/* The parts of a small screen that CSS cannot reach.

   Loaded only by the pages the server serves, so nothing here can affect the
   editor's panel. Two jobs: keep the composer above the keyboard, and let the
   dashboard be swiped rather than tapped through. */
(function () {
  'use strict';

  /**
   * A phone keyboard does not resize the window — it resizes the visual
   * viewport and leaves the layout viewport where it was, which is why a
   * composer pinned to the bottom of `100vh` ends up underneath the keys.
   * The height that matters is the one the browser will actually show.
   */
  function trackViewport() {
    const viewport = window.visualViewport;
    const set = () => {
      const height = viewport ? viewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', Math.round(height) + 'px');
      // iOS scrolls the page itself to reveal the focused field; putting it
      // back is what stops the header sliding off the top.
      if (viewport && viewport.offsetTop === 0) window.scrollTo(0, 0);
    };
    set();
    if (viewport) {
      viewport.addEventListener('resize', set);
      viewport.addEventListener('scroll', set);
    }
    window.addEventListener('orientationchange', () => setTimeout(set, 120));
    window.addEventListener('resize', set);
  }

  /**
   * The dashboard's six sections, swiped. It presses the same arrow keys the
   * keyboard would, so there is one way through the sections and not two.
   */
  function swipeTheSheet() {
    const sheet = document.getElementById('status');
    if (!sheet) return;
    let x = 0;
    let y = 0;
    let tracking = false;

    sheet.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1) return;
      x = event.touches[0].clientX;
      y = event.touches[0].clientY;
      tracking = true;
    }, { passive: true });

    sheet.addEventListener('touchend', function (event) {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - x;
      const dy = touch.clientY - y;
      // A deliberate sideways move, not the tail of a scroll.
      if (Math.abs(dx) < 60 || Math.abs(dy) > 45) return;
      // Inside something that scrolls sideways on purpose — the fleet table —
      // a swipe means that table, not the section.
      if (touch.target && touch.target.closest && touch.target.closest('.grid-scroll')) return;
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: dx < 0 ? 'ArrowRight' : 'ArrowLeft', bubbles: true
      }));
    }, { passive: true });
  }

  trackViewport();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', swipeTheSheet);
  } else {
    swipeTheSheet();
  }
})();
