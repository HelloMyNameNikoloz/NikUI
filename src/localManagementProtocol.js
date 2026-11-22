'use strict';

// Local protocol 1 is deliberately separate from the phone protocol. These
// schemas are the contract, defined before the command implementations.
const VERSION = 1;
const string = { type: 'string', minLength: 1, maxLength: 4096 };
const name = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const id = string;
const nullableId = { anyOf: [id, { type: 'null' }] };
const generation = { anyOf: [string, { type: 'integer', minimum: 0 }] };
const choice = (...values) => ({ enum: values });
const object = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, maxItems = 1000) => ({ type: 'array', items, maxItems });
const provenance = object({ profile: string, workspace: string, rawScope: string });
const scope = choice('user', 'project', 'editor');
const menuTools = object(Object.fromEntries(['claude', 'codex', 'node', 'gh'].map((key) => [key, nullableId])));
const menuSettings = object({ revision: { type: 'integer', minimum: 0 }, tools: menuTools, codexHome: string,
  port: { type: 'integer', minimum: 0, maximum: 65535 }, bind: string });
// Existing status/fleet fields remain extensible; the fields consumed by the
// native typed client are required and validated before a success is emitted.
const menuStatus = { type: 'object', properties: {
  ok: { const: true }, root: string, generation: string, pid: { type: 'integer', minimum: 1 }, state: string,
  engine: { type: 'object', properties: { id: string, boot: string, version: string }, required: ['id', 'boot', 'version'] },
  listener: object({ host: { const: '127.0.0.1' }, port: { type: 'integer', minimum: 0, maximum: 65535 } }),
  account: { type: 'object', properties: { home: string, borrowed: { type: 'boolean' } }, required: ['home', 'borrowed'] },
  bridge: object(Object.fromEntries(['connected', 'editors', 'pendingEditorRequests'].map((key) => [key, { type: 'integer', minimum: 0 }]))),
  tools: { type: 'object', additionalProperties: { type: 'object', properties: { status: choice('resolved', 'missing'), path: nullableId,
    source: choice('configured', 'known-directory', 'login-shell-binary', 'missing') }, required: ['status', 'path', 'source'] } },
  blockers: array({ type: 'object', properties: { code: string }, required: ['code'] })
}, required: ['ok', 'root', 'generation', 'pid', 'state', 'engine', 'listener', 'account', 'bridge', 'tools', 'blockers'] };
const menuFleet = { type: 'object', properties: { type: { const: 'fleet' }, instances: array({ type: 'object' }),
  codex: array({ type: 'object' }), projects: array({ type: 'object' }) }, required: ['type', 'instances', 'codex', 'projects'] };
const desktopSnapshot = object({ engineID: string,
  events: array(object({ id: string, engineID: string, conversationID: string,
    kind: choice('needs-you', 'failed', 'turn-finished'), title: string,
    body: { type: 'string', maxLength: 160 }, createdAt: { type: 'integer', minimum: 0 } }), 128),
  pendingApprovals: array(object({ conversationID: string, requestID: string, id: string }), 4096),
  issue: nullableId });
const menuSnapshot = object({ status: menuStatus, fleet: menuFleet, browserURL: nullableId,
  settings: menuSettings, requiresRestart: { type: 'boolean' }, importBlocker: string, updateBlockers: array(string),
  desktop: desktopSnapshot }, ['status', 'fleet', 'browserURL', 'settings', 'requiresRestart', 'importBlocker', 'updateBlockers']);
const commands = Object.freeze({
  'menu.snapshot': object(),
  'tools.refresh': object(),
  'engine.settings.get': object(),
  'engine.settings.update': menuSettings,
  'session.rename': object({ id, name: { type: 'string', maxLength: 200 } }),
  'session.stop': object({ id }),
  'session.restart': object({ id, mode: choice('context', 'fresh') }),
  'session.restartAll': object(),
  'quota.resume': object(),
  'session.remove': object({ id }),
  'session.clearStopped': object(),
  'selection.cycle': object({ direction: choice('next', 'previous'), currentId: nullableId }),
  'folder.create': object({ name }),
  'folder.rename': object({ id, name }),
  'folder.delete': object({ id }),
  'folder.order': object({ ids: { ...array(id), uniqueItems: true } }),
  'folder.place': object({ id, folder: nullableId }),
  'history.list': object({ cwd: nullableId, filter: { type: 'string', maxLength: 500 }, offset: { type: 'integer', minimum: 0, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
  'history.resume': object({ conversation: id, cwd: string }),
  'history.delete': object({ conversation: id, cwd: string }),
  'device.list': object(),
  'device.rename': object({ id, name }),
  'device.grant': object({ id, control: { type: 'boolean' } }),
  'device.revoke': object({ id }),
  'device.forget': object({ id }),
  'pairing.status': object(),
  'pairing.open': object({ seconds: { type: 'integer', minimum: 1, maximum: 300 } }),
  'pairing.close': object(),
  'localClient.list': object(),
  'localClient.revoke': object({ id }),
  'localClient.forget': object({ id }),
  'network.status': object(),
  'network.start': object({ kind: choice('tailnet', 'public') }),
  'network.stop': object({ kind: choice('tailnet', 'public') }),
  'network.open': object(),
  'settings.get': object({ scope, root: nullableId }),
  'settings.update': object({ scope, root: nullableId, key: string, value: {}, provenance }),
  'project.list': object(),
  'project.save': object({ root: string, provenance }),
  'project.remove': object({ root: string }),
  'client.state.get': object(),
  'client.state.save': object({ selected: nullableId, panels: { ...array(id, 200), uniqueItems: true } }),
  'editor.request': object({ method: choice('settings', 'slack', 'ticket', 'prPicker', 'prLink', 'credentials', 'quotaConfirm', 'lidConfirm'), target: nullableId })
});
const requestSchema = Object.freeze({ $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: Object.entries(commands).map(([op, args]) => object({ type: { const: 'local:request' }, version: { const: VERSION },
    id: { type: 'string', pattern: '^[a-f0-9]{32}$' }, generation, op: { const: op }, args })) });
const boolean = { type: 'boolean' }, count = { type: 'integer', minimum: 0 }, nil = { type: 'null' };
const clientState = object({ selected: nullableId, panels: { ...array(id, 200), uniqueItems: true } });
const pairing = { anyOf: [object({ open: { const: false }, qr: nil }), object({ open: { const: true }, code: string,
  expiresAt: count, msLeft: count, link: string, appLink: string, host: nullableId, scheme: choice('http', 'https'),
  fingerprint: nullableId, laptop: string, qr: object({ text: string, appText: string }) })] };
const network = object({ action: choice('status', 'start', 'stop', 'open'), synthetic: { const: true },
  kind: choice('tailnet', 'public'), state: choice('disabled', 'running', 'stopped'), url: string }, ['action', 'synthetic']);
const dataSchemas = Object.freeze({
  'menu.snapshot': menuSnapshot,
  'tools.refresh': menuSnapshot,
  'engine.settings.get': object({ settings: menuSettings, requiresRestart: boolean }),
  'engine.settings.update': object({ settings: menuSettings, requiresRestart: boolean }),
  'session.rename': object({ id, name: string }),
  'session.stop': object({ id, retained: { const: true } }),
  'session.restart': object({ id, mode: choice('context', 'fresh') }),
  'session.restartAll': object({ ids: array(id) }),
  'quota.resume': object({ resumed: count }),
  'session.remove': object({ id, transcriptRetained: { const: true } }),
  'session.clearStopped': object({ removed: count, transcriptRetained: { const: true } }),
  'selection.cycle': object({ selected: nullableId }),
  'folder.create': object({ folder: object({ id, name }) }),
  'folder.rename': object({ id }), 'folder.delete': object({ id, instancesRetained: { const: true } }),
  'folder.order': object({ ids: { ...array(id), uniqueItems: true } }), 'folder.place': object({ id, folder: nullableId }),
  'history.list': object({ entries: array({ type: 'object', properties: { sessionId: id, file: string, title: string,
    label: string, cwd: nullableId, modified: string, mtimeMs: { type: 'number' }, size: count }, required: ['sessionId', 'file', 'label', 'cwd', 'modified'] }, 200),
    offset: count, hasMore: boolean, exhausted: boolean }),
  'history.resume': object({ id, resumed: boolean }), 'history.delete': object({ conversation: id, deleted: { const: true } }),
  'device.list': object({ devices: array(object({ id, name, control: boolean, pairedAt: count, lastSeenAt: count, fingerprint: string }, ['id', 'name', 'control'])) }),
  'device.rename': object({ id, name }), 'device.grant': object({ id, control: boolean }),
  'device.revoke': object({ id, control: { const: false } }), 'device.forget': object({ id, forgotten: { const: true } }),
  'pairing.status': pairing, 'pairing.open': pairing, 'pairing.close': pairing,
  'localClient.list': object({ clients: array(object({ id, kind: choice('local', 'editor'), revoked: boolean })) }),
  'localClient.revoke': object({ id, revoked: { const: true }, forgotten: boolean }),
  'localClient.forget': object({ id, revoked: { const: true }, forgotten: boolean }),
  'network.status': network, 'network.start': network, 'network.stop': network, 'network.open': network,
  'settings.get': object({ scope, root: nullableId, provenance, settings: array(object({ key: string,
    disposition: choice('editor-only', 'engine-user', 'machine-policy-local-only'), default: {}, explicit: boolean,
    value: {}, effective: {}, effectiveSource: object({ scope: choice('default', 'user', 'project', 'editor'), root: nullableId,
      provenance: { anyOf: [provenance, nil] } }), provenance: { anyOf: [provenance, nil] } })) }),
  'settings.update': object({ scope, root: nullableId, key: string, requiresRestart: boolean }),
  'project.list': object({ saved: array(object({ root: string, approved: { const: true }, provenance })), announced: array(string), provenance }),
  'project.save': object({ root: string, approved: { const: true } }), 'project.remove': object({ root: string }),
  'client.state.get': clientState, 'client.state.save': clientState,
  'editor.request': object({ status: choice('dispatched'), method: commands['editor.request'].properties.method,
    target: nullableId, requestId: id })
});
const resultBase = { type: { const: 'local:result' }, version: { const: VERSION },
  id: { anyOf: [{ type: 'string', pattern: '^[a-f0-9]{32}$' }, nil] }, generation };
const resultSchema = Object.freeze({ $schema: 'https://json-schema.org/draft/2020-12/schema', oneOf: [
  object({ ...resultBase, op: { anyOf: [choice(...Object.keys(commands)), nil] }, ok: { const: false },
    outcome: choice('refused', 'unavailable', 'unknown'), code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,79}$' }, data: nil }),
  ...Object.entries(dataSchemas).map(([op, data]) => object({ ...resultBase, op: { const: op }, ok: { const: true },
    outcome: { const: 'applied' }, code: nil, data }))
] });

function jsonValue(value, depth = 0) {
  if (depth > 30) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return Object.keys(value).length === value.length && value.every((v) => jsonValue(v, depth + 1));
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((k) =>
    !['__proto__', 'constructor', 'prototype'].includes(k) && jsonValue(value[k], depth + 1));
}

function matches(value, schema, depth = 0) {
  if (depth > 30) return false;
  if (schema.oneOf) return schema.oneOf.filter((s) => matches(value, s, depth + 1)).length === 1;
  if (schema.anyOf) return schema.anyOf.some((s) => matches(value, s, depth + 1));
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && !(schema.type === 'integer' ? Number.isSafeInteger(value) : type === schema.type)) return false;
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (type === 'string' && (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (type === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    if (Object.keys(value).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) return false;
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
    for (const key of Object.keys(value)) {
      const member = schema.properties?.[key];
      if (!member && schema.additionalProperties === false || member && !matches(value[key], member, depth + 1)) return false;
      if (!member && schema.additionalProperties && typeof schema.additionalProperties === 'object' && !matches(value[key], schema.additionalProperties, depth + 1)) return false;
    }
  }
  if (type === 'array' && (value.length > (schema.maxItems ?? Infinity) || schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length || schema.items && !value.every((v) => matches(v, schema.items, depth + 1)))) return false;
  return true;
}

function validateRequest(value) {
  try { return jsonValue(value) && Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024 && matches(value, requestSchema); } catch (_) { return false; }
}
function result(request, current, { ok = false, outcome = 'refused', code = null, data = null } = {}) {
  // Source APIs may return Dates (History.modified). The contract and durable
  // local receipts contain only the JSON representation that crosses the wire.
  data = JSON.parse(JSON.stringify(data));
  const value = { type: 'local:result', version: VERSION, id: /^[a-f0-9]{32}$/.test(request?.id) ? request.id : null,
    generation: current, op: Object.hasOwn(commands, request?.op || '') ? request.op : null, ok, outcome, code, data };
  if (!matches(value, resultSchema) || ok !== (outcome === 'applied') || ok && code !== null || !ok && !code) throw new Error('Invalid local result');
  return value;
}

module.exports = { VERSION, commands, dataSchemas, requestSchema, resultSchema, matches, validateRequest, result };
