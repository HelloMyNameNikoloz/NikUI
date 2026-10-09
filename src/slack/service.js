'use strict';

const { EventEmitter } = require('events');
const { createEscalator } = require('./escalate');
const { toHtml, toPlain, escapeHtml } = require('./mrkdwn');
const { applyEmoji } = require('./emoji');

/**
 * The laptop side of Slack: signed in once with a user token, it watches for
 * a DM from someone on the VIP list or a message anywhere that @-mentions
 * the user, and tells the rest of NikUI when one has gone unanswered long
 * enough to interrupt — a popup first, the phone's alarm if that too goes
 * unseen.
 *
 * Socket Mode is a speed-up, not a dependency: whether the events this cares
 * about even arrive on a user token's socket was never confirmed, so a poll
 * loop runs regardless and the socket, when it works, just gets there first.
 * Either path funnels through the same ingest, deduplicated by channel+ts.
 */

const IGNORED_VIP_DEFAULT_POPUP_MS = 60000;
const IGNORED_VIP_DEFAULT_ALARM_MS = 180000;
const DEFAULT_POLL_MS = 20000;
const RECHECK_MS = 30000;
// Conversations tier is roughly 50/min on this app; stay under that with room
// for the occasional search and info call.
const HISTORY_BUDGET_PER_MIN = 40;

class SlackService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {{call: Function}} deps.api
   * @param {Function} [deps.createSocket]  e.g. require('./socket').createSocket; omit to poll only
   * @param {() => object} deps.config  returns { enabled, vips, mentions, popupAfterMs, alarmAfterMs, pollMs }
   * @param {Function} [deps.now]
   * @param {Function} [deps.setTimeout]
   * @param {Function} [deps.clearTimeout]
   * @param {(line: string) => void} [deps.log]
   */
  constructor({ api, createSocket, config, now, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, log }) {
    super();
    this.api = api;
    this.createSocket = createSocket || null;
    this.config = config || (() => ({}));
    this.now = now || Date.now;
    this.setTimeout = setTimeoutFn || setTimeout;
    this.clearTimeout = clearTimeoutFn || clearTimeout;
    this.log = log || (() => {});

    this.me = null;
    this.cfg = null;
    this.error = null;

    this.vips = [];
    this.vipIds = new Set();
    this.unresolved = [];
    this.imChannels = new Map();   // vip id -> DM channel id
    this.vipByChannel = new Map(); // DM channel id -> vip id

    this.conversations = new Map(); // id -> conv, oldest-touched first
    this.lastSeenTs = new Map();    // channel id -> newest ts polled
    this._seen = new Set();         // 'channel:ts' already ingested
    // How far each conversation has been looked at in NikUI, as a Slack ts. A
    // mark, not a flag: having looked once must not silence what comes next.
    this._nikuiSeen = new Map();
    this._userCache = new Map();    // user id -> {id, name, initials, image}
    this._channelNameKnown = new Set();
    this._directory = null;
    this._directoryAt = 0;
    this._imCacheAt = 0;
    this._lastMentionAt = 0;
    this._searchCursor = null;
    this._polledOnce = false;
    this._pollOk = false;

    // ---- sidebar: every conversation we are a member of, not only the ones
    // escalation cares about. See refreshSidebar().
    this._sidebarMembership = new Map();  // id -> {id, kind, title, private, user}
    this._mpimMembersKnown = new Set();
    this._counts = new Map();             // id -> {unread, mentions, latestAt, latestTs}
    this._countsUnsupported = false;
    this._previewCache = new Map();       // id -> {ts, raw, from, mine, at}
    this._membershipAt = 0;
    this._countsAt = 0;
    this._sidebarRefreshAt = 0;
    this._sidebarLoaded = false;
    this._sidebarAt = null;
    this._sidebarItems = [];

    this.escalator = createEscalator({ popupAfterMs: IGNORED_VIP_DEFAULT_POPUP_MS, alarmAfterMs: IGNORED_VIP_DEFAULT_ALARM_MS });
    this.socket = null;
    this.socketState = 'off';

    this._pollTimer = null;
    this._dueTimer = null;
    this._recheckTimer = null;
    this._stateTimer = null;
    this._stopping = true;
  }

  // ---- lifecycle --------------------------------------------------------

  async start() {
    this._clearTimers();
    this._stopping = false;
    const cfg = Object.assign({
      vips: [], mentions: true,
      popupAfterMs: IGNORED_VIP_DEFAULT_POPUP_MS, alarmAfterMs: IGNORED_VIP_DEFAULT_ALARM_MS,
      pollMs: DEFAULT_POLL_MS
    }, this.config() || {});
    this.cfg = cfg;
    this.escalator = createEscalator({ popupAfterMs: cfg.popupAfterMs, alarmAfterMs: cfg.alarmAfterMs });

    if (!cfg.enabled) {
      this._stopping = true;
      this._emitState();
      return;
    }

    this.error = null;
    try {
      const auth = await this.api.call('auth.test', {});
      this.me = { id: auth.user_id, name: auth.user, teamId: auth.team_id, team: auth.team, url: auth.url };
      await this._resolveVips(cfg.vips);
      await this._mapVipChannels();
    } catch (err) {
      this.error = humanError(err);
      this.log('slack: ' + this.error);
    }

    if (this._stopping) return; // stop() raced us while we were awaiting Slack
    if (this.me) this.refreshSidebar(true).catch((err) => this.log('slack: sidebar failed: ' + err.message));
    this._startSocket();
    this._startPollLoop();
    this._armRecheck();
    this._armDue();
    this._emitState();
  }

  stop() {
    this._stopping = true;
    this._clearTimers();
    if (this.socket) { this.socket.stop(); this.socket = null; }
    this.socketState = 'off';
  }

  async restart() {
    this.stop();
    await this.start();
  }

  _clearTimers() {
    if (this._pollTimer) { this.clearTimeout(this._pollTimer); this._pollTimer = null; }
    if (this._dueTimer) { this.clearTimeout(this._dueTimer); this._dueTimer = null; }
    if (this._recheckTimer) { this.clearTimeout(this._recheckTimer); this._recheckTimer = null; }
    if (this._stateTimer) { this.clearTimeout(this._stateTimer); this._stateTimer = null; }
  }

  _startSocket() {
    if (!this.createSocket) return;
    this.socketState = 'off';
    this.socket = this.createSocket({
      api: this.api,
      onEvent: (event) => this._onSocketEvent(event),
      onState: (s) => this._onSocketState(s),
      setTimeout: this.setTimeout,
      clearTimeout: this.clearTimeout,
      log: this.log
    });
    this.socket.start();
  }

  _onSocketState(s) {
    this.socketState = s.socket;
    if (s.error) this.error = s.error;
    this._scheduleStateEmit();
  }

  _onSocketEvent(event) {
    try { this._handleIncoming(event, 'socket'); }
    catch (err) { this.log('slack: could not read a socket event: ' + err.message); }
  }

  // ---- VIP resolution -----------------------------------------------------

  async _resolveVips(list) {
    const vips = [];
    const unresolved = [];
    for (const raw of list || []) {
      const cleaned = String(raw || '').trim().replace(/^@/, '');
      if (!cleaned) continue;
      let id = null;

      if (/^[UW][A-Z0-9]{2,}$/i.test(cleaned) && !cleaned.includes('@')) {
        try {
          const info = await this.api.call('users.info', { user: cleaned.toUpperCase() });
          id = info.user.id;
          this._cacheUser(info.user);
        } catch (_) { /* might just look like an id; try the other ways below */ }
      }
      if (!id && cleaned.includes('@')) {
        try {
          const info = await this.api.call('users.lookupByEmail', { email: cleaned });
          id = info.user.id;
          this._cacheUser(info.user);
        } catch (_) { /* unresolved, reported below */ }
      }
      if (!id && !cleaned.includes('@')) {
        id = await this._findByName(cleaned);
      }

      if (id) {
        const cached = this._userCache.get(id);
        vips.push({ id, name: (cached && cached.name) || cleaned, initials: (cached && cached.initials) || initialsFor(cleaned) });
      } else {
        unresolved.push(raw);
      }
    }
    this.vips = vips;
    this.vipIds = new Set(vips.map((v) => v.id));
    this.unresolved = unresolved;
  }

  async _findByName(name) {
    await this._ensureDirectory();
    const target = name.toLowerCase();
    for (const member of this._directory || []) {
      const profile = member.profile || {};
      const display = String(profile.display_name || '').toLowerCase();
      const real = String(profile.real_name || '').toLowerCase();
      const handle = String(member.name || '').toLowerCase();
      if (target && (display === target || real === target || handle === target)) {
        this._cacheUser(member);
        return member.id;
      }
    }
    return null;
  }

  async _ensureDirectory() {
    const now = this.now();
    if (this._directory && now - this._directoryAt < 30 * 60000) return;
    const members = [];
    let cursor;
    do {
      const page = await this.api.call('users.list', cursor ? { cursor, limit: 200 } : { limit: 200 });
      members.push(...(page.members || []));
      cursor = page.response_metadata && page.response_metadata.next_cursor;
    } while (cursor);
    this._directory = members;
    this._directoryAt = now;
  }

  async _mapVipChannels() {
    if (!this.vips.length) { this.imChannels = new Map(); this.vipByChannel = new Map(); return; }
    const now = this.now();
    if (this._imCacheAt && now - this._imCacheAt < 10 * 60000) return;
    const channels = [];
    let cursor;
    do {
      const page = await this.api.call('conversations.list', cursor ? { types: 'im', limit: 200, cursor } : { types: 'im', limit: 200 });
      channels.push(...(page.channels || []));
      cursor = page.response_metadata && page.response_metadata.next_cursor;
    } while (cursor);
    const byUser = new Map();
    for (const ch of channels) if (ch.is_im) byUser.set(ch.user, ch.id);
    const imChannels = new Map();
    const vipByChannel = new Map();
    for (const vip of this.vips) {
      const channelId = byUser.get(vip.id);
      if (channelId) { imChannels.set(vip.id, channelId); vipByChannel.set(channelId, vip.id); }
    }
    this.imChannels = imChannels;
    this.vipByChannel = vipByChannel;
    this._imCacheAt = now;
  }

  _cacheUser(user) {
    if (!user || !user.id) return;
    const profile = user.profile || {};
    const name = profile.display_name || profile.real_name || user.name || user.id;
    this._userCache.set(user.id, { id: user.id, name, initials: initialsFor(name), image: profile.image_72 || null });
  }

  // ---- polling --------------------------------------------------------------

  _startPollLoop() {
    const tick = async () => {
      if (this._stopping) return;
      try { await this._pollOnce(); this._pollOk = true; }
      catch (err) { this._pollOk = false; this.error = humanError(err); this.log('slack: poll failed: ' + err.message); }
      await this.refreshSidebar().catch((err) => this.log('slack: sidebar failed: ' + err.message));
      this._scheduleStateEmit();
      if (this._stopping) return;
      this._pollTimer = this.setTimeout(tick, this._effectivePollMs());
    };
    tick();
  }

  /** Stretched past the configured interval only when enough VIPs would otherwise blow the budget. */
  _effectivePollMs() {
    const cfg = this.cfg || {};
    const base = cfg.pollMs || DEFAULT_POLL_MS;
    const vipCount = this.vips.length;
    if (!vipCount) return base;
    const minForBudget = Math.ceil((vipCount / HISTORY_BUDGET_PER_MIN) * 60000);
    return Math.max(base, minForBudget);
  }

  async _pollOnce() {
    if (!this.me) return;
    const now = this.now();
    const first = !this._polledOnce;
    this._polledOnce = true;
    const catchUpSince = String(Math.max(0, (now - (this.cfg.alarmAfterMs || IGNORED_VIP_DEFAULT_ALARM_MS)) / 1000));

    for (const vip of this.vips) {
      const channelId = this.imChannels.get(vip.id);
      if (!channelId) continue;
      const oldest = this.lastSeenTs.get(channelId) || (first ? catchUpSince : '0');
      let history;
      try {
        history = await this.api.call('conversations.history', { channel: channelId, oldest, limit: 15 });
      } catch (err) {
        this.error = humanError(err);
        this.log('slack: could not read a DM: ' + err.message);
        continue;
      }
      const messages = (history.messages || []).slice().reverse(); // oldest first
      for (const m of messages) {
        this._handleIncoming(Object.assign({ type: 'message', channel: channelId, channel_type: 'im' }, m), 'poll');
        if (Number(m.ts) > Number(this.lastSeenTs.get(channelId) || 0)) this.lastSeenTs.set(channelId, m.ts);
      }
    }

    if (this.cfg.mentions === false || !this.me) return;
    const mentionInterval = Math.max(this.cfg.pollMs || DEFAULT_POLL_MS, 60000);
    if (this._lastMentionAt && now - this._lastMentionAt < mentionInterval) return;
    this._lastMentionAt = now;
    try {
      const result = await this.api.call('search.messages', {
        query: '<@' + this.me.id + '>', sort: 'timestamp', sort_dir: 'desc', count: 20
      });
      const matches = ((result.messages && result.messages.matches) || []).slice().reverse(); // oldest first
      let newest = this._searchCursor ? Number(this._searchCursor) : 0;
      for (const match of matches) {
        if (this._searchCursor && Number(match.ts) <= Number(this._searchCursor)) continue;
        this._handleIncoming({
          type: 'message',
          channel: match.channel && match.channel.id,
          channel_type: match.channel && match.channel.is_im ? 'im' : 'channel',
          user: match.user,
          text: match.text,
          ts: match.ts
        }, 'poll');
        newest = Math.max(newest, Number(match.ts));
      }
      if (newest) this._searchCursor = String(newest);
    } catch (err) {
      this.error = humanError(err);
      this.log('slack: mention search failed: ' + err.message);
    }
  }

  // ---- ingest ------------------------------------------------------------

  _handleIncoming(raw, _source) {
    if (!this.me || !raw || (raw.type && raw.type !== 'message')) return;
    if (!raw.ts || !raw.channel) return;

    const key = raw.channel + ':' + raw.ts;
    if (this._seen.has(key)) return;
    this._seen.add(key);
    if (this._seen.size > 4000) {
      const keep = [...this._seen].slice(-2000);
      this._seen = new Set(keep);
    }

    // Ours: never escalated, and an answer to whatever was waiting there — you
    // replied in Slack itself, so nobody is waiting on you any more.
    if (raw.user === this.me.id) {
      if (this.escalator.pending().some((p) => p.item.conversationId === raw.channel && Number(p.item.ts) < Number(raw.ts))) {
        this.escalator.resolve(raw.channel);
        this._markResolved(raw.channel);
        this._scheduleStateEmit();
      }
      return;
    }
    if (raw.subtype && raw.subtype !== 'thread_broadcast') return; // edits, deletes, bot/joins

    const mentionsMe = mentionsUser(raw.text, this.me.id);
    const isVipDm = this.vipByChannel.has(raw.channel);
    const senderIsVip = this.vipIds.has(raw.user);

    let kind = null;
    if (isVipDm) kind = 'vip';
    else if (senderIsVip && mentionsMe) kind = 'vip';
    else if (mentionsMe) kind = 'mention';
    if (!kind) return;

    const threadTs = raw.thread_ts && raw.thread_ts !== raw.ts ? raw.thread_ts : undefined;
    const conversationId = raw.channel;
    const escKey = conversationId + (threadTs ? ':' + threadTs : '');
    const item = { key: escKey, conversationId, ts: raw.ts, threadTs, from: raw.user, kind, text: raw.text || '' };
    this.escalator.arrive(item, this.now());

    this._touchConversation(raw, kind, conversationId);
    this._armDue();
    this._scheduleStateEmit();
  }

  _touchConversation(raw, kind, conversationId) {
    const vipId = this.vipByChannel.get(conversationId) || (this.vipIds.has(raw.user) ? raw.user : null);
    const vip = vipId ? this.vips.find((v) => v.id === vipId) : null;
    const withInfo = this._userInfoSync(raw.user);

    let conv = this.conversations.get(conversationId);
    if (!conv) {
      const kindGuess = vip ? 'dm' : (raw.channel_type === 'mpim' || raw.channel_type === 'group' ? 'group' : 'channel');
      conv = {
        id: conversationId,
        kind: kindGuess,
        title: vip ? vip.name : '#' + conversationId,
        with: withInfo,
        vip: !!vip,
        pending: false,
        lastAt: 0,
        last: null
      };
    }
    conv.vip = conv.vip || !!vip;
    if (vip) { conv.title = vip.name; conv.with = this._userCache.get(vip.id) || withInfo; }
    conv.pending = true;
    conv.lastAt = Math.round(Number(raw.ts) * 1000) || this.now();
    // Kept raw: the user cache may not have a name for everyone mentioned yet.
    // state() flattens this with whatever names are known by the time it is asked.
    conv.last = { raw: raw.text || '', from: raw.user, ts: raw.ts };

    this.conversations.delete(conversationId);
    this.conversations.set(conversationId, conv);
    this._trimConversations();

    this._resolveUserInfo(raw.user);
    this._resolveMentionedIds(raw.text);
    if (conv.kind !== 'dm') this._resolveChannelTitle(conversationId);
  }

  /** Any `<@U…>` in text whose name is not yet known, resolved so a later state() fills it in. */
  _resolveMentionedIds(text) {
    for (const id of new Set(mentionedIds(text))) this._resolveUserInfo(id);
  }

  _trimConversations() {
    while (this.conversations.size > 30) {
      this.conversations.delete(this.conversations.keys().next().value);
    }
  }

  _userInfoSync(id) {
    return this._userCache.get(id) || { id, name: id, initials: initialsFor(id), image: null };
  }

  async _resolveUserInfo(id) {
    if (!id || this._userCache.has(id)) return;
    this._userCache.set(id, this._userInfoSync(id)); // placeholder so a slow lookup is not started twice
    try {
      const info = await this.api.call('users.info', { user: id });
      this._cacheUser(info.user);
    } catch (_) { return; } // keep the placeholder; the id is still shown
    for (const conv of this.conversations.values()) {
      if (conv.with && conv.with.id === id) conv.with = this._userCache.get(id);
    }
    this._scheduleStateEmit();
  }

  async _resolveChannelTitle(conversationId) {
    if (this._channelNameKnown.has(conversationId)) return;
    this._channelNameKnown.add(conversationId);
    try {
      const info = await this.api.call('conversations.info', { channel: conversationId });
      const name = info.channel && info.channel.name;
      if (name) {
        const conv = this.conversations.get(conversationId);
        if (conv) conv.title = '#' + name;
        this._scheduleStateEmit();
      }
    } catch (_) { /* keep the fallback title */ }
  }

  _namesMap() {
    const names = {};
    for (const [id, info] of this._userCache) names[id] = info.name;
    return names;
  }

  // ---- sidebar -------------------------------------------------------------
  //
  // Everything this is a member of, not only the handful of VIPs and mentions
  // the escalator watches — a directory, the way Slack's own app shows one.
  // Membership changes rarely so it is cheap to cache; recency and previews
  // are kept fresher but still budgeted, because this runs on a poll tick.

  /**
   * @param {boolean} [force] ignore the 15s debounce (used once, right after
   *   sign-in, so the first screen is not empty for fifteen seconds).
   */
  async refreshSidebar(force) {
    if (!this.me) return;
    const now = this.now();
    if (!force && this._sidebarRefreshAt && now - this._sidebarRefreshAt < 15000) return;
    this._sidebarRefreshAt = now;
    try {
      await this._ensureMembership(force);
      await this._refreshCounts();
      await this._refreshPreviews();
      this._rebuildSidebarItems();
      this._sidebarLoaded = true;
      this._sidebarAt = this.now();
    } catch (err) {
      this.log('slack: could not build the sidebar: ' + err.message);
    }
    this._scheduleStateEmit();
  }

  async _ensureMembership(force) {
    const now = this.now();
    if (!force && this._membershipAt && now - this._membershipAt < 5 * 60000) return;
    const channels = [];
    let cursor;
    let pages = 0;
    do {
      const page = await this.api.call('users.conversations', Object.assign({
        types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200
      }, cursor ? { cursor } : {}));
      channels.push(...(page.channels || []));
      cursor = page.response_metadata && page.response_metadata.next_cursor;
      pages++;
    } while (cursor && pages < 5);

    const membership = new Map();
    for (const ch of channels) {
      if (ch.is_im) {
        // A deleted person's DM, or the Slackbot DM, is not a conversation
        // worth a row — nobody is on the other end of it to reply to.
        if (ch.is_user_deleted || ch.user === 'USLACKBOT') continue;
        // Not the name itself: a placeholder lookup may still be running, so
        // _rebuildSidebarItems reads the cache fresh each time instead.
        membership.set(ch.id, { id: ch.id, kind: 'dm', userId: ch.user, private: false });
        this._resolveUserInfo(ch.user);
      } else if (ch.is_mpim) {
        const known = this._sidebarMembership.get(ch.id);
        membership.set(ch.id, { id: ch.id, kind: 'group', title: (known && known.title) || mpimFallbackTitle(ch.name), private: true, user: null });
        this._resolveMpimTitle(ch.id);
      } else {
        membership.set(ch.id, { id: ch.id, kind: 'channel', title: ch.name || ch.id, private: !!ch.is_private, user: null });
      }
    }
    this._sidebarMembership = membership;
    this._membershipAt = now;
  }

  /** A group DM's title is its members' names, joined — fetched once per id, like a channel's. */
  async _resolveMpimTitle(conversationId) {
    if (this._mpimMembersKnown.has(conversationId)) return;
    this._mpimMembersKnown.add(conversationId);
    try {
      const result = await this.api.call('conversations.members', { channel: conversationId, limit: 200 });
      const ids = (result.members || []).filter((id) => !this.me || id !== this.me.id);
      await Promise.all(ids.map((id) => this._resolveUserInfo(id)));
      const names = this._namesMap();
      const title = ids.map((id) => names[id] || id).join(', ');
      const item = this._sidebarMembership.get(conversationId);
      if (item && title) item.title = title;
    } catch (_) { /* keep the fallback title */ }
  }

  /** Recency and unread, cheaply: client.counts where it works, else a capped fallback. */
  async _refreshCounts() {
    const now = this.now();
    if (this._countsAt && now - this._countsAt < 20000) return;
    this._countsAt = now;
    if (!this._countsUnsupported) {
      try {
        const result = await this.api.call('client.counts', {});
        const map = new Map();
        for (const group of ['channels', 'mpims', 'ims']) {
          for (const c of (result[group] || [])) {
            map.set(c.id, {
              unread: !!c.has_unreads,
              mentions: c.mention_count || 0,
              latestTs: c.latest || null,
              latestAt: c.latest ? Math.round(Number(c.latest) * 1000) : null
            });
          }
        }
        this._counts = map;
        return;
      } catch (err) {
        if (err && (err.code === 'unknown_method' || err.code === 'not_allowed' || err.code === 'method_not_supported')) {
          this._countsUnsupported = true; // an app token: never try client.counts again
        } else {
          this.log('slack: counts failed: ' + err.message);
          return;
        }
      }
    }
    await this._refreshCountsFallback();
  }

  /** conversations.info per DM/group, capped — client.counts not being there is an app token, not a budget to blow. */
  async _refreshCountsFallback() {
    const ids = [...this._sidebarMembership.values()]
      .filter((it) => it.kind === 'dm' || it.kind === 'group')
      .map((it) => it.id);
    let budget = 25;
    for (const id of ids) {
      if (budget-- <= 0) break;
      try {
        const info = await this.api.call('conversations.info', { channel: id });
        const ch = info.channel || {};
        const latest = ch.latest && ch.latest.ts;
        this._counts.set(id, {
          unread: !!(ch.unread_count_display || ch.unread_count),
          mentions: 0,
          latestTs: latest || null,
          latestAt: latest ? Math.round(Number(latest) * 1000) : null
        });
      } catch (err) { this.log('slack: could not read a conversation\'s recency: ' + err.message); }
    }
  }

  /** The newest message of whichever conversations moved, newest first, capped. */
  async _refreshPreviews() {
    const candidates = [...this._sidebarMembership.keys()]
      .map((id) => ({ id, counts: this._counts.get(id) }))
      .filter((x) => x.counts && x.counts.latestTs)
      .filter((x) => {
        const cached = this._previewCache.get(x.id);
        return !cached || cached.ts !== x.counts.latestTs;
      })
      .sort((a, b) => Number(b.counts.latestTs) - Number(a.counts.latestTs));

    let budget = 12;
    for (const { id, counts } of candidates) {
      if (budget-- <= 0) break;
      try {
        const history = await this.api.call('conversations.history', { channel: id, limit: 1 });
        const m = (history.messages || [])[0];
        if (!m) continue;
        await this._resolveUserInfo(m.user);
        this._previewCache.set(id, {
          ts: counts.latestTs,
          raw: m.text || '',
          from: m.user || null,
          mine: m.user === (this.me && this.me.id),
          at: Math.round(Number(m.ts) * 1000)
        });
      } catch (err) { this.log('slack: could not read a preview: ' + err.message); }
    }
  }

  _rebuildSidebarItems() {
    const names = this._namesMap();
    const pendingByConv = new Map();
    for (const p of this.escalator.pending()) {
      const at = pendingByConv.get(p.item.conversationId);
      if (!at || p.arrivedAt < at) pendingByConv.set(p.item.conversationId, p.arrivedAt);
    }
    const vipIds = this.vipIds;

    const items = [...this._sidebarMembership.values()].map((m) => {
      const counts = this._counts.get(m.id) || {};
      const preview = this._previewCache.get(m.id);
      const last = preview ? {
        text: toPlain(preview.raw, names),
        from: preview.from ? (names[preview.from] || null) : null,
        mine: preview.mine,
        at: preview.at
      } : null;
      const pendingSince = pendingByConv.get(m.id) || null;
      // A DM's name may have arrived after the row was first seen — read the
      // cache fresh each time rather than whatever was known at membership load.
      const user = m.kind === 'dm' ? (this._userCache.get(m.userId) || this._userInfoSync(m.userId)) : null;
      const title = m.kind === 'dm' ? user.name : m.title;
      return {
        id: m.id,
        kind: m.kind,
        title,
        private: !!m.private,
        user,
        latestAt: counts.latestAt != null ? counts.latestAt : null,
        unread: !!counts.unread,
        mentions: counts.mentions || 0,
        last,
        pending: !!pendingSince,
        pendingSince,
        vip: !!(m.kind === 'dm' && user && vipIds.has(user.id))
      };
    });

    items.sort((a, b) => {
      if (a.latestAt == null && b.latestAt == null) return a.title.localeCompare(b.title);
      if (a.latestAt == null) return 1;
      if (b.latestAt == null) return -1;
      return b.latestAt - a.latestAt;
    });
    this._sidebarItems = items;
  }

  // ---- escalation ---------------------------------------------------------

  _armDue() {
    if (this._dueTimer) { this.clearTimeout(this._dueTimer); this._dueTimer = null; }
    if (this._stopping) return;
    const next = this.escalator.nextAt();
    if (next === null) return;
    const delay = Math.max(0, next - this.now());
    this._dueTimer = this.setTimeout(() => this._fireDue(), delay);
  }

  async _fireDue() {
    this._dueTimer = null;
    const actions = this.escalator.due(this.now());
    for (const { action, item } of actions) {
      let seen = false;
      try { seen = await this._isSeen(item); }
      catch (err) { this.log('slack: could not check whether a message was seen: ' + err.message); }
      if (seen) {
        this.escalator.resolve(item.key);
        this._markResolved(item.conversationId);
        continue;
      }
      this._fireAction(action, item);
    }
    this._armDue();
    this._scheduleStateEmit();
  }

  async _isSeen(item) {
    const looked = this._nikuiSeen.get(item.conversationId);
    if (looked && Number(looked) >= Number(item.ts)) return true;
    try {
      const info = await this.api.call('conversations.info', { channel: item.conversationId });
      const lastRead = info.channel && info.channel.last_read;
      if (lastRead && Number(lastRead) >= Number(item.ts)) return true;
    } catch (_) { /* carry on to the reply check */ }
    try {
      if (item.threadTs) {
        const replies = await this.api.call('conversations.replies', { channel: item.conversationId, ts: item.threadTs, oldest: item.ts });
        if ((replies.messages || []).some((m) => m.user === this.me.id && Number(m.ts) > Number(item.ts))) return true;
      } else {
        const history = await this.api.call('conversations.history', { channel: item.conversationId, oldest: item.ts });
        if ((history.messages || []).some((m) => m.user === this.me.id && Number(m.ts) > Number(item.ts))) return true;
      }
    } catch (_) { /* try again at the next deadline */ }
    return false;
  }

  _markResolved(conversationId) {
    const conv = this.conversations.get(conversationId);
    if (!conv) return;
    conv.pending = this.escalator.pending().some((p) => p.item.conversationId === conversationId);
  }

  _fireAction(action, item) {
    const conv = this.conversations.get(item.conversationId) || null;
    const who = (conv && conv.with && conv.with.name) || this._userInfoSync(item.from).name;
    const title = item.kind === 'vip'
      ? who + ' messaged you on Slack'
      : who + ' mentioned you in ' + (conv ? conv.title : 'Slack');
    const message = {
      conversationId: item.conversationId, ts: item.ts, threadTs: item.threadTs,
      from: item.from, text: toPlain(item.text, this._namesMap())
    };
    if (action === 'popup') this.emit('popup', { conversation: conv, message });
    else this.emit('alarm', { conversation: conv, message, title });
  }

  _armRecheck() {
    if (this._recheckTimer) { this.clearTimeout(this._recheckTimer); this._recheckTimer = null; }
    if (this._stopping) return;
    this._recheckTimer = this.setTimeout(async () => {
      try { await this._recheckPending(); }
      catch (err) { this.log('slack: recheck failed: ' + err.message); }
      this._armRecheck();
    }, RECHECK_MS);
  }

  /** Cheap: last_read only, so a read in Slack itself updates the UI before the deadline. */
  async _recheckPending() {
    const pending = this.escalator.pending();
    const checked = new Set();
    for (const p of pending) {
      const conversationId = p.item.conversationId;
      if (checked.has(conversationId)) continue;
      checked.add(conversationId);
      let info;
      try { info = await this.api.call('conversations.info', { channel: conversationId }); }
      catch (_) { continue; }
      const lastRead = info.channel && info.channel.last_read;
      if (!lastRead) continue;
      for (const q of pending) {
        if (q.item.conversationId === conversationId && Number(lastRead) >= Number(q.item.ts)) {
          this.escalator.resolve(q.item.key);
        }
      }
      this._markResolved(conversationId);
    }
    this._scheduleStateEmit();
  }

  // ---- what the UI asks for -----------------------------------------------

  /** @returns {Promise<{conversation: object, messages: object[]}>} oldest first, last 50 */
  async thread(conversationId, threadTs) {
    let messages;
    if (threadTs) {
      const replies = await this.api.call('conversations.replies', { channel: conversationId, ts: threadTs, limit: 50 });
      messages = replies.messages || [];
    } else {
      const history = await this.api.call('conversations.history', { channel: conversationId, limit: 50 });
      messages = (history.messages || []).slice().reverse();
    }
    for (const m of messages) await this._resolveUserInfo(m.user);
    // Not just who sent each message: who they mention too, so a name nobody
    // has looked up yet still has a chance to arrive before this renders.
    for (const m of messages) await Promise.all([...new Set(mentionedIds(m.text))].map((id) => this._resolveUserInfo(id)));
    const names = this._namesMap();
    const out = messages.slice(-50).map((m) => ({
      ts: m.ts,
      user: m.user,
      name: names[m.user] || m.user,
      initials: initialsFor(names[m.user] || m.user || '?'),
      mine: m.user === (this.me && this.me.id),
      html: messageHtml(m, names),
      edited: !!m.edited,
      files: (m.files || []).length,
      reactions: (m.reactions || []).map((r) => ({
        name: r.name, emoji: applyEmoji(':' + r.name + ':'), count: r.count || 0,
        mine: !!(this.me && (r.users || []).includes(this.me.id))
      })),
      at: Math.round(Number(m.ts) * 1000),
      threadTs: m.thread_ts,
      replyCount: m.reply_count
    }));
    return { conversation: this.conversations.get(conversationId) || { id: conversationId }, messages: out };
  }

  async permalink(conversationId, ts) {
    const result = await this.api.call('chat.getPermalink', { channel: conversationId, message_ts: ts });
    return result.permalink;
  }

  /** Posts as the user, then marks the conversation read up to the newest message — ours included. */
  async reply(conversationId, text, threadTs) {
    if (!text || !String(text).trim()) throw Object.assign(new Error('there is nothing to send'), { refused: true });
    const params = Object.assign({ channel: conversationId, text }, threadTs ? { thread_ts: threadTs } : {});
    const posted = await this.api.call('chat.postMessage', params);

    let newest = posted.ts;
    try {
      const history = await this.api.call('conversations.history', { channel: conversationId, limit: 1 });
      const top = history.messages && history.messages[0];
      if (top && Number(top.ts) > Number(newest)) newest = top.ts;
    } catch (_) { /* our own ts is still a correct mark */ }
    try { await this.api.call('conversations.mark', { channel: conversationId, ts: newest }); }
    catch (err) { this.log('slack: could not mark as read: ' + err.message); }

    this.escalator.resolve(conversationId);
    this._markResolved(conversationId);
    this._scheduleStateEmit();
    return { ts: posted.ts };
  }

  /** Looked at in NikUI. Does not touch Slack's own read marker. */
  seenInNikui(conversationId) {
    const conv = this.conversations.get(conversationId);
    const newest = this.escalator.pending()
      .filter((p) => p.item.conversationId === conversationId)
      .reduce((top, p) => (Number(p.item.ts) > Number(top) ? p.item.ts : top), (conv && conv.last && conv.last.ts) || '0');
    this._nikuiSeen.set(conversationId, Number(newest) > 0 ? newest : String(this.now() / 1000));
    this.escalator.resolve(conversationId);
    this._markResolved(conversationId);
    this._scheduleStateEmit();
  }

  state() {
    // How long each conversation has been waiting: the first unseen message.
    const since = new Map();
    for (const p of this.escalator.pending()) {
      const at = since.get(p.item.conversationId);
      if (!at || p.arrivedAt < at) since.set(p.item.conversationId, p.arrivedAt);
    }
    const names = this._namesMap();
    return {
      enabled: !!(this.cfg && this.cfg.enabled),
      // Socket mode knows the instant it is live; polling only knows after a
      // poll has actually gone through, so "connected" does not claim more
      // than either path has really managed.
      connected: !!this.me && !this.error && (this.socketState === 'live' || this._pollOk),
      mode: this.createSocket ? 'socket' : 'poll',
      socket: this.socketState,
      error: this.error || null,
      signedOut: this.error === SIGNED_OUT,
      me: this.me,
      unresolved: this.unresolved,
      vips: this.vips.map((v) => ({ id: v.id, name: v.name, initials: v.initials })),
      conversations: [...this.conversations.values()].slice().reverse().map((c) => {
        const waiting = since.get(c.id);
        const last = c.last ? {
          text: toPlain(c.last.raw, names),
          from: c.last.from ? (names[c.last.from] || c.last.from) : null,
          ts: c.last.ts
        } : null;
        return Object.assign({}, c, { last, pendingSince: c.pending && waiting ? waiting : null });
      }),
      sidebar: { loaded: this._sidebarLoaded, at: this._sidebarAt, items: this._sidebarItems }
    };
  }

  _scheduleStateEmit() {
    if (this._stateTimer) return;
    this._stateTimer = this.setTimeout(() => {
      this._stateTimer = null;
      this.emit('state', this.state());
    }, 100);
  }

  _emitState() {
    if (this._stateTimer) { this.clearTimeout(this._stateTimer); this._stateTimer = null; }
    this.emit('state', this.state());
  }
}

function mentionsUser(text, id) {
  if (!text || !id) return false;
  return text.includes('<@' + id + '>') || text.includes('<@' + id + '|');
}

/** Every `<@U…>` a raw message mentions, Slack's own un-escaped form. */
const MENTION_ID = /<@([A-Z0-9]+)(?:\|[^>]*?)?>/g;

/** Before a group DM's members are known: Slack's own `mpdm-a--b--c-1` name, made a little more readable. */
function mpimFallbackTitle(name) {
  if (!name) return 'Group';
  return String(name).replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ');
}

function mentionedIds(text) {
  const ids = [];
  if (!text) return ids;
  MENTION_ID.lastIndex = 0;
  let m;
  while ((m = MENTION_ID.exec(text))) ids.push(m[1]);
  return ids;
}

/**
 * A message's text when it has one; otherwise whatever made it worth showing
 * — a file, an attachment, a huddle, or rich-text blocks — so a bubble is
 * never left empty. The last resort is a dim placeholder, never nothing.
 */
function messageHtml(m, names) {
  const text = m && m.text;
  if (text && String(text).trim()) return toHtml(text, names);
  if (/huddle/i.test((m && m.subtype) || '')) return 'Huddle';

  const files = (m && m.files) || [];
  if (files.length) {
    return files.map((f) => {
      const label = '📎 ' + escapeHtml(f.title || f.name || 'file');
      return /^https:\/\//.test(f.permalink || '') ? '<a href="' + escapeHtml(f.permalink) + '">' + label + '</a>' : label;
    }).join('<br>');
  }

  const attachments = (m && m.attachments) || [];
  if (attachments.length) {
    const pieces = attachments.map((a) => escapeHtml(a.fallback || a.text || a.title || '')).filter(Boolean);
    if (pieces.length) return pieces.join('<br>');
  }

  const blocks = (m && m.blocks) || [];
  const flattened = blocks.length ? flattenRichText(blocks) : '';
  if (flattened) return toHtml(flattened, names);

  return '<span class="slack-dim">(message)</span>';
}

/** Rich-text blocks, flattened back to Slack's own mrkdwn tokens so toHtml can read them. */
function flattenRichText(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block.type !== 'rich_text') continue;
    for (const section of block.elements || []) {
      for (const leaf of section.elements || []) {
        if (leaf.type === 'text' && leaf.text) parts.push(leaf.text);
        else if (leaf.type === 'emoji' && leaf.name) parts.push(':' + leaf.name + ':');
        else if (leaf.type === 'user' && leaf.user_id) parts.push('<@' + leaf.user_id + '>');
        else if (leaf.type === 'link' && leaf.url) parts.push(leaf.text || leaf.url);
      }
    }
  }
  return parts.join(' ').trim();
}

function initialsFor(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const SIGNED_OUT = 'Slack refused the token — connect again.';

/** A sentence, never a token, however Slack phrased its complaint. */
function humanError(err) {
  if (!err) return 'Something went wrong talking to Slack.';
  const code = err.code;
  if (code === 'invalid_auth' || code === 'not_authed' || code === 'token_revoked' || code === 'account_inactive') {
    return SIGNED_OUT;
  }
  if (code === 'network') return 'No connection to Slack.';
  if (code === 'no_token' || code === 'no_fetch') return 'No connection to Slack.';
  return 'Slack could not do that right now.';
}

module.exports = { SlackService, mentionsUser, initialsFor, humanError };
