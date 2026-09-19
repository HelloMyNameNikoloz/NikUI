'use strict';

const vscode = require('vscode');
const qr = require('./qr');
const { randomNonce, escapeHtml } = require('./page');

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

  /** One QR, drawn from whatever it is asked to carry. */
  qrFor(link, name, hidden) {
    const svg = qr.toSvg(qr.encode(link));
    return `      <svg class="qr" id="qr-${name}" viewBox="0 0 ${svg.span} ${svg.span}"
           role="img" aria-label="Pairing code"${hidden ? ' hidden' : ''}>
        <rect class="qr-bg" width="${svg.span}" height="${svg.span}"></rect>
        <path class="qr-fg" d="${svg.path}"></path>
      </svg>`;
  }

  codeBody(state) {
    // Two invitations to the same pairing: one a phone's camera hands to the
    // app, one it hands to a browser. Both are drawn now and one is shown,
    // because swapping them is a tap rather than a round trip.
    // A code that names 127.0.0.1 cannot be used by anything that is not this
    // machine, and the way that fails on a phone is "failed to fetch" — which
    // says nothing. So it is said here, before anybody points a camera at it.
    const onlyHere = /^(127\.0\.0\.1|localhost|\[?::1\]?)(:|$)/.test(String(state.host || ''));
    return `  <main class="pair">
    <h1>Pair a device</h1>
    <p class="lede">Point your phone's camera at this. It lasts one minute and works once.</p>
${onlyHere ? `    <p class="warn" role="alert"><strong>This code only works on this machine.</strong>
      It points at ${escapeHtml(String(state.host || '127.0.0.1'))}, which a phone cannot reach.
      Run <strong>NikUI: Reach this window from my phone</strong> and pair again.</p>` : ''}
    <div class="choose" role="tablist" aria-label="What is scanning this">
      <button class="chosen" id="for-app" role="tab" aria-selected="true">The app</button>
      <button id="for-browser" role="tab" aria-selected="false">A browser</button>
    </div>
    <div class="qr-frame">
${this.qrFor(state.appLink || state.link, 'app', false)}
${this.qrFor(state.link, 'browser', true)}
    </div>
    <p class="how" id="how">Opens NikUI on the phone, already filled in.</p>
    <div class="code" aria-label="Pairing code">${escapeHtml(spaced(state.code))}</div>
    <div class="countdown" id="left" data-until="${state.expiresAt}">&nbsp;</div>
    <p class="where">${escapeHtml(state.link.replace(/#.*$/, ''))}</p>
    <ul class="terms">
      <li>The device makes a key that never leaves it, and proves it on every connection.</li>
      <li>It can <strong>watch</strong> as soon as it pairs. Sending prompts is a separate grant.</li>
      <li>${onlyHere
        ? 'Only this machine can reach this window right now.'
        : 'This window is reachable from your tailnet, so a phone elsewhere can pair with it.'}</li>
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

function laptopName() {
  try { return require('os').hostname().replace(/\.local$/, ''); } catch (_) { return 'This laptop'; }
}

module.exports = { PairPanel, laptopName };
