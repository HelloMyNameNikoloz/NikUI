/* The app around the client.

   Three jobs, and deliberately no more: remember which laptop this device is
   paired with, hand that to the client the editor also runs, and move between
   screens. Everything about conversations, instances, queues and the dashboard
   is the client's business and is not repeated here — that is the whole reason
   the app is a shell.

   Loaded synchronously and before anything else, because the client reads
   `window.NIKUI_REMOTE` the moment it starts. */
(function () {
  'use strict';

  const STORE = 'nikui.app.laptop';
  const PREFS = 'nikui.app.prefs';

  const native = () => (window.Capacitor && window.Capacitor.Plugins) || null;

  /** Anything that must survive the app being closed. */
  function read(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }

  function write(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) { /* a device with no storage cannot be paired anyway */ }
    // Mirrored into native preferences so a backup, a restore or a WebView
    // reset does not silently lose the pairing. localStorage stays the source
    // of truth because the client reads it synchronously at startup.
    const plugins = native();
    if (plugins && plugins.Preferences) {
      const call = value === null
        ? plugins.Preferences.remove({ key })
        : plugins.Preferences.set({ key, value: JSON.stringify(value) });
      if (call && call.catch) call.catch(() => {});
    }
  }

  /**
   * The laptop this device is paired with.
   *
   * `host` is a name on the tailnet, not an address: the whole point of the
   * mesh is that the address moves and the name does not.
   */
  function laptop() {
    const saved = read(STORE, null);
    if (!saved || !saved.host) return null;
    return {
      host: String(saved.host),
      scheme: saved.scheme === 'http' ? 'http' : 'https',
      name: saved.name || saved.host,
      fingerprint: saved.fingerprint || null,
      pairedAt: saved.pairedAt || null
    };
  }

  function remember(connection) {
    write(STORE, Object.assign({ pairedAt: Date.now() }, connection));
  }

  /** Forget the laptop, and with it the reason this device could reach it. */
  function forget() {
    write(STORE, null);
    if (window.nikDevice && window.nikDevice.forget) {
      const done = window.nikDevice.forget();
      if (done && done.catch) done.catch(() => {});
    }
  }

  function prefs() {
    return Object.assign({ textSize: 'medium' }, read(PREFS, {}));
  }

  function setPref(key, value) {
    const next = prefs();
    next[key] = value;
    write(PREFS, next);
    applyPrefs(next);
    return next;
  }

  /** The few things the reader can change about how this looks. */
  function applyPrefs(current) {
    const p = current || prefs();
    const sizes = { small: 14, medium: 16, large: 18.5 };
    const size = sizes[p.textSize] || sizes.medium;
    document.documentElement.style.setProperty('--nik-font-size', size + 'px');
    document.documentElement.style.fontSize = size + 'px';
  }

  const origin = (where) => (where ? where.scheme + '://' + where.host : null);

  /**
   * What the client needs to know about where it is.
   *
   * In a browser the client learned this from the page's own address. In the
   * app there is no such address — the page came from the bundle — so it is
   * handed over explicitly, and every URL the client builds is absolute.
   */
  function remote(sessionId) {
    const where = laptop();
    if (!where) return null;
    const base = origin(where);
    return {
      session: sessionId || null,
      origin: base,
      socket: base.replace(/^http/, 'ws') + '/socket' +
        (sessionId ? '?session=' + encodeURIComponent(sessionId) : ''),
      // Where a client should go when it is told to open another instance.
      conversation: 'conversation.html?session=',
      app: true
    };
  }

  const params = () => new URLSearchParams(window.location.search);

  const NAV_DIR = 'nikui.app.navdir';

  /**
   * How the screen that is about to load should look like it arrived:
   * pushed in from the right ('forward'), undoing that ('back'), or a
   * crossfade between peers ('tab'). Each screen here is its own document, so
   * there is no way to ask the next one anything once this one has gone —
   * the only thing that survives the navigation is `sessionStorage`, read
   * back on `pagereveal` in `wireTransitions` below.
   */
  function setNavDirection(dir) {
    try { window.sessionStorage.setItem(NAV_DIR, dir); } catch (_) { /* no storage, no transition */ }
  }

  function go(page, query, dir) {
    setNavDirection(dir || 'forward');
    const search = query ? '?' + new URLSearchParams(query).toString() : '';
    window.location.assign(page + search);
  }

  /** Every screen but the way in needs a laptop; send them there if there isn't one. */
  function requireLaptop() {
    const where = laptop();
    if (!where) {
      window.location.replace('connect.html');
      return null;
    }
    return where;
  }

  let versionCache = null;
  function version() {
    if (versionCache) return Promise.resolve(versionCache);
    return fetch('version.json')
      .then((r) => r.json())
      .then((v) => { versionCache = v; return v; })
      .catch(() => ({ client: 'unknown', app: 'unknown' }));
  }

  // ---- native edges --------------------------------------------------------

  /**
   * The app's own chrome, on whichever screen has it: the way to settings, the
   * way back, and the rule that no screen but the way in works without a
   * laptop to talk to.
   */
  function wireChrome() {
    tabs();
    swipeScreens();
    wireTransitions();

    // The client's own back link points at the server's root; in a bundle the
    // fleet is a page rather than a path.
    const back = document.getElementById('back');
    if (back && back.tagName === 'A') back.setAttribute('href', 'index.html');

    // Anything that reads as "go back" — a chevron button, a link to the
    // fleet — says so before the navigation happens, in the one place that
    // still exists to say it in: this is a capture listener so it runs ahead
    // of the browser's own handling of the click, including the default
    // navigation an anchor is about to do.
    document.addEventListener('click', (event) => {
      if (event.target.closest('.back, #back, a[href="index.html"]')) setNavDirection('back');
    }, true);

    const onWayIn = /connect\.html$/.test(window.location.pathname);
    if (!onWayIn && !laptop()) window.location.replace('connect.html');
  }

  /**
   * Forward slides in, back slides out the same way in reverse, and a tab
   * switch crossfades rather than either — the direction is decided before
   * the page unloads (`go`, the back-link listener above, the back gesture
   * below) and read back here, on `pagereveal`, which fires on the document
   * that is arriving at the moment the browser is deciding how to animate the
   * crossing it is already doing because of `@view-transition` in app.css.
   *
   * Nothing here is required for the transition to happen at all — that is
   * the stylesheet's doing, and a WebView too old to fire `pagereveal` is a
   * WebView too old to animate the crossing either, so there is nothing to
   * mis-set the direction of.
   */
  function wireTransitions() {
    if (!('onpagereveal' in window)) return;
    window.addEventListener('pagereveal', (event) => {
      if (!event.viewTransition) return;
      let dir = 'forward';
      try { dir = window.sessionStorage.getItem(NAV_DIR) || 'forward'; } catch (_) { /* default stands */ }
      try { window.sessionStorage.removeItem(NAV_DIR); } catch (_) { /* nothing to clean up */ }
      document.documentElement.classList.toggle('nav-back', dir === 'back');
      document.documentElement.classList.toggle('nav-tab', dir === 'tab');
      try { event.viewTransition.types.add(dir); } catch (_) { /* types is newer than the rest of this */ }
    });
  }

  // The three screens that are peers rather than a hierarchy: what is running,
  // what has run, and how this is set up. A tab bar says that in a way a pair
  // of icons crowded into a title bar cannot, and puts all three where a thumb
  // already is.
  // Instances gives up the >_ now that there is a real terminal to wear it: a
  // chip is what a fleet of them looks like, and two tabs with the same glyph
  // is a tab bar you have to read rather than glance at.
  const TABS = [
    { page: 'index.html', label: 'Instances', icon: 'cpu' },
    { page: 'status.html', label: 'Status', icon: 'activity' },
    { page: 'terminal.html', label: 'Terminal', icon: 'terminal' },
    { page: 'history.html', label: 'History', icon: 'history' },
    { page: 'settings.html', label: 'Settings', icon: 'settings' },
    { page: 'slack.html', label: 'Slack', icon: 'message' }
  ];

  function tabs() {
    const host = document.getElementById('tabs');
    if (!host) return;
    const here = (window.location.pathname.split('/').pop() || 'index.html');
    let at = TABS.findIndex((t) => t.page === here);
    if (at < 0) at = 0;

    // The selected tab is a glass capsule of its own, sitting inside the strip
    // — the thing iOS 26 morphs from one tab to the next rather than redrawing.
    // It is a sibling of the buttons rather than a background on one, because
    // it has to be able to move independently of both.
    const pill = document.createElement('span');
    pill.className = 'tab-pill';
    pill.setAttribute('aria-hidden', 'true');
    host.appendChild(pill);

    const buttons = [];
    for (const tab of TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tab' + (tab.page === here ? ' here' : '');
      button.setAttribute('aria-label', tab.label);
      if (tab.page === here) button.setAttribute('aria-current', 'page');
      // The product's own icon set, so nothing here is a second vocabulary.
      if (window.icon) {
        const art = document.createElement('span');
        art.className = 'tab-icon';
        art.innerHTML = window.icon(tab.icon, 22);
        button.appendChild(art);
      }
      const words = document.createElement('span');
      words.className = 'tab-label';
      words.textContent = tab.label;
      button.appendChild(words);
      host.appendChild(button);
      buttons.push(button);
    }

    slide(host, pill, buttons, at);
  }

  /**
   * The capsule, and the finger that can drag it.
   *
   * Tapping a tab is the ordinary way through, and it still is. But a strip of
   * three things with a shape sitting on one of them invites being pushed, and
   * on a phone the best control is the one that does what you tried. So the
   * capsule follows a finger across the strip, the tab under it lights up as
   * you pass, and letting go both settles it and goes there.
   *
   * The page changes on release rather than while dragging: every screen here
   * is its own document, and navigating mid-gesture would tear the thing you
   * are holding out from under you.
   */
  function slide(host, pill, buttons, startAt) {
    const count = buttons.length;
    let at = startAt;

    // Where the capsule is and how fast, in pixels and pixels per millisecond.
    // A CSS transition cannot do this: it has a duration and an easing curve,
    // and what Apple's glass has is momentum — throw it and it carries, with
    // the shape stretching while it travels and springing back when it lands.
    let x = 0;
    let v = 0;
    let target = 0;
    let dragging = false;
    let frame = null;
    let moved = false;
    let arrive = null;

    const span = () => host.getBoundingClientRect().width / count;
    const clamp = (value) => Math.max(0, Math.min((count - 1) * span(), value));

    /**
     * Gel, in two numbers.
     *
     * Apple's own words for this material are "gel-like flexibility" and that
     * elements "stretch, bounce, and morph"; its sliders "preserve momentum and
     * stretch when they are moved". A thing made of liquid that is pushed
     * lengthens along the push and thins across it — the volume has to go
     * somewhere — and thickens optically as it does.
     */
    const paint = () => {
      // Subtle. Photos does not fling its capsule across the bar; it gives a
      // little and springs back, and anything more reads as a bug.
      const stretch = Math.max(-0.14, Math.min(0.14, v / 5200));
      const pull = Math.abs(stretch);
      pill.style.transform =
        'translate3d(' + x.toFixed(2) + 'px, 0, 0)' +
        ' scaleX(' + (1 + pull).toFixed(4) + ')' +
        ' scaleY(' + (1 - pull * 0.55).toFixed(4) + ')';
      // Which way it is leaning, for the highlight that lags behind it.
      pill.style.setProperty('--drift', (stretch / 0.14).toFixed(3));
      // "When glass flexes and morphs to larger sizes, its material
      // characteristics change to simulate a thicker, more substantial
      // material." So it does.
      pill.style.setProperty('--thick', pull.toFixed(3));
      tint();
    };

    /**
     * How much of each tab the capsule is over.
     *
     * Not a threshold: as it crosses a tab it takes its colour by degrees, so
     * halfway across two tabs are half lit. That is the difference between
     * something sliding under a light and something switching on when it
     * arrives.
     */
    function tint() {
      const glass = pill.getBoundingClientRect();
      for (let i = 0; i < count; i++) {
        const box = buttons[i].getBoundingClientRect();
        const over = Math.max(0, Math.min(glass.right, box.right) - Math.max(glass.left, box.left));
        const lit = box.width ? Math.max(0, Math.min(1, over / box.width)) : 0;
        buttons[i].style.setProperty('--lit', lit.toFixed(3));
        buttons[i].classList.toggle('here', lit > 0.5);
        if (lit > 0.5) buttons[i].setAttribute('aria-current', 'page');
        else buttons[i].removeAttribute('aria-current');
      }
    }

    /**
     * A spring, in the units a spring is written in.
     *
     * ω is how fast it wants to move and ζ how much it resists — just under 1,
     * so it arrives with a little left in it rather than stopping dead. The
     * first version of this used arbitrary constants against milliseconds, and
     * `damping × dt` came out above 1: every step flipped the velocity's sign
     * and made it bigger, which is how a spring explodes. It jumped 248 points
     * in one frame. Seconds, and ω·dt well under 1, is what keeps it stable.
     */
    const OMEGA = 17;     // radians per second — settles in about a third of one
    const ZETA = 0.82;    // just under critical, so it overshoots a little

    let last = 0;
    function step(now) {
      frame = null;
      // A tab that was in the background gets one enormous frame otherwise, and
      // one enormous frame is a jump.
      const dt = Math.min(1 / 30, (last ? now - last : 16) / 1000);
      last = now;

      if (!dragging) {
        const away = x - target;
        const a = -(OMEGA * OMEGA) * away - 2 * ZETA * OMEGA * v;
        v += a * dt;
        x += v * dt;
        // Only at the very ends, and it takes the velocity with it rather than
        // leaving it to fight the wall.
        const limit = (count - 1) * span();
        if (x < 0) { x = 0; v = 0; }
        if (x > limit) { x = limit; v = 0; }
        if (Math.abs(away) < 0.3 && Math.abs(v) < 6) {
          x = target;
          v = 0;
          paint();
          if (arrive) { const go = arrive; arrive = null; go(); }
          return;
        }
      }
      paint();
      frame = requestAnimationFrame(step);
    }

    const run = () => {
      if (frame) return;
      last = 0;
      frame = requestAnimationFrame(step);
    };

    const settled = (index, animate) => {
      at = index;
      target = index * span();
      if (!animate) {
        x = target;
        v = 0;
        pill.style.width = (100 / count) + '%';
        paint();
        return;
      }
      run();
    };

    pill.style.width = (100 / count) + '%';
    // Drawn where it belongs before anything can move: a capsule that springs
    // in from the left on every page load would be a page load you can see.
    settled(at, false);

    // ---- the finger ----------------------------------------------------------

    let wasX = 0;
    let wasAt = 0;
    let downX = 0;
    // Whether a finger is down at all. Tracked here rather than asked of
    // pointer capture: capture is a request a browser may not grant, and a
    // gesture that only works when it does is a gesture that sometimes does not.
    let down = false;

    // How far a finger has to travel before it is a drag rather than a tap.
    // Below this it is somebody pressing a button, and a button should do what
    // it says rather than what the physics makes of it.
    const SLOP = 8;

    host.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      // Not dragging yet. Treating every touch as a drag is what made tapping a
      // tab unreliable: the first move then measured the distance from wherever
      // the capsule happened to be to wherever the finger landed, divided it by
      // a couple of milliseconds, and called the result velocity. Tapping
      // Terminal from Instances is two tabs of "movement" in no time at all —
      // the throw that produced sailed past and landed on Settings.
      dragging = false;
      moved = false;
      down = true;
      arrive = null;
      downX = event.clientX;
      try { host.setPointerCapture(event.pointerId); } catch (_) { /* not granted */ }
      wasAt = event.timeStamp || performance.now();
    });

    host.addEventListener('pointermove', (event) => {
      const box = host.getBoundingClientRect();
      const next = clamp(event.clientX - box.left - span() / 2);
      const now = event.timeStamp || performance.now();

      if (!dragging) {
        if (!down || Math.abs(event.clientX - downX) < SLOP) return;
        // It is a drag now. The capsule jumps to the finger, and that jump is
        // not a movement anybody made: it starts from rest.
        dragging = true;
        moved = true;
        pill.classList.add('held');
        v = 0;
        wasX = next;
        wasAt = now;
        x = next;
        paint();
        run();
        return;
      }

      event.preventDefault();
      const dt = Math.max(1, now - wasAt);
      // Points per second, the same units the spring works in. Smoothed, or a
      // single jittery frame becomes a flick.
      const instant = ((next - wasX) / dt) * 1000;
      v = v * 0.4 + instant * 0.6;
      wasX = next;
      wasAt = now;
      x = next;
      paint();
    });

    const release = () => {
      down = false;
      // A tap never gets here: the button's own click handler takes it, which
      // is the only place that should decide where a tap goes. This is only
      // ever the end of a drag.
      if (!dragging) return;
      dragging = false;
      pill.classList.remove('held');
      // Thrown, not dropped: where it would come to rest decides which tab it
      // lands on, which is what makes a flick feel like it went somewhere.
      const projected = x + v * 0.13;
      const index = Math.max(0, Math.min(count - 1, Math.round(projected / span())));
      if (index === at) {
        settled(index, true);
        return;
      }
      const next = index;
      arrive = () => go(TABS[next].page, null, 'tab');
      buzz();
      settled(next, true);
    };

    host.addEventListener('pointerup', release);
    host.addEventListener('pointercancel', () => {
      down = false;
      if (!dragging) return;
      dragging = false;
      pill.classList.remove('held');
      settled(at, true);
    });

    buttons.forEach((button, index) => {
      button.addEventListener('click', (event) => {
        if (moved) { event.preventDefault(); return; }
        if (index === at) return;
        // A tap has no throw of its own, so it is given one: the capsule leaves
        // with a push rather than easing away from a standstill.
        v = (index > at ? 1 : -1) * 620;
        arrive = () => go(TABS[index].page, null, 'tab');
        buzz();
        settled(index, true);
      });
    });

    window.addEventListener('resize', () => settled(at, false));
  }

  /**
   * The content is the tab strip too.
   *
   * A phone held in one hand has a thumb near the bottom and a whole screen
   * under it; making only the strip work means reaching for the strip. So a
   * horizontal swipe anywhere on the content moves between tabs, in the order
   * they are in.
   *
   * Locked to one axis on the first few pixels: these screens scroll, and a
   * list that sometimes changes tab when you meant to scroll it is worse than
   * one that never does.
   */
  function swipeScreens() {
    const screen = document.querySelector('.screen');
    const host = document.getElementById('tabs');
    if (!screen || !host) return;
    const here = (window.location.pathname.split('/').pop() || 'index.html');
    let at = TABS.findIndex((t) => t.page === here);
    if (at < 0) at = 0;

    let startX = 0;
    let startY = 0;
    let axis = null;
    let tracking = false;

    screen.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      tracking = true;
      axis = null;
      startX = event.clientX;
      startY = event.clientY;
    });

    screen.addEventListener('pointermove', (event) => {
      if (!tracking) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!axis) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        axis = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'x' : 'y';
      }
      if (axis !== 'x') return;
      event.preventDefault();
    });

    const done = (event) => {
      if (!tracking) return;
      tracking = false;
      if (axis !== 'x') return;
      const dx = event.clientX - startX;
      if (Math.abs(dx) < 60) return;
      const next = at + (dx < 0 ? 1 : -1);
      if (next < 0 || next >= TABS.length) return;
      buzz();
      go(TABS[next].page, null, 'tab');
    };

    screen.addEventListener('pointerup', done);
    screen.addEventListener('pointercancel', () => { tracking = false; });
  }

  /**
   * The small knock a touch becomes, everywhere on the phone this matters:
   * `light` for a tab taken or a tap that merely selected something, `medium`
   * for a pull that reached its threshold, `success` and `warning` for the
   * same two outcomes the rest of the product already has words for.
   *
   * The plugin first, because that is the real thing — a distinct, tuned
   * knock rather than a buzz. A plain `vibrate` under it for a phone with no
   * such plugin (a browser, an iPhone before the plugin is wired there), and
   * nothing at all under that: a phone that cannot buzz is not a bug.
   */
  function haptic(kind) {
    const plugins = native();
    const haptics = plugins && plugins.Haptics;
    if (haptics) {
      try {
        if ((kind === 'success' || kind === 'warning') && haptics.notification) {
          const said = haptics.notification({ type: kind === 'success' ? 'SUCCESS' : 'WARNING' });
          if (said && said.catch) said.catch(() => {});
          return;
        }
        if (haptics.impact) {
          const said = haptics.impact({ style: kind === 'medium' ? 'MEDIUM' : 'LIGHT' });
          if (said && said.catch) said.catch(() => {});
          return;
        }
      } catch (_) { /* fall through to a plain vibration */ }
    }
    if (navigator.vibrate) {
      try { navigator.vibrate(kind === 'medium' || kind === 'warning' ? 16 : 10); } catch (_) { /* nothing left to try */ }
    }
  }

  // Loaded on every screen, including the conversation — which is where
  // another hand uses it for the other half of this: a reply arriving, a
  // turn finishing. Here, it is the tab bar and a pull that just let go.
  window.NikHaptic = haptic;

  /** The small knock that makes a selection feel like it happened. */
  function buzz() {
    haptic('light');
  }

  function wireNative() {
    const plugins = native();
    if (!plugins) return;

    if (plugins.StatusBar && plugins.StatusBar.setStyle) {
      plugins.StatusBar.setStyle({ style: 'DARK' }).catch(() => {});
    }
    // Android's back gesture should mean what it means everywhere else: go
    // back, and at the first screen leave — not close the WebView on a page
    // that happens to be first in history.
    if (plugins.App && plugins.App.addListener) {
      plugins.App.addListener('backButton', ({ canGoBack }) => {
        // Something open over the page (the GitHub pull request) closes first.
        if ((window.NikBack || []).some((close) => close())) return;
        if (canGoBack && window.history.length > 1) { setNavDirection('back'); window.history.back(); }
        else if (plugins.App.exitApp) plugins.App.exitApp();
      });
    }
  }

  window.NikApp = {
    laptop, remember, forget, remote, origin,
    prefs, setPref, applyPrefs,
    params, go, requireLaptop, version, native
  };

  // The client reads this at startup, so it is set before anything else runs.
  const session = params().get('session');
  const config = remote(session);
  if (config) window.NIKUI_REMOTE = config;

  /**
   * Which phone this is, on the root element.
   *
   * Not for feature detection — everything functional asks the platform
   * directly — but for the one thing that genuinely differs: an iPhone expects
   * to look like an iPhone. Liquid Glass is Apple's material and belongs on
   * Apple's hardware; Android has its own and gets the flat one.
   */
  function markPlatform() {
    let platform = 'web';
    try {
      const cap = window.Capacitor;
      if (cap && typeof cap.getPlatform === 'function') platform = cap.getPlatform();
    } catch (_) { /* a browser, then */ }
    document.documentElement.classList.add('plat-' + platform);
    return platform;
  }

  markPlatform();
  applyPrefs();
  const start = () => { wireChrome(); wireNative(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
