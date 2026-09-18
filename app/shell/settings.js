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
    health: null            // round trip in ms, when it answered
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
    row(identity, { label: 'Its key', value: shortKey(state.device && state.device.publicKey), mono: true });
    row(identity, { label: 'Laptop key pinned', value: shortKey(state.where.fingerprint), mono: true });
    row(identity, { label: 'Paired', value: ago(state.where.pairedAt) });

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
    row(about, { label: 'App', value: state.version.app, mono: true });
    row(about, { label: 'Client', value: state.version.client, mono: true,
      hint: 'The same files the editor’s panel runs' });
    row(about, {
      label: 'Copy diagnostics',
      hint: 'Everything on this screen, as text',
      tap: copyDiagnostics,
      chevron: true
    });

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
        state.connection = 'live';
        state.control = message.device ? message.device.control !== false : null;
        draw();
      } else if (message.type === '@denied') {
        state.connection = 'refused';
        draw();
      }
    });
  }

  function copyDiagnostics() {
    const lines = [
      'NikUI app ' + state.version.app + ' · client ' + state.version.client,
      'laptop: ' + state.where.scheme + '://' + state.where.host,
      'connection: ' + state.connection + (state.health != null ? ' (' + state.health + ' ms)' : ''),
      'permission: ' + (state.control === null ? 'unknown' : state.control ? 'can steer' : 'watching only'),
      'device id: ' + ((state.device && state.device.id) || 'not paired'),
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
    if (window.nikDevice && window.nikDevice.available()) {
      window.nikDevice.load().then((record) => { state.device = record; draw(); }).catch(() => {});
    }
    probe();
  }
})();
