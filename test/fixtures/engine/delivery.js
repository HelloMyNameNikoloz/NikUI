'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createDelivery } = require('../../../src/deliveryRuntime');
const { createSelectedDelivery } = require('../../../src/daemonDelivery');
const { createEngine } = require('../../../src/engine');
const { loadIdentity, readPublicKey, verifyWith } = require('../../../src/identity');
const push = require('../../../src/push');
const { DeviceStore } = require('../../../src/devices');
const secure = require('../../../src/secure');
const { RemoteServer } = require('../../../src/remote');
const { makeDevice } = require('../../helpers/device');
const { state, settings, context, tick } = require('./fakes');

const root = process.env.NIKUI_ENGINE_FIXTURE_ROOT;
const noNetwork = async () => ({ status: 201, body: '' });
function selected(store, extra = {}) {
  return { store, fingerprint: loadIdentity(store).fingerprint,
    applicationServerKey: push.loadVapid(store).applicationServerKey, ...extra };
}
function managerFixture() { return Object.assign(new EventEmitter(), { list: [] }); }
function intervals() {
  const tasks = new Map(); let seq = 0;
  return { tasks, setInterval(fn, ms) { const id = ++seq; tasks.set(id, { fn, ms }); return id; },
    clearInterval(id) { tasks.delete(id); }, fire() { for (const { fn } of [...tasks.values()]) fn(); } };
}
function response() {
  return Object.assign(new EventEmitter(), { status: null, headers: {}, text: '', ended: 0,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    write(text) { this.text += text; }, end(text = '') { this.text += text; this.ended++; this.emit('close'); } });
}
function streamRequest(secret) {
  return Object.assign(new EventEmitter(), { headers: { authorization: 'Bearer ' + secret },
    socket: { setTimeout() {}, setKeepAlive() {} } });
}
async function httpPair(server, body) {
  const req = new PassThrough();
  Object.assign(req, { method: 'POST', url: '/pair', headers: { host: '127.0.0.1:0' },
    socket: { remoteAddress: '127.0.0.1' } });
  const res = response();
  const handling = server.handle(req, res);
  req.end(JSON.stringify(body));
  await handling;
  return { status: res.status, body: JSON.parse(res.text) };
}
function rejected(name, fn, pattern) {
  let message = '';
  try { fn(); } catch (err) { message = err.message; }
  check(name, pattern.test(message));
  return message;
}

module.exports = async function () {
  const runtimes = [], servers = [], engines = [];
  const make = (options) => { const d = createDelivery(options); runtimes.push(d); return d; };
  const strict = (options) => { const d = createSelectedDelivery(options); runtimes.push(d); return d; };
  const transportOptions = { pushRequest: noNetwork, appleRequest: noNetwork };
  try {
    suite('P1-06/T03/T04: delivery is inert and owned by one headless engine');
    const legacyStore = state(), source = settings(), manager = managerFixture(), timer = intervals();
    rejected('a core caller must choose its secret policy', () => createDelivery({ store: legacyStore, settings: source }), /secret policy/);
    const legacy = make({ store: legacyStore, settings: source, manager, timers: timer, secretPolicy: { mode: 'legacy-window' } });
    checkEqual('legacy keys retain the two existing memento shapes', Object.keys(legacyStore.values).sort(), ['nikui.identity', 'nikui.vapid']);
    checkEqual('construction has no manager watcher, stream or APNs access', [manager.eventNames().length, timer.tasks.size, legacy.apns.state().configured], [0, 0, false]);
    legacy.start(); legacy.start();
    checkEqual('start twice watches each manager event once', ['session-changed', 'failed', 'ci-result', 'paused', 'resumed'].map((event) => manager.listenerCount(event)), [1, 1, 1, 1, 1]);
    const keyRecord = JSON.stringify(legacyStore.values);
    const reopened = make({ store: legacyStore, settings: source, secretPolicy: { mode: 'legacy-window' } });
    checkEqual('window restart reuses exactly the same host/VAPID keys', [reopened.identity.fingerprint, reopened.vapid.applicationServerKey], [legacy.identity.fingerprint, legacy.vapid.applicationServerKey]);
    checkEqual('reopening does not rewrite the legacy stores', JSON.stringify(legacyStore.values), keyRecord);
    const brokenLegacy = state({ 'nikui.identity': { publicKey: 'bad', privateKey: 'bad' }, 'nikui.vapid': {} });
    const healed = make({ store: brokenLegacy, settings: source, secretPolicy: { mode: 'legacy-window' } });
    check('legacy window regeneration remains available', healed.identity.verifyOwn('window', healed.identity.sign('window')));

    const selectedStore = state(), selection = selected(selectedStore);
    const phone = await makeDevice('Selected phone');
    const records = new DeviceStore(selectedStore, { now: () => 1234 });
    const record = records.add({ name: phone.name, publicKey: phone.publicKey, protection: 'secure-enclave', biometric: true });
    phone.id = record.id;
    records.setControl(record.id, true);
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const auth = crypto.randomBytes(16).toString('base64url');
    records.subscribe(record.id, { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic',
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth } });
    records.subscribeApple(record.id, 'ab'.repeat(32));
    const listenerSecret = 'a'.repeat(43);
    records.setListener(record.id, crypto.createHash('sha256').update(listenerSecret).digest('hex'));
    const conflictStore = state(), conflict = selected(conflictStore);
    new DeviceStore(conflictStore).add({ name: 'Unselected phone', publicKey: (await makeDevice('Unselected')).publicKey });

    suite('P1-06/T41: selected host, grants and all delivery records keep their exact scope');
    const disk = path.join(root, 'selected.json');
    fs.writeFileSync(disk, JSON.stringify(selectedStore.values), { mode: 0o600 });
    let diskWrites = 0;
    const diskStore = { get(key, fallback) { const value = JSON.parse(fs.readFileSync(disk)); return key in value ? value[key] : fallback; },
      update(key, value) { diskWrites++; const data = JSON.parse(fs.readFileSync(disk)); data[key] = value; fs.writeFileSync(disk, JSON.stringify(data), { mode: 0o600 }); } };
    const beforeBytes = fs.readFileSync(disk, 'utf8');
    const a = strict({ selection: { ...selection, store: diskStore }, settings: source, ...transportOptions });
    const b = strict({ selection: conflict, settings: source, ...transportOptions });
    checkEqual('the selected host proves the pin already held by the phone', [a.identity.publicKeySpki, a.identity.fingerprint,
      verifyWith(a.identity.publicKeySpki, 'proof', a.identity.sign('proof'))], [selectedStore.values['nikui.identity'].publicKey, selection.fingerprint, true]);
    checkEqual('the VAPID pin is selected separately from the host pin', a.vapid.applicationServerKey, selection.applicationServerKey);
    checkEqual('device grants, key protection, APNs, push and listener hashes survive byte for byte', a.devices.list(), structuredClone(records.list()));
    checkEqual('a selected file read does not rewrite keys or records', [fs.readFileSync(disk, 'utf8'), diskWrites, fs.statSync(disk).mode & 0o777], [beforeBytes, 0, 0o600]);
    checkEqual('conflicting stores never union devices or substitute a host', [a.devices.list().length, b.devices.list().length,
      a.devices.list()[0].name, b.devices.list()[0].name, a.identity.fingerprint !== b.identity.fingerprint], [1, 1, 'Selected phone', 'Unselected phone', true]);

    suite('P1-06/T41: unavailable selected secrets never regenerate or leak');
    const selectedArgs = { selection, settings: source, ...transportOptions };
    rejected('the daemon adapter requires selection rather than a legacy source lookup', () => createSelectedDelivery({ settings: source }), /explicit selected/);
    rejected('selected construction cannot inherit real network transports', () => createSelectedDelivery({ selection, settings: source }), /explicit push and APNs/);
    rejected('a selected APNs key path must be explicit and absolute', () => createSelectedDelivery({ ...selectedArgs, paths: { apnsKeyFile: 'relative.p8' } }), /absolute/);
    const noApns = strict({ ...selectedArgs, settings: settings({ 'apns.keyFile': '/unselected/source-key.p8' }), paths: { apnsKeyFile: undefined } });
    checkEqual('an absent selected APNs reference cannot fall through to legacy settings', noApns.apns.settings().keyFile, '');
    const wrongCurve = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1', publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
    const wrongPair = { publicKey: wrongCurve.publicKey.toString('base64url'), privateKey: wrongCurve.privateKey.toString('base64url') };
    let generated = 0, writes = 0;
    const originalGenerate = crypto.generateKeyPairSync;
    crypto.generateKeyPairSync = function () { generated++; throw new Error('selected keys must never be generated'); };
    const failures = [];
    try {
      for (const [label, data] of [
        ['missing host', { ...selectedStore.values, 'nikui.identity': null }],
        ['corrupt host', { ...selectedStore.values, 'nikui.identity': { publicKey: 'RAW-SECRET-MARKER', privateKey: 'RAW-SECRET-MARKER' } }],
        ['mismatched host pair', { ...selectedStore.values, 'nikui.identity': { ...selectedStore.values['nikui.identity'], privateKey: conflictStore.values['nikui.identity'].privateKey } }],
        ['unsupported host curve', { ...selectedStore.values, 'nikui.identity': wrongPair }],
        ['missing VAPID', { ...selectedStore.values, 'nikui.vapid': null }],
        ['corrupt VAPID', { ...selectedStore.values, 'nikui.vapid': { publicKey: 'RAW-SECRET-MARKER', privateKey: 'RAW-SECRET-MARKER' } }],
        ['mismatched VAPID pair', { ...selectedStore.values, 'nikui.vapid': { ...selectedStore.values['nikui.vapid'], privateKey: conflictStore.values['nikui.vapid'].privateKey } }],
        ['unsupported VAPID curve', { ...selectedStore.values, 'nikui.vapid': wrongPair }]
      ]) {
        const store = state(data); store.update = () => writes++;
        failures.push(rejected(label + ' refuses selected startup', () => createSelectedDelivery({ ...selectedArgs,
          selection: { ...selection, store } }), /Selected (?:host|VAPID) identity unavailable/));
      }
      for (const status of ['locked', 'denied']) {
        const store = { get() { throw new Error(status + ' RAW-SECRET-MARKER'); }, update() { writes++; } };
        failures.push(rejected(status + ' store refuses selected startup', () => createSelectedDelivery({ ...selectedArgs,
          selection: { ...selection, store } }), /store inaccessible/));
      }
      failures.push(rejected('a locked VAPID read after the host read also refuses', () => createSelectedDelivery({ ...selectedArgs,
        selection: { ...selection, store: { get(key, fallback) { if (key === 'nikui.vapid') throw new Error('locked RAW-SECRET-MARKER'); return selectedStore.get(key, fallback); }, update() { writes++; } } } }), /VAPID identity unavailable: store inaccessible/));
      rejected('a different selected host pin cannot reuse these grants', () => createSelectedDelivery({ ...selectedArgs,
        selection: { ...selection, fingerprint: conflict.fingerprint } }), /pin mismatch/);
      rejected('a different selected VAPID pin cannot reuse subscriptions', () => createSelectedDelivery({ ...selectedArgs,
        selection: { ...selection, applicationServerKey: conflict.applicationServerKey } }), /pin mismatch/);
    } finally { crypto.generateKeyPairSync = originalGenerate; }
    checkEqual('every selected failure leaves key generation and stores untouched', [generated, writes], [0, 0]);
    check('errors contain named reasons without raw secret contents', failures.every((message) => !message.includes('RAW-SECRET-MARKER')));

    suite('P1-06/T07/T11/T42: real pairing, grants and rekey through both policies');
    for (const runtime of [legacy, a]) {
      const server = new RemoteServer({ delivery: runtime, root, host: {}, hubs: {}, sessions: { list: () => [], get: () => null } });
      servers.push(server);
      const handset = await makeDevice('Paired fixture');
      let invitation = runtime.pairing.start({ host: 'fixture.invalid', fingerprint: runtime.identity.fingerprint });
      const paired = await httpPair(server, await handset.pairingBody(invitation.code));
      handset.id = paired.body.device;
      checkEqual('new HTTP pairing is watch-only and returns the selected host pin', [paired.status, paired.body.control, paired.body.fingerprint], [200, false, runtime.identity.fingerprint]);
      const replay = await httpPair(server, await handset.pairingBody(invitation.code));
      checkEqual('the pairing invitation is single-use', replay.status, 403);
      runtime.devices.setControl(handset.id, true);
      invitation = runtime.pairing.start({ fingerprint: runtime.identity.fingerprint });
      const upsert = await httpPair(server, await handset.pairingBody(invitation.code));
      checkEqual('re-pairing the same key preserves its ID and existing control grant', [upsert.body.device, upsert.body.control], [handset.id, true]);
      const replacement = await makeDevice('Replacement');
      const state = server.gate.challenge(), answer = await handset.answer(state, handset.id);
      const fingerprint = readPublicKey(replacement.publicKey).fingerprint;
      const signed = `nikui-rekey:${state.nonce}:${answer.nonce}:${fingerprint}:` + secure.binding(state.ephemeral.spki, answer.epk);
      answer.signature = await handset.sign(signed);
      answer.rekey = { publicKey: replacement.publicKey, signature: 'forged', protection: 'secure-enclave', biometric: true };
      checkEqual('a replacement without proof of its new key is refused', server.gate.answer(state, answer).ok, false);
      checkEqual('a refused rekey preserves the old pin and grant', [runtime.devices.get(handset.id).publicKey, runtime.devices.get(handset.id).control], [handset.publicKey, true]);
      answer.rekey.signature = await replacement.sign(signed);
      const moved = server.gate.answer(state, answer);
      checkEqual('valid two-key proof preserves identity and the control grant', [moved.ok, moved.device.id, moved.device.control, moved.welcome.rekeyed.fingerprint], [true, handset.id, true, fingerprint]);
      runtime.devices.setControl(handset.id, false);
      const next = server.gate.challenge();
      checkEqual('a later challenge sees the revoked grant immediately', server.gate.answer(next, await replacement.answer(next, handset.id)).device.control, false);
      runtime.devices.forget(handset.id);
      const after = server.gate.challenge();
      checkEqual('forget refuses the former device even with the replacement key', server.gate.answer(after, await replacement.answer(after, handset.id)).ok, false);
      runtime.pairing.start();
      checkEqual('one wrong guess closes the pairing window', [runtime.pairing.claim('WRONG').ok, runtime.pairing.isOpen], [false, false]);
    }

    suite('P1-06/T47: actual Web Push, APNs and SSE use injected delivery adapters');
    const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    const keyPath = path.join(root, 'fixture.p8'); fs.writeFileSync(keyPath, key.privateKey, { mode: 0o600 });
    const requests = [], logs = []; let keyReads = 0, appleStatus = 200, pushStatus = 201;
    const deliverySettings = settings({ 'apns.teamId': 'FIXTURETEAM', 'apns.keyId': 'FIXTUREKEY', 'apns.keyFile': '/unselected/never-read.p8',
      notifyDevices: { needsYou: false, ci: false, turnFinished: false }, notifyOnAttention: false, notifyCI: false });
    const deliveryTimers = intervals();
    const delivery = strict({ selection, settings: deliverySettings, paths: { apnsKeyFile: keyPath }, timers: deliveryTimers,
      readApnsKey(file) { keyReads++; if (file !== keyPath) throw new Error('unselected key'); return fs.readFileSync(file, 'utf8'); },
      appleRequest: async (host, headers, body) => { requests.push({ kind: 'apple', host, headers, body: JSON.parse(body) }); return { status: appleStatus, body: '{}' }; },
      pushRequest: async (endpoint, headers, body) => { requests.push({ kind: 'push', endpoint, headers, body }); return { status: pushStatus, body: '' }; },
      log: (line) => logs.push(line) });
    checkEqual('APNs uses only the explicit key reference and reads no key at construction', [delivery.apns.settings().keyFile, keyReads], [keyPath, 0]);
    const fakeTransport = { listening: true, notifyDevices: (message) => delivery.stream.notify(message), stops: 0, stop() { this.stops++; } };
    delivery.connect(fakeTransport); delivery.start();
    const req = streamRequest(listenerSecret), res = response();
    delivery.stream.open(req, res, delivery.stream.authenticate(req));
    checkEqual('the imported listener hash opens its existing SSE stream', [res.status, deliveryTimers.tasks.size], [200, 1]);
    checkEqual('disabled attention does not reach any delivery path', await delivery.notifier.announce('needs-you', { title: 'quiet' }), { sent: 0, failed: 0, attached: 0, skipped: true });
    checkEqual('the three laptop switches still add to the phone preferences', ['turn-finished', 'ci', 'needs-you'].map((kind) => delivery.notifier.wants(kind)), [false, false, false]);
    deliverySettings.values.notifyWhenDone = true; deliverySettings.values.notifyCI = true; deliverySettings.values.notifyOnAttention = true;
    checkEqual('fresh window settings enable the same notifications', ['turn-finished', 'ci', 'needs-you'].map((kind) => delivery.notifier.wants(kind)), [true, true, true]);
    delivery.audience.steered('fixture-session', record.id);
    const delivered = await delivery.notifier.announce('needs-you', { title: 'Fixture needs an answer', session: 'fixture-session', tag: 'fixture' });
    checkEqual('one notification takes the three existing delivery paths', delivered, { sent: 2, failed: 0, attached: 1, skipped: false });
    check('SSE carries only notification data addressed to its device', /event: notify\ndata: .*Fixture needs an answer/.test(res.text));
    const web = requests.find((request) => request.kind === 'push'), apn = requests.find((request) => request.kind === 'apple');
    const plaintext = JSON.parse(push.decrypt(web.body, ecdh.getPrivateKey(), auth));
    checkEqual('real push encryption targets the selected subscription and audience', [web.endpoint, plaintext.to, plaintext.title], ['https://fcm.googleapis.com/fcm/send/synthetic', record.id, 'Fixture needs an answer']);
    check('Web Push signs with the selected VAPID identity', web.headers.authorization.endsWith('k=' + selection.applicationServerKey));
    const jwt = apn.headers.authorization.slice('bearer '.length).split('.');
    check('APNs uses the injected synthetic private key', crypto.verify('sha256', Buffer.from(jwt[0] + '.' + jwt[1]), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2], 'base64url')));
    checkEqual('APNs sends to the selected phone and bundle', [apn.headers[':path'], apn.headers['apns-topic']], ['/3/device/' + 'ab'.repeat(32), 'com.nikoloz.nikui']);
    checkEqual('an APNs token is read once and cached within this owner', keyReads, 1);
    const blockedLogs = [];
    const blockedApns = strict({ selection, settings: deliverySettings, paths: { apnsKeyFile: keyPath },
      readApnsKey() { throw new Error('locked RAW-SECRET-MARKER'); }, ...transportOptions, log: (line) => blockedLogs.push(line) });
    blockedApns.connect({ listening: true, notifyDevices: () => 0 });
    checkEqual('an inaccessible APNs key reports failure while Web Push still works',
      await blockedApns.notifier.announce('needs-you', { title: 'Blocked signing key' }), { sent: 1, failed: 1, attached: 0, skipped: false });
    check('a signing-key failure keeps the phone subscription and a sanitized reason', !!blockedApns.devices.get(record.id).apns &&
      blockedLogs.some((line) => line.includes('APNs signing key unavailable')) && !blockedLogs.join('\n').includes('RAW-SECRET-MARKER'));
    const beforeText = res.text;
    delivery.stream.notify({ title: 'other phone', to: 'unselected' });
    checkEqual('SSE audience filtering cannot disclose another phone notification', res.text, beforeText);
    const posts = [];
    checkEqual('local seats cannot obtain a listener bearer', delivery.stream.issue({ device: { kind: 'local', id: 'local' }, post: (message) => posts.push(message) }), false);
    delivery.stream.issue({ device: { kind: 'device', ...record }, post: (message) => posts.push(message) });
    checkEqual('rotating the listener secret closes its old stream on the next write', [delivery.stream.notify({ title: 'rotated' }), res.ended, deliveryTimers.tasks.size], [0, 1, 0]);
    checkEqual('a rotated imported bearer no longer authenticates', delivery.stream.authenticate(streamRequest(listenerSecret)), null);
    const newReq = streamRequest(posts[0].secret), newRes = response();
    delivery.stream.open(newReq, newRes, delivery.stream.authenticate(newReq));
    deliveryTimers.fire();
    check('the new listener receives the same keepalive format', newRes.text.includes(': ping\n\n'));
    delivery.devices.forget(record.id); deliveryTimers.fire();
    checkEqual('forget also closes the listener and retires its timer', [newRes.ended, deliveryTimers.tasks.size], [1, 0]);
    check('neither listener bearer nor host/APNs private keys appear in logs', !logs.join('\n').includes(posts[0].secret) && !logs.join('\n').includes(key.privateKey) && !logs.join('\n').includes(selectedStore.values['nikui.identity'].privateKey));

    suite('P1-06/T04/T41: secret replacement and engine disposal close owned listeners once');
    const changeListeners = new Set(); let subscriptionsDisposed = 0;
    const ownerManager = managerFixture(), ownerTimers = intervals();
    const owner = strict({ selection: { ...selection, onDidChange(fn) { changeListeners.add(fn); return { dispose() { subscriptionsDisposed++; changeListeners.delete(fn); } }; } },
      settings: source, manager: ownerManager, timers: ownerTimers, ...transportOptions });
    owner.start(); owner.start(); owner.pairing.start();
    const bound = new RemoteServer({ delivery: owner, root, host: {}, hubs: {}, sessions: { list: () => [], get: () => null },
      // Conflicting explicit parameters cannot override the selected graph.
      devices: b.devices, identity: b.identity });
    servers.push(bound);
    const stopBound = bound.stop.bind(bound);
    bound.stops = 0;
    bound.stop = () => { bound.stops++; return stopBound(); };
    const ownerDevice = owner.devices.add({ name: phone.name, publicKey: phone.publicKey });
    const ownerPosts = [];
    owner.stream.issue({ device: { ...ownerDevice, kind: 'device' }, post: (message) => ownerPosts.push(message) });
    const ownerReq = streamRequest(ownerPosts[0].secret), ownerRes = response();
    owner.stream.open(ownerReq, ownerRes, owner.stream.authenticate(ownerReq));
    checkEqual('the retiring owner has an actual open SSE listener and timer', [ownerRes.status, ownerTimers.tasks.size], [200, 1]);
    check('server composition cannot substitute another profile devices or identity', bound.devices === owner.devices && bound.identity === owner.identity);
    for (const fn of [...changeListeners]) fn();
    checkEqual('one secret change retires the watcher, subscription, pairing and transport', [owner.available, ownerManager.eventNames().length,
      changeListeners.size, subscriptionsDisposed, owner.pairing.isOpen, bound.stops], [false, 0, 0, 1, false, 1]);
    checkEqual('secret retirement closes SSE and removes both close callbacks', [ownerRes.ended, ownerTimers.tasks.size,
      ownerReq.listenerCount('close'), ownerRes.listenerCount('close')], [1, 0, 0, 0]);
    checkEqual('an unavailable selected graph refuses both HTTP and socket guards', bound.guard({}).status, 503);
    let listenError = '';
    try { await bound.start(0); } catch (err) { listenError = err.message; }
    check('unavailable selected identity cannot bind a listener', /secrets changed/.test(listenError));
    rejected('closed selected bindings cannot be reused for a new server', () => owner.serverOptions(), /secrets changed/);
    owner.dispose(); owner.start();
    checkEqual('dispose and start cannot resurrect a retired selection', [subscriptionsDisposed, bound.stops, ownerManager.eventNames().length], [1, 1, 0]);
    const inaccessible = strict({ selection: { ...selection, onDidChange() { throw new Error('denied RAW-SECRET-MARKER'); } },
      manager: ownerManager, settings: source, ...transportOptions });
    rejected('unavailable secret events refuse startup without raw backend errors', () => inaccessible.start(), /^Delivery secret subscription unavailable$/);
    checkEqual('a failed event subscription also rolls back the manager watcher', [inaccessible.available, ownerManager.eventNames().length], [false, 0]);

    const engineStore = state(), engineSelection = selected(engineStore), engineTimers = intervals();
    let apnsPathProbes = 0;
    const engineIo = Object.create(fs);
    engineIo.existsSync = (file) => { if (file === keyPath) { apnsPathProbes++; return false; } return fs.existsSync(file); };
    const engine = createEngine({ context: context(), settings: settings({ 'apns.teamId': 'FIXTURETEAM', 'apns.keyId': 'FIXTUREKEY' }), fs: engineIo,
      paths: { home: root, projects: path.join(root, 'projects'), codexCache: path.join(root, 'cache') },
      spawner: () => { throw new Error('no Claude spawn'); },
      codex: { home: path.join(root, 'codex'), codexPath: '/fixture/codex', spawnFn: () => { throw new Error('no Codex spawn'); } },
      delivery: { create: createSelectedDelivery, selection: engineSelection, timers: engineTimers, paths: { apnsKeyFile: keyPath }, ...transportOptions } });
    engines.push(engine);
    checkEqual('engine filesystem injection reaches APNs without a real-filesystem fallback',
      [engine.delivery.apns.state().configured, apnsPathProbes], [false, 1]);
    checkEqual('engine construction exposes delivery without starting its watchers', engine.manager.listenerCount('failed'), 0);
    await Promise.all([engine.start(), engine.start()]);
    checkEqual('the engine starts the selected delivery watcher once', engine.manager.listenerCount('failed'), 1);
    const engineBindings = engine.delivery.serverOptions();
    check('the engine exposes one shared device/auth/delivery graph', engineBindings.devices === engine.delivery.notifier.devices && engineBindings.notificationStream === engine.delivery.stream);
    engine.dispose(); engine.dispose();
    checkEqual('engine disposal owns delivery and leaves no watcher or timer', [engine.delivery.available, engine.manager.listenerCount('failed'), engineTimers.tasks.size], [false, 0, 0]);
    legacy.dispose(); legacy.dispose();
    checkEqual('disposal also removes the legacy delivery watchers once', [manager.eventNames().length, timer.tasks.size], [0, 0]);
    await tick();
  } finally {
    for (const server of servers.reverse()) await server.dispose();
    for (const engine of engines.reverse()) engine.dispose();
    for (const runtime of runtimes.reverse()) runtime.dispose();
  }
};
