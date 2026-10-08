/* Pull to refresh, shared by every screen that has something to refresh.

   One rubber band, one spinner, one place that understands touch versus a
   scroll: a list at the top of its scroll, pulled down, drags a spinner with
   it and snaps to "release to refresh" at about 70 points. Let go past that
   and the screen's own refresh runs — the same retry a button already offers
   on each of these screens, just reached without lifting a thumb to find one.
   Let go short of it and it springs back having done nothing, which is the
   whole of the gesture everybody already knows from Mail.

   Touch only, and passive wherever the gesture allows it: this never competes
   with the horizontal swipe between tabs, because it only ever answers to a
   vertical pull starting at the very top of the list. */
(function () {
  'use strict';

  const THRESHOLD = 70;
  const MAX = 110;

  /**
   * `scrollHost` is the scrolling element a pull starts in (it must be at
   * `scrollTop === 0` for a pull to begin); `onRefresh` is called once per
   * pull that clears the threshold and may return a promise — the spinner
   * keeps turning until it settles, rather than guessing how long a refresh
   * takes.
   */
  function attach(scrollHost, onRefresh) {
    if (!scrollHost || scrollHost.__nikPull) return;
    scrollHost.__nikPull = true;

    const spinner = document.createElement('div');
    spinner.className = 'pull-spinner';
    spinner.innerHTML = '<span class="pull-spin"></span>';
    scrollHost.insertBefore(spinner, scrollHost.firstChild);
    scrollHost.classList.add('pull-host');

    let startY = 0;
    let pulling = false;
    let dragging = false;
    let busy = false;

    const setPull = (amount) => {
      const clamped = Math.max(0, Math.min(MAX, amount));
      spinner.style.transform = 'translateY(' + clamped + 'px)';
      spinner.style.opacity = String(Math.min(1, clamped / THRESHOLD));
      spinner.classList.toggle('ready', clamped >= THRESHOLD);
    };

    // Passive: nothing here ever calls preventDefault, so the browser is free
    // to start scrolling immediately rather than waiting to find out.
    scrollHost.addEventListener('touchstart', (event) => {
      if (busy || scrollHost.scrollTop > 0 || !event.touches.length) { pulling = false; return; }
      pulling = true;
      dragging = false;
      startY = event.touches[0].clientY;
    }, { passive: true });

    scrollHost.addEventListener('touchmove', (event) => {
      if (!pulling || !event.touches.length) return;
      const dy = event.touches[0].clientY - startY;
      if (dy <= 0 || scrollHost.scrollTop > 0) { pulling = false; setPull(0); return; }
      dragging = true;
      // Rubber band: the further it is pulled, the less each extra pixel
      // moves it — the same curve the strip's own pill borrows the feel of.
      setPull(Math.pow(dy, 0.72) * 2.4);
    }, { passive: true });

    const release = () => {
      if (!pulling) return;
      pulling = false;
      const ready = dragging && spinner.classList.contains('ready');
      if (!ready) {
        // Let go short of the threshold: it springs back, rather than
        // vanishing, which is the one bit of this that needs a transition —
        // every frame while a finger is still moving it does not.
        spinner.classList.add('snap');
        setPull(0);
        setTimeout(() => spinner.classList.remove('snap'), 220);
        return;
      }
      busy = true;
      spinner.classList.add('spinning');
      if (window.NikHaptic) window.NikHaptic('medium');
      const done = () => {
        busy = false;
        spinner.classList.add('snap');
        spinner.classList.remove('spinning', 'ready');
        setPull(0);
        setTimeout(() => spinner.classList.remove('snap'), 220);
      };
      let result = null;
      try { result = onRefresh(); } catch (_) { /* a refresh that throws still has to let go */ }
      if (result && typeof result.then === 'function') result.then(done, done);
      else setTimeout(done, 600);
    };

    scrollHost.addEventListener('touchend', release, { passive: true });
    scrollHost.addEventListener('touchcancel', release, { passive: true });
  }

  window.NikPull = { attach };
})();
