'use strict';

// The sealed channel.
//
// TLS already carries this traffic and the laptop already proves who it is, so
// nobody can *be* the laptop. What this layer exists for is the one who holds a
// certificate for the name — a compromised authority, a relay that terminates
// TLS, a profile installed on the phone — and can therefore read everything.
//
// It is written twice, in Node and in a browser, because it runs in both. Two
// implementations of one format is a standing offer to drift apart, so the
// first thing here is that they have not.

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const laptop = require('../src/secure.js');
const { RemoteServer } = require('../src/remote.js');
const { memoryState } = require('./helpers/vscode-stub.js');
const { DeviceStore } = require('../src/devices.js');
const { Gate, LocalKey } = require('../src/auth.js');
const { loadIdentity } = require('../src/identity.js');
const { makeDevice } = require('./helpers/device.js');

// media/secure.js is a browser file, and this is the browser it gets.
global.window = global.window || {};
window.crypto = window.crypto || globalThis.crypto;
window.atob = window.atob || globalThis.atob;
window.btoa = window.btoa || globalThis.btoa;
const browser = require('../media/secure.js');

const flip = (frame) => {
  const bytes = laptop.fromBase64(frame.c);
  bytes[0] ^= 1;
  return { type: '@box', n: frame.n, c: laptop.toBase64(bytes) };
};

module.exports = async function () {
  suite('the two halves of one envelope');

  const phoneKey = await browser.ephemeral();
  const laptopKey = laptop.ephemeral();

  checkEqual('both ends compute the same binding from the same two keys',
    await browser.binding(laptopKey.spki, phoneKey.spki),
    laptop.binding(laptopKey.spki, phoneKey.spki));

  const server = laptop.serverBox(laptopKey, phoneKey.spki, 'ns', 'nc');
  const phone = await browser.clientBox(phoneKey, laptopKey.spki, 'ns', 'nc');
  check('the laptop agreed a channel', !!server);
  check('and so did the phone', !!phone);

  const down = server.seal('{"type":"@welcome","device":{"name":"a phone"}}');
  checkEqual('what the laptop seals, the phone opens',
    await phone.open(down), '{"type":"@welcome","device":{"name":"a phone"}}');

  const up = await phone.seal('{"type":"send","text":"from the phone"}');
  checkEqual('and what the phone seals, the laptop opens',
    server.open(up), '{"type":"send","text":"from the phone"}');

  check('nothing readable travels in the envelope',
    !/welcome|a phone|from the phone/.test(JSON.stringify(down) + JSON.stringify(up)));

  suite('a recording of it is worth nothing');

  const again = laptop.serverBox(laptop.ephemeral(), phoneKey.spki, 'ns', 'nc');
  check('a second connection agrees different keys, from the same device',
    again.sending.key.toString('hex') !== server.sending.key.toString('hex'));

  const sameKeys = laptop.serverBox(laptopKey, phoneKey.spki, 'ns-2', 'nc');
  check('and so does the same pair of keys with a different nonce',
    sameKeys.sending.key.toString('hex') !== server.sending.key.toString('hex'));

  const fresh = laptop.serverBox(laptopKey, phoneKey.spki, 'ns', 'nc');
  const phoneAgain = await browser.clientBox(phoneKey, laptopKey.spki, 'ns', 'nc');
  const one = fresh.seal('one');
  const two = fresh.seal('two');
  checkEqual('messages open in the order they were sealed', await phoneAgain.open(one), 'one');
  checkEqual('and the next one after that', await phoneAgain.open(two), 'two');
  checkEqual('the same message a second time is refused', await phoneAgain.open(two), null);
  checkEqual('and so is one from before the last one', await phoneAgain.open(one), null);

  const tamperer = laptop.serverBox(laptopKey, phoneKey.spki, 'ns', 'nc');
  const whole = tamperer.seal('{"type":"send","text":"do the safe thing"}');
  const edited = flip(whole);
  const reader = await browser.clientBox(phoneKey, laptopKey.spki, 'ns', 'nc');
  checkEqual('a byte changed in flight opens to nothing at all', await reader.open(edited), null);
  checkEqual('and having refused it, the next real one still opens',
    await reader.open(whole), '{"type":"send","text":"do the safe thing"}');

  const mirror = laptop.serverBox(laptopKey, phoneKey.spki, 'ns', 'nc');
  const itsOwn = mirror.seal('said by the laptop');
  const laptopReading = laptop.serverBox(laptopKey, phoneKey.spki, 'ns', 'nc');
  checkEqual('what the laptop said cannot be played back at the laptop',
    laptopReading.open(itsOwn), null);

  suite('a key that is not a key');

  const wrongCurve = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp384r1', publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  const rsa = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  const onePoint = laptop.fromBase64(phoneKey.spki);
  onePoint[40] ^= 0xff; // no longer a point on the curve

  for (const [what, offered] of [
    ['a key on another curve', laptop.toBase64(wrongCurve.publicKey)],
    ['a key of another kind', laptop.toBase64(rsa.publicKey)],
    ['a point that is not on the curve', laptop.toBase64(onePoint)],
    ['something that is not a key at all', 'aGVsbG8'],
    ['nothing', '']
  ]) {
    check('refused: ' + what, laptop.readEphemeral(offered) === null);
    check('and no channel is agreed from it: ' + what,
      laptop.serverBox(laptopKey, offered, 'ns', 'nc') === null);
  }

  suite('the counter, which must never repeat');

  const base = Buffer.alloc(12, 7);
  const seen = new Set();
  for (const counter of [0, 1, 2, 255, 256, 65535, 65536, 1e6, Math.pow(2, 40)]) {
    seen.add(laptop.nonceFor(base, counter).toString('hex'));
  }
  checkEqual('every counter gives a different starting point', seen.size, 9);
  checkEqual('and the browser computes the same ones',
    Buffer.from(browser.nonceFor(new Uint8Array(base), 65536)).toString('hex'),
    laptop.nonceFor(base, 65536).toString('hex'));

  const full = laptop.serverBox(laptopKey, phoneKey.spki, 'ns', 'nc');
  full.sent = laptop.CEILING;
  let stopped = false;
  try { full.seal('one too many'); } catch (_) { stopped = true; }
  check('a socket that has said two hundred and eighty trillion things stops', stopped);
  checkEqual('and nothing is opened past the ceiling',
    full.open({ type: '@box', n: laptop.CEILING, c: 'x'.repeat(40) }), null);

  suite('agreeing it is part of proving who you are');

  const state = memoryState();
  const devices = new DeviceStore(state);
  const identity = loadIdentity(state);
  const gate = new Gate({ localKey: new LocalKey(), devices, identity });
  const device = await makeDevice('A phone');
  const record = devices.add({ name: device.name, publicKey: device.publicKey });

  const honest = gate.challenge();
  check('the laptop offers a throwaway key to everyone', !!honest.ephemeral && !!honest.ephemeral.spki);
  check('and puts it in the challenge', !!gate.challengeMessage(honest).epk);

  const sealed = gate.answer(honest, await device.answer(honest, record.id));
  check('a device that agrees one is seated', sealed.ok === true);
  check('with a channel to talk over', !!sealed.box);
  // The welcome goes out inside the envelope, which is only readable by the
  // device that agreed it — a box never opens what it sealed itself.
  const wrapped = sealed.box.seal(JSON.stringify(sealed.welcome));
  check('the welcome itself travels sealed', wrapped.type === '@box' && !/welcome/.test(wrapped.c));
  check('and the device that agreed the channel reads it',
    device.read(wrapped).type === '@welcome');

  const plain = gate.challenge();
  const unsealed = gate.answer(plain, await device.answer(plain, record.id, { plain: true }));
  check('a device that will not agree one is refused', unsealed.ok === false);
  check('and told why', /sealed/.test(unsealed.reason));

  const lenient = new Gate({
    localKey: new LocalKey(), devices, identity, requireSealed: () => false
  });
  const tolerated = lenient.challenge();
  const allowed = lenient.answer(tolerated, await device.answer(tolerated, record.id, { plain: true }));
  check('unless this window has been told to allow it', allowed.ok === true);
  check('in which case there is no channel, and it says so', !allowed.box && allowed.sealed === false);

  // The attack this binding exists for: somebody between the two ends swaps the
  // throwaway keys for their own, so both sides agree a secret with them
  // instead of with each other. The signature is over both keys, so it fails.
  const middled = gate.challenge();
  const honestAnswer = await device.answer(middled, record.id);
  const theirs = laptop.ephemeral();
  check('a throwaway key swapped in flight invalidates the answer',
    gate.answer(middled, Object.assign({}, honestAnswer, { epk: theirs.spki })).ok === false);
  check('and so does stripping it to force a plain connection',
    gate.answer(gate.challenge(), Object.assign({}, honestAnswer, { epk: undefined })).ok === false);

  const rotten = gate.challenge();
  const rottenAnswer = await device.answer(rotten, record.id);
  check('and so does offering something that is not a key',
    gate.answer(rotten, Object.assign({}, rottenAnswer, { epk: 'not-a-key' })).ok === false);

  const replayed = gate.challenge();
  const once = await device.answer(replayed, record.id);
  check('the answer works once', gate.answer(replayed, once).ok === true);
  check('and not on the next connection', gate.answer(gate.challenge(), once).ok === false);
  suite('serving the app, and nothing else');

  // The app carries its own copy of the client, so from anywhere but this
  // machine there is no reason for a page, a stylesheet or a service worker to
  // exist at all. Turning them off is not defence in depth — it is removing
  // depth that was only ever there for a browser.

  let appOnly = false;
  const served = new RemoteServer({
    root: path.join(__dirname, '..'),
    host: { config: () => ({ promptSnippets: {} }), home: '/tmp', knownCommands: () => [],
      fleet: () => [], env: () => ({}) },
    sessions: { list: () => [], get: () => null },
    devices, identity, localKey: new LocalKey(),
    appOnly: () => appOnly
  });
  await served.start(0);
  const tailnet = 'laptop.tailnet.ts.net';
  served.publicHost = tailnet;

  const ask = (route, host, method) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: served.port, path: route, method: method || 'GET',
      headers: { host: host }
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

  const loopback = '127.0.0.1:' + served.port;
  checkEqual('with it off, the tunnel gets a page', await ask('/', tailnet), 200);

  appOnly = true;
  for (const [route, why] of [
    ['/', 'the fleet page'],
    ['/s/nik-1', 'a conversation'],
    ['/media/panel.css', 'anything a page would load'],
    ['/sw.js', 'the service worker'],
    ['/manifest.webmanifest', 'the manifest'],
    ['/pair', 'the pairing page a browser would open']
  ]) {
    checkEqual('with it on, the tunnel gets nothing: ' + why, await ask(route, tailnet), 404);
  }

  checkEqual('but the pulse still answers, or a phone cannot tell dead from refused',
    await ask('/health', tailnet), 200);
  checkEqual('and the app can still pair', await ask('/pair', tailnet, 'POST') !== 404, true);

  checkEqual('this machine’s own browser is untouched', await ask('/', loopback), 200);
  checkEqual('including everything it loads', await ask('/media/panel.css', loopback), 200);

  check('and a refusal is written down, so it is not a mystery later',
    served.refusals.some((r) => /app-only/.test(r.why || r.reason || JSON.stringify(r))));

  await served.dispose();
};
