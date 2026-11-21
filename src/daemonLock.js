'use strict';

const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { privateFile, readPrivateJson, fail } = require('./daemonPaths');

function probeSocket(file, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: file });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish('live'));
    socket.once('error', (err) => finish(['ENOENT', 'ECONNREFUSED'].includes(err.code) ? 'absent' : 'unproved'));
    socket.setTimeout(timeoutMs, () => finish('unproved'));
  });
}
function pidState(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (err) { return err.code === 'ESRCH' ? 'dead' : 'unproved'; }
}
const same = (a, b) => a && b && a.ino === b.ino && a.dev === b.dev;

// Offline doctor inspects only this root's control endpoint, never keeper.
async function diagnoseRoot(paths, { alive = pidState, probe = probeSocket } = {}) {
  const breaker = paths.lock + '.reap';
  if (!privateFile(breaker, { optional: true })) {
    const file = path.join(paths.state, 'authority.jsonl');
    if (privateFile(file, { optional: true })) {
      const authority = await require('./jsonlAuthority').openAuthority({ file, readOnly: true });
      const issue = authority.status().issue;
      await authority.close();
      if (issue) return { ok: false, code: issue.code, hint: 'Private JSONL authority is unavailable. Preserve its bytes and unresolved inputs; do not reset it under the same scope.' };
    }
    return { ok: false, code: 'OWNER_UNAVAILABLE', hint: 'No daemon answers this private root.' };
  }
  let reaper, owner;
  try {
    reaper = readPrivateJson(breaker);
    owner = privateFile(paths.lock, { optional: true }) ? readPrivateJson(paths.lock) : null;
  } catch (_) { return { ok: false, code: 'OWNER_UNPROVEN', hint: 'Recovery record is unreadable; inspect it without removing any endpoint.' }; }
  const valid = (record) => record && record.version === 1 && Number.isSafeInteger(record.pid) && record.pid > 0;
  const dead = valid(reaper) && alive(reaper.pid) === 'dead' && (!owner || valid(owner) && alive(owner.pid) === 'dead');
  privateFile(paths.socket, { socket: true, optional: true });
  if (!dead || await probe(paths.socket) !== 'absent') {
    return { ok: false, code: 'OWNER_UNPROVEN', hint: 'Recovery owner or control endpoint is live or unproved; leave all locks and endpoints in place.' };
  }
  const quoted = "'" + breaker.replace(/'/g, "'\\''") + "'";
  return { ok: false, code: 'OWNER_UNPROVEN', recoveryLock: breaker,
    hint: 'The recovery pid and root owner are dead and the control endpoint is absent. With all nikd starts for this root stopped, remove only the recovery lock, then retry start.',
    manualFix: 'rm -- ' + quoted };
}

async function acquireRootLock(paths, { probe = probeSocket, alive = pidState } = {}) {
  const breaker = paths.lock + '.reap';
  const token = crypto.randomUUID();
  let held = null;
  const record = { version: 1, pid: process.pid, token };
  function create(file) {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd); return fs.fstatSync(fd); }
    finally { fs.closeSync(fd); }
  }
  function release() {
    if (held && same(held, privateFile(paths.lock, { optional: true }))) {
      const owner = readPrivateJson(paths.lock);
      if (owner.token === token && owner.pid === process.pid) fs.unlinkSync(paths.lock);
    }
    held = null;
  }
  // A dead reaper is intentionally a named refusal; no age-based unlink can
  // prove an endpoint safe. It contains a pid for manual fixture diagnostics.
  if (privateFile(breaker, { optional: true })) throw fail('OWNER_UNPROVEN', 'Root recovery is already in progress; inspect the private fixture lock');
  try { held = create(paths.lock); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const st = privateFile(paths.lock);
    let owner;
    try { owner = readPrivateJson(paths.lock); } catch (_) { throw fail('OWNER_UNPROVEN', 'Existing root owner record is unreadable'); }
    if (!owner || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') {
      throw fail('OWNER_UNPROVEN', 'Existing root owner record cannot be proved stale');
    }
    privateFile(paths.socket, { socket: true, optional: true });
    const state = alive(owner.pid), endpoint = await probe(paths.socket);
    if (state !== 'dead' || endpoint !== 'absent') {
      throw fail(endpoint === 'live' ? 'OWNER_EXISTS' : 'OWNER_UNAVAILABLE', 'Another root owner exists or is unavailable; no takeover was attempted');
    }
    let recovery;
    try { recovery = create(breaker); }
    catch (err) { if (err.code === 'EEXIST') throw fail('OWNER_UNPROVEN', 'Another process is recovering this private root'); throw err; }
    try {
      if (!same(st, privateFile(paths.lock)) || alive(owner.pid) !== 'dead' || await probe(paths.socket) !== 'absent') {
        throw fail('OWNER_UNPROVEN', 'Root ownership changed during recovery');
      }
      const endpoint = privateFile(paths.socket, { socket: true, optional: true });
      if (endpoint) fs.unlinkSync(paths.socket);
      fs.unlinkSync(paths.lock);
      held = create(paths.lock);
    } finally {
      if (same(recovery, privateFile(breaker, { optional: true }))) fs.unlinkSync(breaker);
    }
  }
  try {
    // An endpoint without a matching dead owner record is unproved, even if
    // connect() refuses it. Never unlink it on a fresh acquisition.
    if (privateFile(paths.socket, { socket: true, optional: true })) {
      throw fail('OWNER_UNPROVEN', 'An existing control endpoint has no proved stale owner');
    }
    return { token, record, release };
  } catch (err) { release(); throw err; }
}

module.exports = { acquireRootLock, probeSocket, pidState, diagnoseRoot };
