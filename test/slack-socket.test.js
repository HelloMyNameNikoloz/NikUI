'use strict';
const { createSocket, BACKOFF_MS } = require('../src/slack/socket.js');

/** A WebSocket that does nothing on its own: the test drives it by hand. */
function fakeWebSocket() {
  const instances = [];
  function FakeWS(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    instances.push(this);
  }
  FakeWS.prototype.send = function (data) { this.sent.push(data); };
  FakeWS.prototype.close = function () { this.closed = true; };
  FakeWS.instances = instances;
  return FakeWS;
}

/** A fake clock: setTimeout/clearTimeout that only fire when told to. */
function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fire: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
    pending: () => [...timers.values()].map((t) => t.ms)
  };
}

function fakeApi(opens) {
  const calls = [];
  return {
    calls,
    call: async (method, params, options) => {
      calls.push({ method, params, options });
      if (method === 'apps.connections.open') {
        const next = opens.shift();
        if (next instanceof Error) throw next;
        return next || { ok: true, url: 'wss://example/' + calls.length };
      }
      throw new Error('unexpected call ' + method);
    }
  };
}

module.exports = async function () {
  suite('Socket Mode');

  {
    const WS = fakeWebSocket();
    const api = fakeApi([]);
    const states = [];
    const events = [];
    const clock = fakeClock();
    const socket = createSocket({
      api, WebSocket: WS, onEvent: (e) => events.push(e), onState: (s) => states.push(s),
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    socket.start();
    await Promise.resolve(); await Promise.resolve();
    check('asked Slack for a URL with the app token', api.calls[0].options.app === true);
    const ws = WS.instances[0];
    check('connected to the URL Slack gave back', ws.url === 'wss://example/1');

    ws.onmessage({ data: JSON.stringify({ type: 'hello' }) });
    check('hello means live', states[states.length - 1].socket === 'live');

    ws.onmessage({ data: JSON.stringify({
      type: 'events_api', envelope_id: 'env-1',
      payload: { event: { type: 'message', text: 'hi' }, authorizations: [{ user_id: 'U1' }] }
    }) });
    checkEqual('an envelope is acked immediately', JSON.parse(ws.sent[0]).envelope_id, 'env-1');
    checkEqual('and the event is handed up', events[0].text, 'hi');

    ws.onclose();
    check('an unexpected close schedules a reconnect', clock.pending().length === 1);
    checkEqual('starting with the shortest backoff', clock.pending()[0], BACKOFF_MS[0]);
    clock.fire();
    await Promise.resolve(); await Promise.resolve();
    checkEqual('reconnecting asks for a fresh URL', api.calls.length, 2);

    socket.stop();
  }

  {
    // link_disabled: stop, and say so; no further reconnecting.
    const WS = fakeWebSocket();
    const api = fakeApi([]);
    const states = [];
    const clock = fakeClock();
    const socket = createSocket({ api, WebSocket: WS, onEvent: () => {}, onState: (s) => states.push(s),
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    socket.start();
    await Promise.resolve(); await Promise.resolve();
    const ws = WS.instances[0];
    ws.onmessage({ data: JSON.stringify({ type: 'disconnect', reason: 'link_disabled' }) });
    check('link_disabled is reported as off, with an error', states[states.length - 1].socket === 'off' && !!states[states.length - 1].error);
    checkEqual('and nothing is scheduled to reconnect', clock.pending().length, 0);
  }

  {
    // refresh_requested: reconnects with a fresh URL, not an error.
    const WS = fakeWebSocket();
    const api = fakeApi([]);
    const clock = fakeClock();
    const socket = createSocket({ api, WebSocket: WS, onEvent: () => {}, onState: () => {},
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    socket.start();
    await Promise.resolve(); await Promise.resolve();
    WS.instances[0].onmessage({ data: JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }) });
    await Promise.resolve(); await Promise.resolve();
    checkEqual('a requested refresh gets a second connection straight away', WS.instances.length, 2);
    socket.stop();
  }

  {
    // invalid_auth on opening: stop outright.
    const WS = fakeWebSocket();
    const api = fakeApi([Object.assign(new Error('bad token'), { code: 'invalid_auth' })]);
    const states = [];
    const clock = fakeClock();
    const socket = createSocket({ api, WebSocket: WS, onEvent: () => {}, onState: (s) => states.push(s),
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    socket.start();
    await Promise.resolve(); await Promise.resolve();
    check('reports it is off, with an error', states[states.length - 1].socket === 'off' && !!states[states.length - 1].error);
    checkEqual('and does not try again', WS.instances.length, 0);
  }

  {
    // No WebSocket anywhere — not injected, and none global either.
    const states = [];
    const saved = globalThis.WebSocket;
    delete globalThis.WebSocket;
    try {
      const socket = createSocket({ api: fakeApi([]), onEvent: () => {}, onState: (s) => states.push(s) });
      socket.start();
      checkEqual('missing WebSocket reports unavailable', states[0].socket, 'unavailable');
    } finally {
      globalThis.WebSocket = saved;
    }
  }

  {
    // Backoff grows on repeated failures, capped at the last step.
    const WS = fakeWebSocket();
    const api = fakeApi([new Error('down'), new Error('down'), new Error('down')]);
    const clock = fakeClock();
    const socket = createSocket({ api, WebSocket: WS, onEvent: () => {}, onState: () => {},
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    socket.start();
    await Promise.resolve(); await Promise.resolve();
    const delays = [];
    for (let i = 0; i < 3; i++) {
      delays.push(clock.pending()[0]);
      clock.fire();
      await Promise.resolve(); await Promise.resolve();
    }
    checkEqual('backoff grows with each failure', delays, [BACKOFF_MS[0], BACKOFF_MS[1], BACKOFF_MS[2]]);
    socket.stop();
  }
};
