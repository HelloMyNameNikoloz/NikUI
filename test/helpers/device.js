'use strict';

// A phone, as far as the server can tell: a P-256 key pair in WebCrypto, with
// the private half non-extractable, signing exactly what a browser would sign.
// Node's WebCrypto is a different implementation from the host's `crypto.verify`
// path, so this doubles as the interop check on both.

// It also seals the channel when the laptop offers to, which is what a real
// device does. The laptop's own implementation is used for this side rather
// than the browser's, so a socket test stays synchronous and legible; that the
// browser's implementation agrees with it byte for byte is proved separately,
// in test/secure.test.js, and again by a real browser in the browser checks.
const secure = require('../../src/secure.js');

async function makeDevice(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64url');

  const sign = async (message) => {
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(String(message), 'utf8')
    );
    return Buffer.from(signature).toString('base64url');
  };

  const device = {
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
    /**
     * The answer to a challenge, with a nonce of its own — and a throwaway key,
     * when the laptop offered one, because that is what a real device does.
     * `{ plain: true }` is the old shape, for testing what happens to a client
     * that will not seal.
     */
    answer: async (challenge, id, options) => {
      const mine = Buffer.from(String(Date.now()) + ':' + Math.random()).toString('base64url');
      // Either the `@challenge` a socket receives or the state a Gate keeps —
      // the same key, under the name each of them calls it.
      const offered = challenge.epk || (challenge.ephemeral && challenge.ephemeral.spki) || null;
      const plain = !!(options && options.plain) || !offered;
      let suffix = '';
      if (!plain) {
        device.ephemeral = secure.ephemeral();
        suffix = ':' + secure.binding(offered, device.ephemeral.spki);
        // The same agreement the laptop is about to make, from this side: the
        // laptop's box sends to the client, so this one is the mirror of it.
        const theirs = secure.serverBox(device.ephemeral, offered, challenge.nonce, mine);
        device.box = new secure.Box(theirs.receiving, theirs.sending);
      }
      const message = {
        type: '@auth',
        device: id,
        nonce: mine,
        signature: await sign(`nikui-auth:${challenge.nonce}:${mine}` + suffix)
      };
      if (!plain) message.epk = device.ephemeral.spki;
      return message;
    },
    /** Whatever the laptop sent, opened if this device agreed to seal. */
    read: (message) => {
      if (!message || message.type !== '@box' || !device.box) return message;
      const inside = device.box.open(message);
      return inside === null ? null : JSON.parse(inside);
    },
    /** Something to say, sealed if this device agreed to seal. */
    write: (message) => (device.box ? device.box.seal(JSON.stringify(message)) : message)
  };
  return device;
}

module.exports = { makeDevice };
