'use strict';

const crypto = require('crypto');
const { sameSecret } = require('./auth');

/**
 * The minute in which a new device may introduce itself.
 *
 * One code, open for sixty seconds, good for exactly one device. A wrong guess
 * closes the window rather than costing an attempt, so there is no guessing
 * game to play: whoever is trying gets one try before the code they are
 * attacking stops existing.
 *
 * The code is eight characters rather than a hundred and twenty-eight bits of
 * base64, because it has to be readable off a screen and typable on a phone
 * when the camera will not focus. Eight characters of this alphabet is forty
 * bits; against a single attempt inside a sixty-second window that is not the
 * weak link, and it keeps one secret in play instead of two.
 */

// No I, O, 0, 1, U: the characters people get wrong when reading them aloud or
// copying them across a room.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTVWXYZ';
const LENGTH = 8;
const WINDOW_MS = 60000;

class PairingWindow {
  constructor(options) {
    const o = options || {};
    this.ttl = o.ttlMs || WINDOW_MS;
    this.now = o.now || (() => Date.now());
    this.open = null;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) {
      try { fn(this.state()); } catch (_) { /* a view's problem */ }
    }
  }

  /** Start a window, replacing any that was already open. */
  start(options) {
    const o = options || {};
    this.open = {
      code: newCode(),
      startedAt: this.now(),
      expiresAt: this.now() + this.ttl,
      host: o.host || null,
      // http on this machine, https once the tailnet is in front of it. A phone
      // cannot hold a device key over anything else: Web Crypto is only there
      // in a secure context.
      scheme: o.scheme === 'https' ? 'https' : 'http',
      fingerprint: o.fingerprint || null,
      laptop: o.laptop || 'This laptop'
    };
    this.changed();
    return this.state();
  }

  close(why) {
    if (!this.open) return false;
    this.open = null;
    this.reason = why || null;
    this.changed();
    return true;
  }

  get isOpen() {
    if (!this.open) return false;
    if (this.now() >= this.open.expiresAt) {
      // Expiry is not a state anybody has to sweep up: it is noticed here, the
      // first time anyone asks.
      this.close('expired');
      return false;
    }
    return true;
  }

  state() {
    if (!this.isOpen) return { open: false };
    return {
      open: true,
      code: this.open.code,
      expiresAt: this.open.expiresAt,
      msLeft: Math.max(0, this.open.expiresAt - this.now()),
      link: this.link(),
      appLink: this.appLink(),
      host: this.open.host,
      scheme: this.open.scheme,
      fingerprint: this.open.fingerprint,
      laptop: this.open.laptop
    };
  }

  /**
   * What the QR carries: an ordinary URL, so a phone camera opens it without a
   * custom scheme or an app. The code and the fingerprint sit in the fragment,
   * which browsers never send to the server — so even the machine serving the
   * page does not see them in its own logs.
   */
  link() {
    if (!this.open) return null;
    const at = this.open;
    return `${at.scheme}://${at.host || '127.0.0.1'}/pair#${this.fragment()}`;
  }

  /**
   * The same invitation, addressed to the app instead of to a browser.
   *
   * A phone's own camera reads a QR and offers to open what is in it. An
   * ordinary https link opens a browser, which is right when the browser is the
   * client and wrong when the app is — so the app claims a scheme of its own and
   * the laptop can offer either. One tap, no typing, no camera permission and no
   * scanner in the app: the camera the person already knows how to use does it.
   *
   * The host travels in the fragment here because a custom scheme has no
   * authority worth the name — and the fragment is the part a browser never
   * sends anywhere, which is where the code belongs regardless.
   */
  appLink() {
    if (!this.open) return null;
    const at = this.open;
    return `nikui://pair#${this.fragment()}&h=${encodeURIComponent(at.host || '127.0.0.1')}` +
      `&s=${encodeURIComponent(at.scheme || 'http')}`;
  }

  /** The secret half, which is the same either way. */
  fragment() {
    const at = this.open;
    return [
      'c=' + encodeURIComponent(at.code),
      at.fingerprint ? 'f=' + encodeURIComponent(at.fingerprint) : null,
      at.laptop ? 'n=' + encodeURIComponent(at.laptop) : null
    ].filter(Boolean).join('&');
  }

  /**
   * Spend the code. Anything other than the right code inside the window closes
   * it: there is no second guess and no rate to limit.
   *
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  claim(code) {
    if (!this.isOpen) return { ok: false, reason: 'no pairing window is open' };
    const offered = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!offered || !sameSecret(offered, this.open.code)) {
      this.close('wrong code');
      return { ok: false, reason: 'that code is not the one on screen, and the window is now closed' };
    }
    this.close('paired');
    return { ok: true };
  }
}

function newCode() {
  const out = [];
  // Rejection-free: 31 symbols from a byte would bias, so take 5 bits at a time
  // from a fresh random pool and drop the values that fall outside the alphabet.
  while (out.length < LENGTH) {
    for (const byte of crypto.randomBytes(LENGTH * 2)) {
      const value = byte & 0x1f;
      if (value >= ALPHABET.length) continue;
      out.push(ALPHABET[value]);
      if (out.length === LENGTH) break;
    }
  }
  return out.join('');
}

module.exports = { PairingWindow, newCode, ALPHABET, LENGTH, WINDOW_MS };
