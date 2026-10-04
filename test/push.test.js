'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { memoryState } = require('./helpers/vscode-stub.js');
const push = require('../src/push.js');
const { Notifier } = require('../src/notify.js');

/** A subscription, as a browser makes one. */
function subscription(endpoint) {
  const client = crypto.createECDH('prime256v1');
  client.generateKeys();
  return {
    endpoint: endpoint || 'https://push.example.com/send/abc123',
    keys: {
      p256dh: client.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url')
    },
    private: client.getPrivateKey()
  };
}

module.exports = async function () {
  suite('the identity this window sends under');

  const store = memoryState();
  const vapid = push.loadVapid(store);
  const again = push.loadVapid(store);
  checkEqual('it is made once and kept', again.applicationServerKey, vapid.applicationServerKey);
  checkEqual('the browser gets a raw P-256 point, not a DER wrapper',
    Buffer.from(vapid.applicationServerKey, 'base64url').length, 65);
  checkEqual('uncompressed, as the spec requires',
    Buffer.from(vapid.applicationServerKey, 'base64url')[0], 4);

  suite('the token that says who is sending');

  const header = push.vapidHeader(vapid, 'https://push.example.com/send/abc', 'mailto:me@example.com', Date.UTC(2026, 0, 1));
  const token = /t=([^,]+)/.exec(header)[1];
  const [head, claims, signature] = token.split('.');
  checkEqual('it is a JWT', JSON.parse(Buffer.from(head, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });

  const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
  checkEqual('addressed to the push service, not to the endpoint', body.aud, 'https://push.example.com');
  checkEqual('with the sender named', body.sub, 'mailto:me@example.com');
  checkEqual('and an expiry inside the day the spec allows',
    body.exp - Date.UTC(2026, 0, 1) / 1000 <= 24 * 3600, true);

  check('the signature is this window\'s, and checks out',
    crypto.verify('sha256', Buffer.from(head + '.' + claims),
      { key: vapid.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  checkEqual('the key the service should check it with is advertised beside it',
    /k=([^,\s]+)/.exec(header)[1], vapid.applicationServerKey);
  check('a different window cannot sign for this one', !crypto.verify('sha256',
    Buffer.from(head + '.' + claims),
    { key: push.loadVapid(memoryState()).publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url')));

  suite('the payload the push service cannot read');

  const to = subscription();
  const sealed = push.encrypt(to.keys, JSON.stringify({ title: 'hello', body: 'world' }));

  checkEqual('the salt comes first, sixteen bytes of it', sealed.length > 16, true);
  checkEqual('then the record size', sealed.readUInt32BE(16), 4096);
  checkEqual('then the length of the key', sealed[20], 65);
  checkEqual('then the key itself, uncompressed', sealed[21], 4);
  check('and then something nobody else can read',
    sealed.length === 16 + 4 + 1 + 65 + (JSON.stringify({ title: 'hello', body: 'world' }).length + 1 + 16));

  checkEqual('the subscription can read it back',
    push.decrypt(sealed, to.private, to.keys.auth), '{"title":"hello","body":"world"}');

  const other = subscription();
  let refused = null;
  try { push.decrypt(sealed, other.private, other.keys.auth); } catch (err) { refused = err; }
  check('and nobody else can', !!refused);

  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 20] ^= 0xff;
  let caught = null;
  try { push.decrypt(tampered, to.private, to.keys.auth); } catch (err) { caught = err; }
  check('a payload changed on the way is refused, not quietly wrong', !!caught);

  const twice = push.encrypt(to.keys, 'the same words');
  const andAgain = push.encrypt(to.keys, 'the same words');
  check('the same message encrypted twice is not the same bytes', !twice.equals(andAgain));

  checkEqual('a key that is not a key is refused', (() => {
    try { push.encrypt({ p256dh: 'bm90YWtleQ', auth: to.keys.auth }, 'x'); return null; }
    catch (err) { return /subscription key/.test(err.message); }
  })(), true);
  checkEqual('and so is an auth secret of the wrong size', (() => {
    try { push.encrypt({ p256dh: to.keys.p256dh, auth: 'c2hvcnQ' }, 'x'); return null; }
    catch (err) { return /auth secret/.test(err.message); }
  })(), true);

  suite('sending it');

  const posted = [];
  const fakePost = (endpoint, headers, payload) => {
    posted.push({ endpoint, headers, payload });
    return Promise.resolve({ status: 201, body: '' });
  };
  const out = await push.send(to, { title: 'hi' }, { vapid, request: fakePost });
  checkEqual('a push service that accepts it is a success', out.ok, true);
  checkEqual('it goes to the endpoint the browser gave', posted[0].endpoint, to.endpoint);
  checkEqual('encoded the way the standard says', posted[0].headers['content-encoding'], 'aes128gcm');
  checkEqual('as bytes, not as JSON', posted[0].headers['content-type'], 'application/octet-stream');
  check('with a token', /^vapid t=/.test(posted[0].headers.authorization));
  check('and a time to live', Number(posted[0].headers.ttl) > 0);
  checkEqual('the body is the encrypted block, nothing else',
    push.decrypt(posted[0].payload, to.private, to.keys.auth), '{"title":"hi"}');

  const gone = await push.send(to, { title: 'hi' }, {
    vapid, request: () => Promise.resolve({ status: 410, body: 'gone' })
  });
  checkEqual('a subscription the service has forgotten is reported as gone', gone.gone, true);
  checkEqual('and not as a success', gone.ok, false);

  const broken = await push.send({ endpoint: to.endpoint, keys: { p256dh: 'x', auth: 'y' } }, {}, { vapid });
  checkEqual('a subscription that cannot be encrypted to fails without throwing', broken.ok, false);

  suite('what is worth waking a phone for');

  const devices = fakeDevices([
    { id: 'd1', name: 'A phone', push: to },
    { id: 'd2', name: 'Another', push: subscription('https://push.example.com/send/def') }
  ]);
  const sent = [];
  const notifier = new Notifier({
    devices, vapid,
    settings: () => ({ needsYou: true, quota: true, failed: true, turnFinished: false }),
    send: (target, message) => { sent.push({ to: target.endpoint, message }); return Promise.resolve({ ok: true }); }
  });

  const waiting = {
    id: 's1', label: '1327', status: 'waiting',
    items: [{ kind: 'permission', name: 'Bash', resolved: null }]
  };
  await notifier.needsYou(waiting);
  checkEqual('an instance waiting reaches every device that asked', sent.length, 2);
  checkEqual('and says which one it is', sent[0].message.title, '1327 needs an answer');
  checkEqual('and what it is asking', sent[0].message.body, 'Allow Bash?');
  checkEqual('with somewhere to go when it is tapped', sent[0].message.url, '/s/s1');
  checkEqual('and a tag, so one instance is one notification', sent[0].message.tag, 'needs-you:s1');

  sent.length = 0;
  await notifier.needsYou(waiting);
  checkEqual('the same instance still waiting does not buzz again', sent.length, 0);
  notifier.settled({ id: 's1', status: 'idle' });
  await notifier.needsYou(waiting);
  checkEqual('but it does after it has been answered and asks again', sent.length, 2);

  sent.length = 0;
  await notifier.finished({ id: 's1', label: '1327' });
  checkEqual('a turn finishing is not sent unless it was asked for', sent.length, 0);

  const loud = new Notifier({
    devices, vapid,
    settings: () => ({ turnFinished: true }),
    send: (target, message) => { sent.push({ message }); return Promise.resolve({ ok: true }); }
  });
  await loud.finished({ id: 's1', label: '1327' });
  checkEqual('and is when it was', sent.length, 2);

  sent.length = 0;
  const quiet = new Notifier({
    devices, vapid,
    settings: () => ({ needsYou: false, quota: false, failed: false }),
    send: (target, message) => { sent.push({ message }); return Promise.resolve({ ok: true }); }
  });
  await quiet.needsYou(waiting);
  await quiet.failed({ id: 's2', label: 'x' }, 'broke');
  await quiet.paused({ until: Date.now() + 3600000 });
  checkEqual('nothing is sent for what is turned off', sent.length, 0);

  suite('nothing is sent that could not be acted on');

  sent.length = 0;
  const unreachable = new Notifier({
    devices, vapid,
    settings: () => ({ needsYou: true, quota: true, failed: true }),
    reachable: () => false,
    send: (target, message) => { sent.push({ message }); return Promise.resolve({ ok: true }); }
  });
  await unreachable.needsYou({ id: 's5', label: 'x', items: [] });
  await unreachable.paused({ until: Date.now() + 1000 });
  checkEqual('with nothing able to reach this window, nothing is sent', sent.length, 0);

  suite('a turn finishing is a thing that can be asked for');

  sent.length = 0;
  const chatty = new Notifier({
    devices, vapid,
    settings: () => ({ turnFinished: true }),
    send: (target, message) => { sent.push(message.title); return Promise.resolve({ ok: true }); }
  });
  const window2 = new EventEmitter();
  window2.off = window2.removeListener;
  const stopWatching = chatty.watch(window2);
  window2.emit('session-changed', { id: 'f1', label: '1327', status: 'done', items: [] });
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('a turn that ends reaches the devices that asked', sent.length, 2);
  check('by name, as the laptop says it', /1327 is done/.test(sent[0]));
  window2.emit('session-changed', { id: 'f1', label: '1327', status: 'done', items: [] });
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('and resting there does not say it again', sent.length, 2);
  stopWatching();

  suite('said the way the laptop says it');

  const told = [];
  const echo = new Notifier({
    devices, vapid,
    settings: () => ({ turnFinished: true }),
    send: (target, message) => { told.push(message); return Promise.resolve({ ok: true }); }
  });
  const window3 = new EventEmitter();
  window3.off = window3.removeListener;
  const stopEcho = echo.watch(window3);
  window3.emit('session-changed', { id: 'g1', label: '1400', status: 'done', items: [
    { kind: 'text', text: '## Fixed the **flaky** test\nIt was a timer.' }, { kind: 'result' }] });
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('a finished turn says the first line of its answer',
    told[0] && told[0].body, 'Fixed the flaky test');
  told.length = 0;
  window3.emit('session-changed', { id: 'g2', label: '1401', status: 'done', items: [
    { kind: 'text', text: 'half' }, { kind: 'result', interrupted: true }] });
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('a turn you stopped yourself is not news', told.length, 0);

  window3.emit('ci-result', { id: 'g3', label: '1402' },
    { phase: 'failed', pr: { number: 88, title: 'Faster boot' }, failing: ['lint', 'unit'] });
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('CI that failed reaches the phone', told[0] && told[0].title, 'PR #88 failed');
  checkEqual('naming what failed and where', told[0] && told[0].body, 'lint, unit · 1402');
  checkEqual('as one notification per instance', told[0] && told[0].tag, 'ci:g3');
  told.length = 0;
  window3.emit('ci-result', { id: 'g3', label: '1402' }, { phase: 'passed', pr: { number: 88, title: 'Faster boot' } });
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('and green says so', told[0] && told[0].title, 'PR #88 is green');
  checkEqual('with the PR it is about', told[0] && told[0].body, 'Faster boot · 1402');
  told.length = 0;
  window3.emit('ci-result', { id: 'g3', label: '1402' }, { phase: 'running' });
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('a build still running is not news', told.length, 0);
  stopEcho();

  const noCi = new Notifier({
    devices, vapid,
    settings: () => ({ ci: false }),
    send: (target, message) => { told.push(message); return Promise.resolve({ ok: true }); }
  });
  await noCi.ci({ id: 'g4', label: 'x' }, { phase: 'passed' });
  checkEqual('and CI can be turned off', told.length, 0);

  suite('a device that is gone stops being written to');

  const dying = fakeDevices([{ id: 'd3', name: 'Uninstalled', push: subscription('https://push.example.com/send/ghi') }]);
  const persistent = new Notifier({
    devices: dying, vapid,
    settings: () => ({ needsYou: true }),
    send: () => Promise.resolve({ ok: false, status: 410, gone: true, reason: 'gone' })
  });
  await persistent.needsYou({ id: 's9', label: 'x', items: [] });
  checkEqual('the subscription is dropped', dying.subscribers().length, 0);
  check('and it is written down', dying.records.some((r) => /notifications stopped/.test(r.action)));

  suite('following a window');

  const manager = new EventEmitter();
  manager.off = manager.removeListener;
  const heard = [];
  const following = new Notifier({
    devices, vapid,
    settings: () => ({ needsYou: true, quota: true, failed: true }),
    send: (target, message) => { heard.push(message.title); return Promise.resolve({ ok: true }); }
  });
  const unwatch = following.watch(manager);

  manager.emit('session-changed', { id: 'w1', label: 'alpha', status: 'waiting', items: [] });
  manager.emit('failed', { id: 'w2', label: 'beta' }, 'the CLI is not on the path');
  manager.emit('paused', { until: Date.now() + 3600000 });
  manager.emit('resumed', { woken: 3 });
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('every one of the three reaches a phone', heard.length, 8);
  check('the one that needs an answer', heard.some((t) => /needs an answer/.test(t)));
  check('the one that failed', heard.some((t) => /failed/.test(t)));
  check('the quota running out', heard.some((t) => /limit is spent/.test(t)));
  check('and coming back', heard.some((t) => /quota reset/.test(t)));

  heard.length = 0;
  manager.emit('resumed', { woken: 1, manual: true });
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('a resume you asked for yourself is not news', heard.length, 0);

  unwatch();
  manager.emit('failed', { id: 'w3', label: 'gamma' }, 'again');
  await new Promise((r) => setTimeout(r, 120));
  checkEqual('and it can be let go of', heard.length, 0);

  suite('a phone that is already here is told down the socket it is holding');

  // The push path needs a tunnel, a push service and a phone reachable from
  // outside. A phone with the app open needs none of those — it is connected,
  // right now, over a socket this window is already holding.

  const attached = [];
  const bothWays = new Notifier({
    devices: fakeDevices([{ id: 'd1', name: 'A phone', push: subscription }]),
    vapid, now: () => 1000,
    toSockets: (message) => { attached.push(message); return 2; },
    send: async () => ({ ok: true })
  });

  const reachedBoth = await bothWays.announce('needs-you', { title: 'alpha needs an answer', tag: 'x', session: 'nik-1' });
  checkEqual('the socket is told', attached.length, 1);
  checkEqual('and so is the push service', reachedBoth.sent, 1);
  checkEqual('and it says how many were already here', reachedBoth.attached, 2);
  checkEqual('what goes down the socket is the same thing that goes up the wire',
    attached[0].title, 'alpha needs an answer');
  check('and it names the instance, so a tap can open it', attached[0].session === 'nik-1');
  check('and which kind it was, so the phone can filter it', attached[0].kind === 'needs-you');

  attached.length = 0;
  const shutAway = new Notifier({
    devices: fakeDevices([{ id: 'd1', name: 'A phone', push: subscription }]),
    vapid, now: () => 1000,
    reachable: () => false,
    toSockets: (message) => { attached.push(message); return 1; },
    send: async () => ({ ok: true })
  });
  const anyway = await shutAway.announce('failed', { title: 'beta failed', tag: 'y' });
  checkEqual('a window nothing outside can reach still tells the phone that is here',
    attached.length, 1);
  checkEqual('and does not pretend it pushed anything', anyway.sent, 0);
  check('nor that it skipped everything', anyway.skipped === false);

  attached.length = 0;
  const nobody = new Notifier({
    devices: fakeDevices([]), vapid, now: () => 1000,
    toSockets: () => 0, send: async () => ({ ok: true })
  });
  const silence = await nobody.announce('failed', { title: 'gamma failed', tag: 'z' });
  check('with nobody anywhere, it says it skipped', silence.skipped === true);

  attached.length = 0;
  const breaking = new Notifier({
    devices: fakeDevices([]), vapid, now: () => 1000,
    toSockets: () => { throw new Error('the socket went away mid-sentence'); },
    send: async () => ({ ok: true })
  });
  let survived = false;
  try { await breaking.announce('failed', { title: 'delta failed', tag: 'w' }); }
  catch (_) { survived = true; }
  check('a socket that dies while being written to does not take the announcement with it', !survived);

  const notWanted = new Notifier({
    devices: fakeDevices([]), vapid, now: () => 1000,
    settings: () => ({ failed: false }),
    toSockets: (m) => { attached.push(m); return 1; },
    send: async () => ({ ok: true })
  });
  attached.length = 0;
  await notWanted.announce('failed', { title: 'never said', tag: 'v' });
  checkEqual('and what this window does not want told is not told either way', attached.length, 0);
};

function fakeDevices(list) {
  const records = [];
  return {
    records,
    list: () => list,
    subscribers: () => list.filter((d) => d.push),
    unsubscribe: (id) => { const d = list.find((x) => x.id === id); if (d) delete d.push; },
    record: (entry) => { records.push(entry); }
  };
}
