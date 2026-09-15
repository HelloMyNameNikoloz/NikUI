'use strict';

const vscode = require('vscode');
const fs = require('fs');
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

const rootCache = new Map();

/**
 * The project an instance belongs to: its workspace folder if it has one,
 * otherwise the nearest git root, otherwise its own directory. Worktrees under
 * a project therefore group with that project rather than on their own.
 */
function projectRoot(cwd) {
  if (!cwd) return '';
  if (rootCache.has(cwd)) return rootCache.get(cwd);

  let best = null;
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const p = folder.uri.fsPath;
    if (cwd === p || cwd.startsWith(p + path.sep)) {
      if (!best || p.length > best.length) best = p;
    }
  }

  if (!best) {
    let dir = cwd;
    for (let i = 0; i < 10; i++) {
      try { if (fs.existsSync(path.join(dir, '.git'))) { best = dir; break; } } catch (_) { /* unreadable */ }
      const up = path.dirname(dir);
      if (!up || up === dir) break;
      dir = up;
    }
  }

  const root = best || cwd;
  rootCache.set(cwd, root);
  return root;
}

class SessionTree {
  constructor(manager) {
    this.manager = manager;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    manager.on('changed', () => this._onDidChangeTreeData.fire());
  }

  refresh() {
    rootCache.clear();
    this._groupCache = null;
    this._onDidChangeTreeData.fire();
  }

  groups() {
    // Stable identity across calls: reveal() and getParent() compare objects,
    // so rebuilding them every time breaks both.
    const key = this.manager.list.map((x) => x.id).join(",");
    if (this._groupKey === key && this._groupCache) return this._groupCache;

    const byRoot = new Map();
    for (const session of this.manager.list) {
      const root = projectRoot(session.cwd);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(session);
    }
    this._groupKey = key;
    this._groupCache = [...byRoot.entries()]
      .map(([root, sessions]) => ({
        __group: true,
        root,
        label: path.basename(root) || root,
        sessions
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return this._groupCache;
  }

  shouldGroup(groupCount) {
    const mode = vscode.workspace.getConfiguration('nikui').get('groupByProject', 'auto');
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return groupCount > 1; // auto: only worth a level of nesting once there are several
  }

  getChildren(element) {
    if (element && element.__group) return element.sessions;
    if (element) return [];
    const groups = this.groups();
    return this.shouldGroup(groups.length) ? groups : this.manager.list;
  }

  getTreeItem(element) {
    return element.__group ? this.groupItem(element) : this.sessionItem(element);
  }

  groupItem(group) {
    const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'group:' + group.root;
    item.contextValue = 'projectGroup';
    item.resourceUri = vscode.Uri.file(group.root);
    item.iconPath = vscode.ThemeIcon.Folder;

    const busy = group.sessions.filter((s) => s.isBusy).length;
    const cost = group.sessions.reduce((sum, s) => sum + s.totalCost, 0);
    const bits = [`${group.sessions.length}`];
    if (busy) bits.push(`${busy} working`);
    if (cost > 0) bits.push('$' + cost.toFixed(2));
    item.description = bits.join(' · ');
    item.tooltip = new vscode.MarkdownString(`**${group.label}**\n\n\`${group.root}\``);
    return item;
  }

  sessionItem(session) {
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

  getParent(element) {
    if (!element || element.__group) return null;
    const groups = this.groups();
    if (!this.shouldGroup(groups.length)) return null;
    return groups.find((g) => g.sessions.includes(element)) || null;
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

module.exports = { SessionTree, LOOK, projectRoot };
