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

  window.Capacitor.Plugins.Watcher = {
    status: function () { return Promise.resolve({ supported: true, running: shelf().watching, platform: 'android' }); },
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
