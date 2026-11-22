'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { privateDirectory, privateFile, readPrivateJson, fail } = require('./daemonPaths');

// Synthetic P1 data only. This is deliberately not an import/Keychain adapter
// or the future durable receipt authority. Never regenerates a corrupt file.
function createTestStore(file, { testOnly = false } = {}) {
  if (!testOnly) throw fail('TEST_STORE_ONLY', 'The file secret adapter is test-only; production requires the signed SecItem helper');
  privateDirectory(path.dirname(file), false);
  const existing = privateFile(file, { optional: true });
  let saved;
  try { saved = existing ? readPrivateJson(file) : { version: 1, purpose: 'nikd-isolated-p1', values: {} }; }
  catch (_) { throw fail('STORE_UNAVAILABLE', 'Private test store is unreadable or corrupt'); }
  if (!saved || saved.version !== 1 || saved.purpose !== 'nikd-isolated-p1' ||
      !saved.values || typeof saved.values !== 'object' || Array.isArray(saved.values)) {
    throw fail('STORE_UNAVAILABLE', 'Private test store is corrupt or has an unsupported format');
  }
  let values = structuredClone(saved.values);
  const listeners = new Set();
  function commit(next) {
    privateDirectory(path.dirname(file), false);
    privateFile(file, { optional: true });
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, purpose: 'nikd-isolated-p1', values: next }) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, file);
      const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      values = next;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
  if (!existing) commit(values);
  const update = (key, value) => {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('BAD_STORE_KEY', 'Invalid private store key');
    const next = structuredClone(values);
    if (value === undefined) delete next[key]; else next[key] = structuredClone(value);
    commit(next);
    for (const fn of listeners) fn({ key });
  };
  return {
    keys() { return Object.keys(values); },
    get(key, fallback) { return Object.hasOwn(values, key) ? structuredClone(values[key]) : fallback; },
    update,
    async store(key, value) { update(key, value); },
    async delete(key) { update(key, undefined); },
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    dispose() { listeners.clear(); }
  };
}

module.exports = { createTestStore };
