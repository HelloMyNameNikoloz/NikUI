'use strict';

const vscode = require('vscode');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { SessionManager, readConfig } = require('./manager');
const { projectRoot } = require('./tree');
const { SessionTree } = require('./tree');
const { FolderStore } = require('./folders');
const { Durable, placeOf } = require('./durable');
const { Ledger } = require('./ledger');
const { SessionPanel } = require('./panel');
const { DoneNotifier, banner: plainBanner, chime } = require('./done');
const { CiWatcher } = require('./ci');
const { PrLinks } = require('./prlink');
const { PrFeed, parseTicketUrl } = require('./prView');
const { resolveRepoFolder, originOf } = require('./repoFolders');
const { MacNotifier } = require('./notifier');
const { closeHub, closeAllHubs, eachHub } = require('./hub');
const { HistoryTree } = require('./historyTree');
const { projectsRoot, listSessions } = require('./history');
const { nextTicket } = require('./ticket');
const { labelFor } = require('./label');
const { createHost, installHost, forgetHost } = require('./host');
const { RemoteServer } = require('./remote');
const { Terminals } = require('./terminal');
const { Audience } = require('./audience');
const { DeviceStore } = require('./devices');
const { DevicesTree } = require('./devicesTree');
const { PairingWindow } = require('./pairing');
const { PairPanel } = require('./pairPanel');
const { loadIdentity } = require('./identity');
const { Tailscale, Cloudflared } = require('./tunnel');
const { Awake, KeepAwake } = require('./awake');
const { LidGuard } = require('./lid');
const { loadVapid } = require('./push');
const { Notifier } = require('./notify');
const { openSettings, schemaFrom, rememberModelsIn, useSwitch, write: writeSetting, registered,
  unloaded, offerReload, notLoaded } = require('./settingsMenu');
const { loadApns } = require('./apns');
const { Voice } = require('./voice');
const { startSlack } = require('./slackHome');

let manager;
let ledger = null;
// The GitHub pane's feed and PR picker, for the host the server builds.
let github = {};

/**
 * Bring a transcript back as an instance — the live one if it is already
 * open, otherwise resumed from disk. Shared by the History view's own resume
 * command and by Slack's "open in instance", which does the same thing on
 * its way to a ticket.
 *
 * @returns {object|null} the SessionPanel shown, or null if there was nothing
 * to resume (and a warning has already been shown).
 */
function resumeHistoryEntry(entry, context, manager) {
  if (!entry || !entry.sessionId) return null;
  const cwd = entry.cwd || (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath;
  if (!cwd) { vscode.window.showWarningMessage('NikUI: that transcript has no folder recorded.'); return null; }
  const live = manager.list.find((s) => s.claudeSessionId === entry.sessionId);
  if (live) return SessionPanel.show(live, context, manager);
  // Recover a PR/issue number from the stored prompt so the instance is not
  // just named after its folder.
  const ticket = nextTicket(null, entry.title || '');
  const session = manager.create({
    cwd,
    resume: entry.sessionId,
    title: null,
    ticket,
    autoLabel: ticket ? null : (entry.label || labelFor(entry.title))
  });
  return SessionPanel.show(session, context, manager);
}

/** The folders this window already knows about, for repoFolders to search from. */
function repoFolderOptions(manager, historyCwds) {
  const cfg = vscode.workspace.getConfiguration('nikui');
  const candidateDirs = [];
  for (const s of manager.list) if (s.cwd) candidateDirs.push(s.cwd);
  for (const cwd of historyCwds) if (cwd) candidateDirs.push(cwd);
  for (const f of vscode.workspace.workspaceFolders || []) candidateDirs.push(f.uri.fsPath);
  return {
    override: cfg.get('repoFolders', {}) || {},
    codeRoots: cfg.get('codeRoots', ['~/Codes']) || [],
    candidateDirs
  };
}

/** Whether a checkout at `cwd` has its origin on `repo` ({owner, repo}). */
function checkoutMatches(cwd, repo) {
  if (!cwd) return false;
  const info = originOf(cwd, fs);
  return !!info && info.owner.toLowerCase() === repo.owner.toLowerCase() && info.repo.toLowerCase() === repo.repo.toLowerCase();
}

/**
 * Slack's "open in instance": focus a live instance on this ticket, else
 * resume the most recent history entry on it, else start a fresh one in the
 * repo's local checkout — asking where that is, once, if it cannot be found.
 *
 * @returns {Promise<{ok: boolean, how?: 'focused'|'resumed'|'created', reason?: string}>}
 */
async function openTicketInNikui(url, context, manager) {
  const parsed = parseTicketUrl(url);
  if (!parsed) return { ok: false, reason: 'Not a GitHub pull request or issue link.' };

  // Tickets are kept as strings; the URL's number is a number.
  const ticket = String(parsed.number);
  const live = manager.list.find((s) => String(s.ticket || '') === ticket && checkoutMatches(s.cwd, parsed));
  if (live) { SessionPanel.show(live, context, manager).focusInput(); return { ok: true, how: 'focused' }; }

  const history = await listSessions({ limit: 200, scan: 800 });
  const entry = history.find((e) => checkoutMatches(e.cwd, parsed) && String(nextTicket(null, e.title || '') || '') === ticket);
  if (entry) {
    const panel = resumeHistoryEntry(entry, context, manager);
    if (panel) { panel.focusInput(); return { ok: true, how: 'resumed' }; }
  }

  const folder = resolveRepoFolder(parsed, repoFolderOptions(manager, history.map((e) => e.cwd)));
  if (!folder) {
    const repoName = parsed.owner + '/' + parsed.repo;
    const choice = await vscode.window.showWarningMessage(
      `NikUI: no local checkout found for ${repoName}.`, 'Choose folder…'
    );
    if (choice === 'Choose folder…') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        title: `Folder for ${repoName}`
      });
      const dir = picked && picked[0] && picked[0].fsPath;
      if (dir) {
        const cfg = vscode.workspace.getConfiguration('nikui');
        const map = Object.assign({}, cfg.get('repoFolders', {}) || {});
        map[repoName] = dir;
        await writeSetting('nikui.repoFolders', map);
        return openTicketInNikui(url, context, manager);
      }
    }
    return { ok: false, reason: `No local checkout found for ${repoName}.` };
  }

  const session = manager.create({ cwd: folder, ticket, autoLabel: null });
  const panel = SessionPanel.show(session, context, manager);
  panel.focusInput();
  if (typeof panel.draftText === 'function') panel.draftText(url);
  return { ok: true, how: 'created' };
}

function activate(context) {
  manager = new SessionManager(context);
  // A copy of the open instances and the folders that outlives this window's
  // own storage, which an empty window loses the moment its process does.
  const memoryDir = context.globalStorageUri && context.globalStorageUri.fsPath;
  const durable = memoryDir ? new Durable({ dir: memoryDir, place: placeOf(vscode.workspace) }) : null;
  if (durable) manager.useDurable(durable);
  const folders = new FolderStore(context, durable);
  // Every instance this machine has run and what it cost, for /status.
  ledger = memoryDir ? new Ledger({ dir: memoryDir }) : null;
  let remembering = null;
  manager.on('changed', () => {
    if (remembering) return;
    remembering = setTimeout(() => {
      remembering = null;
      if (ledger) ledger.record(manager.list);
      for (const s of manager.list) folders.remember(s);
    }, 2000);
  });
  context.subscriptions.push({ dispose: () => { if (remembering) clearTimeout(remembering); if (ledger) { ledger.record(manager.list); ledger.flush(); } } });
  const tree = new SessionTree(manager, folders);
  context.subscriptions.push(tree);

  const view = vscode.window.createTreeView('nikui.sessions', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: true
  });
  context.subscriptions.push(view);

  const history = new HistoryTree();
  const historyView = vscode.window.createTreeView('nikui.history', { treeDataProvider: history });
  context.subscriptions.push(historyView, history);
  // Scope and filter live in the header, not in a status-bar message that has
  // already gone by the time you wonder why the list looks short.
  const showScope = () => { historyView.description = history.summary; };
  showScope();
  // Transcripts are written continuously; re-read whenever the panel is shown.
  context.subscriptions.push(historyView.onDidChangeVisibility((e) => { if (e.visible) history.refresh(); }));
  // A sweep of every transcript on the machine is not a thing to do on every
  // status change of every instance. The list only changes when a conversation
  // is created or removed, and a moment's delay is invisible either way.
  let historySoon = null;
  const refreshHistory = () => {
    if (historySoon) return;
    historySoon = setTimeout(() => { historySoon = null; history.refresh(); }, 1500);
  };
  context.subscriptions.push({ dispose: () => { if (historySoon) clearTimeout(historySoon); } });
  manager.on('removed', refreshHistory);
  manager.on('session-changed', (session) => {
    // A conversation gets its id the first time the CLI answers; that is when
    // it becomes something History could show.
    if (session && session.claudeSessionId) refreshHistory();
  });

  // Keep the sidebar badge honest about how many instances are busy.
  // Whatever removes an instance, its panel goes with it; an orphaned panel
  // still holds a live reference and could respawn the process.
  manager.on('removed', (session) => {
    SessionPanel.close(session.id);
    // Whoever else was watching — a second view, later a phone — goes with it.
    closeHub(session.id);
  });

  manager.on('changed', () => {
    const busy = manager.list.filter((s) => s.isBusy).length;
    view.badge = busy ? { value: busy, tooltip: `${busy} working` } : undefined;
  });

  followFocus(view, manager);
  watchForTrouble(manager, (session) => SessionPanel.show(session, context, manager));
  watchForCi(manager, context, watchForDone(manager, context));
  const prLinks = new PrLinks();
  context.subscriptions.push({ dispose: prLinks.attach(manager) });
  // One feed of pull request state for the window, shared by every instance's
  // GitHub pane; it only polls while a pane is open in a visible tab.
  const prFeed = new PrFeed();
  context.subscriptions.push({ dispose: () => prFeed.dispose() });
  const setPr = (session, url) => prLinks.pin(session, url);
  const pickPr = (session) => pickPullRequest(session, setPr);
  github = { prFeed, pickPr, setPr };
  watchForCrowding(manager);
  watchForQuota(manager);

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
    const session = manager.create({ cwd: cwd.path });
    SessionPanel.show(session, context, manager).focusInput();
  });

  register('nikui.newSessionInFolder', async (node) => {
    const folderId = folderIdOf(node);
    const folder = folderId ? folders.get(folderId) : null;
    if (!folder) return;
    const cwd = await pickFolder(manager);
    if (!cwd) return;
    const session = manager.create({ cwd: cwd.path });
    folders.place(session, folder.id);
    tree.refresh();
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

  const cycle = (step) => {
    const list = manager.list;
    if (!list.length) return;
    const active = manager.active;
    const at = active ? list.findIndex((s) => s.id === active.id) : -1;
    const next = list[((at < 0 ? 0 : at + step) + list.length) % list.length];
    if (next) SessionPanel.show(next, context, manager).focusInput();
  };

  register('nikui.nextInstance', () => cycle(1));
  register('nikui.previousInstance', () => cycle(-1));

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
    // Restarting means "start it again the way I have things set now". Without
    // this it meant "start it again the way things were when I first opened
    // it": the model, the effort and the rest were captured at creation and
    // never looked at again, so changing a setting and restarting — the obvious
    // way to apply one — did nothing at all.
    reconfigure(session);
    if (!choice.keep && session.hasHistory) {
      const go = await vscode.window.showWarningMessage(
        `Start ${session.label} over?`,
        { modal: true, detail: 'The panel is cleared and a new Claude session begins, so this conversation is no longer the one being continued. The transcript stays on disk and can be reopened from History.' },
        'Start over'
      );
      if (go !== 'Start over') return;
    }
    session.restart({ keepContext: choice.keep });
  });

  /**
   * Bring an instance back in line with the settings as they are now.
   *
   * Only the things a restart can actually change: every one of these is read
   * when the process is spawned, so they take effect on the next start and not
   * before. Anything that is part of the conversation rather than the process —
   * its title, its folder, what it has said — is left alone.
   */
  function reconfigure(session) {
    const cfg = readConfig();
    session.claudePath = cfg.claudePath;
    session.model = cfg.model;
    session.permissionMode = cfg.permissionMode;
    session.effort = cfg.effort;
    session.outputStyle = cfg.outputStyle;
    session.extraArgs = cfg.extraArgs;
    return session;
  }

  /**
   * Every instance, on whatever the settings say now.
   *
   * The model an instance runs is fixed when its process starts, so changing it
   * is restarting them — which is a thing worth having one button for rather
   * than doing one at a time down the list.
   */
  register('nikui.restartAll', async () => {
    const open = manager.list.filter((s) => s.everStarted);
    if (!open.length) return void vscode.window.showInformationMessage('Nothing is running.');
    const cfg = readConfig();
    const go = await vscode.window.showWarningMessage(
      `Restart ${open.length} instance${open.length === 1 ? '' : 's'} on ${cfg.model || 'your Claude Code default'}?`,
      {
        modal: true,
        detail: 'Each one is resumed, so the conversations continue — but whatever any of them is ' +
          'doing right now stops. The model an instance runs is decided when its process starts, ' +
          'which is why this is the way to change it.'
      },
      'Restart them'
    );
    if (go !== 'Restart them') return;
    for (const session of open) {
      reconfigure(session);
      session.restart({ keepContext: true });
    }
    vscode.window.setStatusBarMessage(
      `NikUI: restarted ${open.length} instance${open.length === 1 ? '' : 's'}` +
      (cfg.model ? ` on ${cfg.model}` : ''), 6000);
  });

  register('nikui.status', async (arg) => {
    const session = await pickSession(arg);
    if (!session) return;
    SessionPanel.show(session, context, manager).openStatus();
  });

  register('nikui.resumeNow', () => {
    if (!manager.pause) {
      vscode.window.setStatusBarMessage('NikUI: nothing is waiting on the quota', 2500);
      return;
    }
    const woken = manager.resumeFromLimit({ manual: true });
    vscode.window.setStatusBarMessage(
      woken ? `NikUI: started ${woken} instance${woken === 1 ? '' : 's'} again` : 'NikUI: nothing to start', 3000
    );
  });

  register('nikui.sleep', async (arg) => {
    const session = await pickSession(arg);
    if (!session) return;
    if (!session.isRunning) {
      vscode.window.setStatusBarMessage(`NikUI: ${session.label} is not running`, 2500);
      return;
    }
    if (session.isBusy) {
      const go = await vscode.window.showWarningMessage(
        `${session.label} is still working. Stop its process?`,
        { modal: true, detail: 'The turn is abandoned. The instance stays in the list and picks the conversation back up when you open it.' },
        'Stop process'
      );
      if (go !== 'Stop process') return;
    }
    manager.sleep(session.id);
    vscode.window.setStatusBarMessage(`NikUI: stopped ${session.label} — open it to pick up where it left off`, 3500);
  });

  register('nikui.stop', async (arg) => {
    const session = await pickSession(arg);
    if (!session) return;
    // Closing removes the row. That is fine for an instance with nothing in it,
    // but anything with a conversation behind it gets asked first — the × on a
    // row reads like "hide this", and it is not.
    if (session.isBusy) {
      const go = await vscode.window.showWarningMessage(
        `${session.label} is still working. Close it anyway?`,
        { modal: true, detail: 'The turn is abandoned and the instance leaves the list. The conversation stays in History and can be reopened.' },
        'Close instance'
      );
      if (go !== 'Close instance') return;
    } else if (session.hasHistory) {
      const go = await vscode.window.showWarningMessage(
        `Close ${session.label}?`,
        { modal: true, detail: 'It leaves the list and its process is stopped. The conversation stays in History and can be reopened from there.' },
        'Close instance'
      );
      if (go !== 'Close instance') return;
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

  register('nikui.clearStopped', async () => {
    // Only instances whose process ran and then exited. Instances restored from
    // the last window have no process either, and clearing those unasked used
    // to wipe the sidebar after every reload.
    const dead = manager.stopped();
    if (!dead.length) {
      const asleep = manager.list.filter((s) => s.isAsleep).length;
      vscode.window.setStatusBarMessage(
        asleep
          ? `NikUI: nothing to remove — ${asleep} instance${asleep === 1 ? '' : 's'} restored from your last window are asleep, not stopped`
          : 'NikUI: nothing to remove',
        4000
      );
      return;
    }
    const names = dead.map((s) => s.label).join(', ');
    const go = await vscode.window.showWarningMessage(
      `Remove ${dead.length} stopped instance${dead.length === 1 ? '' : 's'}?`,
      { modal: true, detail: `${names}\n\nTheir processes have already exited. The conversations stay in History and can be reopened.` },
      'Remove'
    );
    if (go !== 'Remove') return;
    const removed = manager.removeStopped();
    vscode.window.setStatusBarMessage(`NikUI: removed ${removed} stopped instance${removed === 1 ? '' : 's'}`, 3000);
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
    // Deleting a folder never touches the instances inside it — but a folder
    // with things in it looks like it would, so it says what happens to them.
    const inside = manager.list.filter((s) => (folders.folderOf(s) || {}).id === id).length;
    if (inside) {
      const go = await vscode.window.showWarningMessage(
        `Delete the folder "${folder.name}"?`,
        { modal: true, detail: `The ${inside} instance${inside === 1 ? '' : 's'} in it are not closed — they move back to the top level.` },
        'Delete folder'
      );
      if (go !== 'Delete folder') return;
    }
    folders.remove(id);
    tree.refresh();
    vscode.window.setStatusBarMessage(`NikUI: removed folder "${folder.name}"`, 2500);
  });

  register('nikui.linkPr', async (arg) => {
    const session = await pickSession(arg);
    if (session) await pickPr(session);
  });

  register('nikui.unlinkPr', async (arg) => {
    const session = await pickSession(arg);
    if (session) setPr(session, null);
  });

  // Open or close the GitHub pane in that instance's tab, opening the tab if
  // it is not already showing.
  register('nikui.togglePrPane', async (arg) => {
    const session = await pickSession(arg);
    if (!session) return;
    if (!session.prUrl) {
      const pick = await vscode.window.showInformationMessage(`${session.label} has no pull request yet.`, 'Link a PR…');
      if (pick) await pickPr(session);
      if (!session.prUrl) return;
    }
    const was = session.prPane || {};
    session.prPane = { open: !was.open, tab: was.tab || 'conversation', width: was.width || null, full: !!was.full };
    session.emit('meta');
    SessionPanel.show(session, context, manager);
  });

  register('nikui.moveToFolder', async (arg) => {
    const session = await pickSession(arg);
    if (!session) return;
    const current = folders.folderOf(session);
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
      folders.place(session, made.id);
    } else {
      folders.place(session, choice.folderId);
    }
    tree.refresh();
  });

  register('nikui.refreshHistory', () => history.refresh());

  register('nikui.showHistory', async () => {
    history.refresh();
    await vscode.commands.executeCommand('nikui.history.focus');
  });

  register('nikui.historyScope', () => {
    history.toggleScope();
    showScope();
  });

  register('nikui.historyMore', () => history.showMore());

  register('nikui.historyFilter', async () => {
    const value = await vscode.window.showInputBox({
      prompt: 'Filter conversations by name, opening prompt, folder or branch',
      placeHolder: 'Leave empty to show everything',
      value: history.filter
    });
    if (value === undefined) return;
    history.setFilter(value);
    showScope();
  });

  register('nikui.deleteHistory', async (entry) => {
    if (!entry || !entry.file) return;
    // Only ever a transcript. Nothing else on disk is this command's business,
    // whatever it is handed.
    const root = projectsRoot();
    if (!entry.file.startsWith(root + path.sep) || !entry.file.endsWith('.jsonl')) {
      vscode.window.showWarningMessage('NikUI: that is not a transcript.');
      return;
    }
    // Never pull the transcript out from under a conversation that is open.
    const live = manager.list.find((s) => s.claudeSessionId === entry.sessionId);
    if (live) {
      vscode.window.showWarningMessage(
        `${live.label} is still open on that conversation. Close the instance first.`
      );
      return;
    }
    const go = await vscode.window.showWarningMessage(
      `Delete the transcript for "${entry.label || entry.title}"?`,
      { modal: true, detail: `${entry.file}\n\nThis removes the file from disk. It cannot be undone, and the conversation cannot be reopened afterwards.` },
      'Delete'
    );
    if (go !== 'Delete') return;
    try {
      fs.unlinkSync(entry.file);
      vscode.window.setStatusBarMessage('NikUI: transcript deleted', 2500);
    } catch (err) {
      vscode.window.showErrorMessage(`NikUI: could not delete that transcript — ${err.message}`);
    }
    history.refresh();
  });

  register('nikui.resumeHistory', async (entry) => {
    const panel = resumeHistoryEntry(entry, context, manager);
    if (panel) panel.focusInput();
  });

  // Bring back the instances that were open before the reload, then let VS Code
  // hand their editor tabs back to us. Folder assignments are tidied once the
  // whole set is back, never while it is still being rebuilt.
  manager.restoreOpen();
  folders.prune(manager.list.map((s) => s.id));
  // A quota pause that started before the reload is still in force.
  manager.restorePause();
  tree.refresh();

  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('nikui.session', {
    async deserializeWebviewPanel(panel, state) {
      const id = state && state.sessionId;
      const session = id ? manager.get(id) : null;
      if (!session) { panel.dispose(); return; }
      SessionPanel.adopt(panel, session, context, manager);
    }
  }));

  // Whether this laptop may sleep — on its own, and with the lid closed. Made
  // before the server, which reads it and lets phones switch it; the server
  // is asked whether it is listening only once there is one to ask.
  let server = null;
  const awake = keepAwake(context, manager, () => server);
  server = serveLocally(context, manager, awake, folders, { refreshTree: () => tree.refresh() });
  useSwitch('nikui.lidClosed', (on) => awake.switchLid(on));
  if (server.onState) context.subscriptions.push({ dispose: server.onState(() => awake.reconsider()) });
  awake.reconsider();

  // Settings that change how a conversation is drawn reach the pages that are
  // already open. They used to be sent once, in the first message a client got,
  // so changing the font did nothing until the tab was closed and reopened.
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event && event.affectsConfiguration && !event.affectsConfiguration('nikui')) return;
      eachHub((hub) => { hub.broadcast(hub.metaMessage()); hub.broadcastSettings(); hub.broadcastCommands(); });
      tree.refresh();
    }));
  }

  context.subscriptions.push({ dispose: () => { closeAllHubs(); manager.disposeAll(); } });
}

/**
 * Put this CLI's models in the composer's palette.
 *
 * Typing "/model " should offer what is actually installed. The CLI's own reply
 * names the aliases and then says "or a full model ID", which is true and is not
 * a list — so the identifiers are read out of the binary instead, the same way
 * the settings picker reads them, and handed to the composer.
 *
 * Failing is allowed and quiet: without this the palette still has whatever the
 * CLI printed, which is what it had before.
 */
function offerModelsToComposer(store) {
  const { discover } = require('./models');
  const { offerCommandArgs } = require('./session');
  let claudePath = 'claude';
  try { claudePath = vscode.workspace.getConfiguration('nikui').get('claudePath', 'claude'); } catch (_) { /* a stub */ }
  return discover({ claudePath, cache: store }).then((found) => {
    // The aliases are what the CLI names itself, so there is nothing to add.
    if (found.from === 'aliases') return false;
    const values = found.models
      .filter((model) => !model.alias)
      .map((model) => ({ value: model.id, label: model.label, detail: model.detail }));
    if (!offerCommandArgs('model', values)) return false;
    // Pages that are already open asked for this list when they loaded.
    eachHub((hub) => hub.broadcast(hub.metaMessage()));
    return true;
  }).catch(() => false);
}

/**
 * Keep the machine awake while there is something worth staying awake for.
 *
 * Off unless asked, because keeping somebody's laptop awake is not a decision
 * to make for them; released the moment nothing needs it, because a machine
 * that never sleeps through a forgotten flag is its own bug.
 *
 * Both settings are written for the whole machine rather than this workspace:
 * they are questions about the laptop, and a phone switching one off should not
 * leave another window holding it on.
 *
 * @param {() => object|null} serverOf  the server, once there is one
 */
function keepAwake(context, manager, serverOf) {
  // A keep-awake that cannot hold anything says so once, rather than looking
  // like a machine that simply had nothing to hold.
  const awake = new Awake({
    log: (line) => {
      if (!/could not|nothing to hold/.test(line) || awake.complained) return;
      awake.complained = true;
      vscode.window.showWarningMessage('NikUI: ' + line +
        '. The machine may still sleep and take its instances with it.');
    }
  });

  const cfg = () => vscode.workspace.getConfiguration('nikui');
  const flag = (key) => { try { return cfg().get(key, false); } catch (_) { return false; } };
  const lid = new LidGuard({ log: (line) => console.log('NikUI ' + line) });

  // Written the one way every NikUI setting is written, so a setting this
  // window has not loaded yet is refused with a reason rather than by VS Code.
  const keeping = new KeepAwake({
    awake,
    enabled: () => flag('keepAwake'),
    write: (on) => writeSetting('nikui.keepAwake', on, vscode.ConfigurationTarget.Global),
    lid,
    lidEnabled: () => flag('lidClosed'),
    writeLid: (on) => writeSetting('nikui.lidClosed', on, vscode.ConfigurationTarget.Global),
    sessions: () => manager.list,
    serving: () => { const s = serverOf(); return !!(s && s.listening); }
  });

  /**
   * The lid switch, from the laptop — where the one-time approval can be asked
   * for, because the password dialog is here. From a phone the same switch
   * says "approve it on the laptop" instead, and never raises a dialog on a
   * screen nobody is looking at.
   */
  keeping.switchLid = async (on) => {
    // Before anything else: a switch VS Code cannot store is not worth your
    // password. Refused with the reason, so wherever it was flipped says why.
    if (!registered('nikui.lidClosed')) {
      offerReload();
      throw notLoaded('nikui.lidClosed');
    }
    if (!on) return keeping.setLid(false);
    if (!(await lid.ready())) {
      const go = await vscode.window.showInformationMessage(
        'Keep working with the lid closed?',
        {
          modal: true,
          detail: 'While Claude is working, closing the lid will not put this Mac to sleep; it sleeps once the ' +
            'work is done. macOS will ask for your password once, to let NikUI turn sleep off and back on — ' +
            'nothing else. Undo it any time from the NikUI status bar item. Keep it out of a bag while it works.'
        },
        'Continue'
      );
      if (go !== 'Continue') return null;
      const done = await lid.setUp();
      if (!done.ok) {
        if (!done.cancelled) vscode.window.showWarningMessage('NikUI could not set that up: ' + done.reason);
        return null;
      }
    }
    return keeping.setLid(true);
  };

  keeping.removeLidApproval = async () => {
    if (registered('nikui.lidClosed')) await writeSetting('nikui.lidClosed', false, vscode.ConfigurationTarget.Global);
    const out = await lid.takeDown();
    if (out.ok) vscode.window.setStatusBarMessage('NikUI: closing the lid puts this Mac to sleep again, always', 5000);
    keeping.reconsider();
    return out;
  };

  const reconsider = () => keeping.reconsider();
  manager.on('changed', reconsider);
  manager.on('session-changed', reconsider);
  manager.on('paused', reconsider);
  manager.on('resumed', reconsider);
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      const touches = (key) => !event || !event.affectsConfiguration || event.affectsConfiguration(key);
      if (touches('nikui.keepAwake') || touches('nikui.lidClosed')) reconsider();
      // Switched on somewhere that could not ask — settings.json, say — so it
      // is asked here, once, rather than left silently doing nothing.
      if (touches('nikui.lidClosed') && flag('lidClosed')) {
        lid.ready().then((ok) => {
          if (ok) return;
          vscode.window.showWarningMessage(
            'NikUI needs a one-time approval before the lid can be closed while Claude works.', 'Approve'
          ).then((choice) => { if (choice) keeping.switchLid(true).catch(() => {}); });
        });
      }
    }));
  }
  // Whatever a crash left behind is cleared before anything is held again.
  lid.recover().catch(() => {});
  // Quitting the editor lets go of it, rather than leaving the machine awake
  // on the strength of a process that is no longer there.
  context.subscriptions.push({ dispose: () => keeping.dispose() });
  return keeping;
}

/**
 * The same client, in a browser on this machine.
 *
 * Off unless you say so, and loud while it is on: NikUI runs Claude with
 * permissions bypassed, so anything that can reach this server can run code
 * here. The status bar item is not decoration — it is the answer to "is it
 * listening right now", which should never need looking up.
 */
/**
 * @param {object} [folders] the user's own folders, so a phone is shown the
 *   window the way the editor shows it rather than a flat list of what is in it
 */
function serveLocally(context, manager, awakeState, folders, deps) {
  const injected = deps || {};
  const bar = vscode.window.createStatusBarItem
    ? vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    : null;
  const out = vscode.window.createOutputChannel
    ? vscode.window.createOutputChannel('NikUI server')
    : null;

  // The laptop's own key, the devices it knows, and the minute in which a new
  // one may introduce itself. All three outlive the server being started and
  // stopped, so they are made here rather than inside it.
  const identity = loadIdentity(context.globalState);
  const devices = new DeviceStore(context.globalState);
  const pairing = new PairingWindow();
  // The identity this window sends notifications under. Separate from the one
  // devices pair against: one proves who the laptop is to a phone, the other
  // proves who the sender is to a push service.
  const vapid = loadVapid(context.globalState);

  // Installed, not just built: the panel asks for this same object, so a hub
  // opened from the editor knows about devices and the trail as well — and so
  // the phone's status screen is built from exactly the same facts.
  /**
   * Who is using the app, and who asked for what.
   *
   * One per window, and handed to three places: the hub records which phone
   * sent a prompt, the server records any phone doing anything at all, and the
   * notifier asks which of them — if any — should be told.
   */
  // The model list is read out of the CLI and only changes when the CLI does,
  // so it is kept across openings rather than rebuilt for every menu.
  rememberModelsIn(context.globalState);
  offerModelsToComposer(context.globalState);
  // A window that started from VS Code's old copy of NikUI's settings says so
  // now, while the fix is one click, rather than at the first switch that fails.
  try {
    if (unloaded(schemaFrom(context.extensionUri.fsPath)).length) offerReload();
  } catch (_) { /* nothing to compare against */ }

  const audience = new Audience();

  const served = installHost(createHost(context, manager, Object.assign({ devices, awake: awakeState || null, ledger }, github)));
  served.audience = audience;

  /**
   * Somewhere to run a command, when a device is allowed to.
   *
   * Made here rather than inside the server so the window owns it: closing the
   * window has to take the processes with it, and a thing the server made would
   * outlive the server being restarted.
   *
   * Off is a real answer. A terminal is a shell on this machine, and while a
   * device with control can already cause anything a shell could — NikUI runs
   * Claude with permissions bypassed — somebody who wants the phone to watch
   * and only watch should be able to have that.
   */
  const terminals = vscode.workspace.getConfiguration('nikui').get('remote.terminal', true)
    ? new Terminals({ onEvent: (event) => server.terminalSaid(event) })
    : null;
  context.subscriptions.push({ dispose: () => { if (terminals) terminals.closeAll(); } });

  // Speech from the phone, heard here. Built once into NikUI's storage and
  // run only while a recording is being turned into words.
  const voice = new Voice({
    dir: context.globalStorageUri ? context.globalStorageUri.fsPath : null,
    enabled: () => vscode.workspace.getConfiguration('nikui').get('voice.enabled', true),
    log: (line) => { if (out) out.appendLine(new Date().toISOString() + '  ' + line); }
  });

  let slackRoom = null;
  const server = new RemoteServer({
    root: context.extensionUri.fsPath,
    host: served,
    terminals,
    voice,
    audience,
    // Made after the notifier, which it rings the phone through.
    slack: () => slackRoom,
    // Whether this laptop may sleep, readable by any paired device and
    // switchable by one that may send prompts.
    keepAwake: awakeState || null,
    sessions: { list: () => manager.list, get: (id) => manager.get(id) },
    // The same folders, projects and history the editor shows, so a phone is
    // looking at this window rather than at a list of what happens to be in it.
    folders,
    projectRoot,
    // This window's own workspace folders — the only places a phone may ask
    // for a new instance to be started, never an arbitrary path it names.
    projects: () => (vscode.workspace.workspaceFolders || []).map((f) => ({
      path: f.uri.fsPath, name: f.name
    })),
    // The same path `nikui.newSession` takes, without opening a panel: a
    // phone starting an instance should not steal the editor's focus.
    createInstance: async ({ cwd, folderId }) => {
      const session = manager.create({ cwd });
      const folder = folderId ? folders.get(folderId) : null;
      if (folder) folders.place(session, folder.id);
      if (deps && deps.refreshTree) deps.refreshTree();
      return { id: session.id };
    },
    refreshTree: () => { if (deps && deps.refreshTree) deps.refreshTree(); },
    history: (ask) => require('./history').listSessions(ask),
    // What /status draws, built exactly as the hub builds it — the instance
    // somebody is most likely asking about, with the rest as its fleet.
    report: () => {
      const { buildReport } = require('./report');
      const open = manager.list;
      const session = manager.get(manager.activeId) || open[0] || null;
      if (!session) return null;
      return buildReport({
        session,
        fleet: open,
        env: served.env ? served.env(session) : {},
        lifetime: ledger ? ledger.totals() : null
      });
    },
    devices,
    identity,
    pairing,
    vapid,
    watchFleet: (fn) => {
      const on = () => fn();
      manager.on('changed', on);
      manager.on('session-changed', on);
      return () => { manager.off('changed', on); manager.off('session-changed', on); };
    },
    log: (line) => { if (out) out.appendLine(new Date().toISOString() + '  ' + line); },
    requireSealed: () => {
      try { return vscode.workspace.getConfiguration('nikui').get('remote.requireEncryption', true); }
      catch (_) { return true; }
    },
    appOnly: () => {
      try { return vscode.workspace.getConfiguration('nikui').get('remote.appOnly', false); }
      catch (_) { return false; }
    },
    announce: (event) => {
      if (event.kind !== 'rekeyed') return;
      const where = {
        'secure-enclave': 'the Secure Enclave', 'strongbox': 'a StrongBox chip',
        'keystore': 'the Android Keystore', 'software': 'the browser', 'unknown': 'somewhere it did not name'
      }[event.protection] || event.protection;
      vscode.window.showInformationMessage(
        `NikUI: ${event.device} moved its key into ${where}` +
        (event.biometric ? ', behind a fingerprint or face check.' : '.'),
        'Show devices'
      ).then((choice) => {
        if (choice) vscode.commands.executeCommand('nikui.devices.focus');
      });
    }
  });

  // The mesh in front of the server, when there is one. Nothing binds anywhere
  // but loopback either way: this asks Tailscale's own proxy to forward to us.
  // Injectable so the one decision that can silently take every phone away
  // from another window — who holds the tailnet — can be driven in a test
  // without a mesh to drive it on.
  const tailscale = injected.tailscale || new Tailscale();
  const cloudflared = new Cloudflared({
    log: (line) => { if (out) out.appendLine(new Date().toISOString() + '  ' + line); }
  });
  let weExposed = false;

  /**
   * Being told, rather than checking. Three things are worth a phone buzzing;
   * a turn finishing is available and off, because four agents finishing
   * overnight is a phone buzzing all night.
   */
  // The only door in this product that goes through anybody else's machine, and
  // the only one that needs an account: an iPhone with the app closed. Inert
  // until somebody fills in four settings.
  const apns = loadApns(() => {
    try {
      const cfg = vscode.workspace.getConfiguration('nikui');
      return {
        teamId: cfg.get('apns.teamId', ''),
        keyId: cfg.get('apns.keyId', ''),
        keyFile: cfg.get('apns.keyFile', ''),
        bundleId: cfg.get('apns.bundleId', 'com.nikoloz.nikui'),
        production: cfg.get('apns.production', true)
      };
    } catch (_) { return {}; }
  });

  const notifier = new Notifier({
    devices,
    vapid,
    apns,
    audience,
    // A notification whose instance cannot be opened is a notification that
    // teaches you to ignore them.
    reachable: () => server.listening,
    // The app, when it is open, is already holding a socket — so it is told
    // down that rather than through a push service, which needs a tunnel, an
    // account somewhere, and a phone that is reachable from outside.
    toSockets: (message) => server.notifyDevices(message),
    // Whatever pops up on this laptop also goes to the phone — somebody out of
    // the house has only the phone. notifyDevices can add to that, not take
    // away from it: a turn finishing is sent when either says so.
    settings: () => {
      try {
        const cfg = vscode.workspace.getConfiguration('nikui');
        const phone = Object.assign({}, cfg.get('notifyDevices', {}) || {});
        if (cfg.get('notifyWhenDone', false)) phone.turnFinished = true;
        if (cfg.get('notifyCI', true)) phone.ci = true;
        if (cfg.get('notifyOnAttention', true)) phone.needsYou = true;
        return phone;
      } catch (_) { return {}; }
    },
    log: (line) => { if (out) out.appendLine(new Date().toISOString() + '  push: ' + line); }
  });
  context.subscriptions.push({ dispose: notifier.watch(manager) });

  // Slack: a VIP waiting a minute pops up here, three minutes rings the phone.
  const slack = startSlack(context, {
    notifier,
    devices,
    openTicket: (url) => openTicketInNikui(url, context, manager),
    log: (line) => { if (out) out.appendLine(new Date().toISOString() + '  ' + line); }
  });
  slackRoom = slack.room;
  served.openSlack = () => slack.open({});

  // The lid is shut, the battery is at its floor and work is still running:
  // the one sleep a phone should hear about before it happens.
  if (awakeState && awakeState.lid && awakeState.lid.onGiveUp) {
    context.subscriptions.push({ dispose: awakeState.lid.onGiveUp((why) => notifier.sleeping(why)) });
  }

  const tree = new DevicesTree(devices, server);
  const view = vscode.window.createTreeView('nikui.devices', { treeDataProvider: tree });
  context.subscriptions.push(view, tree);

  /** The two switches that decide what is exposed, read fresh each time. */
  const exposure = () => {
    const cfg = vscode.workspace.getConfiguration('nikui');
    return {
      sealed: cfg.get('remote.requireEncryption', true),
      appOnly: cfg.get('remote.appOnly', false)
    };
  };

  const paint = () => {
    if (!bar) return;
    if (!server.listening) { bar.hide(); return; }
    const paired = devices.list().length;
    // Reachable from elsewhere is a different state from listening, and the
    // status bar is where you should be able to tell them apart at a glance.
    // A laptop that will not sleep should say so where you would look when
    // wondering why it did not: a machine awake because of a flag somebody
    // forgot is a bug with no symptom but a flat battery.
    const awake = awakeState && awakeState.state ? awakeState.state() : null;
    const lidHeld = !!(awake && awake.lid && awake.lid.held);
    const held = !!(awake && awake.held) || lidHeld;
    bar.text = (server.exposed ? `$(radio-tower) NikUI · ${server.publicHost}` : `$(broadcast) NikUI :${server.port}`) +
      (held ? ' $(coffee)' : '');
    bar.tooltip = (server.exposed
      ? `NikUI is reachable on the tailnet at ${server.publicScheme}://${server.publicHost}`
      : `NikUI is serving this window on 127.0.0.1:${server.port}, and nowhere else`) +
      (paired ? ` · ${paired} paired device${paired === 1 ? '' : 's'}` : '') +
      (held ? ' · keeping this laptop awake' : '') +
      (lidHeld ? ', even with the lid closed, while ' + (awake.lid.reason || 'the work runs') : '') +
      // Only said when it is the unusual answer. A tooltip that lists every
      // setting at its default is a tooltip nobody reads to the end.
      (exposure().sealed ? '' : ' · not requiring encryption') +
      (exposure().appOnly ? ' · app only' : '') +
      '. Click for actions.';
    bar.command = 'nikui.remoteMenu';
    bar.show();
  };
  context.subscriptions.push({ dispose: devices.onChange(paint) });
  // Switched here or from a phone, everyone who can see the switch is told:
  // the phones over their sockets, and this window in its status bar.
  if (awakeState && awakeState.onChange) {
    context.subscriptions.push({ dispose: awakeState.onChange(() => {
      server.broadcastAwake();
      paint();
      // An open /settings sheet says whether the laptop is holding right now.
      eachHub((hub) => hub.broadcastSettings());
    }) });
  }

  const start = async () => {
    if (server.listening) return server;
    const port = vscode.workspace.getConfiguration('nikui').get('remote.port', 4517);
    try {
      await server.start(port);
    } catch (err) {
      vscode.window.showWarningMessage(
        'NikUI could not start the local server: ' + ((err && err.message) || 'unknown error')
      );
      return null;
    }
    // Being reachable is the point of serving at all: a phone that has to be on
    // the same wifi is a phone that works at the desk it was not needed at. So
    // the tailnet goes in front by itself unless somebody turned that off, and
    // falls back to merely noticing a tunnel that is already there.
    if (vscode.workspace.getConfiguration('nikui').get('remote.tailnet', true)) becomeReachable();
    else adoptTunnel();
    context.workspaceState.update('nikui.remote.wasServing', true);
    // Built ahead of being needed, so the first thing said into the phone is
    // not the thing that waits minutes for a compiler. Once: after that the
    // program is kept, and only ever started for a recording.
    if (voice.possible && voice.enabled() && voice.modelPresent() && !voice.isBuilt()) {
      const later = setTimeout(() => voice.ensure(), 20000);
      context.subscriptions.push({ dispose: () => clearTimeout(later) });
    }
    if (server.movedFrom) {
      // Another window already has the usual port. Said once, quietly: the
      // address is handed out rather than typed, so the number rarely matters.
      vscode.window.setStatusBarMessage(
        `NikUI: ${server.movedFrom} was taken, so this window is serving on ${server.port}`, 6000
      );
    }
    paint();
    return server;
  };

  /** Whatever this window put in front of the server, taken back down. */
  const closeTunnels = async () => {
    const problems = [];
    if (cloudflared.running) {
      const out = await cloudflared.hide();
      if (!out.ok) problems.push(out.reason);
    }
    if (weExposed) {
      const out = await tailscale.hide();
      if (!out.ok) problems.push(out.reason);
    }
    weExposed = false;
    server.publicHost = null;
    return problems;
  };

  const stop = async () => {
    // The server going away leaves anything in front of it pointing at
    // nothing, so both go — but only what this window set up. This is the one
    // path that takes the tunnel down, because it is the one where somebody
    // said they were finished rather than the window merely reloading.
    await closeTunnels();
    await server.stop();
    context.workspaceState.update('nikui.remote.wasServing', false);
    paint();
  };

  /**
   * Put the tailnet in front of the server, so a phone that is somewhere else
   * can reach it. Nothing new listens here: Tailscale's proxy takes the
   * connection on the mesh and forwards it to 127.0.0.1, with a certificate,
   * which is also the only way a device can hold a key at all.
   */
  const reach = async () => {
    if (!(await start())) return;
    const state = await tailscale.status();
    if (!state.installed) {
      const go = await vscode.window.showWarningMessage(
        'NikUI: Tailscale is not installed.',
        { modal: true, detail: 'Tailscale puts this laptop and your phone on the same private network, ' +
          'with encryption and device identity of its own — so nothing of NikUI\'s is ever exposed to the ' +
          'internet. Install it on both, sign in, and run this again.' },
        'Open tailscale.com'
      );
      if (go) await vscode.env.openExternal(vscode.Uri.parse('https://tailscale.com/download'));
      return;
    }
    if (!state.running || !state.https) {
      vscode.window.showWarningMessage('NikUI cannot use Tailscale yet: ' + (state.reason || 'unknown reason'));
      return;
    }

    // The address is the machine's, not this window's. Taking it from a window
    // that is still using it is a legitimate thing to want — it is why this
    // command exists — but it has to be a thing somebody chose, because the
    // address does not change when it moves: a phone that was showing that
    // window simply starts showing this one, with nothing on either screen to
    // say why.
    const held = await tailscale.forwardedPort().catch(() => null);
    if (held !== null && held !== server.port && await answering(held)) {
      const move = await vscode.window.showWarningMessage(
        'Another NikUI window is already reachable at this address.',
        {
          modal: true,
          detail: `${state.name} currently forwards to that window (port ${held}). ` +
            'Moving it here takes every paired phone with it: the address is the same, so a ' +
            'phone that was watching that window will start watching this one instead.'
        },
        'Move it to this window'
      );
      if (move !== 'Move it to this window') return false;
    }

    const out = await tailscale.expose(server.port);
    if (!out.ok) {
      vscode.window.showWarningMessage('NikUI could not ask Tailscale to forward to it: ' + out.reason);
      return false;
    }
    weExposed = true;
    server.publicHost = out.host;
    paint();

    const next = await vscode.window.showInformationMessage(
      `NikUI is reachable at ${out.url} from anything on your tailnet.`,
      'Pair a device', 'Copy the address'
    );
    if (next === 'Pair a device') { pair(); return true; }
    if (next === 'Copy the address' && vscode.env.clipboard) await vscode.env.clipboard.writeText(out.url);
    return true;
  };

  /**
   * The tailnet may already be forwarding to this port — from a window closed
   * without tidying up, or a `tailscale serve` set up by hand. Without noticing
   * it, the server refuses its own tailnet name with a 403 and the pairing code
   * carries 127.0.0.1, which is exactly the shape of "it says failed to fetch".
   *
   * Noticed, not claimed: this window did not set it up, so stopping does not
   * tear it down.
   */
  const adoptTunnel = async (knownPort) => {
    if (!server.listening || server.exposed) return false;
    let already = false;
    try {
      already = knownPort === undefined
        ? await tailscale.serving(server.port)
        : knownPort === server.port;
    } catch (_) { return false; }
    if (!already) return false;
    const state = await tailscale.status().catch(() => null);
    if (!state || !state.name) return false;
    server.publicHost = state.name;
    if (out) out.appendLine(new Date().toISOString() +
      `  the tailnet was already forwarding to ${server.port}; this window answers to ${state.name}`);
    paint();
    return true;
  };

  /**
   * Is a NikUI still answering on that port?
   *
   * Asked of a port the tailnet is already forwarding to, to tell "another
   * window has this" from "a window that had it is gone". Only /health, which
   * says nothing but yes and needs no credentials.
   */
  const answering = (port) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 700 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(res.statusCode === 200 && /"ok"\s*:\s*true/.test(body)));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  /**
   * Put this window on the tailnet by itself, if nothing else is using it.
   *
   * `tailscale serve` is one setting for the whole machine. Two windows both
   * claiming it would mean the second silently takes every phone away from the
   * first — the address does not change, so nothing would look wrong; the phone
   * would simply be showing a different window's instances.
   *
   * So the tunnel is claimed only when it is free, or when it points at a port
   * where nothing answers any more — a window that was closed, or a laptop that
   * restarted. A window that loses the race keeps serving on loopback, which is
   * what it would have done anyway, and says so in the log rather than in a
   * dialog nobody asked for.
   */
  const becomeReachable = async () => {
    if (!server.listening || server.exposed) return false;
    let held = null;
    try { held = await tailscale.forwardedPort(); } catch (_) { return false; }
    if (held === server.port) return adoptTunnel(held);
    if (held !== null && await answering(held)) {
      if (out) out.appendLine(new Date().toISOString() +
        `  the tailnet is already forwarding to ${held}, which is another window; ` +
        `this one is serving on ${server.port} and is reachable from this machine only`);
      return false;
    }

    const state = await tailscale.status().catch(() => null);
    if (!state || !state.installed || !state.running || !state.https) {
      if (out && state) out.appendLine(new Date().toISOString() +
        '  not putting this window on the tailnet: ' + (state.reason || 'Tailscale is not ready'));
      return false;
    }
    const done = await tailscale.expose(server.port);
    if (!done.ok) {
      if (out) out.appendLine(new Date().toISOString() +
        '  tailscale serve refused: ' + done.reason);
      return false;
    }
    weExposed = true;
    server.publicHost = done.host;
    if (out) out.appendLine(new Date().toISOString() +
      `  this window answers to ${done.host} on the tailnet`);
    paint();
    return true;
  };

  /**
   * The other way out, and the one you have to read something first.
   *
   * A tailnet is a set of devices you authorised. A public hostname is the
   * internet, and the difference is the whole of the threat model's third
   * attacker — so this says exactly what changes, and does not proceed until
   * somebody has said yes to that sentence rather than to a button.
   */
  const reachPublicly = async () => {
    if (!(await start())) return;
    const choice = await vscode.window.showWarningMessage(
      'Open a public address for this window?',
      {
        modal: true,
        detail: 'This puts a hostname on the internet that forwards to this window. ' +
          'Nobody can reach an instance without a paired device — but the pairing page ' +
          'becomes reachable by anyone who learns the address, and NikUI runs Claude with ' +
          'permissions bypassed, so a device that pairs and is granted control can run any ' +
          'command here.\n\n' +
          'Tailscale is the better path if you can use it: a tailnet is devices you already ' +
          'authorised. THREAT-MODEL.md in the repository is the long version.'
      },
      'Open it anyway', 'Read the threat model'
    );
    if (choice === 'Read the threat model') {
      const file = vscode.Uri.joinPath(context.extensionUri, 'THREAT-MODEL.md');
      return vscode.commands.executeCommand('markdown.showPreview', file);
    }
    if (choice !== 'Open it anyway') return;

    const opened = await cloudflared.expose(server.port);
    if (!opened.ok) {
      vscode.window.showWarningMessage('NikUI could not open a public tunnel: ' + opened.reason);
      return;
    }
    weExposed = true;
    server.publicHost = opened.host;
    paint();
    const next = await vscode.window.showWarningMessage(
      `NikUI is on the internet at ${opened.url} until you close it or this window.`,
      'Pair a device', 'Close it now'
    );
    if (next === 'Pair a device') return pair();
    if (next === 'Close it now') return unreach();
  };

  const unreach = async () => {
    const wasOpen = cloudflared.running || weExposed;
    if (!wasOpen) {
      vscode.window.setStatusBarMessage('NikUI: nothing outside this machine could reach this window', 4000);
      return;
    }
    const problems = await closeTunnels();
    paint();
    if (problems.length) vscode.window.showWarningMessage('NikUI: ' + problems.join('; '));
    else vscode.window.setStatusBarMessage('NikUI: only this machine can reach this window again', 4000);
  };

  const open = async () => {
    if (!(await start())) return;
    // The key rides in once and the page trades it for a cookie, so the address
    // bar — and anything that screenshots it — keeps nothing worth stealing.
    await vscode.env.openExternal(vscode.Uri.parse(server.url));
  };

  /**
   * A device introduces itself inside a one-minute window. The server has to be
   * running for that, so starting it is part of the same action rather than a
   * thing to discover from an error.
   */
  const pair = async () => {
    if (!(await start())) return;
    // Claims the address when it is free or abandoned, and leaves it alone when
    // another window is really using it — in which case the question below is
    // the honest one to ask rather than a silent takeover.
    await becomeReachable();

    // A phone is not this machine, and a pairing code for 127.0.0.1 is a code
    // that cannot work from one — it fails as "failed to fetch", which says
    // nothing about why. So the question is asked here, once, rather than
    // discovered on a phone: pairing something that is not here needs this
    // window to be reachable, and that is one tap away.
    if (!server.exposed) {
      const choice = await vscode.window.showInformationMessage(
        'Only this machine can reach this window.',
        {
          modal: true,
          detail: 'A phone somewhere else cannot use a pairing code that points at 127.0.0.1. ' +
            'Putting your tailnet in front of this window lets it — nothing new listens, ' +
            'Tailscale forwards to loopback, and it is one command to undo.'
        },
        'Make it reachable', 'Pair something on this machine'
      );
      if (!choice) return;
      if (choice === 'Make it reachable') {
        if (!(await reach())) return;
      }
    }
    PairPanel.show(context, pairing, server, devices);
  };

  const setExposure = async (key, value, said) => {
    await vscode.workspace.getConfiguration('nikui')
      .update('remote.' + key, value, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage('NikUI: ' + said, 5000);
    paint();
  };

  /** The keep-awake switch as a line in the menu, saying what it is now. */
  const awakeItem = () => {
    const now = awakeState && awakeState.state ? awakeState.state() : null;
    if (!now || now.supported === false) return null;
    return now.on
      ? { label: '$(debug-pause) Let this laptop sleep again', id: 'sleep',
          description: now.held ? 'currently: kept awake' : 'currently: on' }
      : { label: '$(coffee) Keep this laptop awake', id: 'awake',
          description: 'so your phone can always reach it' };
  };

  /** The lid switch, the same way: what it would do, and what it is now. */
  const lidItem = () => {
    const now = awakeState && awakeState.state ? awakeState.state() : null;
    const lid = now && now.lid;
    if (!lid || !lid.supported) return null;
    return lid.on
      ? { label: '$(debug-pause) Let the lid put this laptop to sleep again', id: 'lid-off',
          description: lid.held ? 'currently: working with the lid closed' : 'currently: on' }
      : { label: '$(screen-normal) Keep working with the lid closed', id: 'lid-on',
          description: lid.approved ? 'while Claude works, then sleep' : 'asks for your password once' };
  };

  const switchLid = async (on) => {
    try {
      const now = await awakeState.switchLid(on);
      if (!now) return;
      vscode.window.setStatusBarMessage(on
        ? 'NikUI: closing the lid will not stop work that is running. It sleeps when the work is done.'
        : 'NikUI: closing the lid puts this laptop to sleep again', 6000);
    } catch (err) {
      if (err && err.code === 'NOT_LOADED') return;
      vscode.window.showWarningMessage('NikUI could not change that: ' + ((err && err.message) || 'unknown error'));
    }
  };

  const switchAwake = async (on) => {
    try {
      await awakeState.set(on);
      const lidOn = !!(awakeState.state() && awakeState.state().lid && awakeState.state().lid.on);
      vscode.window.setStatusBarMessage(on
        ? 'NikUI: keeping this laptop awake.' + (lidOn ? '' : ' Closing the lid still puts it to sleep.')
        : 'NikUI: this laptop can sleep again', 5000);
    } catch (err) {
      if (err && err.code === 'NOT_LOADED') return;
      vscode.window.showWarningMessage('NikUI could not change that: ' + ((err && err.message) || 'unknown error'));
    }
  };

  const menu = async () => {
    const how = exposure();
    const choice = await vscode.window.showQuickPick([
      { label: '$(link-external) Open in a browser', id: 'open' },
      { label: '$(device-mobile) Pair a device', id: 'pair' },
      server.exposed
        ? { label: '$(circle-slash) Stop being reachable from my phone', id: 'unreach' }
        : { label: '$(radio-tower) Reach this window from my phone', id: 'reach' },
      server.exposed
        ? null
        : { label: '$(globe) Open a public address (read this first)', id: 'public' },
      { label: '$(clippy) Copy the link', id: 'copy' },
      awakeItem(),
      lidItem(),
      // The two switches that decide what a phone can reach, phrased as what
      // they do rather than as the words in the settings file.
      how.sealed
        ? { label: '$(unlock) Allow connections that are not sealed', id: 'unseal',
            description: 'currently: every device must encrypt end to end' }
        : { label: '$(lock) Require every device to encrypt end to end', id: 'seal',
            description: 'currently: a device may connect without sealing' },
      how.appOnly
        ? { label: '$(browser) Serve a browser page as well as the app', id: 'serve-page',
            description: 'currently: the app only' }
        : { label: '$(shield) Serve the app only, no browser page', id: 'app-only',
            description: 'currently: the app and a browser page' },
      { label: '$(debug-stop) Stop the server', id: 'stop' }
    ].filter(Boolean), {
      placeHolder: server.exposed
        ? `NikUI is reachable at ${server.publicScheme}://${server.publicHost}`
        : `NikUI is serving on 127.0.0.1:${server.port}`
    });
    if (!choice) return;
    if (choice.id === 'open') return open();
    if (choice.id === 'pair') return pair();
    if (choice.id === 'reach') return reach();
    if (choice.id === 'public') return reachPublicly();
    if (choice.id === 'unreach') return unreach();
    if (choice.id === 'stop') return stop();
    if (choice.id === 'awake') return switchAwake(true);
    if (choice.id === 'sleep') return switchAwake(false);
    if (choice.id === 'lid-on') return switchLid(true);
    if (choice.id === 'lid-off') return switchLid(false);
    if (choice.id === 'seal') {
      return setExposure('requireEncryption', true, 'every device must now encrypt end to end');
    }
    if (choice.id === 'unseal') {
      const yes = await vscode.window.showWarningMessage(
        'Allow a device to connect without encrypting?',
        {
          modal: true,
          detail: 'Everything between your phone and this laptop would then be protected by HTTPS ' +
            'alone — readable by anything holding a certificate for this address. The only reason ' +
            'to do this is a client too old to seal.'
        },
        'Allow it'
      );
      if (yes !== 'Allow it') return;
      return setExposure('requireEncryption', false, 'a device may now connect without sealing');
    }
    if (choice.id === 'app-only') {
      return setExposure('appOnly', true,
        'only the app can reach this window now — no page is served outside this machine');
    }
    if (choice.id === 'serve-page') {
      return setExposure('appOnly', false, 'a browser page is served again');
    }
    if (choice.id === 'copy' && vscode.env.clipboard) {
      await vscode.env.clipboard.writeText(server.url || '');
      vscode.window.setStatusBarMessage('NikUI: link copied — it only works on this machine', 4000);
    }
  };

  /**
   * Granting control is the one irreversible-feeling thing in here, so it asks
   * in the words that matter: a prompt from a phone is code running here.
   */
  const grant = async (device) => {
    if (!device) return;
    const yes = await vscode.window.showWarningMessage(
      `Let ${device.name} send prompts to this window?`,
      {
        modal: true,
        detail: 'A prompt from this device runs with the same permissions as one typed here — ' +
          'which, with NikUI\'s default settings, means it can run any command on this machine. ' +
          'You can take this back at any time.'
      },
      'Grant control'
    );
    if (yes !== 'Grant control') return;
    devices.setControl(device.id, true);
  };

  const revoke = async (device) => {
    if (!device) return;
    devices.setControl(device.id, false);
    vscode.window.setStatusBarMessage(`NikUI: ${device.name} can watch but not steer`, 4000);
  };

  const forget = async (device) => {
    if (!device) return;
    const yes = await vscode.window.showWarningMessage(
      `Forget ${device.name}?`,
      { modal: true, detail: 'Its key is deleted and any connection it is holding is closed now. ' +
        'It would have to pair again from scratch.' },
      'Forget it'
    );
    if (yes !== 'Forget it') return;
    devices.forget(device.id);
  };

  const rename = async (device) => {
    if (!device) return;
    const name = await vscode.window.showInputBox({ prompt: 'Name for this device', value: device.name });
    if (name == null) return;
    devices.rename(device.id, name);
  };

  /** A tree row, or whichever device the palette should ask about. */
  const pick = async (node) => {
    if (node && node.id && node.publicKey) return node;
    const all = devices.list();
    if (!all.length) {
      vscode.window.showInformationMessage('NikUI: no devices are paired yet.');
      return null;
    }
    if (all.length === 1) return all[0];
    const chosen = await vscode.window.showQuickPick(
      all.map((device) => ({ label: device.name, description: device.control ? 'can steer' : 'watching only', device })),
      { placeHolder: 'Which device?' }
    );
    return chosen ? chosen.device : null;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('nikui.remoteStart', async () => {
      if (await start()) vscode.window.setStatusBarMessage(`NikUI is serving on 127.0.0.1:${server.port}`, 4000);
    }),
    vscode.commands.registerCommand('nikui.remoteStop', stop),
    vscode.commands.registerCommand('nikui.remoteOpen', open),
    vscode.commands.registerCommand('nikui.remoteMenu', menu),
    // One place for everything, reachable from every view's menu and from the
    // palette. The settings themselves come from package.json, so this cannot
    // fall behind them.
    vscode.commands.registerCommand('nikui.settings', () => openSettings({
      schema: schemaFrom(context.extensionUri.fsPath),
      actions: [
        server.listening
          ? {
            label: '$(debug-stop) Stop the local server',
            description: `listening on 127.0.0.1:${server.port}`,
            run: stop
          }
          : {
            label: '$(broadcast) Start the local server',
            description: 'nothing is listening',
            detail: 'A socket into this window is code execution on this machine, so it is off until you say so',
            run: start
          },
        server.exposed
          ? {
            label: '$(circle-slash) Stop being reachable from my phone',
            description: `${server.publicScheme}://${server.publicHost}`,
            run: unreach
          }
          : {
            label: '$(radio-tower) Reach this window from my phone',
            detail: 'Puts the tailnet in front of the server. Nothing new listens.',
            run: reach
          },
        { label: '$(device-mobile) Pair a device', run: pair },
        {
          label: '$(list-unordered) Devices, and what they did',
          detail: `${devices.list().length} paired`,
          run: () => vscode.commands.executeCommand('nikui.devices.focus')
        }
      ]
    })),
    vscode.commands.registerCommand('nikui.pairDevice', pair),
    vscode.commands.registerCommand('nikui.reachFromPhone', reach),
    vscode.commands.registerCommand('nikui.stopReaching', unreach),
    vscode.commands.registerCommand('nikui.reachPublicly', reachPublicly),
    vscode.commands.registerCommand('nikui.grantControl', async (node) => grant(await pick(node))),
    vscode.commands.registerCommand('nikui.revokeControl', async (node) => revoke(await pick(node))),
    vscode.commands.registerCommand('nikui.forgetDevice', async (node) => forget(await pick(node))),
    vscode.commands.registerCommand('nikui.renameDevice', async (node) => rename(await pick(node))),
    { dispose: () => {
      // Deliberately not closeTunnels(). This runs on a window reload as well
      // as on a window closing, and a reload that tears the tunnel down leaves
      // a phone that was connected a moment ago saying it cannot reach
      // anything — for a reason nobody watching could possibly guess.
      //
      // `tailscale serve` outlives this process by design, so the next window
      // adopts it. Stopping the server on purpose still takes it down, because
      // that is somebody saying they are finished.
      server.dispose();
      if (bar) bar.dispose();
      if (out) out.dispose();
    } }
  );

  /**
   * A window that was serving when it went away starts serving when it comes
   * back.
   *
   * Not the same thing as autoStart, which is a standing instruction to listen.
   * This is narrower and it is the honest reading of what happened: somebody
   * asked this window to serve, and a reload is not them changing their mind.
   * Without it, every reload of the editor silently drops every phone.
   */
  const SERVING = 'nikui.remote.wasServing';
  if (context.workspaceState.get(SERVING, false) ||
      vscode.workspace.getConfiguration('nikui').get('remote.autoStart', true)) {
    // `start` already puts the tailnet in front when it is allowed to; there is
    // nothing left to do here but let it fail quietly if Tailscale is not up.
    start();
  }
  return server;
}

/**
 * One question: which folder. Reopening a past conversation is what History is
 * for — this picker used to offer both, and a list where half the rows start an
 * instance and half resume one is a list nobody reads carefully.
 */
async function pickFolder(mgr) {
  const separator = (label) => {
    const kind = vscode.QuickPickItemKind && vscode.QuickPickItemKind.Separator;
    return kind === undefined ? null : { label, kind };
  };

  const items = [];
  const seen = new Set();
  const workspace = vscode.workspace.workspaceFolders || [];

  if (workspace.length) {
    items.push(separator('This workspace'));
    for (const f of workspace) {
      seen.add(f.uri.fsPath);
      items.push({ label: `$(folder) ${f.name}`, description: f.uri.fsPath, path: f.uri.fsPath });
    }
  }

  // Folders this window has run an instance in before, newest last in storage.
  const recent = [];
  for (const saved of mgr.restorable().slice().reverse()) {
    if (!saved.cwd || seen.has(saved.cwd)) continue;
    seen.add(saved.cwd);
    recent.push({ label: `$(folder) ${path.basename(saved.cwd)}`, description: saved.cwd, path: saved.cwd });
  }
  if (recent.length) {
    items.push(separator('Used before'));
    items.push(...recent.slice(0, 8));
  }

  items.push(separator('Anywhere else'));
  items.push({ label: '$(folder-opened) Browse...', description: 'Pick any folder on this machine', browse: true });

  const choice = await vscode.window.showQuickPick(items.filter(Boolean), {
    placeHolder: 'Which folder should this instance run in?'
  });
  if (!choice) return null;
  if (choice.browse) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Start instance here'
    });
    return picked && picked.length ? { path: picked[0].fsPath } : null;
  }
  return { path: choice.path };
}

/**
 * Running out of quota overnight should not mean finding everything stopped in
 * the morning: it is announced when it happens, and announced again when the
 * window comes back and the instances pick their work up.
 */
function watchForQuota(manager, deps) {
  const win = (deps && deps.window) || vscode.window;

  manager.on('paused', (pause) => {
    const when = pause.blind ? 'in about 15 minutes' : new Date(pause.until).toLocaleTimeString();
    win.showWarningMessage(
      `NikUI: the usage limit is spent. Every instance is holding until ${when}, queues intact.`,
      'Resume now'
    ).then((choice) => {
      if (choice === 'Resume now') manager.resumeFromLimit({ manual: true });
    }, () => { /* dismissed */ });
  });

  manager.on('resumed', ({ woken, manual }) => {
    if (!woken || manual) return;
    win.setStatusBarMessage(
      `NikUI: the quota reset — ${woken} instance${woken === 1 ? '' : 's'} carrying on`, 5000
    );
  });
}

/**
 * Every instance is a real CLI process with its own model, and it is easy to
 * forget one behind a tab. Said once per window, when the count first crosses
 * the line, with the way to get the memory back.
 */
function watchForCrowding(manager, deps) {
  const win = (deps && deps.window) || vscode.window;
  const limit = (deps && deps.limit) || 8;
  let told = false;

  manager.on('changed', () => {
    const running = manager.list.filter((s) => s.isRunning).length;
    if (running < limit) { if (running <= limit / 2) told = false; return; }
    if (told) return;
    told = true;
    win.showInformationMessage(
      `${running} NikUI instances are running, each its own CLI process.`,
      'Show me'
    ).then((choice) => {
      if (choice === 'Show me') vscode.commands.executeCommand('nikui.sessions.focus');
    }, () => { /* dismissed */ });
  });
}

/**
 * A banner, and if wanted a chime, when an instance finishes. See done.js.
 *
 * On a Mac the banner comes from NikUI's own small app (notifier.js), so a
 * click on it opens that instance: the app writes its id into this window's
 * inbox, a file watched here, and brings this window to the front. Anywhere that app cannot be
 * built, the banner is the plain kind that cannot be clicked.
 */
function watchForDone(manager, context) {
  const mac = new MacNotifier({
    dir: context.globalStorageUri ? context.globalStorageUri.fsPath : null,
    log: (line) => console.log('[nikui] ' + line)
  });
  const appPath = () => {
    const at = (vscode.env.appRoot || '').indexOf('.app/');
    return at === -1 ? '' : vscode.env.appRoot.slice(0, at + 4);
  };
  // The window's own folder, or workspace file: opening it again is what
  // brings this window forward rather than whichever was last in front.
  const windowFolder = () => {
    const file = vscode.workspace.workspaceFile;
    if (file && file.scheme === 'file') return file.fsPath;
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.length === 1 ? folders[0].uri.fsPath : '';
  };

  const inbox = watchInbox(mac.dir, (id) => openClicked(id, manager, context));
  context.subscriptions.push(inbox);

  // A banner about one instance, which opens that instance when clicked.
  const announce = async (title, body, session) => {
    remember(context, session);
    const project = session.cwd ? path.basename(session.cwd) : '';
    const shown = mac.available && await mac.post({
      id: 'done-' + session.id,
      title, body,
      subtitle: project && project !== session.label ? project : '',
      inbox: inbox.path || '',
      session: session.id,
      app: appPath(),
      folder: windowFolder()
    });
    if (shown) return;
    // A Mac's own fallback belongs to Script Editor, and a click on it opens
    // Script Editor. VS Code's is at least one that can open the instance.
    if (process.platform !== 'darwin') return void plainBanner(title, body);
    const choice = await vscode.window.showInformationMessage(`${title} · ${body}`, 'Open instance');
    if (choice && manager.get(session.id)) SessionPanel.show(session, context, manager).focusInput();
  };

  const notifier = new DoneNotifier({
    settings: () => {
      const cfg = vscode.workspace.getConfiguration('nikui');
      return { popup: cfg.get('notifyWhenDone', false), sound: cfg.get('notifyWhenDoneSound', true) };
    },
    isLookingAt: (id) => !!(vscode.window.state && vscode.window.state.focused) && SessionPanel.isVisible(id),
    banner: announce
  });
  context.subscriptions.push({ dispose: notifier.watch(manager) });
  // Built now, while nothing is waiting on it, rather than at the first banner.
  const cfg = vscode.workspace.getConfiguration('nikui');
  if (mac.available && (cfg.get('notifyWhenDone', false) || cfg.get('notifyCI', true))) mac.ensure();
  return announce;
}

/**
 * CI on the PR an instance pushed to, watched by asking GitHub every fifteen
 * seconds, and a banner when it is over — unless you are looking at it.
 */
const CI_DURATIONS = 'nikui.ciDurations';
function watchForCi(manager, context, announce) {
  const setting = (key, fallback) => vscode.workspace.getConfiguration('nikui').get(key, fallback);
  const watcher = new CiWatcher({
    autoWatch: () => setting('watchCIAfterPush', true),
    history: {
      get: (repo) => (context.globalState.get(CI_DURATIONS) || {})[repo] || [],
      add: (repo, ms) => {
        const all = Object.assign({}, context.globalState.get(CI_DURATIONS) || {});
        all[repo] = [ms].concat(all[repo] || []).slice(0, 10);
        context.globalState.update(CI_DURATIONS, all);
      }
    },
    notify: (session, state) => {
      // The phone hears it whatever the laptop's own banner is set to; which
      // phones, and whether at all, is nikui.notifyDevices.ci.
      manager.emit('ci-result', session, state);
      if (!setting('notifyCI', true)) return;
      if (!['passed', 'failed', 'none', 'error'].includes(state.phase)) return;
      if (setting('notifyWhenDoneSound', true)) chime();
      const looking = !!(vscode.window.state && vscode.window.state.focused) && SessionPanel.isVisible(session.id);
      if (looking) return;
      const pr = state.pr ? `PR #${state.pr.number}` : 'CI';
      const title = state.phase === 'passed' ? `${pr} is green`
        : state.phase === 'failed' ? `${pr} failed` : state.phase === 'none' ? `${pr} has no CI` : 'Cannot watch CI';
      const body = state.phase === 'failed' ? `${(state.failing || []).join(', ')} · ${session.label}`
        : state.phase === 'error' ? `${state.message} · ${session.label}`
          : `${state.pr && state.pr.title ? state.pr.title + ' · ' : ''}${session.label}`;
      announce(title, body, session);
    }
  });
  context.subscriptions.push({ dispose: watcher.attach(manager) });
  return watcher;
}

// What a banner was about, kept so a click can reopen an instance that has
// been closed since. Only what NikUI itself announced: nothing else written
// into the inbox can name a conversation or a folder and have it started.
const NOTIFIED = 'nikui.notified';
function remember(context, session) {
  const known = (context.globalState.get(NOTIFIED) || []).filter((n) => n.id !== session.id);
  known.unshift({ id: session.id, claude: session.claudeSessionId || null, cwd: session.cwd || null,
    label: session.customTitle || session.label || null });
  context.globalState.update(NOTIFIED, known.slice(0, 50));
}

/**
 * This window's inbox: one file, named for this window alone, that the
 * notifier app writes an instance's id into when its banner is clicked. Each
 * window has its own, so a click lands in the window the instance lives in.
 */
function watchInbox(dir, onClick) {
  if (!dir) return { path: null, dispose() {} };
  const folder = path.join(dir, 'clicks');
  const name = crypto.randomBytes(8).toString('hex');
  const file = path.join(folder, name);
  let watcher = null;
  try {
    fs.mkdirSync(folder, { recursive: true });
    watcher = fs.watch(folder, (event, changed) => {
      if (changed !== name) return;
      let id = '';
      try { id = fs.readFileSync(file, 'utf8').trim(); fs.unlinkSync(file); } catch (_) { return; }
      if (id) onClick(id);
    });
  } catch (_) { return { path: null, dispose() {} }; }
  return {
    path: file,
    dispose() {
      if (watcher) watcher.close();
      try { fs.unlinkSync(file); } catch (_) { /* never written */ }
    }
  };
}

/** A banner was clicked: show that instance, or bring it back if it has closed. */
async function openClicked(id, manager, context) {
  const live = manager.get(id);
  if (live) { SessionPanel.show(live, context, manager).focusInput(); return; }
  const known = (context.globalState.get(NOTIFIED) || []).find((n) => n.id === id);
  if (known && known.claude && known.cwd) {
    await vscode.commands.executeCommand('nikui.resumeHistory',
      { sessionId: known.claude, cwd: known.cwd, label: known.label, title: known.label || '' });
    return;
  }
  vscode.window.showInformationMessage('NikUI: that instance is not open any more.');
}

/**
 * Two things must never happen quietly: an instance blocked on a question
 * nobody can see, and an instance that could not start at all — the second
 * writes its error into a panel that, by definition, may never open.
 *
 * `open` is how to bring an instance to the front; injected so this can be
 * driven without a window.
 */
function watchForTrouble(manager, open, deps) {
  const win = (deps && deps.window) || vscode.window;
  const settings = (deps && deps.readConfig) || readConfig;
  const isVisible = (deps && deps.isVisible) || ((id) => SessionPanel.isVisible(id));
  const told = new Map(); // session id -> what it was last told about

  const enabled = () => {
    try { return settings().notifyOnAttention !== false; } catch (_) { return true; }
  };

  manager.on('failed', async (session, message) => {
    if (!enabled()) return;
    told.set(session.id, 'error');
    const choice = await win.showErrorMessage(`NikUI · ${session.label}: ${message}`, 'Open instance', 'Settings');
    if (choice === 'Open instance') open(session);
    else if (choice === 'Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'nikui.claudePath');
    }
  });

  manager.on('session-changed', async (session) => {
    if (!session) return;
    const was = told.get(session.id);
    // Only the moment it starts waiting, and only when it cannot be seen.
    if (session.status !== 'waiting') {
      if (was === 'waiting') told.delete(session.id);
      return;
    }
    if (was === 'waiting' || !enabled() || isVisible(session.id)) return;
    told.set(session.id, 'waiting');
    const pending = (session.items || []).filter((i) => i.kind === 'permission' && !i.resolved).pop();
    const what = pending && pending.name ? ` to run ${pending.name}` : '';
    const choice = await win.showWarningMessage(
      `NikUI · ${session.label} is waiting for your answer${what}.`, 'Open instance'
    );
    if (choice === 'Open instance') open(session);
  });
}

/**
 * Picking an instance from the editor tabs has to move the sidebar highlight
 * too — otherwise the row that looks selected is not the one on screen. The
 * sidebar is left alone when it is hidden, so this never forces the view open.
 */
function followFocus(view, manager) {
  const show = (session, retry) => {
    if (!view || typeof view.reveal !== 'function' || view.visible === false) return;
    let done;
    try {
      done = view.reveal(session, { select: true, focus: false, expand: true });
    } catch (_) { done = null; }
    if (done && typeof done.then === 'function') {
      // A brand new instance can be focused before the tree has drawn its row;
      // one retry after the refresh has landed is the difference between the
      // selection following you and silently not.
      done.then(undefined, () => {
        if (retry) setTimeout(() => show(session, false), 150);
      });
    }
  };
  manager.on('focused', (session) => show(session, true));
}

function folderIdOf(node) {
  if (!node) return null;
  if (node.__folder) return node.id;
  if (typeof node.id === 'string' && node.id.startsWith('folder:')) return node.id.slice(7);
  return null;
}

/**
 * Choose the PR for an instance by hand: the open PRs of its repository, or a
 * URL or number typed in. A number is looked up in the instance's folder.
 */
async function pickPullRequest(session, setPr) {
  const { execFile } = require('child_process');
  const gh = (args) => new Promise((resolve) => {
    execFile('gh', args, { cwd: session.cwd, timeout: 20000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') }));
  });
  const listed = await gh(['pr', 'list', '--state', 'open', '--limit', '40', '--json', 'number,title,url,headRefName,author']);
  let prs = [];
  try { prs = listed.ok ? JSON.parse(listed.stdout) : []; } catch (_) { prs = []; }
  const items = prs.map((p) => ({
    label: `#${p.number} ${p.title}`,
    description: `${p.headRefName}${p.author && p.author.login ? ' · ' + p.author.login : ''}`,
    url: p.url
  }));
  items.push({ label: '$(link) Paste a URL or number…', type: true });
  if (session.prUrl) items.push({ label: '$(close) Unlink the current PR', unlink: true });
  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: listed.ok ? `Pull request for ${session.label}` : `Couldn't list PRs here (${listed.stderr.split('\n')[0]}). Paste a URL instead.`,
    matchOnDescription: true
  });
  if (!choice) return;
  if (choice.unlink) return setPr(session, null);
  let url = choice.url || null;
  if (choice.type) {
    const typed = await vscode.window.showInputBox({ prompt: 'Pull request URL, or its number in this repository', placeHolder: 'https://github.com/owner/repo/pull/123' });
    if (!typed || !typed.trim()) return;
    const text = typed.trim();
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(text)) url = text.replace(/[#?].*$/, '').replace(/(\/pull\/\d+).*$/, '$1');
    else if (/^#?\d+$/.test(text)) {
      const found = await gh(['pr', 'view', text.replace('#', ''), '--json', 'url']);
      try { url = found.ok ? JSON.parse(found.stdout).url : null; } catch (_) { url = null; }
      if (!url) return vscode.window.showWarningMessage(`No PR ${text} in ${session.cwd}.`);
    } else return vscode.window.showWarningMessage('That is not a GitHub pull request URL or number.');
  }
  if (url) setPr(session, url);
}

function deactivate() {
  forgetHost();
  closeAllHubs();
  if (ledger) { ledger.record(manager ? manager.list : []); ledger.flush(); }
  if (manager) manager.disposeAll();
}

module.exports = { activate, deactivate, followFocus, serveLocally, watchForTrouble, watchForCrowding, watchForQuota, watchInbox, openClicked, watchForCi };
