'use strict';

const crypto = require('crypto');
const path = require('path');
const { createReceiptDispatcher, wireError, keyOf } = require('./receiptDispatcher');
const { reserveOperation } = require('./jsonlAuthority');
const { object, requireThat, canonical, failure, immutable, validateRun, ERROR_CODES } = require('./protocolV2');
const { readConfig } = require('./config');
const { createDaemonConfig } = require('./daemonConfig');
const prefs = require('./prefs');
const { createProviderControls, validateControlState, CONTROL_STATE } = require('./providerControls');
const { deliverCodex, exactEvidence, providerFor } = require('./codexDelivery');
const { captureCommand, discoverCommand, validateCommand, deliverCommand } = require('./codexCommands');
const DOMAIN = 'engine.current.v1';
const CODEX_ACCOUNT = 'engine.codexAccount.v1';
const metaFields = ['id', 'cwd', 'provider', 'customTitle', 'autoLabel', 'ticket', 'claudeSessionId', 'prPane', 'prPinned', 'prUrl',
  'totalCost', 'usage', 'turnLog', 'startedAt', 'turns', 'errors', 'interrupts', 'status', 'finishedAt', 'compactions', 'lastCompactedAt', 'cutByLimit', 'unread', 'threadId', 'account', 'codexSettings'];
const launchFields = ['claudePath', 'model', 'permissionMode', 'effort', 'outputStyle', 'extraArgs', 'longCommandsInBackground', 'autoTitle', 'maxItems'];
const current = (state) => state.values[DOMAIN];
const result = (data, replies = [], code = 'ok') => ({ code, data, replies });
const instanceOf = (state, target) => {
  const instance = current(state).instances.find((s) => 'session:' + s.id === target);
  requireThat(instance, 'NOT_FOUND'); return instance;
};
const selectedMeta = (session) => JSON.parse(JSON.stringify(Object.fromEntries(metaFields.filter((k) => session[k] !== undefined).map((k) =>
  [k, k === 'turnLog' ? session[k].slice(-60) : session[k]]))));
const queued = (item) => item.state === 'queued';
const localContext = (target) => ({ authenticated: true, principal: 'local:legacy', role: target === 'fleet' ? 'fleet' : 'conversation', target,
  seat: { id: 'legacy-engine', control: true, local: true, editor: false } });

async function initializeEngineState(authority, { settings = { version: 1, user: {}, projects: [] }, root } = {}) {
  if (current(authority.snapshot())) return;
  requireThat(settings.version === 1, 'CONFIG_INVALID');
  createDaemonConfig({ ...settings, root });
  await authority.commit((state) => {
    if (!current(state)) state.values[DOMAIN] = { v: 1, nextEntity: 0, instances: [], retiredInstances: [],
      folders: { folders: [], assign: {}, byConversation: {} }, settings: structuredClone(settings),
      account: { limits: null, pause: null, limitOverride: 0, knownReset: null } };
  });
}
function validateCurrent(data, root) {
  const text = (v) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 1024 && !['__proto__', 'constructor', 'prototype'].includes(v);
  requireThat(object(data) && data.v === 1 && Number.isSafeInteger(data.nextEntity) && data.nextEntity >= 0 &&
    Array.isArray(data.instances) && data.instances.every((s) => object(s) && text(s.id) && path.isAbsolute(s.cwd || '') &&
      (!root || s.cwd === root || s.cwd.startsWith(root + path.sep)) &&
      (s.codexSettings === undefined || s.provider === 'codex' && object(s.codexSettings) && Object.entries(s.codexSettings).every(([key, value]) =>
        ['model', 'effort', 'mode'].includes(key) && typeof value === 'string' && value.length <= 1024 && (key !== 'mode' || ['plan', 'default'].includes(value))))) &&
    new Set(data.instances.map((s) => s.id)).size === data.instances.length &&
    Array.isArray(data.retiredInstances) && data.retiredInstances.every(text) && new Set(data.retiredInstances).size === data.retiredInstances.length &&
    !data.instances.some((s) => data.retiredInstances.includes(s.id)) &&
    object(data.folders) && Array.isArray(data.folders.folders) && data.folders.folders.every((f) => object(f) && text(f.id) && typeof f.name === 'string') &&
    new Set(data.folders.folders.map((f) => f.id)).size === data.folders.folders.length && object(data.folders.assign) && object(data.folders.byConversation) &&
    object(data.settings) && data.settings.version === 1 && object(data.account) && Number.isSafeInteger(data.account.limitOverride) && data.account.limitOverride >= 0,
  'STORAGE_UNAVAILABLE');
  createDaemonConfig({ ...data.settings, root });
}
function validateOutbox(state, root) {
  const ids = new Set(), correlations = new Set();
  for (const item of state.outbox) if (Object.hasOwn(item, 'queueId')) {
    const p = item.payload;
    requireThat(typeof item.queueId === 'string' && item.queueId.length > 0 && !ids.has(item.queueId) && typeof item.correlation === 'string' && item.correlation.length > 0 && !correlations.has(item.correlation) &&
      Number.isSafeInteger(item.revision) && item.revision > 0 && Number.isSafeInteger(item.at) && item.at >= 0 &&
      Object.hasOwn(item, 'provider') && Object.hasOwn(item, 'error') &&
      object(p) && object(p.message) && p.message.type === 'send' && p.message.scope === item.scope && p.message.mid === item.mid &&
      item.target === 'session:' + p.instance && path.isAbsolute(p.cwd || '') && (!root || p.cwd === root || p.cwd.startsWith(root + path.sep)) &&
      ['claude', 'codex'].includes(p.kind) && object(p.settings) && object(p.authority) && p.authority.authenticated === true &&
      p.authority.principal === item.principal && p.authority.target === item.target && p.authority.role === 'conversation' && object(p.authority.seat), 'STORAGE_UNAVAILABLE');
    requireThat(object(p.providerTarget) && p.providerTarget.kind === p.kind && path.isAbsolute(p.providerTarget.account || '') &&
      (p.kind !== 'codex' || typeof p.providerTarget.threadId === 'string' && p.providerTarget.threadId.length > 0) &&
      (p.mode === undefined || ['send', 'steer', 'question', 'handoff'].includes(p.mode)) &&
      (!p.mode || ['send', 'handoff'].includes(p.mode) || p.kind === 'codex') &&
      (p.mode !== 'handoff' || p.kind === 'claude' && object(p.handoff) && typeof p.handoff.text === 'string') &&
      (p.mode !== 'steer' || !!p.message.run && /^\/steer\s+\S/i.test(p.message.text.trim())) &&
      (p.mode !== 'question' || !!p.message.answerTo) &&
      (p.providerSettings === undefined || object(p.providerSettings)) &&
      (item.dispatchMode === undefined || item.dispatchMode === 'steer') &&
      (item.acceptanceProved === undefined || typeof item.acceptanceProved === 'boolean') &&
      (item.rejectionProved === undefined || typeof item.rejectionProved === 'boolean'), 'STORAGE_UNAVAILABLE');
    if (item.promoteReceipt) requireThat(object(item.promoteReceipt) && /^[a-f0-9]{32}$/.test(item.promoteReceipt.scope) &&
      typeof item.promoteReceipt.principal === 'string' && item.promoteReceipt.principal.length > 0 && /^[a-f0-9]{32}$/.test(item.promoteReceipt.mid), 'STORAGE_UNAVAILABLE');
    if (p.control) {
      requireThat(object(p.control) && p.control.instance === p.instance && p.control.kind === (p.mode === 'handoff' ? 'send' : p.mode || 'send') &&
        (['send', 'handoff'].includes(p.mode) ? p.control.run === null : !!p.control.run) &&
        (p.mode !== 'question' || /^[a-f0-9]{32}$/.test(p.control.identity)), 'STORAGE_UNAVAILABLE');
      if (p.control.run) validateRun(p.control.run);
    }
    validateProvider(item.provider);
    if (p.command) { requireThat(p.kind === 'codex' && p.mode === 'send', 'STORAGE_UNAVAILABLE'); validateCommand(p.command); }
    if (item.error !== null) validateOperationError(item.error);
    validateSend(p.message); ids.add(item.queueId); correlations.add(item.correlation);
  }
}
function allocate(state, prefix) {
  const data = current(state);
  requireThat(Number.isSafeInteger(data.nextEntity + 1), 'RECEIPT_FULL');
  return prefix + '-' + state.engineId + '-' + state.scope + '-' + (++data.nextEntity).toString(36);
}
function operation(item) {
  validateProvider(item.provider);
  requireThat(['queued', 'dispatching', 'accepted', 'completed', 'rejected', 'discarded', 'unknown'].includes(item.state) &&
    Number.isSafeInteger(item.revision) && item.revision > 0 && Number.isSafeInteger(item.at) && item.at >= 0);
  if (['rejected', 'discarded', 'unknown'].includes(item.state)) validateOperationError(item.error);
  return structuredClone({ type: 'operation', scope: item.scope, mid: item.mid, target: item.target,
    revision: item.revision, state: item.state === 'discarded' ? 'rejected' : item.state,
    provider: item.provider, error: item.error, at: item.at });
}
function validateOperationError(error) {
  requireThat(object(error) && ERROR_CODES.has(error.code) && typeof error.message === 'string' && Buffer.byteLength(error.message) <= 2048 && error.retryable === false);
}
function validateProvider(provider) {
  if (provider === null) return;
  const nullable = (v) => v === null || typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 1024;
  requireThat(object(provider) && Object.keys(provider).sort().join(',') === 'account,clientUserMessageId,kind,ownership,threadId,turnId,writer' &&
    ['claude', 'codex'].includes(provider.kind) && typeof provider.account === 'string' && provider.account.length > 0 && Buffer.byteLength(provider.account) <= 1024 &&
    ['owned', 'borrowed'].includes(provider.ownership) && ['engine', 'external', 'unknown'].includes(provider.writer) &&
    nullable(provider.threadId) && nullable(provider.clientUserMessageId) && nullable(provider.turnId));
}
function advance(item, state, at, error = null) { item.state = state; item.revision++; item.at = at; item.error = error; reserveOperation(item); }
function draft(item) {
  const p = item.payload.message;
  return { type: 'editPrompt', text: p.text, sent: p.sent ?? null, snippets: structuredClone(p.snippets || []), attachments: structuredClone(p.attachments || []) };
}
function validateSend(m) {
  if (m.run !== undefined) validateRun(m.run);
  if (m.answerTo !== undefined) {
    requireThat(object(m.answerTo) && typeof m.answerTo.requestId === 'string' && m.answerTo.requestId.length > 0);
    validateRun(m.answerTo.run);
  }
  requireThat(typeof m.text === 'string' && (m.sent === undefined || m.sent === null || typeof m.sent === 'string') &&
    (m.snippets === undefined || Array.isArray(m.snippets) && m.snippets.every((v) => typeof v === 'string')) &&
    (m.attachments === undefined || Array.isArray(m.attachments) && m.attachments.every((a) => object(a) &&
      typeof a.name === 'string' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(a.mediaType) &&
      typeof a.data === 'string' && a.data.length > 0 && a.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(a.data))));
  requireThat(m.text.trim() || m.sent?.trim() || m.attachments?.length);
  if (/^\/steer(?:\s|$)/i.test(m.text.trim())) requireThat(/^\/steer\s+\S/i.test(m.text.trim()));
}

/** Authoritative local state/outbox, independent of window mementos.
 * deliver MUST report an explicit boundary {state: accepted/completed/rejected/
 * unknown, provider?, error?}. It is never inferred from post()/undefined.
 * Service provider adapters opt in here; complete wire-family routing remains
 * a later P1 row.
 */
async function createEngineState({ authority, engine = null, root, authorize, deliver = null,
  ready = null, startQueued = false, now = Date.now, timers = { setTimeout, clearTimeout }, settings, refreshSettings = () => {} } = {}) {
  await initializeEngineState(authority, { settings, root });
  const data = current(authority.snapshot());
  validateCurrent(data, root);
  validateControlState(authority.snapshot().values[CONTROL_STATE]);
  require('./wireMutations').validateMutationState(authority.snapshot());
  if (engine?.account.home) await authority.commit((state) => {
    const saved = state.values[CODEX_ACCOUNT];
    requireThat(!saved || saved.home === engine.account.home && saved.id === engine.account.id, 'STORAGE_UNAVAILABLE',
      'The selected Codex account differs from this single-account authority.');
    state.values[CODEX_ACCOUNT] = { home: engine.account.home, id: engine.account.id };
  });
  if (engine) for (const instance of data.instances) if (instance.provider === 'codex') {
    requireThat(instance.account === engine.account.home && instance.id === 'cx-' + instance.threadId, 'STORAGE_UNAVAILABLE');
  }
  validateOutbox(authority.snapshot(), root);
  // Validate restored settings before any process or timer can start.
  createDaemonConfig({ ...data.settings, root });
  let running = false, disposed = false, admitting = true, projecting = false, pendingMetadata = Promise.resolve();
  let issue = null;
  const drains = new Map(), scheduled = new Map(), writes = new Map(), started = new Set(), capturedSends = new Map(), attached = new Map(), observations = new Set();
  const principalAuthorities = new Map();
  // Restored removals are effective before clients/drains. Fresh self-removal
  // becomes effective only after its committed ack has been enqueued.
  const revokedEnrollments = new Set((authority.snapshot().values['engine.deviceRevocations.v1'] || []).map((r) => JSON.stringify([r.device, r.enrollment])));
  const businessErrors = ['NOT_FOUND', 'STALE_RESOURCE', 'STALE_RUN', 'STALE_TURN', 'APPROVAL_RESOLVED', 'PROVIDER_REJECTED', 'UNSUPPORTED', 'LOCAL_REQUIRED', 'BAD_MESSAGE'];
  const sessionFor = (id) => engine && (engine.manager.get(id) || engine.codex?.get(id));
  const sessions = () => engine ? [...engine.manager.list, ...(engine.codex?.list || [])] : [];
  // A lost editor/PR/Slack reply is not evidence of an active provider turn.
  // Only retained provider sends/controls fence subsequent conversation work.
  const providerBarrier = (q, target) => q.target === target && (q.queueId || q.payload.control) && ['dispatching', 'unknown'].includes(q.state);
  function attach(session) {
    if (attached.has(session)) return;
    const saved = authority.snapshot().values[CONTROL_STATE];
    const prior = saved?.instances.find((s) => s.instance === session.id);
    const controls = createProviderControls(session, () => capture(session), prior, saved?.claims || []);
    const changed = () => capture(session);
    const evidence = (turns) => { if (!disposed && sessionFor(session.id) === session) void api.observeCodex(session.id, turns).catch(() => {}); };
    attached.set(session, { controls, changed, evidence });
    if (session.provider === 'codex') {
      session.account = engine.account.home;
      for (const event of ['status', 'meta', 'queue', 'unread']) session.on(event, changed);
      session.on('provider-evidence', evidence);
    }
    session._durableQueueOwner = queueOwner;
  }
  function captureControl(context, message) {
    const session = sessionFor(context.target?.slice(8));
    if (!session) return { error: failure('NOT_FOUND') };
    attach(session);
    const binding = session._engineControls.capture(message);
    if (!binding.error && session.provider === 'codex' && message.type === 'send' && !message.answerTo) {
      try { binding.command = captureCommand(session, message); }
      catch (error) { binding.error = error; }
    }
    return binding;
  }
  const ipcRequest = (request) => {
    const session = engine.codex.get('cx-' + (request.params?.threadId || request.params?.conversationId));
    const ipc = engine.codex.ipc;
    if (!session || !session.handleRequest({ ...request, id: request.requestId, _providerTransport: 'ipc', _providerConnection: ipc.sock })) {
      ipc.respondError(request.requestId);
    }
  };
  const ipcExit = (connection) => {
    for (const session of sessions()) if (session.provider === 'codex' &&
        ([...(session._pendingRpc?.values() || [])].some((pending) => pending.connection === connection) || session._question?.connection === connection)) {
      session._engineControls?.rotate(session.workspace.client.proc); capture(session);
    }
  };
  const settingsFor = (state, instance) => {
    const configured = readConfig(createDaemonConfig({ ...current(state).settings, root }).forProject(instance.cwd));
    const session = sessionFor(instance.id);
    return Object.fromEntries(launchFields.map((key) => [key, structuredClone(session && session[key] !== undefined ? session[key] : configured[key])]));
  };
  const queueFor = (state, target) => state.outbox.filter((q) => q.target === target && queued(q));
  function enqueueState(change, options = {}) {
    pendingMetadata = pendingMetadata.then(() => authority.commit((state) => {
      change(state); validateCurrent(current(state), root);
    }, options));
    pendingMetadata.catch(() => {
      issue = { code: 'ENGINE_STATE_UNAVAILABLE', message: 'Current engine state could not be committed; automatic work is fenced.' };
      running = false;
      for (const timer of scheduled.values()) timers.clearTimeout(timer); scheduled.clear();
    });
    return pendingMetadata;
  }
  function queueItem(state, message, context) {
    const item = queueFor(state, context.target).find((q) => q.queueId === message.id);
    requireThat(item, 'NOT_FOUND'); return item;
  }
  const handlers = {
    send: { validate: validateSend, businessErrors,
      apply({ state, message, context, entry, captured }) {
        const instance = instanceOf(state, context.target);
        const mode = message.answerTo ? 'question' : /^\/steer(?:\s|$)/i.test(message.text.trim()) ? 'steer'
          : /^\/codex(?:\s|$)/i.test(message.text.trim()) ? 'handoff' : 'send';
        if (!engine) requireThat(!message.run && !message.answerTo && mode === 'send', 'UNSUPPORTED');
        const session = sessionFor(instance.id);
        const control = session ? session._engineControls.retain(state, captured, entry.mid) : null;
        const kind = instance.provider || 'claude';
        requireThat(['claude', 'codex'].includes(kind), 'UNSUPPORTED');
        if (engine && kind === 'codex') requireThat(instance.account === engine.account.home && instance.threadId === session?.threadId, 'STALE_RESOURCE');
        const providerTarget = kind === 'codex' ? { kind, account: engine ? engine.account.home : instance.account,
          threadId: instance.threadId, conversation: null } : { kind, account: root || instance.cwd, threadId: null, conversation: instance.claudeSessionId || null };
        requireThat(typeof providerTarget.account === 'string' && path.isAbsolute(providerTarget.account) &&
          (kind !== 'codex' || typeof providerTarget.threadId === 'string' && providerTarget.threadId.length > 0), 'UNSUPPORTED');
        const queueId = allocate(state, 'q');
        entry.requestRef = 'outbox:' + state.scope + ':' + context.principal + ':' + message.mid;
        const payload = { message: structuredClone(message), instance: instance.id, cwd: instance.cwd,
          kind, providerTarget, settings: settingsFor(state, instance),
          authority: { authenticated: true, principal: context.principal, role: context.role, target: context.target, seat: structuredClone(context.seat) } };
        if (engine) {
          payload.mode = mode; payload.control = control;
          if (mode === 'handoff') {
            requireThat(kind === 'claude' && engine.codex, 'UNSUPPORTED');
            const last = (type) => session.items.filter((i) => i.kind === type && i.text).at(-1)?.text?.slice(0, 4000) || '';
            const task = message.text.trim().replace(/^\/codex\s*/i, '');
            payload.handoff = { text: ['Handed over from a Claude Code conversation in ' + instance.cwd + '.',
              ...(last('user') ? ['', 'What was last asked there:', last('user')] : []),
              ...(last('text') ? ['', 'What Claude last said:', last('text')] : []), '',
              task ? 'Your task: ' + task : 'Pick up from there and carry on.'].join('\n') };
          }
          if (context.origin) payload.requester = structuredClone(context.origin);
          if (kind === 'codex') payload.providerSettings = structuredClone(session._turnSettings());
          if (captured?.command) payload.command = structuredClone(captured.command);
        }
        requireThat(Buffer.byteLength(canonical(payload)) <= authority.limits.maxPayloadBytes, 'RECEIPT_FULL');
        const correlation = 'nikui-' + state.engineId + '-' + state.scope + '-' + crypto.createHash('sha256').update(context.principal).digest('hex').slice(0, 16) + '-' + message.mid;
        requireThat(!state.outbox.some((q) => q.queueId === queueId || q.correlation === correlation), 'MID_CONFLICT');
        const item = { v: 1, id: entry.requestRef, scope: state.scope, principal: context.principal, mid: message.mid,
          state: 'queued', payload, queueId, target: context.target, revision: 1, provider: null, error: null, at: entry.at,
          correlation, operationBudget: 16384 };
        reserveOperation(item); state.outbox.push(item);
        return result({ instance: instance.id, queueId, operation: message.mid }, [], 'accepted');
      } },
    editQueued: { validate: (m) => requireThat(typeof m.id === 'string'), businessErrors,
      resultBytes: ({ state, message, context }) => {
        const item = queueFor(state, context.target).find((q) => q.queueId === message.id);
        return item ? Buffer.byteLength(canonical({ result: result({ queueId: item.queueId }, [draft(item)]), error: null })) : 16384;
      },
      apply({ state, message, context, entry }) {
        const item = queueItem(state, message, context), reply = draft(item);
        advance(item, 'discarded', entry.at, wireError('CANCELLED', 'Prompt reclaimed for editing.'));
        return result({ queueId: item.queueId }, [reply]);
      } },
    unqueue: { validate: (m) => requireThat(typeof m.id === 'string'), businessErrors,
      apply({ state, message, context, entry }) {
        const item = queueItem(state, message, context);
        advance(item, 'discarded', entry.at, wireError('CANCELLED'));
        return result({ queueId: item.queueId });
      } },
    clearQueue: { businessErrors, apply({ state, context, entry }) {
      const items = queueFor(state, context.target);
      for (const item of items) advance(item, 'discarded', entry.at, wireError('CANCELLED'));
      return result({ removed: items.length });
    } },
    promoteQueued: { validate: (m) => requireThat(typeof m.id === 'string' && ['reorder', 'steer'].includes(m.mode)), businessErrors,
      apply({ state, message, context }) {
        requireThat(message.mode === 'reorder', 'UNSUPPORTED');
        const item = queueItem(state, message, context), first = state.outbox.findIndex((q) => q.target === context.target && queued(q));
        state.outbox.splice(state.outbox.indexOf(item), 1); state.outbox.splice(first, 0, item);
        return result({ queueId: item.queueId });
      } },
    'instance:place': { validate: (m) => requireThat(typeof m.instance === 'string' && (m.folderId === undefined || m.folderId === null || typeof m.folderId === 'string')), businessErrors,
      apply({ state, message }) {
        const instance = instanceOf(state, 'session:' + message.instance), folders = current(state).folders;
        const folderId = message.folderId ?? null;
        requireThat(folderId === null || folders.folders.some((f) => f.id === folderId), 'NOT_FOUND');
        if (folderId === null) { delete folders.assign[instance.id]; if (instance.claudeSessionId) delete folders.byConversation[instance.claudeSessionId]; }
        else { folders.assign[instance.id] = folderId; if (instance.claudeSessionId) folders.byConversation[instance.claudeSessionId] = folderId; }
        return result({ instance: instance.id, folderId }, [{ type: 'instance:placed', id: message.id ?? null }]);
      } },
    'pr:pane': { cap: 'pr-v1', businessErrors,
      validate: (message) => requireThat(typeof message.open === 'boolean' && (message.tab === undefined || typeof message.tab === 'string') &&
        (message.full === undefined || typeof message.full === 'boolean') && (message.width === undefined || message.width === null || typeof message.width === 'number')),
      apply({ state, message, context }) {
        const instance = instanceOf(state, context.target);
        requireThat(message.prUrl === (instance.prUrl || null), 'STALE_RESOURCE');
        const was = instance.prPane || {}, aliases = { overview: 'conversation', comments: 'threads' }, tab = aliases[message.tab] || message.tab;
        instance.prPane = { open: message.open, tab: ['conversation', 'threads', 'commits', 'checks', 'files'].includes(tab) ? tab : aliases[was.tab] || was.tab || 'conversation',
          width: Number.isFinite(message.width) ? Math.max(280, Math.min(2000, Math.round(message.width))) : was.width || null,
          full: message.full === undefined ? !!was.full : message.full };
        return result({ prUrl: instance.prUrl || null, pane: instance.prPane });
      } },
    setSetting: { validate: (m) => { try { prefs.validate(m.id, m.value); } catch (_) { throw failure('BAD_MESSAGE'); } }, businessErrors,
      apply({ state, message }) {
        const clean = prefs.validate(message.id, message.value), pref = prefs.PREFS.find((p) => p.id === message.id), values = current(state).settings.user;
        values[pref.key] = pref.part ? { ...(values[pref.key] || {}), [pref.part]: clean } : clean;
        createDaemonConfig({ ...current(state).settings, root });
        return result({ id: message.id, value: clean });
      } }
  };
  for (const [type, method] of [['saveCommand', 'save'], ['removeCommand', 'remove'], ['restoreCommand', 'restore']]) handlers[type] = {
    roles: ['conversation'], businessErrors,
    apply({ state, message }) {
      const values = current(state).settings.user, defaults = require('../package.json').contributes.configuration.properties;
      let next;
      try {
        next = require('./commands')[method]({ shipped: defaults['nikui.promptSnippets'].default,
          shippedSaid: defaults['nikui.promptSnippetDescriptions'].default,
          mine: values.promptSnippets || {}, mineSaid: values.promptSnippetDescriptions || {} }, method === 'save' ? message : message.name);
      } catch (_) { throw failure('BAD_MESSAGE'); }
      values.promptSnippets = next.mine; values.promptSnippetDescriptions = next.mineSaid;
      return result({ name: next.name }, [{ type: 'commands', done: type, name: next.name }]);
    }
  };
  const promoteSteer = {
    roles: ['conversation'], businessErrors,
    validate(message) { requireThat(typeof message.id === 'string' && message.mode === 'steer'); validateRun(message.run); },
    prepare({ state, message, context, entry, captured }) {
      const item = queueItem(state, message, context);
      requireThat(item.payload.kind === 'codex', 'UNSUPPORTED');
      if (captured?.error) throw captured.error;
      requireThat(captured?.session === sessionFor(item.payload.instance), 'STALE_RUN');
      requireThat(!state.outbox.some((q) => providerBarrier(q, context.target)), 'STALE_RESOURCE');
      const control = captured.session._engineControls.retain(state, captured, entry.mid);
      const promoted = { ...structuredClone(item), payload: { ...structuredClone(item.payload), mode: 'steer', control,
        message: { ...structuredClone(item.payload.message), text: '/steer ' + item.payload.message.text, run: message.run } } };
      item.dispatchMode = 'steer';
      item.promoteReceipt = { scope: entry.scope, principal: entry.principal, mid: entry.mid };
      return { message, promoted, control };
    },
    async execute({ message, payload, captured }) {
      const item = payload.promoted, session = sessionFor(item.payload.instance);
      let answer;
      if (!session || captured?.session !== session) answer = { state: 'rejected', error: wireError('STALE_RUN') };
      else answer = await deliverCodex({ engine, session, item, binding: captured,
        permitted: () => checkAuthority({ access: 'dispatch', context: item.payload.authority, message, state: authority.snapshot() }) === true,
        phase: (name, provider) => authority.commit((state) => {
          const saved = state.outbox.find((q) => q.id === item.id);
          requireThat(saved?.state === 'queued', 'STALE_RESOURCE');
          saved.provider = structuredClone(provider); saved.dispatchPhase = name; reserveOperation(saved);
        }) });
      await authority.commit((state) => {
        const saved = state.outbox.find((q) => q.id === item.id);
        if (['completed', 'rejected'].includes(saved.state)) return;
        if (saved.acceptanceProved && answer.state === 'unknown') return;
        if (answer.state === 'rejected') return; // definite non-acceptance leaves the original queue intact
        advance(saved, answer.state, Math.max(now(), state.clockHighWater), answer.error || null);
        if (answer.provider) saved.provider = structuredClone(answer.provider);
        if (['accepted', 'completed'].includes(answer.state)) saved.acceptanceProved = true;
        reserveOperation(saved);
      }, { evidence: 'codex-promote:' + item.correlation });
      const known = authority.snapshot().outbox.find((q) => q.id === item.id);
      return known.acceptanceProved || ['accepted', 'completed'].includes(answer.state) ? { outcome: 'applied', result: result({ queueId: item.queueId }) }
        : { outcome: answer.state, error: answer.error };
    }
  };
  for (const type of ['permission', 'interrupt', 'stopTask']) handlers[type] = {
    businessErrors,
    validate(message) {
      validateRun(message.run);
      if (type === 'permission') requireThat(typeof message.requestId === 'string' && message.requestId.length > 0);
      if (type === 'stopTask') requireThat(typeof message.taskId === 'string' && message.taskId.length > 0);
    },
    prepare({ state, message, context, entry, captured }) {
      instanceOf(state, context.target);
      if (type === 'permission') requireThat(typeof message.allow === 'boolean');
      if (captured?.error) throw captured.error;
      requireThat(captured?.session && sessionFor(captured.session.id) === captured.session, 'STALE_RUN');
      const session = captured.session;
      return { message, control: session._engineControls.retain(state, captured, entry.mid),
        ...(session.provider === 'codex' ? { provider: providerFor(engine, session, null),
          dispatchPhase: type === 'interrupt' && session.readOnly ? 'follower-interrupt' : 'direct-' + type } : {}) };
    },
    execute({ message, captured, entry, context }) {
      if (!captured?.session || sessionFor(captured.session.id) !== captured.session) return { outcome: 'rejected', error: wireError('STALE_RUN') };
      return captured.session._engineControls.execute(captured, message, captured.session.provider === 'codex' ? (name) => authority.commit((state) => {
        const item = state.outbox.find((q) => q.id === entry.requestRef);
        requireThat(item?.state === 'dispatching', 'STALE_RESOURCE');
        item.dispatchPhase = name;
      }) : null, () => checkAuthority({ access: 'dispatch', context, message, state: authority.snapshot() }) === true);
    }
  };
  for (const [name, handler] of Object.entries(handlers)) handler.roles = [name === 'instance:place' ? 'fleet' : 'conversation'];
  const checkAuthority = (args) => {
    const read = principalAuthorities.get(args.context.principal)?.read;
    if (read) {
      const live = read();
      if (!live) return false;
      args = { ...args, context: { ...args.context, seat: { ...args.context.seat, control: live.control === true } } };
    }
    return (args.access === 'view' || require('./mutationGrants').mayMutate(args.context, args.message)) &&
      (!authorize || authorize(args) === true);
  };
  for (const handler of Object.values(handlers)) {
    const apply = handler.apply;
    if (apply) handler.apply = (args) => { const answer = apply(args); validateCurrent(current(args.state), root); return answer; };
  }
  const dispatcher = createReceiptDispatcher({ authority, handlers, now, authorize: checkAuthority });
  async function settlePromotions() {
    const snapshot = authority.snapshot();
    for (const item of snapshot.outbox) if (item.promoteReceipt) {
      const accepted = item.acceptanceProved && ['accepted', 'completed'].includes(item.state);
      const rejected = item.rejectionProved && item.state === 'rejected';
      if (!accepted && !rejected) continue;
      const entry = authority.findReceipt(snapshot, keyOf(item.promoteReceipt));
      if (entry?.outcome === 'unknown') await dispatcher.complete(item.promoteReceipt,
        accepted ? { outcome: 'applied', result: result({ queueId: item.queueId }) } : { outcome: 'rejected', error: item.error },
        'codex-exact:' + item.correlation);
    }
  }
  // Must finish before attaching sessions, restoring a keeper, or arming drains.
  await dispatcher.recover();
  await authority.commit((state) => {
    const neverDispatched = new Set(state.entries.filter((entry) => entry.outcome === 'rejected' && entry.error?.code === 'ENGINE_RESTARTED').map((entry) => entry.requestRef));
    const releasedClaims = new Set(state.outbox.filter((item) => neverDispatched.has(item.id)).map((item) => item.payload.control?.identity));
    if (state.values[CONTROL_STATE]) state.values[CONTROL_STATE].claims = state.values[CONTROL_STATE].claims.filter((claim) => !releasedClaims.has(claim.key));
    const unknown = new Set(state.outbox.filter((item) => item.state === 'unknown').map(keyOf));
    for (const item of state.outbox) if (item.queueId && item.state === 'queued' && item.promoteReceipt &&
        unknown.has(keyOf(item.promoteReceipt))) {
      advance(item, 'unknown', Math.max(now(), state.clockHighWater), wireError('OUTCOME_UNKNOWN'));
    }
    for (const item of state.outbox) if (item.queueId && item.state === 'unknown' && !item.error) {
      advance(item, 'unknown', Math.max(now(), state.clockHighWater), wireError('OUTCOME_UNKNOWN', 'Restored operation requires exact reconciliation evidence.'));
    }
  });
  await settlePromotions();
  async function legacy(type, target, fields = {}) {
    const snap = authority.snapshot();
    return api.dispatch(localContext(target), { type, mid: crypto.randomBytes(16).toString('hex'), scope: snap.scope,
      issuedAt: Math.max(now(), snap.clockHighWater), ...fields });
  }
  const queueOwner = {
    blocked(session) { return authority.snapshot().outbox.some((q) => providerBarrier(q, 'session:' + session.id)); },
    async submit(session, text, attachments, opts = {}) {
      const answer = await legacy('send', 'session:' + session.id,
        { text: String(text || ''), attachments: attachments || [], sent: opts.sent ?? null, snippets: opts.snippets || [],
          ...(opts.run ? { run: opts.run } : {}), ...(opts.answerTo ? { answerTo: opts.answerTo } : {}) });
      schedule('session:' + session.id); return answer;
    },
    control(session, type, fields) {
      let run;
      try { run = session._engineControls.legacy(type, fields); }
      catch (error) { session._notice('This control is no longer current; refresh the conversation.', 'info');
        return Promise.resolve(dispatcher.refuse(localContext('session:' + session.id), { type }, error.code)); }
      return legacy(type, 'session:' + session.id, { ...fields, run });
    },
    schedule(session) { schedule('session:' + session.id); },
    async reclaim(session, id) { const answer = await legacy('editQueued', 'session:' + session.id, { id }); return answer.result?.replies[0] || null; },
    unqueue(session, id) { return legacy('unqueue', 'session:' + session.id, { id }); },
    clearQueue(session) { return legacy('clearQueue', 'session:' + session.id); },
    promote(session, id) { return legacy('promoteQueued', 'session:' + session.id, { id, mode: 'reorder' }); }
  };
  function project() {
    if (!engine || disposed) return;
    const snap = authority.snapshot(), saved = current(snap);
    projecting = true;
    try {
      for (const session of sessions()) {
        attach(session);
        session._durableQueueOwner = queueOwner;
        if (session._clearDrain) session._clearDrain();
        session.queue = queueFor(snap, 'session:' + session.id).map((q) => {
          const p = q.payload.message;
          return { id: q.queueId, text: p.text, sent: p.sent ?? null, snippets: structuredClone(p.snippets || []), attachments: structuredClone(p.attachments || []) };
        });
        const metadata = saved.instances.find((s) => s.id === session.id);
        if (metadata) for (const field of ['customTitle', 'prPane', 'prPinned', 'prUrl', 'unread']) if (Object.hasOwn(metadata, field)) session[field] = structuredClone(metadata[field]);
        if (metadata?.codexSettings && session.provider === 'codex') {
          session.codexSettings = structuredClone(metadata.codexSettings);
          Object.assign(session._chosenSettings, metadata.codexSettings);
          session._settings({ model: metadata.codexSettings.model || session.meta.model,
            effort: metadata.codexSettings.effort ?? session.effort, collaborationMode: { mode: metadata.codexSettings.mode || session.meta.mode } });
        }
        session.emit('queue');
      }
      Object.assign(engine.folders, structuredClone(saved.folders));
      refreshSettings(structuredClone(saved.settings.user));
      engine.slack?.restoreSeen?.(snap.values['engine.slackSeen.v1']);
    } finally { projecting = false; }
  }
  function capture(session) {
    if (projecting || disposed) return;
    attach(session);
    // Do not ever read a slim memento or keeper queue as outbox recovery data.
    const metadata = selectedMeta(session);
    const controls = session._engineControls.snapshot();
    const write = writes.get('session:' + session.id);
    if (write && write.session === session && write.proc === session.proc && session.turns > write.turns) write.completed = true;
    enqueueState((state) => {
      const list = current(state).instances, index = list.findIndex((s) => s.id === metadata.id);
      if (index < 0) list.push(metadata);
      else list[index] = { ...metadata, ...(list[index].codexSettings ? { codexSettings: list[index].codexSettings } : {}) };
      const bindings = state.values[CONTROL_STATE] || (state.values[CONTROL_STATE] = { v: 1, instances: [], claims: [] });
      const previous = bindings.instances.findIndex((s) => s.instance === session.id);
      if (previous < 0) bindings.instances.push(controls); else bindings.instances[previous] = controls;
      const item = write && write.completed && state.outbox.find((q) => q.id === write.id);
      if (item && item.state === 'accepted') advance(item, 'completed', Math.max(now(), state.clockHighWater));
    });
    session._durableQueueOwner = queueOwner;
    if (running) schedule('session:' + session.id);
  }
  function captureAccount() {
    if (projecting || disposed) return;
    const manager = engine.manager, account = JSON.parse(JSON.stringify({ limits: manager.limits || null, pause: manager.pause || null,
      limitOverride: manager.limitOverride || 0, knownReset: manager.knownReset || null }));
    enqueueState((state) => { current(state).account = account; });
  }
  const retired = new Set(data.retiredInstances);
  function removed(session) {
    if (disposed) return;
    retired.add(session.id);
    enqueueState((state) => {
      const data = current(state);
      data.instances = data.instances.filter((s) => s.id !== session.id);
      if (!data.retiredInstances.includes(session.id)) data.retiredInstances.push(session.id);
      delete data.folders.assign[session.id];
      for (const item of state.outbox) if (item.target === 'session:' + session.id) {
        if (item.state === 'queued') advance(item, 'discarded', Math.max(now(), state.clockHighWater), wireError('CANCELLED', 'The instance was closed.'));
        else if (['dispatching', 'accepted'].includes(item.state)) advance(item, 'unknown', Math.max(now(), state.clockHighWater), wireError('OUTCOME_UNKNOWN'));
      }
    });
  }
  function schedule(target, delay = 0) {
    if (!running || disposed || scheduled.has(target) || drains.has(target)) return;
    const timer = timers.setTimeout(() => { scheduled.delete(target); void api.drain(target).catch(() => {}); }, delay);
    scheduled.set(target, timer);
    if (timer && timer.unref) timer.unref();
  }
  function canDrain(item) {
    if (checkAuthority({ access: 'dispatch', context: item.payload.authority, message: item.payload.message, state: authority.snapshot() }) !== true) return false;
    if (ready) return ready(immutable(item)) === true;
    const session = sessionFor(item.payload.instance);
    if (item.payload.mode === 'handoff') return !!(session && !session.disposed && session.cwd === item.payload.cwd && engine.codex);
    if (session?.provider === 'codex') return session.loaded && !!session.workspace.client.proc &&
      (item.payload.command || item.payload.mode && item.payload.mode !== 'send' || !session.inTurn &&
        !authority.snapshot().outbox.some((q) => q.target === item.target && q.state === 'accepted')) && session.cwd === item.payload.cwd;
    return !!(session && session.isReadyForQueue() && !session._attaching && !session.elsewhere &&
      session.proc?.state !== 'pending' && session.cwd === item.payload.cwd);
  }
  function ensureStarted(item) {
    if (!engine || !startQueued || deliver || item.payload.kind !== 'claude' || item.payload.mode === 'handoff' || started.has(item.queueId)) return;
    const session = engine.manager.get(item.payload.instance);
    if (!session || session.disposed || session.isRunning || session.isPaused || session.elsewhere || session._attaching || session.cwd !== item.payload.cwd ||
        checkAuthority({ access: 'dispatch', context: item.payload.authority, message: item.payload.message, state: authority.snapshot() }) !== true) return;
    started.add(item.queueId);
    for (const key of launchFields) if (Object.hasOwn(item.payload.settings, key)) session[key] = structuredClone(item.payload.settings[key]);
    session.start(); // queued acceptance is durable; no prompt has crossed yet
  }
  async function drain(target) {
    if (!running || disposed) return;
    for (;;) {
      const snap = authority.snapshot();
      // A prior unknown/dispatching operation is a conversation barrier.
      if (snap.outbox.some((q) => providerBarrier(q, target))) return;
      const runnable = queueFor(snap, target);
      const item = runnable.find((q) => q.payload.command || ['steer', 'question', 'handoff'].includes(q.payload.mode)) || runnable[0];
      if (!item || item.scope !== snap.scope) return;
      ensureStarted(item);
      if (!canDrain(item)) return;
      let claimed = false;
      await authority.commit((state) => {
        const saved = state.outbox.find((q) => q.id === item.id);
        if (!saved || !queued(saved) || saved.scope !== state.scope ||
            state.outbox.some((q) => providerBarrier(q, target)) || !canDrain(saved)) return;
        advance(saved, 'dispatching', Math.max(now(), state.clockHighWater)); claimed = true;
      });
      if (!claimed) return;
      project();
      let disposition;
      try {
        // No await between this final target check and crossing the adapter.
        if (!canDrain(item)) disposition = { state: 'rejected', error: wireError('STALE_RESOURCE') };
        else if (deliver) disposition = await deliver(immutable(item));
        else if (item.payload.mode === 'handoff') {
          const session = sessionFor(item.payload.instance);
          const destination = await engine.codex.create({ cwd: item.payload.cwd });
          await authority.commit((state) => {
            const saved = state.outbox.find((q) => q.id === item.id);
            requireThat(saved?.state === 'dispatching', 'STALE_RESOURCE'); saved.destination = destination.id;
          });
          // Revalidate the source and current grant after provider creation.
          // A lost creation/submit reply stays behind the parent's marker.
          requireThat(sessionFor(item.payload.instance) === session && canDrain(item), 'STALE_RESOURCE');
          const answer = await queueOwner.submit(destination, item.payload.handoff.text, item.payload.message.attachments || [],
            { snippets: item.payload.message.snippets || [] });
          requireThat(answer.outcome === 'applied', 'OUTCOME_UNKNOWN');
          disposition = { state: 'completed', provider: providerFor(engine, destination, null) };
          session.emit('open', destination.id, item.payload.requester || null);
        } else if (item.payload.command) {
          const session = sessionFor(item.payload.instance);
          disposition = await deliverCommand({ engine, session, item,
            permitted: () => checkAuthority({ access: 'dispatch', context: item.payload.authority, message: item.payload.message, state: authority.snapshot() }) === true,
            phase: (name, provider) => authority.commit((state) => {
              const saved = state.outbox.find((q) => q.id === item.id); requireThat(saved?.state === 'dispatching', 'STALE_RESOURCE');
              saved.dispatchPhase = name; saved.provider = structuredClone(provider); reserveOperation(saved);
            }),
            saveChoice: (choice, check) => authority.commit((state) => {
              check(); const instance = instanceOf(state, item.target);
              instance.codexSettings = { ...(instance.codexSettings || {}), ...structuredClone(choice) };
              validateCurrent(current(state), root);
            }),
            saveDestination: (id) => authority.commit((state) => {
              const saved = state.outbox.find((q) => q.id === item.id); requireThat(saved?.state === 'dispatching', 'STALE_RESOURCE'); saved.destination = id;
            }) });
        } else if (item.payload.kind === 'codex') {
          const session = sessionFor(item.payload.instance);
          let binding = item.payload.mode !== 'send' ? capturedSends.get(item.id) : null;
          if (item.payload.mode !== 'send' && !binding) binding = session._engineControls.capture(item.payload.message);
          disposition = await deliverCodex({ engine, session, item, binding,
            permitted: () => checkAuthority({ access: 'dispatch', context: item.payload.authority, message: item.payload.message, state: authority.snapshot() }) === true,
            phase: (name, provider) => authority.commit((state) => {
              const saved = state.outbox.find((q) => q.id === item.id);
              requireThat(saved?.state === 'dispatching', 'STALE_RESOURCE');
              saved.dispatchPhase = name; saved.provider = structuredClone(provider); reserveOperation(saved);
            }) });
        } else {
          const session = engine.manager.get(item.payload.instance);
          const p = item.payload.message;
          const write = { id: item.id, session, proc: session.proc, turns: session.turns, completed: false };
          writes.set(target, write);
          const written = session.send(p.text, p.attachments,
            { sent: p.sent, snippets: p.snippets, authoritativeDispatch: true });
          disposition = written?.delivery === 'submitted' ? { state: write.completed ? 'completed' : 'accepted' }
            : { state: written?.delivery === 'not_written' ? 'rejected' : 'unknown', error: wireError(written?.delivery === 'not_written' ? 'PROVIDER_REJECTED' : 'OUTCOME_UNKNOWN') };
          if (written?.delivery !== 'submitted') writes.delete(target);
        }
        requireThat(disposition && ['accepted', 'completed', 'rejected', 'unknown'].includes(disposition.state));
        if (['rejected', 'unknown'].includes(disposition.state) && disposition.error) validateOperationError(disposition.error);
        if (disposition.provider) validateProvider(disposition.provider);
      } catch (_) { disposition = { state: 'unknown', error: wireError('OUTCOME_UNKNOWN') }; }
      await authority.commit((state) => {
        const saved = state.outbox.find((q) => q.id === item.id);
        if (['completed', 'rejected', 'discarded'].includes(saved.state) || saved.acceptanceProved && disposition.state === 'unknown') return;
        // Accepted work is nonrunnable but remains active/retained until exact
        // completion evidence arrives. It still consumes active-outbox space.
        advance(saved, disposition.state, Math.max(now(), state.clockHighWater),
          ['rejected', 'unknown'].includes(disposition.state) ? disposition.error || wireError(disposition.state === 'rejected' ? 'PROVIDER_REJECTED' : 'OUTCOME_UNKNOWN') : null);
        if (disposition.provider) { saved.provider = structuredClone(disposition.provider); reserveOperation(saved); }
        if (['accepted', 'completed'].includes(disposition.state)) saved.acceptanceProved = true;
      }, disposition.state === 'unknown' ? {} : { evidence: 'adapter:' + item.correlation });
      project();
      if (disposition.state === 'unknown') return;
    }
  }
  const api = {
    dispatcher, handlers,
    isDeviceRevoked(id, enrollment) { return revokedEnrollments.has(JSON.stringify([id, enrollment])); },
    activateDeviceRevocation(id) {
      for (const r of authority.snapshot().values['engine.deviceRevocations.v1'] || []) if (r.device === id)
        revokedEnrollments.add(JSON.stringify([r.device, r.enrollment]));
    },
    bindPrincipal(principal, owner, read) {
      requireThat(owner && typeof read === 'function', 'FORBIDDEN');
      const prior = principalAuthorities.get(principal);
      requireThat(!prior || prior.owner === owner, 'FORBIDDEN');
      principalAuthorities.set(principal, { owner, read });
    },
    updateReadiness() {
      if (drains.size || dispatcher.pendingCount) return { ready: false, code: 'PROVIDER_DISPATCH_ACTIVE' };
      const outbox = authority.snapshot().outbox;
      const busy = sessions().filter((s) => s.provider === 'codex' &&
        ((s.workspace.client.ownership === 'owned' && s.inTurn) || outbox.some((q) => q.target === 'session:' + s.id &&
          q.provider?.ownership === 'owned' && ['dispatching', 'accepted', 'unknown'].includes(q.state))));
      return busy.length ? { ready: false, code: 'CODEX_OWNED_BUSY', instances: busy.map((s) => s.id) } : { ready: true };
    },
    status() { return { running, admitting, issue: issue && { ...issue }, dispatches: dispatcher.pendingCount,
      drains: drains.size, scheduled: scheduled.size, observations: observations.size }; },
    beginDrain() {
      admitting = false; running = false;
      for (const timer of scheduled.values()) timers.clearTimeout(timer);
      scheduled.clear();
    },
    createSocket(options) {
      if (options.client) return require('./wireMutations').createMutationSocket({ ...options, currentState: api });
      return dispatcher.createSocket({ ...options, mutate: api.dispatch, query: api.operation });
    },
    snapshot: () => authority.snapshot(),
    async dispatch(context, message, implementation = null) {
      if (!admitting) return dispatcher.refuse(context, message, 'STORAGE_UNAVAILABLE');
      let captured, trusted, binding;
      try { captured = immutable(message); trusted = immutable(context); }
      catch (_) { return dispatcher.dispatch(context, message, implementation); }
      if (!object(captured) || typeof captured.type !== 'string' || !object(trusted)) return dispatcher.dispatch(trusted, captured, implementation);
      // Wire families also freeze live targets before the metadata barrier.
      if (implementation?.capture) {
        try {
          const frozen = implementation.capture({ message: captured, context: trusted });
          implementation = { ...implementation, capture: () => frozen };
        } catch (error) {
          implementation = { ...implementation, capture: () => ({ error }) };
        }
      }
      // Capture live object/connection/pending identity BEFORE metadata lookup
      // or receipt I/O. A later await must never obtain a replacement target.
      const runBound = ['permission', 'interrupt', 'stopTask', 'send'].includes(captured.type) || captured.type === 'promoteQueued' && captured.mode === 'steer';
      if (engine && runBound) binding = captureControl(trusted, captured);
      if (!implementation && handlers[captured.type] && runBound) implementation = {
        ...(captured.type === 'promoteQueued' && captured.mode === 'steer' ? promoteSteer : handlers[captured.type]), capture: () => binding };
      if (binding?.command && implementation) implementation.beforeApply = async () => {
        if (binding.error) throw binding.error;
        const validate = () => {
          requireThat(sessionFor(binding.session.id) === binding.session, 'STALE_RUN');
          binding.session._engineControls.validate(binding);
          requireThat(checkAuthority({ access: 'dispatch', context: trusted, message: captured, state: authority.snapshot() }), 'FORBIDDEN');
        };
        try { await discoverCommand(binding.session, binding.command, validate); }
        catch (error) { if (businessErrors.includes(error.code) || error.code === 'FORBIDDEN') throw error; throw failure('PROVIDER_REJECTED'); }
      };
      if (engine && captured.type === 'send' && /^\/steer(?:\s|$)/i.test(captured.text || '') && implementation) {
        implementation.beforeApply = async () => {
          if (binding?.error) throw binding.error;
          const session = binding.session;
          requireThat(sessionFor(session.id) === session, 'STALE_RUN');
          session._engineControls.validate(binding);
          if (session.readOnly) {
            const owner = await session.workspace.ipc?.ownerOf(session.threadId);
            session._engineControls.validate(binding);
            requireThat(owner, 'PROVIDER_REJECTED');
          }
        };
      }
      try { await pendingMetadata; }
      catch (_) { return dispatcher.refuse(trusted, captured, 'STORAGE_UNAVAILABLE'); }
      const answer = await dispatcher.dispatch(trusted, captured, implementation);
      if (answer.admitted) {
        if (answer.outcome === 'applied' && captured.type === 'send' && binding && !binding.error) {
          const item = authority.snapshot().outbox.find((q) => q.scope === captured.scope && q.principal === trusted.principal && q.mid === captured.mid);
          if (item && !capturedSends.has(item.id)) capturedSends.set(item.id, binding);
        }
        project(); schedule(trusted.target);
      }
      return answer;
    },
    async operation(context, message) {
      try {
        const trusted = immutable(context), captured = immutable(message);
        // The receipt lookup performs current view checks and principal isolation.
        const receipt = await dispatcher.lookup(trusted, { ...captured, type: 'receipt:get' });
        if (receipt.type === 'receipt:error') return { ...receipt, type: 'operation:error' };
        const snap = authority.snapshot();
        const item = snap.outbox.find((q) => q.queueId && q.scope === captured.scope && q.principal === trusted.principal && q.mid === captured.mid);
        if (!item || receipt.reason === 'scope_changed') return { type: 'operation:missing', scope: snap.scope, mid: captured.mid, reason: receipt.reason || 'not_found' };
        dispatcher.checkView(trusted, { ...item, what: 'send' });
        return operation(item);
      } catch (error) {
        return { type: 'operation:error', scope: authority.inspect().state?.scope, mid: /^[a-f0-9]{32}$/.test(message?.mid) ? message.mid : null,
          code: ['BAD_MESSAGE', 'FORBIDDEN'].includes(error?.code) ? error.code : 'STORAGE_UNAVAILABLE', message: 'Operation lookup is not authoritative absence.' };
      }
    },
    async register(metadata) {
      requireThat(object(metadata) && typeof metadata.id === 'string' && metadata.id.length > 0 && typeof metadata.cwd === 'string');
      await authority.commit((state) => {
        if (engine && metadata.provider === 'codex') requireThat(metadata.account === engine.account.home && metadata.id === 'cx-' + metadata.threadId, 'BAD_MESSAGE');
        const list = current(state).instances;
        requireThat(!list.some((s) => s.id === metadata.id), 'STALE_RESOURCE'); list.push(structuredClone(metadata));
        validateCurrent(current(state), root);
      });
    },
    async settleOperation(binding, { state: outcome, provider = null, error = null }, evidence) {
      requireThat((typeof evidence === 'string' && evidence.length > 0 || object(evidence)) && ['accepted', 'completed', 'rejected'].includes(outcome));
      if (outcome === 'rejected') validateOperationError(error);
      if (provider) validateProvider(provider);
      const exactRefusal = object(evidence) ? immutable(evidence) : null;
      const proof = exactRefusal ? 'codex-not-accepted:' + exactRefusal.clientUserMessageId : evidence;
      const saved = await authority.commit((state) => {
        const item = state.outbox.find((q) => q.queueId && q.scope === binding.scope && q.principal === binding.principal && q.mid === binding.mid);
        requireThat(item && ['dispatching', 'accepted', 'unknown'].includes(item.state), 'NOT_FOUND');
        if (item.payload.kind === 'codex') {
          requireThat(!item.acceptanceProved && outcome === 'rejected' && exactRefusal?.accepted === false &&
            exactRefusal.account === item.provider?.account && exactRefusal.threadId === item.provider?.threadId &&
            exactRefusal.clientUserMessageId === item.correlation, 'BAD_MESSAGE');
          item.rejectionProved = true;
        }
        advance(item, outcome, Math.max(now(), state.clockHighWater), outcome === 'rejected' ? error : null);
        if (provider) { item.provider = structuredClone(provider); reserveOperation(item); }
      }, { evidence: proof });
      await settlePromotions();
      project(); return operation(saved.outbox.find((q) => q.scope === binding.scope && q.principal === binding.principal && q.mid === binding.mid));
    },
    async reconcileCodex(id) {
      const session = sessionFor(id);
      requireThat(session?.provider === 'codex', 'NOT_FOUND');
      const reader = await engine.codex.reader();
      const page = await reader.request('thread/turns/list', { threadId: session.threadId, limit: 40, sortDirection: 'desc', itemsView: 'full' });
      if (sessionFor(id) !== session || disposed) return;
      await api.observeCodex(id, page?.data);
    },
    observeCodex(id, turns) {
      const pending = (async () => {
        const session = sessionFor(id);
        requireThat(session?.provider === 'codex', 'NOT_FOUND');
        await enqueueState((state) => {
          if (disposed || sessionFor(id) !== session) return;
          for (const item of state.outbox.filter((q) => q.queueId && q.target === 'session:' + id &&
            (['dispatching', 'unknown', 'accepted'].includes(q.state) || q.state === 'queued' && q.promoteReceipt))) {
            const evidence = exactEvidence(item, { account: engine.account.id, threadId: session.threadId, turns });
            if (!evidence) continue;
            item.acceptanceProved = true;
            if (item.state !== evidence.state || item.provider.turnId !== evidence.provider.turnId) {
              item.provider = evidence.provider; advance(item, evidence.state, Math.max(now(), state.clockHighWater));
            }
          }
        }, { evidence: 'codex-exact:' + id });
        await settlePromotions();
        project(); schedule('session:' + id);
      })();
      observations.add(pending);
      void pending.finally(() => observations.delete(pending)).catch(() => {});
      return pending;
    },
    async localTransition(context, message, change) {
      // Administrative callers can supply a pure transition while retaining
      // the same reservation/co-commit path. No network registration is added.
      requireThat(context.seat?.local === true, 'LOCAL_REQUIRED');
      requireThat(!Object.hasOwn(handlers, message.type), 'BAD_MESSAGE');
      return api.dispatch(context, message, { apply: (args) => {
        requireThat(args.context.seat?.local === true, 'LOCAL_REQUIRED');
        const answer = change(args); validateCurrent(current(args.state), root); return answer;
      }, businessErrors });
    },
    restoreEngine() {
      requireThat(!running && engine, 'BAD_MESSAGE');
      projecting = true;
      try {
        const account = current(authority.snapshot()).account;
        if (account) Object.assign(engine.manager, structuredClone(account));
        for (const saved of current(authority.snapshot()).instances) if (!engine.manager.get(saved.id)) {
          if (saved.provider === 'codex') { engine.codex._adopt({ id: saved.threadId, cwd: saved.cwd }); continue; }
          const session = engine.manager.create({ ...saved, title: saved.customTitle, resume: saved.claudeSessionId, queue: [], autoStart: false });
          session._durableQueueOwner = queueOwner;
        }
      } finally { projecting = false; }
      project();
    },
    project,
    start() { requireThat(!disposed && !issue && authority.status().writable, 'STORAGE_UNAVAILABLE'); running = true; project(); for (const item of authority.snapshot().outbox.filter(queued)) schedule(item.target); },
    drain(target) {
      if (drains.has(target)) return drains.get(target);
      const pending = drain(target).finally(() => {
        drains.delete(target);
        if (running && !disposed && authority.status().writable && queueFor(authority.snapshot(), target).length) schedule(target, 1000);
      }); drains.set(target, pending); return pending;
    },
    async flush() {
      for (;;) {
        const pending = pendingMetadata;
        await pending; await Promise.all([...drains.values(), ...observations]);
        if (pending === pendingMetadata && !drains.size && !observations.size) return;
      }
    },
    async dispose() {
      api.beginDrain(); disposed = true;
      for (const timer of scheduled.values()) timers.clearTimeout(timer); scheduled.clear();
      if (engine) engine.manager.removeListener('session-changed', capture);
      if (engine) engine.manager.removeListener('account-changed', captureAccount);
      if (engine) engine.manager.removeListener('removed', removed);
      writes.clear();
      capturedSends.clear();
      if (engine) {
        engine.manager.prepareSession = null;
        if (engine.codex) {
          engine.codex.prepareSession = null; engine.codex.removeListener('session-added', capture);
          engine.codex.ipc?.removeListener?.('request', ipcRequest); engine.codex.ipc?.removeListener?.('exit', ipcExit);
        }
        for (const [session, { changed, evidence }] of attached) {
          if (session.provider === 'codex') for (const event of ['status', 'meta', 'queue', 'unread']) session.removeListener(event, changed);
          session.removeListener('provider-evidence', evidence);
          delete session._engineControls;
        }
      }
      await api.flush(); await dispatcher.dispose(); principalAuthorities.clear();
    }
  };
  if (engine) {
    engine.manager.prepareSession = attach;
    if (engine.codex) {
      engine.codex.prepareSession = attach; engine.codex.on('session-added', capture);
      engine.codex.ipc?.on?.('request', ipcRequest); engine.codex.ipc?.on?.('exit', ipcExit);
    }
    for (const session of sessions()) attach(session);
    engine.manager.on('session-changed', capture);
    engine.manager.on('account-changed', captureAccount);
    engine.manager.on('removed', removed);
    engine.manager.authorityPolicy = ({ id, cwd }) => {
      requireThat(!issue && !disposed && (!id || !engine.manager.get(id) && !retired.has(id)), 'STALE_RESOURCE');
      requireThat(path.isAbsolute(cwd || '') && (!root || cwd === root || cwd.startsWith(root + path.sep)), 'BAD_MESSAGE');
    };
    engine.folders.authorityCommit = (folders) => {
      return enqueueState((state) => {
        requireThat(!disposed, 'STORAGE_UNAVAILABLE'); current(state).folders = structuredClone(folders);
      });
    };
    engine.folders.nextId = () => 'f-' + crypto.randomBytes(16).toString('hex');
  }
  return api;
}

// Pure precommit import validation. The source's approved project scopes are
// checked by the context/provenance adapter; no provider, timer or store opens.
function validateImportedAuthority(state, validateSettings) {
  const data = state.values[DOMAIN];
  if (data !== undefined) {
    requireThat(object(data) && object(data.settings) && Array.isArray(data.settings.projects), 'STORAGE_UNAVAILABLE');
    validateCurrent({ ...data, settings: { ...data.settings, projects: [] } });
    validateSettings(data.settings);
  }
  validateOutbox(state);
  validateControlState(state.values[CONTROL_STATE]);
  require('./wireMutations').validateMutationState(state);
  const account = state.values[CODEX_ACCOUNT];
  requireThat(account === undefined || object(account) && typeof account.id === 'string' && account.id.length > 0 && path.isAbsolute(account.home || ''), 'STORAGE_UNAVAILABLE');
}

module.exports = { DOMAIN, initializeEngineState, createEngineState, allocate, operation, selectedMeta, validateSend, validateImportedAuthority };
