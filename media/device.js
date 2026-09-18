/* This device's own identity.

   A key pair generated in the browser, kept in IndexedDB, with the private half
   marked non-extractable — so it cannot be read back out, even by this page, and
   a copy of the browser profile is not a copy of the device.

   Nothing here is a password and nothing here is a token: the device proves
   itself by signing a fresh challenge on every single connection. */
(function () {
  'use strict';

  const DB = 'nikui';
  const STORE = 'identity';
  const RECORD = 'device';

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

  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  /**
   * Whether this browser can hold a device identity at all. Web Crypto is only
   * available in a secure context, which means https — or loopback, which is
   * how this works on the laptop itself before a tunnel exists.
   */
  function available() {
    return !!(window.crypto && window.crypto.subtle && window.indexedDB);
  }

  /** What is already here, if anything. */
  function load() {
    if (!available()) return Promise.resolve(null);
    return inStore('readonly', (store) => store.get(RECORD)).catch(function () { return null; });
  }

  /**
   * The key for this device, made once and kept. `extractable: false` applies to
   * the private key; the public half is always exportable, which is the half
   * that has to travel.
   */
  function ensure() {
    return load().then(function (existing) {
      if (existing && existing.privateKey) return existing;
      return window.crypto.subtle
        .generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
        .then(function (pair) {
          return window.crypto.subtle.exportKey('spki', pair.publicKey).then(function (spki) {
            const record = { privateKey: pair.privateKey, publicKey: toBase64(spki), id: null, fingerprint: null };
            return inStore('readwrite', (store) => store.put(record, RECORD)).then(function () { return record; });
          });
        });
    });
  }

  /** Sign a message the server chose, and only ever that. */
  function sign(message) {
    return ensure().then(function (record) {
      const bytes = new TextEncoder().encode(String(message));
      return window.crypto.subtle
        .sign({ name: 'ECDSA', hash: 'SHA-256' }, record.privateKey, bytes)
        .then(toBase64);
    });
  }

  /** After pairing: who the laptop says we are, and which laptop it was. */
  function remember(details) {
    return ensure().then(function (record) {
      record.id = details.id || record.id;
      record.fingerprint = details.fingerprint || record.fingerprint;
      record.laptop = details.laptop || record.laptop || null;
      record.pairedAt = Date.now();
      return inStore('readwrite', (store) => store.put(record, RECORD)).then(function () { return record; });
    });
  }

  function forget() {
    return inStore('readwrite', (store) => store.delete(RECORD)).catch(function () { return null; });
  }

  window.nikDevice = { available, load, ensure, sign, remember, forget, toBase64 };
})();
