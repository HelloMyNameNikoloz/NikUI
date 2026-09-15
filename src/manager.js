'use strict';

const vscode = require('vscode');
const path = require('path');
const { EventEmitter } = require('events');
const { Session } = require('./session');

const STORAGE_KEY = 'nikui.sessions.v1';
// One number for both sides of a reload. Remembering more than we restore
// loses rows silently, which is worse than remembering fewer.
const KEEP = 20;
// Turns kept per instance across a reload. Enough to redraw the charts without
// making the workspace store carry the whole conversation.
const KEEP_TURNS = 60;

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

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('nikui');
  return {
    claudePath: cfg.get('claudePath', 'claude'),
    model: cfg.get('model', ''),
    permissionMode: cfg.get('permissionMode', 'bypassPermissions'),
    effort: cfg.get('effort', 'max'),
    outputStyle: cfg.get('outputStyle', 'Concise'),
    extraArgs: cfg.get('extraArgs', []),
    autoTitle: cfg.get('autoTitleFromTicket', true),
    fontFamily: cfg.get('fontFamily', ''),
    fontSize: cfg.get('fontSize', 13),
    showThinking: cfg.get('showThinking', true),
    notifyOnAttention: cfg.get('notifyOnAttention', true),
    interruptOnSingleEscape: cfg.get('interruptOnSingleEscape', false),
    maxItems: cfg.get('maxTranscriptItems', 400),
    keepPanelsWarm: cfg.get('keepHiddenPanelsWarm', false),
    statusEmoji: cfg.get('statusEmoji', {})
  };
}

class SessionManager extends EventEmitter {
  constructor(context) {
    super();
    this.context = context;
    this.sessions = new Map();
    this.activeId = null;
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
    turns, errors, interrupts, status, finishedAt }) {
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
      // What the status sheet needs to keep telling the truth after a reload.
      turnLog,
      startedAt,
      turns,
      errors,
      interrupts,
      // How the conversation left off, so the row looks the same after a reload
      // as it did before one.
      status,
      finishedAt
    });

    session.on('status', () => { this._changed(session); });
    // One place to listen for trouble, however many instances there are.
    session.on('failed', (message, code) => this.emit('failed', session, message, code));
    // A queued prompt changes what the row has to say about the instance.
    session.on('queue', () => this._changed(session));
    session.on('meta', () => {
      this.rememberCommands(session.meta.slashCommands);
      this._changed(session);
    });

    if (usage) Object.assign(session.usage, usage);
    this.sessions.set(session.id, session);
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

  /** Kill the process but keep the instance: the conversation resumes on open. */
  sleep(id) {
    const session = this.sessions.get(id);
    if (!session || !session.isRunning) return false;
    session.stop();
    this._changed(session);
    return true;
  }

  disposeAll() {
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
        claudeSessionId: s.claudeSessionId, totalCost: s.totalCost, usage: s.usage,
        // The running totals are remembered, so the charts that explain them
        // have to be remembered too — a real cost above an empty chart is worse
        // than either on its own.
        startedAt: s.startedAt, turns: s.turns, errors: s.errors, interrupts: s.interrupts,
        status: s.status, finishedAt: s.finishedAt,
        turnLog: (s.turnLog || []).slice(-KEEP_TURNS).map(slimTurn)
      }));
    this.context.workspaceState.update(STORAGE_KEY, data.slice(-KEEP));
  }

  restorable() {
    return this.context.workspaceState.get(STORAGE_KEY, []);
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
      this.create({
        id: entry.id,
        cwd: entry.cwd,
        title: entry.customTitle,
        ticket: entry.ticket,
        autoLabel: entry.autoLabel,
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
        autoStart: false
      });
    }
    return this.list.length;
  }
}

module.exports = { SessionManager, readConfig };
