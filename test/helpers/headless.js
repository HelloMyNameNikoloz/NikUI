'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The outer runner may already have installed a permissive vscode stub. Every
// core fixture gets a fresh process, a private HOME, and poisoned resolution.
function headlessChecks(fixture, { privateListener = false, controlListener = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nik-engine-test-'));
  fs.mkdirSync(path.join(root, 'tmp'));
  try {
    const checks = JSON.parse(require('child_process').execFileSync(process.execPath, [__filename, fixture], {
      encoding: 'utf8', timeout: 30000,
      env: { HOME: root, USERPROFILE: root, TMPDIR: path.join(root, 'tmp'),
        NIKUI_KEEPER_DIR: path.join(root, 'keeper'), CODEX_HOME: path.join(root, 'unused-account'),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', NIKUI_ENGINE_FIXTURE_ROOT: root,
        NIKUI_ENGINE_PRIVATE_LISTENER: privateListener ? '1' : '',
        NIKUI_ENGINE_CONTROL_LISTENER: controlListener ? '1' : '' }
    }));
    for (const result of checks) {
      suite(result.suite);
      checkEqual(result.name, result.actual, result.expected);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (require.main === module) {
  const Module = require('module');
  const checks = [];
  let currentSuite = 'headless', vscodeAttempts = 0, externalAttempts = 0;
  global.suite = (name) => { currentSuite = name; };
  global.checkEqual = (name, actual, expected) => checks.push({ suite: currentSuite, name, actual, expected });
  global.check = (name, actual) => checkEqual(name, !!actual, true);
  for (const method of ['_load', '_resolveFilename']) {
    const original = Module[method];
    Module[method] = function (name) {
      if (/^(?:node:)?vscode(?:\/|$)/.test(name)) { vscodeAttempts++; throw new Error('vscode resolution poisoned'); }
      return original.apply(this, arguments);
    };
  }
  const external = () => { externalAttempts++; throw new Error('A headless fixture attempted a real provider/network effect'); };
  process.kill = external;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) require('child_process')[name] = external;
  const net = require('net'), ports = new Set(), servers = new Set();
  let privateBinds = 0;
  const privateListener = process.env.NIKUI_ENGINE_PRIVATE_LISTENER === '1';
  const controlListener = process.env.NIKUI_ENGINE_CONTROL_LISTENER === '1';
  const controlRoot = fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT);
  const controlPath = (file) => controlListener && typeof file === 'string' &&
    path.join(fs.realpathSync(path.dirname(file)), path.basename(file)).startsWith(controlRoot + path.sep);
  const listen = net.Server.prototype.listen, connect = net.connect, createConnection = net.createConnection;
  net.Server.prototype.listen = function (...args) {
    const unix = controlPath(args[0]);
    if (!unix && (!privateListener || args[0] !== 0 || args[1] !== '127.0.0.1')) return external();
    servers.add(this);
    let port;
    this.once('listening', () => { if (!unix) { privateBinds++; port = this.address().port; ports.add(port); } });
    this.once('close', () => { servers.delete(this); ports.delete(port); });
    return listen.apply(this, args);
  };
  const privateConnection = (original) => function (...args) {
    const options = typeof args[0] === 'object' ? args[0] : typeof args[0] === 'string' && path.isAbsolute(args[0])
      ? { path: args[0] } : { port: args[0], host: args[1] };
    if (!controlPath(options.path) && (!privateListener || options.host !== '127.0.0.1' || !ports.has(Number(options.port)) || options.path)) return external();
    return original.apply(this, args);
  };
  net.connect = privateConnection(connect);
  net.createConnection = privateConnection(createConnection);
  require('http2').connect = external;
  require('tls').connect = external;
  for (const protocol of ['http', 'https']) {
    const http = require(protocol), request = http.request;
    http.request = function (options, ...args) {
      if (!privateListener || protocol !== 'http' || !options || typeof options !== 'object' ||
          (options.host || options.hostname) !== '127.0.0.1' || !ports.has(Number(options.port)) || options.socketPath) return external();
      return request.call(this, options, ...args);
    };
    http.get = function (...args) { const req = http.request(...args); req.end(); return req; };
  }
  global.fetch = external;
  // Guard every path mutation, including caught failures and symlink escapes.
  // Reads of repo code are allowed; writes and watches belong to this HOME.
  const fixtureRoot = fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT);
  let escapedWrites = 0;
  const descriptors = new Map();
  const inside = (file) => {
    if (typeof file === 'number') {
      if (!descriptors.has(file)) { escapedWrites++; throw new Error('Fixture write through an untracked descriptor'); }
      file = descriptors.get(file);
    }
    let at = path.resolve(String(file));
    const tail = [];
    for (;;) {
      try { at = path.join(fs.realpathSync(at), ...tail); break; }
      catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
        const up = path.dirname(at);
        if (up === at) throw err;
        tail.unshift(path.basename(at)); at = up;
      }
    }
    if (at !== fixtureRoot && !at.startsWith(fixtureRoot + path.sep)) {
      escapedWrites++; throw new Error('Fixture write outside its private root');
    }
  };
  const writes = { appendFile: [0], writeFile: [0], mkdir: [0], mkdtemp: [0], rm: [0], rmdir: [0], unlink: [0],
    chmod: [0], chown: [0], utimes: [0], truncate: [0], rename: [0, 1], copyFile: [1], cp: [1], link: [0, 1],
    symlink: [1], createWriteStream: [0], watch: [0], watchFile: [0] };
  for (const api of [fs, fs.promises]) {
    for (const [name, indexes] of Object.entries(writes)) for (const method of [name, name + 'Sync']) {
      if (typeof api[method] !== 'function') continue;
      const original = api[method];
      api[method] = function (...args) { for (const i of indexes) inside(args[i]); return original.apply(this, args); };
    }
    for (const method of ['open', 'openSync']) {
      if (typeof api[method] !== 'function') continue;
      const original = api[method];
      api[method] = function (file, flags, ...args) {
        if (typeof flags === 'number' ? flags !== fs.constants.O_RDONLY : /[wa+]/.test(flags)) inside(file);
        if (api === fs && method === 'openSync') {
          const fd = original.call(this, file, flags, ...args); descriptors.set(fd, file); return fd;
        }
        if (api === fs && method === 'open') {
          const callback = args.pop();
          return original.call(this, file, flags, ...args, (err, fd) => { if (!err) descriptors.set(fd, file); callback(err, fd); });
        }
        return original.call(this, file, flags, ...args);
      };
    }
  }
  for (const method of ['close', 'closeSync']) {
    const original = fs[method];
    fs[method] = function (fd, ...args) { descriptors.delete(fd); return original.call(this, fd, ...args); };
  }
  (async () => {
    await require(path.resolve(process.argv[2]))();
    // Sample after referenced timers/streams drain too: a late caught import
    // must not slip past the proof printed by a completed fixture body.
    process.once('beforeExit', () => {
      suite(path.basename(process.argv[2]) + ' — clean poisoned process');
      checkEqual('no eager, lazy, caught or fallback vscode resolution', vscodeAttempts, 0);
      checkEqual('no real provider, listener or network fallback', externalAttempts, 0);
      checkEqual('no caught or late write escaped the private fixture root', escapedWrites, 0);
      checkEqual('every private listener was closed', servers.size, 0);
      if (privateListener) check('the actual ephemeral loopback listener ran', privateBinds > 0);
      checkEqual('the graph never loaded editor chrome', Object.keys(require.cache).filter((file) =>
        /\/src\/(?:extension|extensionEngine|editorHost|host|tree|historyTree|settingsMenu|slackHome|slackPanel)\.js$/.test(file)), []);
      process.stdout.write(JSON.stringify(checks));
    });
  })().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { headlessChecks };
