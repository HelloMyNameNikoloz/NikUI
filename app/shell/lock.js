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
        // How many digits, so the screen can draw that many dots and open the
        // moment the last one is typed, the way a phone's own lock does. Says
        // no more than the dots on the screen already would.
        length: String(code).length,
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
   *
   * With `length` it knows how long the code is: that many dots, and it is
   * handed over the moment the last digit goes in. Without, it grows a dot per
   * digit and waits for the arrow.
   */
  function makeScreen(opts) {
    const o = opts || {};
    const length = o.length || 0;
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
    said.setAttribute('aria-live', 'polite');
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
    let busy = false;
    let refusing = false;
    let closed = false;

    const view = {
      skin, title, said, face,
      get typed() { return typed; },
      get closed() { return closed; },
      clear() { typed = ''; view.draw(); },
      // Changed in place rather than rebuilt, so a dot filling is a dot
      // filling and not every dot being drawn again.
      draw() {
        const most = length || Math.max(MIN, typed.length);
        while (dots.children.length < most) {
          const dot = document.createElement('span');
          dot.className = 'lock-dot';
          dots.appendChild(dot);
        }
        while (dots.children.length > most) dots.lastChild.remove();
        for (let i = 0; i < most; i++) dots.children[i].classList.toggle('on', i < typed.length);
        skin.classList.toggle('ready', !length && typed.length >= MIN);
      },
      // Waiting on the check: the keys stop taking digits, the dots breathe.
      busy(yes) {
        busy = !!yes;
        skin.classList.toggle('checking', busy);
      },
      shake() {
        skin.classList.remove('wrong');
        void skin.offsetWidth;
        skin.classList.add('wrong');
        buzz('heavy');
      },
      // Wrong: shake with the dots still full so it is clear what was refused,
      // then empty them.
      refuse(then) {
        refusing = true;
        view.shake();
        setTimeout(() => {
          refusing = false;
          skin.classList.remove('wrong');
          view.clear();
          if (then) then();
        }, 420);
      },
      held(yes) { pad.classList.toggle('held', !!yes); },
      close() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey);
        document.documentElement.classList.remove('locked');
        skin.remove();
      },
      // Right: the dots go green and the lock lifts off the app that was
      // already drawn underneath it, rather than vanishing.
      open(then) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey);
        skin.classList.add('right');
        const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        setTimeout(() => {
          document.documentElement.classList.remove('locked');
          skin.classList.add('leaving');
          setTimeout(() => skin.remove(), still ? 0 : 240);
          if (then) then();
        }, still ? 0 : 140);
      }
    };

    const blocked = () => closed || busy || refusing || pad.classList.contains('held');

    const type = (digit) => {
      if (blocked() || typed.length >= (length || MAX)) return;
      typed += digit;
      said.textContent = '';
      view.draw();
      buzz('light');
      if (length && typed.length === length) o.onDone(typed);
      else if (o.onTyped) o.onTyped(typed);
    };

    const back = () => {
      if (blocked() || !typed.length) return;
      typed = typed.slice(0, -1);
      view.draw();
    };

    // Only when the length is not known — choosing one, or a lock set before
    // the length was kept. Guessing when it is finished would be wrong exactly
    // for whoever chose a longer code.
    const go = () => {
      if (blocked() || typed.length < MIN) return;
      o.onDone(typed);
    };

    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'go', '0', 'back']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lock-key';
      let act;
      if (key === 'back') {
        button.className += ' lock-key-thin';
        button.textContent = '⌫';
        button.setAttribute('aria-label', 'Delete');
        act = back;
      } else if (key === 'go') {
        button.className += ' lock-key-thin lock-key-go';
        if (length) {
          // Nothing to press: it opens on the last digit.
          button.className += ' lock-key-none';
          button.setAttribute('aria-hidden', 'true');
          button.tabIndex = -1;
          pad.appendChild(button);
          continue;
        }
        button.textContent = '→';
        button.setAttribute('aria-label', o.goLabel || 'Unlock');
        act = go;
      } else {
        button.textContent = key;
        act = () => type(key);
      }

      // On the finger going down, not on it coming up: a click waits for the
      // lift and, in a WebView, for a little longer after that, which is the
      // lag that makes a keypad feel like a web page. The press is shown for
      // long enough to be seen however quick the tap was.
      let pressed = false;
      let downAt = 0;
      const lift = () => {
        const wait = Math.max(0, 110 - (Date.now() - downAt));
        setTimeout(() => button.classList.remove('down'), wait);
      };
      button.addEventListener('pointerdown', (event) => {
        if (event.button > 0) return;
        event.preventDefault();
        pressed = true;
        downAt = Date.now();
        button.classList.add('down');
        act();
      });
      button.addEventListener('pointerup', lift);
      button.addEventListener('pointercancel', lift);
      button.addEventListener('pointerleave', lift);
      // A click with no press before it is a screen reader or a test; one
      // after a press has already been acted on.
      button.addEventListener('click', () => {
        if (pressed) { pressed = false; return; }
        act();
      });
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
    const saved = read();

    let checking = false;
    let faceTries = 0;
    let facePending = false;
    let faceLater = null;
    let interrupted = 0;
    let ticking = null;
    let done = null;
    // Locks set before the length was kept: checked quietly as it is typed,
    // and the length learned the first time it is right.
    let quietly = Promise.resolve();

    const learn = (code) => {
      const now = read();
      if (now && !now.length) { now.length = String(code).length; write(now); }
    };

    const view = makeScreen({
      title: reason || 'Enter passcode',
      length: saved && saved.length,
      onDone: (code) => {
        if (checking || heldUntil()) return;
        checking = true;
        view.busy(true);
        verify(code).then((ok) => {
          checking = false;
          view.busy(false);
          if (ok) { learn(code); return finish(); }
          const until = wrongAgain();
          view.refuse(() => {
            if (until) countdown();
            else view.said.textContent = 'Wrong passcode.';
          });
        });
      },
      // Not counted when it is wrong: nobody said they had finished.
      onTyped: (code) => {
        if (saved && saved.length) return;
        if (code.length < MIN) return;
        quietly = quietly.then(() => {
          if (view.closed || checking || view.typed !== code) return null;
          return verify(code).then((ok) => {
            if (ok && !view.closed && !checking && view.typed === code) { learn(code); finish(); }
          });
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
      if (view.closed) return;
      if (ticking) clearInterval(ticking);
      document.removeEventListener('visibilitychange', onSeen);
      // The passcode got there while the prompt was still waiting to appear.
      if (facePending) {
        const api = plugin();
        if (api && api.cancel) Promise.resolve(api.cancel()).catch(() => {});
      }
      rightAtLast();
      allow();
      buzz('light');
      view.open(() => {
        showing = null;
        if (done) done(true);
      });
    }

    const offerFace = (kind) => {
      view.face.textContent = 'Use ' + named(kind);
      view.face.hidden = false;
      view.face.onclick = () => askFace(kind);
    };

    const askFace = (kind) => {
      const api = plugin();
      if (!api || view.closed || facePending || faceTries >= FACE_TRIES) return;
      // A prompt asked for behind something is a prompt nobody sees, and the
      // system takes it straight down again. Asked for when the app is back.
      if (document.hidden) { faceLater = kind; return; }
      faceTries++;
      facePending = true;
      view.face.disabled = true;
      api.prompt({ reason: 'Unlock NikUI' }).then(() => {
        facePending = false;
        view.face.disabled = false;
        finish();
      }).catch((err) => {
        facePending = false;
        view.face.disabled = false;
        if (view.closed) return;
        const code = (err && (err.code || err.errorCode)) || '';
        // Another screen of the app asked while this one was waiting.
        if (code === 'REPLACED') return;
        // Taken down by the phone, not by them — the app went behind
        // something, the screen went off. Not a try, and asked again when the
        // app is looked at, a few times before it stops insisting.
        if (code === 'INTERRUPTED') {
          faceTries--;
          offerFace(kind);
          if (++interrupted > 3) return;
          if (document.hidden) faceLater = kind;
          else setTimeout(() => askFace(kind), 400);
          return;
        }
        interrupted = 0;
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

    const onSeen = () => {
      if (document.hidden || !faceLater || view.closed) return;
      const kind = faceLater;
      faceLater = null;
      setTimeout(() => askFace(kind), 300);
    };
    document.addEventListener('visibilitychange', onSeen);

    if (heldUntil()) countdown();

    if (!o.passcodeOnly && saved && saved.biometric !== false) {
      available().then((can) => {
        if (!can || !can.available || view.closed) return;
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
          view.refuse(() => { view.said.textContent = 'Use ' + MIN + ' to ' + MAX + ' digits.'; });
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
          view.refuse(() => {
            view.title.textContent = 'Choose a passcode';
            view.said.textContent = 'Those did not match. Start again.';
          });
          return;
        }
        set(code).then(() => {
          buzz('medium');
          view.open(() => {
            showing = null;
            done(code);
          });
        }).catch((err) => {
          view.refuse(() => { view.said.textContent = (err && err.message) || 'That would not do.'; });
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
