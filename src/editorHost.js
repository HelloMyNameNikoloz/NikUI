'use strict';

// The extension's provider. Machine code receives this object, never VS Code.
const vscode = require('vscode');
const { readConfig: readFrom } = require('./config');
const { focusOpenTab } = require('./browserTab');
const { resolvePath, howToOpen, openInBrowser } = require('./opener');

function editorSettings() { return vscode.workspace.getConfiguration('nikui'); }
// The only zero-argument compatibility reader lives on the extension side.
function readConfig() { return readFrom(editorSettings()); }

function createEditorHost(context, manager, extras) {
  return {
    id: (vscode.env && vscode.env.sessionId) || 'editor',
    get workspaces() { return (vscode.workspace.workspaceFolders || []).map((f) => f.uri); },
    get focused() { return !vscode.window.state || vscode.window.state.focused !== false; },
    openFile: (req, requester) => openFile(req, requester),
    openUrl: (url, requester) => requester?.proto === 2
      ? vscode.env.openExternal(vscode.Uri.parse(url)) : openBrowserUrl(url),
    runInTerminal: (req, requester) => runInTerminal(req),
    switchTo: (id, from, requester) => {
      const switched = switchTo(context, manager, id, from, extras && extras.codex);
      return requester?.proto === 2 ? switched : undefined;
    },
    openAllSettings: async (requester) => {
      const response = await vscode.commands.executeCommand('nikui.settings');
      return requester?.proto === 2 ? { status: 'dispatched' } : response;
    },
    ui: {
      confirm: ({ message, detail, choices }, requester) => vscode.window.showWarningMessage(
        message, { modal: true, detail }, ...choices),
      notify: ({ message, choices = [] }, requester) => vscode.window.showWarningMessage(message, ...choices)
    },
    environment: () => ({ reach: reachState(), vscode: vscode.version })
  };
}

// One Automation hint per extension host, just as before the split.
const openUrl = {};
async function openBrowserUrl(url) {
  const found = await focusOpenTab(url);
  if (found === true) return;
  await vscode.env.openExternal(vscode.Uri.parse(url));
  if (found === 'denied' && !openUrl.told) {
    openUrl.told = true;
    const pick = await vscode.window.showWarningMessage(
      'NikUI opened a new tab because macOS does not let VS Code look at your browser’s tabs. ' +
      'Turn on your browser under Visual Studio Code in Privacy & Security → Automation to go to the open tab instead.',
      'Open Automation settings');
    if (pick) vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'));
  }
}

function reachState() {
  let cfg;
  try { cfg = vscode.workspace.getConfiguration('nikui'); }
  catch (_) { return { sealed: true, appOnly: false }; }
  return {
    sealed: cfg.get('remote.requireEncryption', true),
    appOnly: cfg.get('remote.appOnly', false)
  };
}

async function runInTerminal(req) {
  const command = String((req && req.command) || '').trim();
  if (!command) return false;
  const name = 'NikUI' + (req && req.label ? ' \u00b7 ' + req.label : '');
  const open = vscode.window.terminals.find((t) => t.name === name);
  const terminal = open || vscode.window.createTerminal({ name, cwd: (req && req.cwd) || undefined });
  terminal.show(true);
  terminal.sendText(command, false);
  return true;
}

async function openFile(req, requester) {
  requester?.revalidate?.();
  const raw = String((req && req.path) || '').trim();
  if (!raw) return;
  const abs = resolvePath(raw, req && req.cwd);
  const uri = vscode.Uri.file(abs);
  try {
    switch (howToOpen(abs)) {
      case 'missing':
        vscode.window.setStatusBarMessage('NikUI: no such file ' + raw, 4000);
        return requester?.proto === 2 ? { status: 'unavailable', code: 'EDITOR_UNAVAILABLE' } : undefined;
      case 'browser':
        if (requester?.proto === 2) return openInBrowser(abs, { requireDefault: true, beforeOpen: requester.revalidate });
        if (!(await openInBrowser(abs))) await vscode.env.openExternal(uri);
        return;
      case 'system':
        { const opened = await vscode.env.openExternal(uri); return requester?.proto === 2 ? opened : undefined; }
      case 'folder': {
        const inside = vscode.workspace.getWorkspaceFolder(uri);
        await vscode.commands.executeCommand(inside ? 'revealInExplorer' : 'revealFileInOS', uri);
        return requester?.proto === 2 ? true : undefined;
      }
      case 'picture':
        await vscode.commands.executeCommand('vscode.open', uri, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        return requester?.proto === 2 ? true : undefined;
      default: {
        const doc = await vscode.workspace.openTextDocument(uri);
        requester?.revalidate?.();
        const line = Math.max(0, (Number(req && req.line) || 1) - 1);
        const at = new vscode.Range(line, 0, line, 0);
        await vscode.window.showTextDocument(doc, { selection: at, preview: true, viewColumn: vscode.ViewColumn.Beside });
      }
    }
    if (requester?.proto === 2) return true;
  } catch (error) {
    if (requester?.proto === 2) throw error;
    // Not text after all (an unknown binary): the system knows what it is.
    try { await vscode.env.openExternal(uri); } catch (__) {
      vscode.window.setStatusBarMessage('NikUI: could not open ' + raw, 3000);
    }
  }
}

/** Jump to another instance straight from the fleet table. */
function switchTo(context, manager, id, from, codex) {
  if (!manager || !id) return false;
  // A Codex conversation lives in Codex's workspace, not the manager's fleet.
  const target = manager.get(id) || (codex && codex() ? codex().get(id) : null);
  if (!target) return false;
  if (from && target.id === from.id) return true;
  // Required late: the panel is a client of the hub this host serves.
  const { SessionPanel } = require('./panel');
  SessionPanel.show(target, context, manager).focusInput();
  return true;
}

module.exports = { createEditorHost, editorSettings, readConfig };
