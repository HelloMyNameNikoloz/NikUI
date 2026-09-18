'use strict';

const vscode = require('vscode');
const qr = require('./qr');
const { randomNonce } = require('./page');

/**
 * The minute in which a new device may introduce itself, on screen.
 *
 * A QR the phone's camera can open, the same code in type you can read across a
 * desk, and a countdown — because a code with no visible clock is a code you
 * will try to use after it has gone.
 */
class PairPanel {
  static show(context, pairing, server, devices) {
    if (PairPanel.current) {
      PairPanel.current.panel.reveal(undefined, false);
      PairPanel.current.restart();
      return PairPanel.current;
    }
    PairPanel.current = new PairPanel(context, pairing, server, devices);
    return PairPanel.current;
  }

  constructor(context, pairing, server, devices) {
    this.context = context;
    this.pairing = pairing;
    this.server = server;
    this.devices = devices;
    this.disposables = [];

    this.panel = vscode.window.createWebviewPanel(
      'nikui.pair', 'Pair a device', vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.stopWatchingPairing = pairing.onChange(() => this.paint());
    this.before = devices.list().length;
    // A device appearing while this is open is the success case: say so rather
    // than leaving a code on screen that has already been spent. Anything else
    // the store does — a trail entry, a last-seen — is not this panel's news,
    // and repainting for it would restart the countdown on screen.
    this.stopWatchingDevices = devices.onChange(() => {
      if (devices.list().length !== this.before) this.paint();
    });

    this.restart();
  }

  restart() {
    this.before = this.devices.list().length;
    this.pairing.start({
      host: this.server.publicHost,
      scheme: this.server.publicScheme,
      fingerprint: this.server.identity ? this.server.identity.fingerprint : null,
      laptop: laptopName()
    });
    this.paint();
  }

  paint() {
    const state = this.pairing.state();
    const paired = this.devices.list().length > this.before ? this.devices.list().slice(-1)[0] : null;
    this.panel.webview.html = this.html(state, paired);
  }

  html(state, paired) {
    const nonce = randomNonce();
    const webview = this.panel.webview;
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pairpanel.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pairpanel.js'));

    const body = paired ? this.pairedBody(paired) : state.open ? this.codeBody(state) : this.closedBody();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
<title>Pair a device</title>
</head>
<body>
${body}
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  codeBody(state) {
    const code = qr.encode(state.link);
    const svg = qr.toSvg(code);
    return `  <main class="pair">
    <h1>Pair a device</h1>
    <p class="lede">Point the camera at this, or type the code. It lasts one minute and works once.</p>
    <div class="qr-frame">
      <svg class="qr" viewBox="0 0 ${svg.span} ${svg.span}" role="img" aria-label="Pairing code">
        <rect class="qr-bg" width="${svg.span}" height="${svg.span}"></rect>
        <path class="qr-fg" d="${svg.path}"></path>
      </svg>
    </div>
    <div class="code" aria-label="Pairing code">${escapeHtml(spaced(state.code))}</div>
    <div class="countdown" id="left" data-until="${state.expiresAt}">&nbsp;</div>
    <p class="where">${escapeHtml(state.link.replace(/#.*$/, ''))}</p>
    <ul class="terms">
      <li>The device makes a key that never leaves it, and proves it on every connection.</li>
      <li>It can <strong>watch</strong> as soon as it pairs. Sending prompts is a separate grant.</li>
      <li>${state.scheme === 'https'
        ? 'This window is reachable from the tailnet, so a phone elsewhere can pair with it.'
        : 'Only this machine can reach this window. Run <strong>NikUI: Reach this window from my phone</strong> first if the device is not here.'}</li>
    </ul>
  </main>`;
  }

  pairedBody(device) {
    return `  <main class="pair done">
    <h1>${escapeHtml(device.name)} is paired</h1>
    <p class="lede">It can watch every instance in this window.</p>
    <p class="note">Sending prompts is a separate grant: a prompt from a device runs with the same
    permissions as one typed here. Grant it from the Devices list when you mean to.</p>
    <p class="key">Key ${escapeHtml(device.fingerprint || '')}</p>
  </main>`;
  }

  closedBody() {
    return `  <main class="pair done">
    <h1>That code has gone</h1>
    <p class="lede">A pairing code lasts a minute, works once, and closes on a wrong guess.</p>
    <p class="note">Run <strong>NikUI: Pair a device</strong> again for a new one.</p>
  </main>`;
  }

  dispose() {
    PairPanel.current = null;
    // Closing the window closes the window: a code left open behind a closed
    // tab is a code nobody is watching.
    this.pairing.close('panel closed');
    if (this.stopWatchingPairing) this.stopWatchingPairing();
    if (this.stopWatchingDevices) this.stopWatchingDevices();
    for (const d of this.disposables) { try { d.dispose(); } catch (_) { /* gone */ } }
    this.disposables = [];
  }
}

PairPanel.current = null;

const spaced = (code) => String(code || '').replace(/(.{4})(?=.)/g, '$1 ');
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function laptopName() {
  try { return require('os').hostname().replace(/\.local$/, ''); } catch (_) { return 'This laptop'; }
}

module.exports = { PairPanel, laptopName };
