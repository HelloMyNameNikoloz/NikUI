#!/usr/bin/env node
'use strict';
// native: pending Claude run. Only this freshly minted DEV keeper/job is used.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const { keeperFixture } = require('../test/production-round27.test');
const { releaseKeeper, processSnapshot, sameProcess } = require('../src/keeperContinuity');
const rescue = require('../src/keeperRescue');
const { command, runNative, cleanupCustodyJobs, quitOwnedProcesses, failureEvidence } = require('./native-command');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function wait(test, ms = 10000) {
  const end = Date.now() + ms;
  do { if (await test()) return; await pause(50); } while (Date.now() < end);
  throw Error('NATIVE_CUSTODY_UPGRADE_TIMEOUT');
}
async function main() {
  const base = '/private/tmp/nik-mac/build/p3';
  const round = require('../package.json').macApp.buildNumber;
  const previous = JSON.parse(fs.readFileSync('/tmp/nik-mac/p3/r' + round + '-preservation.json')).final;
  const oldEngine = path.join(previous, 'NikUI Dev.app/Contents/Resources/engine');
  const newEngine = path.join(base, 'final/NikUI Dev.app/Contents/Resources/engine');
  const old = require(path.join(oldEngine, 'src/keeperSupervisor')), current = require(path.join(newEngine, 'src/keeperSupervisor'));
  const builds = { before: JSON.parse(fs.readFileSync(path.join(oldEngine, 'build-manifest.json'))).buildNumber,
    after: JSON.parse(fs.readFileSync(path.join(newEngine, 'build-manifest.json'))).buildNumber };
  assert.notEqual(builds.before, builds.after);
  const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js', { prefix: path.join(base, 'r' + round + '-upgrade-'), graceMs: 15000 });
  const report = { ok: false, native: true, builds, cleanupRoots: [f.dir], custodyDirectories: [f.source.dir], checks: {}, cleanup: [] };
  const original = rescue.supervise, facts = await processSnapshot([...f.pids]); let active;
  const log = (stage, details = {}) => console.error(JSON.stringify({ gate: 'custody-upgrade-held', stage, ...details }));
  const inventory = [];
  report.gc = { inventory };
  try {
    rescue.supervise = directory => old.supervise(directory, { interpreter: path.join(oldEngine, 'node'), sourceDirectory: path.join(oldEngine, 'src') });
    const first = await releaseKeeper(f.source, [f.original], { snapshot: processSnapshot }); await f.source.close();
    const proof = first.transferred[0], before = await rescue.rescueRequest(proof, 'status');
    const editor = f.service(first), session = f.session(editor);
    for (const link of editor.links) if (link.processSnapshot) link.processSnapshot = processSnapshot;
    assert.equal(await editor.attach(session), true); assert.equal(session.proc.pid, proof.pid);
    report.checks.buildNMoveAndRestore = true;
    const prepared = directory => current.supervise(directory, { interpreter: path.join(newEngine, 'node'), sourceDirectory: path.join(newEngine, 'src') });
    await prepared(f.source.dir); rescue.supervise = prepared;
    const next = await releaseKeeper(editor, [session], { snapshot: processSnapshot }); await editor.close();
    const engine = f.service(next), moved = f.session(engine);
    for (const link of engine.links) if (link.processSnapshot) link.processSnapshot = processSnapshot;
    assert.equal(await engine.attach(moved), true); assert.equal(moved.proc.pid, proof.pid);
    const after = await rescue.rescueRequest(proof, 'status'); assert.equal(after.pid, before.pid);
    moved.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'native-upgrade', request: { subtype: 'interrupt' } }) + '\n');
    await wait(() => f.log().some(row => row.type === 'control_request'));
    assert.equal(f.log().filter(row => row.type === 'user').length, 1); assert.equal(f.log().filter(row => row.event === 'start').length, 1);
    report.checks.buildNPlusOneMoveStillDrivesOriginalRun = true;
    const recorded = current.savedProgram(f.source.dir), bytes = fs.readFileSync(recorded.script);
    try {
      fs.appendFileSync(recorded.script, '\n// fixture tamper\n');
      await assert.rejects(prepared(f.source.dir), { code: 'KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED' });
    } finally { fs.writeFileSync(recorded.script, bytes, { mode: 0o600 }); }
    const recordFile = path.join(f.source.dir, 'r1-program.json'), recordBytes = fs.readFileSync(recordFile);
    try {
      require('../src/engineOwner').atomicJson(recordFile, { ...recorded, launcher: 'changed\n' + recorded.launcher });
      await assert.rejects(prepared(f.source.dir), { code: 'KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED' });
    } finally { fs.writeFileSync(recordFile, recordBytes, { mode: 0o600 }); }
    assert.equal((await rescue.rescueRequest(proof, 'status')).pid, before.pid);
    report.checks.tamperedProgramAndLauncherRefusedWithoutLosingCustody = true;
    const compiled = path.join(f.dir, 'gc-active');
    command('/usr/bin/xcrun', ['clang', '-target', 'arm64-apple-macos14.0',
      path.join(__dirname, '../test/fixtures/keepers/gc-active.c'), '-o', compiled]);
    const activeFile = path.join(f.source.dir, 'custody-node-' + sha(fs.readFileSync(compiled)).slice(0, 24));
    fs.renameSync(compiled, activeFile); fs.chmodSync(activeFile, 0o700);
    const unusedBytes = 'R49 obsolete unheld closure', unusedFile = path.join(f.source.dir, 'custody-' + sha(unusedBytes).slice(0, 24) + '.js');
    active = spawn(activeFile, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    active.stdout.on('data', bytes => { output += bytes; }); active.stderr.on('data', bytes => { stderr += bytes; });
    active.on('exit', (code, signal) => { report.gc.exit = { code, signal }; log('active fixture exited', { code, signal }); });
    await new Promise((resolve, reject) => { active.once('spawn', resolve); active.once('error', reject); });
    await wait(() => {
      if (active.exitCode !== null || active.signalCode !== null)
        throw Object.assign(Error('The active fixture exited before readiness'), { diagnostics: { code: active.exitCode, signal: active.signalCode, output, stderr } });
      return output === 'ready\n';
    });
    const activeFacts = (await processSnapshot([active.pid])).get(active.pid);
    assert(activeFacts, 'The ready fixture must have an OS process identity');
    report.gc.active = { file: activeFile, ...activeFacts }; log('active fixture ready', report.gc.active);
    const staged = current.stage(f.source.dir, { interpreter: path.join(newEngine, 'node'), sourceDirectory: path.join(newEngine, 'src'), publish: false });
    await pause(0); // Drain child exit events after synchronous staging.
    assert(sameProcess(activeFacts, (await processSnapshot([active.pid])).get(active.pid)), 'The fixture must still be running immediately before GC');
    fs.writeFileSync(unusedFile, unusedBytes, { mode: 0o600 });
    const processRun = (file, args, options) => {
      const result = spawnSync(file, args, options);
      inventory.push({ command: [file, ...args], status: result.status, spawnError: result.error?.code,
        stdout: file === '/bin/ps' ? String(result.stdout || '').split('\n').filter(line => line.includes(activeFile) || line.includes(String(active.pid))).join('\n') : result.stdout,
        stderr: result.stderr });
      if (result.error || String(result.stderr || '').trim() || result.status !== 0 && !(file === '/usr/sbin/lsof' && result.status === 1))
        throw Error('Incomplete custody fixture inventory');
      return result.stdout;
    };
    const loadedJob = command('/bin/launchctl', ['print', `gui/${process.getuid()}/${current.jobFor(f.source.dir).label}`]);
    report.gc.whileRunning = current.collectPrograms(f.source.dir, { keep: [recorded, staged], loadedJob, processRun });
    log('collection while running', report.gc.whileRunning);
    assert(fs.existsSync(activeFile), JSON.stringify(report.gc));
    assert(report.gc.whileRunning.skipped.includes(activeFile), 'Inventory must explicitly protect the active candidate');
    assert(report.gc.whileRunning.removed.includes(unusedFile), 'Mixed lsof output must not skip the unused candidate');
    assert(inventory.some(row => row.command[0] === '/usr/sbin/lsof' && row.status === 1 && row.stdout.includes(activeFile) && !row.stderr));
    report.checks.mixedLsofOutputProtectsActiveAndCollectsUnused = true;
    assert(sameProcess(activeFacts, (await processSnapshot([active.pid])).get(active.pid)), 'GC must leave the same active process running');
    await new Promise(resolve => { active.once('exit', resolve); active.stdin.end(); });
    assert.equal(active.exitCode, 0);
    report.collection = current.collectPrograms(f.source.dir, { keep: [recorded, staged], loadedJob, processRun });
    log('collection after exit', report.collection);
    assert(!fs.existsSync(activeFile)); assert(fs.existsSync(recorded.node)); assert(fs.existsSync(recorded.script));
    report.checks.collectOnlyAfterTheUsingProcessExits = true;
    report.custodianPID = before.pid; report.originalChildPID = proof.pid;
    report.registration = command('/bin/launchctl', ['print', `gui/${process.getuid()}/${current.jobFor(f.source.dir).label}`]);
    moved.stop(); await wait(() => { try { process.kill(proof.pid, 0); return false; } catch (_) { return true; } });
    await wait(() => {
      try { command('/bin/launchctl', ['print', `gui/${process.getuid()}/${current.jobFor(f.source.dir).label}`]); return false; }
      catch (error) { return error.status === 113 && String(error.stderr).includes('Could not find service'); }
    });
    await wait(() => { try { process.kill(before.pid, 0); return false; } catch (_) { return true; } });
    await current.removeJob(f.source.dir, { emptyProven: true });
    assert(!fs.readdirSync(f.source.dir).some(name => /^custody-(?:node-)?[a-f0-9]{24}(?:\.js)?$/.test(name)));
    report.checks.emptyRetirementCollectsSealedCopies = true;
    report.ok = true;
  } catch (error) {
    report.failure = { ...failureEvidence(error), stack: error.stack };
    log('failed', { failure: report.failure, gc: report.gc });
  }
  finally {
    rescue.supervise = original;
    if (active?.exitCode === null && active.signalCode === null)
      await new Promise(resolve => { active.once('exit', resolve); active.kill('SIGTERM'); });
    for (const link of f.links) await link.close();
    try { report.cleanup.push({ jobs: await cleanupCustodyJobs([f.source.dir], [f.dir]) }); }
    catch (error) { report.ok = false; report.cleanup.push({ failure: failureEvidence(error) }); }
    const live = await processSnapshot([...f.pids]);
    for (const pid of f.pids) if (sameProcess(facts.get(pid), live.get(pid))) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    f.pids.clear(); await f.close();
    report.cleanup.push({ processes: await quitOwnedProcesses([f.dir]) });
  }
  return report;
}
if (require.main === module) void runNative(main);
module.exports = { main };
