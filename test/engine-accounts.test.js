'use strict';

const { fixture, ctx, message } = require('./helpers/engine-provider');
const { createEngineState } = require('../src/engineState');
const { errorCode, disk } = require('./helpers/engine-disk');
const { CONTROL_STATE } = require('../src/providerControls');

module.exports = async function () {
  suite('P1-16 T31: one canonical selected account persists independently of provider availability');
  const a = await fixture(), b = await fixture();
  try {
    const first = await a.codex(), second = await b.codex();
    checkEqual('identical provider thread IDs are possible in separate account engines', first.threadId, second.threadId);
    check('resolved homes, opaque account IDs and authorities are distinct', a.engine.account.home !== b.engine.account.home &&
      a.engine.account.id !== b.engine.account.id && a.store.receiptInfo().scope !== b.store.receiptInfo().scope);
    const wrong = await errorCode(() => a.runtime.register({ id: 'cx-other', threadId: 'other', provider: 'codex', cwd: a.f.dir, account: b.engine.account.home }));
    checkEqual('a second account cannot be registered through the current-state adapter', wrong, 'BAD_MESSAGE');
    const before = b.rpc.processes.length;
    checkEqual('another selected account cannot open this authoritative thread/outbox namespace', await errorCode(() =>
      createEngineState({ authority: a.store, engine: b.engine, root: a.f.dir })), 'STORAGE_UNAVAILABLE');
    checkEqual('account refusal performs no provider discovery/spawn', b.rpc.processes.length, before);
    check('rejected account selection does not poison or reset the original writer', a.store.status().writable);
    const m = message(a.store, 600, { type: 'send', text: 'selected account only' });
    const accepted = await a.runtime.dispatch(ctx(first), m);
    checkEqual('frozen provider target uses the original canonical account', a.runtime.snapshot().outbox[0].payload.providerTarget.account, a.engine.account.home);
    checkEqual('the refused second engine cannot mutate the original receipt', (await a.runtime.dispatch(ctx(first), m)).result, accepted.result);
  } finally { await a.close(); await b.close(); }

  suite('P1-15 recovery: incompatible pending-control authority refuses before effects');
  const f = disk(); let calls = 0;
  try {
    const store = await f.open(); let runtime = await createEngineState({ authority: store, root: f.dir });
    await runtime.dispose();
    await store.commit((state) => { state.values[CONTROL_STATE] = { v: 2, instances: [], claims: [] }; });
    checkEqual('newer control schema cannot silently become empty pending authority', await errorCode(() =>
      createEngineState({ authority: store, root: f.dir, deliver: () => { calls++; return { state: 'accepted' }; } })), 'STORAGE_UNAVAILABLE');
    checkEqual('incompatible controls never trigger a provider fallback', calls, 0);
  } finally { await f.dispose(); }
};
