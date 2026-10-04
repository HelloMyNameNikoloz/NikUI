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

  // Everything on: the laptop decides what is worth sending — whatever pops up
  // on it comes here too, for somebody out of the house with only the phone —
  // and these are for turning one kind off on the phone alone.
  const DEFAULTS = { on: false, needsYou: true, quota: true, failed: true, ci: true, turnFinished: true };
  // Prefs saved before that had a turn finishing switched off by default,
  // written down as if somebody had chosen it.
  const SHAPE = 2;

  // What each kind is called on a screen, so the switches read as things that
  // happen rather than as the names of events.
  const KINDS = [
    ['needsYou', 'needs-you', 'Something needs an answer', 'An instance is waiting and cannot go on'],
    ['failed', 'failed', 'An instance failed', 'It stopped without finishing'],
    ['quota', 'quota', 'The usage limit', 'When it runs out, and when it comes back'],
    ['ci', 'ci', 'CI on a pull request', 'Green, failed, or no CI at all'],
    ['turnFinished', 'turn-finished', 'A turn finished', 'When your laptop says an instance is done']
  ];

  const plugins = () => (window.Capacitor && window.Capacitor.Plugins) || null;
  const local = () => { const p = plugins(); return (p && p.LocalNotifications) || null; };

  // This app's own two, which iOS does not put in `Capacitor.Plugins` — see
  // nativePlugin in media/device.js for why asking by name is the only way
  // that works on both platforms.
  const ours = (name) => (window.nikDevice && window.nikDevice.nativePlugin
    ? window.nikDevice.nativePlugin(name)
    : (plugins() || {})[name] || null);
  const watcher = () => ours('Watcher');
  const appleToken = () => ours('AppleToken');

  function read() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREFS)) || {};
      if (saved.shape !== SHAPE) delete saved.turnFinished;
      return Object.assign({}, DEFAULTS, saved);
    } catch (_) { return Object.assign({}, DEFAULTS); }
  }

  function write(next) {
    next.shape = SHAPE;
    try { window.localStorage.setItem(PREFS, JSON.stringify(next)); } catch (_) { /* nothing to do */ }
    return next;
  }

  const prefs = read;

  function setPref(key, value) {
    const next = read();
    next[key] = value;
    write(next);
    sync();
    return next;
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
    // The phone's own listener has raised this one already, with the chime.
    if (listening) return Promise.resolve(false);
    const api = local();
    if (!api) return Promise.resolve(false);
    return api.schedule({
      notifications: [{
        id: idFor(message.tag || message.kind),
        title: String(message.title || 'NikUI').slice(0, 120),
        body: String(message.body || '').slice(0, 300),
        // Something that cannot go on without you is worth a sound. The rest
        // is worth a line on a lock screen and nothing more.
        // Both made natively (watcher/Chime.java), with the laptop's chime as
        // their sound and its three rising notes as their buzz.
        channelId: message.kind === 'needs-you' ? 'nikui-chime-urgent' : 'nikui-chime',
        // What the laptop's banner says, as it says it: the line under the
        // title is the answer, and it can run to more than one line.
        largeBody: String(message.body || '').slice(0, 300),
        group: 'nikui',
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
        channelId: 'nikui-chime',
        smallIcon: 'ic_stat_nikui'
      }]
    }).then(function () { return true; }).catch(function () { return false; });
  }

  // ---- listening while the app is not running --------------------------------

  /**
   * Notifications on means notifications with the phone locked and the app
   * closed — anything less is not what anybody means by the switch. On Android
   * a service of the app's own holds a connection of its own to the laptop
   * (watcher/WatchService.java), opened with a secret that can do nothing but
   * listen. The laptop hands that secret over on this socket, which is the one
   * that has already proved who this phone is.
   *
   * iPhone cannot: iOS stops an app listening the moment it leaves the screen,
   * so there the only way is Apple's — see below.
   *
   * @returns {Promise<{supported: boolean, running: boolean}>}
   */
  let listening = false;

  function background() {
    const api = watcher();
    if (!api) return Promise.resolve({ supported: false, running: false });
    return api.status()
      .then(function (now) { listening = !!(now && now.listening); return now; })
      .catch(function () { return { supported: false, running: false }; });
  }

  function watch(on) {
    const api = watcher();
    if (!api) return Promise.resolve({ supported: false, running: false });
    return (on ? api.start() : api.stop())
      .then(function () { return background(); })
      .catch(function () { return background(); });
  }

  const laptopOrigin = () => (window.NikApp && window.NikApp.laptop && window.NikApp.origin
    ? window.NikApp.origin(window.NikApp.laptop()) : null);

  /** The kinds the listener should raise: none at all when the switch is off. */
  const wanted = () => {
    const p = read();
    return p.on ? KINDS.filter((k) => p[k[0]] !== false).map((k) => k[1]) : [];
  };

  /**
   * Tells the listener what it needs, starts or stops it to match the switch,
   * and resolves with whether it still needs a secret from the laptop.
   */
  function sync() {
    const api = watcher();
    if (!api || !api.configure) return Promise.resolve(false);
    const on = read().on;
    return api.configure({ origin: laptopOrigin(), kinds: wanted() })
      .then(function (now) {
        if (!now || !now.supported) return now;
        if (on && !now.running) return api.start();
        if (!on && now.enabled) return api.stop();
        return now;
      })
      .then(function (now) {
        listening = !!(now && now.listening);
        return !!(on && now && !now.hasSecret);
      })
      .catch(function () { return false; });
  }

  /** sync, and if the listener has no secret, ask the laptop for one on this socket. */
  function listen() {
    return sync().then(function (needs) {
      if (needs && window.nikLink) window.nikLink.postMessage({ type: '@listen' });
      return background();
    });
  }

  /** Ask Android to leave the listener alone when it is saving battery. */
  function exempt() {
    const api = watcher();
    if (!api || !api.exempt) return Promise.resolve(null);
    return api.exempt().catch(function () { return null; });
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

  /** The same, for one the phone's own listener raised: nothing to do if none was. */
  function opened(event) {
    if (event && event.session && window.NikApp) window.NikApp.go('conversation.html', { session: event.session });
  }

  function start() {
    const api = local();
    if (api) {
      if (api.addListener) {
        api.addListener('localNotificationActionPerformed', function (event) {
          open(event && event.notification);
        });
      }
    }

    // A notification the phone's own listener raised, tapped.
    const native = watcher();
    if (native && native.opened) {
      native.opened().then(opened).catch(function () {});
      if (native.addListener) native.addListener('opened', opened);
    }
    sync();

    window.addEventListener('message', function (event) {
      const message = event.data;
      if (!message) return;
      if (message.type === '@notify') return void raise(message);
      // The secret for listening, asked for below.
      if (message.type === '@listener') {
        const api = watcher();
        if (api && api.configure && message.secret) {
          api.configure({ origin: laptopOrigin(), secret: message.secret, kinds: wanted() })
            .then(function (now) { listening = !!(now && now.listening); })
            .catch(function () {});
        }
        return;
      }
      // A fresh socket has not been told where to reach this phone when it is
      // closed. Tokens outlive connections; the laptop's record of one does not
      // need to, because saying it again costs nothing.
      if (message.type === '@welcome' && window.nikLink) {
        offerApple(function (out) { window.nikLink.postMessage(out); });
        // The listener asks for a secret only when it has none: a new one
        // retires the old, so asking every time would be churn.
        listen();
      }
    });
  }

  window.NikNotify = {
    prefs, setPref, wants, raise, test, permission, ask, background, watch, sync, listen, exempt,
    apple, registerWithApple, offerApple,
    KINDS, DEFAULTS, idFor
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
