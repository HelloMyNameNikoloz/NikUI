'use strict';

const { fixture, ctx, message, DROP, deferred, tick, rpcFixture } = require('./helpers/engine-provider');
const { CodexClient } = require('../src/codex');
const { exactEvidence } = require('../src/codexDelivery');
const { errorCode } = require('./helpers/engine-disk');
const { reserveOperation } = require('../src/jsonlAuthority');
const { daemonProcess } = require('../src/codexSocket');
const { EventEmitter } = require('events');

const inputs = (f) => f.rpc.calls.filter((c) => ['turn/start', 'turn/steer'].includes(c.method));
const followers = (f) => f.router.calls.filter((c) => c.method === 'thread-follower-start-turn');
const itemFor = (f, mid) => f.runtime.snapshot().outbox.find((q) => q.queueId && q.mid === mid);
const op = (f, s, m) => f.runtime.operation(ctx(s), m);
const echo = (id, correlation, status = 'inProgress') => ({ id, status, items: [{ type: 'userMessage', id: 'provider-user', clientId: correlation,
  content: [{ type: 'text', text: 'the same text is insufficient evidence' }] }] });
const start = async (f, s, m) => {
  const accepted = await f.runtime.dispatch(ctx(s), m);
  f.runtime.start(); await f.runtime.drain(ctx(s).target); await f.runtime.flush(); return accepted;
};

module.exports = async function () {
  suite('P1-16 T28/T34: accept-and-drop never requeues on direct RPC or follower IPC');
  for (const borrowed of [false, true]) for (const writer of ['engine', 'external']) {
    let f, boundary;
    const action = () => {
      const saved = itemFor(f, messageId);
      boundary = { state: saved.state, phase: saved.dispatchPhase, provider: saved.provider, correlation: saved.correlation };
      return DROP;
    };
    const messageId = (100 + Number(borrowed) * 10 + Number(writer === 'external')).toString(16).padStart(32, '0');
    f = await fixture({ borrowed, writer, answers: { 'turn/start': action, 'thread/turns/list': { data: [] } },
      ...(writer === 'external' ? { ipcAction: action } : {}) });
    try {
      const s = await f.codex();
      const m = message(f.store, 100 + Number(borrowed) * 10 + Number(writer === 'external'), {
        type: 'send', text: 'original full prompt '.repeat(1200), sent: 'frozen expanded instruction', snippets: ['one', 'two'],
        attachments: [{ name: 'fixture.png', mediaType: 'image/png', data: Buffer.from('isolated image').toString('base64') }] });
      const accepted = await start(f, s, m), saved = itemFor(f, m.mid);
      const label = (borrowed ? 'borrowed' : 'owned') + '/' + writer;
      checkEqual(label + ' immutable engine acceptance is separate from unknown provider outcome', [accepted.outcome, accepted.result.code, saved.state], ['applied', 'accepted', 'unknown']);
      checkEqual(label + ' correlation and both axes precede possible write', [boundary.state, boundary.phase, boundary.provider.clientUserMessageId, boundary.provider.ownership, boundary.provider.writer],
        ['dispatching', writer === 'external' ? 'follower-dispatching' : 'direct-dispatching', saved.correlation, borrowed ? 'borrowed' : 'owned', writer]);
      const sent = writer === 'external' ? followers(f)[0].params.turnStart.request : inputs(f)[0].params;
      checkEqual(label + ' provider receives the persisted correlation/input/settings', [sent.clientUserMessageId, sent.input[0].text, sent.model,
        sent.input[1].url.split(',')[1]], [saved.correlation, m.sent, 'fixture-model', m.attachments[0].data]);
      checkEqual(label + ' ambiguous input leaves runnable queue and retains full payload', [s.queue.length, saved.payload.message], [0, m]);
      const next = message(f.store, 120, { type: 'send', text: 'explicit new intent', retryOf: m.mid });
      const extra = await f.runtime.dispatch(ctx(s), next);
      await f.runtime.drain(ctx(s).target);
      const beforeWriter = f.rpc.calls.filter((c) => c.method === 'thread/resume').length;
      checkEqual(label + ' unknown thread cannot take writer to replay input', await s._takeWriter(), false);
      checkEqual(label + ' new intent is distinct but remains behind unknown lane', [extra.result.code, itemFor(f, next.mid).state,
        f.rpc.calls.filter((c) => c.method === 'thread/resume').length, writer === 'external' ? followers(f).length : inputs(f).length], ['accepted', 'queued', beforeWriter, 1]);
      const reopened = await f.reopen(); f.runtime.start(); await f.runtime.drain(ctx(s).target);
      checkEqual(label + ' replacement preserves scope, unknown and exact correlation without another write',
        [reopened.store.receiptInfo().scope, itemFor(f, m.mid).state, itemFor(f, m.mid).correlation, writer === 'external' ? followers(f).length : inputs(f).length],
        [m.scope, 'unknown', saved.correlation, 1]);
      checkEqual(label + ' accepted receipt survives replacement unchanged', (await f.runtime.dispatch(ctx(s), m)).result, accepted.result);
    } finally { await f.close(); }
  }

  suite('P1-16 T29: only exact account/thread/client-message or known-turn evidence settles uncertainty');
  let pages = [], f = await fixture({ answers: { 'turn/start': () => DROP, 'thread/turns/list': () => ({ data: pages }) } });
  try {
    const s = await f.codex(), m = message(f.store, 200, { type: 'send', text: 'the same text is insufficient evidence' });
    await start(f, s, m); const saved = itemFor(f, m.mid), revision = saved.revision;
    for (const turns of [[], [echo('wrong-turn', 'different-correlation')]]) {
      pages = turns; await f.runtime.reconcileCodex(s.id);
      checkEqual('empty/same-text wrong-ID history remains unknown without a new revision', [(await op(f, s, m)).state, (await op(f, s, m)).revision], ['unknown', revision]);
    }
    checkEqual('a history record from another account is not evidence', exactEvidence(saved, { account: f.f.dir + '/other', threadId: s.threadId, turns: [echo('exact', saved.correlation)] }), null);
    checkEqual('a history record from another thread is not evidence', exactEvidence(saved, { account: f.engine.account.id, threadId: 'other', turns: [echo('exact', saved.correlation)] }), null);
    pages = [echo('exact-turn', saved.correlation)]; await f.runtime.reconcileCodex(s.id);
    let accepted = await op(f, s, m);
    checkEqual('exact client-message echo proves acceptance with provider turn identity', [accepted.state, accepted.provider.turnId, accepted.revision > revision], ['accepted', 'exact-turn', true]);
    pages = [{ id: 'other-turn', status: 'completed', items: [] }]; await f.runtime.reconcileCodex(s.id);
    checkEqual('an unrelated completion cannot settle the accepted turn', (await op(f, s, m)).state, 'accepted');
    pages = [{ id: 'exact-turn', status: 'completed', items: [] }]; await f.runtime.reconcileCodex(s.id);
    checkEqual('completion of a positively correlated turn releases the retained operation', [(await op(f, s, m)).state, (await op(f, s, m)).revision > accepted.revision], ['completed', true]);
    checkEqual('reconciliation never sends or takes the writer', [inputs(f).length, f.rpc.calls.filter((c) => c.method === 'thread/resume').length], [1, 0]);
    const original = await f.runtime.dispatch(ctx(s), m);
    checkEqual('provider completion cannot manufacture a new mutation receipt', [original.status, original.result.code], ['duplicate', 'accepted']);
  } finally { await f.close(); }

  suite('P1-16 T25/T28: direct and follower steering quarantine ambiguity and retain expected turn');
  for (const writer of ['engine', 'external']) {
    f = await fixture({ writer, answers: { 'turn/steer': () => DROP }, ...(writer === 'external' ? { ipcAction: () => DROP } : {}) });
    try {
      const s = await f.codex(); s.turnId = 'issuing-turn';
      const run = s._engineControls.run(), m = message(f.store, 300, { type: 'send', text: '/steer focus on receipts', run });
      await start(f, s, m); const saved = itemFor(f, m.mid);
      const sent = writer === 'external' ? followers(f)[0]?.params.turnStart.request : inputs(f)[0]?.params;
      checkEqual(writer + ' steering captures the expected turn and stable ID', [sent?.expectedTurnId, sent?.clientUserMessageId, sent?.input[0].text], ['issuing-turn', saved.correlation, 'focus on receipts']);
      checkEqual(writer + ' accept-and-drop steer becomes unknown with no runnable queue entry', [saved.state, s.queue.length], ['unknown', 0]);
      await f.runtime.drain(ctx(s).target);
      checkEqual(writer + ' ambiguous steering never starts a fresh turn', f.rpc.calls.filter((c) => c.method === 'turn/start').length, 0);
    } finally { await f.close(); }
  }

  suite('P1-16 T25: delayed follower interrupt/steer cannot target the next turn');
  for (const type of ['interrupt', 'send']) {
    const entered = deferred(), release = deferred();
    f = await fixture({ writer: 'external', ipcAction: () => ({}) });
    try {
      const s = await f.codex(); s.turnId = 'turn-before-lookup';
      f.engine.codex.ipc.ownerOf = async () => { entered.resolve(); await release.promise; return 'fixture-owner'; };
      const m = message(f.store, 310, { type, run: s._engineControls.run(), ...(type === 'send' ? { text: '/steer captured' } : {}) });
      const pending = type === 'send' ? (async () => { const a = await f.runtime.dispatch(ctx(s), m); f.runtime.start(); await f.runtime.drain(ctx(s).target); return a; })()
        : f.runtime.dispatch(ctx(s), m);
      await entered.promise; s.turnId = 'replacement-turn'; release.resolve(); const answer = await pending;
      checkEqual(type + ' rechecks the captured turn after owner discovery', answer.error?.code, 'STALE_TURN');
      checkEqual(type + ' stale control sends nothing to the replacement writer', f.router.calls.filter((c) => /^thread-follower-/.test(c.method)).length, 0);
    } finally { release.resolve(); await f.close(); }
  }

  suite('P1-16 T25: promote-steer keeps queue until acceptance and quarantines lost replies');
  const entered = deferred(), release = deferred();
  f = await fixture({ answers: { 'turn/steer': async () => { entered.resolve(); await release.promise; return DROP; } } });
  try {
    const s = await f.codex(); s.turnId = 'promote-turn';
    const m = message(f.store, 320, { type: 'send', text: 'queued original', sent: 'expanded original' });
    const accepted = await f.runtime.dispatch(ctx(s), m), queueId = accepted.result.data.queueId;
    const promote = message(f.store, 321, { type: 'promoteQueued', id: queueId, mode: 'steer', run: s._engineControls.run() });
    const pending = f.runtime.dispatch(ctx(s), promote); await entered.promise;
    checkEqual('unresolved promotion preserves its queue identity and draft', s.queue.map((q) => [q.id, q.text]), [[queueId, m.text]]);
    const reorder = await f.runtime.dispatch(ctx(s), message(f.store, 322, { type: 'promoteQueued', id: queueId, mode: 'reorder' }));
    checkEqual('reorder remains a local queue action and cannot become another steer', [reorder.outcome, inputs(f).length], ['applied', 1]);
    release.resolve(); const unknown = await pending;
    checkEqual('lost promotion reply quarantines both direct receipt and original input', [unknown.outcome, itemFor(f, m.mid).state, s.queue.length], ['unknown', 'unknown', 0]);
    const saved = itemFor(f, m.mid);
    await f.runtime.observeCodex(s.id, [{ id: 'promote-turn', status: 'completed', items: [] }]);
    checkEqual('turn completion alone cannot prove a particular ambiguous steer', itemFor(f, m.mid).state, 'unknown');
    await f.runtime.observeCodex(s.id, [echo('promote-turn', saved.correlation, 'completed')]);
    const historical = await f.runtime.dispatch(ctx(s), promote);
    checkEqual('exact steer evidence settles operation and original control receipt', [itemFor(f, m.mid).state, historical.status, historical.outcome, historical.result?.data.queueId], ['completed', 'duplicate', 'applied', queueId]);
  } finally { release.resolve(); await f.close(); }

  suite('P1-16 recovery: persisted promotion evidence finishes a lost receipt commit without replay');
  for (const known of ['accepted', 'rejected']) {
    f = await fixture({ answers: { 'turn/steer': known === 'rejected'
      ? { __error: { message: 'unclassified fixture refusal' } } : () => DROP } });
    try {
      const s = await f.codex(); s.turnId = 'promotion-gap';
      const m = message(f.store, 330, { type: 'send', text: 'retained promotion gap' });
      const accepted = await f.runtime.dispatch(ctx(s), m);
      const promote = message(f.store, 331, { type: 'promoteQueued', id: accepted.result.data.queueId, mode: 'steer', run: s._engineControls.run() });
      await f.runtime.dispatch(ctx(s), promote);
      await f.store.commit((state) => {
        // The same valid durable image as a crash after recording exact
        // provider evidence but before completing the promotion receipt.
        const item = state.outbox.find((q) => q.queueId && q.mid === m.mid);
        item.state = known; item.revision++;
        item.error = known === 'rejected' ? { code: 'PROVIDER_REJECTED', message: 'exact fixture non-acceptance', retryable: false } : null;
        item[known === 'accepted' ? 'acceptanceProved' : 'rejectionProved'] = true;
        reserveOperation(item);
      }, { evidence: 'fixture-exact:' + itemFor(f, m.mid).correlation });
      const writes = inputs(f).length; await f.reopen();
      const restored = await f.runtime.dispatch(ctx(s), promote);
      checkEqual(known + ' evidence repairs the associated control receipt on disk reopen',
        [restored.status, restored.outcome, restored.error?.code || null], ['duplicate', known === 'accepted' ? 'applied' : 'rejected', known === 'rejected' ? 'PROVIDER_REJECTED' : null]);
      checkEqual('repair uses the stored proof without a provider retry', [inputs(f).length, itemFor(f, m.mid).payload.message.text], [writes, m.text]);
    } finally { await f.close(); }
  }

  suite('P1-16 T26: provider questions and approval writes bind actual pending identity');
  f = await fixture();
  try {
    const s = await f.codex(), proc = f.rpc.processes[0]; s.turnId = 'question-turn';
    const ask = (id) => proc.ask(id, 'item/tool/requestUserInput', { threadId: s.threadId,
      questions: [{ id: 'choice', question: 'Use the fixture?', options: [{ label: 'Yes' }] }] });
    ask(71); const answerTo = s.items.find((i) => i.id === 'q:71').answerTo;
    checkEqual('provider question carries its immutable request/run marker', answerTo, { requestId: '71', run: s._engineControls.run() });
    const ordinary = await f.runtime.dispatch(ctx(s), message(f.store, 400, { type: 'send', text: 'Yes' }));
    checkEqual('ordinary send cannot implicitly answer the current question', [ordinary.error?.code, inputs(f).length], ['BAD_MESSAGE', 0]);
    ask(72);
    const old = await f.runtime.dispatch(ctx(s), message(f.store, 401, { type: 'send', text: 'Yes', answerTo }));
    checkEqual('stale composer reply cannot answer a replacement question', old.error?.code, 'STALE_TURN');
    const fresh = s.items.find((i) => i.id === 'q:72').answerTo;
    const m = message(f.store, 402, { type: 'send', text: 'Yes', answerTo: fresh });
    const accepted = await start(f, s, m);
    checkEqual('the exact pending question receives one answer', [accepted.result.code, (await op(f, s, m)).state,
      f.rpc.calls.filter((c) => c.id === 72 && c.result).map((c) => c.result.answers.choice.answers)], ['accepted', 'accepted', [['Yes']]]);
    const unsupported = await f.runtime.dispatch(ctx(s), message(f.store, 403, { type: 'stopTask', taskId: 'not-a-codex-task', run: s._engineControls.run() }));
    checkEqual('Codex stopTask refuses its unsupported no-op', unsupported.error?.code, 'UNSUPPORTED');
  } finally { await f.close(); }

  for (const borrowed of [false, true]) {
    f = await fixture({ borrowed });
    try {
      const s = await f.codex(), proc = f.rpc.processes[0]; s.turnId = 'approval-turn';
      proc.ask(77, 'item/commandExecution/requestApproval', { threadId: s.threadId, command: 'fixture' });
      const run = s.items.find((i) => i.id === 'p:77').run;
      const write = proc.stdin.write.bind(proc.stdin);
      proc.stdin.write = (...args) => { const result = write(...args); if (JSON.parse(String(args[0])).id === 77) proc.exit(); return result; };
      const m = message(f.store, 410, { type: 'permission', requestId: '77', run, allow: true });
      const first = await f.runtime.dispatch(ctx(s), m);
      checkEqual((borrowed ? 'borrowed' : 'owned') + ' accept-and-drop approval reports uncertainty', [first.outcome,
        f.rpc.calls.filter((c) => c.id === 77 && c.result).length], ['unknown', 1]);
      const again = await f.runtime.dispatch(ctx(s), m);
      checkEqual('unknown approval receipt cannot requeue or answer twice', [again.status, again.outcome, f.rpc.calls.filter((c) => c.id === 77 && c.result).length], ['duplicate', 'unknown', 1]);
      checkEqual('approval precondition retains account/thread and transport/writer separately',
        [f.runtime.snapshot().outbox[0].payload.provider.account, f.runtime.snapshot().outbox[0].payload.provider.threadId,
          f.runtime.snapshot().outbox[0].payload.provider.ownership, f.runtime.snapshot().outbox[0].payload.provider.writer],
        [f.engine.account.id, s.threadId, borrowed ? 'borrowed' : 'owned', 'engine']);
    } finally { await f.close(); }
  }

  suite('P1-16 T23: provider request IDs reused across questions and approvals cannot retarget old answers');
  f = await fixture();
  try {
    const s = await f.codex(), proc = f.rpc.processes[0]; s.turnId = 'one-turn';
    proc.ask('shared-id', 'item/tool/requestUserInput', { threadId: s.threadId, questions: [{ id: 'q', question: 'Fixture?' }] });
    const old = s.items.find((item) => item.id === 'q:shared-id').answerTo;
    proc.ask('shared-id', 'item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, command: 'fixture replacement' });
    const stale = await f.runtime.dispatch(ctx(s), message(f.store, 415, { type: 'send', text: 'stale question answer', answerTo: old }));
    checkEqual('old question marker cannot answer a replacement approval', [stale.error?.code, f.rpc.calls.filter((c) => c.id === 'shared-id' && c.result).length], ['APPROVAL_RESOLVED', 0]);
    const pending = s.items.find((item) => item.id === 'p:shared-id');
    const current = await f.runtime.dispatch(ctx(s), message(f.store, 416, { type: 'permission', requestId: 'shared-id', run: pending.run, allow: true }));
    checkEqual('fresh pending approval still has its own typed response', [current.outcome, f.rpc.calls.filter((c) => c.id === 'shared-id' && c.result).at(-1)?.result], ['applied', { decision: 'accept' }]);
  } finally { await f.close(); }

  suite('P1-16 T28: an actual borrowed IPC approval cannot be reopened after an uncertain response');
  f = await fixture({ writer: 'external', ipcAction: () => ({}) });
  try {
    const s = await f.codex(), ipc = f.router.ipc; s.turnId = 'ipc-approval-turn';
    await ipc.connect();
    f.router.ask('ipc-approval', 'item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, command: 'fixture' });
    for (let n = 0; n < 100 && !s.items.some((i) => i.id === 'p:ipc-approval'); n++) await tick();
    const pending = s.items.find((i) => i.id === 'p:ipc-approval');
    check('IPC request establishes real pending authority from its issuing turn', !!pending && pending.run.turn === 'ipc-approval-turn');
    const socket = ipc.sock, write = socket.write.bind(socket);
    socket.write = (...args) => { write(...args); throw new Error('fixture accepted IPC response, lost confirmation'); };
    const m = message(f.store, 420, { type: 'permission', requestId: 'ipc-approval', run: pending.run, allow: true });
    const answer = await f.runtime.dispatch(ctx(s), m); socket.write = write;
    for (let n = 0; n < 100 && !f.router.calls.some((c) => c.type === 'response' && c.requestId === 'ipc-approval'); n++) await tick();
    checkEqual('accepted-and-dropped IPC approval stays unknown and retains its phase/identity',
      [answer.outcome, f.runtime.snapshot().outbox[0].dispatchPhase, f.runtime.snapshot().outbox[0].payload.control.transport], ['unknown', 'ipc-permission', 'ipc']);
    const again = await f.runtime.dispatch(ctx(s), m);
    checkEqual('same IPC approval is never sent again', [again.status, again.outcome,
      f.router.calls.filter((c) => c.type === 'response' && c.requestId === 'ipc-approval').length], ['duplicate', 'unknown', 1]);
    const other = await f.runtime.dispatch(ctx(s, 'device:competitor'), message(f.store, 421, { type: 'permission', requestId: 'ipc-approval', run: pending.run, allow: false }));
    checkEqual('another mid cannot acquire an uncertain IPC approval', other.error?.code, 'APPROVAL_RESOLVED');
  } finally { await f.close(); }

  suite('P1-16 T29: definitive non-acceptance is exact, while generic errors and lookup loss stay unknown');
  for (const authoritative of [false, true]) {
    f = await fixture({ answers: { 'turn/start': { __error: { message: 'fixture provider error', ...(authoritative ? { data: { accepted: false } } : {}) } } } });
    try {
      const s = await f.codex(), m = message(f.store, 430, { type: 'send', text: 'retain on rejection or uncertainty' });
      const receipt = await start(f, s, m);
      checkEqual('only explicit provider non-acceptance rejects dispatch: ' + authoritative,
        [(await op(f, s, m)).state, receipt.result.code, itemFor(f, m.mid).payload.message.text],
        [authoritative ? 'rejected' : 'unknown', 'accepted', m.text]);
      if (!authoritative) {
        const saved = itemFor(f, m.mid), binding = { scope: m.scope, principal: ctx(s).principal, mid: m.mid };
        const outcome = { state: 'rejected', error: { code: 'PROVIDER_REJECTED', message: 'exact non-acceptance', retryable: false } };
        checkEqual('a timeout string cannot be passed off as Codex reconciliation evidence', await errorCode(() => f.runtime.settleOperation(binding, outcome, 'timeout/no-match')), 'BAD_MESSAGE');
        const proof = { account: saved.provider.account, threadId: s.threadId, clientUserMessageId: saved.correlation, accepted: false };
        checkEqual('non-acceptance evidence must identify the exact stable message', await errorCode(() => f.runtime.settleOperation(binding, outcome, { ...proof, clientUserMessageId: 'wrong' })), 'BAD_MESSAGE');
        const rejected = await f.runtime.settleOperation(binding, outcome, proof);
        checkEqual('exact authoritative non-acceptance resolves unknown with a persisted revision', [rejected.state, rejected.revision > saved.revision], ['rejected', true]);
      }
    } finally { await f.close(); }
  }

  suite('P1-16 T30/T60: transport, writer and owned history reader lifetimes are independent');
  for (const borrowed of [false, true]) for (const writer of ['engine', 'external', 'unknown']) {
    f = await fixture({ borrowed, writer, answers: { 'thread/turns/list': { data: [] } } });
    try {
      const s = await f.codex(); await f.engine.codex.reader();
      const handles = f.engine.codex.resourceOwnership();
      checkEqual('resource tracking never derives writer from transport: ' + borrowed + '/' + writer,
        [handles.connection.ownership, s.writerAuthority, handles.reader?.ownership || null], [borrowed ? 'borrowed' : 'owned', writer, borrowed ? 'owned' : null]);
      s.turnId = 'active-turn';
      checkEqual('planned replacement checks process ownership, including a borrowed external turn', f.runtime.updateReadiness().ready, borrowed);
      await f.runtime.dispose(); f.engine.dispose(); f.engine.dispose();
      checkEqual('disposal closes a borrowed connection without stopping its daemon',
        f.rpc.processes.map((p) => [p.closes, p.kills]), borrowed ? [[1, 0], [0, 1]] : [[0, 1]]);
    } finally { await f.close(); }
  }
  const failed = rpcFixture({ initialize: { __error: { message: 'fixture refused initialization', data: { accepted: false } } } });
  const external = failed.spawn(), client = new CodexClient({ codexPath: '/fixture/codex', daemonFn: async () => external,
    spawnFn: () => { throw new Error('must never spawn replacement'); } });
  await errorCode(() => client.start()); client.dispose();
  checkEqual('failed borrowed initialization also only closes its own connection', [external.kills, external.closes], [0, 1]);

  f = await fixture({ borrowed: true });
  try {
    await f.codex();
    f.rpc.answers.initialize = { __error: { message: 'owned reader initialization failed', data: { accepted: false } } };
    const reader = await f.engine.codex.reader();
    check('failed owned reader falls back to the still-borrowed connection', reader === f.engine.codex.client);
    await f.runtime.dispose(); f.engine.dispose();
    checkEqual('reader failure and later disposal close each owned/borrowed resource once', f.rpc.processes.map((p) => [p.closes, p.kills]), [[1, 0], [0, 1]]);
  } finally { await f.close(); }

  const ws = new EventEmitter(); ws.open = true;
  ws.send = (line) => { const msg = JSON.parse(line); if (msg.id != null) ws.emit('message', JSON.stringify({ id: msg.id, result: {} })); return false; };
  ws.close = () => { ws.open = false; ws.emit('close'); };
  const socketClient = new CodexClient({ codexPath: '/fixture/codex', daemonFn: async () => daemonProcess(ws), spawnFn: () => { throw new Error('no fallback'); } });
  await socketClient.start();
  checkEqual('borrowed socket backpressure is still a submitted write', socketClient.respondOutcome('fixture', {}), 'submitted');
  ws.open = false;
  checkEqual('closed borrowed socket cannot report a submitted approval', socketClient.respondOutcome('fixture', {}), 'not_written');
  socketClient.dispose();
};
