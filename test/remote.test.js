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
  const auth = new LocalKey('test-key-not-a-secret');
  host.audit = (entry) => devices.record(entry);

  let fleetChanged = null;
  const server = new RemoteServer({
    root: ROOT, host, sessions, devices, identity, pairing, localKey: auth,
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
