/* This device's own identity.

   A P-256 key pair that proves, on every single connection, that this is the
   device the laptop paired with. Nothing here is a password and nothing here is
   a token: there is no secret to leak, only a key to hold.

   Where it is held depends on what the device has:

     hardware  the Secure Enclave on iOS, the Keystore (StrongBox where there is
               one) on Android. The private key is generated inside the chip and
               has no software representation at all — not in this page, not in
               the app, not in a backup. Signing is a request to the chip.
     software  a non-extractable WebCrypto key in IndexedDB. Cannot be read back
               out by this page either, but it lives in a browser profile, and a
               copy of that profile is a copy of the device.

   Hardware is used whenever it exists and software is the fallback, so the same
   file serves the editor's webview, a browser, and the app. A device that paired
   before hardware was possible keeps working and can be upgraded in place —
   see `stageUpgrade`. */
(function () {
  'use strict';

  const DB = 'nikui';
  const STORE = 'identity';
  const RECORD = 'device';

  // What the hardware store knows a key by. Every key gets a name of its own,
  // rather than a fixed one and a fixed replacement: Android's Keystore cannot
  // rename an entry — the key is in a chip and does not move — so a replacement
  // that had to end up under a particular name could only get there by being
  // regenerated, which is the one thing it must not do.
  const ALIAS = 'nikui.device';
  const aliasForNewKey = () => ALIAS + '.' +
    Date.now().toString(36) + '.' + Math.floor(Math.random() * 0x1000000).toString(36);

  // A biometric gate that asked on every reconnect would be unusable — a phone
  // reconnects whenever it changes network. One check covers this long.
  const UNLOCK_WINDOW_SECONDS = 300;

  function open() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no storage for a device key'));
      const request = window.indexedDB.open(DB, 1);
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('storage refused')); };
    });
  }

  function inStore(mode, run) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || new Error('storage refused')); };
      });
    });
  }

  const put = (record) => inStore('readwrite', (store) => store.put(record, RECORD))
    .then(function () { return record; });

  const fromBase64 = (text) => {
    const padded = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = window.atob(padded + '==='.slice((padded.length + 3) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // ---- the two shapes a platform can hand back --------------------------------
  //
  // These are the whole risk of a hardware key, and they fail silently: a badly
  // wrapped public key is refused by the laptop as "not a usable key", and a
  // signature in the wrong encoding is refused as a forgery. Neither says which.
  // So the conversion happens once, here, in the one place a test can reach —
  // rather than twice, in two native languages, on two devices.

  /** The fixed prefix of a P-256 SPKI: algorithm, curve, and a 66-byte bit string. */
  const P256_SPKI_HEADER = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
  ];

  /**
   * A public key in the one form the laptop reads: SPKI.
   *
   * Android's `PublicKey.getEncoded()` already is SPKI. Apple's
   * `SecKeyCopyExternalRepresentation` is the bare 65-byte uncompressed point,
   * so it gets the header put back on. WebCrypto exports SPKI directly.
   */
  function spkiFromPublicKey(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length === 65 && bytes[0] === 0x04) {
      const out = new Uint8Array(P256_SPKI_HEADER.length + 65);
      out.set(P256_SPKI_HEADER, 0);
      out.set(bytes, P256_SPKI_HEADER.length);
      return out;
    }
    // Already wrapped. Whether it is the right curve is the laptop's judgement,
    // not a length check here.
    if (bytes.length > 2 && bytes[0] === 0x30) return bytes;
    throw new Error('that is not a P-256 public key');
  }

  function readInteger(bytes, at) {
    if (bytes[at] !== 0x02) throw new Error('not a signature');
    const length = bytes[at + 1];
    // A P-256 integer is at most 33 bytes, so the long form cannot appear here.
    if (length & 0x80) throw new Error('not a signature');
    const start = at + 2;
    const end = start + length;
    if (end > bytes.length) throw new Error('not a signature');
    let value = bytes.subarray(start, end);
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) throw new Error('not a signature');
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return { value: padded, next: end };
  }

  /**
   * A signature in the one form the laptop verifies: 64 bytes of r‖s.
   *
   * Both platforms sign to DER — `SEQUENCE { INTEGER r, INTEGER s }`, with
   * lengths that vary by a byte or two depending on leading zeros and sign bits.
   * WebCrypto, and therefore the laptop, uses the fixed-width form.
   */
  function p1363FromSignature(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length === 64) return bytes;
    if (bytes[0] !== 0x30) throw new Error('not a signature');
    let at = 2;
    if (bytes[1] & 0x80) at = 2 + (bytes[1] & 0x7f);
    const r = readInteger(bytes, at);
    const s = readInteger(bytes, r.next);
    const out = new Uint8Array(64);
    out.set(r.value, 0);
    out.set(s.value, 32);
    return out;
  }

  // ---- where a key can live ---------------------------------------------------

  const plugin = () => {
    const found = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SecureKey;
    return found && typeof found.sign === 'function' ? found : null;
  };

  /** The chip, when there is one. Every result is converted before it leaves. */
  const hardware = {
    name: 'hardware',
    /** @returns {Promise<{protection: string, biometrics: boolean}|null>} */
    offer() {
      const api = plugin();
      if (!api) return Promise.resolve(null);
      return api.isAvailable()
        .then(function (r) { return r && r.available ? r : null; })
        .catch(function () { return null; });
    },
    create(alias, options) {
      const api = plugin();
      if (!api) return Promise.reject(new Error('no secure hardware here'));
      return api.create({
        alias: alias,
        biometric: !!(options && options.biometric),
        validitySeconds: UNLOCK_WINDOW_SECONDS
      }).then(function (made) {
        return {
          alias: alias,
          publicKey: toBase64(spkiFromPublicKey(fromBase64(made.publicKey))),
          protection: made.protection || 'hardware',
          biometric: !!made.biometric
        };
      });
    },
    sign(holder, message, reason) {
      const api = plugin();
      if (!api) return Promise.reject(new Error('no secure hardware here'));
      return api.sign({
        alias: holder.alias || ALIAS,
        message: String(message),
        reason: reason || 'Prove this phone to your laptop'
      }).then(function (out) {
        return toBase64(p1363FromSignature(fromBase64(out.signature)));
      });
    },
    remove(holder) {
      const api = plugin();
      if (!api || !holder || !holder.alias) return Promise.resolve(null);
      return api.remove({ alias: holder.alias }).catch(function () { return null; });
    }
  };

  /** The browser. Non-extractable, but only as safe as the profile around it. */
  const software = {
    name: 'software',
    offer() {
      return Promise.resolve(available() ? { protection: 'software', biometrics: false } : null);
    },
    create() {
      return window.crypto.subtle
        .generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
        .then(function (pair) {
          return window.crypto.subtle.exportKey('spki', pair.publicKey).then(function (spki) {
            return {
              privateKey: pair.privateKey,
              publicKey: toBase64(spki),
              protection: 'software',
              biometric: false
            };
          });
        });
    },
    sign(holder, message) {
      if (!holder || !holder.privateKey) return Promise.reject(new Error('no key on this device'));
      return window.crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, holder.privateKey,
        new TextEncoder().encode(String(message))
      ).then(toBase64);
    },
    remove() { return Promise.resolve(null); }
  };

  /** Which backend a given key is held by. Records made before this existed are software. */
  const backendFor = (holder) => (holder && holder.protection && holder.protection !== 'software'
    ? hardware : software);

  /**
   * Whether this browser can hold a device identity at all. Web Crypto is only
   * available in a secure context, which means https — or loopback, which is
   * how this works on the laptop itself before a tunnel exists.
   */
  function available() {
    return !!(window.crypto && window.crypto.subtle && window.indexedDB);
  }

  /** What the best available protection would be, without making anything. */
  function bestOffer() {
    return hardware.offer().then(function (chip) {
      if (chip) return { kind: 'hardware', protection: chip.protection || 'hardware', biometrics: !!chip.biometrics };
      return available() ? { kind: 'software', protection: 'software', biometrics: false } : null;
    });
  }

  /** What is already here, if anything. */
  function load() {
    if (!available()) return Promise.resolve(null);
    return inStore('readonly', (store) => store.get(RECORD)).catch(function () { return null; });
  }

  /**
   * The key for this device, made once and kept. Hardware if the device has it,
   * a non-extractable browser key otherwise. The public half is the only part
   * that ever travels.
   */
  function ensure(options) {
    return load().then(function (existing) {
      if (existing && existing.publicKey) return existing;
      return bestOffer().then(function (offer) {
        if (!offer) return Promise.reject(new Error('this device cannot hold a key'));
        if (offer.kind !== 'hardware') return software.create();
        // A chip that says yes and then refuses is not a reason to have no
        // identity at all; the software key still works.
        return hardware.create(aliasForNewKey(), options).catch(function () { return software.create(); });
      }).then(function (made) {
        return put(Object.assign({ id: null, fingerprint: null }, made));
      });
    });
  }

  /** Sign a message the server chose, and only ever that. */
  function sign(message, reason) {
    return ensure().then(function (record) {
      return backendFor(record).sign(record, message, reason);
    });
  }

  // ---- moving a key into hardware ---------------------------------------------

  /**
   * Can this device do better than it currently is?
   *
   * @returns {Promise<{possible: boolean, protection: string, biometrics: boolean, now: string}>}
   */
  function protection() {
    return Promise.all([load(), bestOffer()]).then(function (both) {
      const record = both[0];
      const offer = both[1] || { kind: 'software', protection: 'software', biometrics: false };
      const now = (record && record.protection) || 'software';
      return {
        now: now,
        biometric: !!(record && record.biometric),
        staged: !!(record && record.staged),
        best: offer.protection,
        biometrics: !!offer.biometrics,
        // Only ever means "there is a chip and the key is not in it". Turning
        // the biometric check on is a different move with a different word for
        // it, and offering "move it into the chip" to a key already in the chip
        // would be a lie on the one screen that must not tell any.
        possible: offer.kind === 'hardware' && now === 'software'
      };
    });
  }

  /**
   * Make the replacement key, and keep it beside the working one.
   *
   * Nothing is thrown away here. The old key stays the device's identity until
   * the laptop has seen the new one, checked that the old one authorised it, and
   * said so — which is the only moment it is safe to stop being able to sign.
   */
  function stageUpgrade(options) {
    return ensure().then(function (record) {
      if (!record.id) return Promise.reject(new Error('pair first'));
      // A staged key from an attempt that never finished is dead weight.
      const previous = record.staged;
      return (previous ? hardware.remove(previous) : Promise.resolve())
        .then(function () { return hardware.create(aliasForNewKey(), options); })
        .then(function (made) {
          record.staged = Object.assign({ at: Date.now() }, made);
          return put(record).then(function () { return record.staged; });
        });
    });
  }

  /**
   * The laptop accepted it: the new key becomes the identity, the old one goes.
   *
   * The order matters. The record is written pointing at the new key before the
   * old one is destroyed, so a phone that is killed halfway through comes back
   * holding a key that works rather than a name for one that no longer exists.
   */
  function commitUpgrade() {
    return load().then(function (record) {
      if (!record || !record.staged) return null;
      const staged = record.staged;
      const old = { alias: record.alias, protection: record.protection };
      const next = Object.assign({}, record, {
        alias: staged.alias,
        publicKey: staged.publicKey,
        protection: staged.protection,
        biometric: !!staged.biometric,
        upgradedAt: Date.now()
      });
      delete next.privateKey;
      delete next.staged;
      return put(next).then(function () {
        return hardware.remove(old).then(function () { return next; });
      });
    });
  }

  /** It was refused, or this laptop is too old to understand: put it back. */
  function discardUpgrade() {
    return load().then(function (record) {
      if (!record || !record.staged) return null;
      const staged = record.staged;
      delete record.staged;
      return hardware.remove(staged).then(function () { return put(record); });
    });
  }

  /**
   * The answer to a challenge — and, if a better key is waiting, the request to
   * start using it.
   *
   * A rekey is signed twice over the same sentence: by the key being replaced,
   * which is what authorises it, and by the key replacing it, which is what
   * proves anyone holds it. Both cover the laptop's nonce and the new key's
   * fingerprint, so the request cannot be replayed, redirected at another key,
   * or quietly stripped back to a plain answer — a stripped one is a signature
   * over the wrong sentence.
   */
  function authMessage(record, theirNonce, myNonce) {
    const plain = 'nikui-auth:' + theirNonce + ':' + myNonce;
    const staged = record && record.staged;
    if (!staged) {
      return sign(plain).then(function (signature) {
        return { type: '@auth', device: record.id, nonce: myNonce, signature: signature };
      });
    }
    return fingerprintOf(staged.publicKey).then(function (fingerprint) {
      const claim = 'nikui-rekey:' + theirNonce + ':' + myNonce + ':' + fingerprint;
      return Promise.all([
        backendFor(record).sign(record, claim, 'Move this phone’s key into secure hardware'),
        hardware.sign(staged, claim, 'Confirm this phone’s new key')
      ]).then(function (signatures) {
        return {
          type: '@auth', device: record.id, nonce: myNonce, signature: signatures[0],
          rekey: {
            publicKey: staged.publicKey,
            signature: signatures[1],
            protection: staged.protection,
            biometric: !!staged.biometric
          }
        };
      });
    });
  }

  /**
   * After pairing: who the laptop says we are, and — the part that matters —
   * the laptop's own public key. Keeping only a fingerprint would leave nothing
   * to check a signature against, and a fingerprint compared against a
   * fingerprint the other end simply claims is not a check at all.
   */
  function remember(details) {
    return ensure().then(function (record) {
      record.id = details.id || record.id;
      record.fingerprint = details.fingerprint || record.fingerprint;
      record.serverKey = details.serverKey || record.serverKey || null;
      record.laptop = details.laptop || record.laptop || null;
      record.pairedAt = Date.now();
      return put(record);
    });
  }

  /** Half a SHA-256 of a public key, the way the laptop computes it. */
  function fingerprintOf(spki) {
    return window.crypto.subtle.digest('SHA-256', fromBase64(spki))
      .then(function (digest) { return toBase64(digest.slice(0, 16)); });
  }

  /**
   * Is this the laptop this device paired with?
   *
   * Two questions, and both have to be answered yes. Does the key it is
   * offering hash to the fingerprint that was pinned — which is what makes the
   * fingerprint a pin rather than an echo. And can it sign for that key right
   * now, over a nonce this device chose a moment ago, which is what makes it
   * the laptop rather than a recording of one.
   */
  function verifyLaptop(record, serverKeySpki, message, signature) {
    if (!record || !record.fingerprint) return Promise.resolve(false);
    if (!serverKeySpki || !signature) return Promise.resolve(false);
    return fingerprintOf(serverKeySpki).then(function (fingerprint) {
      if (fingerprint !== record.fingerprint) return false;
      return window.crypto.subtle.importKey(
        'spki', fromBase64(serverKeySpki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
      ).then(function (key) {
        return window.crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' }, key,
          fromBase64(signature), new TextEncoder().encode(String(message))
        );
      });
    }).catch(function () { return false; });
  }

  /** Forget the key, wherever it is being held. */
  function forget() {
    return load().then(function (record) {
      const gone = [];
      if (record && record.staged) gone.push(hardware.remove(record.staged));
      if (record) gone.push(hardware.remove(record));
      return Promise.all(gone);
    }).then(function () {
      return inStore('readwrite', (store) => store.delete(RECORD));
    }).catch(function () { return null; });
  }

  window.nikDevice = {
    available, load, ensure, sign, remember, forget, toBase64, fromBase64,
    fingerprintOf, verifyLaptop, authMessage,
    protection, stageUpgrade, commitUpgrade, discardUpgrade,
    spkiFromPublicKey, p1363FromSignature, UNLOCK_WINDOW_SECONDS
  };

  // Exported so the conversions can be checked against the laptop's real
  // verifier, which is the only way to know a device nobody here owns will be
  // believed by it.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { spkiFromPublicKey, p1363FromSignature, P256_SPKI_HEADER };
  }
})();
