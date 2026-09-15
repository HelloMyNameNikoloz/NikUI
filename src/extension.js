'use strict';

const vscode = require('vscode');
const path = require('path');
const { SessionManager } = require('./manager');
const { SessionTree } = require('./tree');
const { FolderStore } = require('./folders');
const { SessionPanel } = require('./panel');
const { HistoryTree } = require('./historyTree');
const { nextTicket } = require('./ticket');

let manager;

function activate(context) {
  manager = new SessionManager(context);
  const folders = new FolderStore(context);
  const tree = new SessionTree(manager, folders);

  const view = vscode.window.createTreeView('nikui.sessions', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: true
  });
  context.subscriptions.push(view);

  const history = new HistoryTree();
  const historyView = vscode.window.createTreeView('nikui.history', { treeDataProvider: history });
  context.subscriptions.push(historyView);
  // Transcripts are written continuously; re-read whenever the panel is shown.
  context.subscriptions.push(historyView.onDidChangeVisibility((e) => { if (e.visible) history.refresh(); }));
  manager.on('changed', () => history.refresh());

  // Keep the sidebar badge honest about how many instances are busy.
  manager.on('changed', () => {
    const busy = manager.list.filter((s) => s.isBusy).length;
    view.badge = busy ? { value: busy, tooltip: `${busy} working` } : undefined;
  });

  const resolve = (arg) => {
    if (!arg) return null;
    if (typeof arg === 'string') return manager.get(arg);
    if (arg.id) return manager.get(arg.id) || arg;
    return null;
  };

  const pickSession = async (arg) => {
    const direct = resolve(arg);
    if (direct) return direct;
    const list = manager.list;
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    const choice = await vscode.window.showQuickPick(
      list.map((s) => ({ label: s.label, description: s.status, session: s })),
      { placeHolder: 'Pick an instance' }
    );
    return choice ? choice.session : null;
  };

  const register = (id, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('nikui.newSession', async () => {
    const cwd = await pickFolder(manager);
    if (!cwd) return;
    const session = manager.create({ cwd: cwd.path, resume: cwd.resume, title: cwd.title });
    SessionPanel.show(session, context, manager).focusInput();
  });

  register('nikui.newSessionHere', async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Start instance here'
    });
    if (!picked || !picked.length) return;
    const session = manager.create({ cwd: picked[0].fsPath });
    SessionPanel.show(session, context, manager).focusInput();
  });

  register('nikui.open', async (arg) => {
    const session = await pickSession(arg);
    if (session) SessionPanel.show(session, context, manager).focusInput();
  });

  register('nikui.interrupt', async (arg) => {
    const session = await pickSession(arg);
    if (session) session.interrupt();
  });

  register('nikui.restart', async (arg) => {
    const session = await pickSession(arg);
    if (!session) return;
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Restart and keep context', detail: 'Resumes the same Claude session', keep: true },
        { label: 'Restart fresh', detail: 'Clears the transcript and starts a new session', keep: false }
      ],
      { placeHolder: `Restart ${session.label}` }
    );
    if (!choice) return;
    session.restart({ keepContext: choice.keep });
  });

  register('nikui.stop', async (arg) => {
    const session = await pickSession(arg);
    if (!session) return;
    // Closing an idle instance is cheap and reversible via History; only ask
    // when it would kill a turn that is still running.
    if (session.isBusy) {
      const go = await vscode.window.showWarningMessage(
        `${session.label} is still working. Close it anyway?`,
        { modal: true }, 'Close'
      );
      if (go !== 'Close') return;
    }
    session.stop();
    SessionPanel.close(session.id);
    manager.remove(session.id);
    history.refresh();
  });

  register('nikui.rename', async (arg) => {
    const session = await pickSession(arg);
    if (!session) return;
    const value = await vscode.window.showInputBox({
      prompt: 'Instance name (leave empty to go back to automatic PR/issue naming)',
      value: session.customTitle || ''
    });
    if (value === undefined) return;
    session.rename(value);
  });

  register('nikui.clearStopped', () => {
    const removed = manager.removeStopped();
    vscode.window.setStatusBarMessage(
      removed ? `NikUI: removed ${removed} stopped instance${removed === 1 ? '' : 's'}` : 'NikUI: nothing to remove',
      3000
    );
  });

  register('nikui.refresh', () => { tree.refresh(); history.refresh(); });

  register('nikui.newFolder', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Name for the new folder',
      placeHolder: 'e.g. Peuka backend, Spikes, Reviews'
    });
    if (!name || !name.trim()) return;
    folders.create(name);
    tree.refresh();
  });

  register('nikui.renameFolder', async (node) => {
    const id = folderIdOf(node);
    if (!id) return;
    const current = folders.get(id);
    const name = await vscode.window.showInputBox({ prompt: 'Rename folder', value: current ? current.name : '' });
    if (!name || !name.trim()) return;
    folders.rename(id, name);
    tree.refresh();
  });

  register('nikui.deleteFolder', async (node) => {
    const id = folderIdOf(node);
    if (!id) return;
    const folder = folders.get(id);
    if (!folder) return;
    // Deleting a folder never touches the instances inside it.
    folders.remove(id);
    tree.refresh();
    vscode.window.setStatusBarMessage(`NikUI: removed folder "${folder.name}"`, 2500);
  });

  register('nikui.moveToFolder', async (arg) => {
    const session = await pickSession(arg);
    if (!session) return;
    const current = folders.folderOf(session.id);
    const items = folders.list().map((f) => ({
      label: (current && current.id === f.id ? '$(check) ' : '$(folder) ') + f.name,
      folderId: f.id
    }));
    items.push({ label: '$(new-folder) New folder...', create: true });
    if (current) items.push({ label: '$(close) Remove from folder', folderId: null });
    const choice = await vscode.window.showQuickPick(items, { placeHolder: `Move ${session.label} to...` });
    if (!choice) return;
    if (choice.create) {
      const name = await vscode.window.showInputBox({ prompt: 'Name for the new folder' });
      if (!name || !name.trim()) return;
      const made = folders.create(name);
      folders.place(session.id, made.id);
    } else {
      folders.place(session.id, choice.folderId);
    }
    tree.refresh();
  });

  register('nikui.refreshHistory', () => history.refresh());

  register('nikui.showHistory', async () => {
    history.refresh();
    await vscode.commands.executeCommand('nikui.history.focus');
  });

  register('nikui.historyScope', () => {
    const scope = history.toggleScope();
    vscode.window.setStatusBarMessage(
      scope === 'all' ? 'NikUI history: all folders' : 'NikUI history: this workspace', 2500
    );
  });

  register('nikui.resumeHistory', async (entry) => {
    if (!entry || !entry.sessionId) return;
    const cwd = entry.cwd || (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath;
    if (!cwd) { vscode.window.showWarningMessage('NikUI: that transcript has no folder recorded.'); return; }
    const live = manager.list.find((s) => s.claudeSessionId === entry.sessionId);
    if (live) { SessionPanel.show(live, context, manager).focusInput(); return; }
    // Recover a PR/issue number from the stored prompt so the instance is not
    // just named after its folder.
    const ticket = nextTicket(null, entry.title || '');
    const session = manager.create({
      cwd,
      resume: entry.sessionId,
      title: null,
      ticket,
      autoLabel: ticket ? null : shortLabel(entry.title)
    });
    SessionPanel.show(session, context, manager).focusInput();
  });

  // Bring back the instances that were open before the reload, then let VS Code
  // hand their editor tabs back to us.
  manager.restoreOpen();

  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('nikui.session', {
    async deserializeWebviewPanel(panel, state) {
      const id = state && state.sessionId;
      const session = id ? manager.get(id) : null;
      if (!session) { panel.dispose(); return; }
      SessionPanel.adopt(panel, session, context, manager);
    }
  }));

  context.subscriptions.push({ dispose: () => manager.disposeAll() });
}

async function pickFolder(mgr) {
  const items = [];
  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    items.push({ label: `$(folder) ${f.name}`, description: f.uri.fsPath, path: f.uri.fsPath });
  }

  for (const saved of mgr.restorable()) {
    if (!saved.claudeSessionId) continue;
    items.push({
      label: `$(history) ${saved.customTitle || saved.ticket || path.basename(saved.cwd)}`,
      description: `resume · ${saved.cwd}`,
      path: saved.cwd,
      resume: saved.claudeSessionId,
      title: saved.customTitle
    });
  }

  items.push({ label: '$(folder-opened) Browse...', description: 'Pick any folder', browse: true });

  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Where should this instance run?' });
  if (!choice) return null;
  if (choice.browse) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Start instance here'
    });
    return picked && picked.length ? { path: picked[0].fsPath } : null;
  }
  return choice;
}

function folderIdOf(node) {
  if (!node) return null;
  if (node.__folder) return node.id;
  if (typeof node.id === 'string' && node.id.startsWith('folder:')) return node.id.slice(7);
  return null;
}

function shortLabel(text) {
  const cleaned = String(text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > 28 ? cleaned.slice(0, 28).trimEnd() + '\u2026' : cleaned;
}

function deactivate() {
  if (manager) manager.disposeAll();
}

module.exports = { activate, deactivate };
