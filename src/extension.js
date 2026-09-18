'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { SessionManager, readConfig } = require('./manager');
const { SessionTree } = require('./tree');
const { FolderStore } = require('./folders');
const { SessionPanel } = require('./panel');
const { closeHub, closeAllHubs } = require('./hub');
const { HistoryTree } = require('./historyTree');
const { projectsRoot } = require('./history');
const { nextTicket } = require('./ticket');
const { labelFor } = require('./label');
const { createHost } = require('./host');
const { RemoteServer } = require('./remote');
const { DeviceStore } = require('./devices');
const { DevicesTree } = require('./devicesTree');
const { PairingWindow } = require('./pairing');
const { PairPanel } = require('./pairPanel');
const { loadIdentity } = require('./identity');
const { Tailscale, Cloudflared } = require('./tunnel');
const { Awake, shouldHold } = require('./awake');
const { loadVapid } = require('./push');
const { Notifier } = require('./notify');

let manager;

function activate(context) {
  manager = new SessionManager(context);
  const folders = new FolderStore(context);
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
  context.subscriptions.push(historyView);
  // Scope and filter live in the header, not in a status-bar message that has
  // already gone by the time you wonder why the list looks short.
  const showScope = () => { historyView.description = history.summary; };
  showScope();
  // Transcripts are written continuously; re-read whenever the panel is shown.
  context.subscriptions.push(historyView.onDidChangeVisibility((e) => { if (e.visible) history.refresh(); }));
  manager.on('changed', () => history.refresh());

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
    const session = manager.create({ cwd: cwd.path, resume: cwd.resume, title: cwd.title });
    SessionPanel.show(session, context, manager).focusInput();
  });

  register('nikui.newSessionInFolder', async (node) => {
    const folderId = folderIdOf(node);
    const folder = folderId ? folders.get(folderId) : null;
    if (!folder) return;
    const cwd = await pickFolder(manager);
    if (!cwd) return;
    const session = manager.create({ cwd: cwd.path });
    folders.place(session.id, folder.id);
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
    const inside = manager.list.filter((s) => (folders.folderOf(s.id) || {}).id === id).length;
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
      autoLabel: ticket ? null : (entry.label || labelFor(entry.title))
    });
    SessionPanel.show(session, context, manager).focusInput();
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

  // The sheet should be able to say whether the machine is being held awake,
  // and the thing holding it needs to know whether the server is listening, so
  // each is handed a way to ask the other rather than a reference to it.
  let awake = null;
  const server = serveLocally(context, manager, { state: () => (awake ? awake.state() : null) });
  awake = keepAwake(context, manager, server);

  context.subscriptions.push({ dispose: () => { closeAllHubs(); manager.disposeAll(); } });
}

/**
 * Keep the machine awake while there is something worth staying awake for.
 *
 * Off unless asked, because keeping somebody's laptop awake is not a decision
 * to make for them; released the moment nothing needs it, because a machine
 * that never sleeps through a forgotten flag is its own bug.
 */
function keepAwake(context, manager, server) {
  const awake = new Awake();

  const reconsider = () => {
    let enabled = false;
    try { enabled = vscode.workspace.getConfiguration('nikui').get('keepAwake', false); } catch (_) { enabled = false; }
    const verdict = shouldHold({
      enabled,
      sessions: manager.list,
      serving: !!(server && server.listening)
    });
    if (verdict.hold) awake.hold(verdict.reason);
    else awake.release();
  };

  manager.on('changed', reconsider);
  manager.on('session-changed', reconsider);
  manager.on('paused', reconsider);
  manager.on('resumed', reconsider);
  if (server && server.onState) context.subscriptions.push({ dispose: server.onState(reconsider) });
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event || !event.affectsConfiguration || event.affectsConfiguration('nikui.keepAwake')) reconsider();
    }));
  }
  // Quitting the editor lets go of it, rather than leaving the machine awake
  // on the strength of a process that is no longer there.
  context.subscriptions.push({ dispose: () => awake.dispose() });
  reconsider();
  return awake;
}

/**
 * The same client, in a browser on this machine.
 *
 * Off unless you say so, and loud while it is on: NikUI runs Claude with
 * permissions bypassed, so anything that can reach this server can run code
 * here. The status bar item is not decoration — it is the answer to "is it
 * listening right now", which should never need looking up.
 */
function serveLocally(context, manager, awakeState) {
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

  const server = new RemoteServer({
    root: context.extensionUri.fsPath,
    host: createHost(context, manager, { devices, awake: awakeState || null }),
    sessions: { list: () => manager.list, get: (id) => manager.get(id) },
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
    log: (line) => { if (out) out.appendLine(new Date().toISOString() + '  ' + line); }
  });

  // The mesh in front of the server, when there is one. Nothing binds anywhere
  // but loopback either way: this asks Tailscale's own proxy to forward to us.
  const tailscale = new Tailscale();
  const cloudflared = new Cloudflared({
    log: (line) => { if (out) out.appendLine(new Date().toISOString() + '  ' + line); }
  });
  let weExposed = false;

  /**
   * Being told, rather than checking. Three things are worth a phone buzzing;
   * a turn finishing is available and off, because four agents finishing
   * overnight is a phone buzzing all night.
   */
  const notifier = new Notifier({
    devices,
    vapid,
    settings: () => {
      try { return vscode.workspace.getConfiguration('nikui').get('notifyDevices', {}) || {}; }
      catch (_) { return {}; }
    },
    log: (line) => { if (out) out.appendLine(new Date().toISOString() + '  push: ' + line); }
  });
  context.subscriptions.push({ dispose: notifier.watch(manager) });

  const tree = new DevicesTree(devices, server);
  const view = vscode.window.createTreeView('nikui.devices', { treeDataProvider: tree });
  context.subscriptions.push(view, tree);

  const paint = () => {
    if (!bar) return;
    if (!server.listening) { bar.hide(); return; }
    const paired = devices.list().length;
    // Reachable from elsewhere is a different state from listening, and the
    // status bar is where you should be able to tell them apart at a glance.
    bar.text = server.exposed ? `$(radio-tower) NikUI · ${server.publicHost}` : `$(broadcast) NikUI :${server.port}`;
    bar.tooltip = (server.exposed
      ? `NikUI is reachable on the tailnet at ${server.publicScheme}://${server.publicHost}`
      : `NikUI is serving this window on 127.0.0.1:${server.port}, and nowhere else`) +
      (paired ? ` · ${paired} paired device${paired === 1 ? '' : 's'}` : '') +
      '. Click for actions.';
    bar.command = 'nikui.remoteMenu';
    bar.show();
  };
  context.subscriptions.push({ dispose: devices.onChange(paint) });

  const start = async () => {
    if (server.listening) return server;
    const port = vscode.workspace.getConfiguration('nikui').get('remote.port', 4517);
    try {
      await server.start(port);
    } catch (err) {
      const why = err && err.code === 'EADDRINUSE'
        ? `port ${port} is already taken — change nikui.remote.port`
        : (err && err.message) || 'unknown error';
      vscode.window.showWarningMessage('NikUI could not start the local server: ' + why);
      return null;
    }
    paint();
    return server;
  };

  const stop = async () => {
    // Taking the server down leaves the tailnet pointing at nothing, so the
    // forwarding goes with it — but only the forwarding this window set up.
    if (weExposed) { await tailscale.hide(); weExposed = false; server.publicHost = null; }
    await server.stop();
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

    const out = await tailscale.expose(server.port);
    if (!out.ok) {
      vscode.window.showWarningMessage('NikUI could not ask Tailscale to forward to it: ' + out.reason);
      return;
    }
    weExposed = true;
    server.publicHost = out.host;
    paint();

    const next = await vscode.window.showInformationMessage(
      `NikUI is reachable at ${out.url} from anything on your tailnet.`,
      'Pair a device', 'Copy the address'
    );
    if (next === 'Pair a device') return pair();
    if (next === 'Copy the address' && vscode.env.clipboard) await vscode.env.clipboard.writeText(out.url);
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
    if (cloudflared.running) {
      await cloudflared.hide();
      weExposed = false;
      server.publicHost = null;
      paint();
      vscode.window.setStatusBarMessage('NikUI: the public address is closed', 4000);
      return;
    }
    if (!weExposed) {
      vscode.window.setStatusBarMessage('NikUI: this window was not reachable from the tailnet', 4000);
      return;
    }
    const out = await tailscale.hide();
    weExposed = false;
    server.publicHost = null;
    paint();
    if (!out.ok) vscode.window.showWarningMessage('NikUI: Tailscale would not stop forwarding: ' + out.reason);
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
    PairPanel.show(context, pairing, server, devices);
  };

  const menu = async () => {
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
    vscode.commands.registerCommand('nikui.pairDevice', pair),
    vscode.commands.registerCommand('nikui.reachFromPhone', reach),
    vscode.commands.registerCommand('nikui.stopReaching', unreach),
    vscode.commands.registerCommand('nikui.reachPublicly', reachPublicly),
    vscode.commands.registerCommand('nikui.grantControl', async (node) => grant(await pick(node))),
    vscode.commands.registerCommand('nikui.revokeControl', async (node) => revoke(await pick(node))),
    vscode.commands.registerCommand('nikui.forgetDevice', async (node) => forget(await pick(node))),
    vscode.commands.registerCommand('nikui.renameDevice', async (node) => rename(await pick(node))),
    { dispose: () => {
      if (weExposed) tailscale.hide();
      cloudflared.hide();
      server.dispose();
      if (bar) bar.dispose();
      if (out) out.dispose();
    } }
  );

  if (vscode.workspace.getConfiguration('nikui').get('remote.autoStart', false)) start();
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

function deactivate() {
  closeAllHubs();
  if (manager) manager.disposeAll();
}

module.exports = { activate, deactivate, followFocus, serveLocally, watchForTrouble, watchForCrowding, watchForQuota };
