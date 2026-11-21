'use strict';

// Test-only corpus reader. This validates fixture consistency, not a v2 runtime.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '../..');
const DIRECTORY = path.join(ROOT, 'test/fixtures/protocol-v2');
const CORE = ['mid-ack-v1', 'receipts-v1', 'run-precondition-v1', 'operation-state-v1'];
const KEYWORDS = new Set(['$schema', '$defs', '$ref', 'title', 'description', 'type', 'const', 'enum',
  'anyOf', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum']);

class FixtureError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function insist(condition, code, message) { if (!condition) throw new FixtureError(code, message); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Write sorted key/value pairs directly: JSON.stringify(object) reorders numeric keys.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  insist(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'hash', 'Not JSON');
  return JSON.stringify(value);
}

// Dependency-free implementation of the JSON Schema keywords used by schema.json.
// Unknown keywords fail closed so adding a schema constraint cannot silently skip it.
function validateSchemaDefinition(schema) {
  for (const key of Object.keys(schema)) insist(KEYWORDS.has(key), 'schema', 'Unsupported keyword ' + key);
  for (const field of ['$defs', 'properties']) {
    for (const child of Object.values(schema[field] || {})) validateSchemaDefinition(child);
  }
  for (const child of schema.anyOf || []) validateSchemaDefinition(child);
  if (schema.items) validateSchemaDefinition(schema.items);
  if (object(schema.additionalProperties)) validateSchemaDefinition(schema.additionalProperties);
}

function validateSchema(value, schema, root, location = '$') {
  for (const key of Object.keys(schema)) insist(KEYWORDS.has(key), 'schema', location + ': unsupported keyword ' + key);
  if (schema.$ref) {
    insist(schema.$ref.startsWith('#/$defs/'), 'schema', 'Only local definition references are supported');
    const definition = root.$defs[schema.$ref.slice(8)];
    insist(definition, 'schema', 'Unknown reference ' + schema.$ref);
    validateSchema(value, definition, root, location);
  }
  if (schema.anyOf) {
    const matched = schema.anyOf.some(candidate => {
      try { validateSchema(value, candidate, root, location); return true; } catch (error) {
        if (!(error instanceof FixtureError)) throw error;
        return false;
      }
    });
    insist(matched, 'schema', location + ': no anyOf branch matched');
  }
  if ('const' in schema) insist(canonical(value) === canonical(schema.const), 'schema', location + ': const');
  if (schema.enum) insist(schema.enum.some(candidate => canonical(value) === canonical(candidate)), 'schema', location + ': enum');
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    insist(types.some(type => ({ null: value === null, object: object(value), array: Array.isArray(value),
      string: typeof value === 'string', boolean: typeof value === 'boolean',
      integer: Number.isSafeInteger(value), number: typeof value === 'number' && Number.isFinite(value) })[type]), 'schema', location + ': type');
  }
  if (object(value)) {
    for (const key of schema.required || []) insist(Object.hasOwn(value, key), 'schema', location + ': missing ' + key);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) validateSchema(child, schema.properties[key], root, location + '.' + key);
      else {
        insist(schema.additionalProperties !== false, 'schema', location + ': extra ' + key);
        if (object(schema.additionalProperties)) validateSchema(child, schema.additionalProperties, root, location + '.' + key);
      }
    }
  }
  if (Array.isArray(value)) {
    insist(value.length >= (schema.minItems || 0) && value.length <= (schema.maxItems ?? Infinity), 'schema', location + ': item count');
    if (schema.uniqueItems) insist(new Set(value.map(canonical)).size === value.length, 'schema', location + ': duplicate item');
    if (schema.items) value.forEach((child, index) => validateSchema(child, schema.items, root, location + '[' + index + ']'));
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    insist(length >= (schema.minLength || 0) && length <= (schema.maxLength ?? Infinity), 'schema', location + ': string length');
    if (schema.pattern) insist(new RegExp(schema.pattern, 'u').test(value), 'schema', location + ': pattern');
    if (schema === root.$defs?.error?.properties.message) insist(Buffer.byteLength(value, 'utf8') <= 2048, 'schema', location + ': error byte limit');
    if (schema === root.$defs?.run?.properties.turn) insist(Buffer.byteLength(value, 'utf8') <= 256, 'schema', location + ': turn byte limit');
  }
  if (typeof value === 'number') insist(value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity), 'schema', location + ': range');
  return true;
}

function validateDraft(draft, schema) {
  if (draft && Object.hasOwn(draft, 'attachments')) {
    validateSchema(draft.attachments, { type: 'array', items: { $ref: '#/$defs/attachment' } }, schema);
  }
}

function validateVector(vector, schema) {
  validateSchema(vector, schema.$defs.vector, schema);
  const { context, expected } = vector;
  insist((context.role === 'fleet') === (context.target === 'fleet'), 'identity', vector.id + ': role/target');
  insist(!context.seat.editor || context.seat.local, 'identity', vector.id + ': editor must be enrolled locally');
  validateDraft(vector.initial.record?.payload, schema);
  for (const step of vector.input) {
    if (step.direction === 'server') {
      const rule = schema.$defs['wire-' + step.message.type] || schema.$defs[step.message.type];
      if (rule) validateSchema(step.message, rule, schema);
    }
    if (step.direction === 'harness' && step.message.type === 'persist') validateDraft(step.message.record?.payload, schema);
  }
  const previous = new Map();
  let uncertain = false;
  for (const reply of expected.replies) {
    const wireSchema = schema.$defs['wire-' + reply.type];
    if (wireSchema) validateSchema(reply, wireSchema, schema);
    if (reply.type === 'ack') {
      validateSchema(reply, schema.$defs.ack, schema);
      const { outcome, status, admitted, result, error } = reply;
      insist(status === 'duplicate' ? admitted : status === outcome, 'ack', vector.id + ': disposition');
      insist(admitted ? reply.mid !== null && reply.expiresAt >= reply.at + 86400000 : reply.expiresAt === null && outcome === 'rejected', 'ack', vector.id + ': retention/admission');
      insist((outcome === 'applied') === (result !== null), 'ack', vector.id + ': result/outcome');
      insist(['rejected', 'unknown'].includes(outcome) === (error !== null), 'ack', vector.id + ': error/outcome');
      if (error) insist(!error.retryable || (!admitted && outcome === 'rejected'), 'ack', vector.id + ': unsafe retry');
      if (result) {
        const dataSchema = schema.$defs['data-' + reply.what];
        insist(dataSchema, 'ack', vector.id + ': unknown result family');
        validateSchema(result.data, dataSchema, schema);
        insist(result.replies.every(event => !['ack', 'operation', '@auth', '@box', '@challenge', '@welcome'].includes(event.type)), 'ack', 'Unretainable reply');
        const request = vector.input.find(step => step.direction === 'client' && step.message.mid === reply.mid && step.message.type === reply.what)?.message;
        if (request?.type === 'send') validateDraft(request, schema);
        if (request?.type === '@apple') {
          const token = String(request.token || '').replace(/[^0-9a-fA-F]/g, '');
          insist(token.length >= 32 && token.length <= 200, 'ack', vector.id + ': invalid successful APNs token');
        }
        if (request?.type === 'clearQueue' && vector.initial.queue) insist(result.data.removed === vector.initial.queue.length, 'ack', vector.id + ': wrong cleared count');
        for (const event of result.replies) {
          if (event.type !== 'editPrompt') continue;
          validateDraft(event, schema);
          const queued = vector.initial.queue?.find(item => item.id === request?.id);
          insist(queued && ['text', 'sent', 'snippets', 'attachments'].every(key => Object.hasOwn(queued, key) && Object.hasOwn(event, key) && canonical(queued[key]) === canonical(event[key])), 'ack', vector.id + ': reclaimed draft differs from queue');
        }
        if (request?.type === 'slack:signIn') {
          const retained = canonical(result);
          insist([request.token, request.cookie].filter(Boolean).every(secret => !retained.includes(secret)), 'ack', vector.id + ': retained credential');
        }
      }
      const key = reply.scope + ':' + reply.mid;
      const prior = previous.get(key);
      if (prior && status === 'duplicate') {
        const stable = ['scope', 'mid', 'what', 'target', 'admitted', 'at', 'expiresAt'];
        insist(stable.every(field => canonical(prior[field]) === canonical(reply[field])), 'ack', vector.id + ': duplicate changed identity/retention');
        const withoutStatus = value => { const copy = { ...value }; delete copy.status; return copy; };
        if (['applied', 'rejected'].includes(prior.outcome)) insist(canonical(withoutStatus(prior)) === canonical(withoutStatus(reply)), 'ack', vector.id + ': duplicate changed terminal result');
        if (prior.outcome === 'unknown') insist(outcome !== 'pending', 'ack', vector.id + ': unknown cannot become runnable pending');
      }
      previous.set(key, reply);
      uncertain ||= outcome === 'unknown';
    } else if (reply.type === 'operation') {
      validateSchema(reply, schema.$defs.operation, schema);
      insist(['rejected', 'unknown'].includes(reply.state) === (reply.error !== null), 'operation', vector.id + ': operation error');
      insist(!reply.error || reply.error.retryable === false, 'operation', 'Operation cannot authorize automatic retry');
      uncertain ||= reply.state === 'unknown';
    } else if (reply.type === 'welcome') {
      validateSchema(reply.seat, schema.$defs.seat, schema);
      insist(reply.proto === 1 || reply.proto === 2, 'schema', 'Welcome version');
      insist(reply.proto === 2 ? CORE.every(cap => reply.caps.includes(cap)) && reply.receipts.scope.match(/^[0-9a-f]{32}$/) : reply.caps.length === 0 && reply.receipts === null, 'schema', 'Welcome core/receipts');
    } else if (reply.type === 'protocol:error') {
      insist(['BAD_HELLO', 'NO_COMMON_PROTOCOL', 'REQUIRED_CAPABILITY', 'NEGOTIATION_TIMEOUT'].includes(reply.code) && expected.close === 1002, 'schema', 'Negotiation error/close');
    }
    if (reply.type === 'send') validateDraft(reply, schema);
  }
  if (uncertain) insist(expected.state.autoResend === false && expected.state.retained === true, 'unknown', vector.id + ': unknown must retain payload without replay');
  if (vector.hash) {
    const message = { ...vector.input[0].message }; delete message.mid; delete message.scope;
    const bytes = canonical({ message, target: context.target });
    insist(bytes === vector.hash.canonical && sha256(Buffer.from(bytes, 'utf8')) === vector.hash.sha256, 'hash', vector.id + ': canonical bytes/hash');
  }
  return true;
}

function mutationInventory(document) {
  let role = null;
  const found = [];
  const section = document.split("## 8. Full inventory of today's messages and mid requirements")[1].split('## 9.')[0];
  for (const line of section.split('\n')) {
    if (line.startsWith('### Authentication and transport')) role = 'either';
    else if (line.startsWith('### Fleet requests') || line.startsWith('### Terminal,') || line.startsWith('### Slack,')) role = 'fleet';
    else if (line.startsWith('### Conversation requests')) role = 'conversation';
    else if (line.startsWith('### ')) role = null;
    if (!role || !line.startsWith('| ')) continue;
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (!cells[1].startsWith('M') || !cells[2].startsWith('Yes')) continue;
    const type = cells[0].replace(/^C→S /, '');
    found.push(role + '/' + type + '/' + (cells[1].includes('M local') ? 'local' : 'default'));
  }
  return found.sort();
}

function loadCorpus() {
  const read = name => {
    insist(/^[a-z0-9-]+\.json$/.test(name), 'schema', 'Unsafe fixture path');
    const bytes = fs.readFileSync(path.join(DIRECTORY, name));
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  };
  const schema = read('schema.json').value;
  validateSchemaDefinition(schema);
  const manifest = read('manifest.json').value;
  validateSchema(manifest, schema.$defs.manifest, schema);
  const vectors = new Map();
  const files = new Set();
  const categories = new Set();
  for (const entry of manifest.files) {
    insist(!files.has(entry.file) && !categories.has(entry.category), 'schema', 'Duplicate file/category');
    files.add(entry.file); categories.add(entry.category);
    const file = read(entry.file);
    insist(sha256(file.bytes) === entry.sha256, 'hash', entry.file + ': file checksum');
    validateSchema(file.value, schema, schema);
    const rows = file.value.vectors;
    insist(file.value.category === entry.category && rows.length === entry.count, 'schema', entry.file + ': category/count');
    insist(canonical(rows.map(v => v.id)) === canonical(entry.ids), 'schema', entry.file + ': IDs');
    insist(rows.filter(v => v.polarity === 'positive').length === entry.positive && rows.filter(v => v.polarity === 'negative').length === entry.negative && entry.positive > 0 && entry.negative > 0, 'schema', entry.file + ': polarity counts');
    for (const vector of rows) {
      insist(!vectors.has(vector.id), 'schema', 'Duplicate vector ID ' + vector.id);
      validateVector(vector, schema); vectors.set(vector.id, vector);
    }
  }
  insist(vectors.size === manifest.totalVectors, 'schema', 'Total vector count');
  for (const vector of vectors.values()) {
    for (const [field, same] of [['sameAs', true], ['differentFrom', false]]) {
      for (const id of vector.hash?.[field] || []) {
        const peer = vectors.get(id);
        insist(peer?.hash && (peer.hash.sha256 === vector.hash.sha256) === same, 'hash', 'Hash relation ' + vector.id + '/' + id);
      }
    }
  }
  const ids = manifest.inventory.map(entry => entry.id);
  insist(new Set(ids).size === ids.length, 'schema', 'Duplicate inventory branch');
  for (const item of manifest.inventory) {
    const vector = vectors.get(item.vector);
    insist(vector?.inventory?.includes(item.id) && vector.input[0].message.type === item.type && (item.role === 'either' || vector.context.role === item.role), 'schema', 'Uncovered inventory ' + item.id);
  }
  const indexed = [...vectors.values()].flatMap(v => v.inventory || []).sort();
  insist(canonical(indexed) === canonical([...ids].sort()), 'schema', 'Inventory coverage is not bidirectional');
  const document = fs.readFileSync(path.join(ROOT, 'docs/engine/protocol-v2.md'), 'utf8');
  insist(canonical(mutationInventory(document)) === canonical(manifest.inventory.filter(item => ['default', 'local'].includes(item.branch)).map(item => item.id).sort()), 'schema', 'Protocol mutation inventory drift');
  const invalidFile = read(manifest.invalidFile.file);
  insist(sha256(invalidFile.bytes) === manifest.invalidFile.sha256, 'hash', 'Invalid corpus checksum');
  const invalid = invalidFile.value;
  validateSchema(invalid, schema.$defs.invalidCorpus, schema);
  insist(invalid.cases.length === manifest.totalInvalid && new Set(invalid.cases.map(item => item.id)).size === invalid.cases.length, 'schema', 'Invalid vector count/IDs');
  const expectedFiles = ['manifest.json', 'schema.json', manifest.invalidFile.file, ...files].sort();
  insist(canonical(fs.readdirSync(DIRECTORY).filter(name => name.endsWith('.json')).sort()) === canonical(expectedFiles), 'schema', 'Unlisted corpus file');
  return { manifest, schema, vectors, invalid: invalid.cases };
}

function malformedVector(test, vectors) {
  insist(vectors.has(test.base), 'schema', 'Missing malformed-vector base ' + test.base);
  const result = structuredClone(vectors.get(test.base));
  for (const patch of test.patches) {
    let parent = result;
    for (const key of patch.path.slice(0, -1)) {
      insist(parent !== null && Object.hasOwn(parent, key), 'schema', 'Invalid mutation path');
      parent = parent[key];
    }
    const key = patch.path.at(-1);
    insist(!['__proto__', 'constructor', 'prototype'].includes(key), 'schema', 'Unsafe patch');
    if (patch.op === 'remove') { insist(Object.hasOwn(parent, key), 'schema', 'Missing removal key'); delete parent[key]; }
    else { insist(Object.hasOwn(patch, 'value'), 'schema', 'Missing replacement value'); parent[key] = structuredClone(patch.value); }
  }
  return result;
}

module.exports = { loadCorpus, validateSchemaDefinition, validateSchema, validateVector, malformedVector, FixtureError, canonical };
