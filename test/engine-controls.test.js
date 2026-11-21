'use strict';

const { fixture, ctx, message, deferred, tick } = require('./helpers/engine-provider');
const { CONTROL_STATE } = require('../src/providerControls');
const { Session } = require('../src/session');
const { SessionHub } = require('../src/hub');
const { KeptProc } = require('../src/keeperLink');

const permission = (session, id = 'reused-approval') => {
  session._handleControlRequest({ type: 'control_request', request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'fixture only' } } });
  return session.items.filter((i) => i.kind === 'permission').at(-1).run;
};
const responses = (f) => f.claude.calls.filter((c) => c.type === 'control_response');
const nextTurn = (s) => { s._handleResult({ type: 'result', is_error: false }); s._beginOwnTurn(); };
const tasks = (s, list) => s._handleBackgroundTasks(list.map(([id, type]) => ({ task_id: id, task_type: type, description: 'fixture finite build' })));

module.exports = async function () {
  suite('P1-15 T23/T24: real pending Claude approvals, one winner and historical duplicates');
  let f = await fixture();
  try {
    const s = await f.session(), run = permission(s), context = ctx(s);
    check('execution and turn tokens are opaque engine identities', /^[a-f0-9]{32}$/.test(run.id) && /^turn:[a-f0-9]{32}$/.test(run.turn) && run.id !== s.id);
    checkEqual('reading a fresh snapshot does not rotate a healthy execution', s._engineControls.run(), run);
    const missing = await f.runtime.dispatch(context, message(f.store, 1, { type: 'permission', run, requestId: 'transcript-only', allow: true }));
    checkEqual('a running process or transcript item cannot substitute for pending membership', [missing.outcome, missing.error.code, responses(f).length], ['rejected', 'APPROVAL_RESOLVED', 0]);
    const first = message(f.store, 2, { type: 'permission', run, requestId: 'reused-approval', allow: true });
    const second = message(f.store, 3, { type: 'permission', run, requestId: 'reused-approval', allow: false });
    const [a, b] = await Promise.all([f.runtime.dispatch(context, first), f.runtime.dispatch(ctx(s, 'device:competitor'), second)]);
    checkEqual('two independent mids have exactly one approval winner', [a.outcome, b.outcome, b.error?.code, responses(f).length], ['applied', 'rejected', 'APPROVAL_RESOLVED', 1]);
    checkEqual('write boundary yields the concrete typed result', a.result?.data, { requestId: 'reused-approval', run, allow: true, delivery: 'submitted' });
    checkEqual('pending identity and winning mid are committed', f.store.snapshot().values[CONTROL_STATE].claims.map((c) => [c.kind, c.owner]), [['permission', first.mid]]);
    const oldProc = s.proc;
    s.stop(); s.start(); s._beginOwnTurn();
    const replacement = permission(s);
    check('process replacement rotates execution identity even with reused request ID', replacement.id !== run.id && s.proc !== oldProc);
    const replay = await f.runtime.dispatch(context, first);
    checkEqual('duplicate on an ended execution returns the original receipt', [replay.status, replay.result, responses(f).length], ['duplicate', a.result, 1]);
    const stale = await f.runtime.dispatch(context, message(f.store, 4, { ...first, mid: undefined }));
    checkEqual('invalid envelopes remain refused', stale.admitted, false);
    const late = await f.runtime.dispatch(context, message(f.store, 5, { type: 'permission', run, requestId: 'reused-approval', allow: true }));
    checkEqual('old run cannot answer a replacement approval with the same provider ID', [late.error?.code, responses(f).length], ['STALE_RUN', 1]);
    const legacy = await s.respondToPermission('reused-approval', true);
    checkEqual('service v1 refuses ambiguous ID reuse instead of minting a current target', [legacy.error?.code, responses(f).length], ['STALE_RUN', 1]);
    check('keeper checkpoints never serialize live control authority', !Object.hasOwn(s.snapshot(), '_engineControls'));
    const hub = new SessionHub(s, { config: () => ({}) });
    checkEqual('service init/meta publish run beside their payload', [hub.initMessage('fixture').run, hub.metaMessage().run], [replacement, replacement]);
    checkEqual('run is kept outside the existing meta report', hub.initMessage('fixture').meta.run, undefined);
    hub.dispose();
  } finally { await f.close(); }

  suite('P1-15 T23/T25: capture target before asynchronous state/receipt lookup');
  const entered = deferred(), release = deferred(); let armed = false;
  f = await fixture({ hook: async (name) => { if (armed && name === 'append:before') { armed = false; entered.resolve(); await release.promise; } } });
  try {
    const s = await f.session(), run = permission(s);
    await f.runtime.flush(); armed = true; s.rename('metadata lookup waits'); await entered.promise;
    const pending = f.runtime.dispatch(ctx(s), message(f.store, 10, { type: 'permission', run, requestId: 'reused-approval', allow: true }));
    s.stop(); s.start(); s._beginOwnTurn(); permission(s);
    release.resolve(); const answer = await pending;
    checkEqual('replacement during metadata await is rejected with zero writes', [answer.error?.code, responses(f).length], ['STALE_RUN', 0]);
    const current = s._engineControls.run();
    nextTurn(s);
    const interrupt = await f.runtime.dispatch(ctx(s), message(f.store, 11, { type: 'interrupt', run: current }));
    checkEqual('a stale interrupt cannot hit the next foreground turn', [interrupt.error?.code, f.claude.calls.filter((c) => c.type === 'control_request').length], ['STALE_TURN', 0]);
  } finally { release.resolve(); await f.close(); }

  suite('P1-15 T26: background tasks retain their issuing turn and background set token');
  f = await fixture();
  try {
    const s = await f.session(), issued = s._engineControls.run();
    tasks(s, [['shell-old', 'local_bash']]);
    checkEqual('stoppable shell is stamped with its issuing run', s.shellList[0].run, issued);
    nextTurn(s); const newest = s._engineControls.run();
    const wrong = await f.runtime.dispatch(ctx(s), message(f.store, 20, { type: 'stopTask', taskId: 'shell-old', run: newest }));
    checkEqual('newest foreground turn is not authority over an older task', wrong.error?.code, 'STALE_TURN');
    const right = await f.runtime.dispatch(ctx(s), message(f.store, 21, { type: 'stopTask', taskId: 'shell-old', run: issued }));
    checkEqual('older issuing turn can stop its still-live task', [right.outcome, right.result?.data.run, f.claude.calls.at(-1)?.request], ['applied', issued, { subtype: 'stop_task', task_id: 'shell-old' }]);
    tasks(s, [['agent-1', 'local_agent'], ['shell-old', 'local_bash']]);
    s._handleResult({ type: 'result', is_error: false });
    const background = s._engineControls.run();
    check('idle/background interruption has its own set token', /^bg:[a-f0-9]{32}$/.test(background.turn));
    tasks(s, [['agent-2', 'local_agent'], ['shell-old', 'local_bash']]);
    const before = f.claude.calls.length;
    const changed = await f.runtime.dispatch(ctx(s), message(f.store, 22, { type: 'interrupt', run: background }));
    checkEqual('changed background set rejects its old control token', [changed.error?.code, f.claude.calls.length], ['STALE_TURN', before]);
    const exact = await f.runtime.dispatch(ctx(s), message(f.store, 23, { type: 'interrupt', run: s._engineControls.run() }));
    checkEqual('background interrupt targets captured agents, preserving the shell', [exact.outcome, f.claude.calls.at(-1)?.request], ['applied', { subtype: 'stop_task', task_id: 'agent-2' }]);
    s._beginOwnTurn(); tasks(s, [['reuse', 'local_bash']]);
    const reused = s.backgroundTasks[0].run; tasks(s, []); tasks(s, [['reuse', 'local_bash']]);
    const refused = await f.runtime.dispatch(ctx(s), message(f.store, 24, { type: 'stopTask', taskId: 'reuse', run: reused }));
    checkEqual('same-turn task ID reuse cannot redirect an old stop', refused.error?.code, 'STALE_RESOURCE');
    s._handleSystem({ type: 'system', subtype: 'task_started', task_id: 'announced', task_type: 'local_bash' });
    const announced = s._engineControls.run(); nextTurn(s); tasks(s, [['announced', 'local_bash']]);
    checkEqual('task_started fixes issuing turn before delayed background discovery', s.shellList[0].run, announced);
    tasks(s, [['older-agent', 'local_agent']]); const agentRun = s.backgroundTasks[0].run; nextTurn(s);
    const agentStop = await f.runtime.dispatch(ctx(s), message(f.store, 25, { type: 'stopTask', taskId: 'older-agent', run: agentRun }));
    checkEqual('an active background agent also uses its own issuing turn', [agentStop.outcome, f.claude.calls.at(-1)?.request], ['applied', { subtype: 'stop_task', task_id: 'older-agent' }]);
  } finally { await f.close(); }

  suite('P1-15 keeper write boundary: disconnected or pending writes never become replayable controls');
  f = await fixture();
  try {
    const s = await f.session(), link = { send: () => false }, proc = new KeptProc(link, 'fixture-kept-run', s);
    s.proc = proc; proc.state = 'kept'; s._engineControls.rotate(proc); s._beginOwnTurn();
    const run = permission(s), m = message(f.store, 35, { type: 'permission', requestId: 'reused-approval', run, allow: true });
    const answer = await f.runtime.dispatch(ctx(s), m);
    checkEqual('failed keeper socket write is unknown', answer.outcome, 'unknown');
    checkEqual('unknown control is never retained in the keeper reconnect outbox', proc.outbox.length, 0);
    proc.state = 'pending';
    const written = s._write({ type: 'control_request', request: { subtype: 'interrupt' } });
    checkEqual('a service control cannot enter a pending keeper replay queue', [written.delivery, proc.outbox.length], ['not_written', 0]);
    // This is an injected handle; retire it without a real keeper lifecycle.
    s.proc = null; proc.exitCode = 0;
  } finally { await f.close(); }

  suite('P1-15 T24/T34: a possibly delivered approval stays consumed and unknown');
  f = await fixture();
  try {
    const s = await f.session(), run = permission(s), proc = s.proc;
    const write = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (...args) => { write(...args); throw new Error('fixture accepted response, lost write confirmation'); };
    const original = message(f.store, 30, { type: 'permission', run, requestId: 'reused-approval', allow: true });
    const unknown = await f.runtime.dispatch(ctx(s), original);
    checkEqual('lost write confirmation is admitted unknown', [unknown.admitted, unknown.outcome, unknown.error?.code, responses(f).length], [true, 'unknown', 'OUTCOME_UNKNOWN', 1]);
    const other = await f.runtime.dispatch(ctx(s, 'device:competitor'), message(f.store, 31, { type: 'permission', run, requestId: 'reused-approval', allow: false }));
    checkEqual('uncertainty never reopens the pending approval', [other.error?.code, responses(f).length], ['APPROVAL_RESOLVED', 1]);
    proc.stdin.write = write;
    const reopened = await f.reopen();
    const replay = await f.runtime.dispatch(ctx(s), original);
    checkEqual('disk reopen retains the unknown result and never repeats the write', [replay.status, replay.outcome, responses(f).length], ['duplicate', 'unknown', 1]);
    checkEqual('retained unknown approval has its complete original precondition', reopened.store.snapshot().outbox[0].payload.message.run, run);
    const historyOnly = await f.runtime.dispatch(ctx(s), message(reopened.store, 32, { type: 'permission', run: s._engineControls.run(), requestId: 'reused-approval', allow: true }));
    checkEqual('historical permission items do not restore live pending authority', historyOnly.error?.code, 'STALE_TURN');
  } finally { await f.close(); }

  suite('P1-15 legacy default: ordinary windows retain their existing control behavior');
  f = await fixture();
  try {
    const s = new Session({ id: 'legacy-default', cwd: f.f.dir, autoTitle: false, spawner: f.claude.spawn });
    s.start();
    checkEqual('legacy window approval still uses the existing boolean API', s.respondToPermission('legacy-id', true), true);
    checkEqual('legacy framing is unchanged', responses(f).at(-1)?.response.request_id, 'legacy-id');
    checkEqual('legacy windows have no service control tracker', s._engineControls, undefined);
    s.dispose(); await tick();
  } finally { await f.close(); }
};
