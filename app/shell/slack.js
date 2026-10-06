/* Slack, read and replied to from the phone.

   The same chat `media/slack.js` draws in the browser panel, mounted here
   instead of there. This file is the bootstrap and nothing more: where the
   socket comes from, what a tap on a message's link should do on a phone, and
   which conversation to land on when the screen was opened by a notification.
   The conversation itself — the list, the thread, the composer — is NikSlack's
   business, the same way the transcript is the client's on every other screen.

   Reached three ways: a notification about something on Slack, the row in
   Settings, and typing `/slack` on the laptop. Never the tab bar — it is not a
   peer of Instances, Status and History, it is a place those send you. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = window.NikApp;
  const where = app.requireLaptop();
  if (!where) return;

  const root = $('slack-root');
  const link = $('link');

  // ---- where it comes from ---------------------------------------------------

  window.NIKUI_REMOTE = app.remote(null);
  const transport = window.nikTransport();

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else window.location.replace('index.html');
  }

  /**
   * A link inside a message, opened off the phone rather than inside the app.
   *
   * There is no Browser plugin here, and does not need one: a URL this WebView
   * is not allowed to load itself is exactly what Capacitor's own WebViewClient
   * hands to the system browser, so sending the page there is enough to get it
   * outside the app.
   */
  function openUrl(url) {
    window.location.href = url;
  }

  const view = window.NikSlack.mount({
    root, send: transport.postMessage, back: goBack, openUrl, compact: true
  });

  let announced = false;
  function announce() {
    if (link) { link.hidden = false; link.className = 'link'; link.textContent = 'Live'; }
    view.setConnected(true);
    if (announced) return;
    announced = true;
    // The laptop does not know this screen exists until it says so — the same
    // handshake every other screen sends its own `ready`.
    transport.postMessage({ type: 'slack:ready' });
  }

  // As on history and terminal: a socket that never answers the handshake is
  // a laptop that cannot be reached, not a screen that is still loading.
  setTimeout(() => {
    if (announced) return;
    view.setConnected(false);
    if (link) { link.hidden = false; link.className = 'link'; link.textContent = 'Cannot reach the laptop'; }
  }, 8000);

  // Opened from a notification or from Settings, a conversation is already
  // known; land on it the moment the view has something to show one in,
  // rather than racing it against the first state NikSlack draws.
  let picked = false;
  function pickStarting() {
    if (picked) return;
    const conversation = app.params().get('conversation');
    if (!conversation) { picked = true; return; }
    picked = true;
    view.select(conversation);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === '@welcome' || message.type === '@device') {
      announce();
      return;
    }
    if (message.type.indexOf('slack:') !== 0) return;
    view.receive(message);
    if (message.type === 'slack:state') pickStarting();
  });

  const back = $('back');
  if (back) back.addEventListener('click', goBack);
})();
