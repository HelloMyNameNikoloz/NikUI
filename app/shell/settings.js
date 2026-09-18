/* Settings: what this device is, what it is allowed, and how to check.

   Built rather than written out, so every row is one line of description and
   the screen cannot drift from what it describes. Nothing here is a preference
   for its own sake — each row answers a question somebody would otherwise have
   to ask me: is it connected, what can it do, which laptop is this, and how do
   I undo it. */
(function () {
  'use strict';

  const screen = document.getElementById('screen');
  const app = window.NikApp;

  const state = {
    where: app.laptop(),
    device: null,          // this device's own record: id, fingerprint, laptop key
    connection: 'checking', // checking | live | refused | unreachable
    control: null,          // null unknown, true may steer, false watching
    laptopName: null,
    version: { client: '…', app: '…' },
    health: null,           // round trip in ms, when it answered
    key: null,              // where the key is held, and what this device could do better
    moving: null,           // a word for what the move is doing, while it does it
    sealed: null,           // whether this connection is sealed end to end
    showing: null,          // a fingerprint opened up to be read out loud
    notify: null,           // what this phone has been told it may show
    watching: null,         // whether it can keep listening in a pocket
    laptopVersion: null,    // what the laptop is running, as it said on connecting
    explaining: false,      // the one paragraph that says what any of this is
    apple: null             // whether this iPhone can be reached while closed
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /**
   * One row. `value` is what it says on the right; `tap` makes it a control;
   * `tone` colours the value the way the product colours states everywhere.
   */
  function row(list, { label, hint, value, mono, tone, tap, dot, chevron }) {
    const node = el(tap ? 'button' : 'div', 'row' + (tap ? ' tappable' : '') + (tone ? ' ' + tone : ''));
    if (tap) { node.type = 'button'; node.addEventListener('click', tap); }

    const left = el('div', 'row-label');
    left.appendChild(el('b', null, label));
    if (hint) left.appendChild(el('small', null, hint));
    node.appendChild(left);

    const right = el('div', 'row-value' + (mono ? ' mono' : ''));
    if (dot) right.appendChild(el('span', 'state-dot ' + dot));
    if (value != null) right.appendChild(el('span', null, value));
    if (chevron) right.classList.add('chevron');
    node.appendChild(right);

    list.appendChild(node);
    return node;
  }

  function group(title, note) {
    const wrap = el('section', 'group');
    if (title) wrap.appendChild(el('div', 'group-title', title));
    const list = el('div', 'list');
    wrap.appendChild(list);
    if (note) wrap.appendChild(el('p', 'group-note', note));
    screen.appendChild(wrap);
    return list;
  }

  const ago = (at) => {
    if (!at) return 'never';
    const ms = Date.now() - at;
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
    return Math.round(ms / 86400000) + 'd ago';
  };

  const shortKey = (key) => (key ? String(key).slice(0, 8) + '…' : 'none');

  /** A small physical confirmation that a tap did something. */
  function buzz(style) {
    const plugins = app.native();
    const haptics = plugins && plugins.Haptics;
    if (!haptics || !haptics.impact) return;
    const call = haptics.impact({ style: (style || 'light').toUpperCase() });
    if (call && call.catch) call.catch(function () {});
  }

  /**
   * A fingerprint in chunks a person can read aloud and compare without
   * losing their place. Four groups is the most anybody checks properly.
   */
  const groups = (key) => String(key || '').replace(/(.{6})/g, '$1 ').trim();

  /** Where a key is kept, said the way a person would say it. */
  const HELD = {
    'secure-enclave': 'Secure Enclave',
    'strongbox': 'Security chip',
    'keystore': 'Android Keystore',
    'software': 'In this app'
  };

  // ---- what the screen says ------------------------------------------------

  function draw() {
    screen.textContent = '';

    const connection = group('Connection', state.connection === 'live'
      ? 'This device is talking to your laptop now.'
      : 'Nothing is shown until this device can reach the laptop and prove who it is.');

    row(connection, {
      label: 'Status',
      dot: state.connection === 'live' ? 'live' : state.connection === 'checking' ? 'busy' : 'gone',
      value: {
        checking: 'Checking…',
        live: 'Connected',
        refused: 'Refused',
        unreachable: 'Cannot reach it'
      }[state.connection],
      tone: state.connection === 'live' ? 'good' : state.connection === 'checking' ? '' : 'bad'
    });

    row(connection, {
      label: 'Laptop',
      hint: state.laptopName && state.laptopName !== state.where.host ? state.laptopName : null,
      value: state.where.host,
      mono: true
    });

    if (state.health != null) {
      row(connection, { label: 'Round trip', value: state.health + ' ms' });
    }

    row(connection, {
      label: 'Check again',
      tap: () => { state.connection = 'checking'; state.health = null; draw(); probe(); },
      chevron: true
    });

    // ---- what protects this connection ------------------------------------
    //
    // Put directly under the connection it is about, and said in one word that
    // is either right or wrong: there is no useful middle state to explain.

    const safety = group('Security',
      state.sealed
        ? 'Sealed with a key this phone and your laptop agree fresh every time they connect. Nothing carrying it can read it.'
        : 'This connection is protected by HTTPS alone until it is sealed.');

    row(safety, {
      label: 'This connection',
      dot: state.sealed ? 'live' : state.sealed === false ? 'gone' : 'busy',
      value: state.sealed === null ? 'Checking…' : state.sealed ? 'End-to-end encrypted' : 'Not sealed',
      tone: state.sealed ? 'good' : state.sealed === false ? 'warn' : ''
    });

    row(safety, {
      label: 'Check it is really your laptop',
      hint: state.showing ? null : 'Compare four groups of letters with the ones on your laptop',
      value: state.showing ? null : 'Show',
      tap: () => { state.showing = state.showing ? null : (state.where.fingerprint || ''); draw(); },
      chevron: !state.showing
    });

    if (state.showing) {
      const proof = el('p', 'proof');
      proof.textContent = groups(state.showing);
      safety.parentNode.insertBefore(proof, safety.nextSibling);
    }

    const permission = group('What this device may do',
      state.control === false
        ? 'Sending prompts is granted on the laptop: Devices → this device → Let this device send prompts.'
        : 'A prompt from this device runs on your laptop with the same permissions as one typed there.');

    row(permission, {
      label: 'Permission',
      value: state.control === null ? 'Unknown' : state.control ? 'Can send prompts' : 'Watching only',
      tone: state.control === false ? 'warn' : state.control ? 'good' : ''
    });

    const identity = group('This device',
      'The key is made on this device and cannot leave it. The laptop knows only the public half.');

    row(identity, { label: 'Paired', value: state.device && state.device.id ? 'Yes' : 'No',
      tone: state.device && state.device.id ? 'good' : 'bad' });

    const held = (state.device && state.device.protection) || 'software';
    const hardware = held !== 'software';
    row(identity, {
      label: 'Key kept in',
      hint: hardware
        ? 'A chip. Nothing can copy it out — not this app, not a backup.'
        : 'This app, where it cannot be read out but a copy of the phone is a copy of it.',
      value: HELD[held] || held,
      tone: hardware ? 'good' : ''
    });

    // Offered only when it is actually better, and only when it would work.
    if (state.key && state.key.possible) {
      row(identity, {
        label: state.moving || 'Move it into the chip',
        hint: state.moving ? null : 'Takes a moment. Nothing else changes — same laptop, same permission.',
        tone: state.moving ? '' : 'good',
        tap: state.moving ? null : moveKey,
        chevron: !state.moving
      });
    }

    if (hardware && state.key && state.key.biometrics) {
      row(identity, {
        label: 'Ask for Face ID or a fingerprint',
        hint: state.device && state.device.biometric
          ? 'Asked once, then not again for five minutes.'
          : 'Off. Unlocking the phone is enough.',
        value: state.device && state.device.biometric ? 'On' : 'Off',
        tone: state.device && state.device.biometric ? 'good' : '',
        tap: toggleBiometric,
        chevron: true
      });
    }

    row(identity, { label: 'Its key', value: shortKey(state.device && state.device.publicKey), mono: true });
    row(identity, { label: 'Laptop key pinned', value: shortKey(state.where.fingerprint), mono: true });
    row(identity, { label: 'Paired', value: ago(state.where.pairedAt) });

    // ---- being told -------------------------------------------------------
    //
    // One switch to turn it on, which is also the moment the phone is asked for
    // permission — never at launch, because a permission dialog before anybody
    // has asked for anything is a dialog that gets refused.

    const wanted = window.NikNotify ? window.NikNotify.prefs() : { on: false };
    const allowed = state.notify;

    const telling = group('Notifications', allowed === 'denied'
      ? 'This phone is set to show nothing from NikUI. Open its Settings to change that.'
      : 'Your laptop decides what is worth telling you. This decides which of those reach you here.');

    row(telling, {
      label: 'Tell me things',
      hint: allowed === 'denied' ? 'Blocked by this phone' : null,
      value: wanted.on && allowed === 'granted' ? 'On' : 'Off',
      tone: wanted.on && allowed === 'granted' ? 'good' : allowed === 'denied' ? 'bad' : '',
      tap: toggleNotifications,
      chevron: true
    });

    if (wanted.on && allowed === 'granted') {
      for (const [key, , label, hint] of (window.NikNotify.KINDS || [])) {
        row(telling, {
          label, hint,
          value: wanted[key] ? 'On' : 'Off',
          tone: wanted[key] ? 'good' : '',
          tap: () => { window.NikNotify.setPref(key, !wanted[key]); draw(); }
        });
      }
      row(telling, {
        label: 'Send me one now',
        hint: 'To see what it looks like, and that it arrives',
        tap: () => window.NikNotify.test().then((ok) => flash(ok ? 'Sent.' : 'This phone would not show it.')),
        chevron: true
      });
    }

    // Keeping the socket open while the app is not on screen. Android allows
    // it behind a quiet ongoing notification; iOS does not allow it at all,
    // and says so rather than offering a switch that would do nothing.
    const away = state.watching || { supported: false, running: false };
    if (wanted.on && allowed === 'granted') {
      if (away.supported) {
        row(telling, {
          label: 'Keep watching in the background',
          hint: away.running
            ? 'A quiet notification says so, because this phone requires one'
            : 'Off — you are only told while NikUI is open',
          value: away.running ? 'On' : 'Off',
          tone: away.running ? 'good' : '',
          tap: () => window.NikNotify.watch(!away.running).then((now) => { state.watching = now; draw(); }),
          chevron: true
        });
      } else if (state.apple && state.apple.supported) {
        // iOS cannot keep a socket open, so the only way to reach a closed app
        // is Apple's own network — which needs a token from this phone and an
        // Apple Developer account behind the build. Both failures are named,
        // because "notifications do not arrive" is the least useful sentence
        // in this product.
        row(telling, {
          label: 'While NikUI is closed',
          hint: state.apple.registered
            ? 'Your laptop can reach this iPhone through Apple when the app is not running.'
            : state.apple.why || 'iPhone cannot listen in the background. Apple can pass a message on.',
          value: state.apple.registered ? 'On' : 'Set up',
          tone: state.apple.registered ? 'good' : '',
          tap: state.apple.registered ? null : setUpApple,
          chevron: !state.apple.registered
        });
      } else {
        row(telling, {
          label: 'While NikUI is closed',
          hint: 'This phone cannot listen in the background, and cannot be reached any other way.',
          value: 'Not possible'
        });
      }
    }

    const look = group('Text size');
    const sizes = [['small', 'Small'], ['medium', 'Default'], ['large', 'Large']];
    const current = app.prefs().textSize;
    for (const [key, label] of sizes) {
      row(look, {
        label,
        value: key === current ? '✓' : '',
        tone: key === current ? 'good' : '',
        tap: () => { app.setPref('textSize', key); draw(); }
      });
    }

    const about = group('About');
    row(about, {
      label: 'What is this?',
      tap: () => { state.explaining = !state.explaining; draw(); },
      value: state.explaining ? null : 'Read',
      chevron: !state.explaining
    });
    row(about, { label: 'App', value: state.version.app, mono: true });

    // The app carries its own copy of the client. When the laptop is running a
    // different one, everything still works until suddenly it does not, and the
    // symptom is never "the versions differ" — so it is said here, plainly,
    // rather than left to be worked out.
    const drifted = state.laptopVersion && state.laptopVersion !== state.version.client;
    row(about, {
      label: 'Client', value: state.version.client, mono: true,
      tone: drifted ? 'warn' : '',
      hint: drifted
        ? 'Your laptop is running ' + state.laptopVersion + '. Update the app to match.'
        : state.laptopVersion
          ? 'The same version your laptop is running'
          : 'The same files the editor’s panel runs'
    });
    row(about, {
      label: 'Copy diagnostics',
      hint: 'Everything on this screen, as text',
      tap: copyDiagnostics,
      chevron: true
    });

    if (state.explaining) {
      const words = el('p', 'group-note explain');
      words.textContent = 'NikUI runs Claude Code on your laptop. This app is the same screen the ' +
        'editor shows, on your phone: you can watch what every instance is doing from anywhere, ' +
        'and — if you grant it on the laptop — answer and send prompts. Nothing runs on this ' +
        'phone. It holds a key that proves it is yours, and everything it says is sealed between ' +
        'the two.';
      about.parentNode.appendChild(words);
    }

    const danger = group('Undo',
      'Forgetting deletes this device’s key. The laptop keeps its record until you remove it there too.');
    row(danger, {
      label: 'Forget this laptop',
      tone: 'danger',
      tap: confirmForget,
      chevron: true
    });
  }

  // ---- what the screen checks ----------------------------------------------

  /** Is the laptop there, and would it have us? */
  function probe() {
    const base = app.origin(state.where);
    const at = Date.now();
    fetch(base + '/health', { cache: 'no-store' })
      .then((response) => {
        state.health = Date.now() - at;
        if (!response.ok) { state.connection = 'refused'; return draw(); }
        // Reachable is not the same as allowed: only a socket can answer that,
        // and the transport is what holds one.
        listen();
      })
      .catch(() => { state.connection = 'unreachable'; state.health = null; draw(); });
  }

  let transport = null;
  function listen() {
    if (transport) return;
    window.NIKUI_REMOTE = app.remote(null);
    transport = window.nikTransport();
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      if (message.type === '@welcome' || message.type === '@device') {
        if (message.version) state.laptopVersion = message.version;
        state.connection = 'live';
        state.control = message.device ? message.device.control !== false : null;
        state.sealed = !!(transport && transport.sealed && transport.sealed());
        draw();
      } else if (message.type === '@denied') {
        state.connection = 'refused';
        draw();
      }
    });
  }

  /**
   * Move this device's key into the chip, without pairing again.
   *
   * The new key is made here, then offered on the next handshake — signed by
   * the key it replaces, which is what gives the laptop a reason to accept it.
   * So the move is: make it, reconnect, wait to be told it was taken. The
   * reconnect happens now rather than whenever the network next drops, because
   * a face check that arrives while somebody is holding the phone and looking
   * at the button they pressed is a face check that makes sense.
   */
  function moveKey() {
    if (state.moving) return;
    state.moving = 'Making a new key…';
    draw();

    const wanted = !!(state.device && state.device.biometric);
    window.nikDevice.stageUpgrade({ biometric: wanted }).then(function () {
      state.moving = 'Telling your laptop…';
      draw();
      if (transport && transport.reconnect) transport.reconnect();
      else listen();
      // If the laptop never answers, saying so beats a row that spins forever.
      state.giveUp = setTimeout(function () {
        if (!state.moving) return;
        state.moving = null;
        window.nikDevice.discardUpgrade().catch(function () {});
        refreshKey();
        flash('Your laptop did not answer. Nothing changed.');
      }, 20000);
    }).catch(function (err) {
      state.moving = null;
      draw();
      flash(cancelled(err) ? 'Cancelled. Nothing changed.' : 'This phone would not make the key.');
    });
  }

  /** A person saying no is not an error to report as one. */
  const cancelled = (err) => /cancel/i.test(String((err && (err.message || err.code)) || ''));

  /**
   * Turning the face check on or off means making the key again — the rule is
   * baked into the key by the chip and cannot be changed afterwards. Which is
   * exactly the move that already exists, so it is the same path.
   */
  function toggleBiometric() {
    if (state.moving) return;
    const wanting = !(state.device && state.device.biometric);
    state.moving = wanting ? 'Turning it on…' : 'Turning it off…';
    draw();
    window.nikDevice.stageUpgrade({ biometric: wanting }).then(function () {
      if (transport && transport.reconnect) transport.reconnect();
      else listen();
      state.giveUp = setTimeout(function () {
        if (!state.moving) return;
        state.moving = null;
        window.nikDevice.discardUpgrade().catch(function () {});
        refreshKey();
        flash('Your laptop did not answer. Nothing changed.');
      }, 20000);
    }).catch(function (err) {
      state.moving = null;
      draw();
      flash(cancelled(err) ? 'Cancelled. Nothing changed.' : 'This phone would not make the key.');
    });
  }

  /** What the identity says about itself, after anything that could change it. */
  function refreshKey() {
    if (!window.nikDevice || !window.nikDevice.available()) return Promise.resolve();
    return Promise.all([window.nikDevice.load(), window.nikDevice.protection()])
      .then(function (both) {
        state.device = both[0];
        state.key = both[1];
        draw();
      }).catch(function () {});
  }

  // The transport is what carries the move, so it is the transport that says
  // whether it landed.
  window.addEventListener('nikui-key-moved', function (event) {
    if (state.giveUp) { clearTimeout(state.giveUp); state.giveUp = null; }
    state.moving = null;
    refreshKey().then(function () {
      flash(event.detail && event.detail.taken ? 'Done. The key is in the chip.' : 'Your laptop did not take it.');
    });
  });

  /**
   * On means two things at once — this phone allowing it, and this app wanting
   * it — so the switch does both, in that order, and says which one said no.
   */
  function toggleNotifications() {
    const api = window.NikNotify;
    if (!api) return;
    const now = api.prefs();
    if (now.on) {
      api.setPref('on', false);
      // Nothing to listen for means nothing to stay awake for.
      return api.watch(false).then((watching) => { state.watching = watching; draw(); });
    }
    return api.ask().then((verdict) => {
      state.notify = verdict;
      if (verdict !== 'granted') {
        draw();
        flash(verdict === 'unavailable' ? 'Not available here.' : 'This phone said no.');
        return;
      }
      api.setPref('on', true);
      buzz('medium');
      draw();
    });
  }

  /** Ask iOS for a token, and hand it to the laptop over the socket. */
  function setUpApple() {
    const api = window.NikNotify;
    if (!api || !api.registerWithApple) return;
    flash('Asking Apple…');
    api.registerWithApple(function (message) {
      if (window.nikLink) window.nikLink.postMessage(message);
    }).then(function (now) {
      state.apple = now;
      draw();
      if (now.registered) { buzz('medium'); flash('Done.'); }
      else flash(now.why || 'This phone would not register.');
    });
  }

  function copyDiagnostics() {
    const lines = [
      'NikUI app ' + state.version.app + ' · client ' + state.version.client +
        (state.laptopVersion ? ' · laptop ' + state.laptopVersion : ''),
      'laptop: ' + state.where.scheme + '://' + state.where.host,
      'connection: ' + state.connection + (state.health != null ? ' (' + state.health + ' ms)' : ''),
      'sealed: ' + (state.sealed === null ? 'unknown' : state.sealed ? 'end to end' : 'no'),
      'notifications: ' + String(state.notify) +
        (window.NikNotify ? ' · ' + JSON.stringify(window.NikNotify.prefs()) : ''),
      'background: ' + JSON.stringify(state.watching),
      'while closed: ' + JSON.stringify(state.apple),
      'permission: ' + (state.control === null ? 'unknown' : state.control ? 'can steer' : 'watching only'),
      'device id: ' + ((state.device && state.device.id) || 'not paired'),
      'key kept in: ' + ((state.device && state.device.protection) || 'software') +
        (state.device && state.device.biometric ? ' (behind a biometric check)' : ''),
      'laptop key pinned: ' + (state.where.fingerprint || 'none'),
      'paired: ' + (state.where.pairedAt ? new Date(state.where.pairedAt).toISOString() : 'never')
    ].join('\n');

    const plugins = app.native();
    const done = plugins && plugins.Clipboard
      ? plugins.Clipboard.write({ string: lines })
      : navigator.clipboard.writeText(lines);
    Promise.resolve(done)
      .then(() => flash('Copied.'))
      .catch(() => flash('This device would not take it.'));
  }

  function flash(text) {
    const bar = document.querySelector('.bar-title');
    if (!bar) return;
    const was = bar.textContent;
    bar.textContent = text;
    setTimeout(() => { bar.textContent = was; }, 1400);
  }

  /**
   * Undoing is a two-tap decision, in words that say what is lost. The row
   * turns into its own confirmation rather than opening a dialog — one fewer
   * thing on screen, and no way to tap "yes" by muscle memory.
   */
  function confirmForget(event) {
    const node = event.currentTarget;
    if (node.dataset.armed === '1') {
      app.forget();
      window.location.replace('connect.html');
      return;
    }
    node.dataset.armed = '1';
    node.querySelector('b').textContent = 'Tap again to forget';
    node.classList.add('danger');
    buzz('heavy');
    setTimeout(() => {
      if (!node.isConnected) return;
      node.dataset.armed = '';
      node.querySelector('b').textContent = 'Forget this laptop';
    }, 4000);
  }

  // ---- start ---------------------------------------------------------------

  document.getElementById('back').addEventListener('click', () => {
    if (window.history.length > 1) window.history.back();
    else window.location.replace('index.html');
  });

  if (!state.where) {
    window.location.replace('connect.html');
  } else {
    state.laptopName = state.where.name;
    draw();
    app.version().then((v) => { state.version = v; draw(); });
    refreshKey();
    probe();
    if (window.NikNotify) {
      window.NikNotify.permission().then((verdict) => { state.notify = verdict; draw(); });
      window.NikNotify.background().then((watching) => { state.watching = watching; draw(); });
      window.NikNotify.apple().then((apple) => { state.apple = apple; draw(); });
    }
  }
})();
