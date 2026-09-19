/* The lock on the front door of the app.

   What it is for, said plainly, because the wrong idea about it would be
   dangerous: this stops the person your unlocked phone is handed to. It is not
   what keeps your laptop safe — that is the key in the chip, which this cannot
   reach and does not hold — and anyone who can take the phone apart can read
   what is behind it. A four-digit code is ten thousand guesses; what makes it
   worth anything is that there is no way to make those guesses quickly, which
   is why the wrong ones are counted and the waiting grows.

   It runs before every screen, on every page, and paints over the whole app
   before anything else has drawn. Locked means locked: not a dialog on top of
   your instances, which would have shown them for the frame before it appeared.

   Three things it deliberately does:

     A face or a finger is offered first and counted. Three refusals and it
     stops asking — a phone held up to the wrong face should end at the keypad,
     not in a loop of prompts.

     Moving between screens does not ask again. A tab bar that demanded a face
     four times to read one number would be turned off within a day, so the
     unlock lasts for as long as the app is in front of you.

     Coming back after a minute away does. That is the case this exists for:
     the phone put down, picked up by somebody else. */
(function () {
  'use strict';

  const STORE = 'nikui.app.lock';
  const OPEN = 'nikui.app.unlocked';
  const AWAY = 'nikui.app.leftAt';

  // How long the app may sit in somebody's pocket before it wants proof again.
  const GRACE_MS = 60000;
  // How many times a face may be offered before the keypad is the only way in.
  const FACE_TRIES = 3;
  const MIN = 4;
  const MAX = 12;
  // Enough that ten thousand guesses is not a thing you do while waiting for a
  // bus, and little enough that one guess is not a thing you notice.
  const ROUNDS = 210000;

  // ---- what is kept -----------------------------------------------------------

  function read() {
    try {
      const raw = window.localStorage.getItem(STORE);
      const saved = raw ? JSON.parse(raw) : null;
      return saved && saved.hash && saved.salt ? saved : null;
    } catch (_) { return null; }
  }

  function write(value) {
    try {
      if (value) window.localStorage.setItem(STORE, JSON.stringify(value));
      else window.localStorage.removeItem(STORE);
    } catch (_) { /* a phone with no storage cannot hold a lock either */ }
  }

  const on = () => !!read();

  // ---- the code itself --------------------------------------------------------

  const bytes = (n) => window.crypto.getRandomValues(new Uint8Array(n));

  const b64 = (buffer) => {
    const view = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
    return window.btoa(out);
  };

  const unb64 = (text) => Uint8Array.from(window.atob(text), (c) => c.charCodeAt(0));

  /** The code is never kept; this is. */
  function derive(code, salt, rounds) {
    const raw = new TextEncoder().encode(String(code));
    return window.crypto.subtle
      .importKey('raw', raw, 'PBKDF2', false, ['deriveBits'])
      .then((key) => window.crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: rounds }, key, 256))
      .then((bits) => b64(bits));
  }

  /** Same length in, same time out: a comparison should not say how close it was. */
  function same(a, b) {
    const one = String(a);
    const two = String(b);
    if (one.length !== two.length) return false;
    let differs = 0;
    for (let i = 0; i < one.length; i++) differs |= one.charCodeAt(i) ^ two.charCodeAt(i);
    return differs === 0;
  }

  const looksLikeCode = (code) => /^[0-9]+$/.test(String(code || '')) &&
    String(code).length >= MIN && String(code).length <= MAX;

  function verify(code) {
    const saved = read();
    if (!saved) return Promise.resolve(false);
    return derive(code, unb64(saved.salt), saved.rounds || ROUNDS)
      .then((got) => same(got, saved.hash))
      .catch(() => false);
  }

  /** Turn it on, or change the code. The caller has already proved the old one. */
  function set(code, options) {
    if (!looksLikeCode(code)) {
      return Promise.reject(new Error('a passcode is ' + MIN + ' to ' + MAX + ' digits'));
    }
    const salt = bytes(16);
    return derive(code, salt, ROUNDS).then((hash) => {
      const was = read() || {};
      write({
        salt: b64(salt),
        hash: hash,
        rounds: ROUNDS,
        biometric: options && 'biometric' in options
          ? !!options.biometric
          : (was.biometric !== false),
        wrong: 0,
        until: 0
      });
      allow();
      return true;
    });
  }

  function clear() {
    write(null);
    allow();
    return Promise.resolve(true);
  }

  function useBiometrics(yes) {
    const saved = read();
    if (!saved) return false;
    saved.biometric = !!yes;
    write(saved);
    return saved.biometric;
  }

  // ---- how wrong answers are made expensive -----------------------------------

  // Not a lockout anybody is locked out of — the code is still the code — but
  // guessing has to stop being something you can do ten thousand times.
  const WAITS = [
    { after: 5, ms: 30000 },
    { after: 7, ms: 120000 },
    { after: 10, ms: 900000 }
  ];

  function waitFor(wrong) {
    let ms = 0;
    for (const step of WAITS) if (wrong >= step.after) ms = step.ms;
    return ms;
  }

  function wrongAgain() {
    const saved = read();
    if (!saved) return 0;
    saved.wrong = (saved.wrong || 0) + 1;
    const ms = waitFor(saved.wrong);
    saved.until = ms ? Date.now() + ms : 0;
    write(saved);
    return saved.until;
  }

  function rightAtLast() {
    const saved = read();
    if (!saved) return;
    saved.wrong = 0;
    saved.until = 0;
    write(saved);
  }

  const heldUntil = () => {
    const saved = read();
    return saved && saved.until > Date.now() ? saved.until : 0;
  };

  // ---- whether it is open right now -------------------------------------------

  const allow = () => {
    try { window.sessionStorage.setItem(OPEN, String(Date.now())); } catch (_) { /* fine */ }
  };

  const shut = () => {
    try { window.sessionStorage.removeItem(OPEN); } catch (_) { /* fine */ }
  };

  /**
   * Is it already open?
   *
   * Session storage, so moving between screens is free and the app being killed
   * is not. The clock is only consulted for time spent *away*: a screen you are
   * looking at does not become suspicious because you read it slowly.
   */
  function opened() {
    try { return !!window.sessionStorage.getItem(OPEN); } catch (_) { return false; }
  }

  // ---- the face or the finger --------------------------------------------------

  function plugin() {
    const cap = window.Capacitor;
    if (!cap) return null;
    if (cap.Plugins && cap.Plugins.AppLock) return cap.Plugins.AppLock;
    if (typeof cap.registerPlugin !== 'function') return null;
    try {
      const made = cap.registerPlugin('AppLock');
      if (cap.Plugins) cap.Plugins.AppLock = made;
      return made;
    } catch (_) { return null; }
  }

  function available() {
    const api = plugin();
    if (!api || typeof api.available !== 'function') {
      return Promise.resolve({ available: false, kind: 'none', reason: 'not a phone' });
    }
    return api.available().catch(() => ({ available: false, kind: 'none', reason: 'this phone would not say' }));
  }

  const WORD = { face: 'Face ID', touch: 'Touch ID', finger: 'your fingerprint' };
  const named = (kind) => WORD[kind] || 'your face or fingerprint';

  // ---- the screen ---------------------------------------------------------------

  let showing = null;

  function buzz(style) {
    const plugins = (window.Capacitor && window.Capacitor.Plugins) || null;
    const haptics = plugins && plugins.Haptics;
    if (!haptics || !haptics.impact) return;
    const call = haptics.impact({ style: (style || 'light').toUpperCase() });
    if (call && call.catch) call.catch(function () {});
  }

  /**
   * The keypad, and everything around it.
   *
   * Built here rather than put in a page, because it has to exist before any
   * page has drawn a thing — and used by both the screen that asks for the
   * passcode and the one that sets it, so the two cannot drift into looking
   * like different apps.
   */
  function makeScreen(opts) {
    const o = opts || {};
    document.documentElement.classList.add('locked');

    const skin = document.createElement('div');
    skin.className = 'lock';
    skin.setAttribute('role', 'dialog');
    skin.setAttribute('aria-modal', 'true');
    skin.setAttribute('aria-label', o.title || 'Locked');

    const mark = document.createElement('div');
    mark.className = 'lock-mark';
    const title = document.createElement('h1');
    title.className = 'lock-title';
    title.textContent = o.title || 'Enter passcode';
    const said = document.createElement('p');
    said.className = 'lock-said';
    if (o.said) said.textContent = o.said;

    const dots = document.createElement('div');
    dots.className = 'lock-dots';
    const pad = document.createElement('div');
    pad.className = 'lock-pad';
    const face = document.createElement('button');
    face.className = 'lock-face';
    face.type = 'button';
    face.hidden = true;

    // One group that floats in the space above the keypad, so the screen reads
    // as a lock rather than as a column of things pushed to the top.
    const top = document.createElement('div');
    top.className = 'lock-top';
    top.appendChild(mark);
    top.appendChild(title);
    top.appendChild(said);
    top.appendChild(dots);

    skin.appendChild(top);
    skin.appendChild(pad);
    skin.appendChild(face);
    document.body.appendChild(skin);

    let typed = '';

    const view = {
      skin, title, said, face,
      get typed() { return typed; },
      clear() { typed = ''; view.draw(); },
      draw() {
        dots.textContent = '';
        const most = Math.max(MIN, typed.length);
        for (let i = 0; i < most; i++) {
          const dot = document.createElement('span');
          dot.className = 'lock-dot' + (i < typed.length ? ' on' : '');
          dots.appendChild(dot);
        }
        skin.classList.toggle('ready', typed.length >= MIN);
      },
      shake() {
        skin.classList.remove('wrong');
        void skin.offsetWidth;
        skin.classList.add('wrong');
        buzz('heavy');
      },
      held(yes) { pad.classList.toggle('held', !!yes); },
      close() {
        document.removeEventListener('keydown', onKey);
        document.documentElement.classList.remove('locked');
        skin.remove();
      }
    };

    const type = (digit) => {
      if (pad.classList.contains('held') || typed.length >= MAX) return;
      typed += digit;
      said.textContent = '';
      view.draw();
      buzz('light');
    };

    const back = () => {
      if (!typed.length) return;
      typed = typed.slice(0, -1);
      view.draw();
    };

    // Never submitted for you: a passcode may be longer than four, and guessing
    // when it is finished would be wrong exactly for whoever chose a longer one.
    const go = () => {
      if (pad.classList.contains('held') || typed.length < MIN) return;
      o.onDone(typed);
    };

    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'go']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lock-key' + (key === 'back' || key === 'go' ? ' lock-key-thin' : '');
      if (key === 'back') {
        button.textContent = '\u232b';
        button.setAttribute('aria-label', 'Delete');
        button.addEventListener('click', back);
      } else if (key === 'go') {
        button.textContent = '\u2192';
        button.setAttribute('aria-label', o.goLabel || 'Unlock');
        button.addEventListener('click', go);
      } else {
        button.textContent = key;
        button.addEventListener('click', () => type(key));
      }
      pad.appendChild(button);
    }

    // A hardware keyboard, for the times there is one.
    const onKey = (event) => {
      if (/^[0-9]$/.test(event.key)) { type(event.key); event.preventDefault(); }
      else if (event.key === 'Backspace') { back(); event.preventDefault(); }
      else if (event.key === 'Enter') { go(); event.preventDefault(); }
    };
    document.addEventListener('keydown', onKey);

    view.draw();
    return view;
  }

  /** Paint over everything, and do not come back until it is right. */
  function ask(reason, options) {
    if (showing) return showing;
    const o = options || {};

    let checking = false;
    let faceTries = 0;
    let ticking = null;
    let done = null;

    const view = makeScreen({
      title: reason || 'Enter passcode',
      onDone: (code) => {
        if (checking || heldUntil()) return;
        checking = true;
        verify(code).then((ok) => {
          checking = false;
          if (ok) return finish();
          const until = wrongAgain();
          view.clear();
          view.shake();
          if (until) countdown();
          else view.said.textContent = 'Wrong passcode.';
        });
      }
    });

    function countdown() {
      if (ticking) clearInterval(ticking);
      const tick = () => {
        const left = heldUntil() - Date.now();
        if (left <= 0) {
          clearInterval(ticking);
          ticking = null;
          view.said.textContent = '';
          view.held(false);
          return;
        }
        const seconds = Math.ceil(left / 1000);
        view.said.textContent = seconds > 60
          ? 'Too many tries. Try again in ' + Math.ceil(seconds / 60) + ' minutes.'
          : 'Too many tries. Try again in ' + seconds + 's.';
        view.held(true);
      };
      tick();
      ticking = setInterval(tick, 500);
    }

    function finish() {
      if (ticking) clearInterval(ticking);
      rightAtLast();
      allow();
      view.close();
      showing = null;
      buzz('light');
      if (done) done(true);
    }

    const offerFace = (kind) => {
      view.face.textContent = 'Use ' + named(kind);
      view.face.hidden = false;
      view.face.onclick = () => askFace(kind);
    };

    const askFace = (kind) => {
      const api = plugin();
      if (!api || faceTries >= FACE_TRIES) return;
      faceTries++;
      view.face.disabled = true;
      api.prompt({ reason: 'Unlock NikUI' }).then(() => {
        view.face.disabled = false;
        finish();
      }).catch((err) => {
        view.face.disabled = false;
        const code = (err && (err.code || err.errorCode)) || '';
        if (code === 'LOCKED_OUT' || code === 'UNAVAILABLE') {
          faceTries = FACE_TRIES;
          view.face.hidden = true;
          view.said.textContent = (err && (err.message || err.errorMessage)) || 'Use your passcode.';
          return;
        }
        if (faceTries >= FACE_TRIES) {
          view.face.hidden = true;
          view.said.textContent = 'Enter your passcode instead.';
          return;
        }
        // Cancelling is somebody choosing the keypad, not a failure to be
        // counted against them in words.
        if (code !== 'CANCELLED') {
          const left = FACE_TRIES - faceTries;
          view.said.textContent = 'That was not recognised. ' +
            left + ' more ' + (left === 1 ? 'try' : 'tries') + '.';
        }
        offerFace(kind);
      });
    };

    if (heldUntil()) countdown();

    const saved = read();
    if (!o.passcodeOnly && saved && saved.biometric !== false) {
      available().then((can) => {
        if (!can || !can.available || !showing) return;
        offerFace(can.kind);
        // Offered without being asked for: on a phone, holding it up is the
        // thing you were going to do anyway.
        if (!heldUntil()) askFace(can.kind);
      });
    }

    showing = new Promise((resolve) => { done = resolve; });
    return showing;
  }

  /**
   * Choose a passcode, twice.
   *
   * Twice because there is no way back from a code you typed wrong once: the
   * only thing that could reset it is knowing it. Turning the lock off and on
   * again is the way out, and that needs the code as well.
   */
  function choose() {
    if (showing) return Promise.reject(new Error('busy'));
    let first = null;
    let done = null;
    let give = null;

    const view = makeScreen({
      title: 'Choose a passcode',
      said: MIN + ' digits or more',
      goLabel: 'Continue',
      onDone: (code) => {
        if (!looksLikeCode(code)) {
          view.clear();
          view.shake();
          view.said.textContent = 'Use ' + MIN + ' to ' + MAX + ' digits.';
          return;
        }
        if (first === null) {
          first = code;
          view.clear();
          view.title.textContent = 'Enter it again';
          view.said.textContent = '';
          return;
        }
        if (first !== code) {
          first = null;
          view.clear();
          view.shake();
          view.title.textContent = 'Choose a passcode';
          view.said.textContent = 'Those did not match. Start again.';
          return;
        }
        set(code).then(() => {
          view.close();
          showing = null;
          buzz('medium');
          done(code);
        }).catch((err) => {
          view.clear();
          view.shake();
          view.said.textContent = (err && err.message) || 'That would not do.';
        });
      }
    });

    // A way out that is not choosing one, since this is somebody turning on a
    // setting rather than being asked to prove anything.
    view.face.textContent = 'Cancel';
    view.face.hidden = false;
    view.face.onclick = () => {
      view.close();
      showing = null;
      give(new Error('cancelled'));
    };

    showing = new Promise((resolve, reject) => { done = resolve; give = reject; });
    return showing;
  }

  /**
   * The one call every screen makes. Resolves when the app may be looked at.
   */
  function guard() {
    if (!on()) return Promise.resolve(true);
    if (opened()) { allow(); return Promise.resolve(true); }
    return ask();
  }

  /**
   * Ask for the code, and only the code.
   *
   * No face here, on purpose. Changing the passcode or taking the lock off are
   * the two things that end it, and a face is the credential you can be made to
   * present without agreeing to anything — someone holding the phone can hold it
   * up to you. A code has to be told. It is also what the phone itself does:
   * turning off a passcode asks for the passcode, never the face.
   */
  function confirm(reason) {
    if (!on()) return Promise.resolve(true);
    return ask(reason || 'Enter your passcode', { passcodeOnly: true });
  }

  // ---- away, and back ----------------------------------------------------------

  // A phone in a pocket is the case this exists for. Capacitor tells us when the
  // app goes behind something; the browser's own visibility is the fallback, and
  // between them every way out of the app is covered.
  function watchAway() {
    const note = (active) => {
      if (!on()) return;
      if (!active) {
        try { window.sessionStorage.setItem(AWAY, String(Date.now())); } catch (_) { /* fine */ }
        return;
      }
      let left = 0;
      try { left = Number(window.sessionStorage.getItem(AWAY) || 0); } catch (_) { left = 0; }
      if (!left || Date.now() - left < GRACE_MS) return;
      shut();
      guard();
    };

    const plugins = (window.Capacitor && window.Capacitor.Plugins) || null;
    if (plugins && plugins.App && plugins.App.addListener) {
      plugins.App.addListener('appStateChange', (state) => note(!!(state && state.isActive)));
    }
    document.addEventListener('visibilitychange', () => note(!document.hidden));
  }

  window.nikLock = {
    on, guard, confirm, choose, verify, set, clear, useBiometrics, available,
    kind: () => available().then((can) => (can && can.available ? can.kind : 'none')),
    named, looksLikeCode, MIN, MAX,
    // Read by the settings screen so it can say what it is doing.
    settings: () => {
      const saved = read();
      return saved ? { biometric: saved.biometric !== false } : null;
    }
  };

  // Before anything else draws. `guard` paints over the app when it has to, and
  // does nothing at all when there is no lock — which is every phone until
  // somebody turns one on.
  watchAway();
  guard();
})();
