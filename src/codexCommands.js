'use strict';

const { requireThat, immutable, canonical, object } = require('./protocolV2');
const { wireError } = require('./receiptDispatcher');
const { providerFor } = require('./codexDelivery');
const NAMES = new Set(['plan', 'goal', 'review', 'fork', 'undo', 'model', 'effort']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Local Codex slash commands are intents too. Freeze their implicit source,
// settings and read-derived targets before admission; never send the slash text
// as an ordinary turn or call the legacy command queue/writer fallback.
function captureCommand(session, message) {
  const match = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(message.text.trim());
  if (!match || match[1].toLowerCase() === 'steer') return null;
  const name = match[1].toLowerCase(), args = (match[2] || '').trim();
  requireThat(NAMES.has(name), 'UNSUPPORTED');
  const precondition = { run: session._engineControls.run(), threadId: session.threadId, cwd: session.cwd,
    history: session._historyVersion, goal: session._goalVersion };
  const plan = { name, args, precondition, settings: structuredClone(session._turnSettings()), mode: session.meta.mode || 'default' };
  if (name === 'plan') {
    requireThat(!args || ['on', 'off'].includes(args));
    plan.choice = { mode: args ? args === 'on' ? 'plan' : 'default' : session.meta.mode === 'plan' ? 'default' : 'plan' };
  }
  if (name === 'fork' || name === 'undo') requireThat(!args);
  if (name === 'review') {
    const parts = args.split(/\s+/);
    if (args) requireThat(parts[0] === 'commit' ? parts.length === 2 && !!parts[1] : parts.length === 1);
    plan.target = !args ? { type: 'uncommittedChanges' } : parts[0] === 'commit' ? { type: 'commit', sha: parts[1] } : { type: 'baseBranch', branch: args };
  }
  if (['review', 'undo'].includes(name)) requireThat(!session.inTurn && !session._sending && !session.readOnly, 'STALE_RESOURCE');
  if (name === 'goal' && args) {
    const status = { pause: 'paused', resume: 'active', done: 'complete' }[args];
    if (status) requireThat(session.meta.goal, 'NOT_FOUND');
    plan.method = args === 'clear' ? 'thread/goal/clear' : 'thread/goal/set';
    plan.params = args === 'clear' ? { threadId: session.threadId, origin: 'user' }
      : status ? { threadId: session.threadId, status, origin: 'user' }
        : { threadId: session.threadId, objective: args, status: 'active', origin: 'user' };
  }
  return plan;
}
function validateSource(session, plan) {
  requireThat(!session.disposed && session.threadId === plan.precondition.threadId && session.cwd === plan.precondition.cwd &&
    canonical(session._engineControls.run()) === canonical(plan.precondition.run), 'STALE_RESOURCE');
  if (plan.name === 'undo') requireThat(!session.inTurn && session._historyVersion === plan.precondition.history && !session.readOnly, 'STALE_RESOURCE');
  if (plan.name === 'review') requireThat(!session.inTurn && !session.readOnly, 'STALE_RESOURCE');
  if (plan.name === 'goal') requireThat(session._goalVersion === plan.precondition.goal, 'STALE_RESOURCE');
}
async function discoverCommand(session, plan, revalidate) {
  if (!plan) return;
  revalidate(); validateSource(session, plan);
  requireThat(session.loaded && session.workspace.client.proc, 'STALE_RESOURCE');
  if (plan.name === 'review' && !plan.settings.model) {
    const models = await session.workspace.models(); revalidate(); validateSource(session, plan);
    const model = models.find((m) => m.isDefault) || models[0]; requireThat(model, 'PROVIDER_REJECTED');
    const id = model.model || model.id, effort = plan.settings.effort || model.defaultReasoningEffort || null;
    plan.settings = { model: id, effort, collaborationMode: { mode: plan.mode,
      settings: { model: id, reasoning_effort: effort, developer_instructions: null } } };
  } else if (['model', 'effort'].includes(plan.name)) {
    const models = await session.workspace.models(); revalidate(); validateSource(session, plan);
    if (plan.name === 'model' && !plan.args) plan.notice = 'Models (* current):\n' + models.map((m) => (m.id === session.meta.model ? '* ' : '  ') + m.id).join('\n');
    else {
      const parts = plan.args.split(/\s+/), id = plan.name === 'model' ? parts[0] : session.meta.model;
      requireThat(plan.args && parts.length <= (plan.name === 'model' ? 2 : 1));
      const model = models.find((m) => m.id === id || m.model === id); requireThat(model, 'BAD_MESSAGE');
      const supported = (model.supportedReasoningEfforts || []).map((e) => e.reasoningEffort || e);
      const asked = plan.name === 'model' ? parts[1] : plan.args;
      requireThat(!asked || EFFORTS.includes(asked) && supported.includes(asked));
      plan.choice = { ...(plan.name === 'model' ? { model: model.model || model.id } : {}),
        effort: asked || (supported.includes(session.effort) ? session.effort : model.defaultReasoningEffort) || '' };
    }
  } else if (plan.name === 'undo') {
    const page = await session.workspace.client.request('thread/turns/list', { threadId: session.threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
    revalidate(); validateSource(session, plan);
    const last = page?.data?.[0]; requireThat(!last || last.status !== 'inProgress', 'STALE_RESOURCE');
    plan.beforeTurnId = last?.id || null;
  } else if (plan.name === 'goal' && !plan.args) {
    const response = await session.workspace.client.request('thread/goal/get', { threadId: session.threadId });
    revalidate(); validateSource(session, plan);
    const goal = response?.goal; plan.notice = goal ? 'Goal (' + goal.status + '): ' + goal.objective : 'No goal set.';
  }
}
function validateCommand(plan) {
  requireThat(object(plan) && NAMES.has(plan.name) && typeof plan.args === 'string' && object(plan.precondition) && object(plan.settings), 'STORAGE_UNAVAILABLE');
  require('./protocolV2').validateRun(plan.precondition.run);
  requireThat(typeof plan.precondition.threadId === 'string' && typeof plan.precondition.cwd === 'string', 'STORAGE_UNAVAILABLE');
  if (plan.name === 'goal' && plan.args) requireThat(['thread/goal/set', 'thread/goal/clear'].includes(plan.method) &&
    plan.params?.threadId === plan.precondition.threadId, 'STORAGE_UNAVAILABLE');
}
async function deliverCommand({ engine, session, item, phase, permitted, saveChoice, saveDestination }) {
  const plan = immutable(item.payload.command), provider = providerFor(engine, session, item.correlation);
  let crossed = false;
  const check = () => {
    requireThat(permitted() && engine.codex.get(session.id) === session && engine.account.home === item.payload.providerTarget.account, 'FORBIDDEN');
    validateSource(session, plan);
  };
  async function request(method, params) {
    check(); await phase('command:' + method, provider); check(); crossed = true;
    return session.workspace.client.request(method, params);
  }
  try {
    validateCommand(plan); check();
    if (plan.choice) {
      crossed = true; // the desired setting itself is an authoritative effect
      await saveChoice(plan.choice, check); check();
      session.codexSettings = { ...(session.codexSettings || {}), ...plan.choice };
      Object.assign(session._chosenSettings, plan.choice);
      session._settings({ model: plan.choice.model || session.meta.model, effort: plan.choice.effort ?? session.effort,
        collaborationMode: { mode: plan.choice.mode || session.meta.mode } });
      session._notice(plan.name === 'plan' ? 'Plan mode ' + (plan.choice.mode === 'plan' ? 'on.' : 'off.')
        : 'Model: ' + session.meta.model + (session.effort ? '; effort: ' + session.effort : '') + '.');
    } else if (plan.notice) session._notice(plan.notice);
    else if (plan.name === 'goal') {
      const response = await request(plan.method, plan.params);
      if (plan.method === 'thread/goal/set') requireThat(response?.goal, 'OUTCOME_UNKNOWN');
      check(); session._goal(plan.method === 'thread/goal/clear' ? null : response.goal);
      const goal = session.meta.goal; session._notice(goal ? 'Goal (' + goal.status + '): ' + goal.objective : 'Goal cleared.');
    } else if (plan.name === 'review') {
      await request('thread/settings/update', { threadId: session.threadId, ...plan.settings });
      const response = await request('review/start', { threadId: session.threadId, target: plan.target, delivery: 'inline' });
      provider.turnId = response?.turn?.id || null;
      requireThat(provider.turnId, 'OUTCOME_UNKNOWN');
      if (!session.disposed && engine.codex.get(session.id) === session) {
        if (response.turn.status === 'inProgress' && !session._drawnTurns.has(provider.turnId)) session.turnId = provider.turnId;
        session._setStatus(response.turn.status === 'inProgress' ? 'working' : 'done'); session._notice('Review started in this conversation.');
      }
      return { state: response.turn.status === 'inProgress' ? 'accepted' : 'completed', provider };
    } else if (plan.name === 'fork') {
      const response = await request('thread/fork', { threadId: session.threadId, excludeTurns: true });
      check(); const child = engine.codex._adopt(response?.thread); requireThat(child, 'OUTCOME_UNKNOWN');
      await saveDestination(child.id);
      child._settings({ ...response, collaborationMode: { mode: plan.settings.collaborationMode?.mode || 'default' } });
      child.loaded = true; child.writerAuthority = 'engine'; child.everStarted = true;
      try { await child._loadTurns(true); await child._readGoal(); } catch (_) { /* optional snapshot, fork is known */ }
      session._notice('Conversation forked.'); session.emit('open', child.id, item.payload.requester || null);
    } else if (plan.name === 'undo') {
      if (!plan.beforeTurnId) session._notice('No turn to undo. Files on disk are NOT reverted.');
      else {
        const response = await request('thread/revert', { threadId: session.threadId, beforeTurnId: plan.beforeTurnId });
        check(); if (response?.thread) session.update(response.thread);
        session._historyVersion++; session.items = []; session._index.clear(); session._drawnFrom.clear(); session._drawnTurns.clear();
        session._kept = []; session._more = false; session.turns = 0; session.turnId = null; session._clearMac();
        session.workspace.cache.write(session.threadId, { turns: [], more: false, savedAt: Date.now() }); session.emit('reset');
        try { await session._loadTurns(true); } catch (_) { /* mutation already known */ }
        session._notice('Last turn removed. Files on disk are NOT reverted.');
      }
    } else requireThat(false, 'UNSUPPORTED');
    return { state: 'completed', provider };
  } catch (error) {
    const rejected = !crossed || error.delivery === 'not_written';
    return { state: rejected ? 'rejected' : 'unknown', provider,
      error: wireError(rejected && ['STALE_RESOURCE', 'FORBIDDEN', 'UNSUPPORTED', 'BAD_MESSAGE', 'NOT_FOUND'].includes(error.code) ? error.code
        : rejected ? 'PROVIDER_REJECTED' : 'OUTCOME_UNKNOWN') };
  }
}
module.exports = { captureCommand, discoverCommand, validateCommand, deliverCommand };
