'use strict';

const { loadCorpus, canonical: fixtureCanonical, validateSchema } = require('./helpers/protocol-v2-fixtures');
const { disk, receipt, stamp, mid, deferred, errorCode } = require('./helpers/engine-disk');
const { CORE, canonical, requestHash, createNegotiation, failure } = require('../src/protocolV2');
const { createReceiptDispatcher, keyOf } = require('../src/receiptDispatcher');

const context = (principal = 'device:phone-1', target = 'session:instance-7') => ({ authenticated: true, principal,
  role: target === 'fleet' ? 'fleet' : 'conversation', target, seat: { id: principal.slice(7), control: true, local: false, editor: false } });
const accepted = (m) => ({ code: 'accepted', data: { instance: 'instance-7', queueId: 'q-29', operation: m.mid }, replies: [] });
const granted = () => true;
const shape = (value) => {
  const out = structuredClone(value);
  if (out.error) delete out.error.message;
  if (out.type.endsWith(':error') || out.type === 'protocol:error') delete out.message;
  return out;
};

module.exports = async function () {
  const corpus = loadCorpus();
  suite('R14: indexed receipt lookup remains bounded at 10,000 retained entries');
  const indexed = disk();
  try {
    let at = stamp, store = await indexed.open({ now: () => at });
    const ctx = context(), original = { type: 'send', scope: store.receiptInfo().scope, mid: mid(10000), issuedAt: stamp, text: 'tail receipt' };
    await store.commit((state) => {
      for (let n = 1; n <= 10000; n++) state.entries.push(receipt(state, n, {
        principal: ctx.principal, target: ctx.target,
        ...(n === 10000 ? { hash: requestHash(original, ctx.target), expiresAt: stamp + 2 * 86400000, result: accepted(original) } : {}) }));
    });
    const d = createReceiptDispatcher({ authority: store, authorize: () => true, now: () => at }); await d.recover();
    let commits = 0, snapshots = 0, lookups = 0;
    const commit = store.commit, snapshot = store.snapshot, lookup = store.lookup;
    store.commit = (...args) => { commits++; return commit(...args); };
    store.snapshot = (...args) => { snapshots++; return snapshot(...args); };
    store.lookup = (...args) => { lookups++; return lookup(...args); };
    const answers = await Promise.all(Array.from({ length: 100 }, () => d.dispatch(ctx, original)));
    check('10k tail duplicate queries share the original result', answers.every((answer) => answer.status === 'duplicate' && answer.result.data.operation === original.mid));
    checkEqual('100 duplicate messages never scan/clone/commit the retained state', [commits, snapshots, lookups], [0, 0, 100]);
    const olderSnapshot = store.snapshot();
    at += 86400000 + store.limits.skewMs + 1;
    await store.prune(); await store.compact();
    checkEqual('index follows pruning and compaction without a stale position', [(await d.dispatch(ctx, original)).result, store.snapshot().entries.length], [accepted(original), 1]);
    checkEqual('in-flight older snapshots retain their own indexed positions across pruning', store.findReceipt(olderSnapshot, keyOf({ ...original, principal: ctx.principal })).result, accepted(original));
    await d.dispose(); await store.close(); store = await indexed.open({ now: () => at });
    checkEqual('disk reopen rebuilds the index from authoritative entries', (await store.lookup({ ...original, principal: ctx.principal })).result, accepted(original));
  } finally { await indexed.dispose(); }
  suite('P1-13 runtime conformance: canonical hashing uses all 14 shared preimages');
  for (const v of corpus.vectors.values()) if (v.hash) {
    const m = v.input[0].message, copy = { ...m }; delete copy.mid; delete copy.scope;
    checkEqual(v.id + ' runtime canonical preimage', canonical({ message: copy, target: v.context.target }), v.hash.canonical);
    checkEqual(v.id + ' runtime digest', requestHash(m, v.context.target), v.hash.sha256);
  }
  for (const value of ['\ud800', '\udfff', { '\ud800': 'bad' }, NaN, Infinity, undefined, { a: undefined }, new Date(), [, 1]]) {
    checkEqual('canonicalizer rejects non-JSON/ill-formed Unicode ' + String(value), await errorCode(() => canonical(value)), 'BAD_MESSAGE');
  }
  const cyclic = {}; cyclic.self = cyclic;
  checkEqual('cycles fail closed', await errorCode(() => canonical(cyclic)), 'BAD_MESSAGE');
  checkEqual('UTF-16 ordering, ECMAScript numeric/escape boundaries and nested envelope names', canonical({ '\u{10000}': '\n\t\u0001', '\ue000': -0,
    numbers: [1e21, 1e-7, 0.000001, 1.25], mid: { scope: null } }), fixtureCanonical({ '\u{10000}': '\n\t\u0001', '\ue000': -0,
    numbers: [1e21, 1e-7, 0.000001, 1.25], mid: { scope: null } }));
  checkEqual('ECMAScript numeric boundaries have exact canonical spelling', canonical([-0, Number.MIN_VALUE, 1e-6, 1e-7, 1e20, 1e21, Number.MAX_VALUE, 9007199254740992]),
    '[0,5e-324,0.000001,1e-7,100000000000000000000,1e+21,1.7976931348623157e+308,9007199254740992]');
  checkEqual('control, quote, backslash and slash escaping is exact', canonical('\0\b\t\n\f\r"\\/'), String.raw`"\u0000\b\t\n\f\r\"\\/"`);

  suite('P1-13 runtime conformance: authenticated socket negotiation from shared traces');
  let negotiationCount = 0;
  for (const v of corpus.vectors.values()) if (v.id.startsWith('negotiation-') &&
      !['negotiation-new-client-old-host', 'negotiation-direct-webview-legacy'].includes(v.id)) {
    const replies = [], dispatched = []; let close = null, timeout;
    const welcome = corpus.vectors.get('negotiation-v2-fleet').expected.replies[0];
    const socket = createNegotiation({ authenticated: true, context: { ...v.context, authenticated: true },
      sealed: v.initial.sealed !== false, testOnlyV2: true, caps: v.initial.implementedCaps || CORE,
      engine: welcome.engine, receipts: welcome.receipts, now: () => stamp,
      post: (m) => replies.push(m), close: (code) => { close = code; },
      timers: { setTimeout: (fn) => { timeout = fn; return 1; }, clearTimeout: () => { timeout = null; } },
      legacy: (m) => { dispatched.push(m); if (m.type === '@listen') replies.push({ type: '@listener', secret: 'synthetic-private-bearer' }); },
      receive: () => { throw new Error('Negotiation trace unexpectedly dispatched v2 work'); } });
    for (const step of v.input) {
      if (step.direction === 'server' && step.message.type === '@welcome') checkEqual(v.id + ' advertisement', socket.advertisement,
        { proto: step.message.proto, caps: step.message.caps });
      if (step.direction === 'client') await socket.receive(step.message);
      else if (step.message.type === 'advance-time') timeout();
    }
    checkEqual(v.id + ' replies', replies.map(shape), v.expected.replies.map(shape));
    checkEqual(v.id + ' close', close, v.expected.close);
    if (v.expected.state.proto) checkEqual(v.id + ' pinned protocol', socket.proto, v.expected.state.proto);
    if (v.expected.state.unchangedDispatch) checkEqual(v.id + ' unchanged legacy payload', dispatched, v.input.filter((s) => s.direction === 'client').map((s) => s.message));
    socket.dispose(); negotiationCount++;
  }
  checkEqual('19 applicable server negotiation vectors executed by runtime', negotiationCount, 19);
  checkEqual('unauthenticated construction is refused', await errorCode(() => createNegotiation({ authenticated: false, context: context() })), 'FORBIDDEN');
  const production = createNegotiation({ authenticated: true, context: context(), sealed: true, engine: {}, post() {}, close() {} });
  checkEqual('partial runtime cannot advertise v2 by default', production.advertisement, { proto: { min: 1, max: 1 }, caps: [] }); production.dispose();
  for (const length of [80, 81]) {
    const replies = [], welcome = corpus.vectors.get('negotiation-v2-fleet').expected.replies[0];
    const socket = createNegotiation({ authenticated: true, context: context(), sealed: true, testOnlyV2: true,
      engine: welcome.engine, receipts: welcome.receipts, now: () => stamp, post: (m) => replies.push(m), close() {} });
    await socket.receive({ type: 'hello', proto: { min: 2, max: 2 }, caps: CORE,
      client: { id: mid(79), kind: 'test', version: '😀'.repeat(length) } });
    checkEqual('version label counts Unicode characters: ' + length, replies[0].type, length === 80 ? 'welcome' : 'protocol:error');
    socket.dispose();
  }

  suite('P1-13 runtime conformance: 20 shared receipt traces on the real JSONL authority');
  let receiptCount = 0;
  for (const v of corpus.vectors.values()) if (v.id.startsWith('receipt-')) {
    const f = disk(); let store, dispatcher, effects = { engine: 0, provider: 0, ui: 0 };
    try {
      let at = stamp, view = v.initial.receiptViewAuthorized !== false && v.id !== 'receipt-query-error-forbidden';
      store = await f.open({ now: () => at });
      const state = store.snapshot(), fixtureScope = '981aa39d3e3a4f389f0ff600657d42d9';
      // Fixture IDs/times stay exact; replace only the disk-generated scope.
      const remap = (m) => ({ ...m, scope: m.scope === fixtureScope ? state.scope : m.scope });
      const first = remap(v.input.find((s) => s.direction === 'client').message);
      const original = { type: 'send', mid: first.mid, scope: state.scope, issuedAt: stamp, text: 'original' };
      const seed = (principal = v.context.principal) => store.commit((next) => {
        next.entries.push(receipt(next, 1, { principal, mid: original.mid, target: 'session:instance-7', hash: requestHash(original, 'session:instance-7'),
          result: accepted(original) }));
      });
      if (v.initial.existingReceipt || v.initial.conversationRemoved || v.initial.expired) await seed();
      if (v.initial.otherPrincipalSameMid) await seed('device:phone-1');
      if (v.initial.receiptEntries) await store.commit((next) => {
        for (let n = 1; n <= 10000; n++) next.entries.push(receipt(next, n, { principal: 'device:capacity' }));
      });
      const permissionResult = { code: 'ok', data: { requestId: 'approval-11', run: first.run, allow: true, delivery: 'submitted' }, replies: [] };
      const handlers = {
        send: v.id === 'receipt-pending' ? { execute() { effects.engine++; return { outcome: 'pending' }; } }
          : { apply({ message }) { effects.engine++; return accepted(message); } },
        permission: v.id === 'receipt-unknown' ? { execute() { effects.provider++; return { outcome: 'unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'unknown', retryable: false } }; } }
          : { businessErrors: ['STALE_RUN'], apply() { throw failure('STALE_RUN'); } }
      };
      dispatcher = createReceiptDispatcher({ authority: store, handlers, authorize: () => view, now: () => at }); await dispatcher.recover();
      if (v.initial.now) at = v.initial.now;
      if (v.initial.storeAvailable === false || v.id === 'receipt-query-error-storage-unavailable') await store.close();
      const replies = [];
      for (const step of v.input) {
        const m = remap(step.message);
        if (step.direction === 'client') replies.push(await (m.type === 'receipt:get' ? dispatcher.lookup({ ...v.context, authenticated: true }, m) : dispatcher.dispatch({ ...v.context, authenticated: true }, m)));
        else if (m.type === 'durable-acceptance' || m.type === 'exact-delivery-evidence') await dispatcher.complete({ scope: state.scope, principal: v.context.principal, mid: original.mid },
          { outcome: 'applied', result: m.type === 'durable-acceptance' ? accepted(original) : permissionResult }, m.type === 'exact-delivery-evidence' ? 'fixture exact provider evidence' : null);
      }
      checkEqual(v.id + ' replies', replies.map(shape), v.expected.replies.map((r) => shape(remap(r))));
      checkEqual(v.id + ' effect counts', effects, v.expected.effects);
      for (const reply of replies) if (reply.type === 'ack') check(v.id + ' wire schema', validateSchema(reply, corpus.schema.$defs.ack, corpus.schema));
      receiptCount++;
    } finally { if (dispatcher) await dispatcher.dispose(); await f.dispose(); }
  }
  checkEqual('all receipt vectors ran against disk', receiptCount, 20);

  suite('P1-13 reservation races, revoked views, immutable intent and uncertain adapters');
  const f = disk();
  try {
    const store = await f.open(), entered = deferred(), release = deferred(); let count = 0, canView = true, canDispatch = true;
    const d = createReceiptDispatcher({ authority: store, now: () => stamp,
      authorize: ({ access }) => access === 'view' ? canView : canDispatch,
      handlers: { send: { execute: async ({ message }) => { count++; entered.resolve(); await release.promise; return { outcome: 'applied', result: accepted(message) }; } } } });
    await d.recover(); const ctx = context(), m = { type: 'send', mid: mid(11), scope: store.snapshot().scope, issuedAt: stamp, text: 'immutable' };
    const first = d.dispatch(ctx, m); await entered.promise;
    const duplicates = Array.from({ length: 12 }, () => d.dispatch(ctx, { ...m }));
    const query = d.lookup(context(ctx.principal, 'fleet'), { type: 'receipt:get', scope: m.scope, mid: m.mid });
    checkEqual('changed content conflicts while first write waits', (await d.dispatch(ctx, { ...m, text: 'changed' })).error.code, 'MID_CONFLICT');
    checkEqual('changed target conflicts while first write waits', (await d.dispatch(context(ctx.principal, 'session:replacement'), m)).error.code, 'MID_CONFLICT');
    m.text = 'caller edited after write'; release.resolve();
    const a = await first, many = await Promise.all(duplicates);
    checkEqual('one adapter call for concurrent same-mid requests', count, 1);
    check('all concurrent repeats share one recorded result', many.every((r) => r.status === 'duplicate' && canonical(r.result) === canonical(a.result)));
    checkEqual('lookup waits for reservation/result instead of not_found', (await query).status, 'duplicate');
    const exact = { ...m, text: 'immutable' }; canDispatch = false;
    checkEqual('historical duplicate precedes ended-run/fresh dispatch grants', (await d.dispatch(ctx, exact)).outcome, 'applied');
    canView = false;
    checkEqual('revoked receipt view returns refusal', (await d.dispatch(ctx, exact)).error.code, 'FORBIDDEN');
    checkEqual('revoked lookup never returns absence', (await d.lookup(ctx, exact)).type, 'receipt:error');
    checkEqual('no conflict/revocation redispatch', count, 1); await d.dispose();

    const unknown = createReceiptDispatcher({ authority: store, now: () => stamp, authorize: granted,
      handlers: { send: { execute() { count++; return undefined; } } } }); await unknown.recover();
    const u = { ...exact, mid: mid(12) };
    checkEqual('undefined/post-only adapter is unknown', (await unknown.dispatch(ctx, u)).outcome, 'unknown');
    checkEqual('unknown repeat never executes again', (await unknown.dispatch(ctx, u)).outcome, 'unknown');
    checkEqual('two independent intents have two total adapter calls', count, 2);
    const entries = store.snapshot().entries;
    check('principal is included in external request references', entries.every((e) => e.requestRef.includes(ctx.principal)));
    checkEqual('only engine input drives key, never hello labels', keyOf({ scope: u.scope, principal: ctx.principal, mid: u.mid }), JSON.stringify([u.scope, ctx.principal, u.mid]));
    await unknown.dispose();
  } finally { await f.dispose(); }

  suite('P1-13: negotiation and disk dispatcher compose without trusting hello labels');
  const sockets = disk();
  try {
    const store = await sockets.open(); let effects = 0;
    const d = createReceiptDispatcher({ authority: store, now: () => stamp,
      authorize: ({ access, context }) => access === 'view' || context.seat.control,
      handlers: { send: { apply({ state, message }) { state.values.accepted = (state.values.accepted || 0) + 1; effects++; return accepted(message); } } } });
    await d.recover(); const replies = [], other = [], engine = { id: store.snapshot().engineId, boot: 'b'.repeat(32), version: 'fixture', mode: 'service' };
    const make = (frames, trusted) => d.createSocket({ authenticated: true, context: trusted, sealed: true, testOnlyV2: true, engine,
      post: (m) => frames.push(m), close() {}, legacy() { throw new Error('No legacy dispatch expected'); } });
    const a = make(replies, context()), b = make(other, context());
    const hello = { type: 'hello', proto: { min: 2, max: 2 }, caps: CORE, client: { id: mid(80), kind: 'mac', version: 'fixture' }, from: { local: true } };
    await a.receive(hello); await b.receive({ ...hello, client: { ...hello.client, id: mid(81) } });
    const intent = { type: 'send', mid: mid(82), scope: store.snapshot().scope, issuedAt: stamp, text: 'one authenticated intent' };
    await a.receive(intent); await b.receive(intent);
    checkEqual('hello client ID does not change authenticated dedupe principal', [effects, replies[1].status, other[1].status], [1, 'applied', 'duplicate']);
    checkEqual('forged from.local and mac label cannot upgrade paired seat', replies[0].seat.local, false);
    const watch = [], watcher = make(watch, { ...context(), seat: { ...context().seat, control: false } });
    await watcher.receive(hello); await watcher.receive({ ...intent, mid: mid(83) });
    checkEqual('selected caps do not confer a control grant', [watch[1].error.code, effects], ['FORBIDDEN', 1]);
    a.dispose(); b.dispose(); watcher.dispose(); await d.dispose();
  } finally { await sockets.dispose(); }

  suite('P1-13: reservation/lookup ordering and post-effect storage failure');
  const reserve = disk();
  try {
    let arm = false, effects = 0, resolved = false;
    const entered = deferred(), release = deferred();
    const store = await reserve.open({ hook: async (stage) => { if (arm && stage === 'append:written') { arm = false; entered.resolve(); await release.promise; } } });
    const d = createReceiptDispatcher({ authority: store, now: () => stamp, authorize: granted,
      handlers: { send: { execute({ message }) { effects++; return { outcome: 'applied', result: accepted(message) }; } } } });
    await d.recover(); const m = { type: 'send', mid: mid(90), scope: store.snapshot().scope, issuedAt: stamp, text: 'reserve before first effect' };
    arm = true; const writing = d.dispatch(context(), m); await entered.promise;
    const query = d.lookup(context(), { type: 'receipt:get', scope: m.scope, mid: m.mid }).then((r) => { resolved = true; return r; });
    await Promise.resolve();
    checkEqual('lookup cannot race an uncommitted reservation to not_found', [resolved, effects], [false, 0]);
    release.resolve(); await writing; checkEqual('lookup joins completed reservation', (await query).status, 'duplicate');
    await d.dispose();
  } finally { await reserve.dispose(); }
  const lost = disk();
  try {
    let arm = false, effects = 0;
    const store = await lost.open({ hook: async (stage) => { if (arm && stage === 'append:before') { arm = false; throw Object.assign(new Error('fixture completion fsync failure'), { code: 'EIO' }); } } });
    const d = createReceiptDispatcher({ authority: store, now: () => stamp, authorize: granted,
      handlers: { send: { execute({ message }) { effects++; arm = true; return { outcome: 'applied', result: accepted(message) }; } } } });
    await d.recover(); const m = { type: 'send', mid: mid(91), scope: store.snapshot().scope, issuedAt: stamp, text: 'effect before lost completion' };
    const result = await d.dispatch(context(), m);
    checkEqual('possible effect plus failed completion stays admitted unknown', [result.admitted, result.outcome, effects], [true, 'unknown', 1]);
    checkEqual('fenced completion never permits authoritative absence', (await d.lookup(context(), m)).code, 'STORAGE_UNAVAILABLE');
    await d.dispose(); await store.close();
    const reopened = await lost.open();
    const next = createReceiptDispatcher({ authority: reopened, now: () => stamp, authorize: granted, handlers: { send: { apply() { effects++; return accepted(m); } } } });
    await next.recover();
    checkEqual('persisted dispatch marker recovers unknown without redispatch', [(await next.dispatch(context(), m)).outcome, effects], ['unknown', 1]);
    await next.dispose();
  } finally { await lost.dispose(); }

  suite('P1-13: prepared recovery, result schema and grant changes while an adapter waits');
  const phases = disk();
  try {
    const store = await phases.open(); let effects = 0;
    const m = { type: 'send', mid: mid(92), scope: store.snapshot().scope, issuedAt: stamp, text: 'not dispatched' };
    await store.commit((state) => {
      state.entries.push(receipt(state, 92, { principal: context().principal, hash: requestHash(m, context().target), target: context().target,
        phase: 'prepared', outcome: 'pending', result: null, reservedResultBytes: 16384, requestRef: 'request:prepared' }));
      state.outbox.push({ v: 1, id: 'request:prepared', scope: state.scope, principal: context().principal, mid: m.mid, state: 'prepared', payload: { message: m } });
    });
    const d = createReceiptDispatcher({ authority: store, now: () => stamp, authorize: granted, handlers: { send: { apply() { effects++; return accepted(m); } } } });
    await d.recover(); const answer = await d.dispatch(context(), m);
    checkEqual('prepared recovery rejects original intent and retains input', [answer.status, answer.error.code, store.snapshot().outbox[0].state, effects], ['duplicate', 'ENGINE_RESTARTED', 'discarded', 0]);
    await d.dispose();
    let view = true;
    const entered = deferred(), finish = deferred();
    const revoked = createReceiptDispatcher({ authority: store, now: () => stamp, authorize: () => view,
      handlers: { send: { execute: async ({ message }) => { effects++; entered.resolve(); await finish.promise; return { outcome: 'applied', result: accepted(message) }; } } } });
    await revoked.recover(); const input = { ...m, mid: mid(93) }, waiting = revoked.dispatch(context(), input); await entered.promise;
    view = false; finish.resolve();
    checkEqual('revocation during effect wait suppresses result disclosure', (await waiting).error.code, 'FORBIDDEN');
    view = true; checkEqual('original result survives revoked socket and never repeats effect', [(await revoked.dispatch(context(), input)).outcome, effects], ['applied', 1]);
    await revoked.dispose();
    const malformed = createReceiptDispatcher({ authority: store, now: () => stamp, authorize: granted,
      handlers: { send: { execute() { return { outcome: 'rejected', error: { retryable: false } }; } } } });
    await malformed.recover(); const bad = { ...m, mid: mid(94) };
    checkEqual('malformed external result becomes durable unknown', (await malformed.dispatch(context(), bad)).outcome, 'unknown');
    checkEqual('unknown never regresses to pending on duplicate', (await malformed.dispatch(context(), bad)).outcome, 'unknown');
    await malformed.dispose();
  } finally { await phases.dispose(); }

  suite('P1-13: negotiated time and admission use the persisted effective clock');
  const rollback = disk();
  try {
    let wall = stamp, effects = 0;
    const store = await rollback.open({ now: () => wall });
    const d = createReceiptDispatcher({ authority: store, now: () => wall, authorize: granted,
      handlers: { send: { apply({ message }) { effects++; return accepted(message); } } } });
    await d.recover(); wall += 60000;
    const input = { type: 'send', scope: store.snapshot().scope, mid: mid(200), issuedAt: wall, text: 'before clock rollback' };
    await d.dispatch(context(), input); wall = stamp;
    const replies = [], socket = d.createSocket({ authenticated: true, context: context(), sealed: true, testOnlyV2: true,
      engine: { id: store.snapshot().engineId, boot: 'b'.repeat(32), version: 'fixture', mode: 'service' }, post: (m) => replies.push(m), close() {} });
    await socket.receive({ type: 'hello', proto: { min: 2, max: 2 }, caps: CORE, client: { id: mid(201), kind: 'test', version: 'fixture' } });
    checkEqual('welcome advertises effective persisted server time', replies[0].receipts.now, stamp + 60000);
    checkEqual('serious rollback refuses new admission', (await d.dispatch(context(), { ...input, mid: mid(202) })).error.code, 'CLOCK_SKEW');
    checkEqual('rollback still permits original receipt lookup', (await d.dispatch(context(), input)).status, 'duplicate');
    checkEqual('clock rollback never dispatches another effect', effects, 1);
    socket.dispose(); await d.dispose();
  } finally { await rollback.dispose(); }
};
