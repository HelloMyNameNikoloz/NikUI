'use strict';
const fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { noSymlinks, readPrivateJson, fail } = require('./daemonPaths');
const { atomicJson } = require('./engineOwner');
const configFile = (context) => path.join(context.globalStorageUri.fsPath, 'cutover-recovery.json');

function retainHelper(context, { helper, recoveryConfig, profile, install }) {
  if (!helper) return; // Portable fixtures have an injected Keychain adapter.
  noSymlinks(helper);
  const check = (app) => {
    const result = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 15000, killSignal: 'SIGKILL' });
    const info = spawnSync('/usr/bin/codesign', ['-dvv', app], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    if (result.status !== 0 || info.status !== 0 || !/^TeamIdentifier=KBA6653B4V$/m.test(info.stderr)) throw fail('RECOVERY_HELPER_UNAVAILABLE', 'The signed recovery helper is required');
  };
  check(helper);
  const directory = path.join(context.globalStorageUri.fsPath, 'cutover-recovery');
  noSymlinks(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const retained = path.join(directory, 'NikKeychain.app');
  if (fs.existsSync(retained)) { noSymlinks(retained); fs.rmSync(retained, { recursive: true }); }
  fs.cpSync(helper, retained, { recursive: true }); check(retained);
  atomicJson(configFile(context), { version: 1, ...recoveryConfig, profile, install, helper: retained,
    app: path.resolve(helper, '../../..') });
}
function restore(context) {
  const file = configFile(context), selected = readPrivateJson(file);
  if (selected.version !== 1) throw fail('RECOVERY_HELPER_UNAVAILABLE', 'No reviewed local restore is available');
  const child = spawn(process.execPath, [path.join(__dirname, 'localCutoverRestore.js'), file], {
    env: { ELECTRON_RUN_AS_NODE: '1', HOME: selected.home, USERPROFILE: selected.home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '', finished = false, timer, sequence = 0;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      if (error) reject(error); else resolve(value);
    };
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { child.kill('SIGKILL'); finish(fail('CUTOVER_TIMEOUT', 'Local restore stopped making progress; retry Restore VS Code')); }, 35000);
    };
    progress();
    child.stdout.on('data', (bytes) => {
      output += bytes;
      if (output.length > 1024 * 1024) { child.kill('SIGKILL'); finish(fail('CUTOVER_REPLY_TOO_LARGE', 'Local restore failed')); }
      while (output.startsWith('{"cutoverProgress":') && output.includes('\n')) {
        const at = output.indexOf('\n');
        try {
          const value = JSON.parse(output.slice(0, at));
          if (!Number.isSafeInteger(value.cutoverProgress) || value.cutoverProgress <= sequence) break;
          sequence = value.cutoverProgress; output = output.slice(at + 1); progress();
        } catch (_) { break; }
      }
    });
    child.stderr.resume(); child.once('error', (e) => finish(e));
    child.once('exit', () => {
      try { const value = JSON.parse(output); if (!value.ok) throw fail(value.code || 'CUTOVER_UNAVAILABLE', 'Local restore needs attention'); finish(null, value); }
      catch (error) { finish(error); }
    });
  });
}
function showRecovery(context, vscode, source, { recovery: recovering = false } = {}) {
  const command = 'nikui.restoreVSCode';
  const subscriptions = [], add = (item) => { subscriptions.push(item); context.subscriptions.push(item); };
  const pendingReturn = () => require('./cutoverRecovery').pendingReturns(context)
    .find((item) => item.workspace === require('./sourceWorkspace').identity(vscode.workspace));
  const keep = 'nikui.importSavedConversations', forget = 'nikui.discardSavedReturn';
  add(vscode.commands.registerCommand(keep, async () => {
    const choice = await vscode.window.showWarningMessage('Import saved conversations using your current settings?',
      { modal: true, detail: 'Your current workspace settings will be kept. Saved conversations, transcripts and queued prompts will be restored. Later conversation changes still block this import.' }, 'Import Conversations');
    if (choice !== 'Import Conversations') return;
    try {
      if (!await source.deliverRestore?.({ explicit: true, keepSettings: true })) throw fail('RESTORE_STATE_UNAVAILABLE', 'No saved return');
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (e) { void vscode.window.showWarningMessage('NikUI saved conversations: ' + (e.code || 'RESTORE_STATE_UNAVAILABLE')); }
  }));
  add(vscode.commands.registerCommand(forget, async () => {
    const saved = pendingReturn(); if (!saved) return;
    const choice = await vscode.window.showWarningMessage('Discard this folder’s saved return?',
      { modal: true, detail: saved.workspace + '\nCurrent settings and conversations will be kept. The saved return will be removed from automatic recovery after an encrypted archive is saved in this editor profile.' }, 'Discard Saved Return');
    if (choice !== 'Discard Saved Return') return;
    try {
      const result = await source.forgetRestore(saved);
      void vscode.window.showInformationMessage('NikUI: Encrypted return archive saved at ' + result.archive);
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (e) { void vscode.window.showWarningMessage('NikUI saved return retained: ' + (e.code || 'RESTORE_STATE_UNAVAILABLE')); }
  }));
  add(vscode.commands.registerCommand(command, async () => {
    try {
      // An expired closed-folder return already belongs to an open legacy
      // generation. Consume it here before a coordinator can trigger reload.
      if (await source.deliverRestore?.({ explicit: true })) {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
        void vscode.window.showInformationMessage('NikUI: Current work restored to VS Code.');
        return;
      }
      await restore(context);
      if (await source.deliverRestore?.({ explicit: true })) void vscode.commands.executeCommand('workbench.action.reloadWindow');
      void vscode.window.showInformationMessage('NikUI: Current work restored to VS Code.');
    }
    catch (e) {
      const choices = pendingReturn() ? ['Keep Current Settings and Import Conversations', 'Discard Saved Return…'] : [];
      const choice = await vscode.window.showWarningMessage('NikUI Restore: ' + (e.code || 'CUTOVER_UNAVAILABLE'), ...choices);
      if (choice && choice === choices[0]) await vscode.commands.executeCommand(keep);
      else if (choice && choice === choices[1]) await vscode.commands.executeCommand(forget);
    }
  }));
  const status = vscode.window.createStatusBarItem(); status.text = 'NikUI: Restore VS Code'; status.command = command;
  status.tooltip = 'Restore current work using the retained local helper, even if the Mac app has been removed.'; status.show();
  add(status);
  if (recovering) {
    const rows = [{ label: 'NikUI is waiting for ownership recovery.' }, { label: 'Restore VS Code', command: { command, title: 'Restore VS Code' } }];
    if (source.recoveryProblem) rows.unshift({ label: 'Saved folder work is retained: ' + source.recoveryProblem });
    if (pendingReturn()) rows.push(
      { label: 'Keep Current Settings and Import Conversations', command: { command: keep, title: 'Import Conversations' } },
      { label: 'Discard Saved Return…', command: { command: forget, title: 'Discard Saved Return' } });
    add(vscode.window.createTreeView('nikui.sessions', { treeDataProvider: { getChildren: () => rows, getTreeItem: (item) => item } }));
  }
  return { dispose() { for (const item of subscriptions.splice(0)) {
    item.dispose(); const index = context.subscriptions.indexOf(item); if (index >= 0) context.subscriptions.splice(index, 1);
  } } };
}
module.exports = { retainHelper, restore, showRecovery, configFile };
