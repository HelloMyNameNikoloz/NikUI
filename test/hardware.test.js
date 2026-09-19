'use strict';

// The key that lives in a chip.
//
// Nothing here can run a Secure Enclave or an Android Keystore — this is a
// laptop — so this tests the two things that would otherwise only be discovered
// on a device, and would fail silently when they were:
//
//   the shapes      both platforms hand back a public key and a signature in
//                   encodings the laptop does not read. The conversion is done
//                   once, in media/device.js, and here it is run through the
//                   laptop's real verifier rather than checked against a
//                   specification I read.
//   the move        a phone that paired with a browser key and later gains a
//                   chip has to be able to replace its key without pairing
//                   again, and nothing else may be able to replace it.

const crypto = require('crypto');
const { memoryState } = require('./helpers/vscode-stub.js');
const { DeviceStore, cleanProtection } = require('../src/devices.js');
const { Gate, LocalKey } = require('../src/auth.js');
const { loadIdentity, verifyWith, readPublicKey, fingerprintOf, fromBase64 } = require('../src/identity.js');
const { makeSecureDevice } = require('./helpers/hardware.js');
const { makeDevice } = require('./helpers/device.js');
const laptopSecure = require('../src/secure.js');

// media/device.js is a browser file; these two functions are the reason it has
// an export at all, and they are pure.
global.window = global.window || {};
window.atob = global.atob;
window.btoa = global.btoa;
const { spkiFromPublicKey, p1363FromSignature, P256_SPKI_HEADER, saysKeyIsGone } = require('../media/device.js');

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

module.exports = async function () {
  suite('a chip hands back shapes the laptop does not read');

  const apple = makeSecureDevice('ios');
  const android = makeSecureDevice('android');

  const applePoint = Buffer.from(apple.exportedPublicKey(), 'base64');
  check('Apple gives the bare point, not a key the laptop can read',
    applePoint.length === 65 && applePoint[0] === 0x04 && readPublicKey(b64(applePoint)) === null);

  const appleSpki = spkiFromPublicKey(applePoint);
  checkEqual('wrapped, it is the key that was made', b64(appleSpki), apple.realSpki());
  check('and the laptop reads it', !!readPublicKey(b64(appleSpki)));
  checkEqual('with the fingerprint the phone will be shown',
    readPublicKey(b64(appleSpki)).fingerprint, fingerprintOf(fromBase64(apple.realSpki())));

  const androidKey = Buffer.from(android.exportedPublicKey(), 'base64');
  checkEqual('Android already gives SPKI, and it is left alone',
    b64(spkiFromPublicKey(androidKey)), android.realSpki());

  check('the header is the 26 bytes of a P-256 SPKI and nothing else',
    P256_SPKI_HEADER.length === 26 &&
    Buffer.from(P256_SPKI_HEADER).toString('hex') ===
      '3059301306072a8648ce3d020106082a8648ce3d030107034200');

  let threw = false;
  try { spkiFromPublicKey(new Uint8Array(65)); } catch (_) { threw = true; }
  check('a point that is not a point is refused rather than wrapped', threw);

  suite('a chip signs DER, and the laptop verifies r‖s');

  const derSignature = Buffer.from(apple.sign('nikui-auth:one:two'), 'base64');
  check('what the platform produced is DER', derSignature[0] === 0x30 && derSignature.length !== 64);
  check('and the laptop refuses it as it stands',
    !verifyWith(apple.realSpki(), 'nikui-auth:one:two', b64(derSignature)));

  const converted = p1363FromSignature(derSignature);
  checkEqual('converted, it is exactly 64 bytes', converted.length, 64);
  check('and the laptop believes it',
    verifyWith(apple.realSpki(), 'nikui-auth:one:two', b64(converted)));
  check('but not for anything else it might have said',
    !verifyWith(apple.realSpki(), 'nikui-auth:one:three', b64(converted)));

  // DER integers lose leading zero bytes and gain a padding byte when the top
  // bit is set, so the same key signs to 70, 71 or 72 bytes depending on the
  // message. Every one of them has to come out as 64. A fixed test vector would
  // only ever exercise one of the three.
  const lengths = new Set();
  let everyOne = true;
  for (let i = 0; i < 400; i++) {
    const message = 'nikui-auth:' + crypto.randomBytes(8).toString('hex') + ':n';
    const der = Buffer.from(android.sign(message), 'base64');
    lengths.add(der.length);
    const raw = p1363FromSignature(der);
    if (raw.length !== 64 || !verifyWith(android.realSpki(), message, b64(raw))) everyOne = false;
  }
  check('400 signatures, every one of them verified', everyOne);
  check('and they were not all the same length', lengths.size > 1);

  checkEqual('a platform that already gives r‖s is left alone',
    Buffer.from(p1363FromSignature(new Uint8Array(64).fill(7))).toString('hex'),
    Buffer.from(new Uint8Array(64).fill(7)).toString('hex'));

  const refused = [];
  for (const rubbish of [
    new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01]),                  // says more than it has
    new Uint8Array([0x31, 0x44, 0x02, 0x20]),                        // not a sequence
    new Uint8Array([0x30, 0x06, 0x04, 0x01, 0x01, 0x02, 0x01, 0x01]) // not integers
  ]) {
    try { p1363FromSignature(rubbish); refused.push(false); } catch (_) { refused.push(true); }
  }
  check('nonsense is refused rather than turned into 64 plausible bytes',
    refused.every(Boolean));

  suite('a phone can move its key into the chip without pairing again');

  const state = memoryState();
  const devices = new DeviceStore(state);
  const identity = loadIdentity(state);
  const gate = new Gate({ localKey: new LocalKey(), devices, identity });

  const browserKey = await makeDevice('Nikoloz’s phone');
  const seated = devices.add({ name: browserKey.name, publicKey: browserKey.publicKey });
  devices.setControl(seated.id, true);
  devices.subscribe(seated.id, { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } });
  checkEqual('it paired in the browser', devices.get(seated.id).protection, 'software');
  // The record is the store's own object; the move edits it in place.
  const wasHolding = seated.fingerprint;

  const chip = makeSecureDevice('ios', { biometric: true });
  const chipSpki = b64(spkiFromPublicKey(Buffer.from(chip.exportedPublicKey(), 'base64')));
  const chipFingerprint = readPublicKey(chipSpki).fingerprint;

  // Every connection seals itself, so every message built by hand here has to
  // carry a throwaway key and name it in what it signs — exactly as the real
  // client does. Testing the move over a plain connection would be testing a
  // combination that no longer happens.
  const sealing = (challenge) => {
    const mine = laptopSecure.ephemeral();
    return { epk: mine.spki, suffix: ':' + laptopSecure.binding(challenge.ephemeral.spki, mine.spki) };
  };

  /** What media/device.js sends when a replacement key is waiting. */
  const moveMessage = async (challenge, opts) => {
    const settings = opts || {};
    const mine = crypto.randomBytes(24).toString('base64url');
    const offered = settings.offer || chipSpki;
    const claimed = settings.claim || readPublicKey(offered).fingerprint;
    const seal = sealing(challenge);
    const words = `nikui-rekey:${challenge.nonce}:${mine}:${claimed}` + seal.suffix;
    return {
      type: '@auth',
      device: settings.as || seated.id,
      nonce: mine,
      epk: seal.epk,
      signature: settings.authorise === null ? 'not-a-signature'
        : await (settings.authorise || browserKey).sign(words),
      rekey: {
        publicKey: offered,
        signature: settings.prove === null ? 'not-a-signature'
          : b64(p1363FromSignature(Buffer.from((settings.prove || chip).sign(words), 'base64'))),
        protection: settings.protection || chip.protection,
        biometric: settings.biometric !== undefined ? settings.biometric : true
      }
    };
  };

  const first = gate.challenge();
  const moved = gate.answer(first, await moveMessage(first), { address: '127.0.0.1' });
  check('the laptop accepts a key its own key authorised', moved.ok === true);
  check('and says so, so the phone knows when it is safe to let go of the old one',
    !!(moved.welcome && moved.welcome.rekeyed && moved.welcome.rekeyed.fingerprint === chipFingerprint));

  const after = devices.get(seated.id);
  checkEqual('it is the same device', after.id, seated.id);
  checkEqual('with the same name', after.name, 'Nikoloz’s phone');
  check('and the grant it had already been given', after.control === true);
  check('and still somewhere to be reached', !!(after.push && after.push.endpoint));
  checkEqual('holding a different key now', after.fingerprint, chipFingerprint);
  checkEqual('which it says is in the Secure Enclave', after.protection, 'secure-enclave');
  check('behind a biometric check', after.biometric === true);
  checkEqual('and the key it used to hold is written down', after.previousFingerprint, wasHolding);
  check('the move is in the trail, where a theft would be found',
    devices.recent(3).some((line) => /replaced its key/.test(line.action)));

  const nowOnly = gate.challenge();
  check('the old key no longer opens anything',
    gate.answer(nowOnly, await browserKey.answer(nowOnly, seated.id)).ok === false);
  const withChip = gate.challenge();
  const mine = crypto.randomBytes(24).toString('base64url');
  const chipSeal = sealing(withChip);
  check('and the new one does',
    gate.answer(withChip, {
      type: '@auth', device: seated.id, nonce: mine, epk: chipSeal.epk,
      signature: b64(p1363FromSignature(Buffer.from(
        chip.sign(`nikui-auth:${withChip.nonce}:${mine}` + chipSeal.suffix), 'base64')))
    }).ok === true);

  suite('and nothing else can move it');

  const store2 = memoryState();
  const devices2 = new DeviceStore(store2);
  const gate2 = new Gate({ localKey: new LocalKey(), devices: devices2, identity: loadIdentity(store2) });
  const owner = await makeDevice('The phone');
  const record = devices2.add({ name: owner.name, publicKey: owner.publicKey });
  const target = makeSecureDevice('android');
  const targetSpki = b64(spkiFromPublicKey(Buffer.from(target.exportedPublicKey(), 'base64')));

  const attempt = async (build) => {
    const challenge = gate2.challenge();
    const message = await build(challenge);
    return gate2.answer(challenge, message, { address: '127.0.0.1' });
  };

  // Each builder below asks for its own throwaway key, so `words` needs the
  // suffix handed to it rather than making one nobody else saw.
  const words = (challenge, nonce, fingerprint, suffix) =>
    `nikui-rekey:${challenge.nonce}:${nonce}:${fingerprint}` + (suffix || '');

  const stranger = await makeDevice('Somebody else');
  check('a key the device did not authorise is refused', (await attempt(async (c) => {
    const n = crypto.randomBytes(24).toString('base64url');
    const seal = sealing(c);
    const w = words(c, n, readPublicKey(targetSpki).fingerprint, seal.suffix);
    return {
      type: '@auth', device: record.id, nonce: n, epk: seal.epk,
      signature: await stranger.sign(w),
      rekey: { publicKey: targetSpki, signature: b64(p1363FromSignature(Buffer.from(target.sign(w), 'base64'))) }
    };
  })).ok === false);

  check('a key nobody holds is refused, so a device cannot be locked out',
    (await attempt(async (c) => {
      const n = crypto.randomBytes(24).toString('base64url');
      const seal = sealing(c);
      const w = words(c, n, readPublicKey(targetSpki).fingerprint, seal.suffix);
      return {
        type: '@auth', device: record.id, nonce: n, epk: seal.epk,
        signature: await owner.sign(w),
        rekey: { publicKey: targetSpki, signature: await owner.sign(w) }
      };
    })).ok === false);

  const swap = makeSecureDevice('ios');
  const swapSpki = b64(spkiFromPublicKey(Buffer.from(swap.exportedPublicKey(), 'base64')));
  check('a key swapped for the authorised one in flight is refused',
    (await attempt(async (c) => {
      const n = crypto.randomBytes(24).toString('base64url');
      const seal = sealing(c);
      const w = words(c, n, readPublicKey(targetSpki).fingerprint, seal.suffix);
      return {
        type: '@auth', device: record.id, nonce: n, epk: seal.epk,
        signature: await owner.sign(w),
        rekey: { publicKey: swapSpki, signature: b64(p1363FromSignature(Buffer.from(swap.sign(w), 'base64'))) }
      };
    })).ok === false);

  check('a request to move stripped back to a plain answer is refused',
    (await attempt(async (c) => {
      const n = crypto.randomBytes(24).toString('base64url');
      const seal = sealing(c);
      const w = words(c, n, readPublicKey(targetSpki).fingerprint, seal.suffix);
      return { type: '@auth', device: record.id, nonce: n, epk: seal.epk, signature: await owner.sign(w) };
    })).ok === false);

  check('and a plain answer dressed up as a move is refused',
    (await attempt(async (c) => {
      const n = crypto.randomBytes(24).toString('base64url');
      const seal = sealing(c);
      return {
        type: '@auth', device: record.id, nonce: n, epk: seal.epk,
        signature: await owner.sign(`nikui-auth:${c.nonce}:${n}` + seal.suffix),
        rekey: { publicKey: targetSpki, signature: b64(p1363FromSignature(Buffer.from(target.sign('x'), 'base64'))) }
      };
    })).ok === false);

  const replayable = gate2.challenge();
  const once = await (async () => {
    const n = crypto.randomBytes(24).toString('base64url');
    const seal = sealing(replayable);
    const w = words(replayable, n, readPublicKey(targetSpki).fingerprint, seal.suffix);
    return {
      type: '@auth', device: record.id, nonce: n, epk: seal.epk,
      signature: await owner.sign(w),
      rekey: { publicKey: targetSpki, signature: b64(p1363FromSignature(Buffer.from(target.sign(w), 'base64'))) }
    };
  })();
  check('the move works once', gate2.answer(replayable, once).ok === true);
  check('and the same recording of it is worth nothing afterwards',
    gate2.answer(gate2.challenge(), once).ok === false);

  const other = await makeDevice('Another phone');
  const otherRecord = devices2.add({ name: other.name, publicKey: other.publicKey });
  check('two devices cannot end up sharing one key', (await attempt(async (c) => {
    const n = crypto.randomBytes(24).toString('base64url');
    const seal = sealing(c);
    const w = words(c, n, readPublicKey(targetSpki).fingerprint, seal.suffix);
    return {
      type: '@auth', device: otherRecord.id, nonce: n, epk: seal.epk,
      signature: await other.sign(w),
      rekey: { publicKey: targetSpki, signature: b64(p1363FromSignature(Buffer.from(target.sign(w), 'base64'))) }
    };
  })).ok === false);

  const rsa = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  for (const nonsense of [b64(rsa.publicKey), 'not-a-key', '', null]) {
    check('a replacement that is not a P-256 key is refused: ' + String(nonsense).slice(0, 12),
      (await attempt(async (c) => {
        const n = crypto.randomBytes(24).toString('base64url');
        const seal = sealing(c);
        return {
          type: '@auth', device: record.id, nonce: n, epk: seal.epk,
          signature: await owner.sign(words(c, n, 'x', seal.suffix)),
          rekey: { publicKey: nonsense, signature: 'x' }
        };
      })).ok === false);
  }

  suite('what a device says about its own key is treated as a claim');

  checkEqual('a word the laptop knows is kept', cleanProtection('strongbox'), 'strongbox');
  checkEqual('a word it does not is not put on a screen', cleanProtection('unbreakable'), 'unknown');
  checkEqual('and saying nothing means the browser', cleanProtection(undefined), 'software');
  checkEqual('case is not a way to smuggle one in', cleanProtection('Secure-Enclave'), 'secure-enclave');


  suite('a key that is gone, and a chip that merely will not answer');

  // The record a phone keeps is a name, not a key. When the two come apart —
  // an app rebuilt under a different signing team sees a different keychain
  // access group and none of what the last build stored — every signature fails
  // and the only cure is a new key. But almost every *other* way a chip says no
  // is temporary, and reacting to one of those by making a new key would throw
  // away a working pairing because a phone was in a pocket.
  const gone = (err) => saysKeyIsGone(err);

  check('a native NO_KEY is the identity being gone', gone({ code: 'NO_KEY' }));
  check('so is a build that cannot reach its own keychain',
    gone({ code: 'NO_ENTITLEMENT' }));
  check('the sentence older builds used is still understood',
    gone(new Error('no key under that name')));
  check('and the one the new build uses', gone(new Error('this app holds no key called nikui.device.7')));

  check('a locked phone is not', gone({ code: 'LOCKED' }) === false);
  check('nor a keystore having a bad moment', gone({ code: 'KEYSTORE_ERROR' }) === false);
  check('nor a cancelled face check', gone({ code: 'CANCELLED' }) === false);
  check('nor a chip that would not sign', gone(new Error('the chip would not sign: -25293')) === false);
  check('nor a keychain error with a number in it', gone({ code: 'KEYCHAIN_ERROR' }) === false);
  check('nor nothing at all', gone(null) === false && gone(undefined) === false);
  check('nor an error with neither code nor message', gone({}) === false);

  // Capacitor puts the code on `errorCode` on one platform and `code` on the
  // other, and a check that only read one of them would be half a check.
  check('the code is read wherever Capacitor put it', gone({ errorCode: 'NO_KEY' }));
};
