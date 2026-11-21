'use strict';

// A selected TEST-owner round trip over the running rehearsal's real state.
// Target activations capture data only. No actual owner switch, provider
// resume, installed window, or production profile can be selected here.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { privateDirectory, readPrivateJson, noSymlinks, fail } = require('./daemonPaths');
const { createSyntheticOwner, hash } = require('./engineOwner');
const { createParticipantGate, GLOBAL_KEYS, WORKSPACE_KEYS } = require('./engineTransfer');
const { createGenerationImporter, exportSelectedContext, buildSelectedTransfer } = require('./engineImport');
const { DOMAIN } = require('./engineState');
function memoryAdapter() {
  const values = new Map();
  return { service: 'com.nikui.engine.test.' + crypto.randomBytes(16).toString('hex'), backend: 'login-file-keychain',
    read: (k) => values.has(k) ? Buffer.from(values.get(k)) : null,
    add(k, v) { if (values.has(k)) throw fail('KEYCHAIN_DUPLICATE', 'Duplicate'); values.set(k, Buffer.from(v)); },
    update(k, v) { if (!values.has(k)) throw fail('KEYCHAIN_NOT_FOUND', 'Missing'); values.set(k, Buffer.from(v)); }, delete: (k) => values.delete(k) };
}
async function code(fn) { try { await fn(); return null; } catch (e) { return e.code; } }
async function rehearseTransfer({ daemon, sourceStore, secretAdapter }) {
  const home = daemon.paths.home, base = path.join(home, 'p2-handoff');
  if (fs.existsSync(base)) throw fail('HANDOFF_NOT_FRESH', 'A fresh test handoff is required');
  privateDirectory(base);
  const profile = 'isolated:' + crypto.createHash('sha256').update(daemon.paths.root).digest('hex');
  const owner = createSyntheticOwner({ root: path.join(base, 'o'), profile, install: 'p2-selected-test', testOnly: true });
  await owner.initialize();
  const selection = { fingerprint: daemon.engine.delivery.identity.fingerprint, applicationServerKey: daemon.engine.delivery.vapid.applicationServerKey };
  const accounts = new Set(), backend = secretAdapter || memoryAdapter();
  const tracked = { ...backend };
  for (const method of ['read', 'add', 'update', 'delete']) tracked[method] = (account, ...args) => {
    if (!/^(?:generation|evidence)\.[a-f0-9]{32}$/.test(account)) throw fail('KEYCHAIN_NAMESPACE', 'Only minted transfer accounts allowed');
    if (method === 'add' || method === 'update') accounts.add(account);
    return backend[method](account, ...args);
  };
  let importer, back, returned, runtime, activations = 0;
  const proof = { version: 1, status: 'running', mode: secretAdapter?.backend === 'login-file-keychain' && secretAdapter.portable !== true
    ? 'signed-service / native SecItem / synthetic owner' : 'portable / fake selected store / synthetic owner', cleanup: false };
  try {
    const member = await owner.admit({ id: 'p2-window-export', build: 'p2-metadata-capable', metaVersion: 1 });
    const context = daemon.engine.manager.context;
    const selectedStore = (store, allowed, read = (key) => store.get(key)) => ({
      keys: () => allowed.filter((key) => read(key) !== undefined), get: read });
    const global = selectedStore(context.globalState, GLOBAL_KEYS.filter((k) => !['nikui.identity', 'nikui.vapid'].includes(k)),
      (key) => ['nikui.devices', 'nikui.deviceTrail'].includes(key) ? sourceStore.get(key) : context.globalState.get(key));
    const sourceContext = { globalState: global, workspaceState: selectedStore(context.workspaceState, WORKSPACE_KEYS) };
    const transfer = await owner.begin({ generation: 0, to: 'service', target: 'p2-selected-service',
      inventory: { complete: true, scope: owner.scope, ids: [member.id], otherScopes: [] } });
    const gate = createParticipantGate({ owner, member });
    const source = await gate.quiesce(transfer.token, {
      closeAdmission() {}, cancel() {}, drain: () => daemon.graph.currentState.flush(),
      flush: () => daemon.engine.flush(), detach() {}, releaseResources: () => ({ released: true, owned: [] }),
      exportState: () => exportSelectedContext({ context: sourceContext, engine: daemon.engine,
        settings: daemon.graph.authority.snapshot().values[DOMAIN].settings,
        provenance: { profile, workspace: home, rawScope: 'selected-test' }, selection,
        secrets: { get: (key) => sourceStore.get(key) }, authority: daemon.graph.authority, completeAuthority: true,
        keeper: { metaVersion: 1, runs: [] } }) });
    const envelope = buildSelectedTransfer(transfer, [source], { selectedSource: member.id });
    await owner.exported(transfer.token, envelope.hash);
    importer = createGenerationImporter({ root: path.join(base, 't'), target: 'p2-selected-service', owner, secretAdapter: tracked, testOnly: true,
      activate(state, generation, lease, store) { activations++; runtime = { state, generation, lease, store }; } });
    const receipt = importer.import(envelope); assert(receipt.inactive); assert.equal(activations, 0);
    assert.deepEqual(importer.import(envelope), receipt);
    await owner.imported(transfer.token, receipt); await importer.commit(transfer.token); await importer.start(transfer.token);
    await owner.started(transfer.token, { generation: 1, target: 'p2-selected-service', hash: envelope.hash, oldResourcesReleased: true }); await owner.release(transfer.token);
    const queue = [{ id: 'p2-post-queue', text: 'post-cutover full test input ქართული', sent: 'expanded post-cutover input',
      snippets: ['post-cutover'], attachments: [{ mediaType: 'image/png', data: Buffer.from('post-cutover-image').toString('base64') }], state: 'unknown' }];
    importer.mutate((state) => {
      state.instances.push({ id: 'p2-service-created', provider: 'claude', cwd: path.join(home, 'p2-project'), queue, totalCost: 3, turns: 1 });
      state.queues.push({ instance: 'p2-service-created', items: queue, hash: hash(queue) });
      state.ledger.instances['p2-service-created'] = { cost: 3, tokens: 19, turns: 1 };
    });
    runtime.store.update('nikui.slack.userToken', 'synthetic-post-cutover-current-credential');
    const current = importer.member();
    back = createGenerationImporter({ root: path.join(base, 'b'), target: 'p2-return-window', owner, secretAdapter: tracked, testOnly: true,
      activate(state, generation, lease, store) { activations++; returned = { state, generation, lease, store }; } });
    proof.staleBackupCode = await code(() => back.import(envelope)); assert.equal(proof.staleBackupCode, 'IMPORT_SCOPE_CONFLICT');
    const returning = await owner.begin({ generation: 1, to: 'window', target: 'p2-return-window',
      inventory: { complete: true, scope: owner.scope, ids: [current.id], otherScopes: [] } });
    const currentGate = createParticipantGate({ owner, member: current });
    const fresh = await currentGate.quiesce(returning.token, { closeAdmission() {}, cancel() {}, drain() {}, flush() {}, detach() {},
      releaseResources: () => ({ released: true, owned: [] }),
      exportState: () => importer.exportCurrent({ transition: returning.token,
        provenance: { profile, workspace: path.join(base, 't'), rawScope: 'service' }, keeper: { metaVersion: 1, runs: [] } }) });
    const handback = buildSelectedTransfer(returning, [fresh], { selectedSource: current.id }); await owner.exported(returning.token, handback.hash);
    const backReceipt = back.import(handback); await owner.imported(returning.token, backReceipt);
    await back.commit(returning.token); await back.start(returning.token);
    await owner.started(returning.token, { generation: 2, target: 'p2-return-window', hash: handback.hash, oldResourcesReleased: true }); await owner.release(returning.token);
    assert.equal(returned.generation, 2); assert.equal(activations, 2);
    assert.deepEqual(returned.store.get('nikd.selection'), selection);
    assert.deepEqual(returned.store.get('nikui.devices'), source.state.global['nikui.devices']);
    assert.equal(returned.store.get('nikui.slack.userToken'), 'synthetic-post-cutover-current-credential');
    assert.deepEqual(returned.state.queues.find((q) => q.instance === 'p2-service-created').items, queue);
    assert.equal(returned.state.ledger.instances['p2-service-created'].cost, 3);
    assert.deepEqual(returned.state.authority, source.state.authority);
    proof.oldWriterCode = await code(() => importer.mutate(() => {})); assert.equal(proof.oldWriterCode, 'WRITER_FENCED');
    Object.assign(proof, { status: 'passed', generations: [0, 1, 2], activations, preservedPins: selection,
      currentAuthorityHash: hash(returned.state.authority), receiptScope: returned.state.authority.scope,
      deviceCount: (returned.store.get('nikui.devices') || []).length, postCutoverQueueHash: hash(queue), postCutoverCost: 3,
      providersStarted: 0, accountCount: accounts.size });
  } finally {
    importer?.dispose(); back?.dispose();
    const failures = [];
    for (const account of accounts) { try { backend.delete(account); assert.equal(backend.read(account), null); } catch (_) { failures.push(account); } }
    proof.cleanup = failures.length === 0;
    if (failures.length) throw fail('HANDOFF_KEYCHAIN_CLEANUP_FAILED', 'Minted transfer accounts remain');
  }
  return proof;
}
function cleanupTransferAccounts(root, adapter) {
  const attempted = new Set();
  for (const dir of ['t', 'b']) {
    const file = path.join(root, 'home/p2-handoff', dir, 'generation-import.json');
    noSymlinks(file);
    if (!fs.existsSync(file)) continue;
    const saved = readPrivateJson(file);
    if (saved.version !== 1 || !Array.isArray(saved.records)) throw fail('HANDOFF_CLEANUP_UNPROVEN', 'Invalid test transfer journal');
    for (const r of saved.records) {
      if (r.service !== adapter.service || !/^[a-f0-9]{32}$/.test(r.id) || r.account !== 'generation.' + r.id || r.evidenceAccount !== 'evidence.' + r.id) {
        throw fail('HANDOFF_CLEANUP_UNPROVEN', 'Test transfer namespace disagrees');
      }
      attempted.add(r.account); attempted.add(r.evidenceAccount);
    }
  }
  const failures = [];
  for (const account of attempted) { try { adapter.delete(account); assert.equal(adapter.read(account), null); } catch (_) { failures.push(account); } }
  if (failures.length) throw fail('HANDOFF_KEYCHAIN_CLEANUP_FAILED', 'Minted transfer accounts remain');
  return { accounts: attempted.size, cleanup: true };
}
module.exports = { rehearseTransfer, memoryAdapter, cleanupTransferAccounts };
