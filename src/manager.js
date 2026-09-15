'use strict';

const vscode = require('vscode');
const { EventEmitter } = require('events');
const { Session } = require('./session');

const STORAGE_KEY = 'nikui.sessions.v1';

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

  create({ cwd, title, resume }) {
    const cfg = this.config;
    const session = new Session({
      cwd,
      customTitle: title || null,
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
    session.on('meta', () => { this._changed(session); });

    this.sessions.set(session.id, session);
    session.start();
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
      .map((s) => ({ cwd: s.cwd, customTitle: s.customTitle, ticket: s.ticket, claudeSessionId: s.claudeSessionId }));
    this.context.workspaceState.update(STORAGE_KEY, data.slice(-20));
  }

  restorable() {
    return this.context.workspaceState.get(STORAGE_KEY, []);
  }
}

module.exports = { SessionManager, readConfig };
