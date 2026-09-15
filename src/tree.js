'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { STATUS } = require('./session');

const MIME = 'application/vnd.code.tree.nikui.sessions';

// Real coloured icons in the sidebar — the thing a terminal tab cannot do.
// Restored from a previous window and not opened since. Derived rather than a
// status of its own: the status machine belongs to the CLI, and a seventh value
// in it would have to be handled everywhere the other six are.
const ASLEEP = { icon: 'debug-pause', color: 'disabledForeground', word: 'asleep' };

// A green dot means "this just finished, look at it". Five minutes later it
// means nothing, so it stops being green and goes back to reading as idle.
const DONE_FADES_AFTER_MS = 5 * 60 * 1000;

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

    // Nothing else would redraw a quiet row, and "done" has to stop being green
    // eventually. Only fires when a row would actually change.
    this._fade = setInterval(() => {
      const stale = manager.list.some((s) =>
        s.status === STATUS.DONE && s.finishedAt && Date.now() - s.finishedAt > DONE_FADES_AFTER_MS);
      if (stale) this._onDidChangeTreeData.fire();
    }, 60000);
    if (this._fade.unref) this._fade.unref();
  }

  dispose() {
    if (this._fade) clearInterval(this._fade);
    this._fade = null;
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

    // A project group is where an instance's own folder on disk puts it, so
    // there is nothing to move it into — dropping there used to quietly take it
    // out of whatever folder it was in, which is the opposite of what the
    // gesture looks like.
    if (target && target.__group) {
      vscode.window.setStatusBarMessage(
        'NikUI: projects come from the folder on disk — drop onto one of your own folders instead', 4000
      );
      return;
    }

    // Dropping on a folder files it there; on empty space it goes back to the
    // top level; on another instance it joins whatever folder that one is in.
    let folderId = null;
    if (target && target.__folder) folderId = target.id;
    else if (target) {
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
    // The same three facts a project row shows, in the same order.
    item.description = folder.sessions.length ? summarise(folder.sessions) : 'empty — drag instances here';
    item.tooltip = new vscode.MarkdownString(`**${folder.label}**\n\nDrag instances onto this folder to file them.`);
    return item;
  }

  groupItem(group) {
    const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'group:' + group.root;
    item.contextValue = 'projectGroup';
    item.resourceUri = vscode.Uri.file(group.root);
    item.iconPath = vscode.ThemeIcon.Folder;

    item.description = summarise(group.sessions);
    item.tooltip = new vscode.MarkdownString(`**${group.label}**\n\n\`${group.root}\``);
    return item;
  }

  sessionItem(session) {
    const look = lookFor(session);
    const name = this.manager.displayName ? this.manager.displayName(session) : session.label;
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.id = session.id;
    item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
    item.description = describe(session, look);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${name}** — ${look.word}`,
        '',
        session.isAsleep ? '- Restored from your last window. Opening it starts the process and picks the conversation back up.' : '',
        `- Folder: \`${session.cwd}\``,
        `- Model: ${session.meta.model || 'default'}`,
        session.permissionMode === 'bypassPermissions'
          ? '- Permissions: **bypassed** — tools run without asking'
          : `- Permissions: ${session.permissionMode}`,
        `- Cost: $${session.totalCost.toFixed(4)}`,
        (session.queue || []).length
          ? `- Queued: ${session.queue.length} prompt${session.queue.length === 1 ? '' : 's'} waiting to be sent`
          : '',
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

/** How many, how many of those are working, and what they have cost. */
function summarise(sessions) {
  const busy = sessions.filter((s) => s.isBusy).length;
  const cost = sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
  const bits = [String(sessions.length)];
  if (busy) bits.push(`${busy} working`);
  if (cost > 0) bits.push('$' + cost.toFixed(2));
  return bits.join(' · ');
}

/** What look a row wears: its status, unless it has never been woken up. */
function lookFor(session, now) {
  if (session.isAsleep) return ASLEEP;
  if (session.status === STATUS.DONE && session.finishedAt &&
      (now || Date.now()) - session.finishedAt > DONE_FADES_AFTER_MS) {
    return LOOK[STATUS.IDLE];
  }
  return LOOK[session.status] || LOOK[STATUS.IDLE];
}

/**
 * One grammar for every row: state, then the folder when it is not the project
 * the row already sits under (a worktree, say), then the cost. Every row reads
 * the same way — the old rule showed the folder OR the state depending on
 * whether the instance happened to have a ticket number.
 */
function describe(session, look) {
  const bits = [look.word];
  const queued = (session.queue || []).length;
  // What is about to happen belongs next to what is happening.
  if (queued) bits.push(`${queued} queued`);
  const folder = path.basename(session.cwd || '');
  const project = path.basename(projectRoot(session.cwd) || '');
  if (folder && folder !== project) bits.push(folder);
  if (session.totalCost > 0) bits.push(`$${session.totalCost.toFixed(2)}`);
  return bits.join(' · ');
}

module.exports = { SessionTree, LOOK, ASLEEP, lookFor, describe, summarise, projectRoot, MIME, DONE_FADES_AFTER_MS };
