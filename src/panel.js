'use strict';

const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { readConfig } = require('./manager');
const { hubFor, closeHub } = require('./hub');
const { transcriptPath } = require('./history');

const DEFAULT_EMOJI = {
  idle: '⚪', working: '🟠', waiting: '🔴',
  done: '🟢', error: '🔴', stopped: '⚫'
};

const panels = new Map();
let panelSeq = 0;

/**
 * The VS Code end of an instance: a webview panel, its tab chrome, and the
 * editor-only actions a client can ask for. Everything about the conversation
 * itself lives in the hub, where a second client — a phone, a test — joins on
 * exactly the same terms.
 */
class SessionPanel {
  static show(session, context, manager) {
    const existing = panels.get(session.id);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      // Revealing an existing tab is a selection too. The view-state event says
      // so as well, but only the editor can fire that — anything that opens an
      // instance should not have to hope it arrives.
      if (manager) manager.focus(session);
      return existing;
    }
    const created = new SessionPanel(session, context, undefined, manager);
    panels.set(session.id, created);
    return created;
  }

  /** Rebind a panel that VS Code restored after a window reload. */
  static adopt(panel, session, context, manager) {
    const existing = panels.get(session.id);
    if (existing) { existing.panel.dispose(); }
    const created = new SessionPanel(session, context, panel, manager);
    panels.set(session.id, created);
    return created;
  }

  static close(sessionId) {
    const p = panels.get(sessionId);
    if (p) p.panel.dispose();
  }

  /** Whether the user can already see this instance, and so needs no telling. */
  static isVisible(sessionId) {
    const p = panels.get(sessionId);
    return !!(p && p.panel && p.panel.visible);
  }

  constructor(session, context, existingPanel, manager) {
    this.manager = manager || null;
    this.session = session;
    this.context = context;
    this.disposables = [];
    this.clientId = 'panel-' + (panelSeq++);

    // A hidden panel is rebuilt from the instance when it comes back — the
    // conversation lives in the session, not in the webview — so holding every
    // hidden webview in memory buys a little speed for a lot of RAM. The draft
    // and the scroll position survive through the webview's own state.
    this.panel = existingPanel || vscode.window.createWebviewPanel(
      'nikui.session',
      session.label,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: !!readConfig().keepPanelsWarm,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );

    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    };
    this.panel.webview.html = this.html();

    this.hub = hubFor(session, this.hostDeps());
    this.hub.attach({ id: this.clientId, kind: 'webview', post: (m) => this.panel.webview.postMessage(m) });
    this.refreshChrome();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.hub.receive(this.clientId, msg), null, this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Bringing a tab forward is a selection too, so the sidebar follows it.
    if (this.panel.onDidChangeViewState) {
      this.panel.onDidChangeViewState((e) => {
        const live = e && e.webviewPanel ? e.webviewPanel : this.panel;
        if (live.active && this.manager) this.manager.focus(this.session);
      }, null, this.disposables);
    }
    if (this.manager && this.panel.active === true) this.manager.focus(this.session);
  }

  /**
   * The parts of the picture only the editor can supply. Handed to the hub so
   * it never has to know what VS Code is.
   */
  hostDeps() {
    return {
      config: () => readConfig(),
      home: os.homedir(),
      knownCommands: () => (this.manager ? this.manager.knownCommands() : []),
      fleet: () => (this.manager ? this.manager.list : [this.session]),
      env: (session) => this.env(session),
      openFile: (req) => this.openFile(req),
      switchTo: (id, from) => this.switchTo(id, from),
      onHostEvent: (event) => { if (event === 'chrome') this.refreshChrome(); }
    };
  }

  /** What the status report can only learn from the editor and the machine. */
  env(session) {
    const cfg = readConfig();
    return {
      transcriptPath: transcriptPath(session.cwd, session.claudeSessionId),
      limits: (this.manager && this.manager.limits) || session.limits || null,
      pause: (this.manager && this.manager.pause) || null,
      vscode: vscode.version,
      node: process.versions.node,
      electron: process.versions.electron || null,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1073741824),
      extension: this.context.extension ? this.context.extension.packageJSON.version : null,
      home: os.homedir(),
      showThinking: cfg.showThinking,
      groupByProject: vscode.workspace.getConfiguration('nikui').get('groupByProject', 'auto')
    };
  }

  // Coloured tab icon + emoji title — status visible without opening the tab.
  refreshChrome() {
    const cfg = readConfig();
    const emoji = Object.assign({}, DEFAULT_EMOJI, cfg.statusEmoji || {});
    const glyph = emoji[this.session.status] || '';
    const name = this.manager && this.manager.displayName
      ? this.manager.displayName(this.session) : this.session.label;
    this.panel.title = `${glyph} ${name}`.trim();
    const icon = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'status', `${this.session.status}.svg`);
    this.panel.iconPath = { light: icon, dark: icon };
  }

  /** Jump to another instance straight from the fleet table. */
  switchTo(id) {
    if (!this.manager || !id) return;
    const target = this.manager.get(id);
    if (!target || target.id === this.session.id) return;
    SessionPanel.show(target, this.context, this.manager).focusInput();
  }

  /** Open a path the model mentioned, resolved against the instance's folder. */
  async openFile(req) {
    const raw = String((req && req.path) || '').trim();
    if (!raw) return;
    const abs = path.isAbsolute(raw) ? raw : path.join((req && req.cwd) || this.session.cwd || '', raw);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      const line = Math.max(0, (Number(req && req.line) || 1) - 1);
      const at = new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(doc, { selection: at, preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (_) {
      vscode.window.setStatusBarMessage('NikUI: could not open ' + raw, 3000);
    }
  }

  /** Open the status sheet on this panel, once its webview is listening. */
  openStatus() {
    this.hub.openStatus(this.clientId);
  }

  focusInput() {
    this.hub.focusInput(this.clientId);
  }

  dispose() {
    if (this.hub) this.hub.detach(this.clientId);
    panels.delete(this.session.id);
    // The hub outlives this panel only while somebody else is watching.
    if (this.hub && this.hub.size === 0) closeHub(this.session.id);
    for (const d of this.disposables) { try { d.dispose(); } catch (_) { /* already gone */ } }
    this.disposables = [];
  }

  html() {
    const webview = this.panel.webview;
    const media = (file) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    const nonce = randomNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${media('panel.css')}">
<title>NikUI</title>
</head>
<body>
  <header>
    <div class="title-group">
      <span id="dot" class="dot idle"></span>
      <span class="title" id="title">Claude</span>
    </div>
    <div class="stats" id="stats"></div>
    <div class="ctx" id="ctx" hidden><div class="ctx-bar"><i></i></div><span class="ctx-label"></span></div>
    <span class="spacer"></span>
    <div class="crumbs" id="crumbs"></div>
  </header>

  <div class="find" id="find" hidden>
    <input id="find-input" type="text" placeholder="Find in this conversation" aria-label="Find in this conversation">
    <span class="find-count" id="find-count">0 of 0</span>
    <button class="icon-only" id="find-prev" title="Previous match (Shift+Enter)">↑</button>
    <button class="icon-only" id="find-next" title="Next match (Enter)">↓</button>
    <button class="icon-only" id="find-close" title="Close (Esc)">✕</button>
    <span class="find-note" id="find-note" hidden></span>
  </div>

  <div id="transcript">
    <div class="stream" id="stream"><div class="empty">Ask Claude anything to start.</div></div>
  </div>

  <footer>
    <div class="composer-wrap">
      <button class="jump" id="jump" hidden>Jump to latest</button>
      <div class="esc-hint" id="esc-hint" hidden>Press <kbd>Esc</kbd> again to interrupt this turn</div>
      <div class="slash" id="slash" hidden></div>
      <div class="queue" id="queue" hidden></div>
      <div class="attachments" id="attachments"></div>
      <div class="composer">
        <textarea id="input" rows="1" placeholder="Message Claude…"></textarea>
        <button class="icon-only" id="attach" title="Attach an image"></button>
        <button class="ghost" id="stop" disabled>Stop</button>
        <button id="send">Send</button>
      </div>
      <div class="hint">
        <span><kbd>Enter</kbd> send</span>
        <span><kbd>Shift</kbd>+<kbd>Enter</kbd> newline</span>
        <span><kbd>/</kbd> commands</span>
        <span><kbd>↑</kbd> previous prompt</span>
        <span><kbd>/status</kbd> dashboard</span>
        <span><kbd>⌘F</kbd> find</span>
        <span><kbd>Esc</kbd> <kbd>Esc</kbd> interrupt</span>
        <span>send while busy to queue</span>
        <span>paste or drop an image</span>
      </div>
    </div>
  </footer>

  <div class="sheet" id="status" role="dialog" aria-modal="true" aria-labelledby="sheet-title" hidden></div>
  <div class="tip" id="tip" hidden></div>

  <div class="lightbox" id="lightbox" hidden>
    <button class="close" id="lb-close"></button>
    <img id="lb-img" alt="">
  </div>
  <input type="file" id="file" accept="image/*" multiple hidden>

  <script nonce="${nonce}" src="${media('icons.js')}"></script>
  <script nonce="${nonce}" src="${media('markdown.js')}"></script>
  <script nonce="${nonce}" src="${media('prompts.js')}"></script>
  <script nonce="${nonce}" src="${media('snippets.js')}"></script>
  <script nonce="${nonce}" src="${media('charts.js')}"></script>
  <script nonce="${nonce}" src="${media('status.js')}"></script>
  <script nonce="${nonce}" src="${media('boot.js')}"></script>
  <script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}

function randomNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

module.exports = { SessionPanel };
