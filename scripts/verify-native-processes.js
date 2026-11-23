#!/usr/bin/env node
'use strict';
// Invoked by Claude after each native gate. Scope comes only from that gate's
// freshly minted evidence, never a global bundle id, job label or port.
const fs = require('fs'), path = require('path');
const { ownedProcesses, quitOwnedProcesses, failureEvidence } = require('./native-command');
async function verify(file) {
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  const roots = [...new Set([result.run, result.home, ...(result.cleanupRoots || [])]
    .filter((root) => typeof root === 'string' && path.isAbsolute(root)).map((root) => path.resolve(root)))];
  if (roots.some((root) => !root.startsWith('/private/tmp/nik-mac/') && !root.startsWith('/tmp/nik-mac/'))) throw Error('NATIVE_CLEANUP_SCOPE_INVALID');
  const remaining = roots.length ? ownedProcesses(roots) : [];
  const custodyJobs = await require('./native-command').cleanupCustodyJobs(result.custodyDirectories || [], roots);
  const cleanup = roots.length ? await quitOwnedProcesses(roots, { initial: remaining }) : { absent: true, scans: 0, signals: [] };
  return { ok: !remaining.length && !custodyJobs.some((j) => j.wasRegistered), absent: cleanup.absent, roots, cleanup, custodyJobs,
    ...(remaining.length ? { failure: { ...failureEvidence(Object.assign(Error('Disposable processes remained after the gate'),
      { code: 'NATIVE_GATE_LEAKED_PROCESSES', operation: 'verify native processes', path: file })), pids: remaining.map((p) => p.pid) } }
      : custodyJobs.some((j) => j.wasRegistered) ? { failure: failureEvidence(Object.assign(Error('Disposable custody jobs remained after the gate'),
        { code: 'NATIVE_GATE_LEAKED_CUSTODY_JOBS', operation: 'verify native custody jobs', path: file })) } : {}) };
}
if (require.main === module) verify(process.argv[2]).then((result) => {
  process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : 1;
}, (error) => { process.stdout.write(JSON.stringify({ ok: false, failure: failureEvidence(error) }) + '\n'); process.exitCode = 1; });
module.exports = { verify };
