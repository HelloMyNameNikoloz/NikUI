'use strict';

const path = require('path');
const crypto = require('crypto');
const vscode = require('vscode');
const { openDevelopmentClient, METHODS, CORE } = require('./developmentBridge');
const { createEditorHost } = require('./editorHost');
const { renderPage, randomNonce, jsonForScript } = require('./page');
const { createDevelopmentManagement } = require('./developmentManagement');
const { matches, resultSchema } = require('./localManagementProtocol');

function developmentOptions(context, env = process.env) {
  if (env.NIKUI_ISOLATED_DEV_WINDOW !== '1' && !env.NIKUI_ISOLATED_DEV_ROOT) return null;
  if (env.NIKUI_ISOLATED_DEV_WINDOW !== '1' || !path.isAbsolute(env.NIKUI_ISOLATED_DEV_ROOT || '') ||
      // Development hosts and extension-test hosts (--extensionTestsPath) are
      // both explicitly launched; an installed extension (Production) never is.
      ![vscode.ExtensionMode?.Development ?? 2, vscode.ExtensionMode?.Test ?? 3].includes(context.extensionMode)) {
    throw Object.assign(new Error('An isolated development extension host and explicit private root are required.'), { code: 'ISOLATED_WINDOW_REQUIRED' });
  }
  return { root: env.NIKUI_ISOLATED_DEV_ROOT };
}

function fleetPage(asset, nonce, csp, boot) {
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
    <link rel="stylesheet" href="${asset('browser.css')}"><title>NikUI development</title></head>
    <body class="home"><header class="home-head"><h1>NikUI development</h1><div id="link" role="status"></div></header>
    <p id="lede">Connecting to the isolated daemon…</p><div id="rows"></div>
    <script nonce="${nonce}">${boot}</script>
    <script nonce="${nonce}" src="${asset('transport.js')}"></script>
    <script nonce="${nonce}" src="${asset('development.js')}"></script></body></html>`;
}

/** This activation returns before any window engine/keeper/policy is built.
 * All registered administration gaps refuse visibly; they cannot accidentally
 * invoke a legacy command captured by another mode.
 */
async function activateDevelopment(context, options, { connect = openDevelopmentClient } = {}) {
  let disposed = false, available = false, main = null, statusRequested = false, fleet = { instances: [], codex: [], projects: [] };
  const links = new Set(), panels = new Map(), subscriptions = [];
  const localPending = new Map(); let selected = null, restored = null;
  const changed = new vscode.EventEmitter();
  const status = vscode.window.createStatusBarItem();
  const unavailable = (code = 'DAEMON_UNAVAILABLE') => {
    available = false; status.text = 'NikUI dev: unavailable'; status.tooltip = code + ' — no window engine was started.'; status.show();
    for (const panel of panels.values()) panel.webview.postMessage({ type: 'bridge:offline', code });
    for (const request of localPending.values()) { clearTimeout(request.timer); request.resolve({ ok: false, code: 'LOCAL_OUTCOME_UNKNOWN' }); }
    localPending.clear();
    changed.fire();
  };
  const reportGap = (command) => vscode.window.showWarningMessage(
    `NikUI isolated development: ${command} is unavailable here (P2_LOCAL_MANAGEMENT_REQUIRED).`);
  const canManage = () => available && main?.enrollment?.localManagement?.version === 1;
  function local(op, args) {
    if (!canManage()) return Promise.resolve({ ok: false, code: 'P2_LOCAL_MANAGEMENT_REQUIRED' });
    if (localPending.size >= 128) return Promise.resolve({ ok: false, code: 'LOCAL_REQUESTS_FULL' });
    const id = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { localPending.delete(id); resolve({ ok: false, code: 'LOCAL_OUTCOME_UNKNOWN' }); }, 15000);
      localPending.set(id, { resolve, timer, op });
      try { main.send({ type: 'local:request', version: 1, id, generation: main.enrollment.localManagement.generation, op, args }); }
      catch (_) { clearTimeout(timer); localPending.delete(id); resolve({ ok: false, code: 'LOCAL_OUTCOME_UNKNOWN' }); }
    });
  }
  function saveChrome() { if (canManage()) void local('client.state.save', { selected, panels: [...panels.keys()].filter((id) => id !== 'fleet') }); }
  function show(session = null) {
    if (!available) { void reportGap('daemon connection'); return null; }
    if (session) selected = session;
    const key = session || 'fleet', existing = panels.get(key);
    if (existing) { existing.reveal(); return existing; }
    const panel = vscode.window.createWebviewPanel('nikui.development', session ? 'NikUI conversation' : 'NikUI development',
      vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    panels.set(key, panel);
    const asset = (file) => String(panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', file)));
    const nonce = randomNonce(), csp = `default-src 'none'; img-src ${panel.webview.cspSource} https: data:; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${panel.webview.cspSource};`;
    const boot = 'window.NIKUI_DEV_BRIDGE=' + jsonForScript({ session, hostFingerprint: main.enrollment.hostFingerprint,
      clientKind: 'extension', version: require('../package.json').version }) + ';';
    panel.webview.html = session ? renderPage({ asset, nonce, csp, boot }) : fleetPage(asset, nonce, csp, boot);
    let link = null, opening = null, closed = false;
    subscriptions.push(panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'bridge:open') {
        if ([...fleet.instances, ...fleet.codex].some((s) => s.id === message.session)) show(message.session);
        return;
      }
      if (message?.type === 'bridge:listen') {
        if (opening) return;
        opening = connect({ root: options.root, secrets: context.secrets, target: session,
          onMessage: (m) => { if (!closed) panel.webview.postMessage(m); },
          onClose: () => { if (!closed) panel.webview.postMessage({ type: 'bridge:offline', code: 'DAEMON_UNAVAILABLE' }); }
        }).then((made) => { if (closed || disposed) made.close(); else { link = made; links.add(made); } },
          () => panel.webview.postMessage({ type: 'bridge:offline', code: 'DAEMON_UNAVAILABLE' }));
        return;
      }
      if (!link) { if (opening) await opening; }
      if (!link || closed) return;
      try { link.send(message); } catch (_) { panel.webview.postMessage({ type: 'bridge:offline', code: 'DAEMON_UNAVAILABLE' }); }
    }));
    subscriptions.push(panel.onDidDispose(() => { closed = true; panels.delete(key); if (selected === key) selected = null;
      if (link) { links.delete(link); link.close(); } saveChrome(); }));
    saveChrome();
    return panel;
  }
  const editor = createEditorHost(context, null);
  editor.switchTo = (id) => !!show(id);
  async function handle(message) {
    if (message?.type === 'local:result') {
      const pending = localPending.get(message.id);
      if (!pending || pending.op !== message.op || !matches(message, resultSchema)) return;
      localPending.delete(message.id); clearTimeout(pending.timer); pending.resolve(message); return;
    }
    if (message?.type === '@welcome') return main.send({ type: 'hello', proto: { min: 2, max: 2 },
      caps: [...CORE, 'editor-route-v1'], client: { id: crypto.randomBytes(16).toString('hex'), kind: 'extension', version: 'p1' } });
    if (message?.type === 'welcome') {
      if (message.proto !== 2 || !message.seat?.editor) { unavailable('EDITOR_ENROLLMENT_REQUIRED'); return; }
      available = true; status.text = 'NikUI dev: isolated'; status.tooltip = options.root; status.show();
      announce(); main.send({ type: 'ready' });
      if (canManage()) void local('client.state.get', {}).then((r) => { if (r.ok) { restored = r.data; restoreChrome(); } });
      return;
    }
    if (message?.type === 'fleet') { fleet = message; restoreChrome(); changed.fire(); return; }
    if (message?.type === 'status' && statusRequested) {
      statusRequested = false;
      const report = message.report;
      void vscode.window.showInformationMessage(report ? `NikUI isolated daemon: ${report.state} · generation ${report.generation} · ${report.bridge?.editors || 0} editor providers.` : 'NikUI isolated daemon status unavailable.');
      return;
    }
    if (message?.type === 'editor:request') {
      if (!available || message.origin?.editor !== main.enrollment.id || !METHODS.includes(message.method)) return;
      let result;
      try {
        const req = message.request || {}, requester = { ...message.origin, local: true, proto: 2 };
        result = await (message.method === 'openUrl' ? editor.openUrl(req.url, requester)
          : message.method === 'switchTo' ? editor.switchTo(req.id)
            : editor[message.method](req, requester));
        if (result === undefined) result = { status: 'unavailable', outcome: 'unknown' };
      } catch (_) { result = { status: 'unavailable', outcome: 'unknown' }; }
      if (!disposed && available) try { main.send({ type: 'editor:result', id: message.id, result }); } catch (_) { unavailable(); }
    }
  }
  function announce() {
    if (!main || !available) return;
    try { main.send({ type: 'editor:register', methods: METHODS,
      workspaces: (vscode.workspace.workspaceFolders || []).map((f) => String(f.uri)), focused: vscode.window.state?.focused !== false }); }
    catch (_) { unavailable(); }
  }
  function restoreChrome() {
    if (!restored || !fleet.instances.length && !fleet.codex.length) return;
    const saved = restored; restored = null;
    const ids = new Set([...fleet.instances, ...fleet.codex].map((s) => s.id));
    for (const id of saved.panels || []) if (ids.has(id)) show(id);
    if (saved.selected && ids.has(saved.selected)) show(saved.selected);
  }
  const localChrome = createDevelopmentManagement({ vscode, call: local, fleet: () => fleet, show, selected: () => selected,
    changed: () => { changed.fire(); if (available) main.send({ type: 'ready' }); }, reportGap });
  const tree = { onDidChangeTreeData: changed.event,
    getChildren: (node) => {
      if (!available) return [{ label: 'Isolated daemon unavailable' }];
      if (node?.folderNode) return fleet.instances.filter((s) => s.folder?.id === node.id);
      const folders = fleet.folders || [], placed = new Set(folders.map((f) => f.id));
      return [...folders.map((folder) => ({ id: folder.id, label: folder.name, folder, folderNode: true })),
        ...fleet.instances.filter((s) => !placed.has(s.folder?.id)), ...fleet.codex];
    },
    getTreeItem: (item) => item.folderNode ? { label: item.label, collapsibleState: 1, contextValue: 'nikuiFolder' }
      : { label: item.label || item.id, description: item.status || 'No fallback engine', contextValue: item.id?.startsWith('cx-') ? 'codex' : item.status === 'working' ? 'running' : 'idle',
        command: item.id ? { command: 'nikui.open', title: 'Open', arguments: [item] } : undefined } };
  subscriptions.push(changed, status);
  for (const id of ['nikui.sessions', 'nikui.history', 'nikui.devices']) {
    subscriptions.push(vscode.window.createTreeView(id, { treeDataProvider: id === 'nikui.sessions' ? tree : {
      onDidChangeTreeData: changed.event,
      getChildren: () => canManage() ? id === 'nikui.history' ? localChrome.history() : localChrome.devices()
        : [{ label: 'Local management parity is a P2 blocker' }], getTreeItem: (item) => item } }));
  }
  for (const { command } of require('../package.json').contributes.commands) {
    const action = localChrome.has(command) ? async (arg) => {
      if (!canManage()) return reportGap(command);
      const result = await localChrome.run(command, arg);
      if (result && !result.ok) void vscode.window.showWarningMessage('NikUI: ' + result.code);
      return result;
    } : ['nikui.newSession', 'nikui.newCodex'].includes(command) ? () => show()
      : command === 'nikui.open' ? (session) => show(session?.id || null)
        : command === 'nikui.status' ? () => { if (available) { statusRequested = true; main.send({ type: 'status' }); } else void reportGap(command); }
        : ['nikui.refresh', 'nikui.refreshCodex'].includes(command) ? () => { if (available) main.send({ type: 'ready' }); else void reportGap(command); }
          : () => reportGap(command);
    subscriptions.push(vscode.commands.registerCommand(command, action));
  }
  const runtime = { mode: 'isolated-development-client', show, manage: local, get available() { return available; },
    dispose() { if (disposed) return; disposed = true; available = false;
      for (const link of links) link.close(); links.clear(); main?.close();
      for (const p of localPending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, code: 'LOCAL_OUTCOME_UNKNOWN' }); } localPending.clear();
      for (const panel of panels.values()) panel.dispose(); panels.clear();
      for (const s of subscriptions) s?.dispose(); } };
  context.subscriptions.push(runtime);
  try {
    const pending = [];
    main = await connect({ root: options.root, secrets: context.secrets, provider: true,
      onMessage: (m) => main ? void handle(m) : pending.push(m), onClose: () => { if (!disposed) unavailable(); } });
    if (disposed) main.close(); else for (const m of pending) await handle(m);
    if (vscode.window.onDidChangeWindowState) subscriptions.push(vscode.window.onDidChangeWindowState(announce));
    if (vscode.workspace.onDidChangeWorkspaceFolders) subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(announce));
  } catch (error) { unavailable(error.code || 'DAEMON_UNAVAILABLE'); }
  return runtime;
}

module.exports = { developmentOptions, activateDevelopment };
