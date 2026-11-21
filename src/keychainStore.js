'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { fail, noSymlinks, privateDirectory } = require('./daemonPaths');
const MAX_FRAME = 2 * 1024 * 1024, MAX_VALUE = 1024 * 1024;
const CODES = new Set(['KEYCHAIN_BAD_FRAME', 'KEYCHAIN_BAD_REQUEST', 'KEYCHAIN_NAMESPACE', 'KEYCHAIN_DUPLICATE',
  'KEYCHAIN_NOT_FOUND', 'KEYCHAIN_LOCKED', 'KEYCHAIN_DENIED', 'KEYCHAIN_CORRUPT', 'KEYCHAIN_UNAVAILABLE']);
const validAccount = (s) => typeof s === 'string' && s.trim() === s && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(s);
const validService = (s) => typeof s === 'string' && s.trim() === s && /^com\.nikui\.engine\.(?:test|dev)\.[A-Za-z0-9][A-Za-z0-9.-]{15,199}$/.test(s);
const validKey = (s) => typeof s === 'string' && s.length > 0 && s.length <= 256 && !s.includes('\0') && !['__proto__', 'constructor', 'prototype'].includes(s);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
function encodeFrame(value) {
  const data = Buffer.from(JSON.stringify(value));
  if (!data.length || data.length > MAX_FRAME) throw fail('KEYCHAIN_BAD_FRAME', 'Keychain frame exceeds its bound');
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}
function decodeFrame(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_FRAME + 4 ||
      !bytes.readUInt32BE(0) || bytes.readUInt32BE(0) !== bytes.length - 4) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4));
    const value = JSON.parse(text);
    if (!object(value)) throw new Error();
    return value;
  } catch (_) { throw fail('KEYCHAIN_BAD_FRAME', 'Keychain helper returned an invalid frame'); }
}

function createSecItemAdapter({ helper, service, backend = 'login-file-keychain', home, run = spawnSync, timeoutMs = 5000 } = {}) {
  if (!path.isAbsolute(helper || '') || !validService(service) ||
    backend !== 'login-file-keychain' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    throw fail('KEYCHAIN_NAMESPACE', 'An explicit isolated helper namespace is required');
  }
  noSymlinks(helper);
  const st = fs.lstatSync(helper);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o022) || !(st.mode & 0o100)) {
    throw fail('KEYCHAIN_HELPER_UNSAFE', 'Keychain helper must be an owned executable');
  }
  privateDirectory(home, false);
  let metadata = { backend };
  function request(op, account, data) {
    if (!validAccount(account)) throw fail('BAD_STORE_KEY', 'Invalid Keychain account');
    const id = crypto.randomBytes(16).toString('hex');
    const value = { version: 1, id, op, service, account };
    if (data !== undefined) {
      if (!Buffer.isBuffer(data) || data.length > MAX_VALUE) throw fail('KEYCHAIN_CAPACITY', 'Keychain value exceeds its bound');
      value.data = data.toString('base64');
    }
    let result;
    try {
      result = run(helper, [], { input: encodeFrame(value), encoding: null, timeout: timeoutMs, maxBuffer: MAX_FRAME + 4,
        env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (_) { throw fail('KEYCHAIN_UNAVAILABLE', 'Keychain helper could not execute'); }
    if (result?.error || result?.signal || !Number.isInteger(result?.status)) {
      throw fail(result?.error?.code === 'ETIMEDOUT' ? 'KEYCHAIN_TIMEOUT' : 'KEYCHAIN_UNAVAILABLE', 'Keychain helper did not complete');
    }
    const response = decodeFrame(result.stdout);
    if (response.version !== 1 || response.id !== id || typeof response.ok !== 'boolean') throw fail('KEYCHAIN_BAD_FRAME', 'Keychain helper response is uncorrelated');
    if (!response.ok) {
      if (result.status === 0 || !CODES.has(response.error?.code)) throw fail('KEYCHAIN_BAD_FRAME', 'Keychain failure response is invalid');
      throw fail(response.error.code, 'Keychain operation refused');
    }
    if (result.status !== 0 || response.backend !== backend || response.service !== service || result.stderr?.length) {
      throw fail('KEYCHAIN_BAD_FRAME', 'Keychain helper identity or exit status disagrees');
    }
    metadata = { backend, accessible: response.accessible, accessibilityReported: response.accessibilityReported };
    if (op === 'read') {
      if (response.found === false && response.data === undefined) return null;
      if (response.found !== true || !['AfterFirstUnlockThisDeviceOnly', 'AfterFirstUnlock', 'not-reported-by-file-keychain'].includes(response.accessible) ||
        typeof response.accessibilityReported !== 'boolean' ||
        response.accessibilityReported !== (response.accessible !== 'not-reported-by-file-keychain') || typeof response.data !== 'string') {
        throw fail('KEYCHAIN_CORRUPT', 'Keychain item attributes are invalid');
      }
      const bytes = Buffer.from(response.data, 'base64');
      if (bytes.length > MAX_VALUE || bytes.toString('base64') !== response.data) throw fail('KEYCHAIN_CORRUPT', 'Keychain item is invalid');
      return bytes;
    }
    return response.found;
  }
  return Object.freeze({ service, backend, metadata: () => ({ ...metadata }), read: (account) => request('read', account),
    add: (account, bytes) => request('add', account, bytes), update: (account, bytes) => request('update', account, bytes),
    delete: (account) => request('delete', account) });
}

// A single SecItem value makes each values-map update atomic. The generation's
// exclusive writer/import lock serializes read/modify/update; get never uses a
// cached fallback after a locked, denied, missing or corrupt read.
function createKeychainStore({ adapter, account = 'store.v1', create = false, initial = {} } = {}) {
  if (!adapter || !['read', 'add', 'update', 'delete'].every((k) => typeof adapter[k] === 'function') || !validAccount(account)) {
    throw fail('KEYCHAIN_NAMESPACE', 'An explicit Keychain adapter and account are required');
  }
  let disposed = false;
  const listeners = new Set();
  const encode = (values) => {
    if (!object(values) || !Object.keys(values).every(validKey)) throw fail('KEYCHAIN_CORRUPT', 'Keychain store keys are invalid');
    const bytes = Buffer.from(JSON.stringify({ version: 1, purpose: 'nikui-engine-secrets', values }));
    if (bytes.length > MAX_VALUE) throw fail('KEYCHAIN_CAPACITY', 'Keychain store exceeds its bound');
    return bytes;
  };
  function read() {
    if (disposed) throw fail('KEYCHAIN_CLOSED', 'Keychain store is closed');
    const bytes = adapter.read(account);
    if (bytes === null) throw fail('KEYCHAIN_NOT_FOUND', 'Selected Keychain store is missing');
    try {
      const saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!object(saved) || Object.keys(saved).sort().join(',') !== 'purpose,values,version' || saved.version !== 1 ||
        saved.purpose !== 'nikui-engine-secrets' || !object(saved.values) || !Object.keys(saved.values).every(validKey)) throw new Error();
      return saved.values;
    } catch (_) { throw fail('KEYCHAIN_CORRUPT', 'Selected Keychain store is corrupt'); }
  }
  if (create) adapter.add(account, encode(structuredClone(initial)));
  read(); // Fail before callers construct listeners, identities or providers.
  function update(key, value) {
    if (!validKey(key)) throw fail('BAD_STORE_KEY', 'Invalid private store key');
    const next = read();
    if (value === undefined) delete next[key]; else next[key] = structuredClone(value);
    adapter.update(account, encode(next));
    for (const fn of listeners) { try { fn({ key }); } catch (_) { /* persisted; listener owns its error */ } }
  }
  return { keys: () => Object.keys(read()), get(key, fallback) { if (!validKey(key)) throw fail('BAD_STORE_KEY', 'Invalid private store key');
    const values = read(); return Object.hasOwn(values, key) ? structuredClone(values[key]) : fallback; },
    update, async store(key, value) { update(key, value); }, async delete(key) { update(key, undefined); },
    onDidChange(fn) { if (disposed) throw fail('KEYCHAIN_CLOSED', 'Keychain store is closed'); listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    dispose() { disposed = true; listeners.clear(); } };
}
module.exports = { createSecItemAdapter, createKeychainStore, encodeFrame, decodeFrame, validService, MAX_FRAME, MAX_VALUE };
