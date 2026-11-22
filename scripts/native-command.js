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
      stdout, stderr, controller, spawnError: result.error?.code, diagnostic: stdout + stderr
    });
  }
  return result.stdout;
}
const failureEvidence = (error) => Object.fromEntries(['code', 'message', 'command', 'status', 'signal',
  'stdout', 'stderr', 'controller', 'spawnError', 'diagnostic', 'diagnostics'].filter((key) => error[key] !== undefined).map((key) => [key, error[key]]));
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
  const watchdog = setTimeout(() => finish({ ok: false, failure: { code: 'NATIVE_SCRIPT_TIMEOUT' } }), timeoutMs);
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
function editorProcesses(userData, _cliPIDs = [], run = command) {
  const rows = run('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,command=']).trim().split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    return match ? [{ pid: +match[1], parent: +match[2], proof: match[3] + ' ' + match[4], argv: match[4] }] : [];
  });
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
module.exports = { command, failureEvidence, bounded, childResult, runNative, editorProcesses, aliveExact, signalExact, quitDisposableEditor };
