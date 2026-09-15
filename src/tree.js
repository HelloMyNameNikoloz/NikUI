'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { STATUS } = require('./session');

const MIME = 'application/vnd.code.tree.nikui.sessions';

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
  constructor(manager, folders) {
    this.manager = manager;
    this.folders = folders;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cache = new Map();

    // Drag an instance onto a folder to file it there.
    this.dropMimeTypes = [MIME];
    this.dragMimeTypes = [MIME];

    manager.on('changed', () => {
      this.folders.prune(manager.list.map((s) => s.id));
      this._cache.clear();
      this._onDidChangeTreeData.fire();
    });
  }

  refresh() {
    rootCache.clear();
    this._cache.clear();
    this._onDidChangeTreeData.fire();
  }

  // ---- drag and drop ------------------------------------------------------

  handleDrag(source, dataTransfer) {
    const ids = source.filter((s) => s && !s.__folder && !s.__group).map((s) => s.id);
    if (ids.length) dataTransfer.set(MIME, new vscode.DataTransferItem(ids));
  }

  async handleDrop(target, dataTransfer) {
    const item = dataTransfer.get(MIME);
    if (!item) return;

    let ids = item.value;
    if (typeof ids === 'string') {
      try { ids = JSON.parse(ids); } catch (_) { ids = [ids]; }
    }
    if (!Array.isArray(ids)) ids = [ids];

    // Dropping on a folder files it there; on a project group or empty space
    // it goes back to the top level; on another instance it joins that one.
    let folderId = null;
    if (target && target.__folder) folderId = target.id;
    else if (target && !target.__group) {
      const owner = this.folders.folderOf(target.id);
      folderId = owner ? owner.id : null;
    }

    for (const id of ids) this.folders.place(id, folderId);
    this.refresh();
  }

  // ---- structure ----------------------------------------------------------

  // Stable identity across calls: reveal() and getParent() compare objects, so
  // rebuilding them every time breaks both.
  cached(key, build) {
    if (this._cache.has(key)) return this._cache.get(key);
    const value = build();
    this._cache.set(key, value);
    return value;
  }

  projectGroups(sessions) {
    const key = 'g:' + sessions.map((s) => s.id).join(',');
    return this.cached(key, () => {
      const byRoot = new Map();
      for (const session of sessions) {
        const root = projectRoot(session.cwd);
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root).push(session);
      }
      return [...byRoot.entries()]
        .map(([root, list]) => ({ __group: true, root, label: path.basename(root) || root, sessions: list }))
        .sort((a, b) => a.label.localeCompare(b.label));
    });
  }

  userFolders(sessions) {
    const defs = this.folders.list();
    const key = 'f:' + defs.map((f) => f.id + ':' + f.name).join(',') + '|' +
      sessions.map((s) => s.id + '>' + (this.folders.folderOf(s.id) || { id: '' }).id).join(',');
    return this.cached(key, () => defs.map((def) => ({
      __folder: true,
      id: def.id,
      label: def.name,
      sessions: sessions.filter((s) => {
        const owner = this.folders.folderOf(s.id);
        return owner && owner.id === def.id;
      })
    })));
  }

  shouldGroup(groupCount) {
    const mode = vscode.workspace.getConfiguration('nikui').get('groupByProject', 'auto');
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return groupCount > 1; // auto: only worth a level of nesting once there are several
  }

  getChildren(element) {
    if (element && (element.__folder || element.__group)) return element.sessions;
    if (element) return [];

    const all = this.manager.list;
    const folders = this.userFolders(all);

    // Without user folders nothing changes: project grouping as before.
    const loose = folders.length ? all.filter((s) => !this.folders.folderOf(s.id)) : all;
    const groups = this.projectGroups(loose);
    const rest = this.shouldGroup(groups.length) ? groups : loose;
    return folders.concat(rest);
  }

  getTreeItem(element) {
    if (element.__folder) return this.folderItem(element);
    if (element.__group) return this.groupItem(element);
    return this.sessionItem(element);
  }

  folderItem(folder) {
    const state = folder.sessions.length
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(folder.label, state);
    item.id = 'folder:' + folder.id;
    item.contextValue = 'nikuiFolder';
    item.iconPath = new vscode.ThemeIcon('folder');
    const busy = folder.sessions.filter((s) => s.isBusy).length;
    const bits = [String(folder.sessions.length)];
    if (busy) bits.push(`${busy} working`);
    item.description = folder.sessions.length ? bits.join(' · ') : 'empty — drag instances here';
    item.tooltip = new vscode.MarkdownString(`**${folder.label}**\n\nDrag instances onto this folder to file them.`);
    return item;
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
    if (!element || element.__group || element.__folder) return null;
    const all = this.manager.list;
    const owner = this.folders.folderOf(element.id);
    if (owner) return this.userFolders(all).find((f) => f.id === owner.id) || null;
    const folders = this.userFolders(all);
    const loose = folders.length ? all.filter((s) => !this.folders.folderOf(s.id)) : all;
    const groups = this.projectGroups(loose);
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

module.exports = { SessionTree, LOOK, projectRoot, MIME };
