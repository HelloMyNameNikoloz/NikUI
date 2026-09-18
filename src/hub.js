'use strict';

const { commandArgs } = require('./session');
const { buildReport } = require('./report');

// Commands NikUI answers itself rather than passing to the CLI.
const OWN_COMMANDS = ['status'];

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
  'editQueued', 'clearQueue', 'openFile', 'switch'
]);

// A sheet that quietly goes stale while a turn runs is worse than no sheet, and
// a streaming turn changes constantly. Per client, because one open sheet must
// not drive redraws for a client that has none.
const STATUS_REFRESH_MS = 1500;

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
      this.broadcast({ type: 'status', status });
      this.broadcastStats();
      this.refreshStatus();
      this.emitHost('chrome');
    });
    on('meta', () => {
      this.broadcast(this.metaMessage());
      this.emitHost('chrome');
    });
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

  detach(clientId) {
    const entry = this.clients.get(clientId);
    if (!entry) return false;
    if (entry.statusTimer) clearTimeout(entry.statusTimer);
    this.clients.delete(clientId);
    this.broadcastPresence();
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

  broadcastStats() {
    this.broadcast({ type: 'stats', stats: this.session.stats() });
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
      if (!this.mayControl(entry)) {
        // Refused, said so, and written down: a refused attempt is the entry
        // you would most want to find afterwards.
        this.note(entry, msg.type, false);
        this.send(clientId, {
          type: '@refused',
          what: msg.type,
          reason: 'This device can watch but not steer. Grant it control in the editor.'
        });
        return;
      }
      this.note(entry, msg.type, true);
    }

    switch (msg.type) {
      case 'ready':
        await this.hello(entry);
        break;

      case 'send':
        session.submit(msg.text, msg.attachments, { sent: msg.sent, snippets: msg.snippets });
        break;

      case 'interrupt':
        session.interrupt();
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
        const item = session.items.find((i) => i.kind === 'permission' && i.requestId === msg.requestId);
        if (item) {
          item.resolved = msg.allow ? 'allow' : 'deny';
          this.broadcast({ type: 'items', items: [item] });
        }
        session.respondToPermission(msg.requestId, msg.allow);
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

      case 'openFile':
        if (typeof this.host.openFile === 'function') {
          await this.host.openFile({ path: msg.path, line: msg.line, cwd: session.cwd });
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
  note(entry, action, allowed) {
    if (!entry || !entry.device) return;
    if (typeof this.host.audit !== 'function') return;
    this.host.audit({
      device: entry.device,
      action,
      allowed,
      instance: this.session.label,
      sessionId: this.session.id
    });
  }

  /** A client has loaded and wants the whole picture. */
  async hello(entry) {
    const session = this.session;
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
    if (!session.isRunning && this.host.autoStart !== false && this.mayControl(entry)) session.start();

    entry.ready = true;
    safePost(entry.client, this.initMessage(entry.client.id));
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
    const merged = base.slice();
    for (const own of this.ownCommands(this.config())) if (!merged.includes(own)) merged.push(own);
    return merged;
  }

  queueSummary() {
    return this.session.queue.map((q) => ({ id: q.id, text: q.text, images: q.attachments.length }));
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
      snippets: cfg.promptSnippets || {}
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
      env: typeof this.host.env === 'function' ? this.host.env(this.session) : {}
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

  dispose() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
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

module.exports = { SessionHub, hubFor, closeHub, closeAllHubs, OWN_COMMANDS, STEERING, STATUS_REFRESH_MS };
