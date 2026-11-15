/**
 * Updates from the paired laptop.
 *
 * The laptop keeps the newest build of this app (src/appUpdate.js). On every
 * connection this says which build it is running; when the laptop has a
 * different one it answers with an offer, and the Settings tab gets a dot.
 * Installing downloads it over the same tailnet the app already uses and hands
 * it to Android's installer, which asks, and refuses anything not signed like
 * the app already here.
 *
 * Android only: an iPhone cannot install an app it was handed.
 */
(function () {
  'use strict';

  const plugin = () => {
    const cap = window.Capacitor;
    if (!cap || typeof cap.getPlatform !== 'function' || cap.getPlatform() !== 'android') return null;
    if (cap.Plugins && cap.Plugins.Updater) return cap.Plugins.Updater;
    if (typeof cap.registerPlugin !== 'function') return null;
    try { return (cap.Plugins.Updater = cap.registerPlugin('Updater')); } catch (_) { return null; }
  };

  const state = {
    offer: null,      // what the laptop has, when it is not what this is
    phase: null,      // null, 'asking', 'allow', 'downloading', 'installing', 'confirming'
    progress: null,   // 0..1 while downloading
    error: null
  };
  const listeners = new Set();
  const tell = () => {
    markTab();
    for (const fn of listeners) { try { fn(state); } catch (_) { /* one screen's problem */ } }
  };

  let mine = null;
  const myBuild = () => (mine ? Promise.resolve(mine)
    : window.NikApp.version().then((v) => (mine = (v && v.build) || null)));

  let waiting = null;
  function ask() {
    const link = window.nikLink;
    if (!link || !plugin()) return Promise.resolve(null);
    return myBuild().then((build) => new Promise((resolve) => {
      if (waiting) waiting.resolve(null);
      const timer = setTimeout(() => { if (waiting && waiting.timer === timer) { waiting = null; resolve(null); } }, 8000);
      waiting = { resolve, timer };
      link.postMessage({ type: 'app:update', build });
    }));
  }

  function heard(message) {
    state.offer = message.available ? message : null;
    if (waiting) { clearTimeout(waiting.timer); const w = waiting; waiting = null; w.resolve(state.offer); }
    tell();
  }

  function markTab() {
    const tab = document.querySelector('#tabs .tab[aria-label="Settings"]');
    if (tab) tab.classList.toggle('has-update', !!state.offer);
  }

  let progressHooked = false;
  function hookProgress(api) {
    if (progressHooked || !api.addListener) return;
    progressHooked = true;
    api.addListener('progress', (p) => { took(p); tell(); });
  }

  /** One report from the native side, live or remembered. */
  function took(p) {
    if (!p) return;
    if (p.state === 'downloading') {
      state.phase = 'downloading';
      state.progress = p.total > 0 ? Math.min(1, p.done / p.total) : null;
    } else if (p.state === 'installing' || p.state === 'confirming') {
      state.phase = p.state;
      state.progress = null;
    } else if (p.state === 'cancelled') {
      state.phase = null;
      state.progress = null;
    } else if (p.state === 'failed') {
      state.phase = null;
      state.progress = null;
      state.error = p.message || 'The update could not be installed.';
    } else if (p.state === 'installed') {
      state.phase = null;
    }
  }

  /**
   * A page that loads while an install is under way — the person went to a
   * conversation and came back — picks it up where the native side has it,
   * rather than offering Install again over a download already running.
   */
  function restore(api) {
    if (!api.status) return Promise.resolve();
    return api.status().then((s) => {
      if (!s) return;
      if (s.state) {
        took(s.state === 'downloading' ? { state: 'downloading', done: s.done, total: s.total } : s);
      } else if (state.phase && state.phase !== 'allow' && state.phase !== 'asking') {
        // Finished while nobody was listening: cancelled, or failed.
        state.phase = null;
        state.progress = null;
        if (s.message) state.error = s.message;
      } else if (s.message && !state.phase) {
        state.error = s.message;
      }
      tell();
    }).catch(() => {});
  }

  /** Android's confirmation screen again, when it went away or never came. */
  function confirm() {
    const api = plugin();
    if (!api || !api.confirm) return;
    api.confirm().catch(() => {
      // Nothing is waiting: the install is over, so offer it afresh.
      state.phase = null;
      state.progress = null;
      tell();
      ask();
    });
  }

  /**
   * Install the laptop's build. Asks for a fresh offer first: the address in
   * an old one may have lapsed, and the APK may have been rebuilt since.
   */
  function install() {
    const api = plugin();
    if (!api || state.phase) return;
    hookProgress(api);
    state.error = null;
    state.phase = 'asking';
    tell();
    api.canInstall().then((can) => {
      if (!can || !can.allowed) {
        state.phase = 'allow';
        tell();
        return;
      }
      return ask().then((offer) => {
        const where = window.NikApp.laptop();
        if (!offer || !offer.path || !where) {
          state.phase = null;
          state.error = offer === null && !state.offer ? null : 'Your laptop did not answer. Try again.';
          tell();
          return;
        }
        state.phase = 'downloading';
        state.progress = 0;
        tell();
        return api.install({
          url: window.NikApp.origin(where) + offer.path,
          sha256: offer.sha256,
          size: offer.size
        });
      });
    }).catch((err) => {
      state.phase = null;
      state.progress = null;
      state.error = (err && err.message) || 'The update could not be installed.';
      tell();
    });
  }

  /** Android's own switch for "this app may install updates", opened for the person. */
  function allow() {
    const api = plugin();
    if (!api) return;
    resumeAfterAllow = true;
    api.allow().catch(() => {
      state.phase = null;
      state.error = 'Open Android Settings → Apps → NikUI → Install unknown apps, and allow it.';
      tell();
    });
  }

  // Coming back from Android's settings carries on where it stopped, if the
  // switch was turned on; otherwise the explanation stays where it was.
  let resumeAfterAllow = false;
  function wireResume() {
    const app = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!app || !app.addListener) return;
    app.addListener('resume', () => {
      if (resumeAfterAllow && state.phase === 'allow') {
        resumeAfterAllow = false;
        const api = plugin();
        api && api.canInstall().then((can) => {
          state.phase = null;
          if (can && can.allowed) install(); else tell();
        });
        return;
      }
      // A build made while the phone was in a pocket.
      if (!state.phase) ask();
      // Back from Android's installer screen without an answer, or from
      // anywhere while an install ran: the native side knows where it got to.
      else if (state.phase !== 'allow') restore(plugin());
    });
  }

  function cancelAllow() {
    resumeAfterAllow = false;
    if (state.phase === 'allow') { state.phase = null; tell(); }
  }

  if (!plugin()) {
    window.NikUpdate = { state, supported: false, install() {}, confirm() {}, allow() {}, cancelAllow() {}, on() { return () => {}; } };
    return;
  }

  const api = plugin();
  hookProgress(api);
  restore(api);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === '@welcome' || message.type === 'app:update:changed') {
      if (!state.phase) ask();
    } else if (message.type === 'app:update') {
      heard(message);
    }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markTab);
  else markTab();
  wireResume();

  window.NikUpdate = {
    state,
    supported: true,
    install,
    confirm,
    allow,
    cancelAllow,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
