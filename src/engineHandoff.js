'use strict';

const path = require('path');
const { fail } = require('./daemonPaths');
const insist = (v, code) => { if (!v) throw fail(code, code); };
const complete = (m) => m && typeof m.instance === 'string' && !!m.instance && path.isAbsolute(m.cwd || '') &&
  (m.conversation === null || typeof m.conversation === 'string' && !!m.conversation);
const validRunDescription = (run) => run && typeof run.runId === 'string' && run.runId && typeof run.key === 'string' && run.key &&
  (run.exit === null ? typeof run.owned === 'boolean' : run.exit && typeof run.exit === 'object' && !Array.isArray(run.exit) &&
    (run.exit.code === null || Number.isInteger(run.exit.code)) &&
    (run.exit.signal === undefined || run.exit.signal === null || typeof run.exit.signal === 'string'));

// Pure transfer eligibility. The keeper remains protocol 1. Ownership comes
// from guarded metadata and an explicit manifest, never checkpoint parsing.
function transferredRun({ hello, runs, transferred, requested }) {
  insist(hello?.metaVersion === 1, 'KEEPER_META_UNSUPPORTED');
  insist(Array.isArray(runs) && complete(requested) && Array.isArray(transferred), 'KEEPER_META_INCOMPLETE');
  const eligible = transferred.find((r) => complete(r.meta) && r.meta.instance === requested.instance &&
    r.meta.cwd === requested.cwd && r.meta.conversation === requested.conversation);
  insist(eligible && typeof eligible.runId === 'string', 'KEEPER_NOT_ELIGIBLE');
  for (const run of runs) {
    insist(validRunDescription(run), 'KEEPER_META_INCOMPLETE');
    if (run.exit) continue;
    insist(complete(run.meta) && run.meta.instance === run.key &&
      (requested.conversation === null || run.meta.conversation !== null), 'KEEPER_META_INCOMPLETE');
    if (run.runId !== eligible.runId && (run.key === requested.instance || requested.conversation && run.meta.conversation === requested.conversation))
      throw fail('KEEPER_CONVERSATION_LIVE', 'Another instance owns the conversation');
  }
  const run = runs.find((r) => r.runId === eligible.runId);
  insist(run && !run.exit, 'KEEPER_RUN_LOST');
  insist(!run.owned, 'KEEPER_OWNED_ELSEWHERE');
  insist(run.meta.instance === requested.instance && run.meta.cwd === requested.cwd && run.meta.conversation === requested.conversation,
    'KEEPER_META_INCOMPLETE');
  insist(eligible.released === true && eligible.compatible === true, 'KEEPER_NOT_ELIGIBLE');
  return { runId: run.runId, guard: { ...requested } };
}

function plannedTransitionReadiness({ currentState, engine, resources }) {
  const state = currentState.status();
  if (state.issue) return { ready: false, code: 'STORAGE_UNAVAILABLE' };
  if (state.dispatches || state.drains || state.observations) return { ready: false, code: 'PROVIDER_DISPATCH_ACTIVE' };
  const outbox = currentState.snapshot().outbox;
  const unknown = outbox.filter((q) => ['dispatching', 'unknown'].includes(q.state));
  if (unknown.length) return { ready: false, code: 'UNSAFE_UPDATE_UNKNOWN', operations: unknown.map((q) => q.id) };
  const accepted = outbox.filter((q) => q.state === 'accepted' && q.provider?.kind === 'codex');
  if (accepted.length) return { ready: false, code: accepted.some((q) => q.provider.ownership === 'owned') ? 'CODEX_OWNED_BUSY' : 'CODEX_EXTERNAL_BUSY',
    operations: accepted.map((q) => q.id) };
  const owned = engine.codex.list.filter((s) => s.inTurn && s.workspace.client.ownership === 'owned');
  if (owned.length) return { ready: false, code: 'CODEX_OWNED_BUSY', instances: owned.map((s) => s.id) };
  const borrowed = engine.codex.list.filter((s) => s.inTurn && (s.readOnly || s.workspace.client.ownership !== 'owned'));
  if (borrowed.length) return { ready: false, code: 'CODEX_EXTERNAL_BUSY', instances: borrowed.map((s) => s.id) };
  // Direct Claude children have no keeper transfer proof. A live turn (or an
  // accepted input whose process disappeared) cannot be declared safe merely
  // because the Codex account is idle. Refusal also covers pending approvals.
  const claude = (engine.manager?.list || []).filter((s) => s.isBusy || s.inTurn);
  if (claude.length) return { ready: false, code: 'CLAUDE_OWNED_BUSY', instances: claude.map((s) => s.id) };
  const acceptedClaude = outbox.filter((q) => q.state === 'accepted' && q.provider?.kind === 'claude');
  if (acceptedClaude.length) return { ready: false, code: 'CLAUDE_OWNED_BUSY', operations: acceptedClaude.map((q) => q.id) };
  const terminals = resources?.terminals?.list?.() || [];
  if (terminals.some((t) => t.busy || t.running || t.status === 'running')) return { ready: false, code: 'TERMINAL_BUSY' };
  return { ready: true };
}

module.exports = { transferredRun, plannedTransitionReadiness, validRunDescription };
