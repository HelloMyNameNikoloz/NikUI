/* The browser's half of the sealed channel.

   The laptop's half is src/secure.js, and the two have to agree exactly — the
   same key agreement, the same derivation, the same counter folded into the
   same nonce — or every message looks like a forgery to the other end. They are
   written twice because one runs in Node and one in a browser, and checked
   against each other in test/secure.test.js, which is the only thing that makes
   two implementations of one format safe.

   Why any of it: TLS already carries this, and the laptop already proves who it
   is by signing a nonce with the key this device pinned. What TLS alone does
   not survive is somebody who holds a certificate for the name — a compromised
   authority, a relay that terminates TLS, a profile installed on this phone.
   They still could not *be* the laptop. Without this they could read
   everything. */
(function () {
  'use strict';

  const VERSION = 'nikui-e2e:v1';
  const KEY_BITS = 256;
  const NONCE_BYTES = 12;
  const MATERIAL = (32 + NONCE_BYTES) * 2;
  const CEILING = Math.pow(2, 48);

  const subtle = () => window.crypto.subtle;

  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const fromBase64 = (text) => {
    const padded = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = window.atob(padded + '==='.slice((padded.length + 3) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const available = () => !!(window.crypto && window.crypto.subtle);

  /** A key pair for exactly one connection, thrown away with it. */
  function ephemeral() {
    return subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
      .then(function (pair) {
        return subtle().exportKey('spki', pair.publicKey).then(function (spki) {
          return { privateKey: pair.privateKey, spki: toBase64(spki) };
        });
      });
  }

  /** What both signatures name, so neither throwaway key can be swapped in flight. */
  function binding(serverSpki, clientSpki) {
    const server = fromBase64(serverSpki);
    const client = fromBase64(clientSpki);
    const both = new Uint8Array(server.length + client.length);
    both.set(server, 0);
    both.set(client, server.length);
    return subtle().digest('SHA-256', both).then(toBase64);
  }

  function derive(shared, serverNonce, clientNonce) {
    const label = new TextEncoder().encode(String(serverNonce) + ':' + String(clientNonce));
    return subtle().digest('SHA-256', label).then(function (salt) {
      return subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']).then(function (key) {
        return subtle().deriveBits({
          name: 'HKDF', hash: 'SHA-256', salt: salt,
          info: new TextEncoder().encode(VERSION)
        }, key, MATERIAL * 8);
      });
    }).then(function (material) {
      const bytes = new Uint8Array(material);
      let at = 0;
      const take = (n) => bytes.slice(at, at += n);
      const toClient = { key: take(32), base: take(NONCE_BYTES) };
      const toServer = { key: take(32), base: take(NONCE_BYTES) };
      return Promise.all([importAes(toClient), importAes(toServer)])
        .then(function (pair) { return { toClient: pair[0], toServer: pair[1] }; });
    });
  }

  function importAes(side) {
    return subtle().importKey('raw', side.key, { name: 'AES-GCM', length: KEY_BITS }, false,
      ['encrypt', 'decrypt']).then(function (key) { return { key: key, base: side.base }; });
  }

  /** A counter, folded into the starting point, so no nonce is ever used twice. */
  function nonceFor(base, counter) {
    const out = new Uint8Array(base);
    for (let i = 0; i < 6; i++) {
      out[NONCE_BYTES - 1 - i] ^= (Math.floor(counter / Math.pow(256, i)) & 0xff);
    }
    return out;
  }

  /** The sealed channel, once both ends have agreed. */
  function Box(sending, receiving) {
    this.sending = sending;
    this.receiving = receiving;
    this.sent = 0;
    // Strictly increasing, because a WebSocket delivers in order: anything out
    // of order is a replay or a rearrangement, and neither is a message.
    this.seen = -1;
  }

  Box.prototype.seal = function (text) {
    if (this.sent >= CEILING) return Promise.reject(new Error('this connection has said enough'));
    const counter = this.sent++;
    return subtle().encrypt(
      { name: 'AES-GCM', iv: nonceFor(this.sending.base, counter), tagLength: 128 },
      this.sending.key, new TextEncoder().encode(String(text))
    ).then(function (sealed) {
      return { type: '@box', n: counter, c: toBase64(sealed) };
    });
  };

  /** Resolves to the message inside, or to null if it was not one. */
  Box.prototype.open = function (frame) {
    const self = this;
    if (!frame || typeof frame.n !== 'number' || Math.floor(frame.n) !== frame.n) {
      return Promise.resolve(null);
    }
    if (frame.n <= this.seen || frame.n >= CEILING) return Promise.resolve(null);
    const bytes = fromBase64(frame.c);
    if (bytes.length < 17) return Promise.resolve(null);
    return subtle().decrypt(
      { name: 'AES-GCM', iv: nonceFor(this.receiving.base, frame.n), tagLength: 128 },
      this.receiving.key, bytes
    ).then(function (plain) {
      self.seen = frame.n;
      return new TextDecoder().decode(plain);
    }).catch(function () {
      // A tag that does not check out is not a corrupt message to recover from.
      return null;
    });
  };

  /**
   * This device's side, from its own throwaway key and the laptop's.
   * Resolves to null if what the laptop offered was not a usable key.
   */
  function clientBox(mine, theirSpki, serverNonce, clientNonce) {
    return subtle().importKey('spki', fromBase64(theirSpki),
      { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      .then(function (theirs) {
        return subtle().deriveBits({ name: 'ECDH', public: theirs }, mine.privateKey, 256);
      })
      .then(function (shared) { return derive(shared, serverNonce, clientNonce); })
      .then(function (keys) { return new Box(keys.toServer, keys.toClient); })
      .catch(function () { return null; });
  }

  window.nikSecure = {
    available, ephemeral, binding, clientBox, Box, derive, nonceFor,
    toBase64, fromBase64, VERSION, CEILING
  };

  // Exported so the two halves of one format can be checked against each other.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.nikSecure;
  }
})();
