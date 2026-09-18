'use strict';
const http = require('http');
const path = require('path');
const { install, memoryState } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { RemoteServer } = require('../src/remote.js');
const { LocalKey } = require('../src/auth.js');
const { DeviceStore } = require('../src/devices.js');
const { PairingWindow } = require('../src/pairing.js');
const { loadIdentity } = require('../src/identity.js');
const { loadVapid } = require('../src/push.js');
const { closeHub } = require('../src/hub.js');
const ws = require('./helpers/ws.js');
const { makeDevice } = require('./helpers/device.js');
const wire = require('../src/wire.js');

const ROOT = path.join(__dirname, '..');

/** An instance that will never spawn anything. */
function quietSession(name) {
  const s = new Session({ cwd: ROOT });
  s.customTitle = name || null;
  s.start = function () { this.everStarted = true; };
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

function get(port, route, headers) {
  return request({ port, path: route, headers });
}

function request(options) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method || 'GET',
      path: options.path,
      headers: Object.assign({}, options.headers,
        options.body ? { 'content-type': 'application/json' } : null)
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json: parsed });
      });
    });
    req.on('error', reject);
    if (options.body) req.end(JSON.stringify(options.body));
    else req.end();
  });
}

module.exports = async function () {
  const first = quietSession('alpha');
  const second = quietSession('beta');
  const sessions = { list: () => [first, second], get: (id) => [first, second].find((s) => s.id === id) || null };
  const host = {
    config: () => ({ showThinking: true, promptSnippets: {} }),
    home: '/home',
    knownCommands: () => ['status'],
    fleet: () => sessions.list(),
    env: () => ({ vscode: 'test' })
  };

  const memento = memoryState();
  const devices = new DeviceStore(memento);
  const identity = loadIdentity(memoryState());
  const pairing = new PairingWindow();
  const vapid = loadVapid(memoryState());
  const auth = new LocalKey('test-key-not-a-secret');
  host.audit = (entry) => devices.record(entry);

  let fleetChanged = null;
  const server = new RemoteServer({
    root: ROOT, host, sessions, devices, identity, pairing, vapid, localKey: auth,
    watchFleet: (fn) => { fleetChanged = fn; return () => { fleetChanged = null; }; }
  });

  suite('nothing is listening until you say so');

  checkEqual('a server that was never started is not listening', server.listening, false);
  await server.start(0);
  check('starting it listens', server.listening);
  checkEqual('on loopback and nowhere else', server.server.address().address, '127.0.0.1');

  const port = server.port;
  const cookie = { cookie: 'nikui=' + auth.key };

  suite('the pages carry nothing, so they can be public');

  const home = await get(port, '/');
  checkEqual('the fleet page is served without a key', home.status, 200);
  check('and it names no instance', home.body.indexOf('alpha') < 0 && home.body.indexOf('beta') < 0);
  check('because the list arrives over the socket', /home\.js/.test(home.body));

  const page = await get(port, '/s/' + first.id);
  checkEqual('so is the conversation page', page.status, 200);
  check('built from the same template as the panel', /id="transcript"/.test(page.body));
  check('with nothing of the conversation in it', page.body.indexOf('alpha') < 0);
  checkEqual('even for an instance that does not exist', (await get(port, '/s/nope')).status, 200);
  check('and no inline script without a nonce', !/<script(?![^>]*nonce)/.test(page.body));

  const asset = await get(port, '/media/panel.js');
  checkEqual('the client files are served', asset.status, 200);
  checkEqual('as what they are', asset.headers['content-type'], 'text/javascript; charset=utf-8');
  checkEqual('a path that climbs out of media is refused',
    (await get(port, '/media/..%2fpackage.json')).status, 403);
  checkEqual('and a file type we do not serve', (await get(port, '/media/notes.md')).status, 403);

  checkEqual('a Host that is not loopback is refused',
    (await get(port, '/', { host: 'nikui.example.com' })).status, 403);
  checkEqual('an Origin from somewhere else is refused',
    (await get(port, '/', { origin: 'https://evil.example' })).status, 403);

  const handed = await get(port, '/?key=' + auth.key);
  checkEqual('the key in the address bar is traded for a cookie', handed.status, 302);
  check('which is not readable by script', /HttpOnly/.test(String(handed.headers['set-cookie'])));
  check('and is not sent to other sites', /SameSite=Strict/.test(String(handed.headers['set-cookie'])));

  suite('and nowhere but loopback, whatever else this machine has');

  // The issue this answers is "confirm the server cannot be reached other than
  // through loopback, on a machine with several interfaces" — so it asks the
  // machine what interfaces it has and tries every one of them.
  const os = require('os');
  const interfaces = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.internal || address.family !== 'IPv4') continue;
      interfaces.push({ name, address: address.address });
    }
  }
  const reachable = [];
  for (const where of interfaces) {
    const open = await new Promise((resolve) => {
      const socket = require('net').connect({ host: where.address, port, timeout: 800 });
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (open) reachable.push(where.name + ' (' + where.address + ')');
  }
  checkEqual('no other address on this machine answers', reachable, []);
  check('and there was at least one to try, or this proves nothing',
    interfaces.length > 0 || process.env.CI === 'true');
  checkEqual('the socket says the same', server.server.address().address, '127.0.0.1');

  suite('and it is an app you can install');

  const manifest = await get(port, '/manifest.webmanifest');
  checkEqual('the manifest is served', manifest.status, 200);
  checkEqual('as a manifest', manifest.headers['content-type'], 'application/manifest+json; charset=utf-8');
  checkEqual('standing alone rather than in a browser frame', manifest.json.display, 'standalone');
  checkEqual('with somewhere to start', manifest.json.start_url, '/');
  check('and icons big enough for a home screen',
    manifest.json.icons.some((icon) => icon.sizes === '512x512'));
  check('including one the platform may crop to its own shape',
    manifest.json.icons.some((icon) => icon.purpose === 'maskable'));
  checkEqual('the icons are really there',
    (await get(port, '/media/icons/nikui-512.png')).status, 200);
  checkEqual('and the one iOS asks for by name',
    (await get(port, '/media/icons/apple-touch-icon-180.png')).status, 200);

  const worker = await get(port, '/sw.js');
  checkEqual('the worker is served from the root', worker.status, 200);
  checkEqual('so it can look after every page, not just /media',
    worker.headers['service-worker-allowed'], '/');
  check('it caches the shell', /media\/panel\.js/.test(worker.body));
  check('and says plainly that it caches no conversation', /never caches is a conversation/.test(worker.body));

  const shell = await get(port, '/');
  check('the page points at the manifest', /rel="manifest"/.test(shell.body));
  check('carries a colour for the bar at the top', /name="theme-color"/.test(shell.body));
  check('an icon for iOS', /apple-touch-icon/.test(shell.body));
  check('and asks to be full screen there', /apple-mobile-web-app-capable/.test(shell.body));

  suite('being told about things');

  const key = await get(port, '/push/key');
  checkEqual('the sending key is public, because it has to be', key.status, 200);
  checkEqual('and it is the raw point a browser wants', key.json.key, vapid.applicationServerKey);

  const health = await get(port, '/health');
  checkEqual('the laptop can be asked whether it is there at all', health.status, 200);
  checkEqual('and answers nothing else', JSON.stringify(health.json), '{"ok":true}');

  suite('a socket from this machine needs no ceremony');

  const mine = await ws.connect(`ws://127.0.0.1:${port}/socket?session=${first.id}`, { headers: cookie });
  const welcome = await mine.waitFor('@welcome');
  checkEqual('the key in the cookie is enough', welcome.device.kind, 'local');
  check('and it may steer', welcome.device.control === true);
  mine.send({ type: 'ready' });
  const init = await mine.waitFor('init');
  checkEqual('it is answered with the whole picture', init.sessionId, first.id);
  mine.send({ type: 'send', text: 'from the laptop', sent: 'from the laptop', snippets: [] });
  await mine.next('items');
  check('and a prompt reaches the instance',
    first.items.some((i) => i.kind === 'user' && i.text === 'from the laptop'));

  suite('a socket from anywhere else has to prove itself');

  const stranger = await ws.connect(`ws://127.0.0.1:${port}/socket?session=${first.id}`);
  const challenge = await stranger.waitFor('@challenge');
  check('it is challenged, not welcomed', !!challenge.nonce && challenge.nonce.length > 20);
  checkEqual('and told which laptop is asking', challenge.fingerprint, identity.fingerprint);

  const before = first.items.length;
  stranger.send({ type: 'send', text: 'without answering', sent: 'without answering', snippets: [] });
  await new Promise((r) => setTimeout(r, 60));
  checkEqual('anything sent before answering is dropped', first.items.length, before);

  const phone = await makeDevice('Test phone');
  stranger.send({ type: '@auth', device: 'nobody', nonce: 'a'.repeat(24), signature: 'x'.repeat(86) });
  const unknown = await stranger.waitFor('@denied');
  check('a device nobody paired is refused', /not paired/.test(unknown.reason));
  await stranger.waitClosed();
  check('and the socket goes with it', !!stranger.closed);

  suite('pairing a device');

  const noWindow = await request({ port, method: 'POST', path: '/pair', body: await phone.pairingBody('ABCD2345') });
  checkEqual('a code with no window open is refused', noWindow.status, 403);

  const open = pairing.start({ host: '127.0.0.1:' + port, fingerprint: identity.fingerprint, laptop: 'Test laptop' });
  check('a window has a code you could read aloud', /^[A-Z0-9]{8}$/.test(open.code));
  check('and a link a camera could open', open.link.indexOf('/pair#c=' + open.code) > 0);
  check('with the fingerprint to pin', open.link.indexOf(identity.fingerprint) > 0);

  const wrong = await request({ port, method: 'POST', path: '/pair', body: await phone.pairingBody('WRONGONE') });
  checkEqual('a wrong code is refused', wrong.status, 403);
  checkEqual('and closes the window rather than allowing another guess', pairing.isOpen, false);

  const second_ = pairing.start({ host: '127.0.0.1:' + port, fingerprint: identity.fingerprint });
  const forged = await phone.pairingBody(second_.code);
  forged.signature = forged.signature.replace(/^.{4}/, 'AAAA');
  const bad = await request({ port, method: 'POST', path: '/pair', body: forged });
  checkEqual('a forged signature is refused', bad.status, 403);

  const third = pairing.start({ host: '127.0.0.1:' + port, fingerprint: identity.fingerprint });
  const paired = await request({ port, method: 'POST', path: '/pair', body: await phone.pairingBody(third.code) });
  checkEqual('the right code and a real signature pair the device', paired.status, 200);
  checkEqual('which is read-only to begin with', paired.json.control, false);
  checkEqual('and is told the key to pin', paired.json.fingerprint, identity.fingerprint);
  phone.id = paired.json.device;
  checkEqual('the device is remembered', devices.list().length, 1);
  check('with no secret of its own in the record',
    !JSON.stringify(devices.list()[0]).match(/private/i));

  const replayed = await request({ port, method: 'POST', path: '/pair', body: await phone.pairingBody(third.code) });
  checkEqual('the same code cannot be used twice', replayed.status, 403);

  const expiring = new PairingWindow({ ttlMs: 20 });
  expiring.start({});
  await new Promise((r) => setTimeout(r, 40));
  checkEqual('a code nobody used expires', expiring.isOpen, false);

  suite('and can ask to be told when it is not looking');

  const endpoint = 'https://web.push.apple.com/send/' + phone.id;
  const now = Date.now();
  const unsigned = await request({
    port, method: 'POST', path: '/push/subscribe',
    body: { device: phone.id, endpoint, at: now, keys: { p256dh: 'x', auth: 'y' }, signature: 'nope' }
  });
  checkEqual('a subscription nobody signed for is refused', unsigned.status, 403);

  const notMine = await request({
    port, method: 'POST', path: '/push/subscribe',
    body: {
      device: phone.id, endpoint, at: now, keys: { p256dh: 'x', auth: 'y' },
      signature: await phone.sign(`nikui-push:${now}:https://web.push.apple.com/send/somebody-else`)
    }
  });
  checkEqual('and so is one signed for a different endpoint', notMine.status, 403);

  const elsewhere = 'https://internal.example.corp/steal';
  const offSite = await request({
    port, method: 'POST', path: '/push/subscribe',
    body: {
      device: phone.id, endpoint: elsewhere, at: now, keys: { p256dh: 'x', auth: 'y' },
      signature: await phone.sign(`nikui-push:${now}:${elsewhere}`)
    }
  });
  checkEqual('an endpoint that is not a push service is refused, however well signed',
    offSite.status, 400);

  const stale = Date.now() - 600000;
  const captured = await request({
    port, method: 'POST', path: '/push/subscribe',
    body: {
      device: phone.id, endpoint, at: stale, keys: { p256dh: 'x', auth: 'y' },
      signature: await phone.sign(`nikui-push:${stale}:${endpoint}`)
    }
  });
  checkEqual('and a body captured earlier is too old to use', captured.status, 403);

  const subscribed = await request({
    port, method: 'POST', path: '/push/subscribe',
    body: {
      device: phone.id, endpoint,
      at: Date.now(),
      keys: { p256dh: 'BPa6q2n8dFhO8Yd5lHjLgL0kq8i8nqFQlHZ8p6y5v3hYpXsS1bF7oB2aQ0Zq1nGp8wJ2r6xS9cB7nT4uV5wX6yZ', auth: 'c29tZS1hdXRoLXNlY3JldA' },
      signature: await phone.sign(`nikui-push:${Date.now()}:${endpoint}`)
    }
  });
  checkEqual('one the device signed for is kept', subscribed.status, 200);
  checkEqual('against that device, and no second list to forget',
    devices.get(phone.id).push.endpoint, endpoint);
  checkEqual('so it is one of the subscribers', devices.subscribers().length, 1);

  suite('and pairing is not something to sit and hammer at');

  let lastAttempt = null;
  for (let i = 0; i < 14; i++) {
    lastAttempt = await request({ port, method: 'POST', path: '/pair', body: { code: 'NOPENOPE' } });
  }
  checkEqual('an address that keeps trying is told to wait', lastAttempt.status, 429);
  check('and it is written down', server.refusals.some((r) => /too many/.test(r.why)));

  suite('a paired device can watch');

  const watcher = await ws.connect(`ws://127.0.0.1:${port}/socket?session=${first.id}`);
  const ask = await watcher.waitFor('@challenge');
  watcher.send(await phone.answer(ask, phone.id));
  const seated = await watcher.waitFor('@welcome');
  checkEqual('the right signature gets a seat', seated.device.name, 'Test phone');
  checkEqual('read-only, because that is what pairing grants', seated.device.control, false);
  watcher.send({ type: 'ready' });
  const picture = await watcher.waitFor('init');
  checkEqual('and it sees the whole conversation', picture.sessionId, first.id);

  suite('but it cannot steer');

  const held = first.items.length;
  watcher.send({ type: 'send', text: 'from a device with no grant', sent: 'x', snippets: [] });
  const refused = await watcher.waitFor('@refused');
  checkEqual('a forged prompt is refused by the host, not by the client', refused.what, 'send');
  checkEqual('and nothing reaches the instance', first.items.length, held);
  check('the attempt is written down', devices.recent(5).some((e) => e.action === 'send' && e.allowed === false));
  check('with the device that tried it', devices.recent(5)[0].device === 'Test phone');

  watcher.send({ type: 'interrupt' });
  await watcher.next('@refused');
  check('and so is anything else that changes something', true);

  suite('granting control reaches a socket that is already open');

  devices.setControl(phone.id, true);
  const granted = await watcher.waitFor('@device');
  checkEqual('the device is told at once', granted.device.control, true);
  watcher.send({ type: 'send', text: 'now it may', sent: 'now it may', snippets: [] });
  // The instance is mid-turn from the prompt the laptop sent, so this one
  // queues rather than going straight out — which is the point: it arrived.
  await watcher.next('queue');
  check('and the prompt lands',
    first.queue.some((q) => q.text === 'now it may') ||
    first.items.some((i) => i.kind === 'user' && i.text === 'now it may'));
  check('which is written down too',
    devices.recent(10).some((e) => e.action === 'send' && e.allowed === true));

  suite('revoking takes the socket with it');

  devices.forget(phone.id);
  checkEqual('forgetting a device forgets where to reach it too', devices.subscribers().length, 0);
  const dropped = await watcher.waitClosed();
  check('the live socket is closed', !!dropped);
  const afterwards = await ws.connect(`ws://127.0.0.1:${port}/socket?session=${first.id}`);
  const askAgain = await afterwards.waitFor('@challenge');
  afterwards.send(await phone.answer(askAgain, phone.id));
  const denied = await afterwards.waitFor('@denied');
  check('and it cannot come back', /not paired/.test(denied.reason));
  await afterwards.waitClosed();

  suite('the window as a list');

  const fleet = await ws.connect(`ws://127.0.0.1:${port}/socket`, { headers: cookie });
  await fleet.waitFor('@welcome');
  fleet.send({ type: 'ready' });
  const listed = await fleet.waitFor('fleet');
  checkEqual('every instance is listed', listed.instances.length, 2);
  checkEqual('by the name the editor shows', listed.instances[0].label, 'alpha');
  check('with what it costs', typeof listed.instances[0].cost === 'number');
  if (fleetChanged) fleetChanged();
  const again = await fleet.next('fleet');
  check('and the list is sent again when the window changes', !!again);

  suite('a socket that misbehaves is not fatal');

  const rude = await ws.connect(`ws://127.0.0.1:${port}/socket?session=${second.id}`, { headers: cookie });
  await rude.waitFor('@welcome');
  rude.writeRaw(wire.encodeText('unmasked, which a client may never send'));
  const shut = await rude.waitClosed();
  checkEqual('a frame that breaks the rules closes that socket', shut.code, wire.CLOSE.PROTOCOL);
  check('and leaves the instance alone', !!sessions.get(second.id));

  suite('stopping lets go of everything');

  const kept = first.items.length;
  await server.dispose();
  checkEqual('the server is no longer listening', server.listening, false);
  let down = null;
  try { await get(port, '/'); } catch (err) { down = err.code; }
  checkEqual('the port is closed', down, 'ECONNREFUSED');
  checkEqual('the conversation is untouched', first.items.length, kept);

  closeHub(first.id);
  closeHub(second.id);
  first.dispose();
  second.dispose();
};
