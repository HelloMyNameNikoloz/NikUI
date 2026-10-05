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
identity.verdict = true;
identity.asked = [];
identity.settled = [];
global.window.nikDevice = {
  available: () => true,
  load: () => Promise.resolve(identity.record),
  ensure: () => Promise.resolve(identity.record),
  sign: (message) => { identity.signed.push(message); return Promise.resolve('signature-for-' + message); },
  authMessage: (record, theirs, mine) => {
    const words = identity.record && identity.record.staged
      ? 'nikui-rekey:' + theirs + ':' + mine + ':new-key'
      : 'nikui-auth:' + theirs + ':' + mine;
    identity.signed.push(words);
    const message = { type: '@auth', device: record.id, nonce: mine, signature: 'signature-for-' + words };
    if (identity.record && identity.record.staged) message.rekey = { publicKey: 'new-spki', signature: 'proof' };
    return Promise.resolve(message);
  },
  commitUpgrade: () => { identity.settled.push('committed'); return Promise.resolve({}); },
  discardUpgrade: () => { identity.settled.push('discarded'); return Promise.resolve({}); },
  verifyLaptop: (record, key, message, signature) => {
    identity.asked.push({ key, message, signature });
    return Promise.resolve(identity.verdict);
  }
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
  checkEqual('the moment it is let in, the client says hello again', first.sent, [{ type: 'ready', hidden: false }]);
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
  // Not during the send: the client clears its composer on the line after
  // postMessage returns, so handing the words back inside that call would mean
  // handing them straight into the clearing.
  checkEqual('nothing is handed back while the client is still sending', delivered.length, before);
  await settle();
  checkEqual('a prompt sent with no socket is refused, not swallowed', delivered.length, before + 1);
  checkEqual('and the words come back to the composer once it has finished',
    delivered[delivered.length - 1], { type: 'editPrompt', text: 'typed while offline' });
  check('with the reason on screen', /not sent/.test(pill.textContent));
  await settle();
  check('and the reason is not overwritten by the connection check behind it',
    /not sent/.test(pill.textContent));

  transport.postMessage({
    type: 'send', text: 'with a photo', sent: 'with a photo', snippets: [],
    attachments: [{ name: 'a.png' }]
  });
  await settle();
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
  checkEqual('and the client asks for the whole picture again', second.sent, [{ type: 'ready', hidden: false }]);
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

  suite('and the laptop has to prove itself back');

  const proving = withFakeClock(() => socketTransport({ session: 'nik-6', socket: '/socket?session=nik-6' }));
  const proven = sockets[sockets.length - 1];
  proven.accept();
  proven.deliver({ type: '@challenge', nonce: 'their-nonce', fingerprint: 'fp-1', serverKey: 'their-spki' });
  await settle();
  const answered = proven.sent.find((m) => m.type === '@auth');
  proven.deliver({ type: '@welcome', device: { control: true }, signature: 'from-the-laptop' });
  await settle();
  checkEqual('the welcome is checked, not taken on trust', identity.asked.length, 1);
  checkEqual('against the key the challenge offered', identity.asked[0].key, 'their-spki');
  checkEqual('over the nonces of this connection, in the order it signed them',
    identity.asked[0].message, 'nikui-auth' === 'x' ? '' : 'nikui-host:' + answered.nonce + ':their-nonce');
  checkEqual('and only then is the socket live', proving.__state(), 'online');

  identity.verdict = false;
  identity.asked.length = 0;
  const impostor = withFakeClock(() => socketTransport({ session: 'nik-7', socket: '/socket?session=nik-7' }));
  const pretending = sockets[sockets.length - 1];
  pretending.accept();
  pretending.deliver({ type: '@challenge', nonce: 'n', fingerprint: 'fp-1', serverKey: 'not-the-laptop' });
  await settle();
  pretending.deliver({ type: '@welcome', device: { control: true }, signature: 'forged' });
  await settle();
  checkEqual('a laptop that cannot sign for its key gets nothing', impostor.__state() !== 'online', true);
  check('the client is told which way it went wrong', /not the laptop/i.test(pill.textContent));
  checkEqual('and nothing was said on that socket',
    pretending.sent.filter((m) => m.type !== '@auth').length, 0);
  identity.verdict = true;

  suite('moving this device’s key into the chip');

  identity.record.staged = { publicKey: 'new-spki' };
  identity.settled.length = 0;
  const moving = withFakeClock(() => socketTransport({ session: 'nik-8', socket: '/socket?session=nik-8' }));
  const movingSocket = sockets[sockets.length - 1];
  movingSocket.accept();
  movingSocket.deliver({ type: '@challenge', nonce: 'n8', fingerprint: 'fp-1', serverKey: 'their-spki' });
  await settle();
  const carrying = movingSocket.sent.find((m) => m.type === '@auth');
  check('the answer carries the replacement key', !!(carrying && carrying.rekey));
  check('signed over words that name it, not a plain answer',
    identity.signed.some((m) => m.indexOf('nikui-rekey:n8:') === 0));

  movingSocket.deliver({
    type: '@welcome', device: { control: true }, signature: 'from-the-laptop',
    rekeyed: { fingerprint: 'new-fp', protection: 'secure-enclave' }
  });
  await settle();
  checkEqual('a laptop that took it makes the move final', identity.settled, ['committed']);
  checkEqual('and the socket is live', moving.__state(), 'online');

  identity.settled.length = 0;
  const ignoring = withFakeClock(() => socketTransport({ session: 'nik-9', socket: '/socket?session=nik-9' }));
  const ignoringSocket = sockets[sockets.length - 1];
  ignoringSocket.accept();
  ignoringSocket.deliver({ type: '@challenge', nonce: 'n9', fingerprint: 'fp-1', serverKey: 'their-spki' });
  await settle();
  ignoringSocket.deliver({ type: '@welcome', device: { control: true }, signature: 'from-the-laptop' });
  await settle();
  checkEqual('a laptop that did not take it leaves nothing half-moved', identity.settled, ['discarded']);
  check('and the device is still connected with the key it already had',
    ignoring.__state() === 'online');
  delete identity.record.staged;

  suite('coming back');

  const napping = withFakeClock((scheduled) => {
    const t = socketTransport({ session: 'nik-10', socket: '/socket?session=nik-10' });
    sockets[sockets.length - 1].drop();
    scheduled.length = 0;
    return t;
  });
  const beforeWaking = sockets.length;
  global.document.hidden = false;
  // Every transport made in this file added one, so they all get told — which
  // is what the browser does too.
  withFakeClock(() => {
    for (const fn of listeners.document.visibilitychange || []) fn();
  });
  check('a phone picked up again tries at once rather than waiting out the backoff',
    sockets.length > beforeWaking);

  const dropped = withFakeClock((scheduled) => {
    const t = socketTransport({ session: 'nik-11', socket: '/socket?session=nik-11' });
    sockets[sockets.length - 1].drop();
    scheduled.length = 0;
    return t;
  });
  const waiting2 = sockets.length;
  withFakeClock(() => {
    for (const fn of listeners.window.online || []) fn();
  });
  check('and so does a network that has just come back', sockets.length > waiting2);
  check('both are still the same transport', typeof napping.retry === 'function' &&
    typeof dropped.retry === 'function');

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

  // Anything this transport handed to its own page arrives on a later turn of
  // the loop, so let those land before taking the page away from underneath it.
  await settle();
  await settle();
  delete global.window;
  delete global.document;
  delete global.WebSocket;
  delete global.MessageEvent;
};
