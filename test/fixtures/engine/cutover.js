'use strict';
const fs = require('fs');
const path = require('path');
const { createSyntheticOwner, hash } = require('../../../src/engineOwner');
const { buildTransfer, createSyntheticImporter, runSyntheticTransfer, restoreAuthority, createParticipantGate } = require('../../../src/engineTransfer');
const { cutoverFixture, errorCode, mkdir } = require('../../helpers/engine-cutover');
const { openAuthority } = require('../../../src/jsonlAuthority');
const { receipt, intent } = require('../../helpers/engine-disk');
const base = fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT);

async function exported(f) {
  const t = await f.owner.begin({ generation: 0, to: 'service', target: 'test-service', inventory: f.inventory() });
  const sources = [];
  for (const s of f.sources) sources.push(await s.quiesce(t.token));
  const envelope = buildTransfer(t, sources); await f.owner.exported(t.token, envelope.hash);
  return { t, sources, envelope };
}

module.exports = async () => {
  suite('P2 T50: context-pushed complete inventory and queue/accounting provenance');
  const f = await cutoverFixture(path.join(base, 'export'));
  try {
    const second = f.sources[0].engine.folders.create('Second');
    const folders = f.sources[0].engine.folders;
    folders.folders = [second, ...folders.list().filter((r) => r.id !== second.id)]; folders.save();
    const { t, sources, envelope } = await exported(f);
    const state = sources[0].state;
    checkEqual('source-context names and session IDs are exported', [state.global['nikui.names.v1'], state.instances[0].id, state.instances[0].claudeSessionId], [{'conversation-1': 'Source 1'}, 'session-1', 'conversation-1']);
    check('queue text and expanded input retain all bytes beyond legacy memento limits', state.queues[0].items[0].text.length > 8000 && state.queues[0].items[0].sent.length > 8000);
    checkEqual('all attachment bytes and snippets survive the pushed export', [state.queues[0].items[0].attachments[0].data, state.queues[0].items[0].snippets.length], ['FULL-IMAGE-BYTES', 12]);
    checkEqual('every queue has a full payload hash', state.queues.every((q) => q.hash === hash(q.items)), true);
    checkEqual('deliberate folder order and by-conversation placement are explicit', [state.folders.folders.map((r) => r.id),
      state.folders.byConversation['conversation-1']], [folders.list().map((r) => r.id), folders.assign['session-1']]);
    checkEqual('limits, pause and manual override retain source values', [state.account.limits.at, state.account.pause.until, state.account.limitOverride], [123, 9999999999999, 42]);
    checkEqual('duplicate ledger copies merge by maxima rather than sum', envelope.value.ledger.instances.shared,
      { cost: 4, tokens: 20, turns: 2, firstAt: 98, lastAt: 102 });
    checkEqual('each workspace and settings payload retains source provenance', sources.map((s) => [s.state.provenance.profile, s.state.provenance.workspace]),
      f.sources.map((s) => ['test-profile', s.home]));
    checkEqual('derived/client/provider/SQLite/live-process omissions are classified', Object.keys(state.omitted).sort(), ['caches', 'clientOutboxes', 'editorSQLite', 'liveProcesses', 'providerHomes']);
    checkEqual('source export includes explicit API-provided durable data', state.files.durable.version, 1);
    const conflicting = structuredClone(sources); conflicting[1].state.secrets['nikui.identity'].privateKey = 'other-profile-private';
    conflicting[1].ack.hash = hash(conflicting[1].state);
    checkEqual('conflicting identities are refused rather than unioned', await errorCode(() => buildTransfer(t, conflicting)), 'EXPORT_IDENTITY_CONFLICT');
    const badQueue = structuredClone(sources); badQueue[0].state.queues[0].items[0].text += 'changed'; badQueue[0].ack.hash = hash(badQueue[0].state);
    checkEqual('queue payload/hash disagreement refuses', await errorCode(() => buildTransfer(t, badQueue)), 'EXPORT_QUEUE_HASH');

    suite('P2 T51: repeated import stays inactive and preserves newer target work');
    const receipt = f.importer.import(envelope);
    checkEqual('inactive import records counts before commit', [receipt.inactive, receipt.sources, receipt.instances, receipt.queues, f.starts], [true, 2, 2, 2, 0]);
    checkEqual('inactive imports cannot be started under the old generation', await errorCode(() => f.importer.start(t.token)), 'STALE_GENERATION');
    checkEqual('inactive target state cannot accept new work', await errorCode(() => f.importer.mutate(() => {})), 'IMPORT_INACTIVE');
    checkEqual('repeating the identical import returns its original receipt', f.importer.import(envelope), receipt);
    const conflictingImport = structuredClone(envelope); conflictingImport.value.target = 'wrong-target'; conflictingImport.hash = hash(conflictingImport.value);
    checkEqual('import refuses a different target before writes', await errorCode(() => f.importer.import(conflictingImport)), 'IMPORT_SCOPE_CONFLICT');
    await f.owner.imported(t.token, receipt); await f.owner.commit(t.token); await f.importer.start(t.token);
    await f.owner.started(t.token, { generation: 1, target: 'test-service', hash: envelope.hash, oldResourcesReleased: true }); await f.owner.release(t.token);
    f.importer.mutate((s) => { s.postCutover = { id: 'service-created', cost: 25 }; });
    checkEqual('reimport after new work still returns the original receipt', f.importer.import(envelope), receipt);
    checkEqual('idempotence does not overwrite newer target state', f.importer.snapshot().state.postCutover, { id: 'service-created', cost: 25 });
    const changedSources = structuredClone(sources); changedSources[0].state.instances[0].customTitle = 'different'; changedSources[0].ack.hash = hash(changedSources[0].state);
    const changed = buildTransfer(t, changedSources);
    checkEqual('same import ID with changed valid payload refuses', await errorCode(() => f.importer.import(changed)), 'IMPORT_ID_CONFLICT');
    await f.importer.start(t.token); checkEqual('repeated start does not activate a second writer', f.starts, 1);
  } finally { await f.close(); }

  suite('P2 T52: crash matrix retains a fence on both sides of atomic owner commit');
  const points = ['before-barrier', 'after-barrier', 'before-export:window-1', 'after-export:window-1', 'after-export', 'before-import', 'after-import',
    'before-commit', 'after-commit', 'before-start', 'after-start', 'before-release', 'after-release', 'owner:committed'];
  for (const point of points) {
    let faulted = false;
    const f = await cutoverFixture(path.join(base, point), { count: 1,
      fault: (step) => { if (point === step) { faulted = true; throw new Error('synthetic coordinator crash'); } } });
    try {
      const error = await errorCode(() => runSyntheticTransfer({ owner: f.owner, generation: 0, to: 'service', target: 'test-service',
        inventory: f.inventory(), sources: f.sources, importer: f.importer,
        hook: async (step) => { if (step === point) { faulted = true; throw new Error('synthetic coordinator crash'); } } }));
      check(point + ' fault was exercised', faulted && error === 'synthetic coordinator crash');
      const reopened = createSyntheticOwner({ ...f.options, fault: undefined }); const recovered = await reopened.recover();
      const committed = ['after-commit', 'before-start', 'after-start', 'before-release', 'after-release', 'owner:committed'].includes(point);
      checkEqual(point + ' reopens the correct owner generation', [recovered.owner.generation, recovered.owner.mode], committed ? [1, 'service'] : [0, 'window']);
      checkEqual(point + ' never activates imported work before commit', !committed ? f.starts : 0, 0);
      if (!['after-release', 'before-barrier'].includes(point)) checkEqual(point + ' leaves admission closed until recovery', reopened.status().admission, 'closed');
      else checkEqual('completed transfer releases admission', reopened.status().admission, 'open');
      if (!committed) checkEqual(point + ' preserves the appropriate source fence', recovered.action, point === 'before-barrier' ? 'admit' : 'remain-quiescent');
      else if (point !== 'after-release') {
        const j = recovered.transition;
        await f.importer.start(j.token);
        await reopened.started(j.token, { generation: 1, target: 'test-service', hash: j.hash, oldResourcesReleased: true });
        await reopened.release(j.token);
        checkEqual(point + ' recovery starts one target and never restores a window writer', [f.starts, (await reopened.admit({ id: 'recovered-window', build: 'new', metaVersion: 1 })).role], [1, 'client']);
      }
    } finally { await f.close(); }
  }

  suite('P2 T51/T52: concurrent and interrupted target start never repeat effects');
  const concurrent = await cutoverFixture(path.join(base, 'concurrent-start'), { count: 1 });
  try {
    const { t, envelope } = await exported(concurrent);
    let effects = 0;
    const gate = require('../../helpers/engine-disk').deferred();
    const target = createSyntheticImporter({ root: concurrent.targetRoot, target: 'test-service', owner: concurrent.owner,
      testOnly: true, activate: async () => { effects++; await gate.promise; } });
    await concurrent.owner.imported(t.token, target.import(envelope)); await concurrent.owner.commit(t.token);
    const first = target.start(t.token), second = target.start(t.token);
    const both = Promise.allSettled([first, second]);
    await new Promise((r) => setImmediate(r)); gate.resolve();
    const outcomes = await both;
    checkEqual('concurrent coordinators reserve one target activation', [effects, outcomes.filter((r) => r.status === 'fulfilled').length,
      outcomes.find((r) => r.status === 'rejected')?.reason.code], [1, 1, 'TARGET_START_UNKNOWN']);
    await concurrent.owner.started(t.token, { generation: 1, target: 'test-service', hash: envelope.hash, oldResourcesReleased: true });
    await concurrent.owner.release(t.token);
    checkEqual('a started target cannot rewrite its immutable import evidence', await errorCode(() => target.mutate((s) => { s.transfer.target = 'other'; })), 'IMMUTABLE_IMPORT');
  } finally { await concurrent.close(); }
  const uncertain = await cutoverFixture(path.join(base, 'uncertain-start'), { count: 1 });
  try {
    const { t, envelope } = await exported(uncertain); let effects = 0;
    const target = createSyntheticImporter({ root: uncertain.targetRoot, target: 'test-service', owner: uncertain.owner,
      testOnly: true, activate() { effects++; throw new Error('synthetic crash during target activation'); } });
    await uncertain.owner.imported(t.token, target.import(envelope)); await uncertain.owner.commit(t.token);
    checkEqual('a crash during activation is observed', await errorCode(() => target.start(t.token)), 'synthetic crash during target activation');
    checkEqual('uncertain activation cannot be automatically replayed', await errorCode(() => target.start(t.token)), 'TARGET_START_UNKNOWN');
    checkEqual('after activation uncertainty service keeps ownership and sources stay fenced', [effects, (await uncertain.owner.recover()).action,
      uncertain.owner.status().mode, uncertain.owner.status().admission], [1, 'recover-target', 'service', 'closed']);
  } finally { await uncertain.close(); }

  suite('P2 T53: current handback includes post-cutover work and never steals an unreachable service');
  const h = await cutoverFixture(path.join(base, 'handback'), { count: 1 });
  try {
    const result = await runSyntheticTransfer({ owner: h.owner, generation: 0, to: 'service', target: 'test-service',
      inventory: h.inventory(), sources: h.sources, importer: h.importer });
    h.importer.mutate((s) => { s.sources[0].instances.push({ id: 'service-created', cwd: h.targetRoot, queue: [{ text: 'post-cutover', state: 'unknown' }] });
      s.sources[0].queues.push({ instance: 'service-created', items: [{ text: 'post-cutover', state: 'unknown' }], hash: hash([{ text: 'post-cutover', state: 'unknown' }]) });
      s.ledger.instances['service-created'] = { cost: 7, tokens: 90, turns: 1, firstAt: 500, lastAt: 600 }; });
    const service = h.importer.member();
    const generation = h.owner.status().generation;
    await h.owner.disconnect(service.lease);
    let error; try { await h.owner.begin({ generation, to: 'window', target: 'window-return', inventory: { complete: true, scope: h.owner.scope, ids: [service.id], otherScopes: [] } }); }
    catch (e) { error = e; }
    checkEqual('an unreachable live service blocks handback by participant name', [error?.code, error?.blockers[0].id, error?.blockers[0].code], ['CUTOVER_BLOCKED', 'test-service', 'SOURCE_DISCONNECTED']);
    checkEqual('unreachable service leaves owner/service state intact', [h.owner.status().mode, h.owner.status().generation], ['service', 1]);
    const currentService = await h.owner.admit({ id: service.id, build: 'loaded-meta-build', metaVersion: 1, requested: 'service' });
    const gate = createParticipantGate({ owner: h.owner, member: currentService });
    const source = { member: currentService, quiesce: (t) => gate.quiesce(t, { closeAdmission() {}, cancel() {}, drain() {}, flush() {}, detach() {},
      releaseResources: () => ({ released: true, owned: [] }),
      exportState: () => {
        const latest = h.importer.snapshot().state, state = structuredClone(latest.sources[0]); state.ledger = latest.ledger;
        state.provenance.workspace = h.targetRoot; return state;
      } }) };
    const returnRoot = path.join(path.dirname(h.targetRoot), 'b'); mkdir(returnRoot); let returnStarts = 0;
    const back = createSyntheticImporter({ root: returnRoot, target: 'window-return', owner: h.owner, testOnly: true, activate() { returnStarts++; } });
    checkEqual('a pre-cutover export cannot be imported for a current generation', await errorCode(() => back.import(result.envelope)), 'IMPORT_SCOPE_CONFLICT');
    const forged = structuredClone(result.envelope); forged.value.target = 'window-return'; forged.hash = hash(forged.value);
    checkEqual('renaming a stale backup target cannot authorize handback', await errorCode(() => back.import(forged)), 'STALE_EXPORT');
    await runSyntheticTransfer({ owner: h.owner, generation: 1, to: 'window', target: 'window-return',
      inventory: { complete: true, scope: h.owner.scope, ids: [service.id], otherScopes: [] }, sources: [source], importer: back });
    const latest = back.snapshot().state;
    checkEqual('handback commits another generation and starts only the selected target', [h.owner.status().mode, h.owner.status().generation, returnStarts], ['window', 2, 1]);
    check('current handback retains service-created IDs and unresolved queued payloads', latest.transfer.sources[0].state.instances.some((s) => s.id === 'service-created') &&
      latest.transfer.sources[0].state.queues.some((q) => q.items.some((v) => v.text === 'post-cutover' && v.state === 'unknown')));
    checkEqual('post-cutover accounting is retained without replay/sum', latest.ledger.instances['service-created'].cost, 7);
    checkEqual('the old service lease cannot write after handback', await errorCode(() => h.owner.effect(currentService.lease, 1, () => {})), 'STALE_GENERATION');
  } finally { await h.close(); }

  suite('P2 T53: only complete current authority preserves receipts and runnable scope');
  const authorityDir = path.join(base, 'a'); mkdir(authorityDir);
  const authority = await openAuthority({ file: path.join(authorityDir, 'authority.jsonl') });
  try {
    await authority.commit((s) => { s.entries.push(receipt(s, 1), receipt(s, 2));
      s.outbox.push(intent(s, 1), intent(s, 2, { text: 'effected input' }, { state: 'completed' }), intent(s, 3, { text: 'already unknown' }, { state: 'unknown' })); });
    const saved = authority.snapshot(), complete = restoreAuthority(saved, true), incomplete = restoreAuthority(saved, false);
    checkEqual('a complete current authority retains exact receipt/outbox bytes and scope', complete, saved);
    check('an incomplete authority changes the client receipt scope', incomplete.scope !== saved.scope);
    checkEqual('incomplete restore quarantines runnable work and retains effected/unknown outcomes', incomplete.outbox.map((q) => q.state), ['unknown', 'completed', 'unknown']);
    checkEqual('quarantined items retain original mid and scope', incomplete.outbox.map((q) => [q.mid, q.scope]), saved.outbox.map((q) => [q.mid, q.scope]));
  } finally { await authority.close(); }
};
