'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { openAuthority } = require('../../src/jsonlAuthority');

const stamp = 1795179601000;
const mid = (n) => n.toString(16).padStart(32, '0');
const errorCode = async (fn) => { try { await fn(); return null; } catch (error) { return error.code || error.message; } };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function receipt(state, n, extra = {}) {
  return { v: 1, scope: state.scope, principal: 'device:fixture', mid: mid(n), target: 'session:fixture', what: 'send',
    issuedAt: state.clockHighWater, at: state.clockHighWater, expiresAt: state.clockHighWater + 86400000,
    hash: crypto.createHash('sha256').update(String(n)).digest('hex'), phase: 'completed', outcome: 'applied',
    result: { code: 'accepted', data: { instance: 'fixture', queueId: 'q' + n, operation: mid(n) }, replies: [] }, error: null,
    reservedResultBytes: 0, requestRef: null, ...extra };
}
function intent(state, n, payload = { text: 'full immutable prompt' }, extra = {}) {
  return { v: 1, id: 'outbox:' + n, scope: state.scope, principal: 'device:fixture', mid: mid(n), state: 'queued', payload, ...extra };
}
function disk() {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/na-'));
  const file = dir + '/authority.jsonl', stores = [];
  return { dir, file, async open(options = {}) {
    const store = await openAuthority({ file, now: () => stamp, ...options }); stores.push(store); return store;
  }, async dispose() { for (const store of stores) await store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
// Scoped faults never replace process-global fs methods or touch another root.
function faultFs() {
  const io = Object.create(fs), files = new Map();
  let fault = null;
  io.arm = (op, fn) => { fault = { op, fn }; };
  for (const op of ['openSync', 'writeSync', 'fsyncSync', 'renameSync', 'lstatSync', 'readFileSync', 'fstatSync']) {
    io[op] = (...args) => {
      if (fault && fault.op === op) {
        const selected = fault; fault = null;
        return selected.fn(args, () => fs[op](...args), files);
      }
      const result = fs[op](...args);
      if (op === 'openSync') files.set(result, args[0]);
      return result;
    };
  }
  return io;
}
module.exports = { disk, faultFs, receipt, intent, stamp, mid, errorCode, deferred };
