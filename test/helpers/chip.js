'use strict';

// A phone with a secure chip, as far as a browser is concerned.
//
// Injected into the page before its own scripts, so the app finds it exactly
// where it would find the real plugin and takes exactly the path it takes on a
// phone. What matters is that it is *wrong in the same two ways the real
// platforms are*: it hands back Apple's bare 65-byte point rather than a key
// the laptop can read, and a DER signature rather than the r‖s the laptop
// verifies. A stand-in that handed back the convenient shapes would test
// nothing — the conversion is the entire risk.
//
// The keys are kept in localStorage rather than a chip, because the app moves
// between pages and a stand-in that forgot its keys on every navigation would
// only be testing navigation. Nothing else about it pretends to be secure.

const SOURCE = `(function () {
  const SHELF = 'nikui.test.chip';
  const subtle = () => window.crypto.subtle;

  const shelf = () => { try { return JSON.parse(localStorage.getItem(SHELF)) || {}; } catch (_) { return {}; } };
  const keep = (all) => localStorage.setItem(SHELF, JSON.stringify(all));

  const b64 = (buffer) => {
    const view = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
    return btoa(binary);
  };

  const privateKeyFor = (jwk) => subtle().importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  /** r‖s back to DER, which is what a chip would have produced in the first place. */
  function toDer(raw) {
    const trim = (part) => {
      let at = 0;
      while (at < part.length - 1 && part[at] === 0) at++;
      const kept = part.subarray(at);
      // DER integers are signed, so a top bit set needs a leading zero.
      return kept[0] & 0x80 ? Uint8Array.from([0].concat(Array.from(kept))) : kept;
    };
    const r = trim(raw.subarray(0, 32));
    const s = trim(raw.subarray(32));
    const body = [0x02, r.length].concat(Array.from(r), [0x02, s.length], Array.from(s));
    return Uint8Array.from([0x30, body.length].concat(body));
  }

  window.Capacitor = window.Capacitor || {};
  window.Capacitor.Plugins = window.Capacitor.Plugins || {};
  window.Capacitor.Plugins.SecureKey = {
    isAvailable: function () {
      return Promise.resolve({
        available: true, protection: 'secure-enclave', biometrics: true, platform: 'ios'
      });
    },
    create: function (options) {
      return subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
        .then(function (pair) {
          return Promise.all([
            subtle().exportKey('jwk', pair.privateKey),
            subtle().exportKey('spki', pair.publicKey)
          ]).then(function (both) {
            const all = shelf();
            all[options.alias] = { jwk: both[0], spki: b64(both[1]) };
            all.made = (all.made || 0) + 1;
            keep(all);
            // Apple's shape: the bare point, with the 26-byte header left off.
            return {
              publicKey: b64(new Uint8Array(both[1]).subarray(26)),
              protection: 'secure-enclave', biometric: !!options.biometric, alias: options.alias
            };
          });
        });
    },
    publicKey: function (options) {
      const held = shelf()[options.alias];
      if (!held) return Promise.reject(new Error('no key under that name'));
      const spki = Uint8Array.from(atob(held.spki), function (c) { return c.charCodeAt(0); });
      return Promise.resolve({ publicKey: b64(spki.subarray(26)), alias: options.alias });
    },
    sign: function (options) {
      const held = shelf()[options.alias];
      if (!held) return Promise.reject(new Error('no key under that name'));
      return privateKeyFor(held.jwk).then(function (key) {
        return subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
          new TextEncoder().encode(String(options.message)));
      }).then(function (raw) {
        // A chip's shape: DER, which the laptop does not read.
        return { signature: b64(toDer(new Uint8Array(raw))) };
      });
    },
    remove: function (options) {
      const all = shelf();
      delete all[options.alias];
      keep(all);
      return Promise.resolve({ removed: true });
    }
  };
})();`;

module.exports = { SOURCE };
