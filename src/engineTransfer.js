'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { privateRoot, privateFile, readPrivateJson, fail } = require('./daemonPaths');
const { atomicJson, hash } = require('./engineOwner');
const { validateState, LIMITS } = require('./jsonlAuthority');
const { selectedMeta } = require('./engineState');
const insist = (v, code) => { if (!v) throw fail(code, code); };
const clone = (v) => structuredClone(v);
const GLOBAL_KEYS = Object.freeze(['nikui.names.v1', 'nikui.limits.v1', 'nikui.pause.v1', 'nikui.limitOverride.v1',
  'nikui.slashCommands.v1', 'nikui.devices', 'nikui.deviceTrail', 'nikui.ciDurations', 'nikui.notified', 'nikui.identity', 'nikui.vapid']);
const WORKSPACE_KEYS = Object.freeze(['nikui.sessions.v1', 'nikui.folders.v1', 'nikui.remote.wasServing']);
const SECRET_KEYS = Object.freeze(['nikui.slack.userToken', 'nikui.slack.appToken', 'nikui.slack.sessionToken', 'nikui.slack.sessionCookie']);
const GLOBAL_OMISSIONS = Object.freeze({ 'nikui.models': 'derived', 'nikui.workspace': 'client-owned' });
const OMITTED = Object.freeze({ caches: 'derived; rebuild in target', clientOutboxes: 'client-owned; preserve binding or quarantine',
  providerHomes: 'provider-owned; never copied', editorSQLite: 'never read; export context APIs',
  liveProcesses: 'explicit keeper transfer only; no Codex survival claim' });

/** Gate every synthetic source adapter, including deferred memento writes.
 * Drain callbacks must await their real stores before export. A sealed source
 * cannot write again unless an explicit, proved abort reopens its old lease.
 */
function createParticipantGate({ owner, member, timers = { setTimeout, clearTimeout } }) {
  let phase = 'open', transition = null, issue = null;
  const pending = new Set(), deferred = new Set();
  const options = () => ({ transition, drain: phase === 'quiescing' });
  const api = {
    get phase() { return phase; },
    write(change) {
      insist(phase === 'open' || phase === 'quiescing', 'WRITER_SEALED');
      return owner.effect(member.lease, member.generation, change, options());
    },
    track(promise) {
      insist(phase !== 'sealed', 'WRITER_SEALED');
      const p = Promise.resolve(promise); pending.add(p);
      void p.catch((e) => { issue = e; }).finally(() => pending.delete(p)).catch(() => {}); return p;
    },
    schedule(change, ms) {
      insist(phase === 'open', 'WRITER_FENCED');
      const timer = timers.setTimeout(() => { deferred.delete(timer); if (phase === 'open') api.write(change); }, ms);
      deferred.add(timer); return timer;
    },
    store(store) {
      return { get: store.get.bind(store), keys: store.keys?.bind(store), update(key, value) {
        // Async source APIs are explicitly tracked. Their completion belongs
        // to the drain and cannot be acknowledged while a promise is pending.
        let p; api.write(() => { try { p = store.update(key, value); } catch (e) { issue = e; throw e; } });
        return p?.then ? api.track(p) : p;
      } };
    },
    fs(io) {
      const guarded = Object.create(io);
      for (const name of ['mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'appendFileSync', 'rmSync'])
        guarded[name] = (...args) => api.write(() => { try { return io[name](...args); } catch (e) { issue = e; throw e; } });
      return guarded;
    },
    async quiesce(t, { closeAdmission, cancel, drain, flush, detach, releaseResources, exportState,
      readiness = () => ({ ready: true }), timeoutMs = 5000 }) {
      insist(phase === 'open', 'WRITER_FENCED');
      insist(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000, 'QUIESCENCE_TIMEOUT_INVALID');
      member = owner.participant(member.lease);
      transition = t; phase = 'quiescing';
      try {
        closeAdmission();
        for (const timer of deferred) timers.clearTimeout(timer); deferred.clear();
      } catch (e) { phase = 'sealed'; throw e; }
      let timer, expired = false;
      const deadline = Date.now() + timeoutMs;
      const work = async () => {
        const ready = await readiness(); insist(ready?.ready === true, ready?.code || 'UNSAFE_UPDATE');
        await cancel(); await drain();
        while (pending.size) await Promise.all([...pending]);
        await flush();
        while (pending.size) await Promise.all([...pending]);
        await detach();
        insist(typeof releaseResources === 'function', 'RESOURCE_RELEASE_UNPROVEN');
        const released = await releaseResources();
        insist(released?.released === true && Array.isArray(released.owned), 'RESOURCE_RELEASE_UNPROVEN');
        // No async writer can be outstanding when the gate becomes sealed.
        insist(phase === 'quiescing' && !issue && pending.size === 0 && deferred.size === 0, 'QUIESCENCE_INCOMPLETE');
        owner.assertWriter(member.lease, member.generation, options());
        phase = 'sealed';
        const state = await exportState();
        insist(!expired, 'SOURCE_UNRESPONSIVE');
        const ack = { lease: member.lease, generation: member.generation, quiescent: true, exported: true, sealed: true,
          resourcesReleased: true, resourcesHash: hash(released), deadline, hash: hash(state) };
        await owner.acknowledge(t, member.id, ack); return { member: clone(member), state, ack };
      };
      try {
        return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => {
          expired = true; phase = 'sealed'; reject(Object.assign(fail('SOURCE_UNRESPONSIVE', 'Source did not quiesce within its bound'),
            { blockers: [{ id: member.id, build: member.build, code: 'SOURCE_UNRESPONSIVE' }] }));
        }, timeoutMs); })]);
      } catch (e) { phase = 'sealed'; throw e; }
      finally { clearTimeout(timer); }
    },
    async reopenAfterAbort() {
      const recovered = await owner.recover();
      insist(recovered.transition?.token === transition && recovered.transition.phase === 'aborted' &&
        recovered.owner.generation === member.generation, 'ABORT_UNPROVEN');
      owner.assertWriter(member.lease, member.generation); transition = null; phase = 'open';
    }
  };
  return api;
}

async function exportContext({ context, engine, settings, provenance, globalKeys = GLOBAL_KEYS, workspaceKeys = WORKSPACE_KEYS,
  secrets, secretKeys = SECRET_KEYS, files = {}, authority = null, keeper = { metaVersion: 1, runs: [] }, completeAuthority = false }) {
  insist(context?.globalState && context.workspaceState && provenance && ['profile', 'workspace', 'rawScope'].every((k) => typeof provenance[k] === 'string'), 'EXPORT_INVALID');
  insist(!engine.ledger?.pending, 'EXPORT_LEDGER_UNFLUSHED');
  const inventory = {};
  const collect = async (store, declared, area, omissions = {}) => {
    insist(Array.isArray(declared) && new Set(declared).size === declared.length && declared.every((k) => typeof k === 'string' &&
      !['__proto__', 'constructor', 'prototype'].includes(k)), 'EXPORT_INVENTORY_INCOMPLETE');
    const keys = typeof store.keys === 'function' ? store.keys() : declared;
    insist(Array.isArray(keys) && keys.every((k) => declared.includes(k) || Object.hasOwn(omissions, k)), 'EXPORT_INVENTORY_INCOMPLETE');
    inventory[area] = keys.map((key) => ({ key, disposition: Object.hasOwn(omissions, key) ? omissions[key] : 'authoritative' }));
    const values = {};
    for (const key of declared) { const value = await store.get(key); if (value !== undefined) values[key] = clone(value); }
    return values;
  };
  const global = await collect(context.globalState, globalKeys, 'global', GLOBAL_OMISSIONS), workspace = await collect(context.workspaceState, workspaceKeys, 'workspace');
  const secretValues = secrets ? await collect(secrets, secretKeys, 'secrets') : {};
  for (const key of ['nikui.identity', 'nikui.vapid']) if (Object.hasOwn(global, key)) {
    insist(!Object.hasOwn(secretValues, key) || hash(secretValues[key]) === hash(global[key]), 'EXPORT_IDENTITY_CONFLICT');
    secretValues[key] = global[key]; delete global[key];
  }
  const fileValues = {};
  for (const [name, read] of Object.entries(files)) {
    insist(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(name) && typeof read === 'function', 'EXPORT_INVALID');
    fileValues[name] = clone(await read());
  }
  const instances = [...engine.manager.list, ...engine.codex.list].map((s) => ({ ...selectedMeta(s),
    queue: clone(s.queue || []) })); // full text, sent, snippets, attachments; no slimQueued
  const queues = instances.map((s) => ({ instance: s.id, items: s.queue, hash: hash(s.queue) }));
  const authorityState = authority ? authority.snapshot() : null;
  if (authorityState) validateState(authorityState, LIMITS);
  insist(!completeAuthority || authorityState !== null, 'EXPORT_AUTHORITY_INCOMPLETE');
  const folders = { folders: clone(engine.folders.list()), assign: clone(engine.folders.assign), byConversation: clone(engine.folders.byConversation) };
  const data = { version: 1, provenance: clone(provenance), global, workspace, secrets: secretValues, files: fileValues,
    settings: clone(settings), inventory, instances, queues, folders, ledger: clone(engine.ledger?.data || { version: 1, instances: {} }),
    account: { limits: clone(engine.manager.limits), pause: clone(engine.manager.pause), limitOverride: engine.manager.limitOverride },
    authority: authorityState, completeAuthority, keeper: clone(keeper), omitted: clone(OMITTED) };
  return JSON.parse(JSON.stringify(data));
}

function mergeLedger(sources) {
  const instances = {};
  for (const source of sources) for (const [id, row] of Object.entries(source.state.ledger.instances)) {
    insist(!['__proto__', 'prototype', 'constructor'].includes(id), 'EXPORT_INVALID');
    for (const key of ['cost', 'tokens', 'turns', 'firstAt', 'lastAt']) insist(row[key] === undefined || Number.isFinite(row[key]) && row[key] >= 0, 'EXPORT_INVALID');
    const old = instances[id];
    if (!old) { instances[id] = clone(row); continue; }
    for (const k of ['cwd', 'claudeSessionId']) insist(!old[k] || !row[k] || old[k] === row[k], 'EXPORT_INSTANCE_CONFLICT');
    const merged = { ...clone(row), ...old };
    for (const k of ['cost', 'tokens', 'turns', 'lastAt']) if (old[k] !== undefined || row[k] !== undefined) merged[k] = Math.max(old[k] || 0, row[k] || 0);
    if (old.firstAt !== undefined || row.firstAt !== undefined) merged.firstAt = Math.min(...[old.firstAt, row.firstAt].filter((v) => v !== undefined));
    instances[id] = merged;
  }
  return { version: 1, instances };
}

function buildTransfer(transition, sources) {
  insist(sources.length === transition.sources.length && sources.length > 0 && new Set(sources.map((s) => s.member.id)).size === sources.length, 'EXPORT_INVENTORY_INCOMPLETE');
  const identities = new Set(), vapids = new Set(), authorities = new Set(), instances = new Map(), folders = new Map();
  for (const s of sources) {
    const expected = transition.sources.find((m) => m.id === s.member.id);
    insist(expected && hash(expected) === hash(s.member) && s.ack.hash === hash(s.state) && s.ack.generation === transition.generation &&
      s.ack.sealed === true && s.ack.quiescent === true && s.ack.exported === true && s.ack.resourcesReleased === true, 'EXPORT_INVALID');
    insist(s.state.provenance.profile === transition.scope.profile && s.member.scope.root === transition.scope.root, 'EXPORT_SCOPE_CONFLICT');
    insist(s.state.version === 1 && Array.isArray(s.state.instances) && Array.isArray(s.state.queues) &&
      s.state.folders && Array.isArray(s.state.folders.folders) && s.state.ledger?.instances && s.state.inventory && s.state.settings &&
      typeof s.state.completeAuthority === 'boolean', 'EXPORT_INVALID');
    insist(new Set(s.state.instances.map((i) => i.id)).size === s.state.instances.length &&
      s.state.instances.every((i) => typeof i.id === 'string' && i.id && path.isAbsolute(i.cwd || '') && Array.isArray(i.queue)), 'EXPORT_INVALID');
    insist(s.state.queues.length === s.state.instances.length && s.state.queues.every((q) =>
      s.state.instances.some((i) => i.id === q.instance && hash(i.queue) === hash(q.items))), 'EXPORT_QUEUE_HASH');
    validateKeeperExport(s.state);
    for (const instance of s.state.instances) {
      const identity = { ...instance };
      for (const k of ['totalCost', 'usage', 'turns', 'errors', 'interrupts', 'compactions']) delete identity[k];
      insist(!instances.has(instance.id) || instances.get(instance.id) === hash(identity), 'EXPORT_INSTANCE_CONFLICT');
      instances.set(instance.id, hash(identity));
    }
    for (const folder of s.state.folders.folders) {
      insist(typeof folder.id === 'string' && folder.id && typeof folder.name === 'string' &&
        (!folders.has(folder.id) || folders.get(folder.id) === hash(folder)), 'EXPORT_FOLDER_CONFLICT');
      folders.set(folder.id, hash(folder));
    }
    insist(!s.state.completeAuthority || s.state.authority, 'EXPORT_AUTHORITY_INCOMPLETE');
    if (s.state.authority) { validateState(s.state.authority, LIMITS); authorities.add(hash(s.state.authority)); }
    if (s.state.secrets['nikui.identity']) identities.add(hash(s.state.secrets['nikui.identity']));
    if (s.state.secrets['nikui.vapid']) vapids.add(hash(s.state.secrets['nikui.vapid']));
    for (const q of s.state.queues) insist(q.hash === hash(q.items), 'EXPORT_QUEUE_HASH');
  }
  insist(identities.size <= 1 && vapids.size <= 1, 'EXPORT_IDENTITY_CONFLICT');
  insist(authorities.size <= 1, 'EXPORT_AUTHORITY_CONFLICT');
  const value = { version: 1, purpose: 'synthetic-p2-transfer', transition: transition.token, sourceGeneration: transition.generation,
    generation: transition.generation + 1, from: transition.from, to: transition.to, target: transition.target,
    scope: clone(transition.scope), sources: clone(sources), ledger: mergeLedger(sources) };
  return { value, hash: hash(value) };
}

function validateTransfer(envelope) {
  try {
  const v = envelope?.value;
  insist(v?.version === 1 && v.purpose === 'synthetic-p2-transfer' && envelope.hash === hash(v) &&
    /^[a-f0-9]{32}$/.test(v.transition) && Number.isSafeInteger(v.sourceGeneration) && v.generation === v.sourceGeneration + 1 &&
    ['window', 'service'].includes(v.from) && ['window', 'service'].includes(v.to) && v.to !== v.from &&
    Array.isArray(v.sources) && v.sources.length > 0, 'IMPORT_INVALID');
  const rebuilt = buildTransfer({ token: v.transition, generation: v.sourceGeneration, from: v.from, to: v.to,
    target: v.target, scope: v.scope, sources: v.sources.map((s) => s.member) }, v.sources);
  insist(rebuilt.hash === envelope.hash, 'IMPORT_INVALID');
  return v;
  } catch (e) {
    if (/^(?:IMPORT_|EXPORT_|KEEPER_)/.test(e.code || '')) throw e;
    throw fail('IMPORT_INVALID', 'The synthetic transfer envelope is invalid');
  }
}

function validateKeeperExport(state) {
  const keeper = state.keeper;
  insist(keeper?.metaVersion === 1, 'KEEPER_META_UNSUPPORTED');
  insist(Array.isArray(keeper.runs), 'KEEPER_META_INCOMPLETE');
  for (const run of keeper.runs) {
    insist(require('./engineHandoff').validRunDescription(run), 'KEEPER_META_INCOMPLETE');
    if (run.exit) continue;
    insist(run.meta && run.meta.instance === run.key && path.isAbsolute(run.meta.cwd || '') &&
      (run.meta.conversation === null || typeof run.meta.conversation === 'string' && !!run.meta.conversation), 'KEEPER_META_INCOMPLETE');
  }
  for (const instance of state.instances.filter((s) => s.provider !== 'codex')) {
    const matches = keeper.runs.filter((r) => !r.exit && (r.key === instance.id || instance.claudeSessionId && r.meta.conversation === instance.claudeSessionId));
    if (!matches.length) {
      // Unknown live conversation metadata cannot prove global absence.
      insist(!instance.claudeSessionId || !keeper.runs.some((r) => !r.exit && r.meta.conversation === null), 'KEEPER_META_INCOMPLETE');
      continue;
    }
    insist(matches.length === 1 && matches[0].key === instance.id, 'KEEPER_CONVERSATION_LIVE');
    require('./engineHandoff').transferredRun({ hello: keeper, runs: keeper.runs, transferred: keeper.transferred || [],
      requested: { instance: instance.id, cwd: instance.cwd, conversation: instance.claudeSessionId || null } });
  }
}

function restoreAuthority(state, complete) {
  if (!state) return null;
  validateState(state, LIMITS);
  const next = clone(state);
  if (complete) return next;
  next.scope = crypto.randomBytes(16).toString('hex');
  for (const q of next.outbox) if (!['completed', 'rejected', 'discarded'].includes(q.state)) {
    q.state = 'unknown';
    if (q.operationBudget !== undefined) { q.revision++; q.at = next.clockHighWater;
      q.error = { code: 'OUTCOME_UNKNOWN', message: 'Incomplete handback requires reconciliation', retryable: false };
      require('./jsonlAuthority').reserveOperation(q); }
  }
  for (const r of next.entries) if (r.phase !== 'completed' || r.outcome === 'unknown') {
    r.phase = 'completed'; r.outcome = 'unknown'; r.result = null; r.reservedResultBytes = 0;
    r.error = { code: 'OUTCOME_UNKNOWN', message: 'Incomplete handback requires reconciliation', retryable: false };
  }
  validateState(next, LIMITS); return next;
}

function createSyntheticImporter({ root, target, owner, testOnly = false, activate = () => {} }) {
  insist(testOnly === true, 'PRODUCTION_CUTOVER_DISABLED');
  insist(typeof target === 'string' && target.length > 0 && !target.includes('\0') && typeof activate === 'function', 'IMPORT_TARGET_REQUIRED');
  const paths = privateRoot(root), file = path.join(paths.root, 'inactive-import.json');
  function locked(change) {
    const lock = file + '.lock'; let fd;
    try { fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw fail('IMPORT_BUSY', 'Another importer owns this target'); throw e; }
    const stat = fs.fstatSync(fd);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); return change(); }
    finally { fs.closeSync(fd); const current = privateFile(lock, { optional: true });
      if (current?.ino === stat.ino && current.dev === stat.dev) fs.unlinkSync(lock); }
  }
  const read = () => {
    if (!privateFile(file, { optional: true })) return { version: 1, target, receipts: [], state: null };
    let saved; try { saved = readPrivateJson(file); } catch (_) { throw fail('IMPORT_CORRUPT', 'Inactive import is corrupt'); }
    try {
      insist(saved?.version === 1 && saved.target === target && Array.isArray(saved.receipts) &&
        new Set(saved.receipts.map((r) => r.id)).size === saved.receipts.length && saved.receipts.every((r) =>
          /^[a-f0-9]{32}$/.test(r.id) && /^[a-f0-9]{64}$/.test(r.hash) && r.receipt?.version === 1 &&
          r.receipt.id === r.id && r.receipt.hash === r.hash && r.receipt.target === target && r.receipt.root === paths.root &&
          Number.isSafeInteger(r.receipt.generation) && r.receipt.generation > 0 && r.receipt.inactive === true &&
          ['inactive', 'reserved', 'started'].includes(r.activation) &&
          (r.activation === 'inactive' || /^[a-f0-9]{32}$/.test(r.member?.lease) && r.member.generation === r.receipt.generation)), 'IMPORT_CORRUPT');
      if (saved.state !== null) {
        const record = saved.receipts.find((r) => r.id === saved.state?.transfer?.transition);
        insist(record && Array.isArray(saved.state.sources) && saved.state.ledger?.instances, 'IMPORT_CORRUPT');
        validateTransfer({ value: saved.state.transfer, hash: record.hash });
        if (saved.state.authority) validateState(saved.state.authority, LIMITS);
      }
    } catch (_) { throw fail('IMPORT_CORRUPT', 'Inactive import state or receipts are invalid'); }
    return saved;
  };
  return {
    file,
    import(envelope) {
      return locked(() => {
      const v = validateTransfer(envelope), saved = read();
      insist(v.target === target && v.scope.root !== paths.root, 'IMPORT_SCOPE_CONFLICT');
      const old = saved.receipts.find((r) => r.id === v.transition);
      if (old) { insist(old.hash === envelope.hash, 'IMPORT_ID_CONFLICT'); return clone(old.receipt); }
      owner.verifyExport(envelope);
      const status = owner.status();
      insist(status.generation === v.sourceGeneration && status.admission === 'closed' && status.phase === 'exported', 'IMPORT_NOT_QUIESCENT');
      const complete = v.sources.every((s) => s.state.completeAuthority === true);
      const selectedAuthority = v.sources.find((s) => s.state.authority)?.state.authority || null;
      const authority = restoreAuthority(selectedAuthority, complete);
      const receipt = { version: 1, id: v.transition, hash: envelope.hash, root: paths.root, target, generation: v.generation, inactive: true,
        sources: v.sources.length, instances: v.sources.reduce((n, s) => n + s.state.instances.length, 0),
        queues: v.sources.reduce((n, s) => n + s.state.queues.reduce((sum, q) => sum + q.items.length, 0), 0),
        receiptScopePreserved: complete };
      saved.state = { transfer: clone(v), sources: v.sources.map((s) => clone(s.state)), authority, ledger: clone(v.ledger) };
      saved.receipts.push({ id: v.transition, hash: envelope.hash, receipt, activation: 'inactive' }); atomicJson(file, saved); return clone(receipt);
      });
    },
    async start(id) {
      const saved = read(), record = saved.receipts.find((r) => r.id === id);
      insist(record, 'IMPORT_NOT_FOUND');
      const status = owner.status();
      insist(saved.state?.transfer.transition === id && saved.state.transfer.generation === record.receipt.generation, 'STALE_IMPORT');
      validateTransfer({ value: saved.state.transfer, hash: record.receipt.hash });
      owner.verifyExport({ value: saved.state.transfer, hash: record.receipt.hash });
      insist(status.generation === record.receipt.generation && status.by === target && status.mode === saved.state.transfer.to,
        'STALE_GENERATION');
      if (record.activation === 'started') return { ...clone(record.receipt), inactive: false };
      insist(record.activation === 'inactive', 'TARGET_START_UNKNOWN');
      const member = await owner.targetLease(id, { build: 'synthetic-target-v1', metaVersion: 1 });
      const reserved = locked(() => {
        const current = read(), item = current.receipts.find((r) => r.id === id);
        insist(current.state?.transfer.transition === id && item?.activation === 'inactive', 'TARGET_START_UNKNOWN');
        item.member = member; item.activation = 'reserved'; atomicJson(file, current); return current.state;
      });
      await activate(clone(reserved), record.receipt.generation, clone(member));
      // Reload so target changes made during activation are not overwritten.
      locked(() => { const next = read(); const item = next.receipts.find((r) => r.id === id);
        insist(next.state?.transfer.transition === id && item?.activation === 'reserved', 'TARGET_START_UNKNOWN');
        item.activation = 'started'; atomicJson(file, next); });
      return { ...clone(record.receipt), inactive: false };
    },
    mutate(change) { return locked(() => { const saved = read(), current = saved.receipts.find((r) => r.id === saved.state?.transfer.transition);
      insist(current?.activation === 'started', 'IMPORT_INACTIVE');
      const status = owner.status(); insist(status.generation === current.receipt.generation && status.by === target && status.mode === saved.state.transfer.to && status.admission === 'open', 'WRITER_FENCED');
      const transferHash = hash(saved.state.transfer);
      return owner.effect(current.member.lease, current.member.generation, () => {
        const answer = change(saved.state); insist(!answer || typeof answer.then !== 'function', 'ASYNC_WRITER_UNSUPPORTED');
        insist(hash(saved.state.transfer) === transferHash, 'IMMUTABLE_IMPORT'); atomicJson(file, saved);
      }); }); },
    member() { const saved = read(); return clone(saved.receipts.find((r) => r.id === saved.state?.transfer.transition)?.member || null); },
    snapshot: () => clone(read()),
    discard(id) { return locked(() => { const saved = read(), record = saved.receipts.find((r) => r.id === id);
      insist(!record || record.activation === 'inactive', 'IMPORT_ACTIVE');
      saved.receipts = saved.receipts.filter((r) => r.id !== id); if (saved.state?.transfer.transition === id) saved.state = null; atomicJson(file, saved); }); }
  };
}

async function runSyntheticTransfer({ owner, generation, to, target, inventory, sources, importer, hook = async () => {} }) {
  await hook('before-barrier');
  const t = await owner.begin({ generation, to, target, inventory });
  await hook('after-barrier');
  const exports = [];
  for (const source of sources) { await hook('before-export:' + source.member.id); exports.push(await source.quiesce(t.token)); await hook('after-export:' + source.member.id); }
  const envelope = buildTransfer(t, exports);
  await owner.exported(t.token, envelope.hash); await hook('after-export');
  await hook('before-import'); const receipt = await importer.import(envelope); await hook('after-import');
  await owner.imported(t.token, receipt); await hook('before-commit');
  const committed = await owner.commit(t.token); await hook('after-commit');
  await hook('before-start'); await importer.start(t.token); await hook('after-start');
  await owner.started(t.token, { generation: committed.generation, target, hash: envelope.hash, oldResourcesReleased: true });
  await hook('before-release'); await owner.release(t.token); await hook('after-release');
  return { owner: committed, envelope, receipt };
}

module.exports = { createParticipantGate, exportContext, buildTransfer, validateTransfer, mergeLedger, restoreAuthority,
  createSyntheticImporter, runSyntheticTransfer, GLOBAL_KEYS, WORKSPACE_KEYS, SECRET_KEYS, OMITTED };
