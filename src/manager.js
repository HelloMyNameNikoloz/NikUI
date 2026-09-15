'use strict';

const vscode = require('vscode');
const { EventEmitter } = require('events');
const { Session } = require('./session');

const STORAGE_KEY = 'nikui.sessions.v1';
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
    statusEmoji: cfg.get('statusEmoji', {})
  };
}

class SessionManager extends EventEmitter {
  constructor(context) {
    super();
    this.context = context;
    this.sessions = new Map();
  }

  get list() {
    return [...this.sessions.values()];
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

  create({ id, cwd, title, ticket, autoLabel, resume, autoStart, totalCost, usage }) {
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
      autoTitle: cfg.autoTitle
    });

    session.on('status', () => { this._changed(session); });
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
    this.emit('changed');
    this.persist();
  }

  removeStopped() {
    let removed = 0;
    for (const session of this.list) {
      if (!session.isRunning) { session.dispose(); this.sessions.delete(session.id); removed++; }
    }
    if (removed) { this.emit('changed'); this.persist(); }
    return removed;
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
      .map((s) => ({ id: s.id, cwd: s.cwd, customTitle: s.customTitle, autoLabel: s.autoLabel, ticket: s.ticket,
        claudeSessionId: s.claudeSessionId, totalCost: s.totalCost, usage: s.usage }));
    this.context.workspaceState.update(STORAGE_KEY, data.slice(-20));
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
    for (const entry of saved.slice(-8)) {
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
        autoStart: false
      });
    }
    return this.list.length;
  }
}

module.exports = { SessionManager, readConfig };
