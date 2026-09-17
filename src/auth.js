'use strict';

const crypto = require('crypto');

/**
 * Who is allowed to talk to the local server.
 *
 * Today there is one answer: whoever holds the key this window minted, which is
 * only a defensible answer because the listener is bound to loopback and the key
 * never leaves this machine. It is a lock on a door inside the house.
 *
 * It is written as a seam rather than an `if` because the real answer — a paired
 * device proving possession of a private key it cannot export — replaces this
 * object wholesale and nothing else should have to change. Anything with
 * `check(req)` can be the gate.
 */
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
  check(req) {
    const offered = presentedKey(req);
    if (!offered) return { ok: false, status: 401, reason: 'no key' };
    if (!sameSecret(offered, this.key)) return { ok: false, status: 403, reason: 'wrong key' };
    return {
      ok: true,
      device: { id: 'local', name: 'This machine', control: true, pairedAt: null }
    };
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

/**
 * Constant time, and constant length: comparing digests rather than the secrets
 * means a wrong guess leaks neither which byte was wrong nor how long the key is.
 */
function sameSecret(a, b) {
  const one = crypto.createHash('sha256').update(String(a)).digest();
  const two = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(one, two);
}

module.exports = { LocalKey, sameSecret, presentedKey, cookie };
