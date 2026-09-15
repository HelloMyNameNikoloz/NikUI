'use strict';

const vscode = require('vscode');
const path = require('path');
const { listSessions } = require('./history');

class HistoryTree {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.scope = 'workspace'; // or 'all'
  }

  refresh() { this._onDidChangeTreeData.fire(); }

  toggleScope() {
    this.scope = this.scope === 'workspace' ? 'all' : 'workspace';
    this.refresh();
    return this.scope;
  }

  getTreeItem(entry) {
    const item = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
    item.id = entry.sessionId;
    item.iconPath = new vscode.ThemeIcon('history');
    item.description = `${path.basename(entry.cwd || '')} · ${ago(entry.modified)}`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${entry.title}**`,
        '',
        `- Folder: \`${entry.cwd || 'unknown'}\``,
        entry.branch ? `- Branch: \`${entry.branch}\`` : '',
        `- Last used: ${entry.modified.toLocaleString()}`,
        `- Session: \`${entry.sessionId}\``
      ].filter(Boolean).join('\n')
    );
    item.contextValue = 'historyEntry';
    item.command = { command: 'nikui.resumeHistory', title: 'Resume', arguments: [entry] };
    return item;
  }

  async getChildren(element) {
    if (element) return [];
    const folders = vscode.workspace.workspaceFolders || [];
    if (this.scope === 'workspace' && folders.length) {
      // One sweep, then keep anything under a workspace folder (worktrees included).
      const roots = folders.map((f) => f.uri.fsPath);
      const recent = await listSessions({ limit: 150 });
      return recent
        .filter((e) => e.cwd && roots.some((r) => e.cwd === r || e.cwd.startsWith(r + '/')))
        .slice(0, 40);
    }
    return listSessions({ limit: 40 });
  }
}

function ago(date) {
  const secs = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

module.exports = { HistoryTree };
