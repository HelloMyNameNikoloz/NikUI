'use strict';
const fs = require('fs'), path = require('path');
const { privateDirectory, privateFile, fail } = require('./daemonPaths');
const active = new WeakSet();
const same = (a, b) => a && b && a.ino === b.ino && a.dev === b.dev;
function acquire(directory) {
  privateDirectory(directory, false);
  directory = fs.realpathSync(directory);
  const file = path.join(directory, 'r1.lock');
  let fd, stat;
  try {
    if (process.platform === 'darwin') {
      privateFile(file, { optional: true });
      // Darwin open(2) O_EXLOCK takes the same kernel flock(2) lock, atomically
      // with open. Node omits its symbolic constant. Never unlink this inode:
      // all processes, including /tmp aliases, must contend on the same lock.
      fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | 0x20, 0o600);
    } else {
      // Portable test hosts have no O_EXLOCK. Keep the existing crash-safe
      // admission protocol there; shipping macOS always uses kernel flock.
      fd = require('./privateLock').open(file);
    }
    stat = fs.fstatSync(fd);
    if (!same(stat, privateFile(file))) throw fail('KEEPER_RESCUE_SUPERVISION_LOCK_CHANGED', 'Custody lock changed while opening');
    const lock = { directory, release() {
      if (!active.delete(lock)) return;
      try {
        if (process.platform !== 'darwin' && same(stat, privateFile(file, { optional: true }))) fs.unlinkSync(file);
      } finally { fs.closeSync(fd); }
    } };
    active.add(lock); return lock;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    error.operation = 'lock custody programs'; error.path = file; throw error;
  }
}
const busy = error => ['EAGAIN', 'EWOULDBLOCK', 'EEXIST'].includes(error.code);
function held(lock, directory) { return active.has(lock) && lock.directory === fs.realpathSync(directory); }
async function wait(directory, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return acquire(directory); }
    catch (error) {
      if (!busy(error)) throw error;
      if (Date.now() >= deadline) throw Object.assign(fail('KEEPER_RESCUE_SUPERVISION_LOCK_TIMEOUT', 'Another custody operation is still running'),
        { operation: 'lock custody programs', path: path.join(directory, 'r1.lock') });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
module.exports = { acquire, wait, held };
