'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { disk, stamp, mid, errorCode } = require('./helpers/engine-disk');
const { createEngineState, DOMAIN } = require('../src/engineState');
const { canonical } = require('../src/protocolV2');
const { loadCorpus, validateSchema } = require('./helpers/protocol-v2-fixtures');

const ctx = (principal = 'device:phone-1', target = 'session:instance-7') => ({ authenticated: true, principal, target,
  role: target === 'fleet' ? 'fleet' : 'conversation', seat: { id: principal, control: true, local: false, editor: false } });
const message = (store, n, fields = {}) => ({ type: 'send', mid: mid(n), scope: store.snapshot().scope, issuedAt: stamp,
  text: 'full prompt ' + n, ...fields });
const fixtureRuntime = async (store, dir, options = {}) => {
  const runtime = await createEngineState({ authority: store, root: dir, now: () => stamp, ...options });
  if (!store.snapshot().values[DOMAIN].instances.length) await runtime.register({ id: 'instance-7', cwd: dir, prUrl: null });
  return runtime;
};

module.exports = async function () {
  suite('P1-14: complete outbox acceptance, restart, reclaim and nonreused IDs on real disk');
  const f = disk();
  try {
    let store = await f.open(), runtime = await fixtureRuntime(store, f.dir, { ready: () => false });
    const payload = { text: 'user text '.repeat(12000), sent: 'expanded snippet\n'.repeat(12000), snippets: ['review', 'second'],
      attachments: [{ name: 'original.png', mediaType: 'image/png', data: Buffer.alloc(128 * 1024, 0x37).toString('base64') }] };
    const m = message(store, 1, payload);
    const replies = await Promise.all(Array.from({ length: 8 }, () => runtime.dispatch(ctx(), m)));
    check('one accepted result for concurrent sends', replies.every((r) => r.outcome === 'applied' && r.result.code === 'accepted' && r.result.data.queueId === replies[0].result.data.queueId));
    let saved = store.snapshot();
    checkEqual('one full outbox input, no duplicate queue item', saved.outbox.length, 1);
    checkEqual('co-committed receipt references its complete payload', [saved.entries[0].requestRef, saved.outbox[0].id], [saved.outbox[0].id, saved.entries[0].requestRef]);
    const lastFrame = JSON.parse(fs.readFileSync(f.file, 'utf8').trim().split('\n').at(-1));
    check('acceptance and full input occupy the same durable frame', lastFrame.state.entries[0].outcome === 'applied' && canonical(lastFrame.state.outbox[0].payload.message) === canonical(m));
    const firstId = replies[0].result.data.queueId;
    await runtime.dispose(); await store.close();
    store = await f.open(); let delivered = 0, canDrain = false, exactInput = null;
    runtime = await fixtureRuntime(store, f.dir, { ready: () => canDrain, deliver: (item) => {
      delivered++; exactInput = item;
      checkEqual('dispatch marker is durable before provider adapter', store.snapshot().outbox.find((q) => q.id === item.id).state, 'dispatching');
      if (item.principal === 'device:phone-1') checkEqual('provider receives the full accepted images', item.payload.message.attachments, payload.attachments);
      return { state: 'accepted' };
    } });
    checkEqual('no recovery dispatch before timers/start', delivered, 0);
    saved = store.snapshot().outbox[0];
    checkEqual('all text/expanded/snippets/images survive reopen', [saved.payload.message.text, saved.payload.message.sent, saved.payload.message.snippets, saved.payload.message.attachments],
      [payload.text, payload.sent, payload.snippets, payload.attachments]);
    const edit = message(store, 2, { type: 'editQueued', id: firstId }); delete edit.text;
    const reclaimed = await runtime.dispatch(ctx(), edit);
    checkEqual('reclaim includes the full original draft', reclaimed.result?.replies, [{ type: 'editPrompt', ...payload }]);
    checkEqual('only committed reclaim removes runnable work', store.snapshot().outbox[0].state, 'discarded');
    const second = await runtime.dispatch(ctx(), message(store, 3, payload));
    check('queue ID cannot be reassigned after restart/reclaim', second.result.data.queueId !== firstId);
    const separate = await runtime.dispatch(ctx('device:phone-2'), message(store, 3, { text: 'same mid, another device' }));
    check('principal-qualified same-mid queues cannot collide', separate.result.data.queueId !== second.result.data.queueId);
    const pending = store.snapshot().outbox.filter((q) => q.state === 'queued');
    check('request references and provider correlations include principal identity', new Set(pending.map((q) => q.id)).size === 2 && new Set(pending.map((q) => q.correlation)).size === 2);
    canDrain = true; runtime.start(); await Promise.all([runtime.drain(ctx().target), runtime.drain(ctx().target)]);
    checkEqual('accepted queued work drains once per distinct intent', delivered, 2);
    checkEqual('adapter receives the second device\'s exact immutable input', exactInput.payload.message.text, 'same mid, another device');
    await runtime.drain(ctx().target); checkEqual('another drain cannot replay completed input', delivered, 2);
    const op = await runtime.operation(ctx(), { scope: m.scope, mid: mid(3) });
    checkEqual('engine acceptance receipt and provider submission stay separate', [op.state, (await runtime.dispatch(ctx(), message(store, 3, payload))).result.code], ['accepted', 'accepted']);
    await runtime.dispose(); await store.close(); store = await f.open();
    runtime = await fixtureRuntime(store, f.dir, { ready: () => true, deliver: () => { delivered++; return { state: 'accepted' }; } });
    runtime.start(); await runtime.drain(ctx().target);
    checkEqual('completed accepted work stays nonrunnable on another restart', delivered, 2);
    checkEqual('duplicate reclaimed draft remains complete after draining/restart', (await runtime.dispatch(ctx(), edit)).result, reclaimed.result);
    const third = await runtime.dispatch(ctx(), message(store, 4));
    check('persisted allocation counter survives multiple restarts', ![firstId, second.result.data.queueId, separate.result.data.queueId].includes(third.result.data.queueId));
    await runtime.dispose();
  } finally { await f.dispose(); }

  suite('P1-14: shared mutation fixtures drive current-state transactions');
  const corpus = loadCorpus(), local = disk();
  try {
    const store = await local.open(), runtime = await fixtureRuntime(store, local.dir, { ready: () => false });
    for (const id of ['mutation-fleet-instance-place-default', 'mutation-conversation-setsetting-default', 'mutation-conversation-clearqueue-default']) {
      const v = corpus.vectors.get(id), answers = [];
      // clearQueue's fixture starts with 2 entries.
      if (id.includes('clearqueue')) for (const n of [40, 41]) await runtime.dispatch(ctx(), message(store, n));
      for (const step of v.input) {
        const m = { ...step.message, scope: store.snapshot().scope, mid: id.includes('place') ? mid(20) : id.includes('setsetting') ? mid(21) : mid(22) };
        answers.push(await runtime.dispatch({ ...v.context, authenticated: true }, m));
      }
      check(id + ' durable terminal result and duplicate', answers[0].outcome === 'applied' && answers[1].status === 'duplicate');
      checkEqual(id + ' typed result', answers[0].result, v.expected.replies[0].result);
      for (const answer of answers) check(id + ' ack wire schema', validateSchema(answer, corpus.schema.$defs.ack, corpus.schema));
    }
    const setting = store.snapshot().values[DOMAIN].settings.user.model;
    checkEqual('setting transition and receipt are authoritative', setting, 'synthetic');
    const folderCtx = { ...ctx('local:owner', 'fleet'), seat: { id: 'local', control: true, local: true, editor: false } };
    const folderMessage = message(store, 50, { type: 'fixture:folder', name: 'One' }); delete folderMessage.text;
    const made = await runtime.localTransition(folderCtx, folderMessage, ({ state, message: m }) => {
      state.values[DOMAIN].folders.folders.push({ id: 'folder-fixed', name: m.name });
      return { code: 'ok', data: { folder: 'folder-fixed' }, replies: [] };
    });
    const place = message(store, 51, { type: 'instance:place', instance: 'instance-7', folderId: 'folder-fixed', id: 'original-correlation' }); delete place.text;
    checkEqual('folder creation commits its receipt', made.outcome, 'applied');
    checkEqual('assignment transition is committed with receipt', (await runtime.dispatch(ctx('device:phone-1', 'fleet'), place)).result.data.folderId, 'folder-fixed');
    const pane = message(store, 52, { type: 'pr:pane', prUrl: null, open: true, tab: 'threads', width: 500 }); delete pane.text;
    const p = await runtime.dispatch(ctx(), pane);
    checkEqual('metadata transition is committed with receipt', store.snapshot().values[DOMAIN].instances[0].prPane, p.result.data.pane);
    await runtime.dispose(); await store.close();
    const reopened = await local.open();
    checkEqual('settings/folders/metadata survive restart independently of mementos',
      [reopened.snapshot().values[DOMAIN].settings.user.model, reopened.snapshot().values[DOMAIN].folders.assign['instance-7'], reopened.snapshot().values[DOMAIN].instances[0].prPane],
      ['synthetic', 'folder-fixed', p.result.data.pane]);
  } finally { await local.dispose(); }

  suite('P1-14 runtime conformance: shared send/queue/metadata/watch-seat traces');
  const sharedIds = ['mutation-conversation-send-default', 'mutation-conversation-send-slash-command',
    'mutation-conversation-unqueue-default', 'mutation-conversation-promotequeued-default',
    'mutation-conversation-editqueued-default', 'mutation-conversation-pr-pane-default', 'seat-watch-pane'];
  for (const id of sharedIds) {
    const f = disk();
    try {
      const v = corpus.vectors.get(id), store = await f.open(), runtime = await fixtureRuntime(store, f.dir, { ready: () => false });
      const queueIds = new Map(), inverseIds = new Map();
      for (const [n, q] of (v.initial.queue || []).entries()) {
        const seeded = await runtime.dispatch(ctx(), message(store, 1000 + n, { text: q.text, sent: q.sent ?? null,
          snippets: q.snippets || [], attachments: q.attachments || [] }));
        queueIds.set(q.id, seeded.result.data.queueId); inverseIds.set(seeded.result.data.queueId, q.id);
      }
      const sequence = store.status().seq, replies = [], trusted = { ...v.context, authenticated: true };
      for (const step of v.input) if (step.direction === 'client') {
        const m = { ...step.message, scope: store.snapshot().scope };
        if (queueIds.has(m.id)) m.id = queueIds.get(m.id);
        const reply = await runtime.dispatch(trusted, m);
        if (m.type === 'send' && reply.result) inverseIds.set(reply.result.data.queueId, 'q-29');
        replies.push(reply);
      }
      const normalized = (reply) => {
        const copy = structuredClone(reply); copy.scope = v.expected.replies[0].scope;
        if (copy.result?.data.queueId) copy.result.data.queueId = inverseIds.get(copy.result.data.queueId);
        return copy;
      };
      checkEqual(id + ' runtime replies', replies.map(normalized), v.expected.replies);
      checkEqual(id + ' exactly one authoritative mutation', store.status().seq - sequence, 1);
      if (id.includes('promotequeued')) checkEqual('shared reorder never implicitly steers', store.snapshot().outbox.filter((q) => q.state === 'queued').map((q) => inverseIds.get(q.queueId)), ['q-29', 'q-28']);
      for (const reply of replies) check(id + ' wire schema', validateSchema(reply, corpus.schema.$defs.ack, corpus.schema));
      await runtime.dispose();
    } finally { await f.dispose(); }
  }

  suite('P1-14: unknown, stale backups, capacity and storage failures never return runnable work');
  const uncertain = disk();
  try {
    let store = await uncertain.open(), calls = 0;
    let runtime = await fixtureRuntime(store, uncertain.dir, { ready: () => true, deliver: () => { calls++; throw new Error('lost provider reply'); } });
    const first = message(store, 60), a = await runtime.dispatch(ctx(), first);
    const backup = store.snapshot();
    runtime.start(); await runtime.drain(ctx().target);
    checkEqual('possible provider write produces an unknown operation', (await runtime.operation(ctx(), first)).state, 'unknown');
    checkEqual('accepted receipt is immutable when provider delivery is unknown', (await runtime.dispatch(ctx(), first)).result, a.result);
    await runtime.dispatch(ctx(), message(store, 61)); await runtime.drain(ctx().target);
    checkEqual('unknown operation fences later queue drain on its conversation', calls, 1);
    await runtime.dispose(); await store.close(); store = await uncertain.open();
    runtime = await fixtureRuntime(store, uncertain.dir, { ready: () => true, deliver: () => { calls++; return { state: 'accepted' }; } });
    runtime.start(); await runtime.drain(ctx().target);
    checkEqual('unknown barrier is rebuilt before restart drains', calls, 1);
    await runtime.dispose(); await store.restoreBackup(backup);
    runtime = await fixtureRuntime(store, uncertain.dir, { ready: () => true, deliver: () => { calls++; return { state: 'accepted' }; } });
    runtime.start(); await runtime.drain(ctx().target);
    checkEqual('stale backup changes scope and quarantines queued work', [store.snapshot().scope !== backup.scope, store.snapshot().outbox[0].state, calls], [true, 'unknown', 1]);
    await runtime.dispose();
  } finally { await uncertain.dispose(); }

  const failure = disk();
  try {
    let arm = false, calls = 0;
    const store = await failure.open({ hook: async (stage) => { if (arm && stage === 'append:written') { arm = false; throw Object.assign(new Error('fixture crash after marker write'), { code: 'EIO' }); } } });
    let runtime = await fixtureRuntime(store, failure.dir, { ready: () => true, deliver: () => { calls++; return { state: 'accepted' }; } });
    const m = message(store, 70); await runtime.dispatch(ctx(), m); runtime.start(); arm = true;
    checkEqual('uncertain dispatch-marker fsync refuses before provider call', await errorCode(() => runtime.drain(ctx().target)), 'STORAGE_UNAVAILABLE');
    checkEqual('no provider call after failed dispatch commit', calls, 0);
    await runtime.dispose(); await store.close();
    const recovered = await failure.open(); runtime = await fixtureRuntime(recovered, failure.dir, { ready: () => true, deliver: () => { calls++; return { state: 'accepted' }; } });
    checkEqual('written but unacknowledged marker recovers unknown before timers', (await runtime.operation(ctx(), m)).state, 'unknown');
    runtime.start(); await runtime.drain(ctx().target); checkEqual('ambiguous marker gap never auto-dispatches', calls, 0);
    await runtime.dispose();
  } finally { await failure.dispose(); }

  suite('P1-14: actual child exit and reopen keep full accepted input; dispatch crash quarantines it');
  const childDisk = disk();
  try {
    const payload = { text: 'full text '.repeat(16000), sent: 'expanded '.repeat(20000), snippets: ['one', 'two'], attachments: [
      { name: 'persist.webp', mediaType: 'image/webp', data: Buffer.alloc(65536, 0x41).toString('base64') }] };
    fs.writeFileSync(path.join(childDisk.dir, 'input.json'), JSON.stringify(payload), { mode: 0o600 });
    const worker = path.join(__dirname, 'fixtures/engine/outbox-worker.js');
    const accepted = cp.spawnSync(process.execPath, [worker, childDisk.dir, 'accept'], { encoding: 'utf8', timeout: 10000 });
    checkEqual('first isolated process commits acceptance before abrupt exit', accepted.status, 77);
    let store = await childDisk.open(), runtime = await fixtureRuntime(store, childDisk.dir, { ready: () => false });
    const outbox = store.snapshot().outbox[0];
    checkEqual('full typed work survives real process death', [outbox.payload.message.text, outbox.payload.message.sent, outbox.payload.message.snippets, outbox.payload.message.attachments],
      [payload.text, payload.sent, payload.snippets, payload.attachments]);
    await runtime.dispose(); await store.close();
    const crash = cp.spawnSync(process.execPath, [worker, childDisk.dir, 'dispatch-crash'], { encoding: 'utf8', timeout: 10000 });
    checkEqual('second process exits at its persisted provider boundary', crash.status, 78);
    store = await childDisk.open(); let effects = 0;
    runtime = await fixtureRuntime(store, childDisk.dir, { ready: () => true, deliver: () => { effects++; return { state: 'accepted' }; } });
    runtime.start(); await runtime.drain(ctx().target);
    checkEqual('dispatch crash is unknown, retains input and never drains', [store.snapshot().outbox[0].state, store.snapshot().outbox[0].payload.message.text.length, effects], ['unknown', payload.text.length, 0]);
    await runtime.dispose();
  } finally { await childDisk.dispose(); }

  suite('P1-14: measured result reservations, full-size payloads and active operation bounds');
  const capacity = disk();
  try {
    const store = await capacity.open({ limits: { maxOutbox: 2 } }); let calls = 0, allowed = true;
    const runtime = await fixtureRuntime(store, capacity.dir, { ready: () => true,
      authorize: ({ access }) => access === 'view' || allowed, deliver: () => { calls++; return { state: 'accepted' }; } });
    await runtime.dispatch(ctx(), message(store, 100)); await runtime.dispatch(ctx(), message(store, 101));
    const third = message(store, 102);
    checkEqual('active-outbox bound refuses before another acceptance', (await runtime.dispatch(ctx(), third)).error.code, 'RECEIPT_FULL');
    allowed = false; runtime.start(); await runtime.drain(ctx().target);
    checkEqual('revoked fresh-dispatch authority holds queued work', calls, 0);
    allowed = true; await runtime.drain(ctx().target);
    checkEqual('restored current authority permits each accepted queued intent once', calls, 2);
    checkEqual('provider-accepted work still consumes active capacity', (await runtime.dispatch(ctx(), third)).error.code, 'RECEIPT_FULL');
    const completed = await runtime.settleOperation({ scope: third.scope, principal: ctx().principal, mid: mid(100) }, { state: 'completed' }, 'fixture:exact-provider-completion');
    checkEqual('exact completion evidence releases active capacity', completed.state, 'completed');
    checkEqual('same unadmitted envelope can be accepted once capacity is released', (await runtime.dispatch(ctx(), third)).outcome, 'applied');
    checkEqual('completion cannot reassign a queue ID or receipt', (await runtime.dispatch(ctx(), message(store, 100))).status, 'duplicate');
    await runtime.dispose();
  } finally { await capacity.dispose(); }
  const drafts = disk();
  try {
    const store = await drafts.open({ limits: { maxResultBytes: 32768 } }), runtime = await fixtureRuntime(store, drafts.dir, { ready: () => false });
    const sending = message(store, 110, { text: 'exact immutable prompt '.repeat(2400) });
    const answer = await runtime.dispatch(ctx(), sending), edit = { type: 'editQueued', mid: mid(111), issuedAt: stamp, scope: sending.scope, id: answer.result.data.queueId };
    checkEqual('reclaim measures full draft against result limit before removal', (await runtime.dispatch(ctx(), edit)).error.code, 'RECEIPT_FULL');
    checkEqual('failed reclaim retains complete queued draft', [store.snapshot().outbox[0].state, store.snapshot().outbox[0].payload.message.text.length], ['queued', sending.text.length]);
    const mutable = message(store, 112, { text: 'before first await' }), pending = runtime.dispatch(ctx(), mutable); mutable.text = 'edited after first attempt';
    await pending;
    checkEqual('runtime freezes intent before waiting for metadata work', store.snapshot().outbox[1].payload.message.text, 'before first await');
    await runtime.dispose();
  } finally { await drafts.dispose(); }
  const large = disk();
  try {
    const store = await large.open(), runtime = await fixtureRuntime(store, large.dir, { ready: () => false });
    const text = 'x'.repeat(14 * 1024 * 1024), input = message(store, 120, { text });
    const a = await runtime.dispatch(ctx(), input);
    checkEqual('14 MiB prompt is stored once without a hidden half-size limit', [a.outcome, store.snapshot().outbox[0]?.payload.message.text.length], ['applied', text.length]);
    const edit = { type: 'editQueued', mid: mid(121), issuedAt: stamp, scope: input.scope, id: a.result.data.queueId };
    const reclaimed = await runtime.dispatch(ctx(), edit);
    checkEqual('full-size reclaim fits the advertised result bound', [reclaimed.outcome, reclaimed.result?.replies[0].text.length], ['applied', text.length]);
    const tooBig = await runtime.dispatch(ctx(), message(store, 122, { text: 'z'.repeat(15 * 1024 * 1024) }));
    checkEqual('payload over the enclosing 15 MiB bound refuses without truncation', [tooBig.error.code, store.snapshot().outbox.length], ['RECEIPT_FULL', 1]);
    await runtime.dispose();
  } finally { await large.dispose(); }

  suite('P1-14: actual daemon recovers outbox rather than lossy service mementos');
  const service = disk(); let daemon;
  try {
    const { startDaemon } = require('../src/daemonRuntime');
    const options = { root: service.dir + '/d', adapters: { tools: { knownDirs: [], lookup: async () => ({ tools: {}, available: false }) } } };
    daemon = await startDaemon(options);
    const session = daemon.engine.manager.create({ id: 'persistent-service', cwd: daemon.paths.home, autoStart: false });
    session.pause({ until: Date.now() + 60000, quiet: true });
    const text = 'beyond the memento cap '.repeat(1600), sent = text + '\nexpanded standing instruction', attachments = [
      { name: 'durable.png', mediaType: 'image/png', data: Buffer.alloc(5000, 0x65).toString('base64') }];
    const accepted = await session.submit(text, attachments, { sent, snippets: ['one', 'two'] });
    checkEqual('ordinary isolated service submit is durably accepted', accepted.result.code, 'accepted');
    await daemon.graph.currentState.flush();
    const mirror = daemon.engine.manager.context.workspaceState;
    checkEqual('service mirror retains the existing window serialization', [mirror.get('nikui.sessions.v1')[0].queue[0].text.length, mirror.get('nikui.sessions.v1')[0].queue[0].images], [8000, 1]);
    await daemon.stop(); daemon = null;
    const { createTestStore } = require('../src/daemonStore');
    const stale = createTestStore(options.root + '/state/workspace.test.json', { testOnly: true });
    stale.update('nikui.sessions.v1', [{ id: 'forged-mirror', cwd: service.dir + '/untrusted', queue: [{ id: 'q0', text: 'must not recover' }] }]); stale.dispose();
    daemon = await startDaemon(options);
    const restored = daemon.engine.manager.get('persistent-service');
    check('stale service mirror cannot create or retarget an instance', !!restored && !daemon.engine.manager.get('forged-mirror'));
    checkEqual('authoritative restored queue retains text/expanded/snippets/images', [restored.queue[0].text.length, restored.queue[0].sent === sent,
      restored.queue[0].snippets, restored.queue[0].attachments], [text.length, true, ['one', 'two'], attachments]);
    const draft = await restored.reclaim(restored.queue[0].id);
    checkEqual('legacy service reclaim awaits full durable draft', [draft.text.length, draft.sent === sent, draft.attachments], [text.length, true, attachments]);
    const folder = daemon.engine.folders.create('Persisted folder'); await daemon.graph.currentState.flush();
    check('service folder IDs use a nonreused random namespace', /^f-[a-f0-9]{32}$/.test(folder.id));
    checkEqual('service folder commits before its mirror', daemon.graph.authority.snapshot().values[DOMAIN].folders.folders[0], folder);
    const closing = daemon.engine.manager.create({ id: 'retired-service', cwd: daemon.paths.home, autoStart: false });
    const queued = await closing.submit('cancel when this instance closes', []);
    daemon.engine.manager.remove(closing.id); await daemon.graph.currentState.flush();
    const closed = daemon.graph.authority.snapshot();
    checkEqual('closing an instance durably retires its ID and cancels only queued input', [closed.values[DOMAIN].retiredInstances.includes(closing.id),
      closed.outbox.find((q) => q.mid === queued.mid).state], [true, 'discarded']);
    checkEqual('retired instance IDs cannot name new work', await errorCode(() => daemon.engine.manager.create({ id: closing.id, cwd: daemon.paths.home, autoStart: false })), 'STALE_RESOURCE');
    const historical = await daemon.graph.currentState.dispatcher.lookup({ authenticated: true, principal: 'local:legacy', role: 'fleet', target: 'fleet',
      seat: { id: 'owner', local: true, control: true, editor: false } }, { type: 'receipt:get', scope: queued.scope, mid: queued.mid });
    checkEqual('fleet lookup retains accepted receipt after instance removal', [historical.status, historical.result.code], ['duplicate', 'accepted']);
    daemon.engine.manager.pauseForLimit({ status: 'rejected', at: Date.now(), resetsAt: Date.now() + 60000 });
    await daemon.graph.currentState.flush(); const until = daemon.engine.manager.pause.until;
    checkEqual('quota pause is authoritative current state', daemon.graph.authority.snapshot().values[DOMAIN].account.pause.until, until);
    await daemon.stop(); daemon = null;
    const staleAccount = createTestStore(options.root + '/state/engine.test.json', { testOnly: true });
    staleAccount.update('nikui.pause.v1', null); staleAccount.dispose();
    daemon = await startDaemon(options);
    checkEqual('pause recovery precedes quota timer restoration and ignores stale mirror', [daemon.engine.manager.pause.until, !!daemon.engine.manager._resumeTimer], [until, true]);
    daemon.engine.manager.resumeFromLimit({ manual: true }); await daemon.graph.currentState.flush();
    check('manual quota override and pause removal are committed', daemon.graph.authority.snapshot().values[DOMAIN].account.pause === null &&
      daemon.graph.authority.snapshot().values[DOMAIN].account.limitOverride > 0);
  } finally { if (daemon) await daemon.stop(); await service.dispose(); }

  suite('P1-14: operation completion space remains reserved when other state fills the store');
  const reserved = disk();
  try {
    const store = await reserved.open({ limits: { maxBytes: 70000 } });
    const runtime = await fixtureRuntime(store, reserved.dir, { ready: () => true,
      deliver: () => ({ state: 'unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'x'.repeat(2048), retryable: false } }) });
    const accepted = await runtime.dispatch(ctx(), message(store, 160));
    const saved = store.snapshot(), reservedBytes = saved.outbox[0].reservedOperationBytes;
    check('send acceptance reserves later operation disposition space', reservedBytes > 2048);
    checkEqual('another transition cannot steal operation reservation', await errorCode(() => store.commit((next) => {
      next.outbox[0].reservedOperationBytes = 0;
    })), 'AUTHORITY_INVALID');
    const accounted = Buffer.byteLength(JSON.stringify(saved)) + reservedBytes + 1024;
    await store.commit((next) => { next.values.padding = 'x'.repeat(70000 - accounted - 300); });
    runtime.start(); await runtime.drain(ctx().target);
    const op = await runtime.operation(ctx(), { scope: accepted.scope, mid: accepted.mid });
    checkEqual('reserved unknown completion persists in a nearly full store', [op.state, op.error.message.length, store.status().writable], ['unknown', 2048, true]);
    await runtime.dispose();
  } finally { await reserved.dispose(); }

  suite('P1-14: provider-neutral accepted input freezes its Codex account/thread before restart');
  const codexDisk = disk();
  try {
    let store = await codexDisk.open(), runtime = await fixtureRuntime(store, codexDisk.dir, { ready: () => false });
    const target = 'session:codex-fixture', principal = ctx().principal, trusted = ctx(principal, target), home = codexDisk.dir + '/.codex-work';
    await runtime.register({ id: 'codex-fixture', provider: 'codex', cwd: codexDisk.dir, threadId: 'thread-original', account: home });
    const input = message(store, 170, { text: 'Codex full prompt '.repeat(1600), sent: 'expanded Codex standing instruction', snippets: ['original'],
      attachments: [{ name: 'codex.png', mediaType: 'image/png', data: Buffer.from('codex-image').toString('base64') }] });
    await runtime.dispatch(trusted, input); await runtime.dispose(); await store.close();
    store = await codexDisk.open(); let delivered = 0, captured;
    runtime = await fixtureRuntime(store, codexDisk.dir, { ready: () => true, deliver: (item) => {
      delivered++; captured = item;
      return { state: 'accepted', provider: { kind: 'codex', account: 'fixture-account-id', threadId: item.payload.providerTarget.threadId,
        clientUserMessageId: item.correlation, turnId: 'turn-original', ownership: 'borrowed', writer: 'external' } };
    } });
    const local = { ...ctx('local:owner', 'fleet'), seat: { id: 'owner', local: true, control: true, editor: false } };
    const edit = message(store, 171, { type: 'fixture:provider-target', threadId: 'changed-thread' }); delete edit.text;
    await runtime.localTransition(local, edit, ({ state }) => {
      state.values[DOMAIN].instances.find((s) => s.id === 'codex-fixture').threadId = 'changed-thread';
      return { code: 'ok', data: {}, replies: [] };
    });
    runtime.start(); await runtime.drain(target);
    checkEqual('restart dispatch uses frozen account/thread and full input', [captured.payload.providerTarget.account, captured.payload.providerTarget.threadId,
      captured.payload.message.text.length, captured.payload.message.attachments], [home, 'thread-original', input.text.length, input.attachments]);
    const op = await runtime.operation(trusted, input);
    check('provider correlation is stable and principal qualified', op.provider.clientUserMessageId === captured.correlation && captured.id.includes(principal));
    await runtime.drain(target); checkEqual('provider-neutral queue drains one time', delivered, 1);
    check('Codex operation wire model is valid', validateSchema(op, corpus.schema.$defs.operation, corpus.schema));
    await runtime.dispose();
  } finally { await codexDisk.dispose(); }

  suite('P1-14: local transition functions cannot become network handlers while pending');
  const isolated = disk();
  try {
    const store = await isolated.open(), runtime = await fixtureRuntime(store, isolated.dir, { ready: () => false });
    const local = { ...ctx('local:owner', 'fleet'), seat: { id: 'owner', local: true, control: true, editor: false } };
    const m = message(store, 180, { type: 'fixture:private-folder', name: 'Local only' }); delete m.text;
    const creating = runtime.localTransition(local, m, ({ state, message }) => {
      state.values[DOMAIN].folders.folders.push({ id: message.mid, name: message.name });
      return { code: 'ok', data: { folder: message.mid }, replies: [] };
    });
    const remote = runtime.dispatch(ctx('device:phone-1', 'fleet'), { ...m, mid: mid(181) });
    checkEqual('local transition commits once', (await creating).outcome, 'applied');
    checkEqual('simultaneous remote message remains unsupported', (await remote).error.code, 'UNSUPPORTED');
    checkEqual('private transition never enters shared handler catalog', store.snapshot().values[DOMAIN].folders.folders.length, 1);
    await runtime.dispose();
  } finally { await isolated.dispose(); }

  suite('P1-14: recovered accepted queue starts only its fake provider and drains once');
  const startup = disk(), children = [], inputs = [], launches = []; let owner;
  try {
    const { startDaemon } = require('../src/daemonRuntime');
    const options = { root: startup.dir + '/d', adapters: {
      tools: { knownDirs: [], lookup: async () => ({ tools: {}, available: false }) },
      claudeSpawn: (_cmd, args, opts) => {
        launches.push(args);
        const proc = cp.spawn(process.execPath, [path.join(__dirname, 'helpers/fake-claude.js'), ...args],
          { ...opts, env: { ...opts.env, FAKE_WORDS: '2', FAKE_MS: '1' } }); children.push(proc);
        const write = proc.stdin.write.bind(proc.stdin);
        proc.stdin.write = (line, ...rest) => { const m = JSON.parse(String(line)); if (m.type === 'user') inputs.push(m); return write(line, ...rest); };
        return proc;
      }
    } };
    owner = await startDaemon(options);
    const s = owner.engine.manager.create({ id: 'queued-restart', cwd: owner.paths.home, autoStart: false });
    s.model = 'frozen-model'; s.pause({ until: Date.now() + 60000, quiet: true });
    const accepted = await s.submit('one provider input', [{ name: 'input.png', mediaType: 'image/png', data: Buffer.from('fixture-image').toString('base64') }],
      { sent: 'full expanded instruction', snippets: ['standing'] });
    await owner.graph.host.setSetting('model', 'later-model');
    checkEqual('paused accepted input starts no provider before shutdown', children.length, 0);
    await owner.stop(); owner = await startDaemon(options);
    const end = Date.now() + 5000;
    while (owner.engine.manager.get(s.id).status !== 'done' && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    await owner.graph.currentState.flush();
    checkEqual('startup drains accepted queued work once without a client', [inputs.length, owner.engine.manager.get(s.id).turns], [1, 1]);
    check('recovered queue uses its frozen launch settings', launches[0].includes('frozen-model') && !launches[0].includes('later-model'));
    checkEqual('fake provider receives the complete expanded text and image', inputs[0].message.content.map((b) => b.type === 'text' ? b.text : b.source.data),
      [Buffer.from('fixture-image').toString('base64'), 'full expanded instruction']);
    const operation = await owner.graph.currentState.operation({ authenticated: true, principal: 'local:legacy', role: 'fleet', target: 'fleet',
      seat: { id: 'local', local: true, control: true, editor: false } }, { scope: accepted.scope, mid: accepted.mid });
    checkEqual('observed completion from the same fixture execution is durable', operation.state, 'completed');
    await owner.stop(); owner = await startDaemon(options);
    await owner.graph.currentState.drain('session:' + s.id);
    checkEqual('later restart cannot send completed accepted input again', inputs.length, 1);
  } finally {
    if (owner) await owner.stop();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await startup.dispose();
  }
};
