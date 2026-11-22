'use strict';
const { privateFile, readPrivateJson, fail } = require('./daemonPaths');
const { atomicJson } = require('./engineOwner');
// Production memento mirrors, never credentials or receipt authority.
function createPrivateStore(file, { initial = {}, assertCurrent = () => {} } = {}) {
  let values = privateFile(file, { optional: true }) ? readPrivateJson(file).values : structuredClone(initial);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail('STORE_UNAVAILABLE', 'Private mirror is corrupt');
  const listeners = new Set();
  const api = {
    keys: () => Object.keys(values),
    get: (key, fallback) => Object.hasOwn(values, key) ? structuredClone(values[key]) : fallback,
    update(key, value) {
      assertCurrent();
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('BAD_STORE_KEY', 'Invalid mirror key');
      const next = structuredClone(values);
      if (value === undefined) delete next[key]; else next[key] = structuredClone(value);
      atomicJson(file, { version: 1, values: next }); values = next;
      for (const fn of listeners) fn({ key });
    },
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    dispose() { listeners.clear(); }
  };
  return api;
}
module.exports = { createPrivateStore };
