'use strict';
const fs = require('fs'), path = require('path');
const { createEngine } = require('../src/engine');
const { createLegacyActivation, sourceDirectory } = require('../src/legacySource');
const { createProductionCutover } = require('../src/productionCutover');
const { exportSelectedContext } = require('../src/engineImport');
const { productionPaths } = require('../src/productionComposition');
const { loadIdentity } = require('../src/identity');
const { loadVapid } = require('../src/push');
const { context, settings, Secrets, provider } = require('./fixtures/engine/fakes');
const { memoryAdapter } = require('../src/acceptanceTransfer');

async function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/nk-p3-'));
  const project = path.join(home, 'project'), storage = path.join(home, 'storage');
  for (const directory of [project, storage, path.join(home, '.codex-work'), path.join(home, '.claude/projects')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const original = context(); original.secrets = new Secrets(); original.globalStorageUri = { fsPath: storage };
  const identity = loadIdentity(original.globalState), vapid = loadVapid(original.globalState);
  const source = createLegacyActivation(original, { home, install: '/fixture/compatible-extension', workspace: project });
  const cfg = { version: 1, user: { 'remote.port': 0, watchCIAfterPush: false },
    projects: [{ root: project, approved: true, provenance: { profile: source.profile, workspace: project, rawScope: 'workspace' }, values: {} }] };
  const fake = provider();
  const engine = createEngine({ context: source.context, settings: settings(), paths: { home, projects: path.join(home, '.claude/projects'), storage,
    codexCache: path.join(storage, 'cache') }, spawner: fake.spawnFn,
    codex: { unavailableReason: 'source test has no Codex account' } });
  require('../src/legacyExtensionSource').protect(engine, source);
  const session = engine.manager.create({ cwd: project, id: 'legacy-conversation', autoStart: false, title: 'Legacy conversation' });
  session.items.push({ id: 'legacy-text', kind: 'text', text: 'Seeded legacy transcript' });
  let exported, client = false, returned;
  await source.listen({
    review: async () => ({ ready: true, blockers: [], fingerprint: identity.fingerprint, conversations: 1, queues: 0, devices: 0,
      listener: { configuredPort: 0, listening: false, port: 0 },
      hostInventory: { complete: true, pids: [process.pid], windows: 1 } }),
    closeAdmission() {}, cancel() {}, drain() {}, flush: () => engine.flush(),
    async detach() { exported = await exportSelectedContext({ context: source.context, engine, settings: cfg,
      provenance: { profile: source.profile, workspace: project, rawScope: 'workspace' },
      selection: { fingerprint: identity.fingerprint, applicationServerKey: vapid.applicationServerKey }, secrets: original.secrets,
      files: { sessions: () => [session.snapshot()], keeper: () => null }, keeper: { metaVersion: 1, runs: [] } }); },
    async releaseResources() { await engine.dispose(); return { released: true, owned: ['fixture-window'] }; },
    exportState: () => exported, becomeClient: () => { client = true; }, restoreLegacy() {},
    validateReturn: (state) => { if (!state.completeAuthority && !state.returnNeverActivated) throw Object.assign(new Error('authority'), { code: 'CURRENT_STATE_EXPORT_REQUIRED' }); },
    importShared: (state) => { returned = state; }, importWorkspace() {}
  });
  const selection = { ...productionPaths(home), flavour: 'prod', label: 'com.nikui.engine', appID: 'com.nikui.app' };
  const adapter = memoryAdapter();
  return { home, project, source, engine, original, selection, adapter, client: () => client, returned: () => returned,
    dependencies: { account: () => ({ homedir: home }),
      resolver: { resolveAll: async () => ({ tools: Object.fromEntries(['claude', 'codex', 'node', 'gh'].map((s) => [s,
        { path: '/fixture/' + s, status: 'resolved', source: 'configured' }])), childEnv: { PATH: '/usr/bin:/bin' } }) },
      power: { recover() {}, awake() {}, lid() {}, release() {} }, spawn: fake.spawnFn,
      codexCache: { read: () => null, write() {}, sweep() {}, dispose() {}, picture: async () => null } },
    async cleanup() { await source.dispose(); await engine.dispose(); fs.rmSync(home, { recursive: true, force: true }); } };
}
module.exports = async () => {
  suite('User-clicked production source and current-state handback');
  const f = await fixture(); let runtime;
  try {
    const coordinator = createProductionCutover({ selection: f.selection, secretAdapter: f.adapter });
    check('loading a compatible source does not create a production profile', !fs.existsSync(f.selection.root));
    await f.source.context.globalState.update('nikui.names.v1', { normal: 'legacy writes still work' });
    checkEqual('no handshake retains default legacy writes', f.original.globalState.get('nikui.names.v1'), { normal: 'legacy writes still work' });
    const review = await coordinator.review();
    checkEqual('review uses the live source inventory', [review.ready, review.windows, review.conversations], [true, 1, 1]);
    check('review is free of production-profile effects', !fs.existsSync(f.selection.root));
    let code;
    try { await coordinator.move({ profile: review.profile, token: 'stale' }); } catch (e) { code = e.code; }
    checkEqual('changed review refuses before the barrier', code, 'SOURCE_SELECTION_CHANGED');
    const moved = await coordinator.move(review);
    checkEqual('click-equivalent commits one service generation', [moved.ok, moved.generation], [true, 1]);
    try { await f.source.context.globalState.update('must-not-write', true); } catch (e) { code = e.code; }
    checkEqual('exported legacy writer stays sealed', code, 'WRITER_SEALED');
    runtime = await require('../src/productionRuntime').startProductionRuntime({ selection: f.selection, secretAdapter: f.adapter, dependencies: f.dependencies });
    checkEqual('production runtime restores real source conversation IDs', runtime.engine.manager.list.map((s) => s.id), ['legacy-conversation']);
    checkEqual('production transcript comes from the source context', runtime.engine.manager.get('legacy-conversation').items[0].text, 'Seeded legacy transcript');
    const pins = [runtime.engine.delivery.identity.fingerprint, runtime.engine.delivery.vapid.applicationServerKey];
    await coordinator.finish();
    check('only the ready committed runtime switches the editor to a service client', f.client());
    runtime.engine.manager.create({ cwd: f.project, autoStart: false, title: 'Created after cutover', id: 'service-created' });
    await runtime.currentState.flush();
    await runtime.stop(); runtime = null;
    runtime = await require('../src/productionRuntime').startProductionRuntime({ selection: f.selection, secretAdapter: f.adapter, dependencies: f.dependencies });
    check('restart keeps post-cutover current state', runtime.engine.manager.get('service-created')?.customTitle === 'Created after cutover');
    checkEqual('restart keeps the latest retained transcript', runtime.engine.manager.get('legacy-conversation').items[0].text, 'Seeded legacy transcript');
    const scope = runtime.authority.snapshot().scope;
    const back = await coordinator.handback();
    checkEqual('handback commits the next window generation', [back.ok, back.generation], [true, 2]);
    check('handback exports service-created conversations', f.returned().instances.some((s) => s.id === 'service-created'));
    checkEqual('fresh handback preserves current receipt authority', f.returned().authority.scope, scope);
    checkEqual('fresh handback preserves both selected pins', [loadIdentity({ get: (k) => f.returned().returnSecrets[k] }).fingerprint,
      loadVapid({ get: (k) => f.returned().returnSecrets[k] }).applicationServerKey], pins);
    checkEqual('a repeated handback is idempotent', await coordinator.handback(), { ok: true, stage: 'returned' });
    await runtime.stop(); runtime = null;
    check('normal stop removes only its private endpoint', !fs.existsSync(path.join(f.selection.root, 'c.sock')));
  } finally { await runtime?.stop(); await f.cleanup(); }

  const inactive = await fixture();
  try {
    const coordinator = createProductionCutover({ selection: inactive.selection, secretAdapter: inactive.adapter });
    await coordinator.move(await coordinator.review());
    const restored = await coordinator.handback();
    checkEqual('failed startup before any authority/effect can return verified current inactive state', [restored.generation,
      inactive.returned().returnNeverActivated, inactive.returned().instances.map((s) => s.id)], [2, true, ['legacy-conversation']]);
  } finally { await inactive.cleanup(); }

  const reopened = await fixture(); let reopenedRuntime, replacement, legacy;
  try {
    const coordinator = createProductionCutover({ selection: reopened.selection, secretAdapter: reopened.adapter });
    await coordinator.move(await coordinator.review());
    reopenedRuntime = await require('../src/productionRuntime').startProductionRuntime({ selection: reopened.selection,
      secretAdapter: reopened.adapter, dependencies: reopened.dependencies });
    await coordinator.finish(); await reopened.source.dispose();
    replacement = createLegacyActivation(reopened.original, { home: reopened.home, install: '/fixture/compatible-extension', workspace: reopened.project });
    check('a reopened editor selects service-client mode before a legacy engine exists', replacement.service?.root === reopened.selection.root);
    let current;
    await replacement.listen({ review: async () => ({ ready: true, blockers: [], fingerprint: reopenedRuntime.engine.delivery.identity.fingerprint,
      hostInventory: { complete: true, pids: [process.pid], windows: 1 } }),
      validateReturn() {}, importShared: (state) => { current = state; }, importWorkspace() {}, restoreLegacy() {} });
    await coordinator.handback();
    check('a replacement source context receives the current handback', current.instances.some((s) => s.id === 'legacy-conversation'));
    await reopenedRuntime.stop(); reopenedRuntime = null; await replacement.dispose(); replacement = null;
    legacy = createLegacyActivation(reopened.original, { home: reopened.home, install: '/fixture/compatible-extension', workspace: reopened.project });
    await legacy.ready(); await legacy.context.globalState.update('nikui.names.v1', { restored: 'current generation' });
    check('legacy reactivation acquires the new generation before writing', reopened.original.globalState.get('nikui.names.v1').restored === 'current generation');
  } finally { await reopenedRuntime?.stop(); await replacement?.dispose(); await legacy?.dispose(); await reopened.cleanup(); }

  suite('App coordinator crash boundaries retain one writer');
  for (const stage of ['reviewed', 'joined', 'barrier', 'imported', 'committed', 'launchable']) {
    const f = await fixture();
    try {
      let crashed = false;
      const options = { selection: f.selection, secretAdapter: f.adapter };
      const first = createProductionCutover({ ...options, fault(value) { if (value === stage && !crashed) {
        crashed = true; throw Object.assign(new Error('process lost'), { crash: true, code: 'TEST_CRASH' });
      } } });
      const review = await first.review();
      try { await first.move(review); } catch (e) { if (e.code !== 'TEST_CRASH') throw e; }
      const resumed = createProductionCutover(options);
      const result = await resumed.move(review);
      checkEqual('retry after process loss at ' + stage, [crashed, result.ok, result.generation], [true, true, 1]);
      const proof = require('../src/productionOwnership').committedOwnership(f.selection.root);
      checkEqual('one committed owner after ' + stage, [proof.owner.status().mode, proof.owner.status().generation], ['service', 1]);
    } finally { await f.cleanup(); }
  }
};
