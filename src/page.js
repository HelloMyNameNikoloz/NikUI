'use strict';

const crypto = require('crypto');

/**
 * The page, once, for every host that serves it.
 *
 * The webview and the local server hand over different URLs, a different
 * content-security policy and a different bit of bootstrap, and otherwise serve
 * byte-for-byte the same document. That is deliberate: the phone client is only
 * "the same client" for as long as there is one copy of this markup.
 */

// Order matters: every module registers itself on `window` before panel.js
// wires them together, and transport.js must exist before panel.js asks for it.
const SCRIPTS = [
  'icons.js', 'markdown.js', 'runnable.js', 'prompts.js', 'snippets.js', 'palette.js',
  'charts.js', 'status.js', 'prefs.js', 'commands.js', 'device.js', 'secure.js', 'transport.js', 'boot.js', 'panel.js'
];

/**
 * @param {object} opts
 * @param {(file: string) => string} opts.asset  URL for a file in media/
 * @param {string} opts.nonce                    the CSP nonce for every script
 * @param {string} opts.csp                      the policy itself
 * @param {string} [opts.head]                   extra <head> lines
 * @param {string} [opts.boot]                   JS run before the client loads
 */
function renderPage(opts) {
  const { asset, nonce, csp } = opts;
  const head = opts.head || '';
  const boot = opts.boot || '';
  const scripts = SCRIPTS
    .map((file) => `  <script nonce="${nonce}" src="${asset(file)}"></script>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${asset('panel.css')}">
<title>NikUI</title>
${head}</head>
<body>
  <header>
    <a class="back" id="back" href="/" aria-label="All instances" title="All instances"></a>
    <div class="title-group">
      <span id="dot" class="dot idle"></span>
      <a class="title" id="title" target="_blank" rel="noopener">Claude</a>
    </div>
    <div class="stats" id="stats"></div>
    <div class="ctx" id="ctx" hidden><div class="ctx-bar"><i></i></div><span class="ctx-label"></span></div>
    <a class="ci" id="ci" target="_blank" rel="noopener" hidden><span class="ci-bar"><i></i></span><span class="ci-label"></span></a>
    <span class="spacer"></span>
    <div class="crumbs" id="crumbs"></div>
    <div class="who" id="who" hidden></div>
    <div class="link" id="link" role="status" aria-live="polite" hidden></div>
  </header>
  <div class="shells-pop" id="shells-pop" role="dialog" aria-label="Commands running in the background" hidden></div>

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
      <div class="watching" id="watching" hidden>Watching only — this device has not been granted control.</div>
      <div class="attachments" id="attachments"></div>
      <div class="composer">
        <textarea id="input" rows="1" placeholder="Message Claude…"></textarea>
        <div class="composer-actions">
          <button class="icon-only" id="attach" title="Attach an image"></button>
          <button class="ghost" id="stop" disabled>Stop</button>
          <button id="send">Send</button>
        </div>
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
${boot ? `\n  <script nonce="${nonce}">${boot}</script>\n` : ''}
${scripts}
</body>
</html>`;
}

/**
 * A nonce for the scripts, so no page ever needs 'unsafe-inline'.
 *
 * From the cryptographic generator, never Math.random(). This value is the only
 * thing that decides whether a script on one of these pages runs, and V8's
 * Math.random is a 128-bit xorshift whose state is recoverable from a handful of
 * outputs — and these pages are served to anyone who asks for one, precisely
 * because they carry no data. Predictable here means "injected markup executes".
 */
function randomNonce() {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * JSON on its way into a <script> element.
 *
 * `JSON.stringify` escapes quotes and backslashes and nothing else, so a value
 * containing `</script>` closes the element and everything after it is markup.
 * Escaping the angle brackets — and the two line separators that are newlines
 * to a JavaScript parser but not to JSON — is what makes the value data again.
 */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Text on its way into markup, wherever this side generates any. */
const escapeHtml = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = { renderPage, randomNonce, jsonForScript, escapeHtml, SCRIPTS };
