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
    const settings = document.getElementById('to-settings');
    if (settings) settings.addEventListener('click', () => go('settings.html'));

    // The client's own back link points at the server's root; in a bundle the
    // fleet is a page rather than a path.
    const back = document.getElementById('back');
    if (back && back.tagName === 'A') back.setAttribute('href', 'index.html');

    const onWayIn = /connect\.html$/.test(window.location.pathname);
    if (!onWayIn && !laptop()) window.location.replace('connect.html');
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

  applyPrefs();
  const start = () => { wireChrome(); wireNative(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
