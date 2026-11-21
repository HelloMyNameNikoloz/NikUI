'use strict';

const { fixture, ctx, message } = require('./helpers/engine-provider');
const { loadCorpus, validateSchema } = require('./helpers/protocol-v2-fixtures');

const baseRun = 'a81ec16e4ac74040a9107dbe669380b5';
const finish = (s) => s._handleResult({ type: 'result', is_error: false });
const begin = (s) => s._beginOwnTurn();
const permission = (s) => s._handleControlRequest({ type: 'control_request', request_id: 'approval-11',
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'fixture only' } } });

module.exports = async function () {
  const corpus = loadCorpus(); let count = 0;
  suite('P1-15/16 runtime conformance: 18 shared run/control vectors on real service adapters');
  for (const vector of corpus.vectors.values()) if (vector.id.startsWith('binding-') && !/terminal|pr-relinked/.test(vector.id)) {
    const id = vector.id, codex = /codex|steer|question|promote/.test(id);
    const delayed = !!vector.initial.afterOwnerLookup;
    const f = await fixture({ ...(delayed ? { writer: 'external', ipcAction: () => ({}) } : {}) });
    try {
      const s = codex || delayed ? await f.codex() : await f.session();
      let older, current, background = null, queueId = null;
      if (s.provider === 'codex') { s.turnId = 'turn-9'; current = s._engineControls.run(); older = { ...current, turn: 'turn-8' }; }
      else {
        older = s._engineControls.run();
        if (vector.initial.task) s._handleBackgroundTasks([{ task_id: vector.initial.task.id, task_type: 'local_bash', description: 'fixture finite build' }]);
        finish(s); begin(s); current = s._engineControls.run(); permission(s);
      }
      const actualRuns = new Map([[baseRun, current.id]]);
      const actualTurns = new Map([['turn-9', current.turn], ['turn-8', older.turn]]);
      if (vector.initial.backgroundToken) {
        s._handleBackgroundTasks([{ task_id: 'bg-agent', task_type: 'local_agent', description: 'fixture agent' }]); finish(s);
        background = s._engineControls.run(); actualTurns.set(vector.initial.backgroundToken, background.turn);
        if (id.endsWith('-changed')) s._handleBackgroundTasks([{ task_id: 'changed-agent', task_type: 'local_agent', description: 'fixture replacement' }]);
      }
      if (vector.initial.question) s.handleRequest({ id: vector.initial.question.requestId, method: 'item/tool/requestUserInput',
        params: { threadId: s.threadId, turnId: s.turnId, questions: [{ id: 'fixture-question', question: 'Continue?' }] } });
      if (id.includes('promote')) {
        const seed = await f.runtime.dispatch(ctx(s, vector.context.principal), message(f.store, 900, { type: 'send', text: 'queued fixture' }));
        queueId = seed.result.data.queueId;
      }
      const mapRun = (run) => ({ id: actualRuns.get(run.id) || run.id, turn: actualTurns.get(run.turn) || run.turn });
      const original = vector.input.find((step) => step.direction === 'client').message;
      const m = { ...structuredClone(original), scope: f.store.receiptInfo().scope };
      if (m.run) m.run = mapRun(m.run);
      if (m.answerTo) m.answerTo.run = mapRun(m.answerTo.run);
      if (queueId) m.id = queueId;
      if (vector.initial.approvalWinner) await f.runtime.dispatch(ctx(s, vector.context.principal), { ...m, mid: vector.initial.approvalWinner });
      if (vector.initial.storedApplied) {
        await f.runtime.dispatch(ctx(s, vector.context.principal), m);
        s._engineControls.rotate(s.proc); begin(s); permission(s);
      }
      if (delayed) f.engine.codex.ipc.ownerOf = async () => { s.turnId = 'turn-10'; return 'fixture-owner'; };
      const effects = () => f.claude.calls.filter((c) => ['control_request', 'control_response'].includes(c.type)).length +
        f.rpc.calls.filter((c) => ['turn/start', 'turn/steer', 'turn/interrupt'].includes(c.method) || c.result && c.id !== undefined).length +
        (f.router?.calls.filter((c) => /^thread-follower-/.test(c.method)).length || 0);
      const before = effects(), answer = await f.runtime.dispatch(ctx(s, vector.context.principal), m);
      if (answer.result?.code === 'accepted') { f.runtime.start(); await f.runtime.drain(ctx(s).target); await f.runtime.flush(); }
      const normalize = (reply) => {
        const copy = structuredClone(reply); copy.scope = original.scope; copy.target = vector.context.target;
        if (copy.error) delete copy.error.message;
        if (copy.result?.data.run) {
          const run = copy.result.data.run;
          run.id = [...actualRuns].find(([, actual]) => actual === run.id)?.[0] || run.id;
          run.turn = [...actualTurns].find(([, actual]) => actual === run.turn)?.[0] || run.turn;
        }
        if (copy.result?.data.instance) copy.result.data.instance = 'instance-7';
        if (copy.result?.data.queueId) copy.result.data.queueId = 'q-29';
        return copy;
      };
      checkEqual(id + ' recorded reply', normalize(answer), normalize({ ...vector.expected.replies[0], target: vector.context.target }));
      checkEqual(id + ' provider effect count', effects() - before, vector.expected.effects.provider);
      check(id + ' ack schema', validateSchema(answer, corpus.schema.$defs.ack, corpus.schema));
      count++;
    } finally { await f.close(); }
  }
  checkEqual('all 18 applicable shared control vectors executed through production handlers', count, 18);
};
