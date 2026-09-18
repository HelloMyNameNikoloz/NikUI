'use strict';

const crypto = require('crypto');

/**
 * This laptop's own key, and the fingerprint a phone pins it by.
 *
 * The pairing QR carries the fingerprint, and every connection afterwards makes
 * the server prove it still holds the matching private key. That is what stops
 * something else on the network answering to this address later: a phone that
 * has paired once will refuse anything that cannot sign for the key it saw.
 *
 * It is generated once and kept, because a key that changed on every restart
 * would make pinning meaningless.
 */

const KEY = 'nikui.identity';
const ALGORITHM = 'sha256';
const CURVE = 'prime256v1'; // P-256, what WebCrypto calls ECDSA/P-256

function loadIdentity(store) {
  const saved = store && store.get ? store.get(KEY, null) : null;
  if (saved && saved.publicKey && saved.privateKey) {
    try { return build(fromBase64(saved.publicKey), fromBase64(saved.privateKey), store); }
    catch (_) { /* unreadable: make a new one rather than refusing to start */ }
  }
  const pair = crypto.generateKeyPairSync('ec', {
    namedCurve: CURVE,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  if (store && store.update) {
    store.update(KEY, { publicKey: toBase64(pair.publicKey), privateKey: toBase64(pair.privateKey) });
  }
  return build(pair.publicKey, pair.privateKey, store);
}

function build(publicDer, privateDer) {
  const privateKey = crypto.createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
  return {
    publicKeySpki: toBase64(publicDer),
    fingerprint: fingerprintOf(publicDer),
    sign: (message) => toBase64(crypto.sign(ALGORITHM, Buffer.from(message, 'utf8'), {
      key: privateKey,
      // WebCrypto's ECDSA signatures are r‖s, not DER. Both ends have to agree
      // or every signature looks forged.
      dsaEncoding: 'ieee-p1363'
    })),
    verifyOwn: (message, signature) => verify(publicKey, message, signature)
  };
}

/**
 * Half a SHA-256 of the public key, which is a 128-bit second-preimage barrier
 * and 22 characters on a screen rather than 43.
 */
function fingerprintOf(publicDer) {
  return toBase64(crypto.createHash('sha256').update(publicDer).digest().subarray(0, 16));
}

/** Verify a signature made by a device, given the SPKI it paired with. */
function verifyWith(publicKeySpki, message, signature) {
  let key;
  try {
    key = crypto.createPublicKey({ key: fromBase64(publicKeySpki), format: 'der', type: 'spki' });
  } catch (_) { return false; }
  return verify(key, message, signature);
}

function verify(key, message, signature) {
  let bytes;
  try { bytes = fromBase64(signature); } catch (_) { return false; }
  // P-256 r‖s is exactly 64 bytes; anything else is not a signature we made.
  if (!bytes || bytes.length !== 64) return false;
  try {
    return crypto.verify(ALGORITHM, Buffer.from(message, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' }, bytes);
  } catch (_) { return false; }
}

/** A public key offered by a phone, only if it really is a P-256 public key. */
function readPublicKey(spkiBase64) {
  try {
    const der = fromBase64(spkiBase64);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    const details = key.asymmetricKeyDetails || {};
    if (key.asymmetricKeyType !== 'ec' || details.namedCurve !== 'prime256v1') return null;
    return { spki: toBase64(der), fingerprint: fingerprintOf(der) };
  } catch (_) { return null; }
}

const toBase64 = (buffer) => Buffer.from(buffer).toString('base64url');
const fromBase64 = (text) => Buffer.from(String(text || ''), 'base64url');

module.exports = { loadIdentity, verifyWith, readPublicKey, fingerprintOf, toBase64, fromBase64 };
