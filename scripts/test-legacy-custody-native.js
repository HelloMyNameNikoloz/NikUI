#!/usr/bin/env node
'use strict';
// native: pending Claude run. Only a newly minted test directory and the
// deterministic job created for that directory are ever inspected/signalled.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { keeperFixture } = require('../test/production-round27.test');
const { BUILDS, releaseKeeper, processSnapshot, sameProcess } = require('../src/keeperContinuity');
const rescue = require('../src/keeperRescue'), { rescueRequest } = rescue;
const { privateDirectory } = require('../src/daemonPaths');
const { runNative, cleanupCustodyJobs, quitOwnedProcesses, failureEvidence, command } = require('./native-command');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
async function main() {
  const base = '/private/tmp/nik-mac/build/p3'; privateDirectory(base);
  const report = { ok: false, native: true, cleanupRoots: [], custodyDirectories: [], builds: [], cleanup: [] };
  const originalSupervise = rescue.supervise;
  try {
    for (const build of Object.keys(BUILDS)) {
      const f = await keeperFixture(build, 'never-exiting-claude.js', { graceMs: 15000, prefix: path.join(base, 'custody-') });
      report.cleanupRoots.push(f.dir); report.custodyDirectories.push(f.source.dir);
      const facts = await processSnapshot([...f.pids]);
      try {
        const checkout = path.join(f.dir, 'checkout'), sourceDirectory = path.join(checkout, 'src');
        fs.mkdirSync(checkout, { mode: 0o700 });
        for (const name of ['src', 'media']) fs.cpSync(path.join(__dirname, '..', name), path.join(checkout, name), { recursive: true });
        fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(checkout, 'package.json'));
        rescue.supervise = (directory) => {
          assert.equal(directory, f.source.dir);
          return require('../src/keeperSupervisor').supervise(directory, {
            interpreter: path.join(base, 'final/NikUI Dev.app/Contents/Resources/engine/node'), sourceDirectory });
        };
        const transfer = await releaseKeeper(f.source, [f.original], { snapshot: processSnapshot }); await f.source.close();
        const proof = transfer.transferred[0], before = await rescueRequest(proof, 'status');
        const { label } = require('../src/keeperSupervisor').jobFor(f.source.dir);
        const registration = command('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]);
        fs.rmSync(checkout, { recursive: true }); // no repository or app file is touched
        assert.deepEqual(before.held, [proof.runId]); process.kill(before.pid, 'SIGKILL');
        // No client, engine, app or socket connection remains during this wait.
        // The 10s throttle must fit within the 15s shortened orphan grace.
        await pause(18500); assert(alive(proof.pid));
        const after = await rescueRequest(proof, 'status'); assert.notEqual(after.pid, before.pid); assert(after.held.includes(proof.runId));
        const service = f.service(transfer), session = f.session(service);
        // The transfer was proved by real ps above; do not compare those
        // birth timestamps with the portable fixture's hrtime identities.
        for (const link of service.links) if (link.processSnapshot) link.processSnapshot = processSnapshot;
        assert.equal(await service.attach(session), true);
        assert.equal(session.proc.pid, proof.pid);
        assert.equal(f.log().filter((r) => r.type === 'user').length, 1);
        report.builds.push({ build, ok: true, registration, sourceDeleted: true, samePID: proof.pid, crashedCustodian: before.pid, replacementCustodian: after.pid, noClientsMs: 18500, graceMs: 15000, originalTurnCount: 1 });
      } catch (error) {
        report.builds.push({ build, ok: false, failure: failureEvidence(error) });
      } finally {
        rescue.supervise = originalSupervise;
        // Close drivers before bootout: a live driver's close event would
        // otherwise recreate the job that cleanup is removing.
        for (const link of f.links) await link.close();
        try { report.cleanup.push({ build, jobs: await cleanupCustodyJobs([f.source.dir], [f.dir]) }); }
        catch (error) { report.cleanup.push({ build, failure: failureEvidence(error) }); }
        finally {
          const current = await processSnapshot([...f.pids]);
          for (const pid of f.pids) if (sameProcess(facts.get(pid), current.get(pid))) {
            try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
          f.pids.clear(); // f.close must not signal later without fresh proof.
          await f.close();
          report.cleanup.push({ build, processes: await quitOwnedProcesses([f.dir]) });
        }
      }
    }
    report.ok = report.builds.length === Object.keys(BUILDS).length && report.builds.every((r) => r.ok) && !report.cleanup.some((r) => r.failure);
  } catch (error) { report.failure = failureEvidence(error); }
  finally {
    rescue.supervise = originalSupervise;
    try { report.custodyJobs = await cleanupCustodyJobs(report.custodyDirectories, report.cleanupRoots); }
    catch (error) { report.ok = false; report.cleanupFailure = failureEvidence(error); }
  }
  return report;
}
if (require.main === module) void runNative(main);
module.exports = { main };
