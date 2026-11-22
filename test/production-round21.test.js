'use strict';
const fs = require('fs'), path = require('path'), net = require('net');
const { productionFixture } = require('./helpers/production-cutover');
const { inventory, sourceRequest } = require('../src/legacySource');
const { exportSelectedContext } = require('../src/engineImport');
const { atomicJson } = require('../src/engineOwner');
const legacy = require('../src/legacyExtensionSource'), recovery = require('../src/cutoverRecovery');
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };

module.exports = async () => {
  suite('R21 retained rehearsal: empty reload inventory, abort, retry and current handback');
  const f = await productionFixture(2);
  try {
    for (const slot of f.slots) slot.engine.manager.get('session-' + slot.i).items.push({ id: 'seed-text-' + slot.i, kind: 'text', text: 'Original seed' });
    let interrupted = false, emptySamples = 0, secondAttempts = 0;
    const c = f.coordinator({
      async checkpoint(stage) {
        if (stage === 'barrier' && !interrupted) { await f.close(f.slots[1]); await f.open(f.slots[1]); }
      },
      async sources(options) {
        if (interrupted && options?.tolerateUnresponsive && emptySamples++ < 2) return [];
        return inventory(f.directory, options);
      },
      async request(source, request) {
        if (request.op === 'source.freeze' && !interrupted) { interrupted = true; return { ok: false, code: 'SOURCE_MANIFEST_INCOMPLETE' }; }
        if (request.op === 'source.abort' && source.workspace === f.slots[1].project && secondAttempts++ === 0) return { ok: false, code: 'SOURCE_RELOADING' };
        return sourceRequest(source, request);
      }
    });
    checkEqual('a reload gap preserves the actual Move failure instead of an empty abort diagnostic', await code(async () => c.move(await c.review())), 'SOURCE_MANIFEST_INCOMPLETE');
    check('abort waits through empty inventories and retries the second live window', emptySamples >= 3 && secondAttempts >= 2 && c.saved().releaseAcknowledged);
    await c.restore();
    check('both rebuilt legacy windows contain their own seed transcript', f.slots.every(s => s.source.legacy && s.engine.manager.get('session-' + s.i)?.items.some(i => i.id === 'seed-text-' + s.i)));
    await c.move(await c.review()); await f.start(); await c.finish();
    check('retry Move boots the service with both seed conversations and full transcripts', f.slots.every(s => f.runtime.engine.manager.get('session-' + s.i)?.items.some(i => i.id === 'seed-text-' + s.i)));
    f.runtime.engine.manager.create({ id: 'after-retry', cwd: f.slots[0].project, autoStart: false });
    await f.runtime.currentState.flush();
    await c.restore(); await f.stop();
    check('current handback returns both seeds to working legacy windows', f.slots.every(s => s.source.legacy && s.engine.manager.get('session-' + s.i)?.items.some(i => i.id === 'seed-text-' + s.i)));
    check('post-Move work also returns and ownership/service artifacts are gone', !!f.slots[0].engine.manager.get('after-retry') &&
      !fs.existsSync(path.join(f.directory, f.profile + '.mode')) && !fs.existsSync(path.join(f.selection.root, 'c.sock')) && !fs.existsSync(path.join(f.selection.root, 'production-owner.json')));
  } finally { await f.cleanup(); }

  suite('R21 short export is refused before persisted sessions can be replaced');
  const short = await productionFixture();
  try {
    const s = short.slots[0], identity = short.global.get('nikui.identity'), vapid = short.global.get('nikui.vapid');
    const options = { context: s.source.context, engine: { ...s.engine, manager: { ...s.engine.manager, list: [] } },
      settings: legacy.capturedSettings(s.vscode, s.engine, short.profile),
      provenance: { profile: short.profile, workspace: s.project, rawScope: 'selected-profile' },
      selection: { fingerprint: require('../src/identity').loadIdentity(short.global).fingerprint,
        applicationServerKey: require('../src/push').loadVapid(short.global).applicationServerKey }, secrets: short.secrets,
      keeper: { metaVersion: 1, runs: [] } };
    s.engine.flush();
    const before = structuredClone(s.original.workspaceState.get('nikui.sessions.v1'));
    checkEqual('a persisted conversation missing from the live manager refuses export', await code(() => exportSelectedContext(options)), 'EXPORT_INCOMPLETE');
    await s.original.workspaceState.update('nikui.sessions.v1', []);
    checkEqual('close-admission IDs still detect a short export after a later short memento write',
      await code(() => exportSelectedContext({ ...options, requiredSessionIDs: before.map(s => s.id) })), 'EXPORT_INCOMPLETE');
    await s.original.workspaceState.update('nikui.sessions.v1', before);
    check('failed export keeps the original selected identity and persisted session', short.global.get('nikui.identity') === identity &&
      short.global.get('nikui.vapid') === vapid && s.original.workspaceState.get('nikui.sessions.v1')[0].id === 'session-0');
  } finally { await short.cleanup(); }

  suite('R21 early incomplete-export refusal preserves the live writer and typed work');
  const refused = await productionFixture(), windowInventory = require('../src/sourceWindowInventory');
  const originalInventory = windowInventory.sourceWindowInventory;
  try {
    const s = refused.slots[0]; await refused.close(s); s.original.subscriptions = [];
    windowInventory.sourceWindowInventory = async () => ({ complete: true, pids: [process.pid], windows: 1 });
    await refused.open(s, { productionAdapters: true });
    const session = s.engine.manager.get('session-0');
    session.items.push({ id: 'live-transcript', kind: 'text', text: 'Keep this live transcript' });
    session.queue = [{ id: 'typed-live', text: 'Unsent typed work', snippets: ['full snippet'],
      attachments: [{ mediaType: 'image/png', data: Buffer.from('full live image').toString('base64') }] }];
    const persisted = [...s.original.workspaceState.get('nikui.sessions.v1'), { id: 'persisted-missing', cwd: s.project }];
    await s.original.workspaceState.update('nikui.sessions.v1', persisted);
    const c = refused.coordinator();
    checkEqual('a real adapter refuses a missing persisted ID before teardown', await code(async () => c.move(await c.review())), 'EXPORT_INCOMPLETE');
    check('abort keeps the same usable writer, full transcript, typed input and original memento without reload',
      s.source.legacy && !s.restored && s.engine.manager.get('session-0') === session &&
      session.items.some(i => i.id === 'live-transcript') && session.queue[0].attachments[0].data === Buffer.from('full live image').toString('base64') &&
      JSON.stringify(s.original.workspaceState.get('nikui.sessions.v1')) === JSON.stringify(persisted));
  } finally { windowInventory.sourceWindowInventory = originalInventory; await refused.cleanup(); }

  suite('R21 handback requires every export-time conversation or an explicit deletion tombstone');
  const returned = await productionFixture(2);
  try {
    const c = returned.coordinator(); await c.move(await c.review()); await returned.start(); await c.finish();
    await returned.runtime.currentState.flush();
    const state = { sources: [{ files: { workspaces: returned.runtime.importer.snapshot().records.find(r => r.id === returned.runtime.importer.snapshot().current).state.sources },
      settings: { projects: [] } }], instances: [], completeAuthority: true, authority: returned.runtime.authority.snapshot() };
    // Use the actual materialized source baselines; no fixture list of seed IDs.
    const original = state.sources[0].files.workspaces[0];
    state.sources[0].settings = original.settings; state.sources[0].folders = original.folders;
    const saved = returned.slots.map(s => JSON.stringify(s.original.workspaceState.values));
    checkEqual('a returned list missing a seed is rejected before producing a workspace payload',
      await code(() => legacy.workspaceReturn(state, original.provenance.workspace)), 'EXPORT_INCOMPLETE');
    const adapters = legacy.returnAdapters(returned.slots[0].source, returned.slots[0].original, returned.slots[0].vscode);
    checkEqual('the final editor importer independently refuses a short returned payload', await code(() => adapters.importWorkspace({
      version: 1, workspace: returned.slots[0].project, instances: [], sessions: [], projects: [],
      exportedSessionIDs: ['session-0'], deletedSessionIDs: [], beforeWorkspace: { 'nikui.sessions.v1': [{ id: 'session-0' }] }
    })), 'EXPORT_INCOMPLETE');
    check('rejected handback leaves both original editor mementos unchanged', returned.slots.every((s, i) => JSON.stringify(s.original.workspaceState.values) === saved[i]));
    // This is the real removal event observed by current authority, as used
    // by the app's existing close action; disposal does not emit it.
    returned.runtime.engine.manager.remove('session-0'); await returned.runtime.currentState.flush();
    check('explicit app deletion durably records its tombstone', returned.runtime.authority.snapshot().values['engine.current.v1'].retiredInstances.includes('session-0'));
    await c.restore(); await returned.stop();
    check('an explicitly deleted conversation stays deleted while the other source returns', !returned.slots[0].engine.manager.get('session-0') &&
      !!returned.slots[1].engine.manager.get('session-1') && returned.slots.every(s => s.source.legacy));
  } finally { await returned.cleanup(); }

  suite('R21 the immutable Move receipt independently blocks a short current handback');
  const shortened = await productionFixture(2);
  try {
    const c = shortened.coordinator(); await c.move(await c.review()); await shortened.start(); await c.finish();
    const baseline = shortened.slots.map(s => JSON.stringify(s.original.workspaceState.values));
    const runtime = shortened.runtime;
    runtime.currentState.beginDrain(); await runtime.currentState.flush();
    // Simulate a current-state projection bug, without an explicit removal
    // event or deletion tombstone. The original Move receipt stays intact.
    await runtime.authority.commit(state => { state.values['engine.current.v1'].instances = []; });
    Object.defineProperty(runtime.engine.manager, 'list', { configurable: true, get: () => [] });
    checkEqual('a complete but short current export cannot commit a return', await code(() => c.restore()), 'EXPORT_INCOMPLETE');
    check('short handback changes no editor memento and keeps service ownership for recovery',
      shortened.slots.every((s, i) => JSON.stringify(s.original.workspaceState.values) === baseline[i]) && runtime.ownership.owner.status().mode === 'service');
  } finally { await shortened.cleanup(); }

  suite('R21 recovery snapshots retain skipped work without replaying delivered work');
  const snapshots = await productionFixture();
  try {
    const s = snapshots.slots[0], source = { snapshotsFile: s.source.snapshotsFile };
    const good = s.engine.manager.get('session-0').snapshot(), mismatch = { ...good, cwd: s.project + '-other', items: [{ id: 'retained', kind: 'text', text: 'Keep these bytes' }] };
    atomicJson(source.snapshotsFile, { version: 1, sessions: [mismatch] });
    legacy.restoreSnapshots(source, s.engine);
    check('path mismatch retains its full recovery snapshot', fs.existsSync(source.snapshotsFile) && JSON.parse(fs.readFileSync(source.snapshotsFile)).sessions[0].items[0].id === 'retained');
    atomicJson(source.snapshotsFile, { version: 1, sessions: [good] }); legacy.restoreSnapshots(source, s.engine);
    check('successful hydration still consumes its one-time snapshot', !fs.existsSync(source.snapshotsFile));
  } finally { await snapshots.cleanup(); }

  suite('R21 Forget archives and verifies saved work even without the editor identity');
  const archive = await productionFixture(2);
  try {
    const c = archive.coordinator(), b = archive.slots[1];
    await c.move(await c.review()); await archive.start(); await c.finish();
    await archive.close(b); await c.restore(); await archive.stop();
    const saved = (await c.review()).pendingReturns.find(s => s.workspace === b.project);
    const original = fs.readFileSync(recovery.payloadFile(b.original, b.project));
    await archive.global.update('nikui.identity', undefined);
    const result = await c.forgetReturn({ ...saved, profile: archive.profile, confirmed: true });
    const read = recovery.readArchive(result.archive), payload = read.files.find(f => f.name === path.basename(recovery.payloadFile(b.original, b.project)));
    check('a private archive key authenticates the complete original bytes after identity loss', Buffer.from(payload.data, 'base64').equals(original));
    check('archiving cannot regenerate or replace the selected editor identity', archive.global.get('nikui.identity') === undefined);
    check('both archive and recovery key stay private and the confirmed return is cleared',
      [result.archive, result.archive + '.key'].every(file => (fs.statSync(file).mode & 0o777) === 0o600) && !recovery.pending(b.original, b.project));
  } finally { await archive.cleanup(); }

  suite('R21 rehearsal listener isolation and startup diagnostics');
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const occupiedPort = listener.address().port;
  const native = await productionFixture();
  try {
    const fixture = require('../src/acceptanceFixture').createAcceptanceFixture({ root: native.selection.root, testOnly: true });
    const dependencies = { codexCache: undefined,
      spawn: (file, ...args) => (file.endsWith('codex') ? fixture.adapters.codexSpawn : fixture.adapters.claudeSpawn)(file, ...args),
      power: require('../src/policyOwner').createFakePolicyAdapters().power,
      prRun: async () => ({ ok: false, stdout: '', code: 'FIXTURE_PR_UNAVAILABLE' }) };
    native.user['remote.port'] = occupiedPort;
    check('pre-click review refuses an unrelated listener before joining or changing source ownership',
      (await native.coordinator().review()).blockers.includes('PORT_IN_USE') && !fs.existsSync(path.join(native.selection.root, 'cutover-request.json')));
    await new Promise(resolve => listener.close(resolve));
    const c = native.coordinator(); await c.move(await c.review());
    // A listener can still appear after review. Preserve the real late-bind
    // failure and current-state recovery in addition to pre-click blocking.
    await new Promise(resolve => listener.listen(occupiedPort, '127.0.0.1', resolve));
    checkEqual('a configured occupied listener port reproduces the hidden native startup failure', await code(() => native.start(dependencies)), 'EADDRINUSE');
    await c.restore(); await native.stop();
    native.user['remote.port'] = 0;
    await c.move(await c.review()); await native.start(dependencies); await c.finish();
    check('an isolated port boots without disturbing the other listener', native.runtime.status().listener.port !== occupiedPort && listener.listening);
    await c.restore(); await native.stop();
    check('the isolated startup can hand back its seed to legacy', native.slots[0].source.legacy && !!native.slots[0].engine.manager.get('session-0'));
  } finally { await native.cleanup(); if (listener.listening) await new Promise(resolve => listener.close(resolve)); }
};
