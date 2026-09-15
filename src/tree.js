'use strict';

const vscode = require('vscode');
const path = require('path');
const { STATUS } = require('./session');

// Real coloured icons in the sidebar — the thing a terminal tab cannot do.
const LOOK = {
  [STATUS.IDLE]:    { icon: 'circle-outline', color: 'descriptionForeground', word: 'idle' },
  [STATUS.WORKING]: { icon: 'circle-filled',  color: 'charts.orange',         word: 'working' },
  [STATUS.WAITING]: { icon: 'question',       color: 'charts.red',            word: 'needs you' },
  [STATUS.DONE]:    { icon: 'circle-filled',  color: 'charts.green',          word: 'done' },
  [STATUS.ERROR]:   { icon: 'error',          color: 'charts.red',            word: 'error' },
  [STATUS.STOPPED]: { icon: 'circle-slash',   color: 'disabledForeground',    word: 'stopped' }
};

class SessionTree {
  constructor(manager) {
    this.manager = manager;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    manager.on('changed', () => this._onDidChangeTreeData.fire());
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(session) {
    const look = LOOK[session.status] || LOOK[STATUS.IDLE];
    const item = new vscode.TreeItem(session.label, vscode.TreeItemCollapsibleState.None);
    item.id = session.id;
    item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
    item.description = describe(session, look);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${session.label}** — ${look.word}`,
        '',
        `- Folder: \`${session.cwd}\``,
        `- Model: ${session.meta.model || 'default'}`,
        `- Cost: $${session.totalCost.toFixed(4)}`,
        session.claudeSessionId ? `- Session: \`${session.claudeSessionId}\`` : '',
        session.lastError ? `- Error: ${session.lastError}` : ''
      ].filter(Boolean).join('\n')
    );
    item.contextValue = session.isBusy ? 'running' : 'idle';
    item.command = { command: 'nikui.open', title: 'Open', arguments: [session.id] };
    return item;
  }

  getChildren() {
    return this.manager.list;
  }
}

function describe(session, look) {
  const folder = path.basename(session.cwd || '');
  const bits = [];
  if (session.ticket && folder) bits.push(folder);
  else if (!session.ticket) bits.push(look.word);
  if (session.totalCost > 0) bits.push(`$${session.totalCost.toFixed(2)}`);
  return bits.join(' · ');
}

module.exports = { SessionTree, LOOK };
