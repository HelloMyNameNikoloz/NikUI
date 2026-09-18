/* Being told, on the phone itself.

   The laptop already decides what is worth telling somebody about — an
   instance waiting for an answer, the quota running out, an instance failing.
   That decision is made in one place, `src/notify.js`, and arrives here as an
   `@notify` frame down the socket this device is already holding. No push
   service, no account anywhere, nothing outside the two machines.

   What this adds is the part only a phone can do: raising a real system
   notification, remembering which kinds are wanted, and opening the right
   instance when one is tapped.

   Loaded on every screen, because whichever screen is open is the one holding
   the socket. */
(function () {
  'use strict';

  const PREFS = 'nikui.app.notify';

  // The same three the laptop tells anybody about by default, and the same
  // fourth left off for the same reason: four agents finishing overnight is a
  // phone buzzing all night, and a notification you learn to ignore is worse
  // than no notification at all.
  const DEFAULTS = { on: false, needsYou: true, quota: true, failed: true, turnFinished: false };

  // What each kind is called on a screen, so the switches read as things that
  // happen rather than as the names of events.
  const KINDS = [
    ['needsYou', 'needs-you', 'Something needs an answer', 'An instance is waiting and cannot go on'],
    ['failed', 'failed', 'An instance failed', 'It stopped without finishing'],
    ['quota', 'quota', 'The usage limit', 'When it runs out, and when it comes back'],
    ['turnFinished', 'turn-finished', 'A turn finished', 'Every time any instance finishes — noisy by design']
  ];

  const plugins = () => (window.Capacitor && window.Capacitor.Plugins) || null;
  const local = () => { const p = plugins(); return (p && p.LocalNotifications) || null; };
  const watcher = () => { const p = plugins(); return (p && p.Watcher) || null; };
  const appleToken = () => { const p = plugins(); return (p && p.AppleToken) || null; };

  function read() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(window.localStorage.getItem(PREFS)) || {}); }
    catch (_) { return Object.assign({}, DEFAULTS); }
  }

  function write(next) {
    try { window.localStorage.setItem(PREFS, JSON.stringify(next)); } catch (_) { /* nothing to do */ }
    return next;
  }

  const prefs = read;

  function setPref(key, value) {
    const next = read();
    next[key] = value;
    return write(next);
  }

  /** Whether this kind, right now, is worth interrupting somebody for. */
  function wants(kind) {
    const p = read();
    if (!p.on) return false;
    const row = KINDS.find((k) => k[1] === kind);
    return row ? p[row[0]] !== false : false;
  }

  /**
   * A stable small number from a tag.
   *
   * The platforms replace a notification when a new one has the same id, which
   * is exactly what the laptop's `tag` means — "this is the same news as
   * before, not more of it". So the tag becomes the id rather than being
   * thrown away, and an instance that flickers between waiting and running
   * leaves one notification rather than forty.
   */
  function idFor(tag) {
    let hash = 5381;
    const text = String(tag || 'nikui');
    for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    return (hash % 2000000000) + 1;
  }

  // ---- permission ------------------------------------------------------------

  /** @returns {Promise<'granted'|'denied'|'prompt'|'unavailable'>} */
  function permission() {
    const api = local();
    if (!api) return Promise.resolve('unavailable');
    return api.checkPermissions()
      .then(function (r) { return (r && r.display) || 'prompt'; })
      .catch(function () { return 'unavailable'; });
  }

  /**
   * Ask, once, at the moment somebody turns notifications on — never at
   * launch. A permission dialog before anybody has asked for anything is a
   * dialog that gets refused.
   */
  function ask() {
    const api = local();
    if (!api) return Promise.resolve('unavailable');
    return api.requestPermissions()
      .then(function (r) { return (r && r.display) || 'denied'; })
      .catch(function () { return 'denied'; });
  }

  // ---- raising one -----------------------------------------------------------

  function raise(message) {
    if (!message || !wants(message.kind)) return Promise.resolve(false);
    const api = local();
    if (!api) return Promise.resolve(false);
    return api.schedule({
      notifications: [{
        id: idFor(message.tag || message.kind),
        title: String(message.title || 'NikUI').slice(0, 120),
        body: String(message.body || '').slice(0, 300),
        // Something that cannot go on without you is worth a sound. The rest
        // is worth a line on a lock screen and nothing more.
        channelId: message.kind === 'needs-you' ? 'nikui-needs-you' : 'nikui-news',
        smallIcon: 'ic_stat_nikui',
        extra: { session: message.session || null }
      }]
    }).then(function () { return true; })
      .catch(function () { return false; });
  }

  /** One for the person who just asked whether any of this works. */
  function test() {
    const api = local();
    if (!api) return Promise.resolve(false);
    return api.schedule({
      notifications: [{
        id: idFor('nikui-test'),
        title: 'NikUI can reach you',
        body: 'That is all this one was for.',
        channelId: 'nikui-news',
        smallIcon: 'ic_stat_nikui'
      }]
    }).then(function () { return true; }).catch(function () { return false; });
  }

  // ---- watching while the app is not on screen -------------------------------

  /**
   * Android can keep the socket open behind a quiet ongoing notification, so
   * the phone is told while it is in a pocket. iPhone cannot: iOS stops an app
   * listening the moment it leaves the screen, and there is no setting, no
   * entitlement and no trick that changes it — so the honest thing is to say
   * so rather than offer a switch that does nothing.
   *
   * @returns {Promise<{supported: boolean, running: boolean}>}
   */
  function background() {
    const api = watcher();
    if (!api) return Promise.resolve({ supported: false, running: false });
    return api.status().catch(function () { return { supported: false, running: false }; });
  }

  function watch(on) {
    const api = watcher();
    if (!api) return Promise.resolve({ supported: false, running: false });
    return (on ? api.start() : api.stop())
      .then(function () { return background(); })
      .catch(function () { return background(); });
  }

  // ---- being told while the app is not running at all -------------------------

  /**
   * On an iPhone, the socket is gone the moment the app leaves the screen, and
   * no setting changes that. The only way to reach a closed app is Apple's own
   * push network, which needs a token from iOS and an Apple Developer account
   * behind the build. Android needs none of it and does not have this plugin.
   *
   * @returns {Promise<{supported: boolean, registered: boolean, why?: string}>}
   */
  function apple() {
    const api = appleToken();
    if (!api) return Promise.resolve({ supported: false, registered: false });
    return Promise.resolve({ supported: true, registered: !!read().appleToken });
  }

  /**
   * Ask iOS for a token and hand it to the laptop, over the socket it is
   * already holding — which is authenticated and sealed, so it needs no
   * endpoint, no second signature and no rate limit of its own.
   */
  function registerWithApple(send) {
    const api = appleToken();
    if (!api) return Promise.resolve({ supported: false, registered: false });
    return api.register().then(function (out) {
      const token = out && out.token;
      if (!token) return { supported: true, registered: false, why: 'iOS gave no token' };
      const next = read();
      next.appleToken = token;
      write(next);
      if (send) send({ type: '@apple', token: token });
      return { supported: true, registered: true };
    }).catch(function (err) {
      return {
        supported: true, registered: false,
        why: (err && (err.message || err.errorMessage)) || 'this phone would not register'
      };
    });
  }

  /** Said again on every connection, because a token outlives a socket. */
  function offerApple(send) {
    const token = read().appleToken;
    if (token && send) send({ type: '@apple', token: token });
  }

  // ---- wiring ----------------------------------------------------------------

  /** Where a notification came from, opened when it is tapped. */
  function open(notification) {
    const extra = (notification && (notification.extra ||
      (notification.notification && notification.notification.extra))) || {};
    if (!window.NikApp) return;
    if (extra.session) window.NikApp.go('conversation.html', { session: extra.session });
    else window.NikApp.go('index.html');
  }

  function start() {
    const api = local();
    if (api) {
      // Two channels, so the phone's own settings can separate the one that
      // should make a sound from the ones that should not. Created every time
      // because creating one that exists is free and never creating it means a
      // silent notification nobody can fix.
      if (api.createChannel) {
        api.createChannel({
          id: 'nikui-needs-you', name: 'Needs an answer', importance: 5,
          description: 'An instance is waiting for you', visibility: 1
        }).catch(function () {});
        api.createChannel({
          id: 'nikui-news', name: 'Everything else', importance: 3,
          description: 'Finished turns, failures, the usage limit', visibility: 1
        }).catch(function () {});
      }
      if (api.addListener) {
        api.addListener('localNotificationActionPerformed', function (event) {
          open(event && event.notification);
        });
      }
    }

    window.addEventListener('message', function (event) {
      const message = event.data;
      if (!message) return;
      if (message.type === '@notify') return void raise(message);
      // A fresh socket has not been told where to reach this phone when it is
      // closed. Tokens outlive connections; the laptop's record of one does not
      // need to, because saying it again costs nothing.
      if (message.type === '@welcome' && window.nikLink) {
        offerApple(function (out) { window.nikLink.postMessage(out); });
      }
    });
  }

  window.NikNotify = {
    prefs, setPref, wants, raise, test, permission, ask, background, watch,
    apple, registerWithApple, offerApple,
    KINDS, DEFAULTS, idFor
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
