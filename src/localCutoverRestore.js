'use strict';
// Explicit editor Restore action. Uses its retained signed helper and bundled
// JS; no executable from the Mac app is required, and no shell sees secrets.
const path = require('path');
const command = (file, args, options = {}) => {
  const result = require('child_process').spawnSync(file, args, { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', ...options });
  if (result.error || result.status !== 0) throw fail('SERVICE_OPERATION_FAILED', 'The exact engine job could not be inspected or retired');
  return result.stdout;
};
const { readPrivateJson, fail } = require('./daemonPaths');
const { controlRequest } = require('./daemonControl');
async function matchesJob(job, selected, snapshot = require('./keeperContinuity').processSnapshot) {
  const values = (key) => job.split('\n').flatMap((s) => s.trim().startsWith(key + ' = ') ? [s.trim().slice(key.length + 3)] : []);
  const appID = selected.label === 'com.nikui.engine' ? 'com.nikui.app' : 'com.nikui.app.dev';
  if (JSON.stringify(values('parent bundle identifier')) !== JSON.stringify([appID]) ||
      JSON.stringify(values('program identifier')) !== JSON.stringify(['Contents/MacOS/nikd (mode: 2)'])) return false;
  const pids = values('pid');
  if (pids.length !== 1 || !/^[1-9][0-9]*$/.test(pids[0])) return false;
  const pid = Number(pids[0]), process = (await snapshot([pid])).get(pid), contents = path.join(selected.app, 'Contents');
  // This editor fallback has no bundle-bound SMAppService status API. A
  // stopped job cannot be proved here; retain it for the installed app.
  return [path.join(contents, 'MacOS/nikd'), path.join(contents, 'Resources/engine/node') + ' ' +
    path.join(contents, 'Resources/engine/src/macEngine.js') + ' --root ' + selected.root].includes(process?.command);
}
async function restore(file, { createAdapter = require('./keychainStore').createSecItemAdapter, run = command } = {}) {
  const selected = readPrivateJson(file);
  if (selected.version !== 1 || !['com.nikui.engine', 'com.nikui.engine.development'].includes(selected.label) ||
      path.dirname(selected.helper) !== path.join(path.dirname(file), 'cutover-recovery')) throw fail('RESTORE_SCOPE_MISMATCH', 'Reviewed local recovery scope is required');
  const adapter = createAdapter({ helper: path.join(selected.helper, 'Contents/MacOS/NikKeychain'),
    home: selected.home, service: selected.service });
  const coordinator = require('./productionCutover').createProductionCutover({ selection: selected, secretAdapter: adapter });
  const state = coordinator.saved();
  if (!state || state.profile !== selected.profile || state.install !== selected.install) throw fail('RESTORE_SCOPE_MISMATCH', 'The selected editor profile changed');
  const result = await coordinator.restore();
  const stop = async () => {
    try { await controlRequest({ socket: path.join(selected.root, 'c.sock') }, { op: 'transition.stop' }, { timeoutMs: 10000 }); }
    catch (_) { /* the engine may already be absent */ }
  };
  const target = 'gui/' + process.getuid() + '/' + selected.label;
  // Prove the running package before Stop destroys that evidence. A stopped
  // SM registration has no package path; return the work without guessing it.
  let job;
  try { job = run('/bin/launchctl', ['print', target], { timeout: 10000 }); } catch (_) { await stop(); return result; }
  if (!/^\s*pid = /m.test(job)) { await stop(); return { ...result, registrationRetained: true }; }
  if (!await matchesJob(job, selected)) throw fail('SERVICE_OWNER_UNPROVEN', 'The registered engine does not match this restore');
  run('/bin/launchctl', ['bootout', target], { timeout: 10000 });
  await stop();
  return result;
}
if (require.main === module) {
  let finished = false, stopWatch = () => {};
  const end = (value) => {
    if (finished) return; finished = true; stopWatch();
    process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(value.ok ? 0 : 1));
  };
  stopWatch = require('./cutoverProgress').monitor({ parent: process.ppid, end });
  restore(process.argv[2]).then(end, (e) => end({ ok: false, code: e.code || 'CUTOVER_UNAVAILABLE' }));
}
module.exports = { restore, matchesJob };
