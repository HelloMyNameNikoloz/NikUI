/* The window as a whole.

   Not one conversation — what all of them add up to. What is running, what it
   has cost, what the quota is doing, whether the laptop is being held awake,
   and what can reach it. The same facts the editor's status sheet shows,
   gathered for a screen rather than for a sheet inside a conversation. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = window.NikApp;
  const where = app.requireLaptop();
  if (!where) return;

  const screen = $('screen');
  const state = { stats: null, trouble: null };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const money = (value) => '$' + (Number(value) || 0).toFixed(2);

  const ago = (at) => {
    if (!at) return 'never';
    const ms = Date.now() - at;
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
    return Math.round(ms / 86400000) + 'd ago';
  };

  const when = (at) => {
    if (!at) return null;
    const left = at - Date.now();
    if (left <= 0) return 'now';
    const mins = Math.round(left / 60000);
    if (mins < 60) return 'in ' + mins + 'm';
    return 'at ' + new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  /** A row of big numbers, which is what somebody opens this screen for. */
  function tiles(into, items) {
    const grid = el('div', 'tiles');
    for (const [value, label, tone] of items) {
      const tile = el('div', 'tile' + (tone ? ' ' + tone : ''));
      tile.appendChild(el('div', 'tile-value', String(value)));
      tile.appendChild(el('div', 'tile-label', label));
      grid.appendChild(tile);
    }
    into.appendChild(grid);
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

  function row(list, label, value, tone) {
    const node = el('div', 'row' + (tone ? ' ' + tone : ''));
    const left = el('div', 'row-label');
    left.appendChild(el('b', null, label));
    node.appendChild(left);
    const right = el('div', 'row-value');
    right.appendChild(el('span', null, value == null ? '—' : String(value)));
    node.appendChild(right);
    list.appendChild(node);
    return node;
  }

  const STATUS = [
    ['working', 'Working', 'good'],
    ['waiting', 'Waiting for you', 'warn'],
    ['done', 'Finished', ''],
    ['idle', 'Idle', ''],
    ['error', 'Failed', 'bad'],
    ['stopped', 'Stopped', '']
  ];

  function draw() {
    screen.textContent = '';
    const s = state.stats;

    if (!s) {
      screen.appendChild(el('p', 'lede', state.trouble || 'Looking…'));
      return;
    }

    const waiting = s.byStatus.waiting || 0;
    tiles(screen, [
      [s.instances, s.instances === 1 ? 'instance' : 'instances', ''],
      [money(s.cost), 'this window', ''],
      [waiting, waiting === 1 ? 'needs you' : 'need you', waiting ? 'warn' : '']
    ]);

    const what = group('What they are doing');
    let any = false;
    for (const [key, label, tone] of STATUS) {
      const count = s.byStatus[key] || 0;
      if (!count) continue;
      any = true;
      row(what, label, count, tone);
    }
    if (!any) row(what, 'Nothing is running', '—');
    if (s.queued) row(what, 'Queued prompts', s.queued);

    // The quota is the thing most worth knowing from a phone: everything stops
    // when it runs out, and it comes back on a clock.
    const quota = group('Usage');
    if (s.pause && s.pause.until) {
      row(quota, 'Everything is holding', when(s.pause.until), 'warn');
      row(quota, 'Queues', 'untouched');
    } else {
      row(quota, 'Everything is running', 'yes', 'good');
    }
    if (s.limits) {
      if (s.limits.resetsAt) row(quota, 'Limit resets', when(s.limits.resetsAt));
      if (s.limits.used != null && s.limits.total != null) {
        row(quota, 'Used', s.limits.used + ' of ' + s.limits.total);
      }
    }

    const machine = group('Your laptop');
    row(machine, 'Held awake', s.awake && s.awake.holding ? 'yes' : 'no',
      s.awake && s.awake.holding ? 'good' : '');
    if (s.awake && s.awake.why) row(machine, 'Because', s.awake.why);
    if (s.reach) {
      row(machine, 'Connections', s.reach.sealed ? 'must be sealed' : 'may be plain',
        s.reach.sealed ? 'good' : 'warn');
      row(machine, 'Serves', s.reach.appOnly ? 'the app only' : 'the app and a page');
    }
    if (s.version) row(machine, 'Client', s.version);

    const seen = group('Devices paired with it',
      'Every phone that can watch this window. Sending prompts is granted on the laptop.');
    if (!s.devices.length) row(seen, 'None yet', '—');
    for (const device of s.devices) {
      row(seen, device.name,
        (device.control ? 'can send' : 'watching') + ' · ' + ago(device.lastSeenAt),
        device.control ? 'warn' : '');
    }
  }

  // ---- where it comes from ---------------------------------------------------

  window.NIKUI_REMOTE = app.remote(null);
  const transport = window.nikTransport();
  let asked = null;

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === '@welcome' || message.type === '@device') {
      transport.postMessage({ type: 'stats' });
      // Numbers that stop moving are numbers nobody trusts.
      if (!asked) asked = setInterval(() => transport.postMessage({ type: 'stats' }), 4000);
      return;
    }
    if (message.type === 'fleet') return void transport.postMessage({ type: 'stats' });
    if (message.type !== 'stats') return;
    state.stats = message;
    state.trouble = null;
    draw();
  });

  setTimeout(() => {
    if (!state.stats) { state.trouble = 'Cannot reach the laptop.'; draw(); }
  }, 15000);

  draw();
})();
