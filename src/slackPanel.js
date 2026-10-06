'use strict';

const vscode = require('vscode');
const { randomNonce } = require('./page');

/**
 * Slack, in an editor tab.
 *
 * One tab, however many times it is asked for: `/slack`, the command, and a
 * VIP who has waited a minute all bring the same one forward. When it pops up
 * on its own it opens beside what you are doing and leaves the cursor where it
 * was — a chat that steals the keyboard mid-sentence is a chat that gets the
 * sentence.
 */
class SlackPanel {
  /**
   * @param {object} context
   * @param {import('./slackRoom').SlackRoom} room
   * @param {object} [how]
   * @param {boolean} [how.quietly]   beside, without taking focus
   * @param {string} [how.conversation]  bring this one forward
   */
  static show(context, room, how) {
    const opts = how || {};
    let panel = SlackPanel.current;
    if (panel) {
      panel.panel.reveal(undefined, !!opts.quietly);
    } else {
      panel = SlackPanel.current = new SlackPanel(context, room, opts);
    }
    if (opts.conversation) panel.focus(opts.conversation);
    return panel;
  }

  constructor(context, room, opts) {
    this.context = context;
    this.room = room;
    this.disposables = [];
    this.ready = false;
    this.pending = null;

    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'nikui.slack', 'Slack',
      { viewColumn: opts.quietly ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: !!opts.quietly },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] }
    );
    this.panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    room.join(SlackPanel.ID, {
      local: true,
      control: true,
      device: null,
      // A tab that popped up beside your work has not been read yet; one you
      // have clicked into has.
      looking: () => this.panel.active && this.panel.visible
    }, (message) => this.panel.webview.postMessage(message));

    this.panel.onDidChangeViewState(() => {
      if (this.panel.active) room.looked(SlackPanel.ID);
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage((message) => {
      if (message && message.type === 'slack:ready') {
        this.ready = true;
        if (this.pending) setTimeout(() => this.focus(this.pending), 0);
      }
      room.handle(SlackPanel.ID, message).catch(() => {});
    }, null, this.disposables);

    this.panel.webview.html = this.html();
  }

  /** Select one conversation, once the page can hear it. */
  focus(conversation) {
    if (!this.ready) { this.pending = conversation; return; }
    this.pending = null;
    this.panel.webview.postMessage({ type: 'slack:focus', conversation, reason: 'popup' });
  }

  html() {
    const nonce = randomNonce();
    const webview = this.panel.webview;
    const uri = (name) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('slack.css')}">
<title>Slack</title>
</head>
<body class="slack-editor">
<div id="slack-root"></div>
<script nonce="${nonce}" src="${uri('icons.js')}"></script>
<script nonce="${nonce}" src="${uri('slack.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    SlackPanel.current = null;
    this.room.leave(SlackPanel.ID);
    for (const d of this.disposables) { try { d.dispose(); } catch (_) { /* gone */ } }
    this.disposables = [];
  }
}

SlackPanel.current = null;
SlackPanel.ID = 'editor:slack';

module.exports = { SlackPanel };
