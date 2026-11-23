'use strict';
const fs = require('fs'), path = require('path');
const { createLegacyActivation, sourceDirectory, profileID } = require('../../src/legacySource');
const { createEngine } = require('../../src/engine');
const { createProductionCutover } = require('../../src/productionCutover');
const { capturedSettings, returnAdapters } = require('../../src/legacyExtensionSource');
const { exportSelectedContext } = require('../../src/engineImport');
const { loadIdentity } = require('../../src/identity'), { loadVapid } = require('../../src/push');
const { context, settings, Secrets, provider } = require('../fixtures/engine/fakes');
const { memoryKeychain } = require('./keychain');
const recovery = require('../../src/cutoverRecovery');

async function productionFixture(count = 1) {
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/nk-r11-'));
  const storage = path.join(home, 'storage'), install = '/fixture/compatible-extension';
  for (const p of [storage, path.join(home, '.codex-work'), path.join(home, '.claude/projects')]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  const global = context().globalState, secrets = new Secrets({ 'nikui.slack.userToken': 'old-token', 'future.secret': 'stay-in-vscode' });
  global.keys = () => Object.keys(global.values).filter((k) => global.values[k] !== undefined);
  secrets.keys = async () => [...secrets.values.keys()];
  const identity = loadIdentity(global), vapid = loadVapid(global);
  await global.update('future.global', { retained: true }); await global.update('$$__isNewStorageMarker', true);
  const user = { 'remote.port': 0, watchCIAfterPush: false }, slots = [], engines = [];
  const fake = provider(), adapter = memoryKeychain();
  const selection = { ...require('../../src/productionComposition').productionPaths(home), flavour: 'prod', label: 'com.nikui.engine', appID: 'com.nikui.app' };
  let runtime;
  const dependencies = { account: () => ({ homedir: home }),
    resolver: { resolveAll: async () => ({ tools: Object.fromEntries(['claude', 'codex', 'node', 'gh'].map((s) => [s,
      { path: '/fixture/' + s, status: 'resolved', source: 'configured' }])), childEnv: { PATH: '/usr/bin:/bin' } }) },
    power: { recover() {}, awake() {}, lid() {}, release() {} }, spawn: fake.spawnFn,
    codexCache: { read: () => null, write() {}, sweep() {}, dispose() {}, picture: async () => null } };
  for (let i = 0; i < count; i++) {
    const project = path.join(home, 'p' + i); fs.mkdirSync(project, { mode: 0o700 });
    const original = context(); original.globalState = global; original.secrets = secrets; original.globalStorageUri = { fsPath: storage };
    original.workspaceState.keys = () => Object.keys(original.workspaceState.values).filter((k) => original.workspaceState.values[k] !== undefined);
    await original.workspaceState.update('future.workspace', { i });
    const workspace = { model: 'workspace-model-' + i }, folder = { fontSize: 13 + i };
    const writes = [];
    const vscode = { Uri: { file: (fsPath) => ({ fsPath }) }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
      workspace: { workspaceFolders: [{ uri: { fsPath: project } }], getConfiguration(_section, resource) {
        return { get: (key, fallback) => (resource ? folder[key] : undefined) ?? workspace[key] ?? user[key] ?? fallback,
          inspect: (key) => ({ globalValue: user[key], workspaceValue: resource ? workspace[key] : undefined, workspaceFolderValue: resource ? folder[key] : undefined }),
          async update(key, value, target) {
            writes.push({ key, value, target }); const map = target === 1 ? user : target === 2 ? workspace : folder;
            if (value === undefined) delete map[key]; else map[key] = structuredClone(value);
          } };
      } } };
    slots.push({ i, project, original, vscode, workspace, folder, writes, source: null, engine: null, returned: null });
  }
  const profile = profileID(storage), directory = sourceDirectory(home);
  async function open(slot, { seed = false, productionAdapters = false, keeper, keeperSnapshot, server } = {}) {
    const sourceInstall = slot.install || install;
    const workspace = require('../../src/sourceWorkspace').identity(slot.vscode.workspace);
    const importers = returnAdapters({ profile, authorityFile: path.join(storage, 'cutover.authority'),
      snapshotsFile: workspace ? path.join(storage, 'cutover-' + require('../../src/engineOwner').hash(workspace).slice(0, 12) + '.snapshots') : null }, slot.original, slot.vscode);
    let deliveryError;
    try {
      await recovery.deliver({ directory, profile, install: sourceInstall, workspace, context: slot.original,
        apply: importers.importWorkspace, validate: importers.canDeliverWorkspace });
    } catch (error) { deliveryError = error; }
    const source = createLegacyActivation(slot.original, { home, install: sourceInstall, workspace });
    if (deliveryError || recovery.pending(slot.original, workspace)) { source.requireRecovery(); source.recoveryProblem = deliveryError?.code; }
    source.snapshotsFile = workspace ? path.join(storage, 'cutover-' + require('../../src/engineOwner').hash(workspace).slice(0, 12) + '.snapshots') : null;
    source.listenerFile = workspace ? path.join(storage, 'cutover-' + require('../../src/engineOwner').hash(workspace).slice(0, 12) + '.listener') : null;
    slot.source = source;
    if (source.needsAdmission) await source.ready();
    let engine;
    if (!source.service && !source.recovering) {
      engine = createEngine({ context: source.context, settings: settings(), paths: { home, projects: path.join(home, '.claude/projects'), storage,
        codexCache: path.join(storage, 'cache' + slot.i) }, spawner: fake.spawnFn, codex: { unavailableReason: 'fixture' } });
      require('../../src/legacyExtensionSource').protect(engine, source); engines.push(engine);
      engine.manager.restoreOpen();
      require('../../src/legacyExtensionSource').restoreSnapshots(source, engine);
      if (seed && !engine.manager.get('session-' + slot.i)) engine.manager.create({ id: 'session-' + slot.i, cwd: slot.project, autoStart: false });
    }
    slot.engine = engine;
    if (productionAdapters) {
      engine.delivery = { identity, vapid, devices: { list: () => [] } };
      await require('../../src/legacyExtensionSource').listen(source, { context: source.context, originalContext: slot.original,
        vscode: slot.vscode, engine, keeper, keeperSnapshot, server, becomeClient() {}, restoreLegacy() { slot.restored = true; } });
      return source;
    }
    let exported;
    await source.listen({
      review: async () => ({ ready: true, blockers: [], fingerprint: identity.fingerprint,
        listener: { configuredPort: user['remote.port'], listening: false, port: 0 },
        hostInventory: { complete: true, pids: slots.filter((s) => s.source).map(() => process.pid), windows: slots.filter((s) => s.source).length },
        conversations: engine?.manager.list.length || 0, queues: 0, devices: 0 }),
      closeAdmission() { require('../../src/legacyExtensionSource').saveSnapshots(source, engine); }, cancel() {}, drain() {}, flush: () => engine?.flush(),
      async detach() {
        exported = await exportSelectedContext({ context: source.context, engine, settings: capturedSettings(slot.vscode, engine, profile),
          provenance: { profile, workspace, rawScope: 'workspace' }, selection: { fingerprint: identity.fingerprint,
            applicationServerKey: vapid.applicationServerKey }, secrets,
          files: { sessions: () => engine.manager.list.map((s) => s.snapshot()), keeper: () => null,
            sourceFolders: () => require('../../src/sourceWorkspace').roots(slot.vscode.workspace) }, keeper: { metaVersion: 1, runs: [] } });
      },
      async releaseResources() { await engine.dispose(); return { released: true, owned: ['fixture-window'] }; },
      exportState: () => exported, becomeClient() {},
      ...importers, importShared: async (state, member) => { slot.returned = state; await importers.importShared(state, member); },
      restoreLegacy() { slot.restored = true; }
    });
    return source;
  }
  async function close(slot) {
    const source = slot.source; slot.source = null;
    try { await slot.engine?.dispose(); } catch (e) { if (!['WRITER_FENCED', 'WRITER_SEALED', 'STALE_GENERATION'].includes(e.code)) throw e; }
    await source?.dispose(); slot.engine = null;
  }
  for (const slot of slots) await open(slot, { seed: true });
  return { home, selection, profile, directory, slots, adapter, global, secrets, user, dependencies, open, close,
    coordinator: (extra = {}) => {
      // Fixture reloads are synchronous; retain a short bounded wait for the
      // explicit reload-gap cases without sleeping five seconds for every
      // intentionally closed-window cell in the full recovery matrix.
      const coordinator = createProductionCutover({ selection, secretAdapter: adapter, returnWaitMs: 500, ...extra });
      const afterReload = async (operation) => {
        const result = await operation();
        // Native restore schedules an editor reload. Rebuild the fixture's
        // engine too, instead of treating its disposed manager as usable.
        for (const slot of slots) if (slot.source && slot.restored) {
          slot.restored = false; await close(slot); await open(slot);
        }
        return result;
      };
      return { ...coordinator, restore: () => afterReload(coordinator.restore), handback: () => afterReload(coordinator.handback) };
    },
    async start(extra = {}) { runtime = await require('../../src/productionRuntime').startProductionRuntime({ selection, secretAdapter: adapter, dependencies: { ...dependencies, ...extra } }); return runtime; },
    get runtime() { return runtime; },
    async stop() { await runtime?.stop(); runtime = null; },
    async cleanup() { await runtime?.stop(); for (const slot of slots) await close(slot); for (const engine of engines) await engine.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
  };
}
module.exports = { productionFixture };

