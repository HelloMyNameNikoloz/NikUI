'use strict';
const { transferredRun, plannedTransitionReadiness } = require('../src/engineHandoff');
const { errorCode } = require('./helpers/engine-disk');

module.exports = async () => {
  suite('P2 T54: only compatible released transferred runs can reattach');
  const meta = { instance: 'transferred', cwd: '/private/synthetic/project', conversation: 'conversation' };
  const run = { runId: 'run-one', key: meta.instance, meta, exit: null, owned: false };
  const transferred = [{ runId: run.runId, meta, released: true, compatible: true }];
  const input = { hello: { protocol: 1, metaVersion: 1 }, runs: [run], transferred, requested: meta };
  checkEqual('released compatible manifest entry returns an exact guarded attach', transferredRun(input), { runId: 'run-one', guard: meta });
  for (const [name, changed, expected] of [
    ['old keeper hello', { hello: { protocol: 1 } }, 'KEEPER_META_UNSUPPORTED'],
    ['unavailable list', { runs: null }, 'KEEPER_META_INCOMPLETE'],
    ['no manifest entry', { transferred: [] }, 'KEEPER_NOT_ELIGIBLE'],
    ['live other owner', { runs: [{ ...run, owned: true }] }, 'KEEPER_OWNED_ELSEWHERE'],
    ['lost run', { runs: [] }, 'KEEPER_RUN_LOST'],
    ['expired grace/exited run', { runs: [{ ...run, exit: { code: 0 } }] }, 'KEEPER_RUN_LOST'],
    ['incomplete live metadata', { runs: [{ ...run, meta: null }] }, 'KEEPER_META_INCOMPLETE'],
    ['unknown live ownership', { runs: [{ ...run, owned: undefined }] }, 'KEEPER_META_INCOMPLETE'],
    ['unknown exit evidence', { runs: [{ ...run, exit: 'uncertain' }] }, 'KEEPER_META_INCOMPLETE'],
    ['checkpoint without guarded metadata', { runs: [{ ...run, meta: null, checkpoint: { ...meta, opaque: true } }] }, 'KEEPER_META_INCOMPLETE'],
    ['not released', { transferred: [{ ...transferred[0], released: false }] }, 'KEEPER_NOT_ELIGIBLE'],
    ['incompatible checkpoint', { transferred: [{ ...transferred[0], compatible: false }] }, 'KEEPER_NOT_ELIGIBLE'],
    ['same Claude conversation under another instance', { runs: [run, { ...run, runId: 'run-other', key: 'alternate', meta: { ...meta, instance: 'alternate' }, owned: true }] }, 'KEEPER_CONVERSATION_LIVE'],
    ['different Claude conversation under same instance', { runs: [run, { ...run, runId: 'run-other', meta: { ...meta, conversation: 'other' } }] }, 'KEEPER_CONVERSATION_LIVE'],
    ['unknown other live run', { runs: [run, { ...run, runId: 'unknown', key: 'unknown', meta: null }] }, 'KEEPER_META_INCOMPLETE'],
    ['unknown conversation in another live run', { runs: [run, { ...run, runId: 'unknown', key: 'unknown', meta: { ...meta, instance: 'unknown', conversation: null } }] }, 'KEEPER_META_INCOMPLETE']
  ]) checkEqual(name + ' refuses without attach or fallback spawn', await errorCode(() => transferredRun({ ...input, ...changed })), expected);
  checkEqual('known exited unrelated runs do not block eligible continuity', transferredRun({ ...input,
    runs: [run, { runId: 'old', key: 'old', exit: { code: 0 } }] }), { runId: 'run-one', guard: meta });

  suite('P2 T58/T60: planned handoff/update refuses unsafe owned and borrowed work');
  const currentState = { status: () => ({ dispatches: 0, drains: 0, observations: 0 }), snapshot: () => ({ outbox: [] }) };
  const engine = { codex: { list: [] } }, resources = { terminals: { list: () => [] } };
  checkEqual('quiescent state is eligible without terminating anything', plannedTransitionReadiness({ currentState, engine, resources }), { ready: true });
  for (const field of ['dispatches', 'drains', 'observations']) checkEqual(field + ' holds the update barrier',
    plannedTransitionReadiness({ currentState: { ...currentState, status: () => ({ [field]: 1 }) }, engine, resources }).code, 'PROVIDER_DISPATCH_ACTIVE');
  checkEqual('unknown committed input refuses unsafe replacement', plannedTransitionReadiness({ currentState: { ...currentState,
    snapshot: () => ({ outbox: [{ id: 'unknown', state: 'unknown' }] }) }, engine, resources }), { ready: false, code: 'UNSAFE_UPDATE_UNKNOWN', operations: ['unknown'] });
  for (const ownership of ['owned', 'borrowed']) checkEqual(ownership + ' busy Codex has its own named refusal',
    plannedTransitionReadiness({ currentState, engine: { codex: { list: [{ id: ownership, inTurn: true, workspace: { client: { ownership } } }] } }, resources }).code,
    ownership === 'owned' ? 'CODEX_OWNED_BUSY' : 'CODEX_EXTERNAL_BUSY');
  checkEqual('accepted owned work remains busy even when its live session disappears', plannedTransitionReadiness({ currentState: { ...currentState,
    snapshot: () => ({ outbox: [{ id: 'accepted', state: 'accepted', provider: { kind: 'codex', ownership: 'owned' } }] }) }, engine, resources }).code, 'CODEX_OWNED_BUSY');
  for (const status of [{ inTurn: true }, { isBusy: true }]) checkEqual('active/waiting direct Claude refuses update',
    plannedTransitionReadiness({ currentState, engine: { ...engine, manager: { list: [{ id: 'claude', ...status }] } }, resources }),
    { ready: false, code: 'CLAUDE_OWNED_BUSY', instances: ['claude'] });
  checkEqual('accepted Claude input refuses after its process disappears', plannedTransitionReadiness({ currentState: { ...currentState,
    snapshot: () => ({ outbox: [{ id: 'claude-accepted', state: 'accepted', provider: { kind: 'claude' } }] }) }, engine, resources }).code, 'CLAUDE_OWNED_BUSY');
  checkEqual('an active external terminal also blocks replacement', plannedTransitionReadiness({ currentState, engine,
    resources: { terminals: { list: () => [{ id: 'terminal', busy: true }] } } }).code, 'TERMINAL_BUSY');
};
