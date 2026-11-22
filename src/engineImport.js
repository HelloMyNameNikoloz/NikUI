'use strict';

// P2 selected-scope context export and inactive generation storage. No window
// entrypoint imports this module; production cutover remains disabled.
const fs = require('fs');
const path = require('path');
const { privateRoot, privateFile, readPrivateJson, fail } = require('./daemonPaths');
const { atomicJson, hash } = require('./engineOwner');
const { exportContext, buildTransfer, restoreAuthority, SECRET_KEYS } = require('./engineTransfer');
const { loadIdentity, readPublicKey } = require('./identity');
const { loadVapid } = require('./push');
const { validateState, LIMITS } = require('./jsonlAuthority');
const { createDaemonConfig } = require('./daemonConfig');
const { createKeychainStore, validService } = require('./keychainStore');
const clone = (v) => structuredClone(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
const key = (v) => text(v) && !['__proto__', 'prototype', 'constructor'].includes(v);
const id = (v) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nonnegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const insist = (v, code = 'IMPORT_INVALID') => { if (!v) throw fail(code, code); };
const exactKeys = (v, keys) => object(v) && Object.keys(v).sort().join(',') === keys.slice().sort().join(',');
const SENSITIVE_GLOBAL = ['nikui.devices', 'nikui.deviceTrail'];
const SECRETS = [...SECRET_KEYS, 'nikui.identity', 'nikui.vapid'];
const STATE_KEYS = ['version', 'provenance', 'global', 'workspace', 'secrets', 'files', 'settings', 'inventory',
  'instances', 'queues', 'folders', 'ledger', 'account', 'authority', 'completeAuthority', 'keeper', 'omitted', 'selection', 'fileHashes'];

function jsonData(value) {
  let nodes = 0;
  const visit = (v, depth) => {
    insist(++nodes <= 1000000 && depth <= 80);
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v)) return;
    insist(Array.isArray(v) || object(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)));
    if (Array.isArray(v)) { for (const child of v) visit(child, depth + 1); }
    else for (const [k, child] of Object.entries(v)) { insist(key(k)); visit(child, depth + 1); }
  };
  visit(value, 0);
  insist(Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024 * 1024, 'IMPORT_CAPACITY');
}
function validateInstance(instance) {
  const fields = ['id','cwd','provider','customTitle','autoLabel','ticket','claudeSessionId','prPane','prPinned','prUrl','totalCost','usage','turnLog',
    'startedAt','turns','errors','interrupts','status','finishedAt','compactions','lastCompactedAt','cutByLimit','unread','threadId','account','codexSettings','queue'];
  insist(object(instance) && Object.keys(instance).every((k) => fields.includes(k)) && key(instance.id) && path.isAbsolute(instance.cwd || '') &&
    path.resolve(instance.cwd) === instance.cwd && (instance.provider === undefined || ['claude','codex'].includes(instance.provider)), 'EXPORT_INSTANCE_INVALID');
  for (const field of ['customTitle','autoLabel','ticket','claudeSessionId','prUrl','threadId','account'])
    insist(instance[field] === undefined || instance[field] === null || typeof instance[field] === 'string', 'EXPORT_INSTANCE_INVALID');
  for (const field of ['prPinned','cutByLimit','unread']) insist(instance[field] === undefined || typeof instance[field] === 'boolean', 'EXPORT_INSTANCE_INVALID');
  insist(instance.status === undefined || ['idle','working','waiting','done','error','stopped'].includes(instance.status), 'EXPORT_INSTANCE_INVALID');
  for (const field of ['totalCost','turns','errors','interrupts','startedAt','compactions','finishedAt','lastCompactedAt'])
    insist(instance[field] === undefined || nonnegative(instance[field]), 'EXPORT_ACCOUNTING_INVALID');
  if (instance.usage !== undefined && instance.usage !== null) insist(object(instance.usage) && Object.values(instance.usage).every(nonnegative), 'EXPORT_ACCOUNTING_INVALID');
  if (instance.turnLog !== undefined) insist(Array.isArray(instance.turnLog) && instance.turnLog.length <= 60 && instance.turnLog.every(object), 'EXPORT_ACCOUNTING_INVALID');
  if (instance.prPane !== undefined && instance.prPane !== null) insist(object(instance.prPane) &&
    Object.entries(instance.prPane).every(([k,v]) => ['open','full'].includes(k) ? typeof v === 'boolean' : k === 'width' ? nonnegative(v) : k === 'tab' && typeof v === 'string'), 'EXPORT_INSTANCE_INVALID');
  if (instance.codexSettings !== undefined) insist(object(instance.codexSettings) && instance.provider === 'codex' &&
    Object.entries(instance.codexSettings).every(([k,v]) => ['model','effort','mode'].includes(k) && typeof v === 'string' && (k !== 'mode' || ['plan','default'].includes(v))), 'EXPORT_INSTANCE_INVALID');
  validateQueue(instance.queue);
}
function selectedPins(state) {
  try {
    const store = { get: (k) => state.secrets[k] };
    for (const name of ['nikui.identity','nikui.vapid']) {
      const pair = state.secrets[name];
      insist(exactKeys(pair,['publicKey','privateKey']) && ['publicKey','privateKey'].every((k) => typeof pair[k] === 'string' &&
        Buffer.from(pair[k],'base64url').toString('base64url') === pair[k]), 'EXPORT_IDENTITY_INVALID');
    }
    const identity = loadIdentity(store, { required: true, fingerprint: state.selection.fingerprint });
    const vapid = loadVapid(store, { required: true, applicationServerKey: state.selection.applicationServerKey });
    return { fingerprint: identity.fingerprint, applicationServerKey: vapid.applicationServerKey };
  } catch (_) { throw fail('EXPORT_IDENTITY_INVALID', 'Selected host or VAPID key is missing, corrupt or mismatched'); }
}
function validateDevices(devices, trail) {
  insist(Array.isArray(devices) && devices.length <= 4096 && Array.isArray(trail) && trail.length <= 300, 'EXPORT_DELIVERY_INVALID');
  const ids = new Set(), keys = new Set(), listeners = new Set();
  for (const d of devices) {
    insist(object(d) && Object.keys(d).every((k) => ['id','name','publicKey','fingerprint','pairedAt','lastSeenAt','lastAddress','control','protection','biometric','previousFingerprint','rekeyedAt','controlChangedAt','listener','apns','push','local','pendingLocalEnrollment'].includes(k)), 'EXPORT_DELIVERY_INVALID');
    const publicKey = readPublicKey(d.publicKey);
    insist(object(d) && key(d.id) && !ids.has(d.id) && publicKey && publicKey.spki === d.publicKey && publicKey.fingerprint === d.fingerprint &&
      !keys.has(d.publicKey) && typeof d.control === 'boolean' && typeof d.name === 'string' && typeof d.biometric === 'boolean' &&
      nonnegative(d.pairedAt) && nonnegative(d.lastSeenAt) && ['software', 'keychain', 'keystore', 'strongbox', 'secure-enclave', 'unknown'].includes(d.protection), 'EXPORT_DELIVERY_INVALID');
    ids.add(d.id); keys.add(d.publicKey);
    for (const flag of ['local', 'pendingLocalEnrollment']) insist(d[flag] === undefined || typeof d[flag] === 'boolean', 'EXPORT_DELIVERY_INVALID');
    insist(d.pendingLocalEnrollment !== true || d.local !== true && d.control === false, 'EXPORT_DELIVERY_INVALID');
    for (const time of ['rekeyedAt', 'controlChangedAt']) insist(d[time] === undefined || nonnegative(d[time]), 'EXPORT_DELIVERY_INVALID');
    insist(d.lastAddress === null || typeof d.lastAddress === 'string', 'EXPORT_DELIVERY_INVALID');
    if (d.listener !== undefined) {
      insist(exactKeys(d.listener, ['hash', 'at']) && digest(d.listener.hash) && nonnegative(d.listener.at) && !listeners.has(d.listener.hash), 'EXPORT_DELIVERY_INVALID');
      listeners.add(d.listener.hash);
    }
    if (d.apns !== undefined) insist(exactKeys(d.apns, ['token', 'at']) && /^[a-f0-9]{32,200}$/.test(d.apns.token) && nonnegative(d.apns.at), 'EXPORT_DELIVERY_INVALID');
    if (d.push !== undefined) {
      let url; try { url = new URL(d.push.endpoint); } catch (_) { /* refused below */ }
      insist(exactKeys(d.push, ['endpoint', 'keys', 'at']) && url?.protocol === 'https:' && !url.username && !url.password &&
        exactKeys(d.push.keys, ['p256dh', 'auth']) && typeof d.push.keys.p256dh === 'string' && typeof d.push.keys.auth === 'string' &&
        Buffer.from(d.push.keys.p256dh, 'base64url').length === 65 && Buffer.from(d.push.keys.auth, 'base64url').length === 16 && nonnegative(d.push.at), 'EXPORT_DELIVERY_INVALID');
    }
  }
  for (const row of trail) insist(object(row) && nonnegative(row.at) && typeof row.allowed === 'boolean' && typeof row.action === 'string' &&
    (row.deviceId === null || key(row.deviceId)) && typeof row.device === 'string', 'EXPORT_DELIVERY_INVALID');
}
function validateFolders(folders) {
  insist(exactKeys(folders, ['folders', 'assign', 'byConversation']) && Array.isArray(folders.folders) && folders.folders.length <= 4096 &&
    object(folders.assign) && object(folders.byConversation), 'EXPORT_FOLDER_INVALID');
  const ids = new Set();
  for (const f of folders.folders) {
    insist(exactKeys(f, ['id', 'name']) && key(f.id) && typeof f.name === 'string' && !!f.name.trim() && !ids.has(f.id), 'EXPORT_FOLDER_INVALID'); ids.add(f.id);
  }
  for (const map of [folders.assign, folders.byConversation]) for (const [name, folder] of Object.entries(map)) {
    insist(key(name) && key(folder) && ids.has(folder), 'EXPORT_FOLDER_INVALID');
  }
}
function validateQueue(items) {
  insist(Array.isArray(items) && items.length <= 4096, 'EXPORT_QUEUE_INVALID');
  const ids = new Set();
  for (const q of items) {
    insist(object(q) && key(q.id) && !ids.has(q.id) && typeof q.text === 'string' &&
      (q.sent === undefined || q.sent === null || typeof q.sent === 'string') &&
      (q.snippets === undefined || Array.isArray(q.snippets) && q.snippets.every((s) => typeof s === 'string')) &&
      (q.attachments === undefined || Array.isArray(q.attachments)), 'EXPORT_QUEUE_INVALID');
    ids.add(q.id);
    insist(q.text.trim() || q.sent?.trim() || q.attachments?.length, 'EXPORT_QUEUE_INVALID');
    for (const attachment of q.attachments || []) insist(object(attachment) &&
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.mediaType || attachment.mime) && typeof attachment.data === 'string' &&
      !!attachment.data && Buffer.from(attachment.data, 'base64').toString('base64') === attachment.data, 'EXPORT_QUEUE_INVALID');
  }
}
function validateLedger(ledger) {
  insist(exactKeys(ledger, ['version', 'instances']) && ledger.version === 1 && object(ledger.instances), 'EXPORT_ACCOUNTING_INVALID');
  for (const [instance, row] of Object.entries(ledger.instances)) {
    insist(key(instance) && object(row), 'EXPORT_ACCOUNTING_INVALID');
    for (const name of ['cost', 'tokens', 'turns', 'firstAt', 'lastAt']) insist(row[name] === undefined || nonnegative(row[name]), 'EXPORT_ACCOUNTING_INVALID');
    insist(row.firstAt === undefined || row.lastAt === undefined || row.firstAt <= row.lastAt, 'EXPORT_ACCOUNTING_INVALID');
    for (const name of ['cwd', 'label', 'claudeSessionId']) insist(row[name] === undefined || row[name] === null || typeof row[name] === 'string', 'EXPORT_ACCOUNTING_INVALID');
  }
}
function validateSettings(settings, profile) {
  try {
    insist(object(settings) && settings.version === 1 && object(settings.user) && Array.isArray(settings.projects), 'EXPORT_SETTINGS_INVALID');
    createDaemonConfig({ ...settings, projects: [] });
    insist(new Set(settings.projects.map((p) => p.root)).size === settings.projects.length, 'EXPORT_SETTINGS_INVALID');
    for (const project of settings.projects) {
      createDaemonConfig({ version: 1, user: {}, projects: [project], root: project.root });
      insist(project.provenance.profile === profile && path.resolve(project.root) === project.root, 'EXPORT_SETTINGS_INVALID');
    }
    if (settings.provenance !== undefined) insist(object(settings.provenance) && Object.values(settings.provenance).every((p) =>
      object(p) && p.profile === profile && text(p.workspace) && text(p.rawScope)), 'EXPORT_SETTINGS_INVALID');
  } catch (_) { throw fail('EXPORT_SETTINGS_INVALID', 'Selected settings or provenance are invalid'); }
}
function validateAuthority(authority, profile) {
  try {
    validateState(authority, LIMITS);
    require('./engineState').validateImportedAuthority(authority, (settings) => validateSettings(settings, profile));
  } catch (_) { throw fail('EXPORT_AUTHORITY_INVALID', 'Selected receipt or operation authority is invalid'); }
}
function validateSource(state, scope) {
  insist(exactKeys(state, STATE_KEYS) && state.version === 1, 'EXPORT_INVALID');
  insist(exactKeys(state.provenance, ['profile', 'workspace', 'rawScope']) && state.provenance.profile === scope.profile &&
    require('./sourceWorkspace').valid(state.provenance.workspace) && text(state.provenance.rawScope), 'EXPORT_PROVENANCE_INVALID');
  insist(object(state.global) && object(state.workspace) && object(state.secrets) && object(state.files) && object(state.fileHashes) &&
    exactKeys(state.inventory, ['global', 'workspace', 'secrets']), 'EXPORT_INVENTORY_INCOMPLETE');
  const { GLOBAL_KEYS, WORKSPACE_KEYS, GLOBAL_OMISSIONS, PRESERVED, inventoryFailure } = require('./engineTransfer');
  for (const [area, allowed] of [['global', GLOBAL_KEYS.filter((k) => !['nikui.identity', 'nikui.vapid'].includes(k))], ['workspace', WORKSPACE_KEYS], ['secrets', SECRETS]]) {
    const entries = state.inventory[area], omissions = area === 'global' ? GLOBAL_OMISSIONS : {};
    if (!(Array.isArray(entries) && new Set(entries.map((e) => e.key)).size === entries.length &&
      Object.keys(state[area]).every((k) => allowed.includes(k)) && entries.filter((e) => e.disposition === 'authoritative').length === Object.keys(state[area]).length &&
      entries.every((e) => exactKeys(e, ['key', 'disposition']) && (Object.hasOwn(state[area], e.key) && e.disposition === 'authoritative' ||
        !Object.hasOwn(state[area],e.key) && (Object.hasOwn(omissions,e.key) && omissions[e.key] === e.disposition ||
          typeof e.key === 'string' && !allowed.includes(e.key) && e.disposition === PRESERVED))))) {
      throw inventoryFailure(area, [...Object.keys(state[area]), ...(Array.isArray(entries) ? entries.map((e) => e?.key) : [])], 'payload and dispositions disagree');
    }
  }
  insist(Object.keys(state.files).length === Object.keys(state.fileHashes).length && Object.entries(state.files).every(([name, value]) =>
    /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(name) && state.fileHashes[name] === hash(value)), 'EXPORT_FILE_HASH');
  insist(exactKeys(state.selection, ['fingerprint', 'applicationServerKey']) && text(state.selection.fingerprint) && text(state.selection.applicationServerKey), 'EXPORT_IDENTITY_INVALID');
  selectedPins(state);
  for (const [name, value] of Object.entries(state.secrets)) {
    if (!['nikui.identity', 'nikui.vapid'].includes(name)) insist(typeof value === 'string' && value.length > 0, 'EXPORT_SECRET_INVALID');
  }
  validateDevices(state.global['nikui.devices'] || [], state.global['nikui.deviceTrail'] || []);
  validateSettings(state.settings, scope.profile);
  const apns = state.settings.user['apns.keyFile']; insist(apns === undefined || apns === '' || path.isAbsolute(apns), 'EXPORT_SETTINGS_INVALID');
  insist(Array.isArray(state.instances) && state.instances.length <= 4096 && new Set(state.instances.map((i) => i.id)).size === state.instances.length, 'EXPORT_INSTANCE_INVALID');
  for (const instance of state.instances) validateInstance(instance);
  insist(Array.isArray(state.queues) && state.queues.length === state.instances.length && new Set(state.queues.map((q) => q.instance)).size === state.queues.length &&
    state.queues.every((q) => exactKeys(q, ['instance', 'items', 'hash']) && q.hash === hash(q.items) &&
      state.instances.some((s) => s.id === q.instance && hash(s.queue) === q.hash)), 'EXPORT_QUEUE_HASH');
  validateFolders(state.folders); validateLedger(state.ledger);
  insist(exactKeys(state.account, ['limits', 'pause', 'limitOverride']) && Number.isSafeInteger(state.account.limitOverride) && state.account.limitOverride >= 0 &&
    (state.account.limits === null || object(state.account.limits)) && (state.account.pause === null || object(state.account.pause)), 'EXPORT_ACCOUNTING_INVALID');
  insist(typeof state.completeAuthority === 'boolean' && (!state.completeAuthority || state.authority !== null), 'EXPORT_AUTHORITY_INCOMPLETE');
  if (state.authority !== null) validateAuthority(state.authority, scope.profile);
  require('./engineTransfer').requireConversations([...(state.workspace['nikui.sessions.v1'] || []).map((s) => s.id),
    ...(state.files.exportedSessionIDs || [])], state.instances,
    state.completeAuthority ? state.authority?.values[require('./engineState').DOMAIN]?.retiredInstances || [] : []);
  insist(hash(state.omitted) === hash(require('./engineTransfer').OMITTED), 'EXPORT_INVENTORY_INCOMPLETE');
}

async function exportSelectedContext(options) {
  insist(options?.selection && options.provenance, 'EXPORT_IDENTITY_INVALID');
  insist(options.keeper?.metaVersion === 1 && Array.isArray(options.keeper.runs), 'KEEPER_META_INCOMPLETE');
  const state = await exportContext({ ...options, secretKeys: SECRETS });
  state.files.exportedSessionIDs = state.instances.map((s) => s.id);
  state.selection = clone(options.selection);
  // Moved identity/VAPID are secrets; inventory describes the final payload,
  // never a stale list of the source locations that held them before export.
  state.inventory = Object.fromEntries(['global', 'workspace', 'secrets'].map((area) => [area,
    [...Object.keys(state[area]).map((key) => ({ key, disposition: 'authoritative' })),
      ...state.inventory[area].filter((e) => e.disposition !== 'authoritative')]]));
  state.fileHashes = Object.fromEntries(Object.entries(state.files).map(([name, value]) => [name, hash(value)]));
  return state;
}
function selectionFor(sources, selectedSource) {
  const chosen = sources.find((s) => s.member.id === selectedSource);
  insist(chosen, 'EXPORT_SELECTION_REQUIRED');
  const delivery = (s) => ({ devices: s.state.global['nikui.devices'] || [], trail: s.state.global['nikui.deviceTrail'] || [] });
  for (const source of sources) {
    insist(hash(source.state.selection) === hash(chosen.state.selection), 'EXPORT_IDENTITY_CONFLICT');
    insist(hash(delivery(source)) === hash(delivery(chosen)), 'EXPORT_DELIVERY_CONFLICT');
  }
  return { source: selectedSource, ...selectedPins(chosen.state), deliveryHash: hash(delivery(chosen)) };
}
function buildSelectedTransfer(transition, sources, { selectedSource } = {}) {
  jsonData(sources);
  for (const source of sources) validateSource(source.state, transition.scope);
  const envelope = buildTransfer(transition, sources);
  envelope.value.ledger = selectedLedger(sources);
  envelope.value.purpose = 'selected-p2-transfer';
  envelope.value.selection = selectionFor(sources, selectedSource);
  envelope.hash = hash(envelope.value);
  validateSelectedTransfer(envelope); return envelope;
}
function validateSelectedTransfer(envelope) {
  try {
    jsonData(envelope);
    insist(exactKeys(envelope, ['value', 'hash']) && digest(envelope.hash) && envelope.hash === hash(envelope.value), 'IMPORT_HASH_MISMATCH');
    const v = envelope.value;
    insist(exactKeys(v, ['version', 'purpose', 'transition', 'sourceGeneration', 'generation', 'from', 'to', 'target', 'scope', 'sources', 'ledger', 'selection']) &&
      v.version === 1 && v.purpose === 'selected-p2-transfer' && id(v.transition) && Number.isSafeInteger(v.sourceGeneration) && v.sourceGeneration >= 0 &&
      Number.isSafeInteger(v.generation) && v.generation === v.sourceGeneration + 1 && ['window', 'service'].includes(v.from) && ['window', 'service'].includes(v.to) &&
      v.from !== v.to && key(v.target) && exactKeys(v.scope, ['root', 'profile', 'install']) && path.isAbsolute(v.scope.root) && text(v.scope.profile) && text(v.scope.install) &&
      Array.isArray(v.sources) && v.sources.length > 0 && v.sources.length <= 64, 'IMPORT_INVALID');
    for (const source of v.sources) {
      insist(exactKeys(source, ['member', 'state', 'ack']), 'EXPORT_INVALID');
      const m = source.member, a = source.ack;
      insist(exactKeys(m, ['id', 'build', 'metaVersion', 'busy', 'scope', 'generation', 'lease', 'connected', 'role', 'revision']) && key(m.id) && text(m.build) &&
        m.metaVersion === 1 && m.busy === false && hash(m.scope) === hash(v.scope) && m.generation === v.sourceGeneration && id(m.lease) &&
        m.connected === true && m.role === 'writer' && Number.isSafeInteger(m.revision) && m.revision >= 0, 'EXPORT_PROVENANCE_INVALID');
      insist(exactKeys(a, ['lease', 'generation', 'quiescent', 'exported', 'sealed', 'resourcesReleased', 'resourcesHash', 'deadline', 'hash']) &&
        a.lease === m.lease && a.generation === m.generation && digest(a.resourcesHash) && Number.isSafeInteger(a.deadline) && a.deadline >= 0, 'EXPORT_INVALID');
      validateSource(source.state, v.scope);
    }
    const rebuilt = buildTransfer({ token: v.transition, generation: v.sourceGeneration, from: v.from, to: v.to,
      target: v.target, scope: v.scope, sources: v.sources.map((s) => s.member) }, v.sources);
    rebuilt.value.ledger = selectedLedger(v.sources);
    rebuilt.value.purpose = v.purpose;
    rebuilt.value.selection = selectionFor(v.sources, v.selection.source);
    insist(hash(rebuilt.value) === envelope.hash, 'IMPORT_INVALID');
    return v;
  } catch (e) {
    if (/^(IMPORT_|EXPORT_|KEEPER_)/.test(e.code || '')) throw e;
    throw fail('IMPORT_INVALID', 'Selected import payload is invalid');
  }
}

function partition(v) {
  const transfer = clone(v), evidence = {};
  for (const source of transfer.sources) {
    const sensitive = { secrets: source.state.secrets, global: {} };
    source.state.secrets = {};
    for (const key of SENSITIVE_GLOBAL) if (Object.hasOwn(source.state.global, key)) { sensitive.global[key] = source.state.global[key]; delete source.state.global[key]; }
    evidence[source.member.id] = sensitive;
  }
  const chosen = evidence[v.selection.source];
  return { transfer, values: { ...clone(chosen.secrets), ...clone(chosen.global),
    'nikd.selection': { fingerprint: v.selection.fingerprint, applicationServerKey: v.selection.applicationServerKey } },
    evidence: { 'nikd.importEvidence': { transition: v.transition, hash: hash(v), sources: evidence } } };
}
function rehydrate(transfer, values) {
  const v = clone(transfer), evidence = values['nikd.importEvidence'];
  insist(evidence?.transition === v.transition && digest(evidence.hash) && object(evidence.sources), 'IMPORT_SECRET_MISMATCH');
  for (const source of v.sources) {
    const sensitive = evidence.sources[source.member.id];
    insist(exactKeys(sensitive, ['secrets', 'global']) && object(sensitive.secrets) && object(sensitive.global), 'IMPORT_SECRET_MISMATCH');
    source.state.secrets = clone(sensitive.secrets); Object.assign(source.state.global, clone(sensitive.global));
  }
  // Partition deletion/reinsertion changes JS insertion order. The immutable
  // serialized payload below is reconstructed with its recorded key order.
  return v;
}
function reorder(v, template) {
  if (Array.isArray(template)) return template.map((child, i) => reorder(v[i], child));
  if (!object(template)) return v;
  const result = {};
  for (const [k, child] of Object.entries(template)) result[k] = child === '$secret' ? v[k] : reorder(v[k], child);
  return result;
}
function orderTemplate(v) {
  const t = clone(v);
  for (const source of t.sources) {
    source.state.secrets = '$secret';
    for (const k of SENSITIVE_GLOBAL) if (Object.hasOwn(source.state.global, k)) source.state.global[k] = '$secret';
  }
  return t;
}
function selectedLedger(sources) {
  const ledger = require('./engineTransfer').mergeLedger(sources);
  for (const source of sources) for (const instance of source.state.instances) {
    const usage = instance.usage || {}, tokens = ['input', 'output', 'cacheRead', 'cacheCreate'].reduce((n, k) => n + (usage[k] || 0), 0);
    if (instance.totalCost === undefined && instance.turns === undefined && !tokens) continue;
    const row = ledger.instances[instance.id] || {};
    ledger.instances[instance.id] = { ...row, cost: Math.max(row.cost || 0, instance.totalCost || 0), tokens: Math.max(row.tokens || 0, tokens),
      turns: Math.max(row.turns || 0, instance.turns || 0) };
  }
  return ledger;
}
function materialize(v) {
  const instances = new Map();
  for (const s of v.sources) for (const instance of s.state.instances) {
    const old = instances.get(instance.id);
    if (!old) { instances.set(instance.id, clone(instance)); continue; }
    for (const k of ['totalCost', 'turns', 'errors', 'interrupts', 'compactions'])
      if (old[k] !== undefined || instance[k] !== undefined) old[k] = Math.max(old[k] || 0, instance[k] || 0);
    if (old.usage || instance.usage) old.usage = Object.fromEntries([...new Set([...Object.keys(old.usage || {}), ...Object.keys(instance.usage || {})])]
      .map((k) => [k, Math.max(old.usage?.[k] || 0, instance.usage?.[k] || 0)]));
  }
  const complete = v.sources.every((s) => s.state.completeAuthority);
  const authority = restoreAuthority(v.sources.find((s) => s.state.authority)?.state.authority || null, complete);
  if (authority && !complete) authority.scope = hash({ transition: v.transition, generation: v.generation, scope: 'quarantine' }).slice(0, 32);
  return { version: 1, sources: v.sources.map((s) => ({ id: s.member.id, provenance: clone(s.state.provenance),
    workspace: clone(s.state.workspace), global: Object.fromEntries(Object.entries(s.state.global).filter(([k]) => !SENSITIVE_GLOBAL.includes(k))),
    files: clone(s.state.files), settings: clone(s.state.settings), folders: clone(s.state.folders), account: clone(s.state.account) })),
    instances: [...instances.values()], queues: [...instances.values()].map((s) => ({ instance: s.id, items: clone(s.queue), hash: hash(s.queue) })),
    ledger: selectedLedger(v.sources), authority, completeAuthority: complete };
}
function validateCurrent(state, profile) {
  insist(object(state) && state.version === 1 && Array.isArray(state.sources) && Array.isArray(state.instances) && Array.isArray(state.queues), 'IMPORT_CORRUPT');
  validateLedger(state.ledger);
  insist(new Set(state.instances.map((i) => i.id)).size === state.instances.length && state.queues.length === state.instances.length &&
    new Set(state.queues.map((q) => q.instance)).size === state.queues.length, 'IMPORT_CORRUPT');
  for (const i of state.instances) validateInstance(i);
  insist(state.queues.every((q) => q.hash === hash(q.items) && state.instances.some((i) => i.id === q.instance && hash(i.queue) === q.hash)), 'IMPORT_CORRUPT');
  for (const source of state.sources) { validateFolders(source.folders); validateSettings(source.settings, profile); }
  if (state.authority) validateAuthority(state.authority, profile);
}

function createGenerationImporter({ root, target, owner, secretAdapter, testOnly = false, activate = () => {}, fault = () => {}, maxImports = 512 } = {}) {
  insist(testOnly === true, 'PRODUCTION_CUTOVER_DISABLED');
  return createSelectedImporter({ root, target, owner, secretAdapter, activate, fault, maxImports });
}
function createSelectedImporter({ root, target, owner, secretAdapter, activate = () => {}, fault = () => {}, maxImports = 512 } = {}) {
  insist(Number.isSafeInteger(maxImports) && maxImports > 0 && maxImports <= 512, 'IMPORT_CAPACITY');
  insist(key(target) && owner && secretAdapter && typeof activate === 'function', 'IMPORT_TARGET_REQUIRED');
  insist(validService(secretAdapter.service) &&
    secretAdapter.backend === 'login-file-keychain', 'KEYCHAIN_NAMESPACE');
  const paths = privateRoot(root), file = path.join(paths.root, 'generation-import.json');
  const accountFor = (transition) => 'generation.' + transition;
  const evidenceFor = (transition) => 'evidence.' + transition;
  const activeStores = new Map();
  const empty = () => ({ version: 1, target, current: null, records: [] });
  function locked(fn) {
    const lock = file + '.lock'; let fd;
    try { fd = require('./privateLock').open(lock); }
    catch (e) { if (e.code === 'EEXIST') throw fail('IMPORT_BUSY', 'Another importer owns this generation'); throw e; }
    const stat = fs.fstatSync(fd);
    try { return fn(); }
    finally { fs.closeSync(fd); const st = privateFile(lock, { optional: true }); if (st?.ino === stat.ino && st.dev === stat.dev) fs.unlinkSync(lock); }
  }
  function read() {
    if (!privateFile(file, { optional: true })) return empty();
    try {
      const saved = readPrivateJson(file);
      insist(exactKeys(saved, ['version', 'target', 'current', 'records']) && saved.version === 1 && saved.target === target && Array.isArray(saved.records) && saved.records.length <= maxImports &&
        (saved.current === null || id(saved.current)) && new Set(saved.records.map((r) => r.id)).size === saved.records.length, 'IMPORT_CORRUPT');
      for (const r of saved.records) insist(id(r.id) && digest(r.hash) && r.account === accountFor(r.id) && r.evidenceAccount === evidenceFor(r.id) && digest(r.secretHash) && digest(r.runtimeHash) &&
        r.service === secretAdapter.service && r.backend === secretAdapter.backend && ['preparing', 'inactive', 'reserved', 'started', 'discarding', 'discarded'].includes(r.phase) &&
        r.receipt?.id === r.id && r.receipt.hash === r.hash && r.receipt.target === target && r.receipt.root === paths.root && r.receipt.inactive === true &&
        Number.isSafeInteger(r.receipt.generation) && r.receipt.generation > 0 && r.receipt.version === 1 &&
        (r.phase !== 'reserved' && r.phase !== 'started' || id(r.member?.lease) && r.member.generation === r.receipt.generation), 'IMPORT_CORRUPT');
      insist(saved.current === null || saved.records.some((r) => r.id === saved.current && r.phase !== 'discarded'), 'IMPORT_CORRUPT');
      return saved;
    } catch (_) { throw fail('IMPORT_CORRUPT', 'Generation manifest or receipts are corrupt'); }
  }
  function storeValues(account) {
    const store = createKeychainStore({ adapter: secretAdapter, account });
    try { return Object.fromEntries(store.keys().map((k) => [k, store.get(k)])); } finally { store.dispose(); }
  }
  function secrets(r) {
    const store = createKeychainStore({ adapter: secretAdapter, account: r.evidenceAccount });
    try {
      const values = Object.fromEntries(store.keys().map((k) => [k, store.get(k)]));
      insist(hash(values) === r.secretHash, 'IMPORT_SECRET_MISMATCH'); return values;
    } finally { store.dispose(); }
  }
  function verified(r) {
    const values = secrets(r), v = reorder(rehydrate(r.transfer, values), r.template);
    insist(values['nikd.importEvidence'].hash === r.hash && hash(partition(v).transfer) === hash(r.transfer) && hash(orderTemplate(v)) === hash(r.template), 'IMPORT_SECRET_MISMATCH');
    validateSelectedTransfer({ value: v, hash: r.hash });
    insist(hash(r.receipt) === hash(receiptFor(v, r.hash)), 'IMPORT_CORRUPT');
    const runtime = storeValues(r.account);
    if (['preparing','inactive'].includes(r.phase)) insist(hash(runtime) === r.runtimeHash, 'IMPORT_SECRET_MISMATCH');
    selectedPins({ secrets: runtime, selection: v.selection });
    insist(hash(runtime['nikd.selection']) === hash({ fingerprint: v.selection.fingerprint, applicationServerKey: v.selection.applicationServerKey }), 'IMPORT_SECRET_MISMATCH');
    validateDevices(runtime['nikui.devices'] || [], runtime['nikui.deviceTrail'] || []);
    insist(hash(r.initial) === r.initialHash && r.initialHash === hash(materialize(v)), 'IMPORT_CORRUPT');
    if (['preparing', 'inactive', 'reserved'].includes(r.phase)) insist(hash(r.state) === r.initialHash, 'IMPORT_CORRUPT');
    validateCurrent(r.state, v.scope.profile);
    return { v, values };
  }
  function receiptFor(v, envelopeHash) {
    const unique = new Map(v.sources.flatMap((s) => s.state.instances.map((i) => [i.id, i])));
    return { version: 1, id: v.transition, hash: envelopeHash, root: paths.root, target, generation: v.generation, inactive: true,
      sources: v.sources.length, instances: unique.size, queues: [...unique.values()].reduce((n, i) => n + i.queue.length, 0),
      receiptScopePreserved: v.sources.every((s) => s.state.completeAuthority), storage: 'keychain-generation-v1',
      namespace: { service: secretAdapter.service, backend: secretAdapter.backend, account: accountFor(v.transition), evidenceAccount: evidenceFor(v.transition) } };
  }
  const api = {
    file, secretAdapter,
    async openCommitted({ writerOptions = () => ({}) } = {}) {
      // Runtime construction has no provider effects. The daemon's exclusive
      // root lock and receipt dispatcher recovery protect subsequent starts;
      // the immutable import is never replayed over its current authority.
      const saved = read(), record = saved.records.find((r) => r.id === saved.current);
      insist(record && ['inactive', 'reserved', 'started'].includes(record.phase), 'IMPORT_INACTIVE');
      const { v } = verified(record), status = owner.status();
      insist(status.generation === v.generation && status.mode === v.to && status.by === target, 'SERVICE_OWNERSHIP_REQUIRED');
      owner.assertWriter(record.member?.lease, v.generation);
      const store = createKeychainStore({ adapter: secretAdapter, account: record.account });
      const guarded = { ...store, update(key, value) {
        return owner.effect(record.member.lease, record.member.generation, () => store.update(key, value), writerOptions());
      }, async store(key, value) { return guarded.update(key, value); }, async delete(key) { return guarded.update(key, undefined); } };
      activeStores.set(record.id, store);
      return { state: clone(record.state), receipt: clone(record.receipt), member: clone(record.member), store: guarded, transfer: v };
    },
    async commitRuntimeMember(transition) {
      const member = await owner.targetLease(transition, { build: 'production-runtime-v1', metaVersion: 1 });
      return locked(() => {
        const saved = read(), record = saved.records.find((r) => r.id === transition);
        insist(record && ['inactive', 'reserved', 'started'].includes(record.phase), 'IMPORT_INACTIVE');
        verified(record); record.member = clone(member); record.phase = 'started'; atomicJson(file, saved); return clone(member);
      });
    },
    import(envelope) {
      const v = validateSelectedTransfer(envelope);
      insist(v.target === target && v.scope.root !== paths.root, 'IMPORT_SCOPE_CONFLICT');
      return locked(() => {
        const saved = read(), old = saved.records.find((r) => r.id === v.transition);
        if (old) {
          insist(old.hash === envelope.hash, 'IMPORT_ID_CONFLICT');
          insist(!['discarding', 'discarded'].includes(old.phase), 'IMPORT_DISCARDED');
          if (old.phase !== 'preparing') { verified(old); return clone(old.receipt); }
        }
        owner.verifyExport(envelope);
        const status = owner.status();
        insist(status.generation === v.sourceGeneration && status.admission === 'closed' && status.phase === 'exported', 'IMPORT_NOT_QUIESCENT');
        const prior = saved.records.find((r) => r.id === saved.current);
        insist(!saved.current || saved.current === v.transition || prior?.phase === 'discarded' ||
          prior?.phase === 'started' && prior.receipt.generation < v.sourceGeneration && status.by !== target, 'IMPORT_TARGET_OCCUPIED');
        const split = partition(v), initial = materialize(v), receipt = receiptFor(v, envelope.hash);
        const record = old || { id: v.transition, hash: envelope.hash, account: accountFor(v.transition), service: secretAdapter.service,
          backend: secretAdapter.backend, evidenceAccount: evidenceFor(v.transition), secretHash: hash(split.evidence), runtimeHash: hash(split.values), transfer: split.transfer, template: orderTemplate(v),
          initial, initialHash: hash(initial), state: clone(initial), receipt, phase: 'preparing' };
        if (old) insist(hash(old.transfer) === hash(split.transfer) && hash(old.template) === hash(orderTemplate(v)) &&
          old.secretHash === hash(split.evidence) && old.runtimeHash === hash(split.values) && hash(old.receipt) === hash(receipt) &&
          old.initialHash === hash(initial) && hash(old.state) === hash(initial), 'IMPORT_CORRUPT');
        if (!old) { insist(saved.records.length < maxImports, 'IMPORT_CAPACITY'); saved.records.push(record); saved.current = v.transition; atomicJson(file, saved); }
        fault('import:prepared');
        // Deterministic account + add-only staging permits recovery after a
        // crash at either side of SecItemAdd without overwriting another item.
        for (const [account, values, expectedHash] of [[record.evidenceAccount, split.evidence, record.secretHash], [record.account, split.values, record.runtimeHash]]) {
          const existing = secretAdapter.read(account);
          if (existing === null) {
            const store = createKeychainStore({ adapter: secretAdapter, account, create: true, initial: values }); store.dispose();
          } else insist(hash(storeValues(account)) === expectedHash, 'IMPORT_SECRET_MISMATCH');
          fault(account === record.evidenceAccount ? 'import:evidence' : 'import:runtime');
        }
        fault('import:secrets'); verified(record);
        record.phase = 'inactive'; atomicJson(file, saved); fault('import:inactive');
        return clone(record.receipt);
      });
    },
    verifyInactive(receipt) {
      return locked(() => {
        const saved = read(), record = saved.records.find((r) => r.id === receipt?.id);
        insist(saved.current === receipt?.id && record?.phase === 'inactive' && hash(record.receipt) === hash(receipt), 'IMPORT_REVALIDATION_REQUIRED');
        const { v } = verified(record); owner.verifyExport({ value: v, hash: record.hash }); return true;
      });
    },
    commit(transition, { verifyFence = () => {} } = {}) {
      return owner.commit(transition, { verifyImport: (receipt) => { verifyFence(); return api.verifyInactive(receipt); } });
    },
    async start(transition) {
      const reserved = await (async () => {
        const saved = read(), record = saved.records.find((r) => r.id === transition);
        insist(record && saved.current === transition, 'IMPORT_NOT_FOUND');
        insist(!['preparing', 'discarding', 'discarded'].includes(record.phase), 'IMPORT_INACTIVE');
        const { v } = verified(record); owner.verifyExport({ value: v, hash: record.hash });
        const status = owner.status();
        insist(status.generation === v.generation && status.mode === v.to && status.by === target, 'STALE_GENERATION');
        if (record.phase === 'started') return { already: true, receipt: record.receipt };
        insist(record.phase === 'inactive', 'TARGET_START_UNKNOWN');
        const member = await owner.targetLease(transition, { build: 'selected-generation-v1', metaVersion: 1 });
        return locked(() => {
          const current = read(), item = current.records.find((r) => r.id === transition);
          insist(current.current === transition && item?.phase === 'inactive', 'TARGET_START_UNKNOWN');
          verified(item); item.member = member; item.phase = 'reserved'; atomicJson(file, current); fault('start:reserved');
          return { state: clone(item.state), receipt: clone(item.receipt), member: clone(member), account: item.account };
        });
      })();
      if (reserved.already) return { ...clone(reserved.receipt), inactive: false };
      const store = createKeychainStore({ adapter: secretAdapter, account: reserved.account });
      const guarded = { ...store, update(key, value) {
        return owner.effect(reserved.member.lease, reserved.member.generation, () => store.update(key, value));
      }, async store(key, value) { return guarded.update(key, value); }, async delete(key) { return guarded.update(key, undefined); } };
      try { await activate(reserved.state, reserved.receipt.generation, clone(reserved.member), guarded); activeStores.set(transition, store); }
      catch (e) { store.dispose(); throw e; }
      fault('start:effect');
      locked(() => { const current = read(), item = current.records.find((r) => r.id === transition);
        insist(current.current === transition && item?.phase === 'reserved', 'TARGET_START_UNKNOWN');
        item.phase = 'started'; atomicJson(file, current); });
      fault('start:recorded'); return { ...clone(reserved.receipt), inactive: false };
    },
    mutate(change) {
      return locked(() => {
        const saved = read(), record = saved.records.find((r) => r.id === saved.current);
        insist(record?.phase === 'started', 'IMPORT_INACTIVE'); verified(record);
        const status = owner.status();
        insist(status.generation === record.receipt.generation && status.by === target && status.admission === 'open', 'WRITER_FENCED');
        return owner.effect(record.member.lease, record.member.generation, () => {
          const result = change(record.state); insist(!result || typeof result.then !== 'function', 'ASYNC_WRITER_UNSUPPORTED');
          validateCurrent(record.state, record.transfer.scope.profile); atomicJson(file, saved);
        });
      });
    },
    reconcileOwner(member) {
      return locked(() => {
        const saved = read(), record = saved.records.find((r) => r.id === saved.current), status = owner.status();
        insist(record?.phase === 'started' && status.generation === record.receipt.generation && status.by === target && status.admission === 'open', 'STALE_GENERATION');
        const current = owner.participant(member?.lease);
        insist(current.id === target && current.role === 'writer' && current.generation === record.receipt.generation && current.metaVersion === 1 &&
          hash(current) === hash(member), 'STALE_PARTICIPANT');
        verified(record); record.member = clone(current); atomicJson(file, saved); return clone(current);
      });
    },
    exportCurrent({ transition, provenance, keeper, currentState }) {
      const saved = read(), record = saved.records.find((r) => r.id === saved.current);
      insist(record?.phase === 'started', 'IMPORT_INACTIVE');
      insist(keeper?.metaVersion === 1 && Array.isArray(keeper.runs), 'KEEPER_META_INCOMPLETE');
      owner.assertWriter(record.member.lease, record.member.generation, { transition, drain: true });
      insist(owner.status().phase === 'barrier' && owner.status().admission === 'closed', 'IMPORT_NOT_QUIESCENT');
      const { v } = verified(record), current = currentState || record.state, runtime = storeValues(record.account);
      validateCurrent(current, v.scope.profile);
      const selected = v.sources.find((s) => s.member.id === v.selection.source).state;
      const global = clone(current.sources.find((s) => s.id === v.selection.source)?.global || selected.global), folders = { folders: [], assign: {}, byConversation: {} };
      const folderIDs = new Map();
      for (const source of current.sources) {
        for (const folder of source.folders.folders) {
          insist(!folderIDs.has(folder.id) || folderIDs.get(folder.id) === hash(folder), 'EXPORT_FOLDER_CONFLICT');
          if (!folderIDs.has(folder.id)) { folderIDs.set(folder.id, hash(folder)); folders.folders.push(clone(folder)); }
        }
        for (const area of ['assign', 'byConversation']) for (const [key, value] of Object.entries(source.folders[area])) {
          insist(!Object.hasOwn(folders[area], key) || folders[area][key] === value, 'EXPORT_FOLDER_CONFLICT'); folders[area][key] = value;
        }
      }
      for (const k of SENSITIVE_GLOBAL) if (runtime[k] !== undefined) global[k] = clone(runtime[k]); else delete global[k];
      const state = { version: 1, provenance: clone(provenance), global,
        workspace: { 'nikui.sessions.v1': clone(current.instances), 'nikui.folders.v1': folders },
        secrets: Object.fromEntries(SECRETS.filter((k) => runtime[k] !== undefined).map((k) => [k, clone(runtime[k])])),
        files: { workspaces: clone(current.sources) }, settings: clone(current.sources.find((s) => s.id === v.selection.source)?.settings || current.sources[0].settings),
        inventory: {}, instances: clone(current.instances), queues: clone(current.queues), folders,
        ledger: clone(current.ledger), account: clone(current.sources[0].account), authority: clone(current.authority), completeAuthority: current.completeAuthority,
        keeper: clone(keeper), omitted: clone(selected.omitted),
        selection: clone(runtime['nikd.selection']), fileHashes: {} };
      state.inventory = Object.fromEntries(['global', 'workspace', 'secrets'].map((area) => [area, Object.keys(state[area]).map((key) => ({ key, disposition: 'authoritative' }))]));
      state.fileHashes = Object.fromEntries(Object.entries(state.files).map(([key, value]) => [key, hash(value)]));
      validateSource(state, v.scope); return state;
    },
    snapshot() { const saved = read(); for (const r of saved.records) if (!['preparing', 'discarding', 'discarded'].includes(r.phase)) verified(r); return clone(saved); },
    dispose() { for (const store of activeStores.values()) store.dispose(); activeStores.clear(); },
    member() { const saved = read(); return clone(saved.records.find((r) => r.id === saved.current)?.member || null); },
    recover() {
      return locked(() => {
        const saved = read(), record = saved.records.find((r) => r.id === saved.current);
        if (!record) return { action: 'empty' };
        if (record.phase === 'discarding') return owner.transitionEffect(record.id, ['exported','imported'], () => {
          insist(owner.status().generation === record.receipt.generation - 1, 'STALE_GENERATION');
          secretAdapter.delete(record.account); secretAdapter.delete(record.evidenceAccount); record.phase = 'discarded'; saved.current = null; atomicJson(file, saved); return { action: 'discarded' }; });
        if (record.phase === 'preparing') return { action: 'reimport-required', id: record.id };
        verified(record);
        const status = owner.status();
        if (status.generation < record.receipt.generation) return { action: 'remain-inactive', id: record.id };
        insist(status.generation === record.receipt.generation && status.by === target, 'STALE_GENERATION');
        return { action: record.phase === 'reserved' ? 'reconcile-required' : record.phase === 'started' ? 'started' : 'recover-target', id: record.id };
      });
    },
    discard(transition) {
      return locked(() => {
        const saved = read(), record = saved.records.find((r) => r.id === transition);
        if (!record || record.phase === 'discarded') return;
        insist(['preparing', 'inactive', 'discarding'].includes(record.phase), 'IMPORT_ACTIVE');
        return owner.transitionEffect(transition, ['exported','imported'], () => {
          const status = owner.status();
          insist(status.generation === record.receipt.generation - 1 && status.admission === 'closed', 'STALE_GENERATION');
          record.phase = 'discarding'; atomicJson(file, saved); fault('discard:prepared');
          secretAdapter.delete(record.account); fault('discard:runtime');
          secretAdapter.delete(record.evidenceAccount); fault('discard:secrets');
          record.phase = 'discarded'; if (saved.current === transition) saved.current = null; atomicJson(file, saved);
        });
      });
    },
    cleanupReturned() {
      return locked(() => {
        const status = owner.status();
        insist(status.mode === 'window' && status.admission === 'open' && status.phase === 'released', 'RETURN_NOT_RELEASED');
        const saved = read();
        for (const record of saved.records) {
          insist(record.receipt.generation <= status.generation, 'STALE_GENERATION');
          if (record.phase === 'discarded') continue;
          record.phase = 'discarding'; atomicJson(file, saved);
          secretAdapter.delete(record.account); secretAdapter.delete(record.evidenceAccount);
          record.phase = 'discarded'; if (saved.current === record.id) saved.current = null;
          atomicJson(file, saved);
        }
      });
    }
  };
  return api;
}
module.exports = { exportSelectedContext, buildSelectedTransfer, validateSelectedTransfer, validateSource, createGenerationImporter, createSelectedImporter, materialize };
