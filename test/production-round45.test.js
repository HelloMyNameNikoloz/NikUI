'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), net = require('net'), crypto = require('crypto'), assert = require('assert/strict');
const { createRequire } = require('module');
const repo = path.resolve(__dirname, '..'), baseline = process.env.NIKUI_R45_BASELINE || repo;
const subject = name => require(path.join(baseline, name));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const temp = () => fs.realpathSync(fs.mkdtempSync('/tmp/r45-'));
const atomic = require('../src/engineOwner').atomicJson;
async function caseOf(name, fn) {
  try { await fn(); check(name, true); } catch (error) { checkEqual(name, error.stack || error.message, 'PASS'); }
}
function supervisor({ fault, events = [], codeSign = () => true } = {}) {
  const file = path.join(baseline, 'src/keeperSupervisor.js'), local = createRequire(file), module = { exports: {} };
  const fakeFS = { ...fs, openSync(file, ...args) {
    if (fault === 'ENOSPC' && /\.tmp$/.test(file)) throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
    return fs.openSync(file, ...args);
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, __dirname: path.dirname(file), Buffer, setTimeout, clearTimeout,
    process: { ...process, platform: 'darwin', versions: { ...process.versions, electron: undefined } },
    require(name) {
      if (name === 'fs') return fakeFS;
      if (name === 'child_process') return { ...require('child_process'), execFileSync(file, args) {
        events.push(path.basename(file));
        if (file === '/usr/bin/otool') {
          if (fault === 'ETIMEDOUT') throw Object.assign(Error('otool timeout'), { code: 'ETIMEDOUT' });
          return 'node:\n\t/usr/lib/libSystem.B.dylib\n';
        }
        if (file === '/usr/bin/codesign') {
          assert(args.includes('--verify') && args.includes('--strict'));
          assert(args.includes('=anchor apple generic and certificate leaf[subject.OU] = "KBA6653B4V"'));
          if (!codeSign(args.at(-1))) throw Error('unsigned or foreign-team runtime');
          return '';
        }
        if (args[0] === '--version') return 'v26.7.0\n';
        throw Error('UNEXPECTED_NATIVE_EXECUTION: ' + file);
      } };
      return local(name);
    }
  });
  return module.exports;
}
function sealed(directory, kind, bytes) {
  const file = path.join(directory, (kind === 'node' ? 'custody-node-' : 'custody-') + sha(bytes).slice(0, 24) + (kind === 'node' ? '' : '.js'));
  fs.writeFileSync(file, bytes, { mode: kind === 'node' ? 0o700 : 0o600 }); return file;
}
function program(directory, sup) {
  const nodeBytes = Buffer.from('trusted old standalone Node'), scriptBytes = Buffer.from('old held custody closure');
  const saved = { version: 1, node: sealed(directory, 'node', nodeBytes), nodeHash: sha(nodeBytes),
    script: sealed(directory, 'script', scriptBytes), scriptHash: sha(scriptBytes), launcher: sup.launcher, launcherHash: sha(sup.launcher) };
  atomic(path.join(directory, 'r1-program.json'), saved); return saved;
}
function jobText(directory, sup, saved) {
  return 'job = {\n\tpath = ' + sup.jobFor(directory).file + '\n\tprogram = /bin/sh\n\targuments = {\n' +
    sup.argumentsFor(directory, saved).map(arg => '\t\t' + arg).join('\n') + '\n\t}\n\tpid = ' + process.pid + '\n}\n';
}
const unused = file => file === '/bin/ps' ? '123 /usr/bin/unrelated\n' : '';
module.exports = async () => {
  suite('R45 usable loaded custody survives failed update staging');
  for (const fault of ['ENOENT', 'ENOSPC', 'ETIMEDOUT', 'HASH_MISMATCH']) await caseOf(fault + ' stages only after verified custody and never writes terminal failure', async () => {
    const directory = temp(), events = [], sup = supervisor({ fault, events });
    try {
      const saved = program(directory, sup), interpreter = path.join(directory, 'new-node'); fs.writeFileSync(interpreter, 'new standalone Node');
      if (fault === 'HASH_MISMATCH') {
        const target = sealed(directory, 'node', fs.readFileSync(interpreter)); fs.appendFileSync(target, 'tampered');
      }
      const run = async args => { events.push(args[0]); assert(['print', 'kickstart'].includes(args[0])); return jobText(directory, sup, saved); };
      const result = await sup.supervise(directory, { interpreter, sourceDirectory: fault === 'ENOENT' ? path.join(directory, 'missing') : path.join(repo, 'src'),
        run, ready: async () => { events.push('ready'); }, processRun: unused });
      assert.equal(result.label, sup.jobFor(directory).label); assert.equal(events[0], 'print');
      assert(events.indexOf('ready') < events.indexOf('otool')); assert(!fs.existsSync(sup.failureFor(directory)));
      assert.equal(sup.savedProgram(directory).script, saved.script);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('a healthy loaded custodian takes precedence over an old terminal staging failure', async () => {
    const directory = temp(), sup = supervisor();
    try {
      const saved = program(directory, sup); sup.writeFailure(directory, 'KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING');
      await sup.supervise(directory, { interpreter: '/missing-new-build', run: async args => {
        assert(['print', 'kickstart'].includes(args[0])); return jobText(directory, sup, saved);
      }, ready: async () => {}, processRun: unused });
      assert.equal(sup.savedProgram(directory).node, saved.node);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('failed staging without any verified custodian still records a terminal failure', async () => {
    const directory = temp(), sup = supervisor();
    try {
      await assert.rejects(sup.supervise(directory, { interpreter: '/missing-node', run: async () => {
        throw Object.assign(Error('absent'), { code: 113, stderr: 'Could not find service "' + sup.jobFor(directory).label + '"' });
      } }), error => error.code === 'KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING');
      assert.equal(sup.startupFailure(directory).terminal, true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  suite('R45 recorded custody provenance is not self-certifying');
  for (const tamper of ['node', 'launcher']) await caseOf('self-hashed foreign ' + tamper + ' is refused before kickstart', async () => {
    const directory = temp(), sup = supervisor({ codeSign: file => fs.readFileSync(file, 'utf8') === 'trusted old standalone Node' });
    try {
      const saved = program(directory, sup);
      if (tamper === 'node') { const bytes = Buffer.from('unsigned attacker runtime'); saved.node = sealed(directory, 'node', bytes); saved.nodeHash = sha(bytes); }
      else { saved.launcher = 'exec /bin/sh -c arbitrary-command'; saved.launcherHash = sha(saved.launcher); }
      atomic(path.join(directory, 'r1-program.json'), saved);
      assert.throws(() => sup.savedProgram(directory), error => error.code === 'KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED');
      await assert.rejects(sup.supervise(directory, { interpreter: '/missing-new-build', run: async args => {
        assert.equal(args[0], 'print'); return jobText(directory, sup, saved);
      }, ready: async () => {}, processRun: unused }), error => error.code === 'KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  suite('R45 live custody acknowledgment precedes startup-failure diagnostics');
  await caseOf('reused custody can warm its endpoint before an obsolete terminal failure is honored', async () => {
    const directory = temp(), sup = subject('src/keeperSupervisor.js'); let reads = 0;
    const server = net.createServer(socket => socket.once('data', () => socket.end(JSON.stringify(++reads === 1 ? { ok: false } :
      { ok: true, custodyVersion: 1, pid: process.pid, runs: [], unverified: [], adopting: [] }) + '\n')));
    try {
      sup.writeFailure(directory, 'KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(directory, 'r1.sock'), resolve); });
      fs.chmodSync(path.join(directory, 'r1.sock'), 0o600);
      const saved = program(directory, sup);
      await sup.waitForReady(directory, async () => jobText(directory, sup, saved), false, true);
      assert.equal(reads, 2);
    } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  for (const hold of [false, true]) await caseOf((hold ? 'held' : 'ordinary') + ' add reaches a live custodian despite an old staging failure', async () => {
    const directory = temp(), rescue = subject('src/keeperRescue.js'), sup = subject('src/keeperSupervisor.js');
    const sockets = new Set(); let adds = 0;
    const server = net.createServer(socket => { sockets.add(socket); socket.once('data', data => {
      const request = JSON.parse(data); assert.equal(request.op, 'add'); adds++;
      const response = JSON.stringify({ ok: true, custodyVersion: 1, pid: process.pid, runs: [] }) + '\n';
      if (request.hold) socket.write(response); else socket.end(response);
    }); });
    let registrations = [], statuses = [];
    try {
      sup.writeFailure(directory, 'KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(rescue.socketFor(directory), resolve); });
      fs.chmodSync(rescue.socketFor(directory), 0o600);
      await rescue.protectReleased({ transferred: [{ legacy: {}, directory, runId: 'held-run', key: 'chat', pid: process.pid }] }, hold ? { registrations } : { statuses });
      assert.equal(adds, 1); assert.equal(hold ? registrations.length : statuses.length, 1);
    } finally {
      for (const socket of [...registrations, ...sockets]) socket.destroy();
      await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  suite('R45 garbage collection accepts real lsof fields and protects durable references');
  await caseOf('captured p/f/n output keeps the open file and collects an unrelated obsolete copy with -w', async () => {
    const directory = temp(), sup = subject('src/keeperSupervisor.js');
    try {
      const open = sealed(directory, 'script', 'open closure'), unusedFile = sealed(directory, 'node', 'unused runtime');
      const captured = fs.readFileSync(path.join(__dirname, 'fixtures/keepers/lsof-open-fields.txt'), 'utf8');
      const result = sup.collectPrograms(directory, { loadedJob: null, processRun(file, args) {
        if (file === '/bin/ps') return unused(file);
        assert(args.includes('-w')); return captured.replace(/^n.*$/m, 'n' + open);
      } });
      assert(fs.existsSync(open)); assert(!fs.existsSync(unusedFile)); assert(result.removed.includes(unusedFile));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('the current program record and independently loaded argv protect both copies without caller keep hints', async () => {
    const directory = temp(), sup = subject('src/keeperSupervisor.js');
    try {
      const recorded = { node: sealed(directory, 'node', 'recorded runtime'), script: sealed(directory, 'script', 'recorded closure') };
      atomic(path.join(directory, 'r1-program.json'), recorded);
      const loaded = { node: sealed(directory, 'node', 'loaded runtime'), script: sealed(directory, 'script', 'loaded closure') };
      const obsolete = sealed(directory, 'script', 'obsolete closure'); let inspected = false;
      const result = sup.collectPrograms(directory, { processRun(file) {
        if (file === '/bin/launchctl') { inspected = true; return jobText(directory, sup, { ...loaded, launcher: sup.launcher }); }
        return unused(file);
      } });
      assert(inspected); for (const file of [...Object.values(recorded), ...Object.values(loaded)]) assert(fs.existsSync(file));
      assert(result.removed.includes(obsolete));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('a custodian appearing between two absent snapshots retains its newly published program record', async () => {
    const directory = temp(), sup = subject('src/keeperSupervisor.js');
    try {
      const saved = program(directory, sup); let snapshots = 0;
      const result = await sup.removeJob(directory, { emptyProven: true, processRun: unused, run: async args => {
        assert.equal(args[0], 'print');
        if (++snapshots === 1) throw Object.assign(Error('absent'), { code: 113, stderr: 'Could not find service "' + sup.jobFor(directory).label + '"' });
        return jobText(directory, sup, saved);
      } });
      assert.equal(result.retained, true); assert(fs.existsSync(path.join(directory, 'r1-program.json')));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  suite('R45 stale dev cleanup requires removal of both job and registration');
  await caseOf('no launchd job still unregisters the own enabled BTM record and verifies final status', async () => {
    let state = 'enabled'; const calls = [];
    const result = await subject('scripts/native-command.js').cleanupDevelopmentJob({ attempted: true, exists: () => false, controller(action) {
      calls.push(action);
      if (action === 'build-identity') return { flavour: 'dev', label: 'com.nikui.engine.development' };
      if (action === 'unregister') state = 'notRegistered';
      return { registration: state };
    } });
    assert.deepEqual(calls, ['build-identity', 'unregister', 'status']); assert(result.absent); assert.equal(state, 'notRegistered');
  });
  await caseOf('an enabled record after unregister is a cleanup failure even with no job', async () => {
    await assert.rejects(subject('scripts/native-command.js').cleanupDevelopmentJob({ attempted: true, exists: () => false, controller(action) {
      return action === 'build-identity' ? { flavour: 'dev', label: 'com.nikui.engine.development' } : { registration: 'enabled' };
    } }), error => error.code === 'NATIVE_DEVELOPMENT_CLEANUP_FAILED');
  });
  suite('R45 idle package preflight imports the real composition without acquiring selected resources');
  await caseOf('idle preflight checks compiled package and imports composition without starting it or touching the profile', async () => {
    const file = path.join(baseline, 'src/macPreflight.js'), module = { exports: {} }, calls = [];
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, __dirname: '/Signed.app/Contents/Resources/engine/src', process: { ...process, argv: ['node', file, '--root', '/selected'] },
      require(name) {
        if (name === 'fs') return { readFileSync: () => '{}', realpathSync: value => value };
        if (name === 'path' || name === 'os') return require(name);
        if (name === './macBuildIdentity') return { flavour: 'prod' };
        if (name === './macFlavour') return { validatePackage() { calls.push('validate'); return { appID: 'com.nikui.app', label: 'com.nikui.engine' }; } };
        if (name === './productionRuntime') { calls.push('import'); return { startProductionRuntime() { throw Error('MUST_NOT_START'); } }; }
        throw Error('SELECTED_RESOURCE_ACCESS: ' + name);
      }
    });
    const reply = module.exports.preflight(); assert.equal(reply.mode, 'idle-preflight'); assert.equal(reply.label, 'com.nikui.engine');
    assert.deepEqual(calls, ['validate', 'import']);
  });
};
