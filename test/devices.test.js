'use strict';
const { memoryState } = require('./helpers/vscode-stub.js');
const { DeviceStore, cleanName, TRAIL_LIMIT } = require('../src/devices.js');
const { PairingWindow, ALPHABET, LENGTH } = require('../src/pairing.js');
const { loadIdentity, verifyWith, readPublicKey } = require('../src/identity.js');
const { makeDevice } = require('./helpers/device.js');

module.exports = async function () {
  suite('this laptop knows its own key');

  const kept = memoryState();
  const identity = loadIdentity(kept);
  const again = loadIdentity(kept);
  checkEqual('it is made once and kept', again.fingerprint, identity.fingerprint);
  check('the fingerprint is short enough to print', identity.fingerprint.length === 22);
  check('and the private half is never in what it hands out',
    !JSON.stringify({ key: identity.publicKeySpki }).match(/PRIVATE/i));

  const signature = identity.sign('nikui-host:a:b');
  check('it can prove itself', identity.verifyOwn('nikui-host:a:b', signature));
  check('and cannot prove something it did not say', !identity.verifyOwn('nikui-host:a:c', signature));

  const fresh = loadIdentity(memoryState());
  check('another window has another key', fresh.fingerprint !== identity.fingerprint);
  check('and cannot sign for this one', !identity.verifyOwn('x', fresh.sign('x')));

  suite('a device is known by its key');

  const store = memoryState();
  const devices = new DeviceStore(store);
  const phone = await makeDevice('Test phone');

  checkEqual('nothing is paired to begin with', devices.list().length, 0);
  const paired = devices.add({ name: phone.name, publicKey: phone.publicKey });
  check('pairing keeps the public key', paired.publicKey === phone.publicKey);
  checkEqual('and nothing secret', Object.keys(paired).filter((k) => /private|secret/i.test(k)), []);
  checkEqual('a paired device may only watch', paired.control, false);

  const signed = await phone.sign('nikui-auth:one:two');
  check('it can prove it holds the key', devices.verify(paired.id, 'nikui-auth:one:two', signed));
  check('but not for another message', !devices.verify(paired.id, 'nikui-auth:one:three', signed));

  const impostor = await makeDevice('Not the phone');
  const forged = await impostor.sign('nikui-auth:one:two');
  check('and another key cannot answer for it', !devices.verify(paired.id, 'nikui-auth:one:two', forged));

  check('a key that is not P-256 is refused', devices.add({ name: 'nonsense', publicKey: 'bm90YWtleQ' }) === null);
  check('and so is an RSA one', readPublicKey(rsaSpki()) === null);

  checkEqual('the same phone pairing again is the same device',
    devices.add({ name: phone.name, publicKey: phone.publicKey }).id, paired.id);
  checkEqual('not a second one', devices.list().length, 1);

  suite('control is granted, not assumed');

  devices.setControl(paired.id, true);
  checkEqual('a grant sticks', devices.get(paired.id).control, true);
  devices.setControl(paired.id, false);
  checkEqual('and can be taken back', devices.get(paired.id).control, false);
  check('both are written down',
    devices.trail().filter((e) => /control/.test(e.action)).length === 2);

  suite('what a device did outlives the window');

  devices.record({ device: paired, action: 'send', instance: '1327', allowed: true });
  devices.record({ device: paired, action: 'send', instance: '1327', allowed: false });
  const reopened = new DeviceStore(store);
  checkEqual('the devices come back', reopened.list().length, 1);
  check('and so does the trail', reopened.trail().length >= 4);
  checkEqual('newest first, for anything that shows it', reopened.recent(1)[0].allowed, false);
  check('a refused attempt is kept, not swallowed',
    reopened.trail().some((e) => e.action === 'send' && e.allowed === false));

  for (let i = 0; i < TRAIL_LIMIT + 20; i++) devices.record({ device: paired, action: 'tick' });
  checkEqual('the trail is bounded', devices.trail().length, TRAIL_LIMIT);

  devices.forget(paired.id);
  checkEqual('forgetting a device forgets its key', devices.list().length, 0);
  check('and says so in the trail', devices.recent(1)[0].action === 'forgotten');

  suite('a name from somewhere else is still a name');

  checkEqual('control characters are taken out',
    cleanName('My' + String.fromCharCode(0) + 'phone' + String.fromCharCode(10) + 'X'), 'My phone X');
  checkEqual('and it cannot be long enough to break a row',
    cleanName('x'.repeat(200)).length, 32);
  checkEqual('an empty one is empty rather than undefined', cleanName(null), '');
  checkEqual('markup is not treated as markup here either',
    cleanName('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');

  suite('the minute in which a device may introduce itself');

  const window = new PairingWindow();
  checkEqual('nothing is open by default', window.isOpen, false);
  checkEqual('and a code claimed against nothing is refused', window.claim('ABCD2345').ok, false);

  const open = window.start({ host: '127.0.0.1:4517', fingerprint: identity.fingerprint, laptop: 'Laptop' });
  checkEqual('a code is eight characters', open.code.length, LENGTH);
  check('from an alphabet you can read aloud',
    open.code.split('').every((c) => ALPHABET.includes(c)));
  check('with nothing in it to misread', !/[IO01U]/.test(open.code));
  check('the link is one a camera can open', /^http:\/\/127\.0\.0\.1:4517\/pair#/.test(open.link));
  check('the code rides in the fragment, which is never sent to a server',
    open.link.indexOf('#') > 0 && open.link.indexOf('c=' + open.code) > open.link.indexOf('#'));
  check('and the fingerprint with it', open.link.indexOf(identity.fingerprint) > 0);

  checkEqual('a wrong code is refused', window.claim('WRONGONE').ok, false);
  checkEqual('and there is no second guess', window.isOpen, false);

  const second = new PairingWindow();
  const live = second.start({});
  checkEqual('the right code pairs', second.claim(live.code).ok, true);
  checkEqual('once', second.claim(live.code).ok, false);

  const spaced = new PairingWindow();
  const typed = spaced.start({});
  checkEqual('a code typed with spaces and in lower case still works',
    spaced.claim(' ' + typed.code.toLowerCase().replace(/(.{4})/, '$1 ') + ' ').ok, true);

  let clock = 1000;
  const timed = new PairingWindow({ ttlMs: 60000, now: () => clock });
  const willExpire = timed.start({});
  clock += 59000;
  check('a code is good for the minute', timed.isOpen);
  clock += 2000;
  checkEqual('and not a second longer', timed.isOpen, false);
  checkEqual('using it afterwards is refused', timed.claim(willExpire.code).ok, false);

  const codes = new Set();
  for (let i = 0; i < 200; i++) codes.add(new PairingWindow().start({}).code);
  checkEqual('every code is a new one', codes.size, 200);

  suite('the whole exchange, as the phone does it');

  // Node's WebCrypto on one side, the host's verify on the other: two
  // implementations, which is the only kind of agreement worth having.
  const arriving = await makeDevice('A real phone');
  const window2 = new PairingWindow();
  const invite = window2.start({ fingerprint: identity.fingerprint });
  const body = await arriving.pairingBody(invite.code);
  checkEqual('the code is spent by the right signature', window2.claim(body.code).ok, true);
  check('and that signature is over the code itself',
    verifyWith(body.publicKey, 'nikui-pair:' + invite.code, body.signature));
  check('not over anything else', !verifyWith(body.publicKey, 'nikui-pair:SOMETHING', body.signature));
};

/** An RSA key, to prove the curve check is doing something. */
function rsaSpki() {
  const { publicKey } = require('crypto').generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  return Buffer.from(publicKey).toString('base64url');
}
