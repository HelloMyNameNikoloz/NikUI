'use strict';
const fs = require('fs'), crypto = require('crypto');
const { privateFile, readPrivateJson, fail } = require('./daemonPaths');
const { pidState } = require('./daemonLock');
const same = (a, b) => a && b && a.ino === b.ino && a.dev === b.dev;

// Publish an already-fsynced claim with link(O_EXCL). A crash can never leave
// an empty/unparseable ownership record at the public lock path. The brief
// two-link interval is recognized only for this exact private claim inode.
function settleClaim(file) {
  const deadline = Date.now() + 5000;
  for (;;) {
    let st; try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.nlink !== 2) return;
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600) throw fail('UNSAFE_FILE', 'Unsafe lock claim');
    let record, fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!same(st, fs.fstatSync(fd))) continue;
      record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !/^[a-f0-9]{32}$/.test(record.token || '')) throw fail('UNSAFE_FILE', 'Invalid lock claim');
    const candidate = file + '.' + record.token + '.candidate';
    let claim; try { claim = fs.lstatSync(candidate); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!same(st, claim) || claim.isSymbolicLink() || claim.uid !== st.uid || claim.mode !== st.mode) throw fail('UNSAFE_FILE', 'Unrelated lock hard link');
    if (pidState(record.pid) === 'dead') { fs.unlinkSync(candidate); return; }
    if (Date.now() >= deadline) throw fail('OWNER_ADMISSION_TIMEOUT', 'A live process has not finished publishing its lock claim');
    // The holder is in the synchronous link/unlink publication interval.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}
function reapDead(file) {
  settleClaim(file);
  const st = privateFile(file, { optional: true });
  if (!st) return true;
  let record; try { record = readPrivateJson(file); } catch (_) { return false; }
  if (!Number.isSafeInteger(record.pid) || record.pid < 1 || pidState(record.pid) !== 'dead') return false;
  const current = privateFile(file, { optional: true });
  if (!same(current, st) || pidState(record.pid) !== 'dead') return false;
  fs.unlinkSync(file); return true;
}
function open(file, attributes = {}, { reap = true } = {}) {
  for (;;) {
    const token = attributes.token || crypto.randomBytes(16).toString('hex'), candidate = file + '.' + token + '.candidate';
    let fd, published = false;
    try {
      fd = fs.openSync(candidate, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify({ ...attributes, pid: process.pid, token })); fs.fsyncSync(fd);
      fs.linkSync(candidate, file); published = true;
      fs.unlinkSync(candidate);
      return fd;
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(candidate); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; }
      if (published || e.code !== 'EEXIST') throw e;
      settleClaim(file);
      if (!reap || !reapDead(file)) throw e;
    }
  }
}
module.exports = { reapDead, settleClaim, open };

