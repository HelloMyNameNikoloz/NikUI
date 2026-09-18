/* The countdown on the pairing window.

   A code with no visible clock is a code you will try to use ten seconds after
   it stopped working, and then wonder what you did wrong. */
(function () {
  'use strict';
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
