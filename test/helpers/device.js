'use strict';

// A phone, as far as the server can tell: a P-256 key pair in WebCrypto, with
// the private half non-extractable, signing exactly what a browser would sign.
// Node's WebCrypto is a different implementation from the host's `crypto.verify`
// path, so this doubles as the interop check on both.

async function makeDevice(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64url');

  const sign = async (message) => {
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(String(message), 'utf8')
    );
    return Buffer.from(signature).toString('base64url');
  };

  return {
    name: name || 'A phone',
    publicKey: spki,
    id: null,
    sign,
    /** The body a phone POSTs to /pair. */
    pairingBody: async (code) => ({
      code,
      name: name || 'A phone',
      publicKey: spki,
      signature: await sign('nikui-pair:' + String(code).toUpperCase())
    }),
    /** The answer to a challenge, with a nonce of its own. */
    answer: async (challenge, id) => {
      const mine = Buffer.from(String(Date.now()) + ':nonce-from-the-device').toString('base64url');
      return {
        type: '@auth',
        device: id,
        nonce: mine,
        signature: await sign(`nikui-auth:${challenge.nonce}:${mine}`)
      };
    }
  };
}

module.exports = { makeDevice };
