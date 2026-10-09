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
    apple: null,            // whether this iPhone can be reached while closed
    lock: null,             // whether this app asks for a passcode, and what it may use
    biometrics: null,       // what this phone can check, and what to call it
    awake: null,            // whether the laptop may sleep, and whether this device may say
    switching: null,        // 'on' or 'off' while the laptop is being asked to change it
    devices: null,          // everything paired with this laptop, as this device sees it
    mayManage: false,       // whether this device may take another one off
    me: null                // which of them is this one
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
  function row(list, { label, hint, value, mono, tone, tap, dot, chevron, stacked }) {
    const node = el(tap ? 'button' : 'div',
      'row' + (tap ? ' tappable' : '') + (stacked ? ' stacked' : '') + (tone ? ' ' + tone : ''));
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

  /** A time of day, or a day and a time when it was not today. */
  const clock = (at) => {
    if (!at) return 'now';
    const when = new Date(at);
    const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return when.toDateString() === new Date().toDateString()
      ? time
      : when.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
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
    'keychain': 'iOS Keychain',
    'software': 'In this app'
  };

  // ---- what the screen says ------------------------------------------------

  function draw() {
    // The first drawing arrives; every one after it is the same screen saying
    // one thing differently. Rebuilt children would each fade back in from
    // nothing, so a switch flipped on the other phone read as the whole screen
    // blinking — the flash Status had, arrived at by another road.
    if (screen.firstElementChild) screen.classList.add('steady');
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
      mono: true,
      // An address shortened to fit is an address you cannot check.
      stacked: true
    });

    if (state.health != null) {
      row(connection, { label: 'Round trip', value: state.health + ' ms' });
    }

    row(connection, {
      label: 'Check again',
      tap: () => { state.connection = 'checking'; state.health = null; draw(); probe(); },
      chevron: true
    });

    drawAwake();

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
      label: 'Check this is your laptop',
      hint: state.showing ? null : 'Compare the letters with the ones on your laptop',
      value: state.showing ? null : 'Show',
      tap: () => { state.showing = state.showing ? null : (state.where.fingerprint || ''); draw(); },
      chevron: !state.showing
    });

    if (state.showing) {
      const proof = el('p', 'proof');
      proof.textContent = groups(state.showing);
      safety.parentNode.insertBefore(proof, safety.nextSibling);
    }

    drawLock();

    const permission = group('What this device may do',
      state.control === false
        ? 'Sending prompts is granted on the laptop: Devices → this device → Let this device send prompts.'
        : 'A prompt from this device runs on your laptop with the same permissions as one typed there.');

    row(permission, {
      label: 'Permission',
      value: state.control === null ? 'Unknown' : state.control ? 'Can send prompts' : 'Watching only',
      tone: state.control === false ? 'warn' : state.control ? 'good' : ''
    });

    drawDevices();

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

    // Being told with the phone locked and the app closed is not a second
    // switch: it is what notifications on means. Android does it with a
    // listener of the app's own, so this row only says whether it is working,
    // and the one under it fixes the usual reason it is not. iOS cannot listen
    // at all, and says so rather than offering a switch that would do nothing.
    const away = state.watching || { supported: false, running: false };
    if (wanted.on && allowed === 'granted') {
      if (away.supported) {
        const words = {
          listening: ['Listening', 'Notifications arrive with the phone locked or NikUI closed', 'good'],
          connecting: ['Connecting', 'Reaching your laptop', ''],
          refused: ['Reconnecting', 'Your laptop is handing this phone a new way in', ''],
          waiting: ['Waiting', 'For your laptop to be reachable — it tries again on its own', ''],
          off: ['Off', 'Starting…', '']
        }[away.state] || ['Off', 'Starting…', ''];
        row(telling, {
          label: 'While NikUI is closed',
          hint: words[1],
          value: words[0],
          tone: words[2]
        });
        if (!away.unrestricted) {
          row(telling, {
            label: 'Let it run in the background',
            hint: 'Battery saving can put NikUI to sleep, and then nothing arrives',
            value: 'Allow',
            tap: () => window.NikNotify.exempt(),
            chevron: true
          });
        }
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

    const slack = group('Slack');
    row(slack, {
      label: 'Slack',
      hint: 'Messages from your VIPs and @mentions',
      tap: () => app.go('slack.html'),
      chevron: true
    });

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

  /**
   * Whether the laptop may go to sleep — which is whether this phone will be
   * able to reach it later.
   *
   * Next to the connection because it is the same question asked about the
   * future: that one says whether the laptop is there now, this one whether it
   * will still be there tonight.
   *
   * Turning it off takes two taps, and the second says why. From the other side
   * of a country it is the one switch here that cannot be undone from here: a
   * laptop that has gone to sleep is not listening for a phone to wake it.
   */
  function drawAwake() {
    const now = state.awake;
    if (!now || !now.available) return;

    if (now.supported === false) {
      row(group('Your laptop'), {
        label: 'Keep awake',
        hint: 'Only a Mac can be kept awake from here.',
        value: 'Not on this laptop'
      });
      return;
    }

    const lid = now.lid && now.lid.supported ? now.lid : null;
    const list = group('Your laptop', lid && lid.on
      ? 'Keep awake stops it sleeping on its own while NikUI is open. With the lid closed it keeps going ' +
        'only while work is running, then sleeps. The screen still turns off.'
      : 'Stops it sleeping on its own while NikUI is open, so this phone can always reach it. ' +
        'The screen still turns off. Closing the lid still puts it to sleep.');

    const busy = (what) => state.switching && state.switching.what === what;
    const saying = (what) => (state.switching.on ? 'Turning it on…' : 'Turning it off…');

    const on = !!now.on;
    let hint;
    if (busy('awake')) hint = saying('awake');
    else if (!now.mayChange) hint = 'Only a device that may send prompts can change this.';
    else if (on && now.held) hint = 'Awake since ' + clock(now.since) + (now.reason ? ' · ' + now.reason : '');
    else if (on) hint = 'On, but your laptop could not hold itself awake.';
    else hint = 'Off. It sleeps when idle, and this phone cannot reach it until it wakes.';

    row(list, {
      label: 'Keep awake',
      hint,
      value: on ? 'On' : 'Off',
      tone: on ? (now.held ? 'good' : 'warn') : '',
      tap: now.mayChange && !state.switching
        ? (event) => (on
          ? arm(event, 'Tap again to let it sleep', 'Once it sleeps, this phone cannot wake it.',
            () => ask('awake', false))
          : ask('awake', true))
        : null
    });

    if (!lid) return;

    // The approval is a password dialog on the laptop's own screen, so it is
    // the one thing this switch cannot do from here — and says where to go.
    const unapproved = !lid.approved;
    let lidHint;
    if (busy('lid')) lidHint = saying('lid');
    else if (!now.mayChange) lidHint = 'Only a device that may send prompts can change this.';
    else if (unapproved) lidHint = 'Approve it once on your laptop: click NikUI in the status bar, then Keep working with the lid closed.';
    else if (lid.on && lid.lowBattery) lidHint = 'Battery at ' + lid.battery.percent + '%, so the lid will put it to sleep.';
    else if (lid.on && lid.held) lidHint = (lid.reason || 'Working') + ' · it sleeps when the work is done';
    else if (lid.on && lid.finishing) lidHint = 'The work is done. With the lid closed it sleeps in a moment.';
    else if (lid.on) lidHint = 'Closing the lid will not stop work that is running.';
    else lidHint = 'Off. Closing the lid stops everything.';

    row(list, {
      label: 'Keep working with the lid closed',
      hint: lidHint,
      value: lid.on ? 'On' : 'Off',
      tone: lid.on ? (unapproved || lid.lowBattery ? 'warn' : 'good') : '',
      tap: now.mayChange && !state.switching && !(unapproved && !lid.on)
        ? (event) => (lid.on
          // Off, with work running, is a laptop that sleeps now if it is shut.
          ? (lid.held
            ? arm(event, 'Tap again to turn it off', 'If the lid is closed, it goes to sleep now.',
              () => ask('lid', false))
            : ask('lid', false))
          : ask('lid', true))
        : null
    });
  }

  const ASKED = {
    awake: ['awake:set', 'It will stay awake.', 'It can sleep now.'],
    lid: ['lid:set', 'It will keep working with the lid closed.', 'Closing the lid puts it to sleep again.']
  };

  /** Ask the laptop to change one of them, and say so if it never answers. */
  function ask(what, on) {
    if (!transport || state.switching) return;
    state.switching = { what, on };
    draw();
    transport.postMessage({ type: ASKED[what][0], on: on });
    buzz('medium');
    if (state.switchTimer) clearTimeout(state.switchTimer);
    state.switchTimer = setTimeout(() => {
      state.switchTimer = null;
      if (!state.switching) return;
      state.switching = null;
      draw();
      flash('Your laptop did not answer.');
    }, 10000);
  }

  /** The first tap says what the second one does, in the row itself. */
  function arm(event, label, note, then) {
    const node = event.currentTarget;
    if (node.dataset.armed === '1') return then();
    const name = node.querySelector('b');
    const small = node.querySelector('small');
    const was = [name.textContent, small ? small.textContent : null];
    node.dataset.armed = '1';
    name.textContent = label;
    if (small) small.textContent = note;
    buzz('heavy');
    setTimeout(() => {
      if (!node.isConnected || node.dataset.armed !== '1') return;
      node.dataset.armed = '';
      name.textContent = was[0];
      if (small) small.textContent = was[1];
    }, 4000);
  }

  /**
   * The lock on this app's own front door.
   *
   * Worth being exact about what it is for, because the wrong idea about it
   * would be dangerous: it stops the person this phone is handed to. The laptop
   * is kept safe by the key in the chip, which the lock neither holds nor can
   * reach. This is the difference between someone borrowing your phone and
   * someone being able to send prompts to your machine.
   */
  function drawLock() {
    const lock = window.nikLock;
    if (!lock) return;
    const has = state.lock !== null ? state.lock : lock.on();
    const can = state.biometrics;

    const list = group('Lock this app',
      has
        ? 'Asked for once when the app opens, and again only after five minutes away. Moving between screens does not ask again.'
        : 'Anyone holding this phone unlocked can read every instance, and send prompts if this device may.');

    row(list, {
      label: 'Require a passcode',
      hint: has ? null : 'Four digits or more',
      value: has ? 'On' : 'Off',
      tone: has ? 'good' : '',
      tap: toggleLock
    });

    if (!has) return;

    row(list, { label: 'Change passcode', chevron: true, tap: changeCode });

    if (can && can.available) {
      const settings = lock.settings() || {};
      row(list, {
        label: 'Use ' + lock.named(can.kind),
        hint: 'Three tries, then the passcode.' +
          (can.finger && can.face ? ' Android chooses which it offers.' : ''),
        value: settings.biometric === false ? 'Off' : 'On',
        tone: settings.biometric === false ? '' : 'good',
        tap: () => {
          const now = lock.useBiometrics(settings.biometric === false);
          buzz('light');
          flash(now ? 'On.' : 'Off. The passcode is the only way in.');
          draw();
        }
      });
    } else if (can && can.reason) {
      row(list, { label: 'Face or fingerprint', value: 'Unavailable', hint: can.reason, stacked: true });
    }
  }

  function toggleLock() {
    const lock = window.nikLock;
    if (lock.on()) {
      // Turning it off needs the code, or it would not be a lock.
      lock.confirm('Enter your passcode to turn the lock off').then(() => lock.clear()).then(() => {
        state.lock = false;
        buzz('medium');
        flash('The lock is off.');
        draw();
      });
      return;
    }
    lock.choose().then(() => {
      state.lock = true;
      buzz('medium');
      flash('Locked. It will ask next time the app opens.');
      return lock.available().then((can) => { state.biometrics = can; });
    }).then(draw).catch(() => { /* cancelled, and nothing changed */ });
  }

  function changeCode() {
    const lock = window.nikLock;
    lock.confirm('Enter your current passcode')
      .then(() => lock.choose())
      .then(() => { buzz('medium'); flash('Passcode changed.'); draw(); })
      .catch(() => { /* cancelled */ });
  }

  /**
   * Everything paired with this laptop, and a way to take one off.
   *
   * The remove button used to live only on the laptop, which is the one place
   * you are not when you need it: a phone left in a taxi is unpaired from the
   * phone you still have, or not at all until you get home.
   *
   * Its own is always offered. Anyone else's needs the same permission as
   * sending a prompt, because it is the same kind of act — a change to what the
   * laptop will accept, rather than something you are reading — and a
   * watching-only device that could unpair the others would be a way to lock
   * somebody out of their own machine from a read-only seat.
   */
  function drawDevices() {
    if (!state.devices) return;

    const others = state.devices.filter((d) => !d.me).length;
    const list = group(
      others ? 'Devices' : 'Devices',
      state.mayManage
        ? 'Removing a device deletes the laptop\u2019s record of it. It cannot connect again without pairing.'
        : others
          ? 'Only a device that may send prompts can remove another. This one can still remove itself.'
          : 'Nothing else is paired with this laptop.');

    for (const device of state.devices) {
      const where = HELD[device.protection] || HELD.software;
      const when = device.here ? 'connected now' : 'last seen ' + ago(device.lastSeenAt);
      const may = device.me || state.mayManage;
      row(list, {
        label: device.name,
        hint: where + ' \u00b7 ' + when + (device.control ? ' \u00b7 can send prompts' : ''),
        value: device.me ? 'This device' : may ? 'Remove' : '',
        dot: device.here ? 'live' : null,
        tone: device.me ? '' : may ? 'danger' : '',
        stacked: true,
        tap: may ? (event) => armRemove(event, device) : null,
        chevron: may && !device.me
      });
    }
  }

  /**
   * Two taps, and the second one says what it is about to do by name.
   *
   * The same shape as forgetting the laptop, for the same reason: this is not
   * undoable from here, and a list of rows where one of them unpairs a phone is
   * a list somebody will hit by accident.
   */
  function armRemove(event, device) {
    const node = event.currentTarget;
    const name = node.querySelector('b');
    if (node.dataset.armed === '1') {
      if (!transport) return flash('Your laptop is not connected.');
      transport.postMessage({ type: 'forget', id: device.id });
      buzz('heavy');
      // Its own removal ends this device's pairing, so the key goes with it
      // rather than being left pointing at a record the laptop no longer has.
      if (device.me) handBack();
      return;
    }
    node.dataset.armed = '1';
    name.textContent = device.me ? 'Tap again to remove this device' : 'Tap again to remove ' + device.name;
    buzz('heavy');
    setTimeout(() => {
      if (!node.isConnected) return;
      node.dataset.armed = '';
      name.textContent = device.name;
    }, 4000);
  }

  /**
   * Delete this device's key and go back to the way in.
   *
   * Not immediately: a message written into a socket is not a message that has
   * left, and navigating away closes the socket underneath it — so the laptop
   * would keep a record of a device whose key no longer exists anywhere, which
   * is the one piece of litter this is supposed to avoid.
   *
   * A moment is enough for a round trip on a tailnet, and the key goes either
   * way. The person asked for it, and a laptop that cannot be reached is not a
   * reason to leave a key on a phone they are giving away.
   */
  function handBack() {
    flash('Handing this device back\u2026');
    setTimeout(() => {
      app.forget();
      window.location.replace('connect.html');
    }, 700);
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
        transport.postMessage({ type: 'devices' });
        transport.postMessage({ type: 'awake' });
        draw();
      } else if (message.type === 'awake') {
        // Changed here, on the other phone, or at the laptop: all three arrive
        // the same way, so the row cannot disagree with the machine.
        const asked = state.switching;
        if (state.switchTimer) { clearTimeout(state.switchTimer); state.switchTimer = null; }
        state.switching = null;
        state.awake = message;
        if (message.refused) flash(message.refused);
        else if (asked) {
          const now = asked.what === 'lid' ? !!(message.lid && message.lid.on) : !!message.on;
          flash(now ? ASKED[asked.what][1] : ASKED[asked.what][2]);
        }
        draw();
      } else if (message.type === 'devices') {
        if (message.refused) flash(message.refused);
        if (message.devices) {
          state.devices = message.devices;
          state.mayManage = !!message.mayManage;
          state.me = message.me || null;
        }
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

    // Never behind a face: the lock is the one place that asks for one.
    window.nikDevice.stageUpgrade({ biometric: false }).then(function () {
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
      // Nothing to listen for means nothing to stay awake for: setPref stops it.
      api.setPref('on', false);
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
      // On means with the phone locked too: start listening, and ask Android
      // once to leave it alone when saving battery.
      return api.listen().then((watching) => {
        state.watching = watching;
        draw();
        if (watching.supported && !watching.unrestricted) api.exempt();
      });
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
      'keep awake: ' + (state.awake && state.awake.available
        ? (state.awake.on ? 'on' : 'off') + (state.awake.held ? ', held since ' + new Date(state.awake.since).toISOString() : '')
        : 'not offered'),
      'lid closed: ' + (state.awake && state.awake.lid
        ? (state.awake.lid.on ? 'on' : 'off') + (state.awake.lid.approved ? '' : ', not approved') +
          (state.awake.lid.held ? ', holding' : '')
        : 'not offered'),
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
      // Tell the laptop first, so it does not keep a record of a device whose
      // key no longer exists.
      if (transport && state.me) {
        try { transport.postMessage({ type: 'forget', id: state.me }); } catch (_) { /* going anyway */ }
      }
      handBack();
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

  // Settings is a tab now, not a pushed screen: there is nothing to go back to
  // that the tab bar does not already offer.
  const back = document.getElementById('back');
  if (back) back.addEventListener('click', () => {
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
    if (window.nikLock) {
      state.lock = window.nikLock.on();
      window.nikLock.available().then((can) => { state.biometrics = can; draw(); });
    }
    if (window.NikNotify) {
      window.NikNotify.permission().then((verdict) => { state.notify = verdict; draw(); });
      window.NikNotify.background().then((watching) => { state.watching = watching; draw(); });
      // Coming back from Android's battery screen, or the listener getting through.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          window.NikNotify.background().then((watching) => { state.watching = watching; draw(); });
        }
      });
      setTimeout(() => window.NikNotify.background().then((watching) => { state.watching = watching; draw(); }), 3000);
      window.NikNotify.apple().then((apple) => { state.apple = apple; draw(); });
    }
  }
})();
