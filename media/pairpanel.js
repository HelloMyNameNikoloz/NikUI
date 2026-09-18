/* The countdown on the pairing window.

   A code with no visible clock is a code you will try to use ten seconds after
   it stopped working, and then wonder what you did wrong. */
(function () {
  'use strict';

  // Which of the two codes is showing. The app's is first because the app is
  // what most people are holding; a browser is one tap away for the times it
  // is not.
  const forApp = document.getElementById('for-app');
  const forBrowser = document.getElementById('for-browser');
  if (forApp && forBrowser) {
    const codes = { app: document.getElementById('qr-app'), browser: document.getElementById('qr-browser') };
    const how = document.getElementById('how');
    const words = {
      app: 'Opens NikUI on the phone, already filled in.',
      browser: 'Opens the pairing page in the phone\u2019s browser.'
    };
    const choose = (which) => {
      codes.app.hidden = which !== 'app';
      codes.browser.hidden = which !== 'browser';
      forApp.className = which === 'app' ? 'chosen' : '';
      forBrowser.className = which === 'browser' ? 'chosen' : '';
      forApp.setAttribute('aria-selected', String(which === 'app'));
      forBrowser.setAttribute('aria-selected', String(which === 'browser'));
      if (how) how.textContent = words[which];
    };
    forApp.addEventListener('click', () => choose('app'));
    forBrowser.addEventListener('click', () => choose('browser'));
  }

  const left = document.getElementById('left');
  if (!left) return;
  const until = Number(left.dataset.until || 0);

  function tick() {
    const ms = until - Date.now();
    if (ms <= 0) {
      left.textContent = 'This code has expired — run the command again.';
      left.className = 'countdown gone';
      return;
    }
    const seconds = Math.ceil(ms / 1000);
    left.textContent = seconds + (seconds === 1 ? ' second left' : ' seconds left');
    left.className = 'countdown' + (seconds <= 15 ? ' low' : '');
    setTimeout(tick, 250);
  }

  tick();
})();
