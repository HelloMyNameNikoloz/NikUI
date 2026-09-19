'use strict';

// The native bits of a phone, as far as a browser is concerned.
//
// Stands in for the four plugins the app talks to — notifications, this app's
// own Watcher, haptics, and the one that hands over a link the camera scanned —
// so the whole path can be driven for real: the laptop decides something is
// worth telling, it goes down the socket the app is holding, and the app turns
// it into a notification with the right words, channel and instance. Everything
// up to the last inch is the real code.
//
// What it records is kept in localStorage, so it survives the app moving
// between screens — which the app does constantly, and which is exactly when
// something is most likely to be dropped.

const SOURCE = `(function () {
  const SHELF = 'nikui.test.buzz';
  const shelf = () => { try { return JSON.parse(localStorage.getItem(SHELF)) || { shown: [], channels: [], watching: false, permission: 'prompt' }; } catch (_) { return { shown: [], channels: [], watching: false, permission: 'prompt' }; } };
  const keep = (all) => localStorage.setItem(SHELF, JSON.stringify(all));
  const taps = [];

  window.Capacitor = window.Capacitor || {};
  window.Capacitor.Plugins = window.Capacitor.Plugins || {};

  // The face or finger the app lock asks for. What it answers is set from the
  // test, because the whole point of the rule being tested — three tries and
  // then the keypad — is what happens when it keeps saying no.
  // Kept in localStorage, like everything else here, because this stand-in is
  // re-installed on every document the app opens and the app opens a new one
  // for every screen. Held in a variable it would forget what the test told it
  // the moment the page it was told on went away — and its default is yes, so
  // forgetting means silently unlocking.
  const FACE = 'nikui.test.face';
  const face = () => {
    try { return Object.assign({ available: true, kind: 'face', say: 'yes', asked: 0 },
      JSON.parse(localStorage.getItem(FACE) || '{}')); } catch (_) { return { available: true, kind: 'face', say: 'yes', asked: 0 }; }
  };
  const keepFace = (all) => localStorage.setItem(FACE, JSON.stringify(all));

  Object.defineProperty(window, '__face', {
    get: face,
    set: (value) => keepFace(Object.assign(face(), value)),
    configurable: true
  });
  window.__setFace = (patch) => keepFace(Object.assign(face(), patch));

  window.Capacitor.Plugins.AppLock = {
    available: function () {
      const all = face();
      return Promise.resolve({
        available: !!all.available,
        kind: all.kind,
        enrolled: true,
        reason: all.available ? '' : 'nothing is set up on this phone'
      });
    },
    prompt: function () {
      const all = face();
      all.asked = (all.asked || 0) + 1;
      keepFace(all);
      if (all.say === 'yes') return Promise.resolve({ ok: true });
      const err = new Error(all.say === 'no' ? 'that was not recognised' : 'cancelled');
      err.code = all.say === 'no' ? 'FAILED' : String(all.say).toUpperCase();
      return Promise.reject(err);
    }
  };

  window.Capacitor.Plugins.LocalNotifications = {
    checkPermissions: function () { return Promise.resolve({ display: shelf().permission }); },
    requestPermissions: function () {
      const all = shelf();
      // Whatever the test said to answer next time, or yes.
      all.permission = all.answer || 'granted';
      keep(all);
      return Promise.resolve({ display: all.permission });
    },
    createChannel: function (channel) {
      const all = shelf();
      if (all.channels.indexOf(channel.id) < 0) all.channels.push(channel.id);
      keep(all);
      return Promise.resolve();
    },
    schedule: function (options) {
      const all = shelf();
      for (const one of (options && options.notifications) || []) all.shown.push(one);
      keep(all);
      return Promise.resolve({ notifications: options.notifications });
    },
    addListener: function (name, fn) {
      taps.push({ name: name, fn: fn });
      return Promise.resolve({ remove: function () {} });
    }
  };

  // Which phone this is. A real one is one or the other; the stand-in is told,
  // because both branches of "how do I hear about this while the app is shut"
  // need driving and no single device has both.
  window.Capacitor.Plugins.Watcher = {
    status: function () {
      const all = shelf();
      return Promise.resolve({
        supported: all.platform !== 'ios',
        running: all.watching,
        platform: all.platform || 'android'
      });
    },
    start: function () { const all = shelf(); all.watching = true; keep(all); return Promise.resolve(); },
    stop: function () { const all = shelf(); all.watching = false; keep(all); return Promise.resolve(); }
  };

  window.Capacitor.Plugins.Haptics = {
    impact: function (options) {
      const all = shelf();
      all.buzzes = (all.buzzes || []).concat([(options && options.style) || 'LIGHT']);
      keep(all);
      return Promise.resolve();
    }
  };

  // An iPhone asking iOS where Apple can reach it. Present only on iOS, which
  // is why the app asks whether it is there rather than which platform it is on.
  window.Capacitor.Plugins.AppleToken = {
    isSupported: function () { return Promise.resolve({ supported: true, platform: 'ios' }); },
    register: function () {
      const all = shelf();
      if (all.appleRefusal) return Promise.reject(new Error(all.appleRefusal));
      return Promise.resolve({ token: 'f'.repeat(64) });
    }
  };

  // The link a camera scanned, handed over the way Capacitor hands it over.
  const urlListeners = [];
  window.Capacitor.Plugins.App = {
    addListener: function (name, fn) {
      if (name === 'appUrlOpen') urlListeners.push(fn);
      return Promise.resolve({ remove: function () {} });
    },
    getLaunchUrl: function () { return Promise.resolve({ url: shelf().launchUrl || null }); },
    exitApp: function () {}
  };

  // What the test drives from outside.
  window.__buzz = {
    shown: function () { return shelf().shown; },
    channels: function () { return shelf().channels; },
    watching: function () { return shelf().watching; },
    clear: function () { const all = shelf(); all.shown = []; keep(all); },
    answerWith: function (verdict) { const all = shelf(); all.answer = verdict; keep(all); },
    buzzes: function () { return shelf().buzzes || []; },
    /** A QR the phone's camera just read, delivered the way the platform does. */
    scan: function (url) {
      for (const fn of urlListeners) fn({ url: url });
      return urlListeners.length;
    },
    /** The same link, but as the thing that started the app. */
    launchedWith: function (url) { const all = shelf(); all.launchUrl = url; keep(all); },
    appleRefuses: function (why) { const all = shelf(); all.appleRefusal = why || null; keep(all); },
    beAn: function (kind) { const all = shelf(); all.platform = kind; keep(all); },
    /** Tap the last notification, the way the platform reports it. */
    tapLast: function () {
      const all = shelf();
      const last = all.shown[all.shown.length - 1];
      if (!last) return false;
      for (const tap of taps) {
        if (tap.name === 'localNotificationActionPerformed') tap.fn({ notification: last });
      }
      return true;
    }
  };
})();`;

module.exports = { SOURCE };
