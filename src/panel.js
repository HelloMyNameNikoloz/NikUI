'use strict';

const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { readConfig } = require('./manager');
const { commandArgs } = require('./session');
const { buildReport } = require('./report');
const { transcriptPath } = require('./history');

const DEFAULT_EMOJI = {
  idle: '⚪', working: '🟠', waiting: '🔴',
  done: '🟢', error: '🔴', stopped: '⚫'
};

// Commands the panel answers itself rather than passing to the CLI.
const OWN_COMMANDS = ['status'];

const panels = new Map();

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
    this.ready = false;
    this.pendingStatus = false;
    // While the status sheet is open it has to keep up with the instance it is
    // describing; throttled, because a streaming turn changes constantly.
    this.statusOpen = false;
    this.statusTimer = null;

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
    this.refreshChrome();

    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Bringing a tab forward is a selection too, so the sidebar follows it.
    if (this.panel.onDidChangeViewState) {
      this.panel.onDidChangeViewState((e) => {
        const live = e && e.webviewPanel ? e.webviewPanel : this.panel;
        if (live.active && this.manager) this.manager.focus(this.session);
      }, null, this.disposables);
    }
    if (this.manager && this.panel.active === true) this.manager.focus(this.session);

    const onItems = (items) => { this.post({ type: 'items', items }); this.postStats(); this.refreshStatus(); };
    const onStatus = (status) => {
      this.post({ type: 'status', status });
      this.postStats();
      this.refreshChrome();
      this.refreshStatus();
    };
    const onMeta = () => {
      this.post({
        type: 'meta', meta: this.meta(), slashCommands: this.commandList(),
        commandArgs: commandArgs(), ownCommands: OWN_COMMANDS
      });
      this.refreshChrome();
    };
    const onReset = () => this.post({ type: 'reset' });
    const onQueue = () => { this.postQueue(); this.refreshStatus(); };

    session.on('items', onItems);
    session.on('status', onStatus);
    session.on('meta', onMeta);
    session.on('reset', onReset);
    session.on('queue', onQueue);
    this.detach = () => {
      session.off('queue', onQueue);
      session.off('items', onItems);
      session.off('status', onStatus);
      session.off('meta', onMeta);
      session.off('reset', onReset);
    };

    // Token counts move during a turn even when no item changes.
    this.ticker = setInterval(() => {
      if (!this.session.isBusy) return;
      this.postStats();
      this.refreshStatus();
    }, 2000);
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
      effort: s.effort || null,
      // Bypassing permissions means every tool runs without asking. That is the
      // default here, so it has to be visible in the panel, not buried in
      // settings — see the chip in the header.
      permissionMode: s.permissionMode || null
    };
  }

  /**
   * The session's own list once it has one, otherwise the remembered list —
   * plus the commands NikUI answers itself, which the CLI has no reason to
   * mention and which would otherwise never appear when you type "/".
   */
  commandList() {
    const live = this.session.meta.slashCommands;
    const base = (live && live.length) ? live : (this.manager ? this.manager.knownCommands() : []);
    const merged = base.slice();
    for (const own of OWN_COMMANDS) if (!merged.includes(own)) merged.push(own);
    return merged;
  }

  postQueue() {
    this.post({
      type: 'queue',
      queue: this.session.queue.map((q) => ({ id: q.id, text: q.text, images: q.attachments.length })),
      drainAt: this.session.drainAt || null
    });
  }

  postStats() {
    this.post({ type: 'stats', stats: this.session.stats() });
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
          // Older items were dropped from memory on purpose; the panel says so
          // instead of pretending the conversation began where it does.
          dropped: this.session.droppedItems || 0,
          maxItems: this.session.maxItems || 0,
          meta: this.meta(),
          status: this.session.status,
          stats: this.session.stats(),
          queue: this.session.queue.map((q) => ({ id: q.id, text: q.text, images: q.attachments.length })),
          drainAt: this.session.drainAt || null,
          slashCommands: this.commandList(),
          commandArgs: commandArgs(),
          ownCommands: OWN_COMMANDS,
          showThinking: cfg.showThinking,
          singleEscape: !!cfg.interruptOnSingleEscape,
          font: cfg.fontFamily || '',
          fontSize: cfg.fontSize || 13
        });
        if (this.pendingStatus) { this.pendingStatus = false; this.openStatus(); }
        break;
      }
      case 'send': this.session.submit(msg.text, msg.attachments); break;
      case 'status': this.postStatus(); break;
      case 'statusOpen':
        this.statusOpen = !!msg.open;
        if (!this.statusOpen && this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
        break;
      case 'switch': this.switchTo(msg.id); break;
      case 'unqueue': this.session.unqueue(msg.id); break;
      case 'promoteQueued': this.session.promote(msg.id); break;
      case 'editQueued': {
        const item = this.session.reclaim(msg.id);
        if (item) this.post({ type: 'editPrompt', text: item.text || '' });
        break;
      }
      case 'clearQueue': this.session.clearQueue(); break;
      case 'openFile': await this.openFile(msg); break;
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

  /**
   * Everything /status draws, gathered at the moment it is asked for. The
   * facts only the host knows — the transcript on disk, the other instances,
   * the editor itself — are handed to the builder; it derives the rest.
   */
  postStatus() {
    const cfg = readConfig();
    const report = buildReport({
      session: this.session,
      fleet: this.manager ? this.manager.list : [this.session],
      env: {
        transcriptPath: transcriptPath(this.session.cwd, this.session.claudeSessionId),
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
      }
    });
    this.post({ type: 'statusReport', report });
  }

  /**
   * Redraw the open sheet, at most once every second and a half. A sheet that
   * quietly goes stale while a turn runs is worse than no sheet: every number
   * on it is the sort of thing people read once and trust.
   */
  refreshStatus() {
    if (!this.statusOpen || this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (this.statusOpen) this.postStatus();
    }, 1500);
  }

  /** Jump to another instance straight from the fleet table. */
  switchTo(id) {
    if (!this.manager || !id) return;
    const target = this.manager.get(id);
    if (!target || target.id === this.session.id) return;
    SessionPanel.show(target, this.context, this.manager).focusInput();
  }

  /**
   * Called for a panel that may have just been created, so the request waits
   * for the webview to say hello rather than being posted into the void.
   */
  openStatus() {
    if (!this.ready) { this.pendingStatus = true; return; }
    this.statusOpen = true;
    this.post({ type: 'openStatus' });
    this.postStatus();
  }

  /** Open a path the model mentioned, resolved against the instance's folder. */
  async openFile(msg) {
    const raw = String(msg.path || '').trim();
    if (!raw) return;
    const abs = path.isAbsolute(raw) ? raw : path.join(this.session.cwd || '', raw);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      const line = Math.max(0, (Number(msg.line) || 1) - 1);
      const at = new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(doc, { selection: at, preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (_) {
      vscode.window.setStatusBarMessage('NikUI: could not open ' + raw, 3000);
    }
  }

  focusInput() { this.post({ type: 'focus' }); }

  dispose() {
    if (this.ticker) clearInterval(this.ticker);
    if (this.statusTimer) clearTimeout(this.statusTimer);
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
