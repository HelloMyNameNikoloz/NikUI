'use strict';

const crypto = require('crypto');
const { requireThat, failure, validateRun, object, HEX32 } = require('./protocolV2');
const { wireError } = require('./receiptDispatcher');

const CONTROL_STATE = 'engine.controls.v1';
const token = () => crypto.randomBytes(16).toString('hex');
const sameRun = (a, b) => !!a && !!b && a.id === b.id && a.turn === b.turn;
const agents = new Set(['local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow']);
function validateControlState(data) {
  if (data === undefined) return;
  try {
    requireThat(object(data) && data.v === 1 && Array.isArray(data.instances) && Array.isArray(data.claims));
    const text = (value) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024;
    const identity = (entry, task = false) => {
      requireThat(object(entry) && HEX32.test(entry.identity) && typeof entry.claimed === 'boolean' && !Object.hasOwn(entry, 'source') &&
        (entry.resolved === undefined || typeof entry.resolved === 'boolean') && (task ? text(entry.taskId) : text(entry.requestId)));
      validateRun(entry.run);
    };
    for (const instance of data.instances) {
      requireThat(object(instance) && text(instance.instance) && Array.isArray(instance.pending) && Array.isArray(instance.tasks));
      validateRun(instance.run);
      instance.pending.forEach((entry) => identity(entry)); instance.tasks.forEach((entry) => identity(entry, true));
      requireThat(new Set(instance.pending.map((entry) => entry.requestId)).size === instance.pending.length &&
        new Set(instance.tasks.map((entry) => entry.taskId)).size === instance.tasks.length);
      if (instance.question !== null) identity(instance.question);
      if (instance.seenApprovals !== undefined) requireThat(Array.isArray(instance.seenApprovals) && instance.seenApprovals.every(text));
      if (instance.seenTasks !== undefined) {
        requireThat(Array.isArray(instance.seenTasks));
        for (const entry of instance.seenTasks) { requireThat(object(entry) && text(entry.taskId)); validateRun(entry.run); }
      }
      if (instance.providerExecution != null) requireThat(object(instance.providerExecution) && text(instance.providerExecution.runId) &&
        Number.isSafeInteger(instance.providerExecution.seq) && instance.providerExecution.seq >= 0 &&
        (instance.providerExecution.conversation === null || text(instance.providerExecution.conversation)));
    }
    requireThat(new Set(data.instances.map((entry) => entry.instance)).size === data.instances.length &&
      new Set(data.claims.map((entry) => entry.key)).size === data.claims.length && data.claims.every((entry) => object(entry) &&
        HEX32.test(entry.key) && text(entry.instance) && HEX32.test(entry.owner) && ['permission', 'question', 'stopTask'].includes(entry.kind)));
  } catch (_) { throw failure('STORAGE_UNAVAILABLE', 'Persisted provider controls are unavailable or incompatible.'); }
}
const disposition = (delivery, data) => delivery === 'submitted'
  ? { outcome: 'applied', result: { code: 'ok', data: { ...data, delivery }, replies: [] } }
  : { outcome: delivery === 'not_written' ? 'rejected' : 'unknown', error: wireError(delivery === 'not_written' ? 'PROVIDER_REJECTED' : 'OUTCOME_UNKNOWN') };

/** Live provider authority, deliberately excluded from keeper checkpoints and
 * transcript hydration. Installed only by the service state owner. */
function createProviderControls(session, changed = () => {}, prior = null, retainedClaims = []) {
  let execution = token(), connection, foreground = null, lastTurn = null, background = null;
  const pending = new Map(), tasks = new Map(), announcedTasks = new Map();
  const seenApprovals = new Set([...(prior?.seenApprovals || []), ...(prior?.pending || []).map((entry) => entry.requestId)]);
  const seenTasks = new Map([...(prior?.seenTasks || []), ...(prior?.tasks || [])].map((entry) => [entry.taskId, entry.run]));
  let question = null;
  const codex = session.provider === 'codex';
  const transport = () => codex ? session.workspace.client.proc : session.proc;
  function rotate(proc = transport()) {
    connection = proc; execution = token(); foreground = null; lastTurn = null; background = null;
    for (const [id, task] of tasks) seenTasks.set(id, task.run);
    pending.clear(); tasks.clear(); announcedTasks.clear(); question = null;
    if (codex) { session._pendingRpc?.clear(); session._question = null; }
  }
  function sync() { if (connection !== transport()) rotate(); }
  function run() {
    sync();
    const providerTurn = typeof session.turnId === 'string' && session.turnId && Buffer.byteLength(session.turnId) <= 256 ? session.turnId : null;
    return { id: execution, turn: codex ? providerTurn : session.inTurn ? foreground : background };
  }
  function issuing() {
    const live = run();
    if (!codex && !foreground && session.inTurn) foreground = lastTurn = 'turn:' + token();
    return { id: live.id, turn: codex ? live.turn : foreground || lastTurn };
  }
  function record(kind, id, identity, providerTurn) {
    sync();
    const issuingRun = issuing(), previous = kind === 'question' ? question : pending.get(String(id));
    if (codex && providerTurn !== undefined) issuingRun.turn = typeof providerTurn === 'string' && providerTurn && Buffer.byteLength(providerTurn) <= 256 ? providerTurn : null;
    // An identical provider retransmission shares authority; a reused ID in
    // the same issuing turn is ambiguous and cannot create another answer.
    if (previous && sameRun(previous.run, issuingRun) && previous.requestId === String(id)) {
      if (previous.source !== identity) previous.resolved = true;
      return previous;
    }
    const legacySafe = !seenApprovals.has(String(id)) && !session.items.some((item) => item.kind === 'permission' && item.requestId === String(id) && item.run?.id !== execution);
    seenApprovals.add(String(id));
    const entry = { kind, requestId: String(id), identity: token(), run: issuingRun, source: identity, claimed: false, legacySafe };
    if (kind === 'question') question = entry; else pending.set(String(id), entry);
    return entry;
  }
  const api = {
    rotate,
    beginTurn() { if (session.catchingUp) return; sync(); foreground = lastTurn = 'turn:' + token(); changed(); },
    endTurn() {
      if (session.catchingUp) return;
      foreground = null;
      for (const entry of pending.values()) entry.resolved = true;
      if (question) question.resolved = true;
      changed();
    },
    run,
    approval(id, identity, providerTurn) {
      if (session.catchingUp) return null;
      const entry = record('permission', id, identity, providerTurn); changed(); return structuredClone(entry.run);
    },
    question(id, identity, providerTurn) {
      const entry = record('question', id, identity, providerTurn); changed();
      return { requestId: entry.requestId, run: structuredClone(entry.run) };
    },
    resolved(id) {
      const entry = pending.get(String(id)); if (entry) entry.resolved = true;
      if (question?.requestId === String(id)) question.resolved = true;
      changed();
    },
    taskStarted(id, type) {
      sync();
      if (!id || session.catchingUp) return;
      if (!announcedTasks.has(id)) announcedTasks.set(id, tasks.get(id) || { taskId: id, type, identity: token(), run: issuing(), claimed: false });
      else {
        announcedTasks.get(id).resolved = true; // reused provider identity cannot acquire fresh authority
        if (background) background = 'bg:' + token();
      }
      changed();
    },
    taskFinished(id) {
      if (session.catchingUp) return;
      const entry = tasks.get(id) || announcedTasks.get(id);
      if (entry) { entry.resolved = true; seenTasks.set(id, entry.run); }
      background = [...tasks.values()].some((task) => agents.has(task.type) && !task.resolved) ? 'bg:' + token() : null;
      announcedTasks.delete(id); changed();
    },
    background(list) {
      if (session.catchingUp) return;
      sync();
      const active = new Set(list.map((t) => t.id)); let altered = false;
      for (const id of tasks.keys()) if (!active.has(id)) { seenTasks.set(id, tasks.get(id).run); tasks.delete(id); altered = true; }
      for (const task of list) {
        if (!tasks.has(task.id)) {
          const run = announcedTasks.get(task.id)?.run || issuing(), previous = seenTasks.get(task.id);
          const entry = announcedTasks.get(task.id) || { taskId: task.id, type: task.type, identity: token(), run, claimed: false };
          entry.type = task.type;
          entry.resolved = !!entry.resolved || sameRun(previous, run); entry.legacySafe = !previous;
          tasks.set(task.id, entry); altered = true;
        }
        task.run = structuredClone(tasks.get(task.id).run);
      }
      if (altered) background = [...tasks.values()].some((task) => agents.has(task.type) && !task.resolved) ? 'bg:' + token() : null;
      changed();
    },
    hasQuestion() { sync(); return codex && !!session._question; },
    legacy(kind, fields = {}) {
      sync();
      requireThat(!(codex && kind === 'stopTask'), 'UNSUPPORTED');
      const entry = kind === 'permission' ? pending.get(String(fields.requestId)) : kind === 'stopTask' ? tasks.get(fields.taskId) : null;
      if (kind !== 'interrupt') requireThat(entry && entry.legacySafe && !entry.claimed && !entry.resolved, 'STALE_RUN');
      const expected = entry ? entry.run : run();
      requireThat(expected.turn !== null, 'STALE_RUN');
      return structuredClone(expected);
    },
    snapshot() {
      const simplify = (entry) => { const { source, ...data } = entry; return structuredClone(data); };
      return { instance: session.id, run: run(), pending: [...pending.values()].map(simplify),
        tasks: [...tasks.values()].map(simplify), question: question ? simplify(question) : null,
        seenApprovals: [...seenApprovals], seenTasks: [...seenTasks].map(([taskId, run]) => ({ taskId, run })),
        providerExecution: !codex && session.proc?.kept ? { runId: session.proc.runId, seq: session.proc.seq,
          conversation: session.claudeSessionId } : null };
    },
    reattach() {
      // D19 has already proved this exact private keeper run and replayed its
      // complete checkpoint/tail. Restore only pending identities previously
      // fsynced by this authority, never identities inferred from transcript.
      const proc = session.proc, proof = prior?.providerExecution;
      if (codex || !proc?.kept || proc.state !== 'kept' || !proof || proof.runId !== proc.runId ||
          proof.seq > proc.seq || proof.conversation !== session.claudeSessionId) return false;
      sync();
      const turns = new Map(), rebound = (run) => {
        if (!run?.turn) return null;
        if (!turns.has(run.turn)) turns.set(run.turn, 'turn:' + token());
        return { id: execution, turn: turns.get(run.turn) };
      };
      if (session.inTurn && prior.run.turn && !prior.run.turn.startsWith('bg:')) foreground = lastTurn = rebound(prior.run).turn;
      for (const old of prior.pending) {
        const item = session.items.filter((item) => item.kind === 'permission' && item.requestId === old.requestId &&
          !item.resolved && sameRun(item.run, old.run)).at(-1);
        const run = rebound(old.run);
        if (!item || !run || !session.inTurn) continue;
        const entry = { ...structuredClone(old), run, legacySafe: false,
          claimed: old.claimed || retainedClaims.some((claim) => claim.key === old.identity), source: { runId: proc.runId } };
        pending.set(entry.requestId, entry); item.run = structuredClone(run);
      }
      for (const old of prior.tasks) {
        const task = session.backgroundTasks.find((task) => task.id === old.taskId && sameRun(task.run, old.run));
        const run = rebound(old.run); if (!task || !run) continue;
        tasks.set(old.taskId, { ...structuredClone(old), run, legacySafe: false,
          claimed: old.claimed || retainedClaims.some((claim) => claim.key === old.identity) });
        task.run = structuredClone(run);
      }
      if ([...tasks.values()].some((task) => agents.has(task.type) && !task.resolved)) background = 'bg:' + token();
      changed(); return true;
    },
    capture(message) {
      try {
        sync();
        const kind = message.type === 'send' ? message.answerTo ? 'question' : /^\/steer(?:\s|$)/i.test(message.text.trim()) ? 'steer' : 'send'
          : message.type === 'promoteQueued' ? 'steer' : message.type;
        const expected = kind === 'question' ? message.answerTo.run : message.run;
        requireThat(!(codex && kind === 'stopTask'), 'UNSUPPORTED');
        if (kind === 'send') {
          requireThat(!api.hasQuestion(), 'BAD_MESSAGE');
          requireThat(!message.run, 'UNSUPPORTED');
          return { session, connection, execution, kind };
        }
        validateRun(expected);
        requireThat(expected.id === execution, 'STALE_RUN');
        requireThat(expected.turn !== null, 'STALE_TURN');
        let entry = null;
        if (kind === 'permission' || kind === 'question') {
          entry = kind === 'question' ? question : pending.get(message.requestId);
          requireThat(entry, kind === 'question' ? 'STALE_TURN' : 'APPROVAL_RESOLVED');
          requireThat(entry.run.id === expected.id, 'STALE_RUN');
          requireThat(entry.run.turn === expected.turn, 'STALE_TURN');
          requireThat(kind !== 'question' || entry.requestId === message.answerTo.requestId, 'STALE_TURN');
          requireThat(!entry.claimed && !entry.resolved, 'APPROVAL_RESOLVED');
        } else if (kind === 'stopTask') {
          requireThat(!codex, 'UNSUPPORTED');
          entry = tasks.get(message.taskId);
          requireThat(entry && (entry.type === 'local_bash' || agents.has(entry.type)), 'STALE_RESOURCE');
          requireThat(sameRun(entry.run, expected), 'STALE_TURN');
          requireThat(!entry.claimed && !entry.resolved, 'STALE_RESOURCE');
        } else {
          requireThat(kind !== 'steer' || codex, 'UNSUPPORTED');
          requireThat(sameRun(run(), expected), 'STALE_TURN');
        }
        return { session, connection, execution, kind, run: structuredClone(expected), entry,
          backgroundTargets: kind === 'interrupt' && !codex && !session.inTurn
            ? [...tasks.values()].filter((task) => agents.has(task.type) && !task.resolved) : null };
      } catch (error) { return { error }; }
    },
    validate(binding) {
      if (binding?.error) throw binding.error;
      sync();
      requireThat(binding?.session === session && binding.execution === execution && binding.connection === transport() &&
        !session.disposed && !session._attaching && !session.catchingUp && !session.elsewhere, 'STALE_RUN');
      if (binding.kind === 'send') { requireThat(!api.hasQuestion(), 'BAD_MESSAGE'); return; }
      requireThat(codex ? !!session.workspace.client.proc : session.isRunning, 'STALE_RUN');
      if (binding.entry) {
        const live = binding.kind === 'question' ? question : binding.kind === 'stopTask' ? tasks.get(binding.entry.taskId) : pending.get(binding.entry.requestId);
        requireThat(live === binding.entry && sameRun(live.run, binding.run), 'STALE_RUN');
        requireThat(!live.resolved, 'APPROVAL_RESOLVED');
        if (codex && binding.kind === 'permission') requireThat(session._pendingRpc?.get(live.requestId) === live.source, 'STALE_RUN');
        if (codex && binding.kind === 'question') requireThat(session._question === live.source, 'STALE_RUN');
        if (codex && live.source?.transport === 'ipc') requireThat(live.source.connection === session.workspace.ipc?.sock, 'STALE_RUN');
      } else requireThat(sameRun(run(), binding.run) && (!binding.backgroundTargets ||
        binding.backgroundTargets.every((task) => tasks.get(task.taskId) === task && !task.resolved)), 'STALE_TURN');
    },
    retain(state, binding, owner) {
      api.validate(binding);
      const data = state.values[CONTROL_STATE] || (state.values[CONTROL_STATE] = { v: 1, instances: [], claims: [] });
      const snapshot = api.snapshot(), index = data.instances.findIndex((s) => s.instance === session.id);
      if (index < 0) data.instances.push(snapshot); else data.instances[index] = snapshot;
      if (binding.entry) {
        const key = binding.entry.identity;
        requireThat(!binding.entry.claimed && !data.claims.some((claim) => claim.key === key), binding.kind === 'stopTask' ? 'STALE_RESOURCE' : 'APPROVAL_RESOLVED');
        data.claims.push({ key, instance: session.id, owner, kind: binding.kind });
      }
      return { instance: session.id, kind: binding.kind, run: binding.run || null,
        identity: binding.entry?.identity || null, requestId: binding.entry?.requestId || null, taskId: binding.entry?.taskId || null,
        transport: codex ? binding.entry?.source?.transport || 'rpc' : 'claude',
        targets: binding.backgroundTargets?.map((task) => ({ taskId: task.taskId, identity: task.identity, run: task.run })) || null };
    },
    async execute(binding, message, phase = null, permitted = () => true) {
      let crossed = false;
      const validate = () => { requireThat(permitted(), 'FORBIDDEN'); api.validate(binding); };
      try {
        validate();
        if (binding.entry) binding.entry.claimed = true;
        if (phase) {
          await phase(binding.kind === 'interrupt' && session.readOnly ? 'follower-discovery'
            : (binding.entry?.source?.transport === 'ipc' ? 'ipc-' : 'direct-') + binding.kind);
          validate();
        }
        let delivery;
        if (codex && binding.kind === 'interrupt') {
          const expectedTurnId = binding.run.turn, ipc = session.workspace.ipc;
          if (session.readOnly) {
            const owner = ipc && await ipc.ownerOf(session.threadId);
            validate(); requireThat(owner, 'PROVIDER_REJECTED');
            if (phase) { await phase('follower-interrupt-dispatching'); validate(); }
            await ipc.interrupt(owner, session.threadId, expectedTurnId, { beforeWrite: validate });
          } else {
            validate();
            await session.workspace.client.request('turn/interrupt', { threadId: session.threadId, turnId: expectedTurnId });
          }
          delivery = 'submitted';
        } else if (binding.kind === 'permission') {
          if (codex) delivery = session.respondToPermission(message.requestId, message.allow, { authoritative: true });
          else {
            delivery = session._write({ type: 'control_response', response: { subtype: 'success', request_id: message.requestId,
              response: message.allow ? { behavior: 'allow' } : { behavior: 'deny', message: message.message || 'Denied from NikUI' } } }).delivery;
            if (delivery === 'submitted') session._setStatus('working');
          }
        } else if (binding.kind === 'question') {
          delivery = session._answer(message.sent || message.text, { authoritative: true });
        } else if (binding.kind === 'stopTask') {
          delivery = session._write({ type: 'control_request', request_id: 'nikui-' + token(), request: { subtype: 'stop_task', task_id: message.taskId } }).delivery;
        } else if (binding.kind === 'interrupt') {
          // Claude offers no compare-and-swap turn parameter. Revalidate at
          // the last synchronous boundary; provider scheduling can still race.
          const stop = binding.backgroundTargets
            ? binding.backgroundTargets.map((t) => ({ subtype: 'stop_task', task_id: t.taskId })) : [{ subtype: 'interrupt' }];
          delivery = 'submitted';
          for (const request of stop) {
            validate();
            const written = session._write({ type: 'control_request', request_id: 'nikui-' + token(), request });
            if (written.delivery !== 'not_written') crossed = true;
            if (written.delivery !== 'submitted') { delivery = written.delivery === 'not_written' && stop.length === 1 ? 'not_written' : 'unknown'; break; }
          }
        } else throw failure('UNSUPPORTED');
        changed();
        return disposition(delivery, binding.kind === 'permission'
          ? { requestId: message.requestId, run: binding.run, allow: message.allow }
          : binding.kind === 'question' ? {} : { run: binding.run, taskId: message.taskId || null });
      } catch (error) {
        const definite = ['STALE_RUN', 'STALE_TURN', 'APPROVAL_RESOLVED', 'UNSUPPORTED', 'PROVIDER_REJECTED', 'FORBIDDEN'].includes(error.code);
        return { outcome: !crossed && (definite || error.delivery === 'not_written') ? 'rejected' : 'unknown',
          error: wireError(crossed ? 'OUTCOME_UNKNOWN' : definite ? error.code : error.delivery === 'not_written' ? 'PROVIDER_REJECTED' : 'OUTCOME_UNKNOWN') };
      }
    }
  };
  Object.defineProperty(session, '_engineControls', { configurable: true, value: api });
  sync();
  return api;
}

module.exports = { createProviderControls, validateControlState, CONTROL_STATE, sameRun, disposition };
