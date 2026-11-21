'use strict';
const crypto = require('crypto');
const { fail } = require('../../src/daemonPaths');
function memoryKeychain() {
  const values = new Map(), calls = [];
  let failure = null;
  function effect(op, account, change) { calls.push({ op, account }); if (failure) throw fail(failure, 'Injected Keychain refusal'); return change(); }
  return { service: 'com.nikui.engine.test.' + crypto.randomBytes(16).toString('hex'), backend: 'login-file-keychain', values, calls,
    fail(code) { failure = code; }, read: (account) => effect('read', account, () => values.has(account) ? Buffer.from(values.get(account)) : null),
    add: (account, bytes) => effect('add', account, () => { if (values.has(account)) throw fail('KEYCHAIN_DUPLICATE', 'Duplicate test item'); values.set(account, Buffer.from(bytes)); }),
    update: (account, bytes) => effect('update', account, () => { if (!values.has(account)) throw fail('KEYCHAIN_NOT_FOUND', 'Missing test item'); values.set(account, Buffer.from(bytes)); }),
    delete: (account) => effect('delete', account, () => values.delete(account)) };
}
function keypair() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  return { publicKey: pair.publicKey.toString('base64url'), privateKey: pair.privateKey.toString('base64url') };
}
function pins(values) {
  const store = { get: (k) => values[k] };
  return { fingerprint: require('../../src/identity').loadIdentity(store, { required: true }).fingerprint,
    applicationServerKey: require('../../src/push').loadVapid(store, { required: true }).applicationServerKey };
}
module.exports = { memoryKeychain, keypair, pins };
