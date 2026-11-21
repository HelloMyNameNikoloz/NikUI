'use strict';

const crypto = require('crypto');
const CORE = Object.freeze(['mid-ack-v1', 'receipts-v1', 'run-precondition-v1', 'operation-state-v1']);
const HEX32 = /^[0-9a-f]{32}$/;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const ERROR_CODES = new Set(('BAD_MESSAGE MID_REQUIRED MID_CONFLICT SCOPE_CHANGED EXPIRED CLOCK_SKEW FORBIDDEN LOCAL_REQUIRED UNSUPPORTED NOT_FOUND STALE_RUN STALE_TURN STALE_RESOURCE APPROVAL_RESOLVED EDITOR_UNAVAILABLE UI_UNAVAILABLE CANCELLED RECEIPT_FULL STORAGE_UNAVAILABLE ENGINE_RESTARTED PROVIDER_REJECTED OUTCOME_UNKNOWN').split(' '));
const REPLIES = { 'instance:new': ['instance:created'], 'instance:resume': ['instance:created'], 'instance:place': ['instance:placed'],
  editQueued: ['editPrompt'], saveCommand: ['commands'], removeCommand: ['commands'], restoreCommand: ['commands'],
  'pr:reply': ['pr:done'], 'pr:resolve': ['pr:done'], 'pr:comment': ['pr:done'], 'pr:rerun': ['pr:done'],
  'term:open': ['term:opened'], 'term:close': ['term:closed'], '@listen': ['@listener'],
  'slack:reply': ['slack:sent'], 'slack:link': ['slack:link'], 'slack:openTicket': ['slack:openTicket'], switch: ['@navigate'] };
const object = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const requireThat = (ok, code = 'BAD_MESSAGE', message) => { if (!ok) throw failure(code, message); };
const unicode = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);

// Write pairs directly: JSON.stringify(object) would reorder integer keys.
// This is also the validation boundary for injected (not JSON.parse) callers.
function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { requireThat(unicode(value)); return JSON.stringify(value); }
  if (typeof value === 'number') { requireThat(Number.isFinite(value)); return JSON.stringify(value); }
  requireThat(Array.isArray(value) || object(value));
  requireThat(!seen.has(value) && Object.getOwnPropertySymbols(value).length === 0);
  seen.add(value);
  const keys = Object.keys(value);
  if (Array.isArray(value)) requireThat(keys.length === value.length && keys.every((k, n) => k === String(n)));
  const pairs = (Array.isArray(value) ? keys : keys.sort()).map((k) => {
    requireThat(unicode(k) && !['__proto__', 'prototype', 'constructor'].includes(k));
    const descriptor = Object.getOwnPropertyDescriptor(value, k);
    requireThat(descriptor && Object.hasOwn(descriptor, 'value'));
    return [k, canonical(descriptor.value, seen)];
  });
  seen.delete(value);
  return Array.isArray(value) ? '[' + pairs.map(([, v]) => v).join(',') + ']'
    : '{' + pairs.map(([k, v]) => JSON.stringify(k) + ':' + v).join(',') + '}';
}

function immutable(value) {
  canonical(value);
  const copy = structuredClone(value);
  function freeze(v) { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } }
  freeze(copy); return copy;
}
function targetOf(context) {
  requireThat(context && (context.role === 'fleet' && context.target === 'fleet' ||
    context.role === 'conversation' && typeof context.target === 'string' && /^session:.+/.test(context.target)), 'FORBIDDEN');
  return context.target;
}
function requestHash(message, target) {
  const intent = { ...message }; delete intent.mid; delete intent.scope;
  return crypto.createHash('sha256').update(canonical({ message: intent, target }), 'utf8').digest('hex');
}
function validateEnvelope(message) {
  requireThat(object(message) && typeof message.type === 'string' && message.type.length > 0);
  requireThat(typeof message.mid === 'string' && HEX32.test(message.mid), 'MID_REQUIRED');
  requireThat(typeof message.scope === 'string' && HEX32.test(message.scope));
  requireThat(Number.isSafeInteger(message.issuedAt) && message.issuedAt >= 0);
  requireThat(Buffer.byteLength(canonical(message)) <= MAX_MESSAGE_BYTES);
}
function validateRun(run) {
  requireThat(object(run) && Object.keys(run).sort().join(',') === 'id,turn' && typeof run.id === 'string' && HEX32.test(run.id) &&
    (run.turn === null || typeof run.turn === 'string' && run.turn.length > 0 && Buffer.byteLength(run.turn) <= 256));
}
function validateResult(result, maxBytes = 16384, what = null) {
  requireThat(object(result) && ['accepted', 'ok', 'noop'].includes(result.code) && object(result.data) && Array.isArray(result.replies));
  requireThat(result.replies.every((r) => object(r) && typeof r.type === 'string' &&
    !['ack', 'operation', '@auth', '@box', '@challenge', '@welcome'].includes(r.type)));
  if (what !== null) requireThat(result.replies.every((r) => (REPLIES[what] || []).includes(r.type)));
  const data = result.data, text = (v) => typeof v === 'string' && v.length > 0;
  if (what === 'send') requireThat(result.code === 'accepted' && text(data.instance) && text(data.queueId) && typeof data.operation === 'string' && HEX32.test(data.operation));
  if (['unqueue', 'editQueued', 'promoteQueued'].includes(what)) requireThat(text(data.queueId));
  if (what === 'editQueued') requireThat(result.replies.length === 1 && typeof result.replies[0].text === 'string' &&
    (result.replies[0].sent === null || typeof result.replies[0].sent === 'string') && Array.isArray(result.replies[0].snippets) && Array.isArray(result.replies[0].attachments));
  if (what === 'clearQueue') requireThat(Number.isSafeInteger(data.removed) && data.removed >= 0);
  if (what === 'instance:place') requireThat(text(data.instance) && (data.folderId === null || text(data.folderId)));
  if (['instance:new', 'instance:resume'].includes(what)) requireThat(text(data.instance));
  if (what === 'ready') { requireThat(text(data.instance)); if (data.run !== null) validateRun(data.run); }
  if (what === 'visible') requireThat(typeof data.on === 'boolean');
  if (['saveCommand', 'removeCommand', 'restoreCommand'].includes(what)) requireThat(text(data.name));
  if (['setSetting', 'awake:set', 'lid:set'].includes(what)) requireThat(text(data.id) && Object.hasOwn(data, 'value'));
  if (['pr:pane', 'pr:link', 'pr:unlink'].includes(what)) requireThat((data.prUrl === null || text(data.prUrl)) && (data.pane === null || object(data.pane)));
  if (what === 'permission') { validateRun(data.run); requireThat(text(data.requestId) && typeof data.allow === 'boolean' && data.delivery === 'submitted'); }
  if (['interrupt', 'stopTask'].includes(what)) { validateRun(data.run); requireThat((data.taskId === null || text(data.taskId)) && data.delivery === 'submitted'); }
  if (['pr:reply', 'pr:resolve', 'pr:comment', 'pr:rerun'].includes(what)) requireThat(text(data.prUrl) &&
    data.action === what.slice(3) && typeof data.message === 'string' && (data.providerId === null || text(data.providerId)));
  if (what === 'term:open') requireThat(object(data.terminal) && text(data.terminal.id) && data.terminal.activeRun === null);
  if (['term:run', 'term:stop', 'term:close'].includes(what)) requireThat(text(data.terminal) &&
    (what === 'term:close' && data.terminalRun === null || text(data.terminalRun)));
  if (what === '@apple') requireThat(data.registered === true && Object.keys(data).length === 1);
  if (what === '@listen') requireThat(Object.keys(data).length === 0 && result.replies.length === 1 && text(result.replies[0].secret));
  if (what === 'forget') requireThat(text(data.device));
  if (['slack:reply', 'slack:open'].includes(what)) requireThat(text(data.conversation) && (data.thread === null || text(data.thread)) &&
    (what !== 'slack:reply' || text(data.ts)));
  if (['slack:mute', 'slack:vips', 'slack:enable'].includes(what)) requireThat((data.conversation === null || text(data.conversation)) &&
    (what === 'slack:vips' ? Array.isArray(data.value) && data.value.every((v) => typeof v === 'string') : typeof data.value === 'boolean'));
  if (['slack:connect', 'slack:disconnect', 'slack:signIn'].includes(what)) requireThat(typeof data.connected === 'boolean' &&
    (data.who === null || object(data.who)) && Object.keys(data).sort().join(',') === 'connected,who');
  if (['openFile', 'runInTerminal', 'switch', 'allSettings', 'slack', 'openPr', 'pr:open', 'slack:settings', 'slack:setup', 'slack:link', 'slack:openTicket'].includes(what))
    requireThat((data.provider === null || text(data.provider)) && (data.destination === null || text(data.destination)));
  requireThat(Buffer.byteLength(canonical({ result, error: null })) <= maxBytes, 'RECEIPT_FULL');
  return result;
}

/** A socket owns this state machine only AFTER transport authentication.
 * Partial v2 is deliberately possible only in an explicit in-process harness.
 * Client labels and message.from never participate in authentication.
 */
function createNegotiation({ authenticated, context, sealed = false, testOnlyV2 = false, caps = CORE,
  engine, receipts, now = Date.now, timers = { setTimeout, clearTimeout }, post, close,
  legacy = () => {}, receive = () => {} } = {}) {
  requireThat(authenticated === true && context && typeof context.principal === 'string' && context.principal.length > 0, 'FORBIDDEN');
  targetOf(context);
  const trusted = immutable(context);
  requireThat(object(trusted.seat) && typeof trusted.seat.id === 'string' &&
    ['control', 'local', 'editor'].every((k) => typeof trusted.seat[k] === 'boolean') && (!trusted.seat.editor || trusted.seat.local), 'FORBIDDEN');
  const eligible = testOnlyV2 === true && (trusted.seat.local || sealed === true) && CORE.every((cap) => caps.includes(cap));
  const supported = Object.freeze({ min: 1, max: eligible ? 2 : 1 });
  const advertisedCaps = eligible ? [...caps] : [];
  let proto = null, selected = [], ended = false, deadline;
  function stop() { if (deadline) timers.clearTimeout(deadline); deadline = null; }
  function error(code) {
    if (ended) return;
    ended = true; stop();
    post({ type: 'protocol:error', code, message: code === 'NO_COMMON_PROTOCOL' ? 'No compatible application protocol.' : code, supported: { ...supported } });
    close(1002, code);
  }
  deadline = timers.setTimeout(() => error('NEGOTIATION_TIMEOUT'), 10000);
  if (deadline && deadline.unref) deadline.unref();
  return {
    advertisement: { proto: { ...supported }, caps: advertisedCaps },
    get proto() { return proto; },
    get caps() { return selected.slice(); },
    async receive(message) {
      if (ended) return;
      if (message && message.type === 'hello') {
        if (proto !== null) return error('BAD_HELLO');
        try {
          canonical(message);
          const { proto: range, caps: offered, client } = message;
          requireThat(object(range) && Number.isSafeInteger(range.min) && Number.isSafeInteger(range.max) && range.min > 0 && range.min <= range.max);
          requireThat(Array.isArray(offered) && offered.length <= 64 && new Set(offered).size === offered.length &&
            offered.every((c) => typeof c === 'string' && /^[\x20-\x7e]{1,64}$/.test(c)));
          requireThat(object(client) && typeof client.id === 'string' && HEX32.test(client.id) &&
            ['browser', 'android', 'iphone', 'extension', 'mac', 'test'].includes(client.kind) && typeof client.version === 'string' && [...client.version].length <= 80);
          const common2 = range.min <= 2 && range.max >= 2 && supported.max === 2;
          const core = CORE.every((cap) => offered.includes(cap));
          if (common2 && core) { proto = 2; selected = advertisedCaps.filter((cap) => offered.includes(cap)); }
          else if (range.min <= 1 && range.max >= 1) proto = 1;
          else return error(common2 && !core ? 'REQUIRED_CAPABILITY' : 'NO_COMMON_PROTOCOL');
          stop();
          const clock = now(), receiptInfo = typeof receipts === 'function' ? receipts() : receipts;
          requireThat(proto !== 2 || receiptInfo && HEX32.test(receiptInfo.scope));
          post({ type: 'welcome', proto, caps: selected.slice(), engine: structuredClone(engine), seat: structuredClone(trusted.seat),
            receipts: proto === 2 ? { ...receiptInfo, now: clock } : null });
        } catch (_) { return error('BAD_HELLO'); }
        return;
      }
      if (proto === null) { proto = 1; stop(); }
      if (proto === 1) return legacy(message);
      return receive(message, trusted, selected.slice());
    },
    dispose() { ended = true; stop(); }
  };
}

module.exports = { CORE, HEX32, MAX_MESSAGE_BYTES, ERROR_CODES, object, failure, requireThat, canonical, immutable,
  targetOf, requestHash, validateEnvelope, validateRun, validateResult, createNegotiation };
