'use strict';

const { HEX32, MAX_MESSAGE_BYTES, ERROR_CODES, object, requireThat, immutable, targetOf,
  requestHash, validateEnvelope, validateResult, createNegotiation, canonical } = require('./protocolV2');
const { validateState, reserveOperation } = require('./jsonlAuthority');

const keyOf = ({ scope, principal, mid }) => JSON.stringify([scope, principal, mid]);
const wireError = (code, message = code) => ({ code, message: Buffer.from(message).subarray(0, 2000).toString('utf8'), retryable: false });
const unknownError = () => wireError('OUTCOME_UNKNOWN', 'Delivery cannot be determined; preserve the original intent.');
function ack(entry, duplicate = false) {
  return structuredClone({ type: 'ack', scope: entry.scope, mid: entry.mid, what: entry.what, target: entry.target,
    status: duplicate ? 'duplicate' : entry.outcome, outcome: entry.outcome, admitted: true,
    at: entry.at, expiresAt: entry.expiresAt, result: entry.result, error: entry.error });
}

/** All handlers return explicit typed results. An atomic handler changes only
 * the supplied state, synchronously. An external handler gets a committed
 * dispatch marker before execute; thrown/undefined results mean UNKNOWN.
 * authorize is a synchronous read of CURRENT authenticated grants, including
 * receipt-view authority. It is checked again after waits and before disclosure.
 */
function createReceiptDispatcher({ authority, handlers = {}, authorize, now = Date.now } = {}) {
  requireThat(authority && typeof authorize === 'function');
  const inFlight = new Map();
  let recovered = false, recovering, closed = false;
  const info = () => authority.receiptInfo();
  const clock = () => Math.max(now(), info().clockHighWater);
  const scope = () => info().scope;
  const find = (state, key) => authority.findReceipt(state, key);
  function view(context, entry = null) {
    requireThat(context && context.authenticated === true && typeof context.principal === 'string' &&
      context.principal.length > 0 && Buffer.byteLength(context.principal) <= 256, 'FORBIDDEN');
    targetOf(context);
    requireThat(authorize({ access: 'view', context, entry }) === true, 'FORBIDDEN');
  }
  function rejection(context, message, error) {
    let activeScope, at;
    try { activeScope = scope(); at = clock(); } catch (_) { const saved = authority.inspect().state; activeScope = saved && saved.scope; at = now(); }
    return { type: 'ack', scope: typeof message?.scope === 'string' && HEX32.test(message.scope) ? message.scope : activeScope,
      mid: typeof message?.mid === 'string' && HEX32.test(message.mid) ? message.mid : null,
      what: typeof message?.type === 'string' ? message.type : '', target: context && context.target || 'fleet',
      status: 'rejected', outcome: 'rejected', admitted: false, at, expiresAt: null, result: null,
      error: wireError(ERROR_CODES.has(error?.code) ? error.code : /^(AUTHORITY_|STORAGE_|EIO)/.test(error?.code || '') ? 'STORAGE_UNAVAILABLE' : 'BAD_MESSAGE') };
  }
  function finish(entry, outcome, result, error) {
    requireThat(['applied', 'rejected', 'unknown'].includes(outcome));
    if (outcome === 'applied') validateResult(result, entry.reservedResultBytes || authority.limits.maxResultBytes, entry.what);
    else requireThat(object(error) && ERROR_CODES.has(error.code) && typeof error.message === 'string' &&
      Buffer.byteLength(error.message) <= 2048 && error.retryable === false);
    Object.assign(entry, { phase: 'completed', outcome, result: outcome === 'applied' ? structuredClone(result) : null,
      error: outcome === 'applied' ? null : structuredClone(error), reservedResultBytes: 0 });
  }
  async function recover() {
    if (recovered) return;
    if (!recovering) recovering = authority.commit((state) => {
      for (const entry of state.entries) {
        if (entry.phase === 'prepared') finish(entry, 'rejected', null, wireError('ENGINE_RESTARTED'));
        else if (entry.phase === 'dispatching') finish(entry, 'unknown', null, unknownError());
      }
      for (const item of state.outbox) {
        if (item.state === 'dispatching') {
          item.state = 'unknown';
          if (item.queueId) { item.error = unknownError(); item.revision++; item.at = Math.max(now(), state.clockHighWater); }
          reserveOperation(item);
        }
        else if (item.state === 'prepared') item.state = 'discarded';
      }
    }).then(() => { recovered = true; });
    return recovering;
  }
  async function complete(binding, disposition, evidence = null) {
    const key = keyOf(binding);
    const state = await authority.commit((next) => {
      const entry = find(next, key); requireThat(entry, 'NOT_FOUND');
      if (evidence && ['applied', 'rejected'].includes(entry.outcome)) {
        requireThat(canonical({ outcome: entry.outcome, result: entry.result, error: entry.error }) ===
          canonical({ outcome: disposition.outcome, result: disposition.result || null, error: disposition.error || null }));
        return; // Two exact observers may settle the same evidence together.
      }
      requireThat(entry.outcome === 'pending' || entry.outcome === 'unknown' && typeof evidence === 'string' && evidence.length > 0);
      finish(entry, disposition.outcome, disposition.result, disposition.error);
      const item = next.outbox.find((q) => q.id === entry.requestRef);
      if (item) { item.state = disposition.outcome === 'unknown' ? 'unknown' : 'completed'; reserveOperation(item); }
    }, evidence ? { evidence } : {});
    return ack(find(state, key));
  }
  async function run(context, message, hash, handler, key, captured) {
    // Historical receipts precede fresh provider/resource checks. This indexed
    // path also keeps a duplicate at the 10k bound out of full-state commits.
    if (message.scope === scope()) {
      const old = await authority.lookup({ ...message, principal: context.principal });
      if (old) { view(context, old); requireThat(old.hash === hash, 'MID_CONFLICT'); return ack(old, true); }
    }
    let admissionError = null;
    if (handler?.beforeApply && message.scope === scope()) {
      view(context);
      requireThat(authorize({ access: 'dispatch', context, message, state: authority.snapshot() }) === true, 'FORBIDDEN');
      requireThat(!handler.roles || handler.roles.includes(context.role), 'UNSUPPORTED');
      requireThat(!handler.cap || !context.caps || context.caps.includes(handler.cap), 'UNSUPPORTED');
      try { await handler.beforeApply({ context, message, captured }); }
      catch (error) { if (!handler.businessErrors?.includes(error?.code)) throw error; admissionError = error; }
    }
    let created = false;
    const state = await authority.commit((next) => {
      view(context);
      requireThat(message.scope === next.scope, 'SCOPE_CHANGED');
      const old = find(next, key);
      if (old) { view(context, old); requireThat(old.hash === hash, 'MID_CONFLICT'); return; }
      const at = next.clockHighWater;
      requireThat(now() + authority.limits.skewMs >= at, 'CLOCK_SKEW');
      requireThat(message.issuedAt >= at - authority.limits.retentionMs, 'EXPIRED');
      requireThat(message.issuedAt <= at + authority.limits.skewMs, 'CLOCK_SKEW');
      requireThat(authorize({ access: 'dispatch', context, message, state: next }) === true, 'FORBIDDEN');
      requireThat(handler && (typeof handler.apply === 'function' || typeof handler.execute === 'function'), 'UNSUPPORTED');
      requireThat(!handler.roles || handler.roles.includes(context.role), 'UNSUPPORTED');
      requireThat(!handler.cap || !context.caps || context.caps.includes(handler.cap), 'UNSUPPORTED');
      const reserve = handler.resultBytes ? handler.resultBytes({ state: next, message, context }) : 16384;
      requireThat(Number.isSafeInteger(reserve) && reserve > 0 && reserve <= authority.limits.maxResultBytes, 'RECEIPT_FULL');
      const entry = { v: 1, scope: next.scope, principal: context.principal, mid: message.mid,
        target: context.target, what: message.type, hash, issuedAt: message.issuedAt, at,
        expiresAt: at + authority.limits.retentionMs, phase: 'prepared', outcome: 'pending',
        result: null, error: null, reservedResultBytes: reserve, requestRef: null };
      validateState({ ...next, entries: [...next.entries, entry] }, authority.limits);
      // Local state and receipt are one commit. Never retain a partially
      // mutated state after a business-rule rejection.
      const before = structuredClone(next);
      try {
        if (admissionError) throw admissionError;
        if (handler.apply) finish(entry, 'applied', handler.apply({ state: next, message, context, entry, captured }), null);
        else {
          const payload = handler.prepare ? handler.prepare({ state: next, message, context, entry, captured }) : { message };
          requireThat(object(payload));
          entry.requestRef = 'request:' + next.scope + ':' + context.principal + ':' + message.mid;
          requireThat(!next.outbox.some((q) => q.id === entry.requestRef), 'MID_CONFLICT');
          next.outbox.push({ v: 1, id: entry.requestRef, scope: next.scope, principal: context.principal,
            mid: message.mid, target: context.target, state: 'prepared', payload: structuredClone(payload) });
        }
      } catch (error) {
        if (!handler.businessErrors?.includes(error?.code)) throw error;
        Object.assign(next, before); entry.requestRef = null;
        finish(entry, 'rejected', null, wireError(error.code));
      }
      next.entries.push(entry); created = true;
    });
    const entry = find(state, key);
    if (!created || entry.phase === 'completed') { view(context, entry); return ack(entry, !created); }
    // Capacity and complete immutable input have already been reserved.
    await authority.commit((next) => {
      view(context);
      requireThat(authorize({ access: 'dispatch', context, message, state: next }) === true, 'FORBIDDEN');
      const saved = find(next, key); saved.phase = 'dispatching';
      next.outbox.find((q) => q.id === saved.requestRef).state = 'dispatching';
    }).catch(async (error) => {
      if (error?.code === 'FORBIDDEN') await complete(entry, { outcome: 'rejected', error: wireError('FORBIDDEN') });
      throw error;
    });
    let disposition;
    try {
      // Current authority is read immediately before the external call.
      view(context);
      requireThat(authorize({ access: 'dispatch', context, message, state: authority.snapshot() }) === true, 'FORBIDDEN');
    } catch (_) {
      const refused = await complete(entry, { outcome: 'rejected', error: wireError('FORBIDDEN') });
      view(context, entry); return refused;
    }
    try {
      disposition = await handler.execute({ context, message, entry: immutable(entry),
        payload: immutable(state.outbox.find((q) => q.id === entry.requestRef).payload), captured });
      if (disposition?.outcome === 'pending') { view(context, entry); return ack(entry); }
      requireThat(object(disposition) && ['applied', 'rejected', 'unknown'].includes(disposition.outcome));
      if (disposition.outcome === 'applied') validateResult(disposition.result, entry.reservedResultBytes, entry.what);
      else requireThat(object(disposition.error) && ERROR_CODES.has(disposition.error.code) && typeof disposition.error.message === 'string' &&
        Buffer.byteLength(disposition.error.message) <= 2048 && disposition.error.retryable === false);
    } catch (_) { disposition = { outcome: 'unknown', error: unknownError() }; }
    let result;
    try { result = await complete(entry, disposition); }
    catch (_) {
      // A committed dispatch marker remains the barrier even if completion
      // fsync fails. It must never turn into an unadmitted/not_found response.
      result = ack({ ...entry, outcome: 'unknown', result: null, error: unknownError() });
    }
    view(context, entry); return result;
  }
  const api = {
    authority, recover, complete,
    get pendingCount() { return inFlight.size; },
    checkView: view,
    refuse(context, message, code) { return rejection(context, message, { code }); },
    receiptInfo() { return { scope: scope(), retentionMs: authority.limits.retentionMs, maxEntries: authority.limits.maxEntries,
      maxBytes: authority.limits.maxBytes, maxMessageBytes: MAX_MESSAGE_BYTES, maxResultBytes: authority.limits.maxResultBytes }; },
    dispatch(context, input, implementation = null) {
      let message, trusted, hash, handler, key, captured;
      try {
        requireThat(recovered && !closed, 'STORAGE_UNAVAILABLE');
        view(context);
        validateEnvelope(input);
        message = immutable(input); trusted = immutable(context);
        handler = implementation || (Object.hasOwn(handlers, message.type) ? handlers[message.type] : null);
        if (handler?.validate) requireThat(handler.validate(message) !== false);
        hash = requestHash(message, targetOf(trusted));
        key = keyOf({ ...message, principal: trusted.principal });
        const pending = inFlight.get(key);
        if (pending) {
          requireThat(pending.hash === hash, 'MID_CONFLICT');
          return pending.promise.then(() => api.lookup(trusted, { type: 'receipt:get', scope: message.scope, mid: message.mid }));
        }
        if (handler?.capture) captured = handler.capture({ message, context: trusted });
      } catch (error) { return Promise.resolve(rejection(context, input, error)); }
      const promise = run(trusted, message, hash, handler, key, captured).catch((error) => rejection(trusted, message, error));
      inFlight.set(key, { hash, promise });
      void promise.finally(() => { if (inFlight.get(key)?.promise === promise) inFlight.delete(key); });
      return promise;
    },
    async lookup(context, message) {
      let currentScope;
      try {
        requireThat(recovered && !closed, 'STORAGE_UNAVAILABLE');
        view(context);
        context = immutable(context); message = immutable(message);
        requireThat(object(message) && typeof message.mid === 'string' && HEX32.test(message.mid) && typeof message.scope === 'string' && HEX32.test(message.scope));
        currentScope = scope();
        const pending = inFlight.get(keyOf({ ...message, principal: context.principal }));
        if (pending) await pending.promise;
        view(context);
        if (message.scope !== scope()) return { type: 'receipt:missing', scope: scope(), mid: message.mid, reason: 'scope_changed' };
        const entry = await authority.lookup({ scope: message.scope, principal: context.principal, mid: message.mid });
        view(context, entry);
        if (entry && clock() > entry.expiresAt) return { type: 'receipt:missing', scope: currentScope, mid: message.mid, reason: 'expired' };
        if (entry) return ack(entry, true);
        return { type: 'receipt:missing', scope: currentScope, mid: message.mid, reason: 'not_found' };
      } catch (error) {
        if (error?.code === 'SCOPE_CHANGED') {
          try { view(context); return { type: 'receipt:missing', scope: scope(), mid: message.mid, reason: 'scope_changed' }; }
          catch (refusal) { error = refusal; }
        }
        return { type: 'receipt:error', scope: currentScope || authority.inspect().state?.scope,
          mid: typeof message?.mid === 'string' && HEX32.test(message.mid) ? message.mid : null,
          code: ['BAD_MESSAGE', 'FORBIDDEN'].includes(error?.code) ? error.code : 'STORAGE_UNAVAILABLE', message: 'Receipt lookup is not authoritative absence.' };
      }
    },
    createSocket({ engine, post, query, mutate = api.dispatch, ...options }) {
      return createNegotiation({ ...options, engine, post, now: clock, receipts: () => api.receiptInfo(),
        receive: async (message, trusted, caps) => {
          const context = { ...trusted, caps };
          const answer = message?.type === 'receipt:get' ? await api.lookup(context, message)
            : query && message?.type === 'operation:get' ? await query(context, message) : await mutate(context, message);
          post(answer);
        } });
    },
    async dispose() { closed = true; await Promise.all([...inFlight.values()].map((v) => v.promise)); }
  };
  return api;
}

module.exports = { createReceiptDispatcher, keyOf, ack, wireError };
