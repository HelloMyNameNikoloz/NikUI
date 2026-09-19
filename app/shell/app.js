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

  function go(page, query) {
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

    // The client's own back link points at the server's root; in a bundle the
    // fleet is a page rather than a path.
    const back = document.getElementById('back');
    if (back && back.tagName === 'A') back.setAttribute('href', 'index.html');

    const onWayIn = /connect\.html$/.test(window.location.pathname);
    if (!onWayIn && !laptop()) window.location.replace('connect.html');
  }

  // The three screens that are peers rather than a hierarchy: what is running,
  // what has run, and how this is set up. A tab bar says that in a way a pair
  // of icons crowded into a title bar cannot, and puts all three where a thumb
  // already is.
  const TABS = [
    { page: 'index.html', label: 'Instances', icon: 'terminal' },
    { page: 'stats.html', label: 'Stats', icon: 'activity' },
    { page: 'history.html', label: 'History', icon: 'history' },
    { page: 'settings.html', label: 'Settings', icon: 'settings' }
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
    let at = startAt;
    let dragging = false;
    let moved = false;

    const place = (index, animate) => {
      const span = 100 / buttons.length;
      pill.style.transition = animate ? '' : 'none';
      pill.style.width = span + '%';
      pill.style.transform = 'translate3d(' + (index * 100) + '%, 0, 0)';
      if (!animate) {
        // Let the browser take the jump before transitions are allowed back.
        void pill.offsetWidth;
        pill.style.transition = '';
      }
    };

    /**
     * How much of each tab the capsule is currently over.
     *
     * Not a threshold: as the capsule crosses a tab it takes its colour by
     * degrees, so at the halfway point two tabs are half lit. That is the
     * difference between something sliding under a light and something
     * switching on when it arrives.
     */
    const tint = () => {
      const glass = pill.getBoundingClientRect();
      buttons.forEach((button, i) => {
        const box = button.getBoundingClientRect();
        const over = Math.max(0, Math.min(glass.right, box.right) - Math.max(glass.left, box.left));
        const lit = box.width ? Math.max(0, Math.min(1, over / box.width)) : 0;
        button.style.setProperty('--lit', lit.toFixed(3));
        button.classList.toggle('here', lit > 0.5);
        if (lit > 0.5) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    };

    const lightUp = () => tint();

    // Drawn where it belongs before anything can animate: a capsule that slides
    // in from the left on every page load would be a page load you can see.
    place(at, false);
    tint();

    const nearest = (clientX) => {
      const box = host.getBoundingClientRect();
      const across = (clientX - box.left) / box.width;
      return Math.max(0, Math.min(buttons.length - 1, Math.floor(across * buttons.length)));
    };

    let was = null;
    const follow = (clientX) => {
      const box = host.getBoundingClientRect();
      const span = box.width / buttons.length;
      // Clamped to the strip, so the capsule never leaves the glass it lives in.
      const left = Math.max(0, Math.min(box.width - span, clientX - box.left - span / 2));
      pill.style.transition = 'none';
      pill.style.transform = 'translate3d(' + ((left / span) * 100) + '%, 0, 0)';
      // Which way it is going, and how hard. The highlight lags behind the
      // movement, which is what makes a thing look like it is made of liquid
      // rather than being slid along a rail.
      if (was !== null) {
        const drift = Math.max(-1, Math.min(1, (left - was) / 22));
        pill.style.setProperty('--drift', drift.toFixed(3));
      }
      was = left;
      tint();
    };

    const settle = (clientX) => {
      const index = nearest(clientX);
      pill.style.transition = '';
      place(index, true);
      pill.style.setProperty('--drift', '0');
      was = null;
      // After the transition, not before it: the tint has to follow the
      // capsule the whole way rather than jumping ahead of it.
      const chase = setInterval(tint, 16);
      setTimeout(() => { clearInterval(chase); tint(); }, 460);
      return index;
    };

    host.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      dragging = true;
      moved = false;
      pill.classList.add('held');
      host.setPointerCapture(event.pointerId);
    });

    host.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      moved = true;
      event.preventDefault();
      follow(event.clientX);
    });

    const release = (event) => {
      if (!dragging) return;
      dragging = false;
      pill.classList.remove('held');
      const index = settle(event.clientX);
      if (index === at) {
        // Back where it started: a tap on the tab you are already on, or a drag
        // that changed its mind. Nothing to navigate to.
        if (!moved) return;
        return;
      }
      at = index;
      buzz();
      // After the capsule has arrived, so the last thing seen is it landing.
      setTimeout(() => go(TABS[index].page), 180);
    };

    host.addEventListener('pointerup', release);
    host.addEventListener('pointercancel', () => {
      if (!dragging) return;
      dragging = false;
      pill.classList.remove('held');
      place(at, true);
      tint();
    });

    // A keyboard, or anything that is not a finger.
    buttons.forEach((button, index) => {
      button.addEventListener('click', (event) => {
        if (moved) { event.preventDefault(); return; }
        if (index === at) return;
        at = index;
        place(index, true);
        const chase = setInterval(tint, 16);
        setTimeout(() => { clearInterval(chase); tint(); }, 460);
        buzz();
        setTimeout(() => go(TABS[index].page), 180);
      });
    });

    window.addEventListener('resize', () => place(at, false));
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
      go(TABS[next].page);
    };

    screen.addEventListener('pointerup', done);
    screen.addEventListener('pointercancel', () => { tracking = false; });
  }

  /** The small knock that makes a selection feel like it happened. */
  function buzz() {
    const plugins = native();
    const haptics = plugins && plugins.Haptics;
    if (!haptics || !haptics.selectionChanged) return;
    const call = haptics.selectionChanged();
    if (call && call.catch) call.catch(function () {});
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
        if (canGoBack && window.history.length > 1) window.history.back();
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
