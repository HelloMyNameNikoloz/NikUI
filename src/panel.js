'use strict';

const vscode = require('vscode');
const os = require('os');
const { readConfig } = require('./manager');

const DEFAULT_EMOJI = {
  idle: '⚪', working: '🟠', waiting: '🔴',
  done: '🟢', error: '🔴', stopped: '⚫'
};

const panels = new Map();

class SessionPanel {
  static show(session, context) {
    const existing = panels.get(session.id);
    if (existing) { existing.panel.reveal(existing.panel.viewColumn, false); return existing; }
    const created = new SessionPanel(session, context);
    panels.set(session.id, created);
    return created;
  }

  /** Rebind a panel that VS Code restored after a window reload. */
  static adopt(panel, session, context) {
    const existing = panels.get(session.id);
    if (existing) { existing.panel.dispose(); }
    const created = new SessionPanel(session, context, panel);
    panels.set(session.id, created);
    return created;
  }

  static close(sessionId) {
    const p = panels.get(sessionId);
    if (p) p.panel.dispose();
  }

  constructor(session, context, existingPanel) {
    this.session = session;
    this.context = context;
    this.disposables = [];
    this.ready = false;

    this.panel = existingPanel || vscode.window.createWebviewPanel(
      'nikui.session',
      session.label,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );

    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    };
    this.panel.webview.html = this.html();
    this.refreshChrome();

    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    const onItems = (items) => { this.post({ type: 'items', items }); this.postStats(); };
    const onStatus = (status) => { this.post({ type: 'status', status }); this.postStats(); this.refreshChrome(); };
    const onMeta = () => {
      this.post({ type: 'meta', meta: this.meta(), slashCommands: this.session.meta.slashCommands });
      this.refreshChrome();
    };
    const onReset = () => this.post({ type: 'reset' });

    session.on('items', onItems);
    session.on('status', onStatus);
    session.on('meta', onMeta);
    session.on('reset', onReset);
    this.detach = () => {
      session.off('items', onItems);
      session.off('status', onStatus);
      session.off('meta', onMeta);
      session.off('reset', onReset);
    };

    // Token counts move during a turn even when no item changes.
    this.ticker = setInterval(() => { if (this.session.isBusy) this.postStats(); }, 2000);
  }

  meta() {
    const s = this.session;
    return {
      label: s.label,
      cwd: s.cwd,
      home: os.homedir(),
      model: s.meta.model || readConfig().model || null,
      cost: s.totalCost,
      ticket: s.ticket,
      effort: s.effort || null
    };
  }

  postStats() {
    this.post({ type: 'stats', stats: this.session.stats() });
  }

  // Coloured tab icon + emoji title — status visible without opening the tab.
  refreshChrome() {
    const cfg = readConfig();
    const emoji = Object.assign({}, DEFAULT_EMOJI, cfg.statusEmoji || {});
    const glyph = emoji[this.session.status] || '';
    this.panel.title = `${glyph} ${this.session.label}`.trim();
    const icon = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'status', `${this.session.status}.svg`);
    this.panel.iconPath = { light: icon, dark: icon };
  }

  post(message) {
    if (!this.ready) return;
    this.panel.webview.postMessage(message);
  }

  async onMessage(msg) {
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        // A restored instance has no items yet; rebuild it from disk before the
        // first paint, then bring its process back with --resume.
        if (!this.session.items.length && this.session.claudeSessionId) {
          try { await this.session.replayTranscript(); } catch (_) { /* fall through empty */ }
        }
        if (!this.session.isRunning) this.session.start();
        const cfg = readConfig();
        this.panel.webview.postMessage({
          type: 'init',
          sessionId: this.session.id,
          items: this.session.items,
          meta: this.meta(),
          status: this.session.status,
          stats: this.session.stats(),
          slashCommands: this.session.meta.slashCommands || [],
          showThinking: cfg.showThinking,
          font: cfg.fontFamily || '',
          fontSize: cfg.fontSize || 13
        });
        break;
      }
      case 'send': this.session.send(msg.text, msg.attachments); break;
      case 'interrupt': this.session.interrupt(); break;
      case 'permission': {
        const item = this.session.items.find((i) => i.kind === 'permission' && i.requestId === msg.requestId);
        if (item) { item.resolved = msg.allow ? 'allow' : 'deny'; this.post({ type: 'items', items: [item] }); }
        this.session.respondToPermission(msg.requestId, msg.allow);
        break;
      }
      default: break;
    }
  }

  focusInput() { this.post({ type: 'focus' }); }

  dispose() {
    if (this.ticker) clearInterval(this.ticker);
    if (this.detach) this.detach();
    panels.delete(this.session.id);
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
    <span class="spacer"></span>
    <div class="crumbs" id="crumbs"></div>
  </header>

  <div id="transcript">
    <div class="stream" id="stream"><div class="empty">Ask Claude anything to start.</div></div>
  </div>

  <footer>
    <div class="composer-wrap">
      <button class="jump" id="jump" hidden>Jump to latest</button>
      <div class="slash" id="slash" hidden></div>
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
        <span><kbd>Esc</kbd> interrupt</span>
        <span>paste or drop an image</span>
      </div>
    </div>
  </footer>

  <div class="lightbox" id="lightbox" hidden>
    <button class="close" id="lb-close"></button>
    <img id="lb-img" alt="">
  </div>
  <input type="file" id="file" accept="image/*" multiple hidden>

  <script nonce="${nonce}" src="${media('icons.js')}"></script>
  <script nonce="${nonce}" src="${media('markdown.js')}"></script>
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
