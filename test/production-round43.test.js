'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto'), assert = require('assert/strict');
const repo = path.resolve(__dirname, '..'), baseline = process.env.NIKUI_R43_BASELINE || repo;
const subject = name => require(path.join(baseline, name));
const native = subject('scripts/native-command.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function caseOf(name, fn) {
  try { await fn(); check(name, true); } catch (error) { checkEqual(name, error.stack || error.message, 'PASS'); }
}
function buildWitness(file, directory) {
  let selected;
  const module = { exports: {} }, fakeProcess = { ...process, exitCode: 0, platform: 'darwin', arch: 'arm64', env: process.env };
  const realNative = require('../scripts/native-command');
  const noNative = { ...realNative, developmentJobExists: () => false, ownedProcesses: () => [],
    cleanupCustodyJobs: async () => [], quitOwnedProcesses: async () => ({ absent: true }),
    command: () => { throw Error('NATIVE_COMMAND_TRAPPED'); } };
  vm.runInNewContext(fs.readFileSync(path.join(baseline, file), 'utf8'), { module, process: fakeProcess,
    __dirname: path.join(repo, 'scripts'), Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === './build-mac-engine' || name === './build-mac-app') return { BASE: directory, LABEL: 'com.nikui.engine.development',
        build(options) { selected = options; throw Error('BUILD_CAPTURED_BEFORE_NATIVE_EFFECTS'); } };
      if (name === './native-command') return noNative;
      if (name === 'child_process') return { spawnSync: () => ({ status: 113, stderr: 'Could not find service "com.nikui.engine.development"' }),
        spawn: () => { throw Error('NATIVE_SPAWN_TRAPPED'); } };
      if (name === '../src/engineOwner') return { ...require('../src/engineOwner'), atomicJson() {} };
      return require(require.resolve(name, { paths: [path.join(repo, 'scripts')] }));
    }
  });
  return { async run() { await module.exports.main({ quiet: true }); return selected; } };
}
module.exports = async () => {
  suite('R43 removal cleanup survives stopped or crash-looping startup');
  await caseOf('stopped/crash-looping own registration removes without running-registration proof', async () => {
    const calls = []; let loaded = true;
    const result = await native.cleanupDevelopmentJob({ attempted: true, exists: () => loaded,
      bootout: () => { throw Error('Unregister should suffice'); }, controller(action) {
        calls.push(action);
        if (action === 'build-identity') return { flavour: 'dev', label: 'com.nikui.engine.development' };
        if (action === 'validate-registration') throw Error('SERVICE_BUNDLE_MISMATCH');
        if (action === 'unregister') loaded = false;
        return action === 'status' ? { control: null } : { ok: true };
      } });
    assert(result.absent); assert(calls.includes('unregister')); assert(!calls.includes('intentional-stop'));
  });
  await caseOf('a failed initial proof still reaches bundle-bound unregister and absence verification', async () => {
    const calls = []; let loaded = true, error;
    try { await native.cleanupDevelopmentJob({ attempted: true, exists: () => { calls.push(loaded ? 'job:present' : 'job:absent'); return loaded; },
      bootout: () => { throw Error('Unexpected fallback'); }, controller(action) {
        calls.push(action);
        if (action === 'build-identity') return { flavour: 'dev', label: 'com.nikui.engine.development' };
        if (['validate-registration', 'validate-removal'].includes(action)) throw Error('TRANSIENT_VALIDATION_FAILURE');
        if (action === 'unregister') loaded = false;
        return {};
      } }); } catch (e) { error = e; }
    assert(error?.diagnostics?.absent); assert.equal(error.diagnostics.failures.length, 1);
    assert(calls.lastIndexOf('job:absent') > calls.indexOf('unregister'), 'Absence must be observed after unregister');
  });
  await caseOf('failed unregister falls back only after fresh own-removal proof and verifies job absence', async () => {
    const calls = []; let loaded = true, clock = 0, error;
    try { await native.cleanupDevelopmentJob({ attempted: true, exists: () => loaded, now: () => clock,
      pause: async ms => { clock += ms; }, timeoutMs: 200,
      bootout() { calls.push('bootout'); assert.equal(calls.at(-2), 'validate-removal'); loaded = false; }, controller(action) {
        calls.push(action);
        if (action === 'build-identity') return { flavour: 'dev', label: 'com.nikui.engine.development' };
        if (action === 'unregister') throw Error('SM_REPLY_FAILED');
        return {};
      } }); } catch (e) { error = e; }
    assert.equal(error?.code, 'NATIVE_DEVELOPMENT_CLEANUP_FAILED'); assert(error.diagnostics.absent);
    assert.deepEqual(error.diagnostics.failures.map(e => e.stage), ['unregister']); assert(calls.includes('bootout'));
  });
  await caseOf('foreign running package refuses both unregister and fallback without any signal', async () => {
    let signals = 0, clock = 0, error;
    try { await native.cleanupDevelopmentJob({ attempted: true, exists: () => true, now: () => clock,
      pause: async ms => { clock += ms; }, timeoutMs: 200, bootout: () => { signals++; }, controller(action) {
        if (action === 'build-identity') return { flavour: 'dev', label: 'com.nikui.engine.development' };
        if (['validate-registration', 'validate-removal', 'unregister'].includes(action)) throw Error('SERVICE_BUNDLE_MISMATCH');
        if (action === 'intentional-stop') signals++;
        return {};
      } }); } catch (e) { error = e; }
    assert(error); assert.equal(signals, 0);
  });
  suite('R43 native gates compile the declared current app build');
  for (const file of ['scripts/test-mac-engine.js', 'scripts/test-mac-cutover.js']) await caseOf(file + ' uses current shared build metadata before any native action', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync('/tmp/r43-build-'));
    try {
      const selected = await buildWitness(file, directory).run();
      assert.equal(selected.version, require('../package.json').macApp.version);
      assert.equal(selected.buildNumber, require('../package.json').macApp.buildNumber);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('ordinary prod and dev build plans use the same current app version and build', async () => {
    for (const flavour of ['prod', 'dev']) {
      const plan = subject('scripts/build-mac-app.js').buildPlan({ flavour });
      assert.equal(plan.version, require('../package.json').macApp.version);
      assert.equal(plan.buildNumber, require('../package.json').macApp.buildNumber);
    }
  });
  suite('R43 collection preserves engine and custodian paths through macOS aliases');
  for (const evidence of ['argv', 'open-file']) await caseOf(evidence + ' through /tmp protects a running engine/custodian node and closure in /private/tmp', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync('/tmp/r43-gc-'));
    try {
      const files = ['node', 'script'].map(kind => {
        const bytes = Buffer.from('running ' + kind), hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const file = path.join(directory, (kind === 'node' ? 'custody-node-' : 'custody-') + hash.slice(0, 24) + (kind === 'node' ? '' : '.js'));
        fs.writeFileSync(file, bytes, { mode: kind === 'node' ? 0o700 : 0o600 }); return file;
      });
      const aliases = files.map(file => file.replace(/^\/private\/tmp\//, '/tmp/'));
      const result = subject('src/keeperSupervisor.js').collectPrograms(directory, { loadedJob: null, processRun: file =>
        file === '/bin/ps' ? (evidence === 'argv' ? '123 ' + aliases.join(' ') + '\n' : '123 /unrelated\n') :
          evidence === 'open-file' ? 'p123\n' + aliases.map(file => 'n' + file).join('\n') + '\n' : '' });
      assert(files.every(file => fs.existsSync(file)), JSON.stringify(result));
      assert.equal(result.removed.length, 0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  suite('R43 rescue timeout root-cause witness: a returning app view can wake a stopped source');
  await caseOf('a reconnecting controlling observer can start a second replacement after a confirmed Stop', async () => {
    const f = await require('./production-round27.test').keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    let session, hub;
    async function wait(fn) { const end = Date.now() + 5000; while (!fn()) { assert(Date.now() < end); await pause(20); } }
    try {
      const transfer = await require('../src/keeperContinuity').releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const returned = f.service(transfer); session = f.session(returned);
      assert.equal(await returned.attach(session), true); const original = session.proc.pid;
      session.restart(); await wait(() => session.proc?.pid && session.proc.pid !== original);
      f.pids.add(session.proc.pid); f.pids.add(session.proc.link.keeperPid);
      const first = session.proc; session.stop(); await wait(() => first.exitCode !== null || first.signalCode !== null);
      hub = new (require('../src/hub').SessionHub)(session, { fleet: () => [session] });
      hub.attach({ id: 'returning-app', post() {} }, { id: 'app', kind: 'device', control: true });
      await hub.receive('returning-app', { type: 'ready' });
      await wait(() => session.proc?.pid && session.proc.pid !== first.pid);
      f.pids.add(session.proc.pid); f.pids.add(session.proc.link.keeperPid);
      await wait(() => f.log().filter(row => row.event === 'start').length === 3);
      assert.equal(f.log().filter(row => row.event === 'start').length, 3);
      assert.equal(f.log().filter(row => row.type === 'user').length, 1);
    } finally { hub?.dispose(); session?.stop(); await f.close(); }
  });
};
