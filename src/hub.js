'use strict';

const { commandArgs } = require('./session');
const { buildReport } = require('./report');
const { GRANT } = require('./ci');

// Commands NikUI answers itself rather than passing to the CLI.
const OWN_COMMANDS = ['status', 'settings', 'commands', 'slack', 'watch'];

/**
 * The messages that change something, as opposed to the ones that only watch.
 *
 * A paired device may watch as soon as it is paired; steering is a separate
 * grant, because sending a prompt to an instance running with permissions
 * bypassed is arbitrary code execution on this machine. The client hides these
 * controls when it has no grant — that is courtesy. This list is the rule.
 */
const STEERING = new Set([
  'send', 'interrupt', 'permission', 'unqueue', 'promoteQueued',
  // Running a command is steering by any reading of the word: it is the same
  // machine and the same permissions as a prompt, by a shorter route.
  'editQueued', 'clearQueue', 'openFile', 'switch', 'runInTerminal',
  // Stopping a command it is running is the same as interrupting it.
  'stopTask',
  // Writing to the pull request — a reply, a resolved thread, a re-run — is
  // done as the laptop's GitHub account, so it is steering too.
  'pr:reply', 'pr:resolve', 'pr:comment', 'pr:rerun', 'pr:unlink',
  // /watch hands out permission to push, which is steering if anything is.
  'watch',
  // A setting changes what every instance does next, and whether the laptop
  // sleeps. Reading them is watching; changing one is not.
  'setSetting',
  // A snippet is a standing instruction added to prompts, so rewriting one is
  // writing every prompt that uses it. Reading the list is watching.
  'saveCommand', 'removeCommand', 'restoreCommand'
]);

// A sheet that quietly goes stale while a turn runs is worse than no sheet, and
// a streaming turn changes constantly. Per client, because one open sheet must
// not drive redraws for a client that has none.
const STATUS_REFRESH_MS = 1500;

// The fastest the running totals are worth sending. Fast enough that a counter
// looks live, slow enough that a phone is not paying for it.
const STATS_MIN_MS = 400;

/**
 * One instance, however many people are watching it.
 *
 * The hub owns everything a client needs to draw a session and everything a
 * client is allowed to ask of it. It knows nothing about VS Code or about
 * sockets: a client is anything with an id and a `post(message)`, and the few
 * things only the editor can do — opening a file, bringing another instance to
 * the front — arrive as injected host functions.
 *
 * That is the whole point of the split. The webview and a phone are the same
 * kind of thing to a session, so they cannot drift apart.
 */
class SessionHub {
  constructor(session, host) {
    this.session = session;
    this.host = host || {};
    this.clients = new Map();
    this.listeners = [];
    this.statsSentAt = 0;
    this.statsTimer = null;
    this.watchers = new Set();

    const on = (event, fn) => {
      session.on(event, fn);
      this.listeners.push(() => session.off(event, fn));
    };

    on('items', (items) => {
      this.broadcast({ type: 'items', items });
      this.broadcastStats();
      this.refreshStatus();
    });
    on('status', (status) => {
      // A phone with this conversation on its screen saw it finish.
      this.seenElsewhere();
      this.broadcast({ type: 'status', status });
      this.broadcastStats();
      this.refreshStatus();
      this.emitHost('chrome');
    });
    on('meta', () => {
      this.broadcast(this.metaMessage());
      this.emitHost('chrome');
      this.syncPr();
    });

    // The pull request beside the conversation: one feed for the whole window,
    // shared by every instance that names the same PR.
    const feed = this.host.prFeed || null;
    if (feed) {
      const onPr = (url, state) => {
        if (url && url === this.session.prUrl) this.broadcast(Object.assign({ type: 'pr:state' }, state));
      };
      feed.on('state', onPr);
      this.listeners.push(() => feed.removeListener('state', onPr));
      this.listeners.push(() => feed.unwatch(this.session.id));
    }
    on('background', () => {
      this.broadcastStats();
      this.refreshStatus();
    });
    on('ci', () => this.broadcastStats());
    on('unread', () => this.emitHost('chrome'));
    on('reset', () => this.broadcast({ type: 'reset' }));
    on('queue', () => {
      this.broadcast(this.queueMessage());
      this.refreshStatus();
    });

    // Token counts move during a turn even when no item changes.
    this.ticker = setInterval(() => {
      if (!this.session.isBusy) return;
      this.broadcastStats();
      this.refreshStatus();
    }, 2000);
    if (this.ticker.unref) this.ticker.unref();
  }

  // ---- clients ------------------------------------------------------------

  /**
   * A client joins. Nothing is sent to it until it says `ready`: a transport
   * that is still loading its page would drop whatever arrived first, and the
   * conversation would be missing its middle.
   */
  attach(client) {
    if (!client || !client.id) throw new Error('a client needs an id');
    this.clients.set(client.id, {
      client,
      // Who this is, when anybody knows: a socket always carries a device, the
      // editor's own webview carries none and is trusted like the editor.
      device: client.device || null,
      since: Date.now(),
      ready: false,
      // Whether the page says it is on screen. Assumed so until it says not.
      hidden: false,
      statusOpen: false,
      statusTimer: null,
      pendingStatus: false
    });
    return client;
  }

  /**
   * A device's grant changed while it was connected. Nothing is re-paired and
   * no socket is dropped: the seat is simply worth more, or less, from now on.
   */
  setDevice(clientId, device) {
    const entry = this.clients.get(clientId);
    if (!entry) return false;
    entry.device = device || null;
    safePost(entry.client, { type: '@device', device: entry.device });
    this.broadcastPresence();
    return true;
  }

  /** Whether this seat may change anything, rather than only watch. */
  mayControl(entry) {
    return !entry || !entry.device || entry.device.control !== false;
  }

  /**
   * The blue dot comes off when a device is looking at this conversation —
   * opened on it, brought back to the front, or on screen as the turn ends.
   * The editor's own panel says so for itself, knowing whether it is in view.
   */
  seenElsewhere(arriving) {
    const session = this.session;
    if (!session.unread || typeof session.setUnread !== 'function') return;
    for (const entry of this.clients.values()) {
      if ((entry.ready || entry === arriving) && !entry.hidden && !this.isLocal(entry)) return void session.setUnread(false);
    }
  }

  /** The editor's own panel, or a browser on this machine: somebody at this screen. */
  isLocal(entry) {
    return !entry || !entry.device || entry.device.kind !== 'device';
  }

  /** What the settings sheet draws, in this client's terms. */
  settingsMessage(entry) {
    let settings = null;
    try { settings = typeof this.host.settings === 'function' ? this.host.settings() : null; }
    catch (_) { settings = null; }
    return {
      type: 'settings',
      settings,
      mayChange: this.mayControl(entry),
      // The full list of settings is the editor's, so only the editor is
      // offered the way to it.
      local: this.isLocal(entry)
    };
  }

  /** What the commands page draws, in this client's terms. */
  commandsMessage(entry) {
    let commands = null;
    try { commands = typeof this.host.commands === 'function' ? this.host.commands() : null; }
    catch (_) { commands = null; }
    return { type: 'commands', commands, mayChange: this.mayControl(entry) };
  }

  /** Everyone with the commands page open, told what it says now. */
  broadcastCommands() {
    for (const [id, entry] of this.clients) {
      if (entry.commandsOpen) this.send(id, this.commandsMessage(entry));
    }
  }

  /** Everyone with the sheet open, told what it says now. */
  broadcastSettings() {
    for (const [id, entry] of this.clients) {
      if (entry.settingsOpen) this.send(id, this.settingsMessage(entry));
    }
  }

  detach(clientId) {
    const entry = this.clients.get(clientId);
    if (!entry) return false;
    if (entry.statusTimer) clearTimeout(entry.statusTimer);
    this.clients.delete(clientId);
    this.broadcastPresence();
    this.syncPr();
    return true;
  }

  /**
   * Who else is looking at this instance.
   *
   * Only what is shared is broadcast: who is attached, and whether they can
   * steer. What a client is doing with its own view — the draft it is halfway
   * through, where it has scrolled, whether its status sheet is open — stays
   * where it is. Syncing a draft would mean two people typing over each other.
   */
  presence() {
    const clients = [];
    for (const entry of this.clients.values()) {
      if (!entry.ready) continue;
      clients.push({
        id: entry.client.id,
        name: entry.device ? entry.device.name : 'This editor',
        kind: entry.device ? entry.device.kind : 'editor',
        control: this.mayControl(entry),
        since: entry.since
      });
    }
    return { type: 'presence', clients };
  }

  broadcastPresence() {
    this.broadcast(this.presence());
  }

  get size() {
    return this.clients.size;
  }

  /** Everyone who has finished loading. */
  broadcast(message) {
    for (const entry of this.clients.values()) {
      if (entry.ready) safePost(entry.client, message);
    }
  }

  send(clientId, message) {
    const entry = this.clients.get(clientId);
    if (!entry || !entry.ready) return false;
    return safePost(entry.client, message);
  }

  /**
   * Numbers nobody reads twenty times a second.
   *
   * Items flush every fifty milliseconds while a turn streams, and stats used
   * to go out with each one — doubling the messages on the wire for figures
   * that change meaningfully once or twice a second. Throttled here, with the
   * trailing edge kept so the last word is always the true one.
   */
  broadcastStats() {
    const now = Date.now();
    const since = now - (this.statsSentAt || 0);
    if (since >= STATS_MIN_MS) {
      this.statsSentAt = now;
      this.broadcast({ type: 'stats', stats: this.session.stats() });
      return;
    }
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.statsSentAt = Date.now();
      this.broadcast({ type: 'stats', stats: this.session.stats() });
    }, STATS_MIN_MS - since);
    if (this.statsTimer.unref) this.statsTimer.unref();
  }

  /**
   * For a transport that has its own work to do when the instance moves — a tab
   * title, an icon, a status bar. Every transport gets told, because more than
   * one of them can be watching and the second must not silence the first.
   */
  onHost(fn) {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  emitHost(event) {
    for (const fn of this.watchers) {
      try { fn(event, this.session); } catch (_) { /* a transport's problem, not the session's */ }
    }
  }

  // ---- messages a client sends --------------------------------------------

  /**
   * Every inbound message, from whichever client. The client is named because
   * some answers go back to the one that asked — a report, a reclaimed prompt —
   * while the rest are everybody's business.
   */
  async receive(clientId, msg) {
    const entry = this.clients.get(clientId);
    if (!entry || !msg || typeof msg.type !== 'string') return;
    const session = this.session;

    if (STEERING.has(msg.type)) {
      // Which setting, not only that one was changed: "a phone changed a
      // setting" is not an answer to "who turned the lid switch on".
      const what = msg.type === 'setSetting' ? String(msg.id) + ' → ' + JSON.stringify(msg.value)
        : /Command$/.test(msg.type) ? '/' + String(msg.name || '') : null;
      if (!this.mayControl(entry)) {
        // Refused, said so, and written down: a refused attempt is the entry
        // you would most want to find afterwards.
        this.note(entry, msg.type, false, what);
        this.send(clientId, {
          type: '@refused',
          what: msg.type,
          reason: 'This device can watch but not steer. Grant it control in the editor.'
        });
        return;
      }
      this.note(entry, msg.type, true, what);
      // A prompt is what makes a phone the owner of what follows. Anything else
      // a device does is only it being awake — steering is what says "tell me
      // when this is done", and the last phone to steer is the one holding it.
      if (msg.type === 'send' && this.host.audience && entry.device && entry.device.id) {
        this.host.audience.steered(session.id, entry.device.id);
      }
    }

    switch (msg.type) {
      case 'ready':
        if (typeof msg.hidden === 'boolean') entry.hidden = msg.hidden;
        await this.hello(entry);
        break;

      // The page went behind something, or came back to the front.
      case 'visible':
        entry.hidden = msg.on === false;
        this.seenElsewhere();
        this.syncPr();
        break;

      case 'pr:pane': {
        const tabs = ['overview', 'comments', 'checks', 'files'];
        const was = session.prPane || {};
        session.prPane = {
          open: !!msg.open,
          tab: tabs.includes(msg.tab) ? msg.tab : (was.tab || 'overview'),
          width: Number.isFinite(msg.width) ? Math.max(280, Math.min(2000, Math.round(msg.width))) : (was.width || null)
        };
        // Everyone sees the same pane on this instance, and it is remembered.
        session.emit('meta');
        break;
      }

      case 'pr:refresh':
        if (this.host.prFeed && session.prUrl) this.host.prFeed.refresh(session.prUrl);
        break;

      case 'pr:diff':
        if (this.host.prFeed && session.prUrl) {
          const r = await this.host.prFeed.diff(session.prUrl);
          if (r.ok) this.send(clientId, { type: 'pr:diff', diff: r.diff, truncated: !!r.truncated });
          else this.send(clientId, { type: 'pr:done', action: 'diff', ok: false, message: r.message });
        }
        break;

      case 'pr:reply':
      case 'pr:resolve':
      case 'pr:comment':
      case 'pr:rerun': {
        const feed = this.host.prFeed;
        if (!feed || !session.prUrl) break;
        const url = session.prUrl;
        let r;
        if (msg.type === 'pr:reply') r = await feed.reply(url, String(msg.threadId || ''), String(msg.body || ''));
        else if (msg.type === 'pr:resolve') r = await feed.resolve(url, String(msg.threadId || ''), msg.resolved !== false);
        else if (msg.type === 'pr:comment') r = await feed.comment(url, String(msg.body || ''));
        else r = await feed.rerunFailed(url);
        this.send(clientId, { type: 'pr:done', action: msg.type.slice(3), ok: !!(r && r.ok), message: (r && r.message) || '' });
        break;
      }

      // "Ask Claude": the comment or the failing log goes into this client's
      // composer, not straight to Claude — it is still yours to send.
      case 'pr:askThread':
      case 'pr:askCheck': {
        const feed = this.host.prFeed;
        const known = feed && session.prUrl ? feed.get(session.prUrl) : null;
        const snap = known && known.state;
        if (!snap) break;
        const { threadPrompt, checkPrompt } = require('./prView');
        if (msg.type === 'pr:askThread') {
          const thread = (snap.threads || []).find((t) => t.id === msg.threadId);
          if (thread) this.send(clientId, { type: 'editPrompt', text: threadPrompt(thread, snap) });
        } else {
          const check = (snap.checks || []).find((c) => String(c.runId) === String(msg.runId) && (!msg.name || c.name === msg.name)) ||
            (snap.checks || []).find((c) => String(c.runId) === String(msg.runId));
          if (!check) break;
          const r = check.runId ? await feed.failedLog(session.prUrl, check.runId) : { ok: false };
          this.send(clientId, { type: 'editPrompt', text: checkPrompt(check, r.ok ? r.log : '', snap) });
        }
        break;
      }

      // Picking a PR is a quick pick on the laptop; a phone has nowhere to show it.
      case 'pr:link':
        if (this.isLocal(entry) && typeof this.host.pickPr === 'function') await this.host.pickPr(session);
        break;

      case 'pr:unlink':
        if (typeof this.host.setPr === 'function') this.host.setPr(session, null);
        break;

      case 'pr:open': {
        const url = String(msg.url || '');
        if (/^https:\/\/github\.com\//.test(url) && this.isLocal(entry) && typeof this.host.openUrl === 'function') {
          await this.host.openUrl(url);
        }
        break;
      }

      case 'send':
        session.submit(msg.text, msg.attachments, { sent: msg.sent, snippets: msg.snippets });
        break;

      // /watch: NikUI watches the PR's CI itself, and the model is told it may
      // push — with the prompt that came with it, or with the next one.
      case 'watch': {
        const text = String(msg.text || '').trim();
        if (text) session.submit(text, [], { sent: text + '\n\n' + GRANT });
        else session.pendingNote = GRANT;
        session.emit('watch');
        break;
      }

      case 'interrupt':
        session.interrupt();
        break;

      case 'stopTask':
        if (typeof session.stopTask === 'function') session.stopTask(String(msg.taskId || ''));
        break;

      case 'unqueue':
        session.unqueue(msg.id);
        break;

      case 'promoteQueued':
        session.promote(msg.id);
        break;

      case 'editQueued': {
        // Straight back to whoever asked: a prompt pulled out of the queue
        // belongs in that person's composer, not in everyone's.
        const item = session.reclaim(msg.id);
        if (item) this.send(clientId, { type: 'editPrompt', text: item.text || '' });
        break;
      }

      case 'clearQueue':
        session.clearQueue();
        break;

      case 'permission': {
        // Answer first, then say so. Marking the prompt resolved before knowing
        // the answer went anywhere showed "Allowed" for an instance that had
        // already died.
        const delivered = session.respondToPermission(msg.requestId, msg.allow);
        if (!delivered) break;
        const item = session.items.find((i) => i.kind === 'permission' && i.requestId === msg.requestId);
        if (item) {
          item.resolved = msg.allow ? 'allow' : 'deny';
          this.broadcast({ type: 'items', items: [item] });
        }
        break;
      }

      case 'status':
        this.send(clientId, { type: 'statusReport', report: this.report() });
        break;

      case 'statusOpen':
        entry.statusOpen = !!msg.open;
        if (!entry.statusOpen && entry.statusTimer) {
          clearTimeout(entry.statusTimer);
          entry.statusTimer = null;
        }
        break;

      // `/settings`: asked for, kept fresh while it is open, and changed one row
      // at a time. The answer to a change goes to whoever made it — refused or
      // not — and everybody else with the sheet open hears it from the setting
      // itself changing, whichever window or phone changed it.
      case 'settings':
        entry.settingsOpen = true;
        this.send(clientId, this.settingsMessage(entry));
        break;

      // `/slack` in the editor: its own tab, beside. A phone opens its own
      // Slack page and never asks; a browser elsewhere has nowhere to open it.
      case 'slack':
        if (this.isLocal(entry) && this.host.openSlack) this.host.openSlack();
        else this.send(clientId, { type: '@refused', what: 'slack', reason: 'Slack opens in the NikUI app, or in the editor on the laptop.' });
        break;

      case 'settingsOpen':
        entry.settingsOpen = !!msg.open;
        break;

      case 'setSetting': {
        let refused = null;
        try {
          if (typeof this.host.setSetting !== 'function') throw new Error('This window does not offer settings.');
          await this.host.setSetting(msg.id, msg.value, { local: this.isLocal(entry) });
        } catch (err) {
          refused = (err && err.message) || 'That could not be changed.';
        }
        this.send(clientId, Object.assign(this.settingsMessage(entry), refused ? { refused, id: msg.id } : {}));
        break;
      }

      // `/commands`: the same shape as /settings. A change is answered to whoever
      // made it, with the name it was saved under so the page can go to it;
      // everybody else hears it when the setting changes.
      case 'commands':
        entry.commandsOpen = true;
        this.send(clientId, this.commandsMessage(entry));
        break;

      case 'commandsOpen':
        entry.commandsOpen = !!msg.open;
        break;

      case 'saveCommand':
      case 'removeCommand':
      case 'restoreCommand': {
        const how = msg.type;
        let refused = null;
        let saved = null;
        try {
          if (typeof this.host[how] !== 'function') throw new Error('This window does not offer its commands.');
          saved = await this.host[how](how === 'saveCommand'
            ? { was: msg.was, name: msg.name, prompt: msg.prompt, description: msg.description }
            : msg.name);
        } catch (err) {
          refused = (err && err.message) || 'That could not be changed.';
        }
        this.send(clientId, Object.assign(this.commandsMessage(entry),
          refused ? { refused, name: msg.name } : { done: how, name: saved }));
        break;
      }

      case 'allSettings':
        // Only the editor has the full list, and only on this machine.
        if (this.isLocal(entry) && typeof this.host.openAllSettings === 'function') this.host.openAllSettings();
        break;

      // Only the PR this instance already names, and only from the editor:
      // a phone opening it would open it on the laptop.
      case 'openPr':
        if (session.prUrl && this.isLocal(entry) && typeof this.host.openUrl === 'function') {
          await this.host.openUrl(session.prUrl);
        }
        break;

      case 'openFile':
        if (typeof this.host.openFile === 'function') {
          await this.host.openFile({ path: msg.path, line: msg.line, cwd: session.cwd });
        }
        break;

      // In the editor there is already a terminal and somebody sitting at it,
      // so the command goes there rather than into a view of our own — and it
      // is put in without being sent, because a command you have not read yet
      // is not a command you have agreed to run.
      case 'runInTerminal':
        if (typeof this.host.runInTerminal === 'function') {
          await this.host.runInTerminal({ command: msg.command, cwd: session.cwd, label: session.label });
        }
        break;

      case 'switch':
        // Where a client goes next is that client's business. A phone choosing
        // another instance moves the phone; it does not reach across and
        // rearrange the tabs on the laptop.
        if (entry.device) this.send(clientId, { type: '@navigate', session: msg.id });
        else if (typeof this.host.switchTo === 'function') this.host.switchTo(msg.id, session);
        break;

      default:
        break;
    }
  }

  /**
   * What a device did, for the trail in /status. The editor's own panel is not
   * written down — the audit is about what arrived from somewhere else.
   */
  note(entry, action, allowed, detail) {
    if (!entry || !entry.device) return;
    if (typeof this.host.audit !== 'function') return;
    this.host.audit({
      device: entry.device,
      action,
      allowed,
      detail: detail || null,
      instance: this.session.label,
      sessionId: this.session.id
    });
  }

  /** A client has loaded and wants the whole picture. */
  async hello(entry) {
    const session = this.session;
    // Opened on a phone is opened. The panel says so itself, when it is in view.
    this.seenElsewhere(entry);
    // A restored instance has no items yet; rebuild it from disk before the
    // first paint, then bring its process back with --resume. Only the first
    // client through the door pays for this.
    if (!session.items.length && session.claudeSessionId) {
      let replayed = false;
      try { replayed = await session.replayTranscript(); } catch (_) { replayed = false; }
      if (!replayed) session.noteMissingTranscript();
    }
    // Opening an instance starts it — but only for a client that could steer it
    // anyway. Spawning a CLI process on this machine is not something a
    // watch-only device should be able to do by looking.
    if (!session.isRunning && this.host.autoStart !== false) {
      if (this.mayControl(entry)) session.start();
      else if (!session.items.length) {
        // Watching an instance that is not running would otherwise be an empty
        // page with no composer and nothing to explain either.
        session._notice(
          'This instance is not running, and this device can watch but not start it. ' +
          'Open it on the laptop, or ask for control.',
          'info'
        );
      }
    }

    entry.ready = true;
    // A webview VS Code threw away and rebuilt comes back with a fresh DOM and
    // no sheet. Believing the old state made the dashboard open by itself over
    // the conversation the moment anything changed.
    entry.statusOpen = false;
    if (entry.statusTimer) { clearTimeout(entry.statusTimer); entry.statusTimer = null; }
    safePost(entry.client, this.initMessage(entry.client.id));
    this.syncPr();
    if (this.host.prFeed && session.prUrl) {
      const known = this.host.prFeed.get(session.prUrl);
      if (known) safePost(entry.client, Object.assign({ type: 'pr:state' }, known));
    }
    // Everyone learns who else turned up, including whoever just did.
    this.broadcastPresence();
    if (entry.pendingStatus) {
      entry.pendingStatus = false;
      this.openStatus(entry.client.id);
    }
  }

  // ---- what a client is told -----------------------------------------------

  config() {
    return typeof this.host.config === 'function' ? (this.host.config() || {}) : {};
  }

  meta() {
    const s = this.session;
    const cfg = this.config();
    return {
      label: s.label,
      cwd: s.cwd,
      home: this.host.home || '',
      model: (s.meta && s.meta.model) || cfg.model || null,
      cost: s.totalCost,
      ticket: s.ticket,
      prUrl: s.prUrl || null,
      prPinned: !!s.prPinned,
      prPane: s.prPane || { open: false, tab: 'overview', width: null },
      effort: s.effort || null,
      // Bypassing permissions means every tool runs without asking. That is the
      // default here, so it has to be visible in the panel, not buried in
      // settings — see the chip in the header.
      permissionMode: s.permissionMode || null
    };
  }

  /** Everything NikUI answers itself: its commands, and your snippets. */
  ownCommands(cfg) {
    const snippets = (cfg && cfg.promptSnippets) || {};
    return OWN_COMMANDS.concat(Object.keys(snippets)
      .filter((name) => String(snippets[name] || '').trim())
      .map((name) => name.toLowerCase()));
  }

  /**
   * The session's own list once it has one, otherwise the remembered list —
   * plus the commands NikUI answers itself, which the CLI has no reason to
   * mention and which would otherwise never appear when you type "/".
   */
  commandList() {
    const live = this.session.meta && this.session.meta.slashCommands;
    const remembered = typeof this.host.knownCommands === 'function' ? this.host.knownCommands() : [];
    const base = (live && live.length) ? live : (remembered || []);
    // NikUI's first: the palette shows forty at a time, and the CLI alone
    // lists more than that, which put /watch past the end of the list.
    const own = this.ownCommands(this.config());
    return own.concat(base.filter((c) => !own.includes(c)));
  }

  queueSummary() {
    return this.session.queue.map((q) => ({
      id: q.id,
      text: q.text,
      images: q.attachments.length,
      // A prompt that came back from a reload kept its words and lost its
      // pictures. Saying so beats a chip that claims an image is still there.
      lostImages: q.lostImages || 0
    }));
  }

  queueMessage() {
    return { type: 'queue', queue: this.queueSummary(), drainAt: this.session.drainAt || null };
  }

  metaMessage() {
    const cfg = this.config();
    return {
      type: 'meta',
      meta: this.meta(),
      slashCommands: this.commandList(),
      commandArgs: commandArgs(),
      ownCommands: this.ownCommands(cfg),
      snippets: cfg.promptSnippets || {},
      // The settings the page draws itself with. They were only ever sent in
      // `init`, so changing the font or hiding thinking blocks did nothing
      // until the tab was closed and opened again.
      showThinking: cfg.showThinking,
      clock: cfg.clock === '12h' ? '12h' : '24h',
      replySuggestions: cfg.replySuggestions !== false,
      singleEscape: !!cfg.interruptOnSingleEscape,
      font: cfg.fontFamily || '',
      fontSize: cfg.fontSize || 13
    };
  }

  initMessage(clientId) {
    const session = this.session;
    const cfg = this.config();
    return {
      type: 'init',
      sessionId: session.id,
      // So a client can tell its own row in the presence list from everybody
      // else's, without having to guess at names.
      client: clientId || null,
      items: session.items,
      // Older items were dropped from memory on purpose; the panel says so
      // instead of pretending the conversation began where it does.
      dropped: session.droppedItems || 0,
      maxItems: session.maxItems || 0,
      meta: this.meta(),
      status: session.status,
      stats: session.stats(),
      queue: this.queueSummary(),
      drainAt: session.drainAt || null,
      slashCommands: this.commandList(),
      commandArgs: commandArgs(),
      ownCommands: this.ownCommands(cfg),
      snippets: cfg.promptSnippets || {},
      showThinking: cfg.showThinking,
      clock: cfg.clock === '12h' ? '12h' : '24h',
      replySuggestions: cfg.replySuggestions !== false,
      singleEscape: !!cfg.interruptOnSingleEscape,
      font: cfg.fontFamily || '',
      fontSize: cfg.fontSize || 13
    };
  }

  /**
   * Everything /status draws. The facts only the host knows — the transcript on
   * disk, the other instances, the editor itself — are handed to the builder;
   * it derives the rest.
   */
  report() {
    return buildReport({
      session: this.session,
      fleet: typeof this.host.fleet === 'function' ? this.host.fleet() : [this.session],
      env: typeof this.host.env === 'function' ? this.host.env(this.session) : {},
      lifetime: typeof this.host.lifetime === 'function' ? this.host.lifetime() : null
    });
  }

  // ---- the status sheet ----------------------------------------------------

  /** Redraw any open sheet, at most once every second and a half, per client. */
  refreshStatus() {
    for (const entry of this.clients.values()) {
      if (!entry.statusOpen || entry.statusTimer) continue;
      entry.statusTimer = setTimeout(() => {
        entry.statusTimer = null;
        if (!entry.statusOpen) return;
        safePost(entry.client, { type: 'statusReport', report: this.report() });
      }, STATUS_REFRESH_MS);
      if (entry.statusTimer.unref) entry.statusTimer.unref();
    }
  }

  /**
   * Open the sheet on one client. A client that has not loaded yet gets it the
   * moment it says hello, rather than having it posted into the void.
   */
  openStatus(clientId) {
    const entry = this.clients.get(clientId);
    if (!entry) return false;
    if (!entry.ready) { entry.pendingStatus = true; return false; }
    entry.statusOpen = true;
    safePost(entry.client, { type: 'openStatus' });
    safePost(entry.client, { type: 'statusReport', report: this.report() });
    return true;
  }

  focusInput(clientId) {
    if (clientId) return this.send(clientId, { type: 'focus' });
    this.broadcast({ type: 'focus' });
    return true;
  }

  /**
   * Tell the feed whether anyone is looking at this instance's PR: fetched
   * often while its pane is open in a visible tab, now and then otherwise
   * (enough for the chip in the header), not at all without a PR.
   */
  syncPr() {
    const feed = this.host.prFeed;
    if (!feed) return;
    const s = this.session;
    if (!s.prUrl) { feed.unwatch(s.id); return; }
    let visible = false;
    for (const entry of this.clients.values()) if (entry.ready && !entry.hidden) visible = true;
    feed.watch(s.id, { url: s.prUrl, cwd: s.cwd, active: !!(s.prPane && s.prPane.open) && visible });
  }

  dispose() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    for (const undo of this.listeners) { try { undo(); } catch (_) { /* already gone */ } }
    this.listeners = [];
    this.watchers.clear();
    for (const entry of this.clients.values()) if (entry.statusTimer) clearTimeout(entry.statusTimer);
    this.clients.clear();
  }
}

/** A client that has gone away should not take the session down with it. */
function safePost(client, message) {
  try {
    client.post(message);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * One hub per session, for as long as the session exists. Transports ask for
 * the hub rather than making one, so the second viewer of an instance joins the
 * first rather than starting a rival copy.
 */
const hubs = new Map();

function hubFor(session, host) {
  let hub = hubs.get(session.id);
  if (!hub) {
    hub = new SessionHub(session, host);
    hubs.set(session.id, hub);
  }
  // A later transport joins what is already there: the host is the window's, not
  // any one client's, so replacing it underneath the first would change what
  // "open this file" means depending on who asked last.
  return hub;
}

function closeHub(sessionId) {
  const hub = hubs.get(sessionId);
  if (!hub) return false;
  hub.dispose();
  hubs.delete(sessionId);
  return true;
}

function closeAllHubs() {
  for (const id of [...hubs.keys()]) closeHub(id);
}

/** Every hub in this window — for anything that changed for all of them. */
function eachHub(fn) {
  for (const hub of hubs.values()) {
    try { fn(hub); } catch (_) { /* one hub's problem */ }
  }
}

module.exports = { SessionHub, hubFor, closeHub, closeAllHubs, eachHub, OWN_COMMANDS, STEERING, STATUS_REFRESH_MS, STATS_MIN_MS };
