'use strict';

// Disk primitive for P1-12. No transport advertises receipts on its behalf.
// One caller-owned private directory, one exclusive writer, one promise lane.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const LIMITS = Object.freeze({ maxEntries: 10000, maxBytes: 128 * 1024 * 1024,
  maxOutbox: 1024, maxPayloadBytes: 15 * 1024 * 1024, maxResultBytes: 16 * 1024 * 1024,
  retentionMs: 86400000, skewMs: 30000, maxLogBytes: 512 * 1024 * 1024 });
const HEX32 = /^[a-f0-9]{32}$/, HEX64 = /^[a-f0-9]{64}$/;
const terminal = (item) => ['completed', 'rejected', 'discarded'].includes(item.state);
const finalReceipt = (item) => item.phase === 'completed' && item.outcome !== 'unknown';
const key = (item) => JSON.stringify([item.scope, item.principal, item.mid]);
const err = (code, message) => Object.assign(new Error(message), { code });
const insist = (test, message) => { if (!test) throw err('AUTHORITY_INVALID', message); };
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const text = (v) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 1024 && !v.includes('\0');
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const clone = (v) => structuredClone(v);
const id = () => crypto.randomBytes(16).toString('hex');
const sameFile = (a, b) => a && b && a.ino === b.ino && a.dev === b.dev;
const expired = (item, at, limits) => at > item.expiresAt && at > item.issuedAt + limits.retentionMs + limits.skewMs;
const operationBytes = (item) => bytes({ type: 'operation', scope: item.scope, mid: item.mid, target: item.target,
  revision: item.revision, state: item.state === 'discarded' ? 'rejected' : item.state, provider: item.provider, error: item.error, at: item.at });
function reserveOperation(item) {
  if (item.operationBudget === undefined) return;
  const used = operationBytes(item);
  insist(used <= item.operationBudget, 'Operation exceeds its completion budget');
  item.reservedOperationBytes = terminal(item) ? 0 : item.operationBudget - used;
}

function json(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { insist(Number.isFinite(value), 'Non-finite JSON number'); return; }
  insist(Array.isArray(value) || plain(value), 'Only plain JSON data may be committed');
  insist(!seen.has(value), 'Cyclic JSON data'); seen.add(value);
  insist(Object.getOwnPropertySymbols(value).length === 0, 'Symbol JSON key');
  if (Array.isArray(value)) {
    insist(Object.keys(value).length === value.length, 'Sparse or extended JSON array');
    for (let n = 0; n < value.length; n++) insist(Object.hasOwn(value, n), 'Sparse JSON array');
  }
  for (const name of Object.keys(value)) {
    insist(!['__proto__', 'constructor', 'prototype'].includes(name), 'Unsafe JSON key');
    json(value[name], seen);
  }
  seen.delete(value);
}

function validateState(state, limits) {
  json(state);
  insist(plain(state) && state.v === VERSION && HEX32.test(state.engineId) && HEX32.test(state.scope) &&
    integer(state.clockHighWater) && Array.isArray(state.entries) && Array.isArray(state.outbox) && plain(state.values), 'Invalid authority envelope');
  const keys = new Set(), refs = new Map();
  let reserved = 0;
  for (const entry of state.entries) {
    insist(plain(entry) && entry.v === VERSION && HEX32.test(entry.scope) && text(entry.principal) && HEX32.test(entry.mid) &&
      text(entry.target) && text(entry.what) && HEX64.test(entry.hash) && integer(entry.issuedAt) && integer(entry.at) && integer(entry.expiresAt) &&
      entry.expiresAt >= entry.at + limits.retentionMs && integer(entry.reservedResultBytes) &&
      entry.at <= state.clockHighWater &&
      (entry.requestRef === null || text(entry.requestRef)), 'Invalid receipt');
    insist(!keys.has(key(entry)), 'Duplicate receipt key'); keys.add(key(entry));
    insist(['prepared', 'dispatching', 'completed'].includes(entry.phase), 'Invalid receipt phase');
    if (entry.phase === 'completed') {
      insist(['applied', 'rejected', 'unknown'].includes(entry.outcome) && entry.reservedResultBytes === 0, 'Invalid completed receipt');
      insist(entry.outcome === 'applied' ? plain(entry.result) && entry.error === null : plain(entry.error) && entry.result === null, 'Missing disposition');
      insist(entry.result ? text(entry.result.code) && plain(entry.result.data) && Array.isArray(entry.result.replies)
        : text(entry.error.code) && typeof entry.error.message === 'string' && typeof entry.error.retryable === 'boolean', 'Malformed disposition');
      insist(bytes({ result: entry.result, error: entry.error }) <= limits.maxResultBytes, 'Result exceeds maximum');
    } else {
      insist(entry.outcome === 'pending' && entry.result === null && entry.error === null &&
        entry.reservedResultBytes > 0 && entry.reservedResultBytes <= limits.maxResultBytes, 'Invalid completion reservation');
      // Envelope growth (pending -> completed, error code, etc.) also has room.
      reserved += entry.reservedResultBytes + 1024;
    }
  }
  for (const item of state.outbox) {
    insist(plain(item) && item.v === VERSION && text(item.id) && HEX32.test(item.scope) && text(item.principal) && HEX32.test(item.mid) &&
      ['prepared', 'queued', 'dispatching', 'accepted', 'unknown', 'completed', 'rejected', 'discarded'].includes(item.state) && plain(item.payload), 'Invalid outbox item');
    insist(bytes(item.payload) <= limits.maxPayloadBytes, 'Outbox payload exceeds maximum');
    insist(!refs.has(item.id), 'Duplicate outbox reference'); refs.set(item.id, item);
    if (item.operationBudget !== undefined) {
      insist(integer(item.operationBudget) && item.operationBudget > 0 && item.operationBudget <= limits.maxResultBytes &&
        integer(item.reservedOperationBytes) && operationBytes(item) <= item.operationBudget &&
        item.reservedOperationBytes === (terminal(item) ? 0 : item.operationBudget - operationBytes(item)), 'Invalid operation completion reservation');
      if (item.reservedOperationBytes) reserved += item.reservedOperationBytes + 1024;
    }
  }
  for (const entry of state.entries) if (entry.requestRef !== null) {
    const item = refs.get(entry.requestRef);
    insist(item && key(item) === key(entry), 'Receipt/outbox reference mismatch');
  }
  if (state.entries.length > limits.maxEntries || state.outbox.filter((item) => !terminal(item)).length > limits.maxOutbox ||
      bytes(state) + reserved > limits.maxBytes) throw err('RECEIPT_FULL', 'Authority capacity or completion reservations are full');
}

function validateTransition(before, next, limits, { evidence = null, restore = false } = {}) {
  validateState(next, limits);
  if (restore) {
    insist(next.engineId === before.engineId && next.scope !== before.scope && next.clockHighWater >= before.clockHighWater &&
      next.outbox.every((item) => item.scope !== next.scope && (terminal(item) || item.state === 'unknown')) &&
      next.entries.every((entry) => entry.scope !== next.scope && entry.phase === 'completed'), 'Restore must change scope and quarantine nonterminal work');
    return;
  }
  insist(next.engineId === before.engineId && next.scope === before.scope && next.clockHighWater >= before.clockHighWater, 'Authority identity or clock changed');
  const entries = new Map(next.entries.map((entry) => [key(entry), entry]));
  const previousKeys = new Set(before.entries.map(key));
  for (const old of before.entries) {
    const entry = entries.get(key(old));
    if (!entry) { insist(expired(old, next.clockHighWater, limits), 'An unexpired receipt cannot be removed'); continue; }
    for (const field of ['v', 'scope', 'principal', 'mid', 'target', 'what', 'hash', 'issuedAt', 'at', 'expiresAt', 'requestRef']) {
      insist(entry[field] === old[field], 'Immutable receipt binding or retention changed');
    }
    if (finalReceipt(old)) insist(JSON.stringify(entry) === JSON.stringify(old), 'A final receipt is immutable');
    else if (old.phase === 'completed') {
      insist(JSON.stringify(entry) === JSON.stringify(old) || text(evidence) && entry.phase === 'completed' && finalReceipt(entry), 'Unknown requires explicit resolution evidence');
    } else {
      insist(!(old.phase === 'dispatching' && entry.phase === 'prepared'), 'Dispatch cannot be rewound');
      if (entry.phase === 'completed') insist(bytes({ result: entry.result, error: entry.error }) <= old.reservedResultBytes, 'Result exceeds its completion reservation');
      else insist(entry.reservedResultBytes === old.reservedResultBytes, 'A completion reservation cannot be consumed by other work');
    }
  }
  const outbox = new Map(next.outbox.map((item) => [item.id, item]));
  for (const old of before.outbox) {
    const item = outbox.get(old.id);
    if (!item) { insist(terminal(old) && !next.entries.some((entry) => entry.requestRef === old.id), 'Unresolved payload cannot be removed'); continue; }
    for (const field of ['v', 'scope', 'principal', 'mid']) insist(item[field] === old[field], 'Outbox identity changed');
    for (const field of ['queueId', 'target', 'correlation', 'operationBudget']) if (Object.hasOwn(old, field)) insist(item[field] === old[field], 'Outbox entity or provider correlation changed');
    insist(JSON.stringify(item.payload) === JSON.stringify(old.payload), 'Immutable outbox input changed');
    if (old.state === 'unknown') insist(item.state === 'unknown' || text(evidence) && (terminal(item) || item.state === 'accepted'), 'Unknown work cannot become runnable');
    if (old.state === 'dispatching') insist(['dispatching', 'accepted', 'unknown', 'completed', 'rejected'].includes(item.state), 'Dispatch cannot become runnable');
    if (old.state === 'accepted') insist(['accepted', 'unknown', 'completed', 'rejected'].includes(item.state), 'Accepted work cannot become runnable');
    if (old.state === 'queued') insist(item.state !== 'prepared', 'Durable acceptance cannot be rewound');
    if (terminal(old)) insist(JSON.stringify(item) === JSON.stringify(old), 'Terminal outbox item changed');
  }
  for (const entry of next.entries) if (!previousKeys.has(key(entry))) {
    const wall = next.clockHighWater;
    if (entry.scope !== next.scope) throw err('SCOPE_CHANGED', 'New receipt belongs to another scope');
    if (entry.issuedAt < wall - limits.retentionMs - limits.skewMs) throw err('EXPIRED', 'Intent is too old for admission');
    if (entry.issuedAt > wall + limits.skewMs) throw err('CLOCK_SKEW', 'Intent time is ahead of the authority');
  }
}

function frame(type, seq, prev, state, evidence = null) {
  const data = { v: VERSION, type, seq, prev, state, evidence };
  return { ...data, hash: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}
function encode(record) { return Buffer.from(JSON.stringify(record) + '\n'); }

async function openAuthority({ file, fs: io = fs, now = Date.now, limits: overrides = {}, hook = async () => {}, readOnly = false, initialState } = {}) {
  const limits = Object.freeze({ ...LIMITS, ...overrides });
  for (const [name, value] of Object.entries(limits)) insist(Object.hasOwn(LIMITS, name) && integer(value) && value > 0, 'Invalid authority limit');
  insist(typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0'), 'Absolute authority path required');
  file = path.resolve(file);
  const dir = path.dirname(file), lockFile = file + '.writer', reapFile = lockFile + '.reap';
  let fd, lock, directory, state = null, seq = 0, hash = null, size = 0, identity, issue = null, closed = false, closing = null, busy = false, lane = Promise.resolve();
  // Derived positions only. The committed JSONL state remains authoritative;
  // positions also address its transaction clones without serializing every
  // receipt key again on each dispatcher lookup.
  let receiptIndex = new Map();
  const receiptIndexes = new WeakMap();
  const indexReceipts = () => { receiptIndex = new Map((state?.entries || []).map((entry, n) => [key(entry), n])); };
  const copyState = () => { const copy = clone(state); receiptIndexes.set(copy.entries, receiptIndex); return copy; };
  function nextReceiptIndex(entries) {
    const before = state.entries, common = Math.min(before.length, entries.length);
    for (let n = 0; n < common; n++) if (before[n].scope !== entries[n].scope || before[n].principal !== entries[n].principal || before[n].mid !== entries[n].mid) {
      return new Map(entries.map((entry, position) => [key(entry), position])); // prune/reorder/restore
    }
    if (before.length === entries.length) return receiptIndex; // completion changes no binding
    const next = new Map(receiptIndex);
    for (let n = common; n < before.length; n++) next.delete(key(before[n]));
    for (let n = common; n < entries.length; n++) next.set(key(entries[n]), n);
    return next;
  }
  const uid = process.getuid();
  function checkDirectory() {
    let at = path.parse(dir).root;
    for (const part of dir.slice(at.length).split(path.sep).filter(Boolean)) {
      at = path.join(at, part);
      const st = io.lstatSync(at);
      insist(!st.isSymbolicLink() || (at === '/tmp' || at === '/var') && io.realpathSync(at) === '/private' + at, 'Symlink in authority path');
    }
    const st = io.lstatSync(dir);
    insist(st.isDirectory() && st.uid === uid && (st.mode & 0o777) === 0o700 && (!directory || sameFile(directory, st)), 'Authority directory must stay owner-private');
    directory = st;
  }
  function checkFile(name, optional = false) {
    let st;
    try { st = io.lstatSync(name); } catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
    insist(st.isFile() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o777) === 0o600 && st.nlink === 1, 'Authority file must be an owner-private unlinked file');
    return st;
  }
  function syncDir() {
    const d = io.openSync(dir, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    try { io.fsyncSync(d); } finally { io.closeSync(d); }
  }
  function writeAll(handle, data) {
    let offset = 0;
    while (offset < data.length) {
      const n = io.writeSync(handle, data, offset, data.length - offset, null);
      if (!Number.isInteger(n) || n <= 0) throw err('EIO', 'Authority write made no progress');
      offset += n;
    }
  }
  function poison(error) {
    issue = { code: error.code && /^(AUTHORITY_|STORAGE_|WRITER_)/.test(error.code) ? error.code : 'STORAGE_UNAVAILABLE',
      cause: error.code || 'EIO', message: 'Authority is unavailable; preserve the files and unresolved work.' };
    return err('STORAGE_UNAVAILABLE', issue.message);
  }
  const healthy = () => { if (closed || issue || readOnly) throw err('STORAGE_UNAVAILABLE', 'Authority is closed or unavailable; delivery cannot be determined'); };
  const enqueue = (fn) => { const result = lane.then(fn); lane = result.catch(() => {}); return result; };
  const wallTime = () => { const at = now(); insist(integer(at), 'Clock must return integer milliseconds'); return at; };
  function checkOpen() {
    checkDirectory();
    insist(sameFile(lock, checkFile(lockFile)), 'Authority writer lock changed');
    const st = checkFile(file), opened = io.fstatSync(fd);
    insist(sameFile(identity, st) && sameFile(identity, opened) && st.size === size && opened.size === size &&
      st.mtimeMs === identity.mtimeMs && st.ctimeMs === identity.ctimeMs, 'Authority changed outside its writer');
  }
  function createLock(name, record) {
    const handle = io.openSync(name, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW, 0o600);
    try { writeAll(handle, Buffer.from(JSON.stringify(record) + '\n')); io.fsyncSync(handle); return io.fstatSync(handle); }
    finally { io.closeSync(handle); }
  }
  function readLock() {
    const st = checkFile(lockFile), handle = io.openSync(lockFile, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    try { insist(sameFile(st, io.fstatSync(handle)), 'Writer lock changed'); return { st, value: JSON.parse(io.readFileSync(handle, 'utf8')) }; }
    finally { io.closeSync(handle); }
  }
  const dead = (pid) => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
  function acquire() {
    if (checkFile(reapFile, true)) throw err('WRITER_UNPROVEN', 'Writer recovery lock requires inspection');
    const record = { v: VERSION, pid: process.pid, token: id() };
    try { lock = createLock(lockFile, record); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const previous = readLock();
      if (previous.value.v !== VERSION || !dead(previous.value.pid)) throw err('WRITER_EXISTS', 'Another authority writer exists');
      const reaper = createLock(reapFile, record);
      try {
        const current = readLock();
        if (!sameFile(previous.st, current.st) || !dead(current.value.pid)) throw err('WRITER_UNPROVEN', 'Writer changed during recovery');
        io.unlinkSync(lockFile); lock = createLock(lockFile, record);
      } finally { if (sameFile(reaper, checkFile(reapFile, true))) io.unlinkSync(reapFile); }
    }
  }
  function release() {
    if (lock && sameFile(lock, checkFile(lockFile, true))) io.unlinkSync(lockFile);
    lock = null;
  }
  function removeOrphanCompactions() {
    // Only our exact temp namespace, after validating the committed log and
    // acquiring its exclusive writer. Never promote a temp or clean on doctor.
    const prefix = path.basename(file) + '.';
    let removed = false;
    for (const name of io.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp') || !HEX32.test(name.slice(prefix.length, -4))) continue;
      checkDirectory(); insist(sameFile(lock, checkFile(lockFile)), 'Authority writer lock changed during cleanup');
      checkFile(path.join(dir, name)); io.unlinkSync(path.join(dir, name)); removed = true;
    }
    if (removed) syncDir();
  }
  async function compactState(next, nextSeq, label = 'compact') {
    const record = frame('header', nextSeq, null, next), data = encode(record);
    if (data.length > limits.maxLogBytes) throw err('RECEIPT_FULL', 'Physical authority bound is full');
    const tmp = file + '.' + id() + '.tmp';
    let handle, renamed = false;
    try {
      checkDirectory(); checkFile(file, true);
      handle = io.openSync(tmp, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW, 0o600);
      writeAll(handle, data); await hook(label + ':written');
      io.fsyncSync(handle); await hook(label + ':file-synced');
      io.closeSync(handle); handle = undefined;
      checkDirectory();
      insist(sameFile(lock, checkFile(lockFile)), 'Authority writer lock changed before rename');
      if (identity) checkOpen(); else insist(!checkFile(file, true), 'Authority appeared during initialization');
      io.renameSync(tmp, file); renamed = true; await hook(label + ':renamed');
      syncDir(); await hook(label + ':directory-synced');
      if (fd !== undefined) { io.closeSync(fd); fd = undefined; }
      const st = checkFile(file);
      fd = io.openSync(file, io.constants.O_WRONLY | io.constants.O_APPEND | io.constants.O_NOFOLLOW);
      insist(sameFile(st, io.fstatSync(fd)), 'Compacted authority changed');
      identity = st; size = data.length; hash = record.hash;
    } finally {
      if (handle !== undefined) io.closeSync(handle);
      if (!renamed) { try { io.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    }
  }
  try {
    checkDirectory();
    if (!readOnly) acquire();
    const st = checkFile(file, true);
    if (!st) {
      if (readOnly) throw err('AUTHORITY_MISSING', 'No authority exists at this path');
      // Selected inactive imports can install a fully validated current image
      // exactly once. An existing authority always wins, including its unknown
      // outcomes; a restart never restores the original import over it.
      state = initialState ? clone(initialState) : { v: VERSION, engineId: id(), scope: id(), clockHighWater: wallTime(), entries: [], outbox: [], values: {} };
      validateState(state, limits);
      await compactState(state, 0, 'initialize');
    } else {
      if (st.size > limits.maxLogBytes) throw err('AUTHORITY_TOO_LARGE', 'Physical authority exceeds its bound');
      const handle = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
      let data;
      try { insist(sameFile(st, io.fstatSync(handle)), 'Authority changed while opening'); data = io.readFileSync(handle); }
      finally { io.closeSync(handle); }
      let offset = 0, count = 0;
      size = data.length;
      while (offset < data.length) {
        const end = data.indexOf(10, offset);
        if (end < 0) throw err('AUTHORITY_TORN_TAIL', 'Unframed final record; retained prefix is diagnostic only');
        let record;
        try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, end))); }
        catch (_) { throw err('AUTHORITY_CORRUPT', 'Malformed authority record'); }
        if (record && (record.v > VERSION || record.state && record.state.v > VERSION)) throw err('AUTHORITY_NEWER_SCHEMA', 'Newer authority schema');
        const expected = record && frame(record.type, record.seq, record.prev, record.state, record.evidence);
        insist(plain(record) && Object.keys(record).sort().join() === 'evidence,hash,prev,seq,state,type,v' && record.v === VERSION &&
          integer(record.seq) && HEX64.test(record.hash) && expected.hash === record.hash &&
          (record.type === 'resolve' ? text(record.evidence) : record.evidence === null) &&
          (count === 0 ? record.type === 'header' && record.prev === null : ['commit', 'resolve', 'restore'].includes(record.type) && record.seq === seq + 1 && record.prev === hash), 'Invalid record framing or checksum');
        validateState(record.state, limits);
        if (state) validateTransition(state, record.state, limits, { evidence: record.evidence, restore: record.type === 'restore' });
        state = record.state; seq = record.seq; hash = record.hash;
        offset = end + 1; count++;
      }
      if (!count) throw err('AUTHORITY_CORRUPT', 'Existing empty authority cannot be reset');
      if (!readOnly) {
        fd = io.openSync(file, io.constants.O_WRONLY | io.constants.O_APPEND | io.constants.O_NOFOLLOW);
        insist(sameFile(st, io.fstatSync(fd)), 'Authority changed while opening writer');
      }
      identity = st; size = data.length;
    }
    if (!readOnly) removeOrphanCompactions();
  } catch (e) { poison(e); }
  indexReceipts();

  async function commit(update, options = {}) {
    if (closing) throw err('STORAGE_UNAVAILABLE', 'Authority is closing');
    healthy();
    insist(plain(options) && Object.keys(options).every((name) => ['evidence', 'restore'].includes(name)) &&
      (options.evidence === undefined || options.evidence === null || text(options.evidence)) &&
      (options.restore === undefined || typeof options.restore === 'boolean'), 'Invalid commit policy');
    const policy = { evidence: options.evidence || null, restore: options.restore === true };
    return enqueue(async () => {
      healthy();
      let next = copyState();
      const at = wallTime();
      next.clockHighWater = Math.max(next.clockHighWater, at);
      if (typeof update !== 'function') throw err('AUTHORITY_INVALID', 'A state transition function is required');
      const result = update(next);
      insist(!result || typeof result.then !== 'function', 'State transitions must be synchronous and contain no external effects');
      // The transition callback must not retain a mutable alias to authority.
      json(next);
      next = clone(next);
      next.clockHighWater = policy.restore ? Math.max(next.clockHighWater, state.clockHighWater, at) : Math.max(state.clockHighWater, at);
      // Clock correction blocks only new admissions, never completions.
      const previousKeys = new Set(state.entries.map(key));
      if (at + limits.skewMs < state.clockHighWater && next.entries.some((entry) => !previousKeys.has(key(entry)))) {
        throw err('CLOCK_SKEW', 'Clock is behind the persisted authority high-water');
      }
      validateTransition(state, next, limits, policy);
      if (JSON.stringify(next) === JSON.stringify(state)) return copyState();
      const nextIndex = nextReceiptIndex(next.entries);
      const kind = policy.restore ? 'restore' : policy.evidence ? 'resolve' : 'commit';
      insist(integer(seq + 1), 'Authority sequence exhausted');
      let record = frame(kind, seq + 1, hash, next, policy.evidence), data = encode(record);
      // Always leave room to rewrite a complete live image. Reservations
      // count toward this bound so a different admission cannot steal it.
      const reservation = next.entries.reduce((n, entry) => n + (entry.reservedResultBytes ? entry.reservedResultBytes + 1024 : 0), 0) +
        next.outbox.reduce((n, item) => n + (item.reservedOperationBytes ? item.reservedOperationBytes + 1024 : 0), 0);
      if (data.length + reservation > limits.maxLogBytes / 2) throw err('RECEIPT_FULL', 'Physical completion space is full');
      try {
        checkOpen();
        busy = true;
        if (size + data.length > limits.maxLogBytes) {
          await compactState(state, seq); // same state, no new acknowledgment
          record = frame(kind, record.seq, hash, next, policy.evidence);
          data = encode(record);
        }
        await hook('append:before'); writeAll(fd, data); await hook('append:written');
        io.fsyncSync(fd); await hook('append:synced');
        size += data.length;
        identity = io.fstatSync(fd); checkOpen();
        state = next; seq = record.seq; hash = record.hash; receiptIndex = nextIndex;
        return copyState();
      } catch (e) { throw poison(e); }
      finally { busy = false; }
    });
  }
  return {
    limits,
    status() { return { writable: !closed && !closing && !issue && !readOnly, issue: issue && { ...issue }, seq, bytes: size }; },
    inspect() { return { authoritative: !closed && !issue && !readOnly, state: state && clone(state), issue: issue && { ...issue } }; },
    snapshot() { healthy(); if (!busy) { try { checkOpen(); } catch (e) { throw poison(e); } } return copyState(); },
    receiptInfo() { healthy(); return { scope: state.scope, clockHighWater: state.clockHighWater }; },
    findReceipt(draft, bindingKey) {
      let index = receiptIndexes.get(draft.entries);
      if (!index) { index = new Map(draft.entries.map((entry, n) => [key(entry), n])); receiptIndexes.set(draft.entries, index); }
      const position = index.get(bindingKey);
      return position === undefined ? undefined : draft.entries[position];
    },
    commit,
    lookup({ principal, scope, mid }) {
      return enqueue(() => {
        healthy();
        try { checkOpen(); } catch (e) { throw poison(e); }
        insist(text(principal) && typeof scope === 'string' && HEX32.test(scope) && typeof mid === 'string' && HEX32.test(mid), 'Invalid receipt lookup key');
        if (scope !== state.scope) throw err('SCOPE_CHANGED', 'Receipt scope changed');
        const position = receiptIndex.get(key({ principal, scope, mid }));
        return clone(position === undefined ? null : state.entries[position]);
      });
    },
    compact() {
      healthy();
      return enqueue(async () => {
        healthy();
        try { checkOpen(); busy = true; await compactState(state, seq); indexReceipts(); }
        catch (e) { throw poison(e); }
        finally { busy = false; }
      });
    },
    prune() {
      return commit((next) => {
        const at = Math.max(wallTime(), next.clockHighWater);
        next.entries = next.entries.filter((entry) => !expired(entry, at, limits));
        const refs = new Set(next.entries.map((entry) => entry.requestRef));
        next.outbox = next.outbox.filter((item) => !terminal(item) || refs.has(item.id));
      });
    },
    // A backup is never evidence of non-dispatch. All of its runnable work
    // retains its original scope and becomes unknown in the new scope.
    restoreBackup(backup) {
      validateState(backup, limits);
      const saved = clone(backup);
      return commit((next) => {
        const restored = clone(saved);
        restored.engineId = next.engineId;
        restored.scope = id(); restored.clockHighWater = Math.max(next.clockHighWater, backup.clockHighWater);
        for (const item of restored.outbox) if (!terminal(item)) {
          item.state = 'unknown';
          if (item.operationBudget !== undefined) {
            item.revision++; item.at = restored.clockHighWater;
            item.error = { code: 'OUTCOME_UNKNOWN', message: 'Restored backup requires reconciliation', retryable: false };
            reserveOperation(item);
          }
        }
        for (const entry of restored.entries) if (!finalReceipt(entry)) {
          entry.phase = 'completed'; entry.outcome = 'unknown'; entry.result = null;
          entry.error = { code: 'OUTCOME_UNKNOWN', message: 'Restored backup requires reconciliation', retryable: false }; entry.reservedResultBytes = 0;
        }
        Object.assign(next, restored);
      }, { restore: true });
    },
    close() {
      if (closing) return closing;
      // Queue first so already admitted commits finish before closing.
      closing = enqueue(() => {
        closed = true;
        try { if (fd !== undefined) { io.closeSync(fd); fd = undefined; } }
        finally { release(); }
      });
      return closing;
    }
  };
}

module.exports = { openAuthority, LIMITS, VERSION, validateState, reserveOperation };
