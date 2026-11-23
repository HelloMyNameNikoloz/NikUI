'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
function command(file, args, options = {}, run = spawnSync) {
  const result = run(file, args, { encoding: 'utf8', timeout: 35000, killSignal: 'SIGKILL', ...options });
  if (result.error || result.status !== 0) {
    const stdout = String(result.stdout || ''), stderr = String(result.stderr || '');
    let controller;
    try { controller = JSON.parse(stdout); } catch (_) { /* retain exact streams */ }
    throw Object.assign(new Error('Command failed: ' + path.basename(file)), {
      code: 'NATIVE_CHECK_FAILED', command: [file, ...args], status: result.status, signal: result.signal,
      operation: args[0] || 'execute', path: file,
      stdout, stderr, controller, spawnError: result.error?.code, diagnostic: stdout + stderr
    });
  }
  return result.stdout;
}
const failureEvidence = (error) => ({
  ...Object.fromEntries(['code', 'message', 'command', 'status', 'signal',
    'stdout', 'stderr', 'controller', 'spawnError', 'diagnostic', 'diagnostics'].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])),
  stack: error.stack || new Error(String(error.message || error)).stack,
  operation: error.operation || error.syscall || 'native gate', path: error.path || error.command?.[0] || null
});
function developmentJobExists(run = command) {
  const label = 'com.nikui.engine.development';
  try { run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]); return true; }
  catch (error) {
    if (error.status === 113 && String(error.stderr).includes(`Could not find service "${label}"`)) return false;
    throw error;
  }
}
async function cleanupDevelopmentJob({ controller, attempted, exists = developmentJobExists,
  bootout = () => command('/bin/launchctl', ['bootout', `gui/${process.getuid()}/com.nikui.engine.development`]),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, timeoutMs = 10000 }) {
  if (!attempted) return { attempted: false };
  const failures = [], record = (stage, error) => failures.push({ stage, ...failureEvidence(error) });
  let absent = false;
  const loaded = exists();
  const identity = controller('build-identity');
  if (identity.flavour !== 'dev' || identity.label !== 'com.nikui.engine.development') throw Error('NATIVE_DEVELOPMENT_SCOPE_INVALID');
  if (!loaded) {
    // launchctl absence alone leaves a stale SMAppService/BTM record behind.
    controller('unregister');
    const status = controller('status');
    if (exists() || !['notRegistered', 'notFound'].includes(status.registration))
      throw Object.assign(Error('NATIVE_DEVELOPMENT_REGISTRATION_REMAINS'), { code: 'NATIVE_DEVELOPMENT_CLEANUP_FAILED' });
    return { attempted: true, absent: true, registration: status.registration, failures };
  }
  // Registration is bundle-bound. A foreign same-label job must be left alone.
  try {
    controller('validate-removal');
    if (controller('status').control) controller('intentional-stop');
  } catch (error) { record('stop', error); }
  finally {
    // Unregister validates its own bundle-bound removal permission, which
    // remains usable after startup fails with no control endpoint/PID.
    try {
      controller('unregister');
    } catch (error) {
      record('unregister', error);
      // A lost/failed SM reply cannot strand a gate's running job. Re-prove
      // removal immediately before the scoped fallback; foreign PIDs refuse.
      try { if (exists()) { controller('validate-removal'); bootout(); } }
      catch (fallback) { record('bootout', fallback); }
    }
    try {
      const deadline = now() + timeoutMs;
      do {
        if (!exists()) { absent = true; break; }
        await pause(100);
      } while (now() < deadline);
      if (!absent) throw Error('NATIVE_DEVELOPMENT_JOB_REMAINS');
    } catch (error) { record('absence', error); }
  }
  const result = { attempted: true, absent, failures };
  if (failures.length || !absent) throw Object.assign(Error('NATIVE_DEVELOPMENT_CLEANUP_FAILED'),
    { code: 'NATIVE_DEVELOPMENT_CLEANUP_FAILED', diagnostics: result });
  return result;
}
function bounded(promise, timeoutMs, code = 'NATIVE_TEST_TIMEOUT') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(Error(code), { code })), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
async function childResult(child, timeoutMs, code = 'NATIVE_CHILD_TIMEOUT') {
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signal) => resolve({ code: status, signal }));
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(Error(code), { code, pid: child.pid })); }, timeoutMs);
    });
  } finally { clearTimeout(timer); child.unref(); }
}
// The CLI must finish even when a failed GUI/IPC child retains a Node handle.
// Scenario finally blocks own exact cleanup; this only bounds the harness.
async function runNative(main, timeoutMs = 30 * 60 * 1000) {
  const watchdog = setTimeout(() => finish({ ok: false, failure: failureEvidence(Object.assign(Error('Native script deadline expired'),
    { code: 'NATIVE_SCRIPT_TIMEOUT', operation: 'runNative' })) }), timeoutMs);
  let finished = false;
  function finish(result) {
    if (finished) return; finished = true; clearTimeout(watchdog);
    const status = result.ok === true && !process.exitCode ? 0 : 1;
    const fallback = setTimeout(() => process.exit(status), 1000);
    process.stdout.write(JSON.stringify(result) + '\n', () => { clearTimeout(fallback); process.exit(status); });
  }
  try { const result = await main(); finish({ ok: result?.ok === true, ...(result || {}) }); }
  catch (error) { finish({ ok: false, failure: failureEvidence(error) }); }
}
// Snapshot only the disposable editor's exact argv root and its descendants.
// Recheck start time + command before signalling, to reject PID reuse.
function processRows(run = command) {
  return run('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,command=']).trim().split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    return match ? [{ pid: +match[1], parent: +match[2], proof: match[3] + ' ' + match[4], argv: match[4] }] : [];
  });
}
function editorProcesses(userData, _cliPIDs = [], run = command) {
  const rows = processRows(run);
  // A finished CLI's PID may already belong to an unrelated process. Only
  // exact disposable argv can establish a fresh root; PID alone never can.
  const argument = new RegExp('(?:^|\\s)--user-data-dir(?:=|\\s+)' + userData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)');
  const selected = new Set(rows.filter((r) => argument.test(r.argv)).map((r) => r.pid));
  for (let previous = -1; previous !== selected.size;) {
    previous = selected.size;
    for (const row of rows) if (selected.has(row.parent)) selected.add(row.pid);
  }
  return rows.filter((r) => selected.has(r.pid) && r.pid !== process.pid);
}
function ownedProcesses(roots, run = command) {
  const rows = processRows(run);
  // The verifier's own argv names the report in the disposable root. Do not
  // turn that into ownership of its transient ps child (R45 P2 evidence).
  const selected = new Set(rows.filter((r) => r.pid !== process.pid && roots.some((root) => r.argv.includes(root + path.sep) || r.argv.endsWith(' ' + root))).map((r) => r.pid));
  for (let previous = -1; previous !== selected.size;) {
    previous = selected.size;
    for (const row of rows) if (row.pid !== process.pid && selected.has(row.parent)) selected.add(row.pid);
  }
  return rows.filter((r) => selected.has(r.pid) && r.pid !== process.pid);
}
async function quitOwnedProcesses(roots, options = {}) {
  return quitDisposableEditor('isolated native gate', { ...options, scan: options.scan || (() => ownedProcesses(roots)) });
}
async function cleanupCustodyJobs(directories, roots, run = command) {
  const jobs = [];
  for (const directory of directories) {
    const canonical = path.resolve(directory);
    if (!canonical.startsWith('/private/tmp/nik-mac/build/') || !roots.some((r) => canonical.startsWith(path.resolve(r) + path.sep))) throw Error('NATIVE_CUSTODY_SCOPE_INVALID');
    require('../src/daemonPaths').noSymlinks(canonical);
    const { label, file } = require('../src/keeperSupervisor').jobFor(canonical), target = `gui/${process.getuid()}/${label}`;
    const inspect = () => {
      try { return run('/bin/launchctl', ['print', target]); }
      catch (error) {
        if (error.status === 113 && String(error.stderr).includes('Could not find service "' + label + '"')) return null;
        throw error;
      }
    };
    const before = inspect();
    let wasRegistered = before !== null;
    const waitGone = async () => {
      const end = Date.now() + 8000;
      while (inspect() !== null) {
        if (Date.now() >= end) throw Error('NATIVE_CUSTODY_JOB_REMAINS');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    if (before !== null) {
      const paths = before.split('\n').map((s) => /^\s*path = (.+)$/.exec(s)).filter(Boolean);
      if (paths.length !== 1 || paths[0][1] !== file) throw Error('NATIVE_CUSTODY_JOB_UNPROVEN');
      if (require('../src/daemonPaths').privateFile(file, { optional: true })) {
        try { run('/bin/launchctl', ['bootout', target]); } catch (error) { if (inspect() !== null) throw error; }
        await waitGone();
      } else {
        // The product unlinks its plist before self-bootout can terminate it.
        // Wait for that already-started retirement; no signal is justified by
        // a missing file alone, and this is not a leaked idle job.
        await waitGone(); wasRegistered = false;
      }
    }
    if (require('fs').existsSync(file)) { require('../src/daemonPaths').privateFile(file); require('fs').unlinkSync(file); }
    jobs.push({ label, file, wasRegistered, absent: true, ...(before !== null && !wasRegistered ? { retired: true } : {}) });
  }
  return jobs;
}
function aliveExact(records, run = command) {
  return records.filter((record) => {
    let proof;
    try { proof = run('/bin/ps', ['-ww', '-p', String(record.pid), '-o', 'lstart=', '-o', 'command=']).trim(); }
    catch (_) { return false; }
    // ps pads lstart differently when pid/ppid columns are omitted. Compare
    // the same start-time/argv fields, not that presentation whitespace.
    const match = proof.match(/^(.{24})\s+(.+)$/);
    return !!match && match[1] + ' ' + match[2] === record.proof;
  });
}
function signalExact(records, signal, run = command, kill = process.kill) {
  const sent = [];
  for (const record of aliveExact([...records].reverse(), run)) {
    try { kill(record.pid, signal); sent.push({ pid: record.pid, signal, proof: record.proof }); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  return sent;
}
async function quitDisposableEditor(userData, { scan = editorProcesses, signal = signalExact,
  alive = aliveExact, initial = [], now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), graceMs = 3000, killMs = 3000 } = {}) {
  const started = now(), signals = []; let empty = 0, rounds = 0, known = initial;
  while (now() - started < graceMs + killMs) {
    // Retain proved descendants after reparenting, even if an auxiliary
    // process has no user-data flag of its own. Reject reused PIDs each time.
    const current = [...new Map([...alive(known), ...scan(userData)].map((p) => [p.pid, p])).values()];
    known = current; rounds++;
    if (!current.length) { if (++empty === 2) return { absent: true, scans: rounds, signals }; }
    else {
      empty = 0;
      const kind = now() - started < graceMs ? 'SIGTERM' : 'SIGKILL';
      // Stop exact argv roots before their descendants, then rescan. Electron
      // may replace a renderer while a leaf-first snapshot is being retired.
      const ids = new Set(current.map((p) => p.pid));
      const roots = current.filter((p) => !ids.has(p.parent));
      signals.push(...signal(roots, kind) || []);
      signals.push(...signal(current.filter((p) => ids.has(p.parent)), kind) || []);
    }
    await pause(100);
  }
  throw Object.assign(Error('Exact disposable editor processes remain'), { code: 'EDITOR_CLEANUP_FAILED',
    diagnostics: { signals, processes: [...alive(known), ...scan(userData)].map(({ pid, parent, proof }) => ({ pid, parent, proof })) } });
}
module.exports = { command, failureEvidence, bounded, childResult, runNative, editorProcesses, aliveExact, signalExact, quitDisposableEditor,
  ownedProcesses, quitOwnedProcesses, cleanupCustodyJobs, developmentJobExists, cleanupDevelopmentJob };
