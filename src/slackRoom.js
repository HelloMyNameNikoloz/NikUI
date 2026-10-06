'use strict';

/**
 * Everybody looking at Slack through NikUI, and what each of them may do.
 *
 * Two kinds of window show the same chat: the editor tab on this laptop and the
 * Slack page on a phone. They speak the same `slack:*` messages, so the rules
 * live here once rather than in each transport — the editor's own tab is this
 * machine and may do anything; a phone may read, and may reply or change the
 * VIP list only with the same grant that lets it send prompts, because a reply
 * goes out under your name.
 *
 * Looking is not reading. Opening a conversation here never touches Slack's own
 * read marker; it only tells the service that you have seen it, so the phone
 * does not ring about a message you are looking at. Replying does mark it
 * read, in Slack, because answering somebody is the clearest sign there is.
 *
 * Nothing here knows about VS Code: the service, the settings and the few
 * things only the editor can do are handed in.
 */

const MAX_VIPS = 50;

// What a Slack app needs to do this, as a manifest Slack itself can read: user
// scopes only, so everything happens as you and nothing as a bot, and Socket
// Mode so no server of anybody's has to be reachable from Slack.
const MANIFEST = {
  display_information: {
    name: 'NikUI',
    description: 'Tells you in VS Code, and rings your phone, when a VIP is waiting on you.'
  },
  oauth_config: {
    scopes: {
      user: [
        'im:history', 'im:read', 'im:write',
        'mpim:history', 'mpim:read', 'mpim:write',
        'channels:history', 'channels:read', 'channels:write',
        'groups:history', 'groups:read', 'groups:write',
        'users:read', 'users:read.email', 'chat:write', 'search:read'
      ]
    }
  },
  settings: {
    event_subscriptions: {
      user_events: ['message.im', 'message.mpim', 'message.channels', 'message.groups']
    },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false
  }
};

const SETUP_URL = 'https://api.slack.com/apps?new_app=1&manifest_json=' +
  encodeURIComponent(JSON.stringify(MANIFEST));

class SlackRoom {
  /**
   * @param {object} deps
   * @param {() => object|null} deps.service      the running SlackService, or null
   * @param {() => object} deps.settings          {enabled, hasTokens, vipList, clock}
   * @param {(list: string[]) => Promise} deps.setVips
   * @param {(on: boolean) => Promise} deps.setEnabled
   * @param {() => Promise} [deps.connect]        asks for the tokens, on this laptop
   * @param {() => Promise} [deps.disconnect]
   * @param {() => void} [deps.openSettings]
   * @param {(url: string) => void} [deps.openUrl] opens a link on this laptop
   * @param {(entry: object) => void} [deps.audit]
   * @param {(line: string) => void} [deps.log]
   */
  constructor(deps) {
    this.deps = deps;
    this.log = deps.log || (() => {});
    this.clients = new Map();
  }

  /**
   * One window showing Slack.
   *
   * @param {string} id
   * @param {object} seat   {local, control, device, looking: () => boolean}
   * @param {(message: object) => void} post
   */
  join(id, seat, post) {
    const known = this.clients.get(id);
    if (known) { known.seat = seat; known.post = post; return known; }
    const client = { id, seat, post, open: null, thread: null };
    this.clients.set(id, client);
    return client;
  }

  leave(id) {
    this.clients.delete(id);
  }

  mayAct(seat) {
    if (!seat) return false;
    return seat.local ? true : !!seat.control;
  }

  stateFor(seat) {
    const service = this.deps.service();
    const settings = this.deps.settings() || {};
    const live = service ? service.state() : {};
    return Object.assign({
      connected: false, socket: 'off', error: null, me: null,
      unresolved: [], vips: [], conversations: []
    }, live, {
      enabled: !!settings.enabled,
      hasTokens: !!settings.hasTokens,
      vipList: (settings.vipList || []).slice(),
      clock: settings.clock === '12h' ? '12h' : '24h',
      mayReply: this.mayAct(seat),
      mayEdit: this.mayAct(seat),
      local: !!(seat && seat.local),
      setupUrl: SETUP_URL
    });
  }

  /** The state again, to everybody: the service changed, or a setting did. */
  broadcast() {
    for (const client of this.clients.values()) {
      try { client.post({ type: 'slack:state', state: this.stateFor(client.seat) }); }
      catch (err) { this.log(`slack: could not tell ${client.id}: ${err && err.message}`); }
    }
  }

  /**
   * Bring a conversation forward in the editor's own windows, because it has
   * waited long enough. Phones are told by a notification, not by this.
   */
  focus(conversationId, reason) {
    for (const client of this.clients.values()) {
      if (!client.seat.local) continue;
      client.post({ type: 'slack:focus', conversation: conversationId, reason: reason || 'popup' });
    }
  }

  /**
   * Somebody is looking at this window now — the editor tab came to the front.
   * Whatever it shows has been seen.
   */
  looked(id) {
    const client = this.clients.get(id);
    if (client && client.open) this.seen(client.open);
  }

  seen(conversationId) {
    const service = this.deps.service();
    if (service && conversationId) service.seenInNikui(conversationId);
  }

  async handle(id, message) {
    const client = this.clients.get(id);
    if (!client || !message || typeof message.type !== 'string') return;
    const { seat } = client;
    const post = (m) => client.post(m);
    const refuse = (reason) => post({ type: 'slack:refused', what: message.type, reason });
    const service = this.deps.service();

    switch (message.type) {
      case 'slack:ready':
        return void post({ type: 'slack:state', state: this.stateFor(seat) });

      case 'slack:open': {
        const conversation = text(message.conversation, 40);
        if (!conversation) return;
        client.open = conversation;
        client.thread = text(message.thread, 40) || null;
        // On the phone, opening the page is the act of looking. In the editor
        // the tab may have popped up on its own, so it counts only while it is
        // the tab in front of you.
        if (!seat.looking || seat.looking()) this.seen(conversation);
        return void (await this.sendThread(client));
      }

      case 'slack:reply': {
        const reply = String(message.text || '');
        const conversation = text(message.conversation, 40);
        const answer = (ok, reason) => post({ type: 'slack:sent', id: message.id, ok, reason });
        if (!this.mayAct(seat)) {
          this.note(seat, 'slack reply', false, conversation);
          return void answer(false, 'This phone can only watch. Let it send prompts to reply.');
        }
        if (!service) return void answer(false, 'Slack is not connected.');
        if (!conversation || !reply.trim()) return void answer(false, 'There is nothing to send.');
        if (reply.length > 12000) return void answer(false, 'That is longer than Slack allows.');
        try {
          await service.reply(conversation, reply, text(message.thread, 40) || undefined);
        } catch (err) {
          this.note(seat, 'slack reply', false, conversation);
          return void answer(false, sayError(err));
        }
        this.note(seat, 'slack reply', true, conversation);
        answer(true);
        // Everybody looking at that conversation sees the reply land.
        for (const other of this.clients.values()) {
          if (other.open === conversation) this.sendThread(other).catch(() => {});
        }
        return;
      }

      case 'slack:vips': {
        if (!this.mayAct(seat)) return void refuse('This phone can only watch. Let it send prompts to change your VIPs.');
        const list = Array.isArray(message.vips) ? message.vips : [];
        const clean = [];
        for (const entry of list) {
          const one = text(entry, 100);
          if (one && !clean.some((c) => c.toLowerCase() === one.toLowerCase())) clean.push(one);
          if (clean.length >= MAX_VIPS) break;
        }
        this.note(seat, 'slack vips', true, clean.length + ' VIPs');
        await this.deps.setVips(clean);
        return void this.broadcast();
      }

      case 'slack:enable':
        if (!this.mayAct(seat)) return void refuse('This phone can only watch. Turn Slack on from the laptop.');
        await this.deps.setEnabled(true);
        return void this.broadcast();

      case 'slack:connect':
      case 'slack:disconnect':
      case 'slack:settings': {
        // Tokens are typed on the laptop and nowhere else: they never cross
        // the wire, not even to a phone that may send prompts.
        if (!seat.local) return void refuse('Do that on the laptop.');
        const act = message.type === 'slack:connect' ? this.deps.connect
          : message.type === 'slack:disconnect' ? this.deps.disconnect : this.deps.openSettings;
        if (act) await act();
        return void this.broadcast();
      }

      // The setup page, opened by whoever can: the editor's webview may not
      // open a window itself, so the laptop does it for the laptop.
      case 'slack:setup': {
        if (seat.local && this.deps.openUrl) return void this.deps.openUrl(SETUP_URL);
        return void post({ type: 'slack:link', url: SETUP_URL });
      }

      case 'slack:link': {
        const conversation = text(message.conversation, 40);
        if (!conversation || !service) return;
        let url = null;
        try { url = await service.permalink(conversation, text(message.ts, 40) || undefined); }
        catch (_) { url = null; }
        if (!url) {
          const me = (service.state() || {}).me || {};
          url = 'slack://channel?team=' + encodeURIComponent(me.teamId || '') +
            '&id=' + encodeURIComponent(conversation);
        }
        if (seat.local && this.deps.openUrl) return void this.deps.openUrl(url);
        return void post({ type: 'slack:link', url });
      }

      default:
        return;
    }
  }

  async sendThread(client) {
    const service = this.deps.service();
    if (!service || !client.open) return;
    const asked = client.open;
    try {
      const got = await service.thread(asked, client.thread || undefined);
      // Somebody moved on while it loaded: their screen is about another one now.
      if (client.open !== asked) return;
      client.post({
        type: 'slack:thread',
        conversation: got.conversation,
        thread: client.thread || null,
        messages: got.messages || []
      });
    } catch (err) {
      client.post({ type: 'slack:refused', what: 'slack:open', reason: sayError(err) });
    }
  }

  note(seat, action, allowed, detail) {
    // The editor's own tab is this machine and is not written down.
    if (!seat || seat.local || !this.deps.audit || !seat.device) return;
    try { this.deps.audit({ device: seat.device, action, allowed, detail: detail || '' }); }
    catch (_) { /* the trail is a record, not a gate */ }
  }
}

/** A short string from somewhere else, or nothing. */
function text(value, max) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  return t && t.length <= max ? t : '';
}

/** What went wrong, in a sentence a person can act on. */
function sayError(err) {
  const code = err && err.code;
  if (code === 'not_in_channel' || code === 'channel_not_found') return 'You are not in that conversation any more.';
  if (code === 'invalid_auth' || code === 'token_revoked' || code === 'not_authed') return 'Slack refused the token — connect again.';
  if (code === 'missing_scope') return 'The Slack app is missing a permission. Create it again from the manifest.';
  if (code === 'network') return 'No connection to Slack.';
  return (err && err.message) || 'Slack said no.';
}

module.exports = { SlackRoom, MANIFEST, SETUP_URL, sayError };
