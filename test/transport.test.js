'use strict';

// The browser half of the transport seam, driven without a browser: a fake
// socket, a fake pill, a fake localStorage. What a real browser does with it is
// test/remote.check.js; what it does when the network goes away is here,
// because that is the case you cannot stage on a desk.

const listeners = { window: {}, document: {} };
const sockets = [];

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  // What the network does to it, from the test's side.
  accept() { this.readyState = 1; if (this.onopen) this.onopen(); }
  deliver(message) { if (this.onmessage) this.onmessage({ data: JSON.stringify(message) }); }
  drop() { this.readyState = 3; if (this.onclose) this.onclose(); }
}

const pill = {
  className: '', textContent: '', hidden: true, clicks: [],
  addEventListener: (name, fn) => { pill.clicks.push({ name, fn }); },
  click: () => pill.clicks.forEach((c) => c.fn())
};
const stored = {};
const delivered = [];

function target(bag) {
  return {
    addEventListener: (name, fn) => { (bag[name] = bag[name] || []).push(fn); },
    removeEventListener: () => {},
    fire: (name, event) => { for (const fn of bag[name] || []) fn(event || {}); }
  };
}

const windowEvents = target(listeners.window);
const documentEvents = target(listeners.document);

global.MessageEvent = class { constructor(type, init) { this.type = type; this.data = (init || {}).data; } };
global.WebSocket = FakeSocket;
global.window = {
  addEventListener: windowEvents.addEventListener,
  removeEventListener: windowEvents.removeEventListener,
  dispatchEvent: (event) => { delivered.push(event.data); return true; },
  location: { href: 'http://127.0.0.1:4517/s/nik-1', protocol: 'http:' },
  localStorage: {
    getItem: (k) => (k in stored ? stored[k] : null),
    setItem: (k, v) => { stored[k] = v; }
  },
  NIKUI_REMOTE: { session: 'nik-1', socket: '/socket?session=nik-1' }
};
global.document = {
  hidden: false,
  getElementById: (id) => (id === 'link' ? pill : null),
  addEventListener: documentEvents.addEventListener
};

// A device identity, as media/device.js would provide it.
const identity = { record: { id: 'dev-1', fingerprint: 'fp-1', publicKey: 'pk' }, signed: [] };
global.window.nikDevice = {
  available: () => true,
  load: () => Promise.resolve(identity.record),
  ensure: () => Promise.resolve(identity.record),
  sign: (message) => { identity.signed.push(message); return Promise.resolve('signature-for-' + message); }
};
global.window.crypto = { getRandomValues: (bytes) => { for (let i = 0; i < bytes.length; i++) bytes[i] = i + 1; return bytes; } };
global.window.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64');

const { socketTransport } = require('../media/transport.js');

/** What the server sends a socket it has already recognised. */
const welcome = (socket, control) => socket.deliver({
  type: '@welcome', device: { id: 'local', name: 'This machine', kind: 'local', control: control !== false }
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** setTimeout, seen and controlled. */
function withFakeClock(fn) {
  const real = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (cb, ms) => { scheduled.push({ cb, ms }); return { unref() {} }; };
  try { return fn(scheduled); } finally { global.setTimeout = real; }
}

module.exports = async function () {
  suite('which host is this');

  global.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
  const inPanel = global.window.nikTransport();
  check('in the panel the transport is the editor API, untouched', typeof inPanel.__socket !== 'function');
  delete global.acquireVsCodeApi;

  suite('in a browser it is a socket wearing the same three methods');

  let clock = null;
  const transport = withFakeClock((scheduled) => { clock = scheduled; return socketTransport(global.window.NIKUI_REMOTE); });
  const first = sockets[sockets.length - 1];
  checkEqual('it opens a socket next to the page it was served from',
    first.url, 'ws://127.0.0.1:4517/socket?session=nik-1');
  checkEqual('and says so while it is trying', pill.textContent, 'Connecting…');

  transport.postMessage({ type: 'ready' });
  checkEqual('a message sent before it is open is not lost down a hole', first.sent.length, 0);
  check('and the client is told where it stands', /Connecting|Signing|Offline/.test(pill.textContent));

  first.accept();
  checkEqual('an open socket says nothing until it has a seat', first.sent, []);
  checkEqual('and says so', pill.textContent, 'Signing in…');

  welcome(first);
  checkEqual('the moment it is let in, the client says hello again', first.sent, [{ type: 'ready' }]);
  checkEqual('and the state is visible', [pill.className, pill.textContent], ['link on', 'Live']);

  transport.postMessage({ type: 'send', text: 'hello', sent: 'hello', snippets: [] });
  checkEqual('a prompt goes out as it is', first.sent[1], { type: 'send', text: 'hello', sent: 'hello', snippets: [] });

  first.deliver({ type: 'items', items: [{ id: 'a', kind: 'text', text: 'hi' }] });
  checkEqual('what comes back arrives as a message event, parsed',
    delivered[delivered.length - 1].items[0].text, 'hi');

  suite('state outlives the page');

  transport.setState({ sessionId: 'nik-1', draft: 'half typed' });
  checkEqual('what the client keeps is written down', JSON.parse(stored['nikui:nik-1']).draft, 'half typed');
  checkEqual('and read back', transport.getState().draft, 'half typed');

  suite('when the network goes away');

  const before = delivered.length;
  withFakeClock((scheduled) => {
    clock = scheduled;
    first.drop();
  });
  checkEqual('the client is told it is offline', pill.className, 'link off');
  check('and a reconnect is queued rather than hammered', clock.length === 1 && clock[0].ms >= 400);

  transport.postMessage({ type: 'send', text: 'typed while offline', sent: 'typed while offline', snippets: [] });
  checkEqual('a prompt sent with no socket is refused, not swallowed', delivered.length, before + 1);
  checkEqual('and the words come straight back to the composer',
    delivered[delivered.length - 1], { type: 'editPrompt', text: 'typed while offline' });
  check('with the reason on screen', /not sent/.test(pill.textContent));

  transport.postMessage({
    type: 'send', text: 'with a photo', sent: 'with a photo', snippets: [],
    attachments: [{ name: 'a.png' }]
  });
  check('and it says when an image could not be kept', /images dropped/.test(pill.textContent));

  suite('and when it comes back');

  withFakeClock((scheduled) => {
    clock = scheduled;
    windowEvents.fire('online');
  });
  const second = sockets[sockets.length - 1];
  check('coming back online reconnects at once, not after the backoff', second !== first);
  second.accept();
  welcome(second);
  checkEqual('and the client asks for the whole picture again', second.sent, [{ type: 'ready' }]);
  checkEqual('which is the same path a discarded webview takes', pill.textContent, 'Live');

  withFakeClock(() => {
    global.document.hidden = false;
    second.drop();
    documentEvents.fire('visibilitychange');
  });
  check('a phone waking up reconnects too', sockets.length > 2);

  suite('proving which device this is');

  const signing = withFakeClock(() => socketTransport({ session: 'nik-3', socket: '/socket?session=nik-3' }));
  const asked = sockets[sockets.length - 1];
  asked.accept();
  asked.deliver({ type: '@challenge', nonce: 'server-nonce', fingerprint: 'fp-1', serverKey: 'spki' });
  await settle();
  const answer = asked.sent.find((m) => m.type === '@auth');
  check('a challenge is answered with a signature', !!answer);
  checkEqual('by the device that paired', answer && answer.device, 'dev-1');
  check('over the server nonce and one of its own',
    /^nikui-auth:server-nonce:/.test(identity.signed[identity.signed.length - 1]));
  check('and the nonce is not reused', answer && answer.nonce && answer.nonce.length >= 16);
  checkEqual('nothing else is sent until the server answers',
    asked.sent.filter((m) => m.type !== '@auth').length, 0);
  check('and the transport still answers', typeof signing.postMessage === 'function');

  const laptopSwapped = withFakeClock(() => socketTransport({ session: 'nik-4', socket: '/socket?session=nik-4' }));
  const suspicious = sockets[sockets.length - 1];
  suspicious.accept();
  suspicious.deliver({ type: '@challenge', nonce: 'n', fingerprint: 'a-different-laptop', serverKey: 'spki' });
  await settle();
  check('a laptop that is not the one this device paired with is refused',
    !suspicious.sent.some((m) => m.type === '@auth'));
  check('and the client is told why', /not the laptop/i.test(pill.textContent));
  check('rather than signing anyway', laptopSwapped.__state() !== 'online');

  suite('trying again on purpose');

  const stuck = withFakeClock((scheduled) => {
    const t = socketTransport({ session: 'nik-5', socket: '/socket?session=nik-5' });
    sockets[sockets.length - 1].drop();
    scheduled.length = 0;
    return t;
  });
  const waiting = sockets.length;
  withFakeClock(() => pill.click());
  check('tapping the connection state tries again at once', sockets.length > waiting);
  check('and the transport offers the same as a function', typeof stuck.retry === 'function');

  suite('backoff');

  const waits = [];
  const fresh = withFakeClock((scheduled) => {
    const t = socketTransport({ session: 'nik-2', socket: '/socket?session=nik-2' });
    for (let i = 0; i < 4; i++) {
      scheduled.length = 0;
      sockets[sockets.length - 1].drop();
      waits.push(scheduled[0].ms);
      scheduled[0].cb();   // the retry fires, and that attempt fails too
    }
    return t;
  });
  check('each failure waits longer than the last', waits[1] > waits[0] && waits[2] > waits[1]);
  check('but never longer than a quarter of a minute', waits.every((ms) => ms < 15000));
  check('and the transport still answers', typeof fresh.postMessage === 'function');

  delete global.window;
  delete global.document;
  delete global.WebSocket;
  delete global.MessageEvent;
};
