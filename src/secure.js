'use strict';

const crypto = require('crypto');

/**
 * A second envelope inside the first one.
 *
 * Everything between a phone and this laptop already travels inside TLS, and
 * the laptop already proves who it is by signing a nonce with the key the phone
 * pinned. So an impostor cannot *be* the laptop. What it could still do, if it
 * held a certificate for the name — a compromised certificate authority, a
 * relay that terminates TLS, a device with a profile installed on it — is
 * *read* everything, because TLS is the only thing keeping the bytes private.
 *
 * This closes that. Each connection makes a throwaway key pair on both ends,
 * they agree a secret neither side could have known in advance, and every
 * message from then on is sealed with it. The throwaway keys are named inside
 * the signatures the two ends already exchange, so an impostor cannot swap them
 * for its own without producing a signature it cannot make.
 *
 * Forward secrecy comes free: the throwaway keys are gone when the socket
 * closes, so a recording of today's traffic is not readable by someone who
 * steals either long-term key tomorrow.
 *
 * What this is not: an excuse to drop TLS. It is the layer that survives TLS
 * being wrong.
 */

const VERSION = 'nikui-e2e:v1';
const CURVE = 'prime256v1';
const KEY_BYTES = 32;   // AES-256
const NONCE_BYTES = 12; // what GCM wants
const MATERIAL = (KEY_BYTES + NONCE_BYTES) * 2;

const toBase64 = (buffer) => Buffer.from(buffer).toString('base64url');
const fromBase64 = (text) => Buffer.from(String(text || ''), 'base64url');

/** A key pair for exactly one connection, thrown away with it. */
function ephemeral() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: CURVE });
  return {
    privateKey: pair.privateKey,
    spki: toBase64(pair.publicKey.export({ type: 'spki', format: 'der' }))
  };
}

/**
 * The other end's throwaway key, if it really is one.
 *
 * A point that is not on the curve, or a key on a curve nobody agreed to, is
 * how a shared secret becomes a secret only one side chose.
 */
function readEphemeral(spki) {
  try {
    const key = crypto.createPublicKey({ key: fromBase64(spki), format: 'der', type: 'spki' });
    const details = key.asymmetricKeyDetails || {};
    if (key.asymmetricKeyType !== 'ec' || details.namedCurve !== CURVE) return null;
    return key;
  } catch (_) { return null; }
}

/**
 * What both signatures name, so neither throwaway key can be swapped in flight.
 * Order is fixed — the laptop's first — so both ends compute the same thing.
 */
function binding(serverSpki, clientSpki) {
  return toBase64(crypto.createHash('sha256')
    .update(fromBase64(serverSpki)).update(fromBase64(clientSpki)).digest());
}

/**
 * Two keys and two starting points, one pair for each direction.
 *
 * Separate keys per direction means a message the laptop sent can never be
 * replayed back at it as one the phone sent.
 */
function derive(shared, serverNonce, clientNonce) {
  const salt = crypto.createHash('sha256')
    .update(String(serverNonce)).update(':').update(String(clientNonce)).digest();
  const material = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(VERSION, 'utf8'), MATERIAL));
  let at = 0;
  const take = (n) => material.subarray(at, at += n);
  return {
    toClient: { key: take(KEY_BYTES), base: take(NONCE_BYTES) },
    toServer: { key: take(KEY_BYTES), base: take(NONCE_BYTES) }
  };
}

/** A counter, folded into the starting point, so no nonce is ever used twice. */
function nonceFor(base, counter) {
  const out = Buffer.from(base);
  for (let i = 0; i < 6; i++) {
    // Six bytes is 2^48 messages on one socket; the counter is checked against
    // that ceiling before it ever gets here.
    out[NONCE_BYTES - 1 - i] ^= (Math.floor(counter / Math.pow(256, i)) & 0xff);
  }
  return out;
}

const CEILING = Math.pow(2, 48);

/**
 * The sealed channel, once both ends have agreed.
 *
 * @param {{key: Buffer, base: Buffer}} sending
 * @param {{key: Buffer, base: Buffer}} receiving
 */
class Box {
  constructor(sending, receiving) {
    this.sending = sending;
    this.receiving = receiving;
    this.sent = 0;
    // Strictly increasing, because a WebSocket delivers in order: anything out
    // of order is a replay or a rearrangement, and neither is a message.
    this.seen = -1;
  }

  seal(text) {
    if (this.sent >= CEILING) throw new Error('this connection has said enough');
    const counter = this.sent++;
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sending.key,
      nonceFor(this.sending.base, counter));
    const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return { type: '@box', n: counter, c: toBase64(Buffer.concat([body, cipher.getAuthTag()])) };
  }

  /** @returns {string|null} the message inside, or null if it was not one. */
  open(frame) {
    if (!frame || typeof frame.n !== 'number' || !Number.isInteger(frame.n)) return null;
    if (frame.n <= this.seen || frame.n >= CEILING) return null;
    const bytes = fromBase64(frame.c);
    if (bytes.length < 17) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.receiving.key,
        nonceFor(this.receiving.base, frame.n));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      const text = Buffer.concat([
        decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()
      ]).toString('utf8');
      this.seen = frame.n;
      return text;
    } catch (_) {
      // A tag that does not check out is not a corrupt message to recover from.
      return null;
    }
  }
}

/**
 * The laptop's side, from its own throwaway key and the phone's.
 * @returns {Box|null}
 */
function serverBox(mine, theirSpki, serverNonce, clientNonce) {
  const theirs = readEphemeral(theirSpki);
  if (!theirs) return null;
  const shared = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey: theirs });
  const keys = derive(shared, serverNonce, clientNonce);
  return new Box(keys.toClient, keys.toServer);
}

module.exports = {
  ephemeral, readEphemeral, binding, derive, serverBox, Box,
  VERSION, CURVE, MATERIAL, KEY_BYTES, NONCE_BYTES, CEILING, nonceFor, toBase64, fromBase64
};
