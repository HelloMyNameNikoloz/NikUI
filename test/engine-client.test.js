'use strict';

const { browser, until } = require('./helpers/browser-client');
const vectors = require('./fixtures/protocol-v2/reconnect-outbox.json').vectors;
const { CORE } = require('../src/protocolV2');
const base = vectors[0].input[0].message.record;
const clone = (v) => JSON.parse(JSON.stringify(v));
const initialTime = base.issuedAt + 1000;
const normalize = (r) => ({ ...clone(r), plaintext: JSON.stringify(r.payload), consumed: r.consumed === true });
function harness(record, options = {}) {
  const b = browser({ fakeTimers: true });
  let disk = JSON.stringify({ version: 1, records: record ? [normalize(record)] : [] }), sequence = 0;
  const sent = [], emitted = [], writes = [];
  const app = b.negotiatedClient({ config: { session: options.fleet ? null : 'instance-7', hostFingerprint: options.host || base.hostFingerprint },
    storage: { read: () => disk, write: (text) => { if (options.fail) throw new Error('disk'); writes.push(text); disk = text; } },
    now: () => options.now || initialTime, randomId: () => (++sequence).toString(16).padStart(32, '0'),
    maxCount: options.maxCount, maxBytes: options.maxBytes,
    send: (m) => { if (m.mid && !['receipt:get', 'operation:get'].includes(m.type)) check('intent persisted before socket write', JSON.parse(disk).records.some((r) => r.mid === m.mid)); sent.push(clone(m)); },
    emit: (m) => emitted.push(clone(m)) });
  const welcome = { type: 'welcome', proto: 2, caps: CORE,
    engine: { id: options.engine || base.engineId, boot: 'b'.repeat(32), mode: 'service' },
    receipts: { scope: options.scope || base.scope, now: options.now || initialTime, retentionMs: 86400000 }, seat: vectors[0].context.seat };
  function connect() {
    app.receive({ type: '@welcome', proto: { min: 1, max: 2 }, caps: CORE });
    app.receive(welcome);
  }
  return { app, b, sent, emitted, writes, connect, welcome, disk: () => disk };
}
function ack(record, outcome = 'applied') { return { type: 'ack', scope: record.scope, mid: record.mid, what: record.payload.type,
  target: record.target, status: outcome, outcome, admitted: true, at: initialTime, expiresAt: initialTime + 86400000,
  result: outcome === 'applied' ? { code: 'accepted', data: { operation: record.mid, instance: 'instance-7', queueId: 'q-fixture' }, replies: [] } : null,
  error: outcome === 'unknown' ? { code: 'OUTCOME_UNKNOWN', message: 'unknown', retryable: false } : null }; }

module.exports = async function () {
  suite('P1-21 T35–T38: all shared W outbox traces drive the actual JS client');
  let count = 0;
  for (const vector of vectors) {
    const record = vector.initial.record || vector.input.find((s) => s.message.type === 'persist')?.message.record;
    const reconnect = vector.input.find((s) => s.message.type === 'reconnect')?.message || {};
    const failure = vector.initial.persistFailure;
    const h = harness(record, { ...reconnect, engine: reconnect.engineId, host: reconnect.hostFingerprint,
      maxCount: failure === '128-intents' ? 0 : undefined,
      maxBytes: failure === '32MiB' ? 64 : undefined, fail: failure === 'IO_ERROR' });
    h.connect();
    if (reconnect.type && !['outbox-same-scope-missing', 'outbox-controls-wait-for-snapshot'].includes(vector.id)) {
      if (reconnect.proto === 1 || vector.id.endsWith('downgrade')) { h.app.disconnect(); h.app.receive({ type: '@welcome' }); }
      else if (reconnect.receiptOutcome) h.app.receive(ack(record, reconnect.receiptOutcome));
      else if (reconnect.queryCode) h.app.receive({ type: 'receipt:error', scope: base.scope, mid: base.mid, code: reconnect.queryCode });
    }
    for (const step of vector.input) {
      if (step.direction === 'server') { h.app.receive(step.message); if (step.message.type === 'receipt:missing') h.app.receive(step.message); }
      if (step.direction === 'client' && step.message.type === 'send' && failure) {
        const { mid, scope, issuedAt, ...payload } = step.message;
        checkEqual(vector.id + ': storage failure refuses the attempted action', h.app.post(payload), false);
      }
      if (step.message.type === 'reconnect' && vector.id === 'outbox-accepted-operation-query') { h.app.disconnect(); h.connect(); }
    }
    const sends = h.sent.filter((m) => m.type === 'send' || m.type === 'interrupt');
    checkEqual(vector.id + ': exact replay policy', sends.length, vector.expected.state.autoResend ? 1 : 0);
    if (sends.length) checkEqual(vector.id + ': every byte/ID/precondition is unchanged', sends[0], base.payload);
    if (record) checkEqual(vector.id + ': complete draft and images retained', h.app.records()[0].payload, record.payload);
    if (vector.expected.state.outbox === 'quarantined')
      checkEqual(vector.id + ': quarantine visible', h.app.records()[0].quarantined, true);
    if (vector.id === 'outbox-accepted-operation-query') {
      check('accepted sends query operation state', h.sent.some((m) => m.type === 'operation:get'));
      checkEqual('operation unknown leaves original acceptance intact', h.app.records()[0].ack.outcome, 'applied');
      h.app.receive(vector.expected.replies[0]);
      checkEqual('operation revision/state is authoritative', h.app.records()[0].operation.state, 'unknown');
    }
    h.app.disconnect(); h.b.close(); count++;
  }
  checkEqual('every shared W outbox vector executed', count, 16);

  suite('P1-21 T09/T10/T37/T42: negotiation, caps, storage, and semantic results');
  const h = harness();
  checkEqual('mutation before application welcome is refused', h.app.post({ type: 'send', text: 'before welcome' }), false);
  h.app.receive({ type: '@welcome', proto: { min: 1, max: 2 } });
  checkEqual('only hello is written while negotiating', h.sent.map((m) => m.type), ['hello']);
  h.app.receive(h.welcome);
  checkEqual('disabled PR/terminal/voice UI matches honest caps', ['pr:reply', 'term:open', 'voice'].map((type) => h.app.allowed({ type })), [false, false, false]);
  const pending = h.app.post({ type: 'send', text: 'original', sent: 'original', attachments: [{ name: 'one', data: 'bytes' }] }, { draftVersion: 1, draft: 'original' });
  const r = h.app.records()[0];
  check('send returns a persisted pending ID, never accepted', pending.pending === true && pending.mid === r.mid && r.state === 'pending');
  h.app.receive({ ...ack(r), mid: 'f'.repeat(32) });
  checkEqual('unrelated reply cannot settle original', h.app.records()[0].state, 'pending');
  h.app.receive({ ...ack(r), what: 'permission' });
  checkEqual('wrong type cannot settle original', h.app.records()[0].state, 'pending');
  h.app.receive(ack(r));
  h.app.post({ type: 'editQueued', id: 'q-fixture' });
  const edit = h.app.records().find((r) => r.payload.type === 'editQueued');
  const result = ack(edit); result.result = { code: 'ok', data: { queueId: 'q-fixture' }, replies: [{ type: 'editPrompt', text: 'reclaimed', attachments: [{ data: 'image' }] }] };
  h.app.receive(result); h.app.receive({ ...result, status: 'duplicate' });
  checkEqual('original semantic result is consumed once', h.emitted.filter((m) => m.type === 'editPrompt').length, 1);
  checkEqual('semantic result remains bound to matching pending intent', h.emitted.find((m) => m.type === 'editPrompt').intentMid, edit.mid);
  checkEqual('composition revision survives ack for late-edit comparison', h.app.records()[0].composition, { draftVersion: 1, draft: 'original' });
  checkEqual('late accepted ack clears only the original composition', [
    h.app.acceptsComposition(h.app.records()[0], { draftVersion: 1, draft: 'original' }),
    h.app.acceptsComposition(h.app.records()[0], { draftVersion: 2, draft: 'new draft' }),
    h.app.acceptsComposition(h.app.records()[0], { draftVersion: 2, draft: 'original' })], [true, false, false]);
  h.app.receive({ type: 'init', run: { id: 'a'.repeat(32), turn: 'current' }, items: [{ kind: 'permission', requestId: 'approval', run: { id: 'a'.repeat(32), turn: 'old' } }] });
  h.app.post({ type: 'permission', requestId: 'approval', allow: true });
  checkEqual('approval binds issuing run rather than current turn', h.sent.at(-1).run.turn, 'old');
  h.app.receive({ type: 'protocol:error', code: 'FORBIDDEN', message: 'Query unavailable' });
  checkEqual('a nonfatal query refusal stays visible without discarding the negotiated lane', [h.app.proto, h.app.ready], [2, true]);
  h.app.receive({ type: 'protocol:error', code: 'BAD_HELLO', message: 'Bad hello' });
  checkEqual('fatal negotiation failure never silently downgrades', [h.app.proto, h.app.ready], [null, false]);
  h.app.disconnect(); h.b.close();

  const reloaded = harness(h.app.records().find((r) => r.mid === edit.mid)); reloaded.connect(); reloaded.app.receive(result);
  checkEqual('page reload cannot consume the original semantic result twice', reloaded.emitted.filter((m) => m.type === 'editPrompt').length, 0);
  reloaded.app.disconnect(); reloaded.b.close();

  const capacity = harness(); capacity.connect();
  for (let i = 0; i < 128; i++) capacity.app.post({ type: 'send', text: 'pending ' + i });
  checkEqual('actual 128-intent boundary refuses item 129 without eviction', [capacity.app.records().length, capacity.app.post({ type: 'send', text: 'one too many' }), capacity.sent.filter((m) => m.type === 'send').length], [128, false, 128]);
  capacity.app.disconnect(); capacity.b.close();
  const byteCapacity = harness(); byteCapacity.connect();
  const large = { type: 'send', text: 'large complete draft', attachments: [{ mediaType: 'image/png', name: 'large.png', data: 'x'.repeat(9 * 1024 * 1024) }] };
  const firstLarge = byteCapacity.app.post(large), secondLarge = byteCapacity.app.post(large);
  checkEqual('actual 32MiB bound preserves the complete first image and refuses overflow', [firstLarge.pending, secondLarge, byteCapacity.app.records()[0].payload.attachments[0].data.length], [true, false, 9 * 1024 * 1024]);
  byteCapacity.app.disconnect(); byteCapacity.b.close();

  const legacy = harness(base); legacy.app.post({ type: 'ready' }); legacy.app.receive({ type: '@welcome' });
  checkEqual('old extension ready is immediate with no hello or replay', legacy.sent, [{ type: 'ready' }]);
  legacy.app.disconnect(); legacy.b.close();

  const revoked = harness(base); revoked.connect(); revoked.app.receive({ type: '@device', device: { control: false } });
  checkEqual('live revoked control gates sending', revoked.app.post({ type: 'send', text: 'no grant' }), false);
  revoked.app.disconnect(); revoked.b.close();

  suite('P1-21: application readiness gates existing shared shell welcome listeners');
  const staged = browser({ fakeTimers: true, config: { hostFingerprint: 'fixture-local-pin' } });
  let socket;
  staged.context.WebSocket = class {
    constructor() { socket = this; this.readyState = 0; this.sent = []; }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
  };
  const link = staged.socket(); link.postMessage({ type: 'ready' });
  socket.readyState = 1; socket.onopen();
  socket.onmessage({ data: JSON.stringify({ type: '@welcome', proto: { min: 1, max: 2 }, caps: CORE, device: { id: 'local', kind: 'local', control: true } }) });
  checkEqual('authenticated advertisement is not a live shared-UI welcome', [staged.messages.filter((m) => m.type === '@welcome').length, socket.sent.map((m) => m.type)], [0, ['hello']]);
  staged.window.addEventListener('message', (event) => { if (event.data.type === '@welcome') link.postMessage({ type: 'devices' }); });
  socket.onmessage({ data: JSON.stringify({ type: 'welcome', proto: 2, caps: CORE,
    engine: { id: base.engineId }, seat: { id: 'local', control: true, local: true, editor: false },
    receipts: { scope: base.scope, retentionMs: 86400000, now: initialTime } }) });
  for (const task of [...staged.tasks]) if (task.ms === 0) { staged.tasks.delete(task); task.fn(); }
  checkEqual('existing shared shell initial queries start only after negotiation', socket.sent.map((m) => m.type), ['hello', 'ready', 'devices']);
  checkEqual('shared shell receives one explicitly negotiated welcome', staged.messages.filter((m) => m.type === '@welcome').map((m) => m.negotiated), [2]);
  staged.close();

  suite('P1-21: direct webview v2 requires an explicit bridge opt-in');
  const webview = browser({ fakeTimers: true }); let state = { draft: 'local composer' };
  const sent = [], api = { postMessage: (m) => sent.push(m), getState: () => state, setState: (value) => { state = value; } };
  webview.context.acquireVsCodeApi = () => api;
  checkEqual('unopted direct API is returned immediately unchanged', webview.window.nikTransport() === api, true);
  webview.window.NIKUI_DEV_BRIDGE = { session: 'instance-7', hostFingerprint: base.hostFingerprint, clientKind: 'extension' };
  const opted = webview.window.nikTransport(); opted.application.receive({ type: '@welcome', proto: { min: 1, max: 2 } });
  opted.application.receive({ type: 'welcome', proto: 2, caps: CORE, engine: { id: base.engineId },
    seat: { id: 'e'.repeat(32), local: true, editor: true, control: true }, receipts: { scope: base.scope, retentionMs: 86400000, now: initialTime } });
  opted.postMessage({ type: 'send', text: 'from isolated webview', attachments: [] }); opted.setState({ draft: 'new draft' });
  checkEqual('opted webview persists pending intent alongside independent composer state', [JSON.parse(state.__nikuiIntents).records[0].payload.text, state.draft], ['from isolated webview', 'new draft']);
  checkEqual('bridge listen and application hello precede its first mutation', sent.map((m) => m.type), ['bridge:listen', 'hello', 'send']);
  opted.application.disconnect(); webview.close();

  suite('P1-21 T37/T39: concurrent browser clients serialize durable state');
  const concurrent = browser({ fakeTimers: true });
  let shared = JSON.stringify({ version: 1, records: [] }), chain = Promise.resolve();
  const store = { read: () => shared, write: (text) => { shared = text; },
    exclusive: (fn) => { const next = chain.then(fn); chain = next.catch(() => {}); return next; } };
  const wire = [], clients = [];
  for (const prefix of ['c', 'd']) {
    let sequence = 0;
    const app = concurrent.negotiatedClient({ config: { session: 'instance-7', hostFingerprint: base.hostFingerprint }, storage: store,
      randomId: () => prefix + (++sequence).toString(16).padStart(31, '0'), now: () => initialTime, emit() {},
      send: (m) => { if (m.type === 'send') check('locked browser write precedes socket write', JSON.parse(shared).records.some((r) => r.mid === m.mid)); wire.push(m); } });
    app.receive({ type: '@welcome', proto: { min: 1, max: 2 } }); app.receive({ ...h.welcome }); clients.push(app);
  }
  const first = clients[0].post({ type: 'send', text: 'viewer one', attachments: [{ data: 'one' }] });
  clients[1].post({ type: 'send', text: 'viewer two', attachments: [{ data: 'two' }] });
  checkEqual('async persistence is labeled saving and writes no frame early', [first.pending, wire.filter((m) => m.type === 'send').length], ['saving', 0]);
  await until(() => JSON.parse(shared).records.length === 2, 'concurrent outbox commits');
  checkEqual('neither simultaneous viewer loses its intent/image', JSON.parse(shared).records.map((r) => [r.payload.text, r.payload.attachments[0].data]), [['viewer one', 'one'], ['viewer two', 'two']]);
  clients[0].receive(ack(JSON.parse(shared).records[0]));
  clients[1].post({ type: 'send', text: 'third intent' });
  await until(() => JSON.parse(shared).records.length === 3 && JSON.parse(shared).records[0].ack, 'ack and concurrent intent');
  checkEqual('a late ack cannot overwrite another viewer’s newer intent', JSON.parse(shared).records.map((r) => r.payload.text), ['viewer one', 'viewer two', 'third intent']);
  for (const app of clients) app.disconnect(); concurrent.close();
};
