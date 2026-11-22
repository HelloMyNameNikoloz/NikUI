'use strict';
const fs = require('fs'), path = require('path'), { fork } = require('child_process');
const { createOwner } = require('../src/engineOwner');
const { privateDirectory } = require('../src/daemonPaths');
module.exports = async () => {
  suite('R11 real process loss, stale roster pruning and contending window effects');
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/nk-live-')), root = path.join(home, 'owner');
  privateDirectory(root);
  const script = path.join(home, 'source.cjs'), modulePath = path.resolve(__dirname, '../src/engineOwner');
  fs.writeFileSync(script, [
    "'use strict';",
    'const fs = require("fs"), net = require("net");',
    'const { createOwner } = require(' + JSON.stringify(modulePath) + ');',
    'const root = process.argv[2], socket = root + "/source.sock";',
    '(async () => {',
    ' const server = net.createServer(); await new Promise(r => server.listen(socket, r)); fs.chmodSync(socket, 0o600);',
    ' const owner = createOwner({ root, profile: "liveness", install: "fixture" }); await owner.initialize();',
    ' const member = await owner.admit({ id: "closing-window", build: "fixture", metaVersion: 1, liveness: { pid: process.pid, socket } });',
    ' process.on("message", message => { owner.effect(member.lease, 0, () => { process.send({ locked: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, message.hold); }); });',
    ' process.send({ ready: true });',
    '})().catch(e => { console.error(e); process.exit(1); });'
  ].join('\n'), { mode: 0o600 });
  const child = fork(script, [root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stderr.on('data', (s) => { output += s; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const next = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('ISOLATED_SOURCE_TIMEOUT: ' + output)), 10000);
    child.once('message', (value) => { clearTimeout(timer); resolve(value); });
  });
  try {
    await next();
    const owner = createOwner({ root, profile: 'liveness', install: 'fixture' });
    const member = await owner.admit({ id: 'surviving-window', build: 'fixture', metaVersion: 1 });
    const shortLock = next(); child.send({ hold: 180 }); await shortLock;
    const started = Date.now();
    let effect = false; owner.effect(member.lease, 0, () => { effect = true; });
    check('a second window waits for a short shared lock instead of dropping its send/save', effect && Date.now() - started >= 80);
    let nested = 0; owner.effect(member.lease, 0, () => { owner.effect(member.lease, 0, () => { nested++; }); });
    checkEqual('command and Memento guards can nest without dropping a write', nested, 1);
    const held = next(); child.send({ hold: 60000 }); await held;
    child.kill('SIGKILL'); checkEqual('only the minted source process is terminated', (await exited).signal, 'SIGKILL');
    const lockFile = owner.file + '.lock', deadClaim = fs.readFileSync(lockFile, 'utf8');
    let saved = false; owner.effect(member.lease, 0, () => { saved = true; });
    check('a real process crash while holding the effect lock recovers automatically', saved);
    fs.writeFileSync(lockFile, deadClaim, { mode: 0o600 });
    const candidate = lockFile + '.' + JSON.parse(deadClaim).token + '.candidate'; fs.linkSync(lockFile, candidate);
    owner.effect(member.lease, 0, () => {});
    check('crash residue between atomic claim publication and unlink is also recoverable', !fs.existsSync(lockFile) && !fs.existsSync(candidate));
    const pruned = await owner.pruneDead();
    checkEqual('a dead process/socket retires its old writer lease', pruned.map((s) => s.id), ['closing-window']);
    const t = await owner.begin({ generation: 0, to: 'service', target: 'service',
      inventory: { complete: true, scope: owner.scope, ids: ['surviving-window'], otherScopes: [] } });
    checkEqual('the next Move is based only on surviving writers', t.sources.map((s) => s.id), ['surviving-window']);
    await owner.abort(t.token, { targetInactive: true, importDiscarded: true, allSourcesReachable: true });
    checkEqual('abort reopens the original generation without editing files', owner.status().admission, 'open');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    fs.rmSync(home, { recursive: true, force: true });
  }
  suite('R13 killed cutover backend lock recovery');
  const f = await require('./helpers/production-cutover').productionFixture();
  const scriptFile = path.join(f.home, 'cutover-child.cjs');
  fs.writeFileSync(scriptFile, `
const path = require('path');
const { privateRoot } = require(${JSON.stringify(require.resolve('../src/daemonPaths'))});
const { acquireRootLock } = require(${JSON.stringify(require.resolve('../src/daemonLock'))});
(async () => {
  const paths = privateRoot(process.argv[2]);
  await acquireRootLock({ ...paths, lock: path.join(paths.root, 'cutover-operation.lock'), socket: path.join(paths.root, 'cutover-operation.sock') });
  process.send({ ready: true }); setInterval(() => {}, 1000);
})().catch(() => process.exit(1));
`, { mode: 0o600 });
  const backend = fork(scriptFile, [f.selection.root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const done = new Promise((resolve) => backend.once('exit', (code, signal) => resolve({ code, signal })));
  const { bounded } = require('../scripts/native-command');
  try {
    await bounded(new Promise((resolve, reject) => { backend.once('message', resolve); backend.once('error', reject); }), 5000);
    backend.kill('SIGKILL'); await bounded(done, 5000);
    const result = await f.coordinator().restore();
    check('a backend killed by timeout/app quit leaves a provably stale operation lock that Restore recovers',
      result.ok && result.stage === 'returned' && !fs.existsSync(path.join(f.selection.root, 'cutover-operation.lock')));
  } finally {
    if (backend.exitCode === null && backend.signalCode === null) { backend.kill('SIGKILL'); await bounded(done, 5000); }
    await f.cleanup();
  }
};

