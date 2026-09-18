'use strict';

// A phone with a key it cannot export, as the two platforms actually behave.
//
// This is the part of a hardware key that no test on this machine can otherwise
// reach: neither the Secure Enclave nor the Android Keystore is here, but both
// hand back exactly two shapes, and both shapes are different from what the
// laptop verifies. Node's `crypto` produces the same two, so the conversion can
// be checked against the real verifier rather than against my reading of a
// specification.

const crypto = require('crypto');

const SPKI_HEADER_LENGTH = 26;

/**
 * @param {'ios'|'android'} platform
 *   `ios`      SecKeyCopyExternalRepresentation → the bare 65-byte point
 *   `android`  PublicKey.getEncoded()          → SPKI already
 * Both sign to DER, which is what neither end of this protocol uses.
 */
function makeSecureDevice(platform, options) {
  const opts = options || {};
  const pair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  const privateKey = crypto.createPrivateKey({ key: pair.privateKey, format: 'der', type: 'pkcs8' });

  return {
    platform,
    protection: opts.protection || (platform === 'ios' ? 'secure-enclave' : 'strongbox'),
    biometric: !!opts.biometric,
    /** What the plugin's `create` and `publicKey` hand to JavaScript. */
    exportedPublicKey: () => Buffer.from(platform === 'ios'
      ? pair.publicKey.subarray(SPKI_HEADER_LENGTH)   // the uncompressed point
      : pair.publicKey).toString('base64'),
    /** The SPKI the laptop should end up with, for comparing against. */
    realSpki: () => Buffer.from(pair.publicKey).toString('base64url'),
    /** What the platform's signer hands back: DER, every time. */
    sign: (message) => crypto.sign('sha256', Buffer.from(String(message), 'utf8'), privateKey)
      .toString('base64')
  };
}

module.exports = { makeSecureDevice, SPKI_HEADER_LENGTH };
