'use strict';

const vscode = require('vscode');
const path = require('path');
const { EventEmitter } = require('events');
const { Session, endedOnLimit } = require('./session');
const { transcriptPath } = require('./history');

const STORAGE_KEY = 'nikui.sessions.v1';
// The plan's limits belong to the account, not to a window or a folder.
const LIMITS_KEY = 'nikui.limits.v1';
const PAUSE_KEY = 'nikui.pause.v1';
// A minute past the reset, because the window boundary is not to the second and
// being turned away again would just start the whole dance over.
const RESUME_GRACE_MS = 60000;
// If the CLI never says when the quota comes back, look again in a while rather
// than waiting for ever.
const BLIND_RETRY_MS = 15 * 60000;
// One number for both sides of a reload. Remembering more than we restore
// loses rows silently, which is worse than remembering fewer.
const KEEP = 20;
// Turns kept per instance across a reload. Enough to redraw the charts without
// making the workspace store carry the whole conversation.
const KEEP_TURNS = 60;
// Enough that nobody loses a night's queue, few enough that workspace storage
// stays a list of prompts rather than a copy of the conversation.
const KEEP_QUEUED = 50;
const QUEUED_TEXT_MAX = 8000;

/** Only what /status draws, so a remembered turn stays small. */
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

/**
 * Yours merged over the built-in ones. VS Code replaces an object setting
 * wholesale, so adding a snippet of your own would otherwise silently delete
 * the ones that ship with NikUI; an empty string is how you turn one off.
 */
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

function readSnippets(cfg) {
  let shipped = {};
  try {
    const declared = cfg.inspect && cfg.inspect('promptSnippets');
    shipped = (declared && declared.defaultValue) || {};
  } catch (_) { /* older host, or a stub */ }
  return Object.assign({}, shipped, cfg.get('promptSnippets', {}));
}

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('nikui');
  return {
    claudePath: cfg.get('claudePath', 'claude'),
    model: cfg.get('model', ''),
    permissionMode: cfg.get('permissionMode', 'bypassPermissions'),
    effort: cfg.get('effort', ''),
    outputStyle: cfg.get('outputStyle', 'Concise'),
    extraArgs: cfg.get('extraArgs', []),
    autoTitle: cfg.get('autoTitleFromTicket', true),
    fontFamily: cfg.get('fontFamily', ''),
    fontSize: cfg.get('fontSize', 13),
    showThinking: cfg.get('showThinking', true),
    clock: cfg.get('clock', '24h'),
    replySuggestions: cfg.get('replySuggestions', true),
    pauseOnLimit: cfg.get('pauseWhenQuotaRuns', true),
    resumePrompt: cfg.get('resumePrompt',
      'Your usage limit reset and NikUI has restarted this instance. Carry on with the task you were ' +
      'working on before the pause, from where you left off. If it was already finished, say so and stop.'),
    notifyOnAttention: cfg.get('notifyOnAttention', true),
    promptSnippets: readSnippets(cfg),
    interruptOnSingleEscape: cfg.get('interruptOnSingleEscape', false),
    maxItems: cfg.get('maxTranscriptItems', 400),
    keepPanelsWarm: cfg.get('keepHiddenPanelsWarm', false),
    statusEmoji: cfg.get('statusEmoji', {})
  };
}

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
  constructor(context) {
    super();
    this.context = context;
    this.sessions = new Map();
    this.activeId = null;
    this.limits = context.globalState.get(LIMITS_KEY, null);
    // A pause outlives the window it started in: the quota is the account's and
    // the reset time does not care whether VS Code was open.
    this.pause = context.globalState.get(PAUSE_KEY, null);
    this._resumeTimer = null;
    this.durable = null;
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
    return readConfig();
  }

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
    const cfg = this.config;
    const session = new Session({
      id,
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
      unread
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
    session.on('watch', () => this.emit('watch', session));
    // Whichever instance hears about the account's limits, all of them know.
    session.on('limits', (limits) => this.rememberLimits(limits));
    session.on('exhausted', (limits) => this.pauseForLimit(limits));
    session.on('meta', () => {
      this.rememberCommands(session.meta.slashCommands);
      this._changed(session);
    });

    if (usage) Object.assign(session.usage, usage);
    if (prPane && typeof prPane === 'object') session.prPane = { open: !!prPane.open, tab: prPane.tab || 'overview', width: prPane.width || null };
    if (prPinned && prUrl) { session.prPinned = true; session.prUrl = prUrl; }
    this.sessions.set(session.id, session);
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
    for (const session of this.list) session.pause({ until, reason: 'limit' });
    this._armResume();
    this.emit('paused', this.pause);
    this.emit('changed');
    return true;
  }

  /** Back to work: every held instance is released, and the cut-off ones nudged. */
  resumeFromLimit({ manual } = {}) {
    if (!this.pause) return 0;
    const nudge = this.config.resumePrompt;
    this.pause = null;
    this.context.globalState.update(PAUSE_KEY, null);
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }

    let woken = 0;
    for (const session of this.list) if (session.resume({ nudge })) woken += 1;
    this.emit('resumed', { woken, manual: !!manual });
    this.emit('changed');
    return woken;
  }

  /**
   * Hold anything made while the window is paused, so an instance started
   * during the night does not sail past the quota everything else is waiting on.
   */
  _applyPause(session) {
    if (this.pause) session.pause({ until: this.pause.until, reason: 'limit' });
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
    }
    for (const session of this.list) session.pause({ until: this.pause.until, reason: 'limit' });
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

  disposeAll() {
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    for (const session of this.list) session.dispose();
    this.sessions.clear();
  }

  _changed(session) {
    this.emit('session-changed', session);
    this.emit('changed');
    this.persist();
  }

  // Remember enough to offer a resume after a window reload.
  persist() {
    const data = this.list
      .filter((s) => s.claudeSessionId)
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
        queue: (s.queue || []).slice(0, KEEP_QUEUED).map(slimQueued),
        // Work the limit cut off. It was only ever held in memory, so a reload
        // during a pause forgot who to nudge, and those instances stayed red.
        cutByLimit: !!(s.cutByLimit || s.interruptedByPause),
        // Not opened since it finished: still not, after a reload.
        unread: !!s.unread
      }));
    this.context.workspaceState.update(STORAGE_KEY, data.slice(-KEEP));
    if (this.durable) this.durable.set(STORAGE_KEY, data.slice(-KEEP));
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
    const saved = this.restorable().filter((s) => s.claudeSessionId && s.cwd);
    for (const entry of saved.slice(-KEEP)) {
      if (this.sessions.has(entry.id)) continue;
      // What the CLI wrote down outranks what this window remembered: an
      // instance cut off before NikUI kept track of that still ends, on disk,
      // on the limit — and so is still owed its nudge.
      const onDisk = entry.cutByLimit ? null : endedOnLimit(transcriptPath(entry.cwd, entry.claudeSessionId));
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

module.exports = { SessionManager, readConfig, readSnippets, pickReset, outsideWorktree, RESUME_GRACE_MS, BLIND_RETRY_MS };
