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
  try { await controlRequest({ socket: path.join(selected.root, 'c.sock') }, { op: 'transition.stop' }, { timeoutMs: 10000 }); }
  catch (_) { /* the engine may already be absent */ }
  const target = 'gui/' + process.getuid() + '/' + selected.label;
  // Only retire a job whose exact BundleProgram belongs to the reviewed app.
  let job;
  try { job = run('/bin/launchctl', ['print', target], { timeout: 10000 }); } catch (_) { return result; }
  if (!job.includes('program = ' + path.join(selected.app, 'Contents/MacOS/nikd') + '\n')) throw fail('SERVICE_OWNER_UNPROVEN', 'The registered engine does not match this restore');
  run('/bin/launchctl', ['bootout', target], { timeout: 10000 });
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
module.exports = { restore };
