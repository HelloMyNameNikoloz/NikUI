/* A command on the laptop, from the phone.

   Not a terminal emulator, and it does not pretend to be one. There is no PTY
   behind it, so there is nothing for `vim` to draw on and nowhere for `sudo` to
   ask — and a phone is a bad place for either. What this is instead is the
   thing a terminal is usually a clumsy way of getting: a command, its output,
   and whether it worked.

   That shape is what makes it readable on a phone. Each run is a block you can
   see the start and end of, with the exit code on it, rather than a scrolling
   wall you have to find your place in. Failed ones are marked, so scrolling
   back to "which one broke" is looking rather than reading.

   It needs the same grant as sending a prompt, and for the same reason: this
   runs commands on somebody's machine. The laptop enforces that; this screen
   only says so. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = window.NikApp;
  const where = app.requireLaptop();
  if (!where) return;

  const screen = $('screen');
  const runner = $('runner');
  const field = $('command');
  const go = $('go');
  const link = $('link');
  const pick = $('pick');

  const state = {
    connected: false,
    control: null,
    terminal: null,     // the one this screen is looking at
    terminals: [],      // every one this window has open
    runs: [],           // what has been run in it, oldest first
    trouble: null,
    instances: []       // somewhere to root a new one
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const shortPath = (full) => {
    const parts = String(full || '').split('/').filter(Boolean);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : (full || '');
  };

  const took = (ms) => (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's');

  // ---- what the screen says ---------------------------------------------------

  function draw() {
    screen.textContent = '';

    if (state.trouble) {
      screen.appendChild(el('p', 'lede', state.trouble));
      runner.hidden = true;
      return;
    }

    if (state.control === false) {
      screen.appendChild(el('p', 'lede',
        'This device can watch, but not run commands. Grant it control on the laptop: ' +
        'Devices → this device → Let this device send prompts.'));
      runner.hidden = true;
      return;
    }

    if (!state.terminal) {
      const lede = el('p', 'lede', state.connected
        ? 'Run a command on your laptop. It runs where the instance you pick is, and it can do anything you could type there.'
        : 'Waiting for your laptop…');
      screen.appendChild(lede);
      if (state.connected) screen.appendChild(opener());
      runner.hidden = true;
      pick.hidden = true;
      return;
    }

    pick.hidden = false;
    pick.textContent = shortPath(state.terminal.cwd);
    runner.hidden = false;

    if (!state.runs.length) {
      screen.appendChild(el('p', 'lede', 'Nothing run yet. The command runs in ' +
        shortPath(state.terminal.cwd) + '.'));
    }

    for (const run of state.runs) screen.appendChild(drawRun(run));
    toBottom();
  }

  /** Where a new one should be rooted: beside an instance, or wherever. */
  function opener() {
    const list = el('div', 'list');
    const wrap = el('section', 'group');
    wrap.appendChild(el('div', 'group-title', 'Open a terminal'));
    wrap.appendChild(list);

    if (!state.instances.length) {
      const one = el('button', 'row tappable');
      one.type = 'button';
      const left = el('div', 'row-label');
      left.appendChild(el('b', null, 'In this window'));
      one.appendChild(left);
      one.appendChild(el('div', 'row-value chevron'));
      one.addEventListener('click', () => open(null));
      list.appendChild(one);
      return wrap;
    }

    for (const instance of state.instances) {
      const row = el('button', 'row tappable stacked');
      row.type = 'button';
      const left = el('div', 'row-label');
      left.appendChild(el('b', null, instance.label));
      left.appendChild(el('small', null, shortPath(instance.cwd)));
      row.appendChild(left);
      row.appendChild(el('div', 'row-value chevron'));
      row.addEventListener('click', () => open(instance.id));
      list.appendChild(row);
    }
    return wrap;
  }

  function drawRun(run) {
    const block = el('article', 'run' + (run.done && run.exit !== 0 && run.exit !== null ? ' bad' : '') +
      (!run.done ? ' going' : ''));

    const head = el('header', 'run-head');
    head.appendChild(el('span', 'run-prompt', '$'));
    head.appendChild(el('span', 'run-command', run.command));
    block.appendChild(head);

    if (run.output) {
      const out = el('pre', 'run-out');
      out.textContent = run.output;
      block.appendChild(out);
    }

    const foot = el('footer', 'run-foot');
    if (!run.done) {
      foot.appendChild(el('span', 'run-state going', 'Running…'));
      const stop = el('button', 'run-stop', 'Stop');
      stop.type = 'button';
      stop.addEventListener('click', () => transport.postMessage({ type: 'term:stop', id: state.terminal.id }));
      foot.appendChild(stop);
    } else if (run.note) {
      foot.appendChild(el('span', 'run-state bad', run.note));
    } else if (run.exit === 0) {
      foot.appendChild(el('span', 'run-state good', 'Done' + (run.tookMs ? ' · ' + took(run.tookMs) : '')));
    } else {
      foot.appendChild(el('span', 'run-state bad', 'Exit ' + run.exit +
        (run.tookMs ? ' · ' + took(run.tookMs) : '')));
    }

    const again = el('button', 'run-again', 'Run again');
    again.type = 'button';
    again.addEventListener('click', () => send(run.command));
    if (run.done) foot.appendChild(again);

    block.appendChild(foot);
    return block;
  }

  /** New output belongs at the bottom, unless you had scrolled up to read. */
  function toBottom(force) {
    const near = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 120;
    if (force || near) screen.scrollTop = screen.scrollHeight;
  }

  // ---- doing things -----------------------------------------------------------

  function open(sessionId) {
    transport.postMessage({ type: 'term:open', session: sessionId || undefined });
  }

  function send(command) {
    const text = String(command || '').trim();
    if (!text || !state.terminal) return;
    if (state.runs.some((r) => !r.done)) return flash('Still running. Stop it first.');
    transport.postMessage({ type: 'term:run', id: state.terminal.id, command: text });
    field.value = '';
  }

  let saying = null;
  function flash(words) {
    if (saying) saying.remove();
    saying = el('div', 'flash', words);
    document.body.appendChild(saying);
    setTimeout(() => { if (saying) { saying.remove(); saying = null; } }, 2600);
  }

  runner.addEventListener('submit', (event) => {
    event.preventDefault();
    send(field.value);
  });

  // Switching the folder is switching terminals, which is also how you close
  // the one you are in: a screen with no list is a screen with no way back.
  pick.addEventListener('click', () => {
    state.terminal = null;
    state.runs = [];
    transport.postMessage({ type: 'term:list' });
    draw();
  });

  // ---- where it comes from ----------------------------------------------------

  window.NIKUI_REMOTE = app.remote(null);
  const transport = window.nikTransport();

  const said = (run) => {
    const at = state.runs.findIndex((r) => r.id === run.id);
    if (at >= 0) state.runs[at] = Object.assign({}, state.runs[at], run);
    else state.runs.push(run);
  };

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;

    if (message.type === '@welcome' || message.type === '@device') {
      state.connected = true;
      state.control = message.device ? message.device.control !== false : true;
      if (link) { link.hidden = false; link.className = 'link'; link.textContent = 'Live'; }
      transport.postMessage({ type: 'ready' });
      if (state.control) transport.postMessage({ type: 'term:list' });
      draw();
      return;
    }

    if (message.type === 'fleet') {
      state.instances = (message.instances || []).map((one) => ({
        id: one.id, label: one.label, cwd: one.cwd
      }));
      if (!state.terminal) draw();
      return;
    }

    if (message.type === 'term:list') {
      state.terminals = message.terminals || [];
      // Straight into the one that is already there: a screen that made you
      // choose every time would be a screen you stopped opening.
      const wanted = window.sessionStorage.getItem('nikui.app.terminal');
      const mine = state.terminals.find((t) => t.id === wanted) || state.terminals[0] || null;
      if (mine) {
        state.terminal = mine;
        transport.postMessage({ type: 'term:attach', id: mine.id });
      }
      draw();
      return;
    }

    if (message.type === 'term:opened') {
      state.terminal = message.terminal;
      state.runs = [];
      try { window.sessionStorage.setItem('nikui.app.terminal', message.terminal.id); } catch (_) { /* fine */ }
      draw();
      // Something Claude told you to run, carried here from the conversation.
      if (waiting) { const command = waiting; waiting = null; send(command); }
      else field.focus();
      return;
    }

    if (message.type === 'term:scrollback') {
      state.terminal = message.terminal;
      state.runs = message.runs || [];
      draw();
      toBottom(true);
      if (waiting) { const command = waiting; waiting = null; send(command); }
      return;
    }

    if (message.type === 'term:began') {
      said(message.run);
      draw();
      toBottom(true);
      return;
    }

    if (message.type === 'term:out') {
      const run = state.runs.find((r) => r.id === message.run);
      if (!run) return;
      run.output = (run.output || '') + message.text;
      // Redrawing the whole screen for every chunk of a build's output would
      // be a screen that never settles; only the block that changed moves.
      const block = screen.querySelectorAll('.run')[state.runs.indexOf(run)];
      const out = block && block.querySelector('.run-out');
      if (out) { out.textContent = run.output; toBottom(); }
      else draw();
      return;
    }

    if (message.type === 'term:done') {
      said(message.run);
      draw();
      return;
    }

    if (message.type === 'term:closed') {
      if (state.terminal && state.terminal.id === message.id) {
        state.terminal = null;
        state.runs = [];
      }
      draw();
      return;
    }

    if (message.type === 'term:no') {
      if (/watch/.test(message.reason || '')) state.control = false;
      flash(message.reason || 'That would not run.');
      draw();
      return;
    }

    if (message.type === '@denied') {
      state.trouble = 'This laptop would not have this device.';
      draw();
    }
  });

  // A command sent here from a conversation, to be run as soon as there is
  // somewhere to run it.
  let waiting = (() => {
    const asked = app.params().get('run');
    if (!asked) return null;
    // Taken out of the address at once, so a reload does not run it twice.
    try { window.history.replaceState(null, '', 'terminal.html'); } catch (_) { /* fine */ }
    return asked;
  })();

  if (waiting) {
    const beside = app.params().get('session');
    // Opening is what makes somewhere to run it; the reply carries on from there.
    setTimeout(() => { if (state.connected && !state.terminal) open(beside); }, 300);
  }

  setTimeout(() => {
    if (state.connected || state.trouble) return;
    state.trouble = 'Cannot reach the laptop.';
    draw();
  }, 8000);

  draw();
})();
