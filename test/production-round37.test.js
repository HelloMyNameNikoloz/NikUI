'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), net = require('net');
const { spawn } = require('child_process');
const rescue = require('../src/keeperRescue'), supervisor = require('../src/keeperSupervisor');
const { keeperFixture } = require('./production-round27.test');
const { releaseKeeper, captureKeeper } = require('../src/keeperContinuity');
const { atomicJson } = require('../src/engineOwner');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const temp = () => fs.realpathSync(fs.mkdtempSync('/tmp/r37-'));
const runtime = '/private/tmp/nik-mac/build/p3/final/NikUI Dev.app/Contents/Resources/engine/node';
async function wait(test, ms = 7000) {
  const end = Date.now() + ms;
  do { if (await test()) return; await pause(25); } while (Date.now() < end);
  throw Error('R37_WAIT_TIMEOUT');
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); });
}
async function caseOf(name, fn) {
  if (process.env.NIKUI_TEST_PROGRESS === '1') console.error(name);
  try { await fn(); check(name, true); } catch (error) { checkEqual(name, error.stack || error.message, 'PASS'); }
}
const proofFor = (directory, id = 'run') => ({ directory, key: id, runId: id, pid: process.pid, keeperPID: process.pid,
  meta: { instance: id, cwd: directory, conversation: null } });
function fakeKeeper(rows, { delay = 0, never = false } = {}) {
  const pending = new Set();
  return { socket: {}, keeperPid: process.pid, held: new Map(), requests: [], _dispatch() {},
    async connect() { return true; }, send() { return true; },
    request(msg, timeout) {
      this.requests.push(msg.t);
      if (msg.t === 'attach') { const row = rows.find((r) => r.runId === msg.runId); row.owned = true; return Promise.resolve({ ok: true, runId: row.runId, pid: row.pid }); }
      return new Promise((resolve) => {
        let timer, deadline;
        const finish = (reply) => { clearTimeout(timer); clearTimeout(deadline); pending.delete(cancel); resolve(reply); };
        const cancel = () => finish({ ok: false, message: 'keeper gone' }); pending.add(cancel);
        if (!never) timer = setTimeout(() => finish({ runs: structuredClone(rows) }), delay);
        if (timeout) deadline = setTimeout(() => finish({ ok: false, message: 'no answer' }), timeout);
      });
    },
    async close() { for (const cancel of [...pending]) cancel(); }
  };
}
module.exports = async () => {
  suite('R37 immutable self-contained custody');
  for (const mutation of ['delete', 'modify']) await caseOf('Move, ' + mutation + ' the entire source closure, SIGKILL, restart and adopt the same run', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js'); let child;
    try {
      const sourceDirectory = path.join(f.dir, 'checkout/src'); fs.mkdirSync(path.dirname(sourceDirectory));
      fs.cpSync(path.join(__dirname, '../src'), sourceDirectory, { recursive: true });
      fs.cpSync(path.join(__dirname, '../media'), path.join(f.dir, 'checkout/media'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(f.dir, 'checkout/package.json'));
      const sealed = supervisor.stage(f.source.dir, { interpreter: runtime, sourceDirectory });
      assert.equal(fs.statSync(sealed.script).mode & 0o777, 0o600); assert.equal(fs.statSync(sealed.node).mode & 0o777, 0o700);
      const start = async () => {
        child = spawn(sealed.node, [sealed.script, f.source.dir], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
        await wait(async () => { try { return (await require('../src/daemonControl').controlRequest({ socket: rescue.socketFor(f.source.dir) }, { op: 'status' })).pid === child.pid; } catch (_) { return false; } });
      };
      await start(); const transfer = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const proof = transfer.transferred[0], before = child.pid;
      if (mutation === 'delete') fs.rmSync(path.dirname(sourceDirectory), { recursive: true });
      else for (const name of fs.readdirSync(sourceDirectory)) if (name.endsWith('.js')) fs.writeFileSync(path.join(sourceDirectory, name), 'throw Error("checkout changed");');
      await stop(child); await start();
      await wait(async () => (await rescue.rescueRequest(proof, 'status')).held.includes(proof.runId));
      assert.notEqual(child.pid, before); assert(alive(proof.pid));
      const engine = f.service(transfer), session = f.session(engine); assert.equal(await engine.attach(session), true);
      assert.equal(session.proc.pid, proof.pid); session.stop(); await wait(() => !alive(proof.pid));
      assert.equal(f.log().filter((r) => r.event === 'start').length, 1);
      assert.equal(f.log().filter((r) => r.type === 'user').length, 1);
    } finally { await stop(child); await f.close(); }
  });
  await caseOf('a mutable Homebrew/Electron runtime cannot be sealed as standalone Node', async () => {
    const directory = temp();
    try {
      if (process.platform === 'darwin' && process.execPath !== runtime) assert.throws(() => supervisor.stage(directory), { code: 'KEEPER_RESCUE_SUPERVISION_RUNTIME_REQUIRED' });
      const sealed = supervisor.stage(directory, { interpreter: runtime });
      fs.appendFileSync(sealed.script, '\nchanged');
      assert.throws(() => supervisor.savedProgram(directory), { code: 'KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED' });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('a different loaded program is replaced only after empty custody is independently proved', async () => {
    const directory = temp(), calls = [], sealed = supervisor.stage(directory, { interpreter: runtime });
    const job = supervisor.jobFor(directory); let loaded = true;
    const run = async (args) => {
      calls.push(args[0]);
      if (args[0] === 'print') {
        if (!loaded) throw Object.assign(Error('absent'), { code: 113, stderr: 'Could not find service "' + job.label + '"' });
        return 'job {\n path = ' + job.file + '\n program = /old/node\n}';
      }
      if (args[0] === 'bootout') loaded = false;
      if (args[0] === 'bootstrap') loaded = true;
      return '';
    };
    try {
      fs.writeFileSync(job.file, supervisor.jobPlist(directory, sealed), { mode: 0o600 });
      atomicJson(rescue.stateFor(directory), { version: 1, proofs: [proofFor(directory)] });
      await assert.rejects(() => supervisor.supervise(directory, { interpreter: runtime, run }), { code: 'KEEPER_RESCUE_SUPERVISION_UPGRADE_BLOCKED' });
      assert(!calls.includes('bootout'));
      atomicJson(rescue.stateFor(directory), { version: 1, proofs: [] });
      await supervisor.supervise(directory, { interpreter: runtime, ready: async () => {}, run });
      assert(calls.indexOf('bootout') < calls.indexOf('bootstrap'));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('a compatible endpoint without a matching job cannot make Move release its original owner', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js'); let server, loaded = false;
    const calls = [], job = supervisor.jobFor(f.source.dir);
    try {
      server = await rescue.serveRescue(f.source.dir);
      await assert.rejects(() => supervisor.supervise(f.source.dir, { interpreter: runtime, run: async (args) => {
        calls.push(args[0]);
        if (args[0] === 'bootstrap') loaded = true;
        if (args[0] === 'print') {
          if (!loaded) throw Object.assign(Error('absent'), { code: 113, stderr: 'Could not find service "' + job.label + '"' });
          return 'job {\n path = ' + job.file + '\n}';
        }
        return '';
      } }), { code: 'KEEPER_RESCUE_SUPERVISION_ENDPOINT_BUSY' });
      assert(!calls.includes('bootstrap')); assert(!calls.includes('bootout'));
      assert(f.original.proc && !f.original.proc.released && alive(f.original.proc.pid));
      assert.equal(supervisor.startupFailure(f.source.dir).terminal, true);
    } finally { await server?.close(); await f.close(); }
  });
  await caseOf('readiness binds the endpoint PID to launchd and refuses a different compatible process', async () => {
    const directory = temp(), job = supervisor.jobFor(directory); let server;
    try {
      server = await rescue.serveRescue(directory, { factory: () => fakeKeeper([]) });
      const print = (pid) => async () => 'job {\n path = ' + job.file + '\n pid = ' + pid + '\n}';
      await supervisor.waitForReady(directory, print(process.pid));
      await assert.rejects(() => supervisor.waitForReady(directory, print(process.pid + 1)), { code: 'KEEPER_RESCUE_SUPERVISION_ENDPOINT_BUSY' });
    } finally { await server?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  suite('R37 bounded startup failure with a visible retained diagnostic');
  for (const cause of ['missing-script', 'missing-node', 'missing-directory', 'non-private-directory']) await caseOf(cause + ': OS preflight stops after one failed attempt', async () => {
    const root = temp(), directory = path.join(root, 'custody'); fs.mkdirSync(directory, { mode: 0o700 }); let child;
    try {
      const fake = path.join(root, 'launchctl'), events = path.join(root, 'bootout');
      fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "' + events + '"\n', { mode: 0o700 });
      const program = { node: process.execPath, script: path.join(root, 'exists.js') }; fs.writeFileSync(program.script, '');
      if (cause === 'missing-script') fs.unlinkSync(program.script);
      if (cause === 'missing-node') program.node = path.join(root, 'missing-node');
      if (cause === 'missing-directory') fs.rmdirSync(directory);
      if (cause === 'non-private-directory') fs.chmodSync(directory, 0o755);
      const args = supervisor.argumentsFor(directory, program);
      // All effects are trapped in this test's fake launchctl. No real job is
      // ever inspected, bootstrapped or booted out by a portable test.
      args[2] = args[2].replace('/bin/launchctl bootout', '"' + fake + '" bootout');
      child = spawn(args[0], args.slice(1), { stdio: 'ignore', detached: true });
      await wait(() => fs.existsSync(events)); await pause(80);
      assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').length, 1); assert(alive(child.pid));
      if (cause.startsWith('missing-') && cause !== 'missing-directory') assert.equal(supervisor.startupFailure(directory).terminal, true);
      else await assert.rejects(() => supervisor.supervise(directory, { interpreter: runtime, run: async () => { throw Error('No launchctl should be called'); } }));
      assert.match(supervisor.jobPlist(root, program), /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
      assert.match(supervisor.jobPlist(root, program), /<key>SuccessfulExit<\/key><false\/>/);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve)); process.kill(-child.pid, 'SIGKILL'); await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  for (const cause of ['invalid-proof', 'occupied-endpoint']) await caseOf(cause + ': Node startup preserves proof and self-bootouts exactly once', async () => {
    const directory = temp(), originalCommand = supervisor.command, previousLabel = process.env.NIKUI_CUSTODY_JOB_LABEL;
    let endpoint, parked; const calls = [];
    try {
      if (cause === 'invalid-proof') atomicJson(rescue.stateFor(directory), { version: 99, proofs: [proofFor(directory)] });
      else {
        endpoint = net.createServer((socket) => { socket.resume(); socket.end('incompatible\n'); });
        await new Promise((resolve) => endpoint.listen(rescue.socketFor(directory), resolve)); fs.chmodSync(rescue.socketFor(directory), 0o600);
      }
      const before = fs.existsSync(rescue.stateFor(directory)) && fs.readFileSync(rescue.stateFor(directory));
      supervisor.command = async (args) => { calls.push(args); return ''; };
      process.env.NIKUI_CUSTODY_JOB_LABEL = supervisor.jobFor(directory).label;
      parked = await rescue.startRescue(directory); await pause(60);
      assert.equal(calls.length, 1); assert.equal(calls[0][0], 'bootout');
      assert.equal(supervisor.startupFailure(directory).terminal, true);
      if (before) assert(fs.readFileSync(rescue.stateFor(directory)).equals(before));
      await assert.rejects(() => rescue.protectReleased({ transferred: [{ ...proofFor(directory), legacy: { keeper: { pid: process.pid } } }] }), /./);
    } finally {
      clearInterval(parked); supervisor.command = originalCommand;
      if (previousLabel === undefined) delete process.env.NIKUI_CUSTODY_JOB_LABEL; else process.env.NIKUI_CUSTODY_JOB_LABEL = previousLabel;
      if (endpoint) await new Promise((resolve) => endpoint.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  suite('R37 keeper timeouts cannot erase unverified runs');
  await Promise.all([3000, 10000, Infinity].map((delay) => caseOf('restart with keeper answering ' + (delay === Infinity ? 'never' : 'after ' + delay + 'ms') + ' retains proof and custody recovery', async () => {
    const directory = temp(), proof = proofFor(directory), rows = [{ ...proof, exit: null, owned: false }];
    const backend = fakeKeeper(rows, { delay, never: !Number.isFinite(delay) }); let server;
    try {
      atomicJson(rescue.stateFor(directory), { version: 1, proofs: [proof] });
      server = await rescue.serveRescue(directory, { factory: () => backend });
      if (Number.isFinite(delay)) { await wait(() => server.held.has(proof.runId), delay + 1600); assert.equal(backend.requests.filter((t) => t === 'attach').length, 1); }
      else { await pause(12500); assert(server.records.has(proof.runId), 'An unanswered listing cannot erase its proof'); assert.equal(backend.requests.filter((t) => t === 'list').length, 1); assert(fs.existsSync(rescue.socketFor(directory))); }
      assert.equal(server.records.size, 1);
      assert.equal(JSON.parse(fs.readFileSync(rescue.stateFor(directory))).proofs[0].runId, proof.runId);
    } finally { await server?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  })));
  await caseOf('one changed/invalid proof cannot discard or prevent adoption of the other run', async () => {
    const directory = temp(), good = proofFor(directory, 'good'), bad = proofFor(directory, 'bad'); let server;
    const backend = fakeKeeper([{ ...bad, pid: process.pid + 1, owned: false, exit: null }, { ...good, owned: false, exit: null }]);
    try {
      atomicJson(rescue.stateFor(directory), { version: 1, proofs: [bad, good, { runId: 'invalid' }] });
      server = await rescue.serveRescue(directory, { factory: () => backend, retryMs: 20 });
      await wait(() => server.held.has('good')); assert.equal(server.records.size, 3);
      const status = await require('../src/daemonControl').controlRequest({ socket: rescue.socketFor(directory) }, { op: 'status' });
      assert(status.blocker.startsWith('KEEPER_RESCUE_SUPERVISION_')); assert(status.unverified.includes('bad'));
      assert.equal(JSON.parse(fs.readFileSync(rescue.stateFor(directory))).proofs.length, 3);
    } finally { await server?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('only a successfully verified foreign owner can prune a live proof', async () => {
    const directory = temp(), proof = proofFor(directory); let server;
    const backend = fakeKeeper([{ ...proof, owned: true, exit: null }]);
    try {
      atomicJson(rescue.stateFor(directory), { version: 1, proofs: [proof] });
      server = await rescue.serveRescue(directory, { factory: () => backend });
      await wait(() => server.records.size === 0); assert.equal(backend.requests.filter((t) => t === 'attach').length, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(rescue.stateFor(directory))).proofs, []);
    } finally { await server?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('a repaired row clears its incident blocker without replacing any other connection or proof', async () => {
    const directory = temp(), proof = proofFor(directory), rows = [{ ...proof, pid: process.pid + 1, owned: false, exit: null }]; let server;
    const backend = fakeKeeper(rows);
    try {
      atomicJson(rescue.stateFor(directory), { version: 1, proofs: [proof] });
      server = await rescue.serveRescue(directory, { factory: () => backend });
      await wait(() => supervisor.startupFailure(directory)?.code === 'KEEPER_RESCUE_SUPERVISION_PROCESS_CHANGED');
      const originalSocket = backend.socket; rows[0].pid = process.pid; await server.check();
      assert(server.held.has(proof.runId)); assert.equal(backend.socket, originalSocket);
      assert.equal(supervisor.startupFailure(directory), null);
      assert.equal(JSON.parse(fs.readFileSync(rescue.stateFor(directory))).proofs.length, 1);
    } finally { await server?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('an old foreign-owner observation cannot prune a proof after the latest keeper check times out', async () => {
    const directory = temp(), proof = proofFor(directory), rows = [{ ...proof, owned: true, exit: null }]; let server, failing = false;
    const backend = fakeKeeper(rows), request = backend.request.bind(backend);
    backend.request = (message, timeout) => failing && message.t === 'list' ? Promise.resolve({ ok: false, message: 'no answer' }) : request(message, timeout);
    try {
      server = await rescue.serveRescue(directory, { factory: () => backend, retryMs: 20 });
      await require('../src/daemonControl').controlRequest({ socket: rescue.socketFor(directory) }, { op: 'add', proofs: [proof] });
      failing = true; rows[0].owned = false;
      await assert.rejects(() => server.check(), { code: 'KEEPER_UNAVAILABLE' });
      await pause(1300); assert(server.records.has(proof.runId), 'A previous owner observation is no longer proof after a failed check');
      assert.equal(JSON.parse(fs.readFileSync(rescue.stateFor(directory))).proofs.length, 1);
      failing = false; await server.check(); assert(server.held.has(proof.runId));
    } finally { await server?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  suite('R37 drain, Restore and fixture retirement');
  await caseOf('a persistence failure retains the original socket beyond orphan grace and still permits Stop', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js', { graceMs: 800 }); let server;
    try {
      server = await rescue.serveRescue(f.source.dir);
      const transfer = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const proof = transfer.transferred[0], engine = f.service(transfer), session = f.session(engine);
      assert.equal(await engine.attach(session), true);
      fs.chmodSync(f.source.dir, 0o500);
      const record = server.records.get(proof.runId);
      const link = session.proc.link;
      link.send({ t: 'checkpoint', runId: proof.runId, snapshot: {}, meta: { ...record.proof.meta, conversation: 'changed-checkpoint' } });
      await wait(async () => (await rescue.rescueRequest(proof, 'status')).blocker === 'KEEPER_RESCUE_SUPERVISION_STATE_UNAVAILABLE');
      await pause(1100); assert(alive(proof.pid)); assert(server.held.has(proof.runId));
      fs.chmodSync(f.source.dir, 0o700);
      const job = supervisor.jobFor(f.source.dir), print = async () => 'job {\n path = ' + job.file + '\n pid = ' + process.pid + '\n}';
      await assert.rejects(() => supervisor.waitForReady(f.source.dir, print), { code: 'KEEPER_RESCUE_SUPERVISION_STATE_UNAVAILABLE' });
      await supervisor.waitForReady(f.source.dir, print, true);
      assert(!(await rescue.rescueRequest(proof, 'status')).blocker);
      assert.equal(session.proc.pid, proof.pid); assert(server.held.has(proof.runId));
      session.stop(); await wait(() => !alive(proof.pid)); await wait(() => server.closed);
    } finally { fs.chmodSync(f.source.dir, 0o700); await server?.close(); await f.close(); }
  });
  await caseOf('state write failure cannot prevent a confirmed final exit from closing custody', async () => {
    const directory = temp(), proof = proofFor(directory); let server;
    const backend = fakeKeeper([{ ...proof, owned: false, exit: null }]);
    try {
      atomicJson(rescue.stateFor(directory), { version: 1, proofs: [proof] });
      server = await rescue.serveRescue(directory, { factory: () => backend }); await wait(() => server.held.has('run'));
      fs.rmSync(directory, { recursive: true });
      backend._dispatch({ t: 'exit', runId: 'run', exit: { code: 0 } });
      await wait(() => server.closed); assert.equal(server.records.size, 0);
    } finally { await server?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('drained jobs remove their plist and wait for asynchronous bootout; uncertain runs prevent removal', async () => {
    const directory = temp(), job = supervisor.jobFor(directory), calls = []; let polls = 0, booting = false;
    const run = async (args) => {
      calls.push(args[0]);
      if (args[0] === 'bootout') { booting = true; return ''; }
      if (booting && ++polls > 2) throw Object.assign(Error('absent'), { code: 113, stderr: 'Could not find service "' + job.label + '"' });
      return 'job {\n path = ' + job.file + '\n}';
    };
    try {
      fs.writeFileSync(job.file, 'fixture', { mode: 0o600 }); atomicJson(rescue.stateFor(directory), { version: 1, proofs: [proofFor(directory)] });
      assert.equal((await supervisor.removeJob(directory, { run })).retained, true); assert(!calls.includes('bootout'));
      atomicJson(rescue.stateFor(directory), { version: 1, proofs: [] });
      assert.equal((await supervisor.removeJob(directory, { run })).removed, true); assert(polls >= 3); assert(!fs.existsSync(job.file));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('native cleanup waits through launchd teardown instead of failing after its first print', async () => {
    const root = '/private/tmp/nik-mac/build/p3', directory = fs.mkdtempSync(root + '/r37-cleanup-');
    const job = supervisor.jobFor(directory); let booting = false, polls = 0;
    try {
      fs.writeFileSync(job.file, 'fixture', { mode: 0o600 });
      const result = await require('../scripts/native-command').cleanupCustodyJobs([directory], [root], (_file, args) => {
        if (args[0] === 'bootout') { booting = true; return ''; }
        if (booting && ++polls > 2) throw Object.assign(Error('absent'), { status: 113, stderr: 'Could not find service "' + job.label + '"' });
        return 'job {\n path = ' + job.file + '\n}';
      });
      assert(result[0].absent); assert(polls >= 3); assert(!fs.existsSync(job.file));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('native cleanup accepts product retirement between plist removal and launchd job disappearance', async () => {
    const root = '/private/tmp/nik-mac/build/p3', directory = fs.mkdtempSync(root + '/r37-retiring-');
    const job = supervisor.jobFor(directory); let polls = 0;
    try {
      const result = await require('../scripts/native-command').cleanupCustodyJobs([directory], [root], (_file, args) => {
        assert.equal(args[0], 'print', 'No bootout is allowed without a plist');
        if (++polls > 3) throw Object.assign(Error('absent'), { status: 113, stderr: 'Could not find service "' + job.label + '"' });
        return 'job {\n path = ' + job.file + '\n}';
      });
      assert(result[0].absent && result[0].retired); assert.equal(result[0].wasRegistered, false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('app Move prepares the standalone runtime before any release; Restore revisits the selected custodian', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js'), app = await require('./helpers/production-cutover').productionFixture(); let runtime;
    const prepared = [], retired = [];
    try {
      const slot = await require('./production-round29.test').sourceAdapters(app, { keeper: f.source, keeperSnapshot: f.snapshot });
      const original = f.original, target = slot.engine.manager.create({ id: original.id, cwd: original.cwd, autoStart: false });
      target.hydrate(original.snapshot()); target.proc = original.proc; original.proc = null;
      target.proc.session = target; target._wire(target.proc); slot.engine.manager.persist(); slot.engine.flush();
      const coordinator = app.coordinator({ prepareCustody: async (directory, options) => {
        assert(f.original.proc || (await captureKeeper(f.source, app.slots[0].engine.manager.list, { snapshot: f.snapshot })).transferred.length);
        prepared.push(directory);
        if (options?.repair) fs.unlinkSync(supervisor.failureFor(directory));
      }, retireCustody: async (directory) => { retired.push(directory); return { retained: true }; } });
      supervisor.writeFailure(f.source.dir, 'KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING');
      for (let i = 0; i < 2; i++) assert((await coordinator.review()).blockers.includes('KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING'));
      assert.deepEqual(prepared, []);
      await coordinator.repairCustody({ profile: app.profile });
      const review = await coordinator.review(); assert(review.ready, JSON.stringify(review.blockers)); await coordinator.move(review);
      assert.deepEqual(prepared, [f.source.dir, f.source.dir]);
      runtime = await app.start({ keeperFactory: (o) => o.legacy ? new (require('../src/legacyKeeper').LegacyKeeper)({ ...o, processSnapshot: f.snapshot }) : new (require('../src/daemonKeeper').DaemonKeeper)(o) });
      await coordinator.finish(); await coordinator.restore(); assert(retired.includes(f.source.dir));
    } finally { await runtime?.stop(); await app.cleanup(); await f.close(); }
  });
  await caseOf('the editor Restore parser accepts captured SMAppService format only with exact process evidence', async () => {
    const selected = { app: '/private/tmp/copy/NikUI.app', root: '/private/tmp/home/engine', label: 'com.nikui.engine' };
    const job = 'path = (submitted by smd.41692)\ntype = Submitted\nmanaged_by = com.apple.xpc.ServiceManagement\nstate = running\nprogram identifier = Contents/MacOS/nikd (mode: 2)\nparent bundle identifier = com.nikui.app\nparent bundle version = 35\npid = 42\n';
    const matches = require('../src/localCutoverRestore').matchesJob;
    const command = selected.app + '/Contents/Resources/engine/node ' + selected.app + '/Contents/Resources/engine/src/macEngine.js --root ' + selected.root;
    assert(await matches(job, selected, async () => new Map([[42, { command }]])));
    assert(!await matches(job, selected, async () => new Map([[42, { command: '/foreign/node' }]])));
    assert(!await matches(job.replace('pid = 42\n', ''), selected, async () => new Map()));
  });
  await caseOf('editor Restore proves a live engine before stopping it and preserves an unproved stopped registration', async () => {
    for (const startsRunning of [true, false]) {
      let running = startsRunning; const events = [], moduleObject = { exports: {} };
      const selected = { version: 1, app: '/fixture/NikUI.app', root: '/fixture/root', home: '/fixture/home',
        helper: '/fixture/cutover-recovery/NikKeychain.app', label: 'com.nikui.engine', profile: 'profile', install: 'install' };
      const command = selected.app + '/Contents/Resources/engine/node ' + selected.app + '/Contents/Resources/engine/src/macEngine.js --root ' + selected.root;
      const imports = { path, child_process: { spawnSync() { throw Error('Unexpected real native call'); } },
        './daemonPaths': { readPrivateJson: () => selected, fail: (code) => Object.assign(Error(code), { code }) },
        './daemonControl': { controlRequest: async () => { events.push('stop'); running = false; } },
        './keeperContinuity': { processSnapshot: async () => new Map(running ? [[42, { command }]] : []) },
        './productionCutover': { createProductionCutover: () => ({ saved: () => ({ profile: selected.profile, install: selected.install }),
          restore: async () => { events.push('handback'); return { ok: true }; } }) }
      };
      require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../src/localCutoverRestore.js'), 'utf8'), {
        module: moduleObject, process: { getuid: () => 501 }, require: (name) => { assert(name in imports, 'Unexpected native I/O: ' + name); return imports[name]; }
      });
      const result = await moduleObject.exports.restore('/fixture/recovery.json', { createAdapter: () => ({}), run: (_file, args) => {
        events.push(args[0]);
        if (args[0] === 'bootout') { assert(running, 'Ownership proof must precede Stop'); running = false; return ''; }
        return 'path = (submitted by smd.41692)\ntype = Submitted\nmanaged_by = com.apple.xpc.ServiceManagement\n' +
          'program identifier = Contents/MacOS/nikd (mode: 2)\nparent bundle identifier = com.nikui.app\n' +
          'state = ' + (running ? 'running\npid = 42\n' : 'not running\n');
      } });
      assert(result.ok);
      if (startsRunning) { assert(events.indexOf('bootout') < events.indexOf('stop')); assert(!result.registrationRetained); }
      else { assert(result.registrationRetained); assert(!events.includes('bootout')); }
    }
  });
  await caseOf('the native custody gate visits all five builds and confines source deletion, jobs and signals to its fixtures', async () => {
    const events = [], killed = [], builds = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((b) => [b, {}]));
    let buildIndex = 0, current, samples = 0, statuses = 0;
    const identity = (pid, born) => ({ pid, started: born, command: 'fixture-' + pid });
    async function snapshot() {
      samples++;
      return new Map([[1001, identity(1001, 'keeper')], [1002, identity(1002, samples === 1 ? 'child' : 'reused')]]);
    }
    const mockedRescue = { supervise() {}, rescueRequest: async () => ({ pid: ++statuses === 1 ? 2001 : 2002, held: ['run'] }) };
    const imports = {
      fs: { mkdirSync() {}, cpSync() {}, copyFileSync() {}, rmSync(file) { assert(file.startsWith(current.dir + '/checkout')); events.push('source-deleted'); } },
      path, 'assert/strict': new Proxy(assert, { get(target, key) { return key === 'deepEqual' ? (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b)) : target[key]; } }),
      '../test/production-round27.test': { keeperFixture: async () => {
        samples = 0; statuses = 0;
        const driver = { async close() { events.push('drivers-closed'); }, processSnapshot() { throw Error('Portable identity must not be used by native'); } };
        current = { dir: '/private/tmp/nik-mac/build/p3/mock-' + buildIndex++, pids: new Set([1001, 1002]), original: {}, log: () => [{ type: 'user' }],
          links: [driver], source: { dir: '', async close() {} },
          service: () => ({ links: [driver], async attach() { assert.equal(driver.processSnapshot, snapshot); return true; } }),
          session: () => ({ proc: { pid: 1002 } }), async close() { assert.equal(this.pids.size, 0); events.push('fixture-closed'); } };
        current.source.dir = current.dir + '/old'; return current;
      } },
      '../src/keeperContinuity': { BUILDS: builds, releaseKeeper: async () => ({ transferred: [{ runId: 'run', pid: 1002 }] }), processSnapshot: snapshot,
        sameProcess: (a, b) => a?.started === b?.started && a?.command === b?.command },
      '../src/keeperRescue': mockedRescue, '../src/daemonPaths': { privateDirectory() {} },
      '../src/keeperSupervisor': { jobFor: () => ({ label: 'fixture-job' }) },
      './native-command': { command: () => 'mock registration', runNative() { throw Error('Must not execute native entry'); },
        failureEvidence: (e) => ({ message: e.message }), cleanupCustodyJobs: async () => { events.push('bootout'); return [{ absent: true }]; },
        quitOwnedProcesses: async () => { events.push('zero-processes'); return { absent: true }; } }
    };
    const moduleObject = { exports: {} }, fakeProcess = { argv: [], getuid: () => 501, kill(pid, signal) { if (signal !== 0) killed.push(pid); } };
    require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/test-legacy-custody-native.js'), 'utf8'), {
      require: (name) => { assert(name in imports, 'Unexpected native I/O: ' + name); return imports[name]; },
      module: moduleObject, __dirname: path.join(__dirname, '../scripts'), process: fakeProcess,
      setTimeout: (fn) => { queueMicrotask(fn); return 1; }
    });
    const report = await moduleObject.exports.main(); assert(report.ok, JSON.stringify(report));
    assert.equal(report.builds.length, 5); assert.equal(events.filter((e) => e === 'source-deleted').length, 5);
    assert.equal(events.filter((e) => e === 'zero-processes').length, 5); assert(killed.includes(1001)); assert(!killed.includes(1002));
    assert(events.indexOf('drivers-closed') < events.indexOf('bootout'));
  });
};
