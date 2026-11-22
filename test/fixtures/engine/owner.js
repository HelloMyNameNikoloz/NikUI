'use strict';
const fs = require('fs');
const path = require('path');
const { createSyntheticOwner, hash } = require('../../../src/engineOwner');
const { buildTransfer } = require('../../../src/engineTransfer');
const { cutoverFixture, errorCode, deferred } = require('../../helpers/engine-cutover');
const base = fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT);

module.exports = async () => {
  suite('P2 T48: admission and deferred writes share the generation fence');
  const f = await cutoverFixture(path.join(base, 'normal'), { waitMs: 250 });
  try {
    for (const s of f.sources) s.gate.schedule(() => s.context.workspaceState.update('late', 'must not fire'), 1);
    const t = await f.owner.begin({ generation: 0, to: 'service', target: 'test-service', inventory: f.inventory() });
    checkEqual('owner stays window before commit while admission closes', [f.owner.status().mode, f.owner.status().generation, f.owner.status().admission], ['window', 0, 'closed']);
    checkEqual('writer effects refuse before watcher delivery', await errorCode(() => f.sources[0].gate.write(() => {})), 'WRITER_FENCED');
    checkEqual('racing activation refuses within the bounded admission window', await errorCode(() => f.owner.admit({ id: 'third', build: 'new', metaVersion: 1 })), 'OWNER_TRANSITION_PENDING');
    checkEqual('cannot commit without quiescence/export/import', await errorCode(() => f.owner.commit(t.token)), 'STALE_COORDINATOR');
    const held = deferred(); let settled = false;
    f.sources[0].gate.track(held.promise);
    const first = f.sources[0].quiesce(t.token).then((value) => { settled = true; return value; });
    await new Promise((r) => setImmediate(r));
    checkEqual('pending source writes hold the export acknowledgment', [settled, f.owner.status().acknowledged], [false, []]);
    held.resolve(); const exports = [await first, await f.sources[1].quiesce(t.token)];
    checkEqual('all stores are flushed and writers detached before each export', f.trace.map((e) => e[0]),
      ['close', 'cancel', 'drain', 'flush', 'detach', 'export', 'close', 'cancel', 'drain', 'flush', 'detach', 'export']);
    for (const s of f.sources) { s.fakeClock.fire(); checkEqual(s.member.id + ' has no late memento write', s.rawWorkspace.get('late'), undefined); }
    const envelope = buildTransfer(t, exports); await f.owner.exported(t.token, envelope.hash);
    const receipt = f.importer.import(envelope); await f.owner.imported(t.token, receipt);
    checkEqual('import is inactive before owner commit', f.starts, 0);
    const racer = f.owner.admit({ id: 'waiting-third', build: 'new', metaVersion: 1 }).catch((e) => ({ role: e.code }));
    await f.owner.commit(t.token); await f.importer.start(t.token);
    await f.owner.started(t.token, { generation: 1, target: 'test-service', hash: envelope.hash, oldResourcesReleased: true });
    await f.owner.release(t.token);
    checkEqual('an activation waiting across commit is admitted only as a client', (await racer).role, 'client');
    const third = await f.owner.admit({ id: 'third', build: 'new', metaVersion: 1 });
    checkEqual('a racing/delayed watcher activation becomes only a client after commit', [third.role, third.generation], ['client', 1]);
    for (const s of f.sources) checkEqual(s.member.id + ' old source cannot write any store', await errorCode(() => s.context.workspaceState.update('late', true)), 'WRITER_SEALED');
    checkEqual('one target starts and stale coordinator cannot recommit', [f.starts, await errorCode(() => f.owner.commit(t.token))], [1, 'STALE_COORDINATOR']);
    check('ownership diagnostics contain no exported credentials or prompts', !JSON.stringify(f.owner.status()).includes('synthetic-private') && !JSON.stringify(f.owner.status()).includes('full 🧪'));
    checkEqual('owner format is the agreed four-field record', Object.keys(JSON.parse(fs.readFileSync(f.owner.file))).sort(), ['by', 'generation', 'mode', 'since']);
    checkEqual('owner and transition files are private', [f.owner.file, f.owner.file + '.transition', f.owner.file + '.participants'].map((p) => fs.statSync(p).mode & 0o777), [0o600, 0o600, 0o600]);
  } finally { await f.close(); }

  suite('P2 T49/T52: unresponsive and changed sources retain the barrier');
  const held = await cutoverFixture(path.join(base, 'unresponsive'), { count: 1 });
  try {
    const t = await held.owner.begin({ generation: 0, to: 'service', target: 'test-service', inventory: held.inventory() });
    const never = deferred(); let sourceError;
    try { await held.sources[0].gate.quiesce(t.token, { timeoutMs: 10, closeAdmission() {}, cancel() {}, drain: () => never.promise,
      flush() {}, detach() {}, releaseResources: () => ({ released: true, owned: [] }), exportState: () => ({}) }); }
    catch (e) { sourceError = e; }
    checkEqual('an unresponsive source names its loaded build', [sourceError?.code, sourceError?.blockers[0].id, sourceError?.blockers[0].build],
      ['SOURCE_UNRESPONSIVE', held.sources[0].member.id, 'loaded-meta-build']);
    checkEqual('timeout has no export/import or generation effects', [held.owner.status().generation, held.owner.status().acknowledged, held.starts], [0, [], 0]);
    checkEqual('a timed-out source cannot issue a deferred write', await errorCode(() => held.sources[0].gate.write(() => {})), 'WRITER_SEALED');
    never.resolve(); await new Promise((r) => setImmediate(r));
    checkEqual('late drain completion cannot acknowledge the timed-out export', held.owner.status().acknowledged, []);
    checkEqual('abort needs explicit inactive/discarded/reachable proof', await errorCode(() => held.owner.abort(t.token, {})), 'ABORT_UNPROVEN');
    await held.owner.abort(t.token, { targetInactive: true, importDiscarded: true, allSourcesReachable: true });
    await held.sources[0].gate.reopenAfterAbort(); held.sources[0].gate.write(() => {});
    checkEqual('a proved abort reopens only the original generation', [held.owner.status().generation, held.owner.status().mode, held.sources[0].gate.phase], [0, 'window', 'open']);
  } finally { await held.close(); }
  const advancing = await cutoverFixture(path.join(base, 'advancing'), { count: 1 });
  try {
    const t = await advancing.owner.begin({ generation: 0, to: 'service', target: 'test-service', inventory: advancing.inventory() });
    const started = Date.now(); let steps = 0;
    await advancing.sources[0].gate.quiesce(t.token, { timeoutMs: 100, closeAdmission() {}, cancel() {}, drain() {}, flush() {},
      async detach(progress) { for (let i = 0; i < 4; i++) { await new Promise((resolve) => setTimeout(resolve, 40)); steps++; progress(); } },
      releaseResources: () => ({ released: true, owned: [] }), exportState: () => ({}) });
    check('actual source progress can exceed the initial quiescence deadline without weakening the fence',
      steps === 4 && Date.now() - started > 100 && advancing.owner.status().acknowledged.length === 1);
    await advancing.owner.abort(t.token, { targetInactive: true, importDiscarded: true, allSourcesReachable: true });
    await advancing.sources[0].gate.reopenAfterAbort(); let worked = false; advancing.sources[0].gate.write(() => { worked = true; });
    check('a progress-extended source has a proved path back to usable legacy writes', worked && advancing.sources[0].gate.phase === 'open');
  } finally { await advancing.close(); }
  const disposal = await cutoverFixture(path.join(base, 'stalled-disposal'), { count: 1 });
  try {
    const transition = await disposal.owner.begin({ generation: 0, to: 'service', target: 'test-service', inventory: disposal.inventory() });
    const never = deferred(), started = Date.now(); let failure;
    try {
      await disposal.sources[0].gate.quiesce(transition.token, { timeoutMs: 50, closeAdmission() {}, cancel() {}, drain() {}, flush() {}, detach() {},
        releaseResources() { disposal.sources[0].gate.track(never.promise); return { released: true, owned: [] }; }, exportState: () => ({}) });
    } catch (error) { failure = error.code; }
    check('an unresolved disposal write stays bounded and cannot loosen quiescence',
      ['QUIESCENCE_INCOMPLETE', 'SOURCE_UNRESPONSIVE'].includes(failure) && Date.now() - started < 1000 && disposal.sources[0].gate.phase === 'sealed');
    never.resolve(); await new Promise((resolve) => setImmediate(resolve));
    checkEqual('a disposal write completing after timeout never acknowledges the old generation', disposal.owner.status().acknowledged, []);
  } finally { await disposal.close(); }
  const changed = await cutoverFixture(path.join(base, 'changed'), { count: 1 });
  try {
    const t = await changed.owner.begin({ generation: 0, to: 'service', target: 'test-service', inventory: changed.inventory() });
    const exports = [await changed.sources[0].quiesce(t.token)], envelope = buildTransfer(t, exports);
    await changed.owner.exported(t.token, envelope.hash);
    await changed.owner.updateParticipant(changed.sources[0].member.lease, { busy: true });
    await changed.owner.updateParticipant(changed.sources[0].member.lease, { busy: false });
    checkEqual('activity after acknowledgment invalidates it even when the source becomes idle', await errorCode(() => changed.importer.import(envelope)), 'PARTICIPANTS_CHANGED');
    checkEqual('changed participant does not create an inactive import', fs.existsSync(changed.importer.file), false);
  } finally { await changed.close(); }

  suite('P2 T49: named source/build/profile blockers precede import effects');
  for (const condition of ['old', 'busy', 'disconnected', 'unaccounted', 'incomplete', 'other-profile']) {
    const f = await cutoverFixture(path.join(base, condition));
    try {
      let inventory = f.inventory();
      if (condition === 'old') {
        await f.owner.disconnect(f.sources[0].member.lease);
        f.sources[0].member = await f.owner.admit({ id: f.sources[0].member.id, build: 'old-loaded-build-through-same-symlink' });
      }
      if (condition === 'busy') await f.owner.updateParticipant(f.sources[0].member.lease, { busy: true });
      if (condition === 'disconnected') await f.owner.disconnect(f.sources[0].member.lease);
      if (condition === 'unaccounted') inventory.ids.pop();
      if (condition === 'incomplete') inventory.complete = false;
      if (condition === 'other-profile') inventory.otherScopes.push({ id: 'foreign', state: 'unknown', evidence: '' });
      let error; try { await f.owner.begin({ generation: 0, to: 'service', target: 'test-service', inventory }); } catch (e) { error = e; }
      checkEqual(condition + ' refuses by name', error?.code, ['incomplete', 'other-profile'].includes(condition)
        ? condition === 'incomplete' ? 'PARTICIPANT_INVENTORY_INCOMPLETE' : 'OTHER_SCOPE_UNFENCED' : 'CUTOVER_BLOCKED');
      if (condition === 'old') checkEqual('loaded build is named despite identical install path', [error.blockers[0].build, error.blockers[0].code], ['old-loaded-build-through-same-symlink', 'KEEPER_META_UNSUPPORTED']);
      checkEqual(condition + ' leaves generation and import/start effects unchanged', [f.owner.status().generation, f.starts, fs.existsSync(f.importer.file)], [0, 0, false]);
    } finally { await f.close(); }
  }
  suite('P2 T48/T52: corrupt and locked owner never admit fallback');
  const corrupt = await cutoverFixture(path.join(base, 'corrupt'), { count: 1, waitMs: 10 });
  try {
    fs.writeFileSync(corrupt.owner.file + '.lock', 'held', { mode: 0o600 });
    checkEqual('a stuck admission lock times out without deleting it', await errorCode(() => corrupt.owner.admit({ id: 'racer', build: 'new', metaVersion: 1 })), 'OWNER_ADMISSION_TIMEOUT');
    checkEqual('the competing ownership lock is retained', fs.readFileSync(corrupt.owner.file + '.lock', 'utf8'), 'held');
    fs.unlinkSync(corrupt.owner.file + '.lock'); fs.writeFileSync(corrupt.owner.file, '{"generation":');
    checkEqual('a partial owner record refuses rather than assuming window mode', await errorCode(() => corrupt.owner.admit({ id: 'racer', build: 'new', metaVersion: 1 })), 'OWNER_CORRUPT');
    checkEqual('production construction is refused before reading state', await errorCode(() => createSyntheticOwner({ ...corrupt.options, testOnly: false })), 'PRODUCTION_CUTOVER_DISABLED');
  } finally { await corrupt.close(); }
};
