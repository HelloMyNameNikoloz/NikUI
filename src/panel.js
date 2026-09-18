'use strict';

const vscode = require('vscode');
const { readConfig } = require('./manager');
const { hubFor, closeHub } = require('./hub');
const { theHost } = require('./host');
const { renderPage, randomNonce } = require('./page');

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

    this.hub = hubFor(session, theHost(context, manager));
    this.hub.attach({ id: this.clientId, kind: 'webview', post: (m) => this.panel.webview.postMessage(m) });
    // The tab's title and icon follow the instance for as long as this panel is
    // one of its clients, and stop following the moment it is not.
    this.hostOff = this.hub.onHost((event) => { if (event === 'chrome') this.refreshChrome(); });
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

  /** Open the status sheet on this panel, once its webview is listening. */
  openStatus() {
    this.hub.openStatus(this.clientId);
  }

  focusInput() {
    this.hub.focusInput(this.clientId);
  }

  dispose() {
    if (this.hostOff) { this.hostOff(); this.hostOff = null; }
    if (this.hub) this.hub.detach(this.clientId);
    panels.delete(this.session.id);
    // The hub outlives this panel only while somebody else is watching.
    if (this.hub && this.hub.size === 0) closeHub(this.session.id);
    for (const d of this.disposables) { try { d.dispose(); } catch (_) { /* already gone */ } }
    this.disposables = [];
  }

  html() {
    const webview = this.panel.webview;
    const nonce = randomNonce();
    return renderPage({
      asset: (file) => String(webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file))),
      nonce,
      csp: `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; ` +
        `script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`
    });
  }
}

module.exports = { SessionPanel };
