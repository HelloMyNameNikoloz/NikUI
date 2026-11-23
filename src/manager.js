'use strict';

const { readConfig: readFrom, readSnippets } = require('./config');
const path = require('path');
const { EventEmitter } = require('events');
const { Session, endedOnLimit } = require('./session');
const { transcriptPath, useNames } = require('./history');
const { defaultCommandCatalog } = require('./commandCatalog');

const STORAGE_KEY = 'nikui.sessions.v1';
// The plan's limits belong to the account, not to a window or a folder.
const LIMITS_KEY = 'nikui.limits.v1';
const PAUSE_KEY = 'nikui.pause.v1';
// When you last overrode a pause by hand. Limits the CLI wrote down before it
// are history: a reload must not read them back and pause everything again.
const OVERRIDE_KEY = 'nikui.limitOverride.v1';
// A minute past the reset, because the window boundary is not to the second and
// being turned away again would just start the whole dance over.
const RESUME_GRACE_MS = 60000;
// If the CLI never says when the quota comes back, look again in a while rather
// than waiting for ever.
const BLIND_RETRY_MS = 15 * 60000;
// Names given by hand, by conversation id. Account-wide and kept after the
// instance is closed, so History still finds a conversation by the name it had.
const NAMES_KEY = 'nikui.names.v1';
// Turns kept per instance across a reload. Enough to redraw the charts without
// making the workspace store carry the whole conversation.
const KEEP_TURNS = 60;
const QUEUED_TEXT_MAX = 8000;

/**
 * A queued prompt, small enough to store. The images go: they are base64 in
 * memory and would turn a list of prompts into megabytes of state — so the
 * count comes back instead, and the panel says so.
 */
function slimQueued(q) {
  return {
    id: q.id,
    text: String(q.text || '').slice(0, QUEUED_TEXT_MAX),
    sent: q.sent ? String(q.sent).slice(0, QUEUED_TEXT_MAX) : null,
    snippets: (q.snippets || []).slice(0, 8),
    images: (q.attachments || []).length || q.lostImages || 0
  };
}

/** Only what /status draws, so a remembered turn stays small. */
function slimTurn(t) {
  return {
    n: t.n, at: t.at, durationMs: t.durationMs, costUsd: t.costUsd,
    input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreate: t.cacheCreate,
    contextTokens: t.contextTokens, model: t.model || null,
    tools: (t.tools || []).slice(0, 8),
    interrupted: !!t.interrupted, isError: !!t.isError
  };
}
const COMMANDS_KEY = 'nikui.slashCommands.v1';

// The CLI only reports its command list in the init event, which it emits after
// the first message. Remember the last list we saw so "/" works immediately on
// a fresh instance, and fall back to the built-ins on a brand-new install.
const BUILTIN_COMMANDS = [
  'add-dir', 'agents', 'clear', 'compact', 'config', 'context', 'cost', 'doctor',
  'effort', 'exit', 'export', 'help', 'hooks', 'init', 'install-github-app', 'mcp',
  'memory', 'model', 'output-style', 'permissions', 'pr-comments', 'privacy-settings',
  'release-notes', 'resume', 'review', 'status', 'terminal-setup', 'usage', 'vim'
];

/** When the quota says it comes back: the spent window's own reset, or the top-level one. */
function pickReset(limits) {
  if (!limits) return null;
  const windows = limits.windows || {};
  const byType = {
    five_hour: windows.fiveHour,
    seven_day: windows.week,
    seven_day_overage_included: windows.weekOverage
  }[limits.type];
  const candidates = [byType && byType.resetsAt, limits.resetsAt]
    .filter((v) => typeof v === 'number' && v > 0);
  return candidates.length ? Math.min.apply(null, candidates) : null;
}

// Callers without settings use manifest defaults, never an implicit editor.
const defaultSettings = { get: (key, fallback) => fallback };

/**
 * An instance saved while NikUI still took the CLI's word for its folder may
 * have been saved in one of Claude's own worktrees. It belongs to the project
 * that worktree is in.
 */
function outsideWorktree(cwd) {
  const m = /^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/.exec(cwd || '');
  return m ? m[1] : cwd;
}

class SessionManager extends EventEmitter {
  constructor(context, options) {
    super();
    this.context = context;
    // The extension passes a fresh VS Code source; engines pass their own.
    this.settingsSource = (options && options.settings) || (() => defaultSettings);
    this.history = (options && options.history) || { transcriptPath };
    this.commandCatalog = (options && options.commandCatalog) || defaultCommandCatalog;
    this.spawner = (options && options.spawner) || null;
    this.nextId = options && options.nextId;
    this.sessions = new Map();
    this.activeId = null;
    this.limits = context.globalState.get(LIMITS_KEY, null);
    // A pause outlives the window it started in: the quota is the account's and
    // the reset time does not care whether VS Code was open.
    this.pause = context.globalState.get(PAUSE_KEY, null);
    this.limitOverride = context.globalState.get(OVERRIDE_KEY, 0) || 0;
    this._resumeTimer = null;
    this.durable = null;
    // Legacy callers still feed the compatibility History reader. Engines
    // supply their own reader and never change that process-wide facade.
    if (!(options && options.history)) useNames(() => this.context.globalState.get(NAMES_KEY, {}) || {});
  }

  /**
   * An empty window is keyed by a window id that changes every reopen, so
   * workspaceState alone loses a window with no folder open. Given a durable,
   * persist() also writes there, and restorable() falls back to reading it.
   */
  useDurable(durable) {
    this.durable = durable || null;
  }

  get list() {
    return [...this.sessions.values()];
  }

  /**
   * What to call an instance when it is shown next to the others. Two tabs both
   * called 1327 are indistinguishable, so the first thing that tells them apart
   * is added: the folder, and failing that their order in the list.
   */
  displayName(session) {
    if (!session) return '';
    const same = this.list.filter((s) => s.label === session.label);
    if (same.length < 2) return session.label;
    const folder = path.basename(session.cwd || '');
    const sameFolder = same.filter((s) => path.basename(s.cwd || '') === folder);
    if (folder && sameFolder.length < 2) return `${session.label} · ${folder}`;
    const nth = sameFolder.indexOf(session) + 1;
    return folder ? `${session.label} · ${folder} ${nth}` : `${session.label} ${nth}`;
  }

  /** The instance the user is looking at, whichever way they got to it. */
  get active() {
    return this.activeId ? this.sessions.get(this.activeId) || null : null;
  }

  /**
   * Called when a panel takes focus. Opening an instance from the editor tabs
   * has to move the sidebar highlight exactly as clicking its row does.
   */
  focus(session) {
    if (!session || this.activeId === session.id) return;
    this.activeId = session.id;
    this.emit('focused', session);
  }

  get config() {
    return readFrom(this.settingsSource());
  }

  configFor(cwd) { return readFrom(this.settingsSource(cwd)); }

  knownCommands() {
    const saved = this.context.globalState.get(COMMANDS_KEY, []);
    return saved && saved.length ? saved : BUILTIN_COMMANDS;
  }

  rememberCommands(list) {
    if (!Array.isArray(list) || !list.length) return;
    this.context.globalState.update(COMMANDS_KEY, list);
  }

  create({ id, cwd, title, ticket, autoLabel, resume, autoStart, totalCost, usage, turnLog, startedAt,
    turns, errors, interrupts, status, finishedAt, compactions, lastCompactedAt, queue, cutByLimit, unread,
    prPane, prPinned, prUrl }) {
    if (this.disposed) throw new Error('Session manager is closed');
    if (this.authorityPolicy) this.authorityPolicy({ id, cwd });
    const cfg = this.configFor(cwd);
    const session = new Session({
      id: id || (this.nextId && this.nextId()),
      history: this.history,
      commandCatalog: this.commandCatalog,
      ticket: ticket || null,
      cwd,
      customTitle: title || null,
      autoLabel: autoLabel || null,
      totalCost: totalCost || 0,
      claudeSessionId: resume || null,
      claudePath: cfg.claudePath,
      model: cfg.model,
      permissionMode: cfg.permissionMode,
      effort: cfg.effort,
      outputStyle: cfg.outputStyle,
      extraArgs: cfg.extraArgs,
      longCommandsInBackground: cfg.longCommandsInBackground,
      autoTitle: cfg.autoTitle,
      maxItems: cfg.maxItems,
      limits: this.limits,
      // What the status sheet needs to keep telling the truth after a reload.
      turnLog,
      // And what the reader typed and has not had answered yet.
      queue,
      startedAt,
      turns,
      errors,
      interrupts,
      // How the conversation left off, so the row looks the same after a reload
      // as it did before one.
      status,
      finishedAt,
      compactions,
      lastCompactedAt,
      // Whether the limit cut off its last turn: owed a nudge when the quota
      // comes back, reload or no reload.
      cutByLimit,
      unread,
      // Through the keeper, when there is one, so a reload does not end it.
      spawner: this.spawner || null
    });

    session.on('status', () => { this._changed(session); });
    // One place to listen for trouble, however many instances there are.
    session.on('failed', (message, code) => this.emit('failed', session, message, code));
    // A queued prompt changes what the row has to say about the instance, and
    // so do agents running behind it, which keep it busy whatever its status.
    session.on('queue', () => this._changed(session));
    session.on('background', () => this._changed(session));
    // CI is watched from outside the session: it only says what happened.
    session.on('ci', () => this._changed(session));
    session.on('unread', () => this._changed(session));
    session.on('pushed', (cwd) => this.emit('pushed', session, cwd));
    // Whichever instance hears about the account's limits, all of them know.
    session.on('limits', (limits) => this.rememberLimits(limits));
    session.on('exhausted', (limits) => this.pauseForLimit(limits));
    session.on('meta', () => {
      this.rememberCommands(session.meta.slashCommands);
      this._changed(session);
    });

    if (usage) Object.assign(session.usage, usage);
    if (prPane && typeof prPane === 'object') session.prPane = { open: !!prPane.open, tab: prPane.tab || 'conversation', width: prPane.width || null, full: !!prPane.full };
    if (prPinned && prUrl) { session.prPinned = true; session.prUrl = prUrl; }
    this.sessions.set(session.id, session);
    if (this.prepareSession) this.prepareSession(session);
    this._applyPause(session);
    if (autoStart !== false) session.start();
    this._changed(session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  remove(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.dispose();
    this.sessions.delete(id);
    if (this.activeId === id) this.activeId = null;
    this.emit('removed', session);
    this.emit('changed');
    this.persist();
  }

  /**
   * Instances whose process ran and is now gone. An instance restored from the
   * last window has no process either, but it has never been started — it is
   * asleep, and clearing it would throw away a row the user still wants.
   */
  stopped() {
    return this.list.filter((s) => s.everStarted && !s.isRunning);
  }

  removeStopped() {
    const dead = this.stopped();
    for (const session of dead) {
      if (this.activeId === session.id) this.activeId = null;
      session.dispose();
      this.sessions.delete(session.id);
      this.emit('removed', session);
    }
    if (dead.length) { this.emit('changed'); this.persist(); }
    return dead.length;
  }

  /**
   * The freshest reading wins, and it outlives the window: usage limits are
   * slow-moving and account-wide, so a reload should not start by knowing
   * nothing about them.
   */
  rememberLimits(limits) {
    if (!limits) return;
    if (this.limits && this.limits.at && limits.at && limits.at < this.limits.at) return;
    this.limits = limits;
    for (const session of this.list) session.limits = limits;
    this.context.globalState.update(LIMITS_KEY, limits);
    this.emit('account-changed');
    this.emit('limits', limits);
    this.emit('changed');
  }

  /**
   * The account has nothing left. Everything stops talking to the CLI until the
   * quota resets — queues intact — and a timer brings it all back.
   */
  pauseForLimit(limits) {
    const cfg = this.config;
    if (cfg.pauseOnLimit === false) return false;
    // Older than your own "the quota is back": read back after a reload, not news.
    if (this.limitOverride && limits && limits.at && limits.at < this.limitOverride) return false;

    const resetsAt = pickReset(limits);
    const until = resetsAt ? resetsAt + RESUME_GRACE_MS : Date.now() + BLIND_RETRY_MS;
    // Already waiting on this — unless the wait was a guess and this is a time.
    // "Look again in fifteen minutes" is not a reason to ignore "resets at 9:30".
    const sharper = this.pause && this.pause.blind && resetsAt;
    if (this.pause && !sharper && this.pause.until >= until) return false;

    this.pause = {
      since: Date.now(),
      until,
      blind: !resetsAt,
      limitType: (limits && limits.type) || null
    };
    this.context.globalState.update(PAUSE_KEY, this.pause);
    this.emit('account-changed');
    for (const session of this.list) session.pause({ until, reason: 'limit' });
    this._armResume();
    this.emit('paused', this.pause);
    this.emit('changed');
    return true;
  }

  /** Back to work: every held instance is released, and the cut-off ones nudged. */
  resumeFromLimit({ manual } = {}) {
    if (manual) {
      // You know better than the numbers: the quota was reset early, or more
      // was bought. Forget the reset they promised so a reload does not
      // resurrect the pause from them.
      this.limitOverride = Date.now();
      this.knownReset = null;
      if (this.limits && this.limits.status === 'rejected') {
        this.limits = Object.assign({}, this.limits, { status: 'allowed', at: this.limitOverride });
        this.context.globalState.update(LIMITS_KEY, this.limits);
      }
      this.context.globalState.update(OVERRIDE_KEY, this.limitOverride);
    }
    if (!this.pause) { this.emit('account-changed'); return 0; }
    this.pause = null;
    this.context.globalState.update(PAUSE_KEY, null);
    this.emit('account-changed');
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }

    let woken = 0;
    for (const session of this.list) if (session.resume({ nudge: this.configFor(session.cwd).resumePrompt })) woken += 1;
    this.emit('resumed', { woken, manual: !!manual });
    this.emit('changed');
    return woken;
  }

  /**
   * Hold anything made while the window is paused, so an instance started
   * during the night does not sail past the quota everything else is waiting on.
   */
  _applyPause(session) {
    if (this.pause) session.pause({ until: this.pause.until, reason: 'limit', quiet: this._pauseIsPast() });
  }

  /** The remembered reset has been and gone: holding on is a formality, not news. */
  _pauseIsPast() {
    return !!this.pause && this.pause.until <= Date.now() + 5000;
  }

  _armResume() {
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    if (!this.pause) return;
    // A reset that has already been and gone (VS Code was closed for it) is
    // still given the grace period rather than firing mid-activation.
    const wait = Math.max(1000, Math.min(this.pause.until - Date.now(), 2147483000));
    this._resumeTimer = setTimeout(() => {
      this._resumeTimer = null;
      if (!this.pause) return;
      if (Date.now() + 500 < this.pause.until) { this._armResume(); return; }
      this.resumeFromLimit();
    }, wait);
    if (this._resumeTimer.unref) this._resumeTimer.unref();
  }

  /**
   * Called once the window has its instances back, so a pause survives a
   * reload — and so does the work it cut off.
   *
   * The second case is the one that went wrong. Instances the limit cut off
   * come back owing a nudge; if nothing is waiting on the reset any more —
   * another window already resumed and cleared it, or this one was closed
   * straight through it — they used to be left red for good. Now they get a
   * pause of their own: until the reset the window last heard of, or a few
   * seconds if that has passed. If the quota is still spent, the nudge meets
   * the limit again and the window pauses properly, knowing the time this time.
   */
  restorePause() {
    if (!this.pause) {
      const owed = this.list.filter((s) => s.cutByLimit);
      if (!owed.length) return false;
      // Somebody who switched waiting off did not ask for anything to carry on.
      if (this.config.pauseOnLimit === false) return false;
      const resetsAt = Math.max(pickReset(this.limits) || 0, this.knownReset || 0) || null;
      const soon = Date.now() + 5000;
      this.pause = {
        since: Date.now(),
        until: resetsAt && resetsAt + RESUME_GRACE_MS > soon ? resetsAt + RESUME_GRACE_MS : soon,
        blind: !resetsAt,
        limitType: (this.limits && this.limits.type) || null,
        restored: true
      };
      this.context.globalState.update(PAUSE_KEY, this.pause);
      this.emit('account-changed');
    }
    // A reset that has already passed — the window was closed or reloaded
    // through it — still holds things until the resume, but says nothing: a
    // "Paused … back on the 18th" and "The quota reset" in every instance, days
    // later, is noise. The instances it cut off still say so when nudged.
    const quiet = this._pauseIsPast();
    for (const session of this.list) session.pause({ until: this.pause.until, reason: 'limit', quiet });
    this._armResume();
    return true;
  }

  /** Kill the process but keep the instance: the conversation resumes on open. */
  sleep(id) {
    const session = this.sessions.get(id);
    if (!session || !session.isRunning) return false;
    session.stop();
    this._changed(session);
    return true;
  }

  /**
   * The window is going away. Instances the keeper holds are let go, not
   * stopped — the next window picks them up — and the rest end with it.
   */
  disposeAll() {
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    for (const session of this.list) {
      if (typeof session.detach === 'function' && session.detach()) continue;
      // Still being picked up: the window is going, not the instance.
      session._leaving = true;
      session.dispose();
    }
    this.sessions.clear();
  }

  /** Permanently close an engine owner; disposeAll remains the legacy clear. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeAll();
    this.removeAllListeners();
  }

  /**
   * After a reload: pick up every instance the last window left running.
   * Until each answer is in, opening or prompting it waits rather than
   * starting a second `claude` on the same conversation.
   */
  async reattach(link) {
    try {
    if (link.beginAttach) {
      try { await link.beginAttach(); }
      catch (_) { /* Each session receives its own named attach refusal below. */ }
    }
    const tries = [];
    for (const session of this.list) {
      if (session.isRunning || typeof session.hydrate !== 'function') continue;
      tries.push(this._attachOne(link, session));
    }
    return (await Promise.all(tries)).filter(Boolean).length;
    } finally { try { await link.endAttach?.(); } catch (_) { /* No batch rejection may escape activation. */ } }
  }

  _attachOne(link, session) {
    const trying = Promise.resolve().then(() => link.attach(session)).catch((e) => {
      session.keeperRefusal = e.code || 'KEEPER_UNAVAILABLE';
      return 'elsewhere';
    });
    session._attaching = trying;
    session._checkedAt = Date.now();
    return trying.then((got) => {
      const ok = got === true;
      // Another window has it: this one must not start a second — until it
      // asks again, which starting it does.
      session.elsewhere = got === 'elsewhere';
      // Kept even when it got it: a later drop can find it in another window.
      session._recheck = () => this._attachOne(link, session);
      if (ok) {
        const ci = session._ciBefore;
        session._ciBefore = false;
        // CI it was watching when the window went: watched again, from here.
        if (ci) this.emit('pushed', session, session.cwd);
        this._changed(session);
      }
      // Prompts typed while it was being picked up.
      session.attached();
      return ok;
    });
  }

  _changed(session) {
    this.emit('session-changed', session);
    this.emit('changed');
    this.persist();
  }

  // Remember enough to offer a resume after a window reload. Every instance,
  // however many and however long untouched: only the user takes one off the
  // list. There used to be a cap of twenty, which silently dropped the oldest
  // on the next reload — idle or not.
  persist() {
    this._rememberNames();
    const data = this.list
      .map((s) => ({
        id: s.id, cwd: s.cwd, customTitle: s.customTitle, autoLabel: s.autoLabel, ticket: s.ticket,
        // The GitHub pane: open or not, which tab, how wide — per instance. A
        // PR picked by hand is kept too; a detected one is simply found again.
        prPane: s.prPane || null, prPinned: !!s.prPinned, prUrl: s.prPinned ? s.prUrl : null,
        claudeSessionId: s.claudeSessionId, totalCost: s.totalCost, usage: s.usage,
        // The running totals are remembered, so the charts that explain them
        // have to be remembered too — a real cost above an empty chart is worse
        // than either on its own.
        startedAt: s.startedAt, turns: s.turns, errors: s.errors, interrupts: s.interrupts,
        status: s.status, finishedAt: s.finishedAt,
        compactions: s.compactions, lastCompactedAt: s.lastCompactedAt,
        turnLog: (s.turnLog || []).slice(-KEEP_TURNS).map(slimTurn),
        // Prompts waiting in a queue are typed work — and a quota pause, which
        // is the whole reason a queue gets long, is itself remembered across a
        // reload. Losing one while keeping the other would be the worst pair.
        // All of it: a cap here dropped the tail of a long queue on a reload.
        // Images are left out, so it stays a list of prompts.
        queue: (s.queue || []).map(slimQueued),
        // Work the limit cut off. It was only ever held in memory, so a reload
        // during a pause forgot who to nudge, and those instances stayed red.
        cutByLimit: !!(s.cutByLimit || s.interruptedByPause),
        // Not opened since it finished: still not, after a reload.
        unread: !!s.unread
      }));
    this.context.workspaceState.update(STORAGE_KEY, data);
    if (this.durable) this.durable.set(STORAGE_KEY, data);
  }

  /** Hand-given names, written where History can find them after the instance is gone. */
  _rememberNames() {
    const saved = this.context.globalState.get(NAMES_KEY, {}) || {};
    const names = Object.assign({}, saved);
    for (const s of this.list) {
      if (!s.claudeSessionId) continue;
      if (s.customTitle) names[s.claudeSessionId] = s.customTitle;
      else delete names[s.claudeSessionId];
    }
    const same = Object.keys(names).length === Object.keys(saved).length &&
      Object.keys(names).every((k) => names[k] === saved[k]);
    if (!same) this.context.globalState.update(NAMES_KEY, names);
  }

  /**
   * workspaceState first, since it is what a reload of the same window just
   * wrote — but an empty window's workspaceState is wiped by the time it
   * comes back, so a non-empty durable value for the same place is the
   * fallback rather than starting from nothing.
   */
  restorable() {
    const here = this.context.workspaceState.get(STORAGE_KEY, []);
    if (Array.isArray(here) && here.length) return here;
    if (this.durable) {
      const remembered = this.durable.get(STORAGE_KEY);
      if (Array.isArray(remembered)) return remembered;
    }
    return [];
  }

  /**
   * Bring back the instances that were open before the window reloaded. The
   * processes are not spawned here — opening a panel does that — so a reload
   * never fires off a pile of CLI processes on its own.
   */
  restoreOpen() {
    const saved = this.restorable().filter((s) => s && s.cwd);
    for (const entry of saved) {
      if (this.sessions.has(entry.id)) continue;
      // What the CLI wrote down outranks what this window remembered: an
      // instance cut off before NikUI kept track of that still ends, on disk,
      // on the limit — and so is still owed its nudge.
      let onDisk = entry.cutByLimit || !entry.claudeSessionId ? null : endedOnLimit(this.history.transcriptPath(entry.cwd, entry.claudeSessionId));
      // A limit hit before you overrode the pause by hand is not owed anything.
      if (onDisk && this.limitOverride && (onDisk.at || 0) <= this.limitOverride) onDisk = null;
      if (onDisk && onDisk.resetsAt) this.knownReset = Math.max(this.knownReset || 0, onDisk.resetsAt);
      this.create({
        id: entry.id,
        cwd: outsideWorktree(entry.cwd),
        title: entry.customTitle,
        ticket: entry.ticket,
        autoLabel: entry.autoLabel,
        prPane: entry.prPane,
        prPinned: entry.prPinned,
        prUrl: entry.prUrl,
        resume: entry.claudeSessionId,
        totalCost: entry.totalCost,
        usage: entry.usage,
        turnLog: entry.turnLog,
        startedAt: entry.startedAt,
        turns: entry.turns,
        errors: entry.errors,
        interrupts: entry.interrupts,
        status: entry.status,
        finishedAt: entry.finishedAt,
        compactions: entry.compactions,
        lastCompactedAt: entry.lastCompactedAt,
        queue: entry.queue,
        cutByLimit: !!(entry.cutByLimit || onDisk),
        unread: !!entry.unread,
        autoStart: false
      });
    }
    return this.list.length;
  }
}

module.exports = { SessionManager, readConfig: readFrom, readSnippets, pickReset, outsideWorktree, RESUME_GRACE_MS, BLIND_RETRY_MS };
