'use strict';

const crypto = require('crypto');
const { readPublicKey, verifyWith } = require('./identity');

/**
 * Who is allowed to talk to the local server.
 *
 * Two kinds of caller, and they are told apart on purpose:
 *
 *  - **this machine**, holding the key the window minted. That is only a
 *    defensible credential because the listener is bound to loopback — it is a
 *    lock on a door inside the house — so it is refused the moment a request
 *    looks like it came through something else.
 *  - **a paired device**, which proves on every connection that it still holds
 *    the private key it paired with. No long-lived token exists to leak, and a
 *    stolen URL is worth nothing on a device that cannot sign.
 *
 * The server also proves itself in the same exchange, signing the device's
 * nonce with the key whose fingerprint the device pinned when it paired. That
 * is what stops something else on the network answering to this address later.
 */

// A device has ten seconds to answer the challenge; a browser takes a few
// milliseconds, and anything slower is not waiting on arithmetic.
const CHALLENGE_MS = 10000;

class LocalKey {
  constructor(key) {
    // 256 bits, new every time the server starts, so a key that leaks into a
    // screenshot or a shell history is dead as soon as the window reloads.
    this.key = key || crypto.randomBytes(32).toString('base64url');
    this.name = 'local key';
  }

  /**
   * @returns {{ok: true, device: object} | {ok: false, status: number, reason: string}}
   */
  check(req, context) {
    // A request that has been through a proxy is not this machine talking to
    // itself, whatever the socket says. Everything the tunnel forwards arrives
    // from 127.0.0.1 — these are the two lines that keep the local key from
    // quietly becoming a remote one.
    if (forwarded(req)) return { ok: false, status: 403, reason: 'the local key is not for forwarded requests' };
    // And the belt to that brace: a request addressed to the tailnet name is
    // not this machine talking to itself either, whatever headers it carries.
    if (context && context.loopbackHost === false) {
      return { ok: false, status: 403, reason: 'the local key is only for a loopback address' };
    }
    const offered = presentedKey(req);
    if (!offered) return { ok: false, status: 401, reason: 'no key' };
    if (!sameSecret(offered, this.key)) return { ok: false, status: 403, reason: 'wrong key' };
    return { ok: true, device: localDevice() };
  }
}

const localDevice = () => ({
  id: 'local',
  name: 'This machine',
  kind: 'local',
  control: true
});

/**
 * The gate a socket has to get through: the local key, or a device signature.
 */
class Gate {
  constructor(deps) {
    this.localKey = deps.localKey || new LocalKey();
    this.devices = deps.devices || null;
    this.identity = deps.identity || null;
    this.now = deps.now || (() => Date.now());
  }

  get key() {
    return this.localKey.key;
  }

  /** For an HTTP request that carries real data rather than the empty shell. */
  http(req, context) {
    return this.localKey.check(req, context);
  }


  /**
   * The welcome for a client that had nothing to prove — this machine's own
   * browser, holding the key. It is signed like any other, because a client
   * should never have to decide whether an unsigned welcome is allowed: the
   * answer is always no.
   */
  localWelcome(state, message) {
    const theirs = (message && String(message.nonce || '')) || '';
    return {
      type: '@welcome',
      device: localDevice(),
      signature: this.identity && theirs && state
        ? this.identity.sign(`nikui-host:${theirs}:${state.nonce}`)
        : null
    };
  }

  /** The opening move: a nonce this server will expect signed. */
  challenge() {
    return {
      nonce: crypto.randomBytes(32).toString('base64url'),
      at: this.now()
    };
  }

  challengeMessage(state) {
    return {
      type: '@challenge',
      nonce: state.nonce,
      // Sent every time so a device can check it is still talking to the laptop
      // it paired with, rather than to whatever now answers on this address.
      serverKey: this.identity ? this.identity.publicKeySpki : null,
      fingerprint: this.identity ? this.identity.fingerprint : null
    };
  }

  /**
   * The device's answer. It signs the server's nonce together with one of its
   * own, and the server signs the pair back — so neither side can be replayed
   * at the other.
   *
   * @returns {{ok: true, device: object, welcome: object} | {ok: false, reason: string}}
   */
  answer(state, message, context) {
    const ctx = context || {};
    if (!state || !state.nonce) return { ok: false, reason: 'nothing was challenged' };
    if (this.now() - state.at > CHALLENGE_MS) return { ok: false, reason: 'took too long to answer' };
    if (!message || typeof message !== 'object') return { ok: false, reason: 'no answer' };

    const id = String(message.device || '');
    const theirNonce = String(message.nonce || '');
    if (!id || !theirNonce || theirNonce.length < 16) return { ok: false, reason: 'incomplete answer' };
    if (!this.devices) return { ok: false, reason: 'no devices are paired' };

    const device = this.devices.get(id);
    if (!device) return { ok: false, reason: 'this device is not paired' };

    // A device may use this exchange to replace its own key — because it has
    // moved the key into secure hardware, which it can only do by making a new
    // one. What it signs says so: a different sentence, naming the new key. So
    // a rekey cannot be stripped back to a plain answer, and a plain answer
    // cannot be dressed up as a rekey; either way the signature is over the
    // wrong words.
    let replacement = null;
    if (message.rekey !== undefined && message.rekey !== null) {
      if (typeof message.rekey !== 'object') return { ok: false, reason: 'that is not a key' };
      replacement = readPublicKey(String(message.rekey.publicKey || ''));
      if (!replacement) return { ok: false, reason: 'that is not a key this laptop can use' };
    }

    const signed = replacement
      ? `nikui-rekey:${state.nonce}:${theirNonce}:${replacement.fingerprint}`
      : `nikui-auth:${state.nonce}:${theirNonce}`;

    // The key being replaced authorises the replacement. Anything else would be
    // a way to take over a device record by asking.
    if (!this.devices.verify(id, signed, message.signature)) {
      return { ok: false, reason: 'that signature is not this device' };
    }
    // And the new key proves somebody actually holds it, over the same words —
    // so a device cannot be locked out by rekeying it to a key nobody has.
    if (replacement && !verifyWith(replacement.spki, signed, message.rekey.signature)) {
      return { ok: false, reason: 'the new key did not prove itself' };
    }

    let rekeyed = null;
    if (replacement) {
      rekeyed = this.devices.rekey(id, {
        publicKey: replacement.spki,
        protection: message.rekey.protection,
        biometric: message.rekey.biometric
      });
      if (!rekeyed) return { ok: false, reason: 'that key belongs to another device' };
    }

    const current = rekeyed || device;
    this.devices.touch(id, ctx.address || null);
    const seat = {
      id: current.id,
      name: current.name,
      kind: 'device',
      control: !!current.control
    };
    const welcome = {
      type: '@welcome',
      device: seat,
      // The server's half of the proof, over the device's nonce.
      signature: this.identity ? this.identity.sign(`nikui-host:${theirNonce}:${state.nonce}`) : null
    };
    // Said explicitly, so the device knows the moment it is safe to stop being
    // able to sign with the key it just replaced.
    if (rekeyed) {
      welcome.rekeyed = { fingerprint: rekeyed.fingerprint, protection: rekeyed.protection };
    }
    return { ok: true, device: seat, welcome, rekeyed };
  }
}

/** The key, from wherever the client could reasonably have put it. */
function presentedKey(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const fromQuery = url.searchParams.get('key');
  if (fromQuery) return fromQuery;

  const auth = String((req.headers && req.headers.authorization) || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();

  // The page sets a cookie on first load so the key can leave the address bar:
  // every asset and the socket carry it from then on without it being visible.
  return cookie(req, 'nikui');
}

function cookie(req, name) {
  const raw = String((req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

/** Whether anything in the request says it has been through a proxy. */
function forwarded(req) {
  const headers = (req && req.headers) || {};
  return !!(headers['x-forwarded-for'] || headers['x-forwarded-host'] ||
    headers['x-forwarded-proto'] || headers.forwarded || headers['x-real-ip']);
}

/**
 * Constant time, and constant length: comparing digests rather than the secrets
 * means a wrong guess leaks neither which byte was wrong nor how long the key is.
 */
function sameSecret(a, b) {
  const one = crypto.createHash('sha256').update(String(a)).digest();
  const two = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(one, two);
}

module.exports = { LocalKey, Gate, localDevice, sameSecret, presentedKey, cookie, forwarded, CHALLENGE_MS };
