'use strict';

// Deferred returns live in the editor's own storage and contain workspace
// data only. Files in sources/the engine root never authorize a legacy import.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { privateFile, readPrivateJson, fail } = require('./daemonPaths');
const { atomicJson, hash } = require('./engineOwner');
const restoreFile = (directory, profile, workspace) => path.join(directory, profile + '.' + hash(workspace).slice(0, 12) + '.restore');
function cryptKey(identity, salt) {
  if (typeof identity?.privateKey !== 'string') throw fail('IDENTITY_UNAVAILABLE', 'The unchanged source identity is required for recovery');
  return crypto.hkdfSync('sha256', Buffer.from(identity.privateKey, 'base64url'), salt, Buffer.from('nikui-cutover-recovery-v1'), 32);
}
function seal(value, identity, binding) {
  const salt = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptKey(identity, salt), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { version: 1, binding, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function unseal(record, identity, binding = record.binding) {
  try {
    if (record.version !== 1 || hash(record.binding) !== hash(binding)) throw Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', cryptKey(identity, Buffer.from(record.salt, 'base64')), Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(binding))); decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch (_) { throw fail('RESTORE_STATE_UNAVAILABLE', 'The source recovery payload could not be authenticated'); }
}
function remove(file) {
  if (!privateFile(file, { optional: true })) return;
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const pendingKey = (workspace) => 'nikui.cutover.workspace.' + hash(workspace).slice(0, 24);
const permitFile = (context, workspace) => path.join(context.globalStorageUri.fsPath, 'cutover-workspace-' + hash(workspace).slice(0, 24) + '.permit');
const payloadFile = (context, workspace) => permitFile(context, workspace).replace(/\.permit$/, '.json');
const deliveredFile = (context, workspace) => permitFile(context, workspace).replace(/\.permit$/, '.delivered');
const LIMITS = Object.freeze({ workspaces: 256, bytes: 512 * 1024 * 1024, automaticAgeMs: 30 * 86400000 });
const grantFile = (context) => path.join(context.globalStorageUri.fsPath, 'cutover-grant.json');
const completedFile = (context) => path.join(context.globalStorageUri.fsPath, 'cutover-completed.json');
const logDiscard = (code) => console.error('[NikUI recovery] Discarded artifact:', code);
function discard(file) {
  // Do not follow a corrupt artifact's link or let it block activation.
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() && stat.uid === process.getuid()) fs.unlinkSync(file);
  } catch (e) { if (e.code !== 'ENOENT') logDiscard(e.code || 'ARTIFACT_UNAVAILABLE'); }
}
function obsolete(file, code = 'OBSOLETE_RESTORE_FILE') {
  try { fs.lstatSync(file); discard(file); logDiscard(code); }
  catch (e) { if (e.code !== 'ENOENT') logDiscard(e.code || 'ARTIFACT_UNAVAILABLE'); }
}
function invalidate(context, workspace) {
  if (workspace) { discard(permitFile(context, workspace)); return; }
  const directory = context.globalStorageUri.fsPath;
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) if (/^cutover-workspace-[a-f0-9]{24}\.permit$/.test(name)) discard(path.join(directory, name));
}
function workspaceRevoker(context, workspace) {
  const permit = permitFile(context, workspace);
  let pending = fs.existsSync(permit);
  return (changed = () => true) => { if (pending && changed()) { invalidate(context, workspace); pending = false; } };
}
function editorRecord(file) {
  try { return privateFile(file, { optional: true }) ? readPrivateJson(file) : null; }
  catch (e) { discard(file); logDiscard(e.code || 'EDITOR_RECEIPT_CORRUPT'); return null; }
}
function grant(context, value) { atomicJson(grantFile(context), value); }
function authorized(context, marker) {
  const active = editorRecord(grantFile(context)), completed = editorRecord(completedFile(context));
  return !!active && active.profile === marker.profile && active.install === marker.install && active.ownerRoot === marker.ownerRoot &&
    active.engineRoot === marker.engineRoot && Number.isSafeInteger(active.generation) &&
    (!completed || completed.ownerRoot !== active.ownerRoot || active.generation > completed.generation);
}
function superseded(context, marker) {
  const active = editorRecord(grantFile(context)), completed = editorRecord(completedFile(context));
  return !!completed && completed.profile === marker.profile && completed.install === marker.install && completed.ownerRoot === marker.ownerRoot &&
    (!active || active.ownerRoot === completed.ownerRoot && active.generation <= completed.generation);
}
function complete(context, value) {
  const prior = editorRecord(completedFile(context));
  if (!prior || prior.ownerRoot !== value.ownerRoot || prior.generation < value.generation) atomicJson(completedFile(context), value);
  discard(grantFile(context));
}
// VS Code broadcasts mementos asynchronously between extension hosts. A
// reloaded sibling can still see a receipt after its payload was consumed.
// Keep an editor-owned, exact receipt acknowledgement beside the payload.
function deliveryAcknowledgements(context, workspace) {
  const done = editorRecord(deliveredFile(context, workspace));
  return done?.acknowledgements || (done ? [done] : []);
}
function acknowledgedReceipt(context, workspace, receipt) {
  if (!receipt) return false;
  return deliveryAcknowledgements(context, workspace).some(done =>
    ['profile', 'install', 'ownerRoot', 'generation', 'transition', 'workspace', 'hash'].every(key => done[key] === receipt[key]));
}
function wasDelivered(context, workspace, receipt) {
  if (!acknowledgedReceipt(context, workspace, receipt)) return false;
  // Keep old acknowledgements across later Moves, but never let a stale
  // receipt hide a newer payload that has not actually been applied yet.
  return !privateFile(payloadFile(context, workspace), { optional: true }) || hash(entry(context, workspace)) === receipt.hash;
}
function entry(context, workspace) { return readPrivateJson(payloadFile(context, workspace)); }
async function stage(context, binding, workspaces, { limits = LIMITS, now = Date.now } = {}) {
  const entries = new Map();
  // A new Move must first return every closed folder. Only a retry of this
  // same handback may replace its own staged payloads.
  for (const key of context.globalState.keys?.() || []) if (key.startsWith('nikui.cutover.workspace.')) {
    const prior = context.globalState.get(key);
    if (prior && !wasDelivered(context, prior.workspace, prior) && (!Object.hasOwn(workspaces, prior.workspace) ||
      ['profile', 'install', 'ownerRoot', 'generation', 'transition'].some((name) => prior[name] !== binding[name])))
      throw fail('PENDING_FOLDER_RETURNS', 'Open these folders in VS Code first: ' + pendingWorkspaces(context).join(', '));
  }
  for (const [workspace, payload] of Object.entries(workspaces)) if (workspace)
    entries.set(workspace, { ...binding, workspace, payload, createdAt: now() });
  let bytes = 0;
  for (const value of entries.values()) bytes += Buffer.byteLength(JSON.stringify(value));
  if (entries.size > limits.workspaces || bytes > limits.bytes) throw fail('RESTORE_STORAGE_FULL', 'Workspace return exceeds the private storage bound; current service work is retained');
  // Validate the complete bound before changing any existing delivery.
  for (const [workspace, value] of entries) {
    const digest = hash(value);
    atomicJson(payloadFile(context, workspace), value);
    await context.globalState.update(pendingKey(workspace), { ...binding, workspace, hash: digest, createdAt: value.createdAt,
      paths: (value.payload.projects || []).map(({ project }) => project?.root).filter(Boolean) });
    atomicJson(permitFile(context, workspace), { transition: binding.transition, hash: digest });
  }
}
function pending(context, workspace) {
  const receipt = workspace && context.globalState.get(pendingKey(workspace));
  return !!receipt && !wasDelivered(context, workspace, receipt);
}
function pendingWorkspaces(context) {
  return [...new Set((context.globalState.keys?.() || []).filter((key) => key.startsWith('nikui.cutover.workspace.'))
    .map((key) => context.globalState.get(key)?.workspace).filter((workspace) => typeof workspace === 'string' && !!workspace && pending(context, workspace)))].sort();
}
function pendingReturns(context) {
  return pendingWorkspaces(context).map((workspace) => {
    const receipt = context.globalState.get(pendingKey(workspace));
    const paths = [...(receipt.paths || []), ...(path.isAbsolute(workspace) ? [workspace] : workspace.startsWith('folders:') ? JSON.parse(workspace.slice(8)) : [])];
    return { workspace, hash: receipt.hash || hash(receipt), transition: receipt.transition,
      missing: paths.some((file) => !fs.existsSync(file)) };
  });
}
async function forget(context, workspace, expected) {
  const receipt = context.globalState.get(pendingKey(workspace));
  if (!receipt || expected?.hash !== (receipt.hash || hash(receipt)) || expected.transition !== receipt.transition)
    throw fail('RESTORE_SUPERSEDED', 'The saved return changed; review it again');
  const owner = require('./engineOwner').createOwner({ root: receipt.ownerRoot, profile: receipt.profile, install: receipt.install }).status();
  if (owner.mode !== 'window' || owner.admission !== 'open') throw fail('OWNER_TRANSITION_PENDING', 'Finish ownership recovery before forgetting a return');
  const storage = context.globalStorageUri.fsPath, scope = hash(workspace).slice(0, 12);
  if (privateFile(payloadFile(context, workspace), { optional: true }) && receipt.hash !== hash(entry(context, workspace)))
    throw fail('RESTORE_SUPERSEDED', 'The workspace return changed; refresh before forgetting it');
  const artifacts = [payloadFile(context, workspace), permitFile(context, workspace),
    ...['snapshots', 'keepers', 'keepers.store'].map((ext) => path.join(storage, 'cutover-' + scope + '.' + ext))];
  const files = artifacts.filter((file) => privateFile(file, { optional: true })).map((file) => ({ name: path.basename(file), data: fs.readFileSync(file).toString('base64') }));
  let identity;
  try { require('./identity').loadIdentity(context.globalState, { required: true }); identity = context.globalState.get('nikui.identity'); }
  catch (_) { /* A lost editor identity must not make Forget impossible. */ }
  const archive = path.join(storage, 'cutover-archives', crypto.randomBytes(16).toString('hex') + '.json');
  require('./daemonPaths').privateDirectory(path.dirname(archive));
  if (!identity) {
    // This archive has its own private recovery key. It never replaces the
    // selected editor identity or authorizes an import or service writer.
    atomicJson(archive + '.key', { privateKey: crypto.randomBytes(32).toString('base64url') });
    identity = readPrivateJson(archive + '.key');
  }
  atomicJson(archive, seal({ receipt, files }, identity, { profile: receipt.profile, install: receipt.install, workspace, transition: receipt.transition }));
  if (hash(readArchive(archive, identity)) !== hash({ receipt, files })) throw fail('RESTORE_STATE_UNAVAILABLE', 'The saved archive did not verify');
  // Only a durable, read-back-verified archive permits clearing the blocker. Failure
  // before this point leaves every original byte and the receipt untouched.
  await context.globalState.update(pendingKey(workspace), undefined);
  for (const file of artifacts) discard(file);
  return { archive, workspace };
}
function readArchive(file, identity) {
  return unseal(readPrivateJson(file), privateFile(file + '.key', { optional: true }) ? readPrivateJson(file + '.key') : identity);
}
async function delivered(context, workspace, expected) {
  const receipt = context.globalState.get(pendingKey(workspace));
  const suppliedEntry = expected?.workspace === workspace && typeof expected.profile === 'string' && expected.payload;
  if (!privateFile(payloadFile(context, workspace), { optional: true }) && !suppliedEntry && !receipt) return;
  const value = suppliedEntry ? expected : entry(context, workspace);
  if (expected && ['transition', 'generation'].some((key) => value[key] !== expected[key]))
    throw fail('RESTORE_SUPERSEDED', 'The workspace return changed while it was delivered');
  const { profile, install, ownerRoot, generation, transition } = value;
  const ack = { profile, install, ownerRoot, generation, transition, workspace, hash: hash(value) };
  const acknowledgements = deliveryAcknowledgements(context, workspace).filter(prior => prior.hash !== ack.hash || prior.transition !== transition);
  atomicJson(deliveredFile(context, workspace), { version: 1, acknowledgements: [...acknowledgements, ack].slice(-64) });
  await context.globalState.update(pendingKey(workspace), undefined);
  discard(permitFile(context, workspace)); discard(payloadFile(context, workspace));
}
function exportKey(adapter, transition, create = false) {
  const account = 'recovery.' + transition;
  const store = require('./keychainStore').createKeychainStore({ adapter, account,
    create: create && adapter.read(account) === null, initial: { key: crypto.randomBytes(32).toString('base64url') } });
  try { return { privateKey: store.get('key') }; } finally { store.dispose(); }
}
function saveExport(file, value, adapter, transition) { atomicJson(file, seal(value, exportKey(adapter, transition, true), { transition })); }
function readExport(file, adapter, transition) { return unseal(readPrivateJson(file), exportKey(adapter, transition), { transition }); }
async function deliver({ directory, profile, install, workspace, context, apply, validate = () => true, explicit = false, keepSettings = false, now = Date.now }) {
  if (!workspace) return false;
  const legacyFile = restoreFile(directory, profile, workspace), permit = permitFile(context, workspace);
  obsolete(legacyFile);
  const receipt = context.globalState.get(pendingKey(workspace));
  if (!receipt || wasDelivered(context, workspace, receipt)) return false;
  // Mismatched returns keep their payload, receipt and snapshots. The
  // activation path exposes recovery before constructing a legacy writer.
  // Old globalState payloads are accepted only with their existing permit;
  // staging from this build always writes bounded files and tiny receipts.
  const entry = receipt.payload ? receipt : readPrivateJson(payloadFile(context, workspace));
  const proof = readPrivateJson(permit);
  if (entry.profile !== profile || entry.install !== install || entry.workspace !== workspace ||
      proof.transition !== entry.transition || proof.hash !== hash(entry) || receipt.hash && receipt.hash !== proof.hash) throw fail('RESTORE_SUPERSEDED', 'Later legacy work invalidated this delivery');
  const owner = require('./engineOwner').createOwner({ root: entry.ownerRoot, profile, install }), status = owner.status();
  if (status.mode === 'window' && status.generation === entry.generation && status.admission === 'closed') return false;
  if (status.mode !== 'window' || status.generation !== entry.generation || status.admission !== 'open' || status.phase !== 'released')
    throw fail('RESTORE_SUPERSEDED', 'This generation no longer owns a return');
  if (keepSettings && !explicit) throw fail('RESTORE_CONFIRMATION_REQUIRED', 'Confirm importing conversations with current settings');
  if (!await validate(entry.payload, { keepSettings })) throw fail('RESTORE_SUPERSEDED', 'The workspace changed after export');
  // Expiry ends automatic import, never deletes undelivered user work.
  // The explicit editor Restore action rechecks the same scope and owner.
  if (!explicit && Number.isSafeInteger(entry.createdAt) && now() - entry.createdAt > LIMITS.automaticAgeMs)
    throw fail('RESTORE_EXPIRED', 'Saved workspace work needs explicit Restore VS Code');
  // Consume authorization before an async import; a crash cannot replay it.
  discard(permit);
  await apply(entry.payload, { generation: entry.generation, keepSettings });
  await delivered(context, workspace, entry);
  return true;
}
module.exports = { seal, unseal, saveExport, readExport, restoreFile, stage, pending, pendingKey, permitFile, invalidate,
  grant, authorized, superseded, complete, grantFile, completedFile, deliver, delivered, pendingWorkspaces, pendingReturns, forget, readArchive,
  remove, discard, obsolete, logDiscard, workspaceRevoker, payloadFile, deliveredFile, wasDelivered, entry, LIMITS };
