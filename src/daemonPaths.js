'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function fail(code, message) { return Object.assign(new Error(message), { code }); }
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const uid = () => process.getuid();
function noSymlinks(file) {
  let at = path.parse(file).root;
  for (const part of file.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    let st;
    try { st = fs.lstatSync(at); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    // macOS's two system aliases are not user-selected redirects.
    if (st.isSymbolicLink() && !((at === '/tmp' || at === '/var') && fs.realpathSync(at) === '/private' + at)) {
      throw fail('UNSAFE_PATH', 'Private daemon paths must not contain symlinks');
    }
  }
}
function privateDirectory(dir, create = true) {
  noSymlinks(dir);
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid() || (st.mode & 0o777) !== 0o700) {
    throw fail('UNSAFE_DIRECTORY', 'Daemon directories must be owner-owned with mode 0700');
  }
  return dir;
}
function privateFile(file, { socket = false, optional = false } = {}) {
  let st;
  try { st = fs.lstatSync(file); }
  catch (err) { if (optional && err.code === 'ENOENT') return null; throw err; }
  return validatePrivateFile(st, socket);
}
function validatePrivateFile(st, socket = false, allowUnlinked = false) {
  if (st.uid !== uid() || (st.mode & 0o777) !== 0o600 || st.isSymbolicLink() ||
      (socket ? !st.isSocket() : !st.isFile() || st.nlink !== 1 && !(allowUnlinked && st.nlink === 0))) {
    throw fail('UNSAFE_FILE', 'Daemon files and socket must be owner-owned, unlinked private entries with mode 0600');
  }
  return st;
}
function privateRoot(root, { create = true, realHome = os.userInfo().homedir, envHome = process.env.HOME } = {}) {
  const { resolvedPath } = require('./engine');
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) {
    throw fail('ROOT_REQUIRED', 'An explicit absolute private --root is required (use a short temporary path)');
  }
  root = path.resolve(root);
  noSymlinks(root);
  const canonical = resolvedPath(root);
  const homes = [realHome, envHome].filter(Boolean).map((p) => resolvedPath(p));
  if (homes.includes(canonical) || homes.some((h) => inside(canonical, h)) ||
      /(?:^|\/)globalstorage(?:\/|$)/i.test(canonical) ||
      /\/Library\/Application Support\/(?:Code[^/]*|VSCodium|Cursor)(?:\/|$)/i.test(canonical) ||
      [path.parse(canonical).root, '/tmp', '/private/tmp', '/var', '/private/var'].includes(canonical)) {
    throw fail('FORBIDDEN_ROOT', 'Use a private fixture root outside HOME itself, editor profiles and globalStorage');
  }
  const socket = path.join(canonical, 'c.sock');
  // sockaddr_un.sun_path on macOS has 104 bytes including the terminator.
  if (Buffer.byteLength(socket) >= 104) throw fail('SOCKET_PATH_TOO_LONG', 'Control socket path must be under 104 bytes; choose a shorter --root');
  privateDirectory(canonical, create);
  return Object.freeze({ root: canonical, socket, lock: path.join(canonical, 'owner.lock'),
    home: path.join(canonical, 'home'), state: path.join(canonical, 'state'),
    secrets: path.join(canonical, 'secrets.test.json'), config: path.join(canonical, 'config.json') });
}

function readPrivateJson(file) {
  try {
    // atomicJson and the source observer publish with rename. A different
    // inode is legitimate only after both entries pass the full private-file
    // checks. Retry that race finitely; unsafe bytes and parse errors refuse.
    for (let attempt = 0; attempt < 4; attempt++) {
      const st = privateFile(file);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = validatePrivateFile(fs.fstatSync(fd), false, true);
        if (opened.nlink === 0 || opened.ino !== st.ino || opened.dev !== st.dev) {
          privateFile(file); // The replacement must also remain private.
          continue;
        }
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally { fs.closeSync(fd); }
    }
    throw fail('PATH_CHANGED', 'Private entry kept changing while opening');
  } catch (error) {
    error.operation = 'readPrivateJson'; error.path = file; throw error;
  }
}

function checkPrivateTree(root) {
  // Reject redirects in dormant legacy-format caches/readers too. Never
  // follow a source-state symlink while composing a private generation.
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    let st; try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isFile() && st.nlink === 2) {
      const claim = file.match(/^(.*\.lock)\.[a-f0-9]{32}\.candidate$/)?.[1] || (file.endsWith('.lock') ? file : null);
      if (claim) {
        require('./privateLock').settleClaim(claim);
        try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      }
    }
    if (st.isSymbolicLink() || st.uid !== uid() || (st.isFile() && st.nlink !== 1)) {
      throw fail('UNSAFE_PATH', 'Private daemon state contains a redirect or foreign-owned entry');
    }
    if (st.isDirectory()) { privateDirectory(file, false); checkPrivateTree(file); }
    else if (!st.isFile() && !st.isSocket()) throw fail('UNSAFE_PATH', 'Private daemon state contains an unsupported entry');
  }
}

module.exports = { privateRoot, privateDirectory, privateFile, readPrivateJson, checkPrivateTree, noSymlinks, inside, fail };
