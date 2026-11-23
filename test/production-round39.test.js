'use strict';
const fs = require('fs'), path = require('path'), net = require('net'), assert = require('assert/strict'), vm = require('vm');
const { spawn } = require('child_process');
const repo = path.resolve(__dirname, '..'), baseline = process.env.NIKUI_R39_BASELINE;
const subject = (name) => require(path.join(baseline || repo, name));
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function caseOf(name, fn) {
  try { await fn(); check(name, true); } catch (error) { checkEqual(name, error.stack || error.message, 'PASS'); }
}
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  do { if (await fn()) return; await pause(20); } while (Date.now() < end);
  throw Error('R39_WAIT_TIMEOUT');
}
async function sourceFixture() {
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/r39-'));
  const context = require('./fixtures/engine/fakes').context();
  context.globalStorageUri = { fsPath: path.join(home, 'storage') };
  context.secrets = new (require('./fixtures/engine/fakes').Secrets)(); context.subscriptions = [];
  require('../src/identity').loadIdentity(context.globalState);
  const bridge = subject('src/legacySource.js');
  const source = bridge.createLegacyActivation(context, { home, install: 'nikoloz.nikui', workspace: home });
  return { home, context, source, bridge, directory: bridge.sourceDirectory(home),
    async close() { source.recoveryUI?.dispose(); await source.dispose(); fs.rmSync(home, { recursive: true, force: true }); } };
}
function packageCode() {
  return fs.readFileSync(path.join(baseline || repo, 'src/macEngine.js'), 'utf8') + '\nmodule.exports.runPackage = runPackage;';
}
function packageVM(startRuntime) {
  const events = new (require('events').EventEmitter)(), exits = [], phases = [];
  events.exit = code => exits.push(code);
  const module = { exports: {} };
  vm.runInNewContext(packageCode(), { module, __dirname: repo + '/src', process: events, require(name) {
    if (name === './productionRuntime') return { startProductionRuntime: startRuntime };
    if (name === './engineOwner') return { atomicJson: (_file, value) => phases.push(value) };
    return require(require.resolve(name, { paths: [repo + '/src'] }));
  } });
  return { events, exits, phases, start: () => module.exports.runPackage({ config: {}, selection: { flavour: 'prod', root: '/fixture' } }) };
}
module.exports = async () => {
  suite('R39 current source review during rescue editor relaunch');
  for (const mode of ['Client', 'Recovery']) await caseOf(mode + ' bridge preserves identity and a transient inventory blocker, then recovers', async () => {
    const f = await sourceFixture(); let settling = true;
    const disposable = () => ({ dispose() {}, show() {}, hide() {} });
    const vscode = { commands: { registerCommand: disposable, executeCommand: async () => {
      if (settling) throw Object.assign(Error('relaunch inventory'), { code: 'SOURCE_MANIFEST_INCOMPLETE' });
      return `CPU %\tMem MB\t PID\tProcess\n0\t0\t${process.pid}\textension-host\n0\t0\t1\twindow [1] (fixture)\n`;
    } }, workspace: { workspaceFolders: [{ uri: { fsPath: f.home } }] },
    window: { createStatusBarItem: disposable, showWarningMessage: async () => {}, createTreeView: disposable } };
    try {
      await subject('src/legacyExtensionSource.js')['listen' + mode](f.source, { context: f.context, vscode,
        runtime: { available: true, fingerprint: 'fixture', fleet: { instances: [], codex: [] }, dispose() {} } });
      const blocked = (await f.bridge.inventory(f.directory))[0];
      assert.equal(blocked.build, f.bridge.SOURCE_BUILD); assert.equal(blocked.review.id, blocked.id);
      assert.equal(blocked.review.version, 1); assert.equal(blocked.review.ready, false);
      assert.deepEqual(blocked.review.blockers, ['SOURCE_MANIFEST_INCOMPLETE']);
      settling = false;
      const ready = (await f.bridge.inventory(f.directory))[0];
      assert(ready.review.ready); assert(ready.review.hostInventory.complete);
    } finally { await f.close(); }
  });
  await caseOf('inventory retains an operation error instead of labelling a current bridge old', async () => {
    const f = await sourceFixture(); let control;
    try {
      fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
      const id = '1'.repeat(16), socket = path.join(f.directory, id + '.sock');
      require('../src/engineOwner').atomicJson(path.join(f.directory, id + '.json'),
        { version: 1, id, socket, nonce: '2'.repeat(32), pid: process.pid, profile: 'fixture', build: f.bridge.SOURCE_BUILD });
      control = await require('../src/daemonControl').createControl({ paths: { socket },
        handle: () => ({ ok: false, code: 'SOURCE_MANIFEST_INCOMPLETE' }) });
      await assert.rejects(f.bridge.inventory(f.directory), { code: 'SOURCE_MANIFEST_INCOMPLETE' });
      assert.deepEqual((await f.bridge.inventory(f.directory, { tolerateUnresponsive: true }))[0].review.blockers, ['SOURCE_MANIFEST_INCOMPLETE']);
    } finally { await control?.dispose(); await f.close(); }
  });
  for (const mismatch of ['id', 'profile', 'version']) await caseOf('inventory still refuses a reply with the wrong ' + mismatch, async () => {
    const f = await sourceFixture(); let control;
    try {
      fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
      const id = '1'.repeat(16), socket = path.join(f.directory, id + '.sock');
      require('../src/engineOwner').atomicJson(path.join(f.directory, id + '.json'),
        { version: 1, id, socket, nonce: '2'.repeat(32), pid: process.pid, profile: 'fixture' });
      control = await require('../src/daemonControl').createControl({ paths: { socket },
        handle: () => ({ ok: true, version: 1, id, profile: 'fixture', [mismatch]: 'wrong' }) });
      await assert.rejects(f.bridge.inventory(f.directory), { code: 'SOURCE_BUILD_OLD' });
    } finally { await control?.dispose(); await f.close(); }
  });
  suite('R39 intentional package stop and independent custody');
  await caseOf('keeper close flushes release and closes a peer that keeps its readable half open', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync('/tmp/r39-sock-')), sockets = []; let received = '';
    const server = net.createServer({ allowHalfOpen: true }, s => { sockets.push(s); s.on('data', b => { received += b; }); });
    const socketPath = path.join(dir, 'k1.sock');
    await new Promise(resolve => server.listen(socketPath, resolve));
    const socket = net.connect(socketPath); await new Promise(resolve => socket.once('connect', resolve));
    const link = new (subject('src/keeperLink.js').KeeperLink)({ dir }); link.socket = socket;
    try {
      link.send({ t: 'release', runId: 'original' }); await link.close();
      await waitFor(() => received.includes('"runId":"original"'));
      assert(socket.destroyed, 'A successful close must not retain the peer read handle');
    } finally { socket.destroy(); for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  for (const duringStartup of [false, true]) await caseOf('package Stop drains once and exits zero ' + (duringStartup ? 'when signalled during startup' : 'after startup'), async () => {
    let release, stopped = 0, complete;
    const drain = new Promise(resolve => { complete = resolve; });
    const ready = new Promise(resolve => { release = resolve; });
    const runtime = { stop: async () => { stopped++; await drain; } };
    const pkg = packageVM(() => ready), started = pkg.start();
    if (duringStartup) pkg.events.emit('SIGTERM');
    release(runtime);
    if (!duringStartup) { await started; pkg.events.emit('SIGTERM'); pkg.events.emit('SIGINT'); }
    await pause(0); assert.equal(stopped, 1); assert.deepEqual(pkg.exits, []);
    complete(); await started; await pause(0);
    assert.deepEqual(pkg.exits, [0]);
  });
  await caseOf('a failed package drain never reports successful intentional exit', async () => {
    const pkg = packageVM(async () => ({ stop: async () => { throw Error('fixture drain failed'); } }));
    await pkg.start(); pkg.events.emit('SIGTERM'); await pause(0);
    assert.deepEqual(pkg.exits, []); assert.equal(pkg.events.exitCode, 1);
  });
  await caseOf('real SIGTERM exits the package after drain despite a remaining peer handle', async () => {
    const script = `const fs=require('fs'),Module=require('module');
      const file=${JSON.stringify(path.join(baseline || repo, 'src/macEngine.js'))};
      const mod=new Module(file);mod.filename=file;mod.paths=Module._nodeModulePaths(${JSON.stringify(repo + '/src')});
      const original=mod.require.bind(mod);mod.require=name=>name==='./productionRuntime'?{startProductionRuntime:async()=>({stop:async()=>{process.send({drained:true});}})}:
        name==='./engineOwner'?{atomicJson(){}}:original(name);
      mod._compile(fs.readFileSync(file,'utf8')+'\\nmodule.exports.runPackage=runPackage;',file);
      setInterval(()=>{},10000);
      mod.exports.runPackage({config:{},selection:{flavour:'prod',root:'/fixture'}}).then(()=>process.send({ready:true}));`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages = []; let stderr = '';
    child.on('message', m => messages.push(m)); child.stderr.on('data', b => { stderr += b; });
    const end = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      await waitFor(() => messages.some(m => m.ready) || child.exitCode !== null); assert.equal(stderr, '');
      child.kill('SIGTERM');
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 1500);
      assert.deepEqual(await end, { code: 0, signal: null }); assert(messages.some(m => m.drained));
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await end; }
  });
  await caseOf('two real package SIGTERMs after rescue/restart preserve the same borrowed child and custodian', async () => {
    const kept = await require('./production-round27.test').keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    const f = await require('./helpers/production-cutover').productionFixture(); let child;
    try {
      const slot = await require('./production-round29.test').sourceAdapters(f, { keeper: kept.source, keeperSnapshot: kept.snapshot });
      const original = kept.original, childPID = original.proc.pid;
      const live = slot.engine.manager.create({ id: original.id, cwd: original.cwd, autoStart: false });
      live.hydrate(original.snapshot()); live.proc = original.proc; original.proc = null;
      live.proc.session = live; live._wire(live.proc); slot.engine.manager.persist(); slot.engine.flush();
      const coordinator = f.coordinator(); await coordinator.move(await coordinator.review());
      const keychain = path.join(kept.dir, 'package-keychain.json'), config = path.join(kept.dir, 'package.json');
      require('../src/engineOwner').atomicJson(keychain, { service: f.adapter.service,
        values: Object.fromEntries([...f.adapter.values].map(([key, bytes]) => [key, bytes.toString('base64')])) });
      require('../src/engineOwner').atomicJson(config, { selection: f.selection, keychain, facts: [...await kept.snapshot([...kept.pids])] });
      const status = () => require('../src/daemonControl').controlRequest({ socket: require('../src/keeperRescue').socketFor(kept.source.dir) }, { op: 'status' });
      const custodianPID = (await status()).pid;
      for (let cycle = 0; cycle < 2; cycle++) {
        const messages = []; let stderr = '';
        child = spawn(process.execPath, [path.join(__dirname, 'fixtures/keepers/package-engine.js'), config],
          { env: { ...process.env, ...(baseline ? { NIKUI_R39_BASELINE: baseline } : {}) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        child.on('message', message => messages.push(message)); child.stderr.on('data', b => { stderr += b; });
        const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
        await waitFor(() => messages.some(m => m.ready) || child.exitCode !== null, 6000);
        assert.equal(stderr, '');
        const ready = messages.find(m => m.ready); assert(ready, stderr);
        assert(ready.status.keeper.runs.some(r => r.childPID === childPID));
        if (!cycle) { await coordinator.finish(); for (const source of f.slots) await f.close(source); }
        child.kill('SIGTERM');
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 6000);
        assert.deepEqual(await exited, { code: 0, signal: null });
        process.kill(childPID, 0); const custody = await status();
        assert.equal(custody.pid, custodianPID); assert(custody.held.includes(live.proc?.runId || ready.status.keeper.runs[0].runID));
      }
      assert.equal(kept.log().filter(event => event.type === 'user').length, 1);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
      await f.cleanup(); await kept.close();
    }
  });
  suite('R39 every native registering gate cleans independently');
  for (const failedStage of ['stop', 'status', 'unregister']) await caseOf(failedStage + ' failure still verifies absence and retains the cleanup error', async () => {
    const cleanup = subject('scripts/native-command.js').cleanupDevelopmentJob;
    assert.equal(typeof cleanup, 'function');
    const calls = []; let exists = true, error;
    const controller = action => {
      calls.push(action);
      if (action === 'build-identity') return { flavour: 'dev', label: 'com.nikui.engine.development' };
      if (action === 'unregister') { exists = false; if (failedStage === action) throw Error('unregister reply lost'); }
      if (action === failedStage || failedStage === 'stop' && action === 'intentional-stop') throw Error('fixture ' + failedStage);
      return action === 'status' ? { control: { pid: 42 } } : { ok: true };
    };
    try { await cleanup({ attempted: true, controller, exists: () => { calls.push(exists ? 'job:present' : 'job:absent'); return exists; }, pause: async () => {} }); }
    catch (e) { error = e; }
    assert.equal(error?.code, 'NATIVE_DEVELOPMENT_CLEANUP_FAILED');
    assert(error.diagnostics.absent); assert.equal(error.diagnostics.failures.length, 1);
    assert(calls.includes('unregister'));
    assert(calls.lastIndexOf('job:absent') > calls.indexOf('unregister'), 'Absence must be observed after unregister');
  });
  await caseOf('native cleanup waits for delayed unregister and reports a persistent job', async () => {
    const cleanup = subject('scripts/native-command.js').cleanupDevelopmentJob;
    assert.equal(typeof cleanup, 'function');
    let unregister = false, polls = 0, now = 0;
    const controller = action => {
      if (action === 'build-identity') return { flavour: 'dev', label: 'com.nikui.engine.development' };
      if (action === 'unregister') unregister = true;
      return {};
    };
    const result = await cleanup({ controller, attempted: true, exists: () => !unregister || ++polls < 4, pause: async () => {} });
    assert(result.absent); assert.equal(polls, 4);
    await assert.rejects(cleanup({ controller, attempted: true, exists: () => true,
      pause: async () => { now += 100; }, now: () => now, timeoutMs: 200 }), e => e.diagnostics.absent === false);
  });
  await caseOf('native cleanup leaves an unattempted or foreign package job untouched', async () => {
    const cleanup = subject('scripts/native-command.js').cleanupDevelopmentJob;
    assert.equal(typeof cleanup, 'function');
    let mutations = 0;
    await cleanup({ attempted: false, controller: () => { mutations++; throw Error('untouched'); } });
    let time = 0;
    await assert.rejects(cleanup({ attempted: true, exists: () => true, now: () => time, pause: async ms => { time += ms; }, timeoutMs: 200,
      bootout: () => { mutations++; }, controller: action => {
      if (action === 'build-identity') return { flavour: 'dev', label: 'com.nikui.engine.development' };
      if (['validate-removal', 'unregister'].includes(action)) throw Error('SERVICE_BUNDLE_MISMATCH');
      mutations++;
    } }), e => e.code === 'NATIVE_DEVELOPMENT_CLEANUP_FAILED' && e.diagnostics.absent === false);
    assert.equal(mutations, 0);
  });
};
