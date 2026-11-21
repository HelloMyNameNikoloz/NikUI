'use strict';

const { fixture, ctx, DROP, tick, stamp } = require('./helpers/engine-provider');
const { loadCorpus, validateSchema } = require('./helpers/protocol-v2-fixtures');

module.exports = async function () {
  const corpus = loadCorpus(); let count = 0;
  suite('P1-16 runtime conformance: all 18 shared Codex uncertainty/axes vectors');
  for (const vector of corpus.vectors.values()) if (vector.id.startsWith('codex-')) {
    const id = vector.id, axes = id.includes('-axes-'), lost = id.endsWith('-reply-lost'), approval = id.includes('-approval-');
    const prior = vector.initial.operation || vector.initial.oldUnknown;
    const expectedOperation = vector.expected.replies.find((reply) => reply.type === 'operation') || prior;
    const descriptor = expectedOperation?.provider;
    const ownership = vector.initial.ownership || descriptor?.ownership || 'owned';
    const writer = vector.initial.writer || descriptor?.writer || 'engine';
    const ipc = vector.initial.transport === 'ipc' || writer === 'external';
    let f, pages = [];
    const action = () => { f.advance(1000); return axes ? { turn: { id: 'turn-9', status: 'inProgress' } } : DROP; };
    f = await fixture({ borrowed: ownership === 'borrowed', writer,
      answers: { 'turn/start': action, 'turn/steer': action, 'thread/turns/list': () => ({ data: pages }) },
      ...(ipc ? { ipcAction: action } : {}) });
    try {
      const s = await f.codex(), context = ctx(s, vector.context.principal);
      const first = vector.input.find((step) => step.direction === 'client')?.message;
      const seed = first && lost ? structuredClone(first) : { type: 'send', mid: prior?.mid || expectedOperation.mid, issuedAt: stamp, text: vector.initial.retainedInput || 'retained input' };
      seed.scope = f.store.receiptInfo().scope;
      if (seed.run || approval) { s.turnId = 'turn-9'; seed.run = s._engineControls.run(); }
      let restoreWrite = null;
      if (approval) {
        if (ipc) {
          await f.router.ipc.connect();
          f.router.ask(seed.requestId, 'item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, command: 'fixture' });
          for (let n = 0; n < 100 && !s.items.some((item) => item.id === 'p:' + seed.requestId); n++) await tick();
          const socket = f.router.ipc.sock, write = socket.write.bind(socket);
          socket.write = (...args) => { write(...args); f.advance(1000); throw new Error('accepted IPC response, lost confirmation'); };
          restoreWrite = () => { socket.write = write; };
        } else {
          const proc = f.rpc.processes[0];
          proc.ask(seed.requestId, 'item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, command: 'fixture' });
          const write = proc.stdin.write.bind(proc.stdin);
          proc.stdin.write = (...args) => { write(...args); f.advance(1000); throw new Error('accepted RPC response, lost confirmation'); };
          restoreWrite = () => { proc.stdin.write = write; };
        }
      }
      const accepted = await f.runtime.dispatch(context, seed);
      if (restoreWrite) restoreWrite();
      if (!approval) { f.runtime.start(); await f.runtime.drain(context.target); await f.runtime.flush(); }
      const saved = f.runtime.snapshot().outbox.find((item) => item.queueId && item.mid === seed.mid);
      let replies = lost ? [accepted] : [];
      if (lost && !approval) replies.push(await f.runtime.operation(context, seed));
      if (id.startsWith('codex-reconcile-')) {
        const evidence = vector.input[0].message;
        if (evidence.authoritativeNonAcceptance) {
          await f.runtime.settleOperation({ scope: seed.scope, principal: context.principal, mid: seed.mid },
            { state: 'rejected', error: { code: 'PROVIDER_REJECTED', message: 'exact provider refusal', retryable: false } },
            { account: saved.provider.account, threadId: s.threadId, clientUserMessageId: saved.correlation, accepted: false });
        } else {
          pages = evidence.clientId ? [{ id: evidence.turnId || 'turn-other', status: 'inProgress', items: [{ type: 'userMessage',
            clientId: evidence.clientId === prior.provider.clientUserMessageId ? saved.correlation : evidence.clientId,
            content: [{ type: 'text', text: evidence.text || '' }] }] }] : evidence.history || [];
          if (evidence.elapsedMs) {
            f.rpc.answers['thread/turns/list'] = () => DROP;
            let refused = false;
            try { await f.runtime.reconcileCodex(s.id); } catch (_) { refused = true; }
            check(id + ' failed provider lookup is not authoritative non-acceptance', refused);
          } else await f.runtime.reconcileCodex(s.id);
        }
        replies.push(await f.runtime.operation(context, seed));
      } else if (axes) replies.push(await f.runtime.operation(context, seed));
      else if (id === 'codex-explicit-new-intent') {
        const next = { ...first, scope: seed.scope };
        await f.runtime.dispatch(context, next); await f.runtime.drain(context.target);
        const all = f.runtime.snapshot().outbox.filter((item) => item.queueId);
        checkEqual(id + ' old unknown stays intact and distinct new mid remains queued', all.map((item) => [item.mid, item.state]), [[seed.mid, 'unknown'], [next.mid, 'queued']]);
      }
      const normalize = (reply) => {
        const copy = structuredClone(reply); copy.scope = first?.scope || descriptor && expectedOperation.scope; copy.target = vector.context.target;
        if (copy.error) delete copy.error.message;
        if (copy.provider) {
          copy.provider.account = descriptor.account; copy.provider.threadId = descriptor.threadId;
          copy.provider.clientUserMessageId = descriptor.clientUserMessageId;
        }
        if (copy.result?.data.instance) copy.result.data.instance = 'instance-7';
        if (copy.result?.data.queueId) copy.result.data.queueId = 'q-29';
        return copy;
      };
      checkEqual(id + ' runtime dispositions', replies.map(normalize), vector.expected.replies.map(normalize));
      for (const reply of replies) check(id + ' wire schema', validateSchema(reply, corpus.schema.$defs[reply.type === 'ack' ? 'ack' : 'operation'], corpus.schema));
      if (lost) {
        const before = f.rpc.calls.length + (f.router?.calls.length || 0);
        await f.reopen(); f.runtime.start(); await f.runtime.drain(context.target);
        checkEqual(id + ' reconnect never retries or takes writer', f.rpc.calls.length + (f.router?.calls.length || 0), before);
      }
      count++;
    } finally { await f.close(); }
  }
  checkEqual('all 18 shared Codex vectors executed through the durable adapter', count, 18);
};
