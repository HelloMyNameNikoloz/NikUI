'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict');
const { spawn } = require('child_process');
const repo = path.resolve(__dirname, '..');
const subject = require(path.join(process.env.NIKUI_R41_BASELINE || repo, 'src/keeperSupervisor'));
const old = require('../src/keeperSupervisor');
const rescue = require('../src/keeperRescue'), { controlRequest } = require('../src/daemonControl');
const runtime = '/private/tmp/nik-mac/build/p3/final/NikUI Dev.app/Contents/Resources/engine/node';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const temp = () => fs.realpathSync(fs.mkdtempSync('/tmp/r41-'));
async function wait(fn, ms = 7000) {
  const end = Date.now() + ms;
  do { if (await fn()) return; await pause(25); } while (Date.now() < end);
  throw Error('R41_WAIT_TIMEOUT');
}
async function stop(child) {
  if (child?.exitCode === null && child.signalCode === null)
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
}
async function caseOf(name, fn) {
  if (process.env.NIKUI_TEST_PROGRESS === '1') console.error(name);
  try { await fn(); check(name, true); } catch (error) { checkEqual(name, error.stack || error.message, 'PASS'); }
}
function printJob(directory, program, pid) {
  // Captured R39 launchctl formatting, including the multiline shell argument.
  return 'job = {\n\tpath = ' + subject.jobFor(directory).file + '\n\tprogram = /bin/sh\n\targuments = {\n' +
    old.argumentsFor(directory, program).map(arg => '\t\t' + arg).join('\n') + '\n\t}\n\tpid = ' + pid + '\n}\n';
}
function launchd(directory, program, pid = process.pid) {
  let loaded = true; const calls = [];
  const run = async args => {
    calls.push(args);
    if (args[0] === 'print') {
      if (!loaded) throw Object.assign(Error('absent'), { code: 113, stderr: 'Could not find service "' + subject.jobFor(directory).label + '"' });
      return printJob(directory, program, pid);
    }
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'bootstrap') loaded = true;
    return '';
  };
  return { run, calls };
}
const unused = (file) => file === '/bin/ps' ? '123 /usr/bin/unrelated\n' : '';
function orphan(directory, kind, text) {
  const bytes = Buffer.from(text), file = path.join(directory, (kind === 'node' ? 'custody-node-' : 'custody-') + sha(bytes).slice(0, 24) + (kind === 'node' ? '' : '.js'));
  fs.writeFileSync(file, bytes, { mode: kind === 'node' ? 0o700 : 0o600 }); return file;
}
function previousProgram(directory) {
  const staged = old.stage(directory, { interpreter: runtime });
  const bytes = Buffer.concat([fs.readFileSync(staged.script), Buffer.from('\n// previous compatible build\n')]);
  const program = { ...staged, scriptHash: sha(bytes), script: path.join(directory, 'custody-' + sha(bytes).slice(0, 24) + '.js') };
  fs.writeFileSync(program.script, bytes, { mode: 0o600 });
  delete program.launcher; delete program.launcherHash; // Real R37/R39 record shape.
  require('../src/engineOwner').atomicJson(path.join(directory, 'r1-program.json'), program);
  return program;
}
module.exports = async () => {
  suite('R41 app updates keep the existing verified custodian and original live turn');
  await caseOf('build N custody survives Restore and a complete build N+1 Move, with the same child and drivable run', async () => {
    const f = await require('./production-round27.test').keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    const app = await require('./helpers/production-cutover').productionFixture();
    const originalSupervise = rescue.supervise; let child, current;
    try {
      const program = previousProgram(f.source.dir);
      child = spawn(program.node, [program.script, f.source.dir], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
      const status = () => controlRequest({ socket: rescue.socketFor(f.source.dir) }, { op: 'status' });
      await wait(async () => { try { return (await status()).pid === child.pid; } catch (_) { return false; } });
      const job = launchd(f.source.dir, program, child.pid);
      rescue.supervise = directory => old.waitForReady(directory, job.run);
      const first = await require('../src/keeperContinuity').releaseKeeper(f.source, [f.original], { snapshot: f.snapshot });
      await f.source.close(); const pid = first.transferred[0].pid;
      const editor = f.service(first), session = f.session(editor); assert.equal(await editor.attach(session), true);
      assert.equal(session.proc.pid, pid); // Restore still drives build N custody.
      current = directory => subject.supervise(directory, { interpreter: runtime, run: job.run, processRun: unused });
      rescue.supervise = current;
      const slot = await require('./production-round29.test').sourceAdapters(app, { keeper: editor, keeperSnapshot: f.snapshot });
      const live = slot.engine.manager.create({ id: session.id, cwd: session.cwd, autoStart: false });
      live.hydrate(session.snapshot()); live.proc = session.proc; session.proc = null;
      live.proc.session = live; live._wire(live.proc); slot.engine.manager.persist(); slot.engine.flush();
      const coordinator = app.coordinator({ prepareCustody: current });
      const review = await coordinator.review(); assert(review.ready, JSON.stringify(review.blockers)); await coordinator.move(review);
      const factory = options => options.legacy ? new (require('../src/legacyKeeper').LegacyKeeper)({ ...options, processSnapshot: f.snapshot }) : new (require('../src/daemonKeeper').DaemonKeeper)(options);
      const engine = await app.start({ keeperFactory: factory }); await coordinator.finish();
      const moved = engine.engine.manager.get(live.id);
      assert.equal(moved.proc?.pid, pid); assert.equal((await status()).pid, child.pid);
      moved.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'upgrade-interrupt', request: { subtype: 'interrupt' } }) + '\n');
      await wait(() => f.log().some(row => row.type === 'control_request'));
      assert.equal(f.log().filter(row => row.event === 'start').length, 1);
      assert.equal(f.log().filter(row => row.type === 'user').length, 1);
      assert(!job.calls.some(args => ['bootout', 'bootstrap'].includes(args[0])));
      assert.equal(subject.savedProgram(f.source.dir).script, program.script);
    } finally { rescue.supervise = originalSupervise; await app.cleanup(); await stop(child); await f.close(); }
  });
  for (const tamper of ['script', 'node', 'launcher-record', 'launcher-job']) await caseOf(tamper + ' tampering refuses a loaded old program without replacing its held custody', async () => {
    const directory = temp();
    try {
      const program = subject.stage(directory, { interpreter: runtime }), job = launchd(directory, program);
      fs.writeFileSync(subject.jobFor(directory).file, subject.jobPlist(directory, program), { mode: 0o600 });
      require('../src/engineOwner').atomicJson(path.join(directory, 'r1-state.json'), { version: 1, proofs: [{ runId: 'held' }] });
      if (tamper === 'script' || tamper === 'node') fs.appendFileSync(program[tamper], 'changed');
      else if (tamper === 'launcher-record') {
        const record = JSON.parse(fs.readFileSync(path.join(directory, 'r1-program.json')));
        record.launcher = 'echo tampered\n' + (record.launcher || old.launcher);
        require('../src/engineOwner').atomicJson(path.join(directory, 'r1-program.json'), record);
      } else {
        const original = job.run;
        job.run = async args => args[0] === 'print' ? (await original(args)).replace('umask 077', 'umask 000') : original(args);
      }
      await assert.rejects(subject.supervise(directory, { interpreter: runtime, run: job.run, ready: async () => {}, processRun: unused }),
        error => /KEEPER_RESCUE_SUPERVISION_(PROGRAM_CHANGED|UPGRADE_BLOCKED)/.test(error.code));
      assert(!job.calls.some(args => ['bootout', 'bootstrap'].includes(args[0])));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  suite('R41 sealed-file collection needs complete process evidence');
  await caseOf('Move collects stale copies while preserving both loaded build N and staged build N+1', async () => {
    const directory = temp();
    try {
      const loaded = previousProgram(directory);
      const next = subject.stage(directory, { interpreter: runtime, publish: false });
      const obsolete = [orphan(directory, 'node', 'obsolete node'), orphan(directory, 'script', 'obsolete script')];
      const job = launchd(directory, loaded);
      await subject.supervise(directory, { interpreter: runtime, run: job.run, ready: async () => {}, processRun: unused });
      for (const file of obsolete) assert(!fs.existsSync(file), 'Unused hashed file retained: ' + file);
      for (const file of [loaded.node, loaded.script, next.node, next.script]) assert(fs.existsSync(file));
      assert.equal(subject.savedProgram(directory).script, loaded.script);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  for (const evidence of ['argv', 'mapped', 'ps-denied', 'lsof-denied']) await caseOf(evidence + ' prevents deletion of a possibly used sealed file', async () => {
    const directory = temp();
    try {
      const program = subject.stage(directory, { interpreter: runtime }), job = launchd(directory, program);
      const files = [orphan(directory, 'node', 'active node'), orphan(directory, 'script', 'active script')];
      const processRun = file => {
        if (evidence === 'ps-denied' && file === '/bin/ps' || evidence === 'lsof-denied' && file !== '/bin/ps') throw Error('OS evidence denied');
        if (file === '/bin/ps') return evidence === 'argv' ? '123 ' + files.join(' ') + '\n' : unused(file);
        return evidence === 'mapped' ? 'p123\n' + files.map(name => 'n' + name).join('\n') + '\n' : '';
      };
      await subject.supervise(directory, { interpreter: runtime, run: job.run, ready: async () => {}, processRun });
      assert(files.every(file => fs.existsSync(file)));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('an editor reusing the old runtime preserves newer app copies it cannot identify', async () => {
    const directory = temp(), electron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    try {
      const program = previousProgram(directory), job = launchd(directory, program);
      const next = old.stage(directory, { interpreter: runtime, publish: false });
      Object.defineProperty(process.versions, 'electron', { configurable: true, value: 'fixture' });
      await subject.supervise(directory, { run: job.run, ready: async () => {}, processRun: unused });
      for (const file of [program.node, program.script, next.node, next.script]) assert(fs.existsSync(file));
    } finally {
      if (electron) Object.defineProperty(process.versions, 'electron', electron); else delete process.versions.electron;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await caseOf('empty retirement removes its record and unused sealed files only after launchd absence', async () => {
    const directory = temp();
    try {
      const program = subject.stage(directory, { interpreter: runtime }), job = launchd(directory, program);
      fs.writeFileSync(subject.jobFor(directory).file, subject.jobPlist(directory, program), { mode: 0o600 });
      const result = await subject.removeJob(directory, { run: job.run, emptyProven: true, processRun: file => {
        assert(job.calls.some(args => args[0] === 'bootout')); return unused(file);
      } });
      assert(result.removed); assert(!fs.existsSync(path.join(directory, 'r1-program.json')));
      assert(!fs.existsSync(program.node)); assert(!fs.existsSync(program.script));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
};
