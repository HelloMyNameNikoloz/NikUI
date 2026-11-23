'use strict';

// Real production graph. P2's isolated daemon and synthetic machine adapters
// are not imported here. A validated committed source and selected SecItem
// generation are required before constructing any service.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { privateRoot, privateDirectory, privateFile, checkPrivateTree, fail } = require('./daemonPaths');
const { committedOwnership } = require('./productionOwnership');
const { createSelectedImporter, exportSelectedContext } = require('./engineImport');
const { createPrivateStore } = require('./privateStore');
const { acquireRootLock } = require('./daemonLock');
const { createProductionComposition } = require('./productionComposition');
const { createDaemonConfig } = require('./daemonConfig');
const { openAuthority } = require('./jsonlAuthority');
const { createEngineState, DOMAIN } = require('./engineState');
const { createMachineHost } = require('./machineHost');
const { createRemoteResources } = require('./remoteRuntime');
const { createDevelopmentBridge } = require('./developmentBridge');
const { createDaemonManagement } = require('./daemonManagement');
const { createMenuManagement, defaults } = require('./menuManagement');
const { createLocalDeviceEnrollment } = require('./localDeviceEnrollment');
const { createDesktopNotifications } = require('./desktopNotifications');
const { createControl } = require('./daemonControl');
const { enableIsolatedProtocol, disableIsolatedProtocol } = require('./isolatedProtocol');
const { LocalKey } = require('./auth');
const { CORE } = require('./protocolV2');
const { atomicJson, hash } = require('./engineOwner');
const { GLOBAL_KEYS, WORKSPACE_KEYS } = require('./engineTransfer');
const unavailable = () => { throw fail('CAPABILITY_UNAVAILABLE', 'This optional adapter is unavailable'); };

async function startProductionRuntime({ selection, secretAdapter, dependencies = {} }) {
  const ownership = committedOwnership(selection.root);
  let drainingTransition;
  const writerOptions = () => drainingTransition ? { transition: drainingTransition, drain: true } : {};
  const assertCurrent = () => ownership.assertCurrent(writerOptions());
  const privatePaths = privateRoot(selection.root, { create: false }), paths = { ...privatePaths, home: selection.home };
  checkPrivateTree(paths.root);
  const lock = await acquireRootLock(paths);
  try { ownership.assertCurrent(); }
  catch (error) { lock.release(); throw error; }
  const importer = createSelectedImporter({ root: selection.root, target: selection.label, owner: ownership.owner, secretAdapter });
  let composition, authority, currentState, bridge, management, menu, desktop, devices, control, keeper, exposure;
  let running = false, closing, phase = 'starting';
  let returnExport, returnToken;
  const generation = ownership.generation + ':' + crypto.randomBytes(16).toString('hex');
  const stop = () => closing ||= (async () => {
    const errors = [];
    const finish = async (action) => { try { await action(); } catch (e) {
      if (!['WRITER_FENCED', 'WRITER_SEALED', 'STALE_GENERATION'].includes(e.code)) errors.push(e);
    } };
    const journal = (await ownership.owner.recover()).transition;
    if (journal?.to === 'window' && journal.generation === ownership.record.generation) drainingTransition = journal.token;
    running = false; phase = 'draining'; currentState?.beginDrain();
    if (composition?.engine.remote) disableIsolatedProtocol(composition.engine.remote);
    bridge?.dispose(); menu?.dispose();
    await finish(() => control?.dispose()); await finish(() => desktop?.dispose());
    await finish(() => management?.flush()); await finish(() => devices?.flush());
    await finish(() => composition?.engine.flush()); await finish(() => currentState?.dispose());
    await finish(() => composition?.dispose()); await finish(() => keeper?.close());
    await finish(() => authority?.close()); importer.dispose(); lock.release(); phase = 'stopped';
    if (errors.length) throw errors[0];
  })();
  try {
    const imported = await importer.openCommitted({ writerOptions }), state = imported.state, store = imported.store;
    const selected = state.sources.find((s) => s.id === imported.transfer.selection.source) || state.sources[0];
    const mergedSettings = { ...selected.settings, projects: [...new Map(state.sources.flatMap((s) => s.settings.projects).map((p) => [p.root, p])).values()] };
    const stateGenerationFile = path.join(selection.root, 'production-state-generation.json');
    const priorState = privateFile(stateGenerationFile, { optional: true }) ? require('./daemonPaths').readPrivateJson(stateGenerationFile) : null;
    if (priorState && priorState.generation !== ownership.record.generation && fs.existsSync(paths.state))
      fs.renameSync(paths.state, path.join(selection.root, 'retired-state-' + priorState.generation));
    const legacyQueueBarrier = priorState?.generation === ownership.record.generation && priorState.legacyQueueBarrier === true ||
      !privateFile(path.join(paths.state, 'authority.jsonl'), { optional: true });
    atomicJson(stateGenerationFile, { version: 1, generation: ownership.record.generation, legacyQueueBarrier });
    privateDirectory(paths.state); privateDirectory(path.join(selection.root, 'tmp'));
    const mirrors = { globalState: createPrivateStore(path.join(paths.state, 'global.json'), { initial: selected.global, assertCurrent }),
      workspaceState: createPrivateStore(path.join(paths.state, 'workspace.json'), { initial: selected.workspace, assertCurrent }) };
    const settings = createDaemonConfig({ ...mergedSettings, persist: async (_next, change) => {
      const committed = await authority.commit((saved) => { ownership.assertCurrent(); saved.values[DOMAIN].settings.user[change.key] = change.value; });
      return committed.values[DOMAIN].settings;
    } });
    keeper = require('./productionKeeper').createProductionKeeper({ root: selection.root, store: mirrors.globalState,
      sources: imported.transfer.sources.map((s) => s.state), ...(dependencies.keeperFactory ? { factory: dependencies.keeperFactory } : {}) });
    composition = await createProductionComposition({ selection: { ...selection, flavour: 'prod' }, generation,
      ownership: { ...ownership, generation, assertCurrent }, context: mirrors, secretStore: store, settings,
      approvedProjects: [...new Set(state.sources.flatMap((s) => s.settings.projects.map((p) => p.root)))],
      codexHome: path.join(selection.home, settings.get('codexAccount') === 'personal' ? '.codex' : '.codex-work'),
      selectedPins: store.get('nikd.selection'), dependencies: { ...dependencies, ...(keeper ? { keeperSpawn: keeper.spawner() } : {}) } });
    const engine = composition.engine;
    if (engine.ledger && !fs.existsSync(engine.ledger.file)) engine.ledger.data = structuredClone(state.ledger);
    const initial = state.authority ? structuredClone(state.authority) : { v: 1, engineId: crypto.randomBytes(16).toString('hex'),
      scope: crypto.randomBytes(16).toString('hex'), clockHighWater: Date.now(), entries: [], outbox: [], values: {} };
    if (!initial.values[DOMAIN] || !state.completeAuthority) initial.values[DOMAIN] = { v: 1, nextEntity: initial.values[DOMAIN]?.nextEntity || 0,
      instances: state.instances.map(({ queue, ...meta }) => meta), retiredInstances: [],
      folders: mergeFolders(state.sources), settings: mergedSettings, account: { ...selected.account, knownReset: null } };
    authority = await openAuthority({ file: path.join(paths.state, 'authority.jsonl'), initialState: initial });
    if (!authority.status().writable) throw fail('AUTHORITY_UNAVAILABLE', 'Current receipt authority is unavailable');
    dependencies.fault?.('runtime:authority-open');
    settings.refreshAll(authority.snapshot().values[DOMAIN].settings);
    currentState = await createEngineState({ authority, engine, startQueued: true,
      refreshSettings: (values) => settings.refresh(values), authorize: ({ access, context, message }) => {
        if (context.principal === 'local:legacy') return context.seat?.local === true;
        if (context.principal.startsWith('local-client:')) return context.seat?.local === true &&
          store.get('nikd.developmentClients.v1', []).some((c) => !c.revoked && context.principal === 'local-client:' + c.id);
        const device = context.principal.startsWith('device:') && engine.delivery.devices.get(context.principal.slice(7));
        return !!device && (access === 'view' || require('./mutationGrants').mayMutate({ ...context,
          seat: { ...context.seat, control: device.control === true, local: device.local === true && device.control === true } }, message));
      } });
    currentState.restoreEngine();
    dependencies.startupProgress?.('keeper-attach');
    if (keeper) await engine.manager.reattach(keeper);
    dependencies.startupProgress?.('keeper-attached');
    const snapshotsFile = path.join(paths.state, 'current-snapshots.json');
    const snapshots = privateFile(snapshotsFile, { optional: true }) ? require('./daemonPaths').readPrivateJson(snapshotsFile).sessions
      : state.sources.flatMap((s) => s.files.sessions || []);
    for (const snapshot of snapshots) {
      const session = engine.manager.get(snapshot.id);
      if (session && !session.proc && !session.items.length) session.hydrate(snapshot);
    }
    const flushEngine = engine.flush;
    let snapshotsClosed = false;
    engine.flush = () => {
      if (snapshotsClosed) return;
      assertCurrent(); flushEngine();
      if (engine.ledger && fs.existsSync(engine.ledger.file)) fs.chmodSync(engine.ledger.file, 0o600);
      atomicJson(snapshotsFile, { version: 1, sessions: engine.manager.list.map((s) => s.snapshot()) });
    };
    // A legacy queue has no receipt IDs. Allocate stable import mids through
    // the real dispatcher before opening drains. Restart repeats only receipt
    // lookups, never inputs that already crossed a dispatch marker.
    const legacyImportComplete = authority.snapshot().values['engine.legacyImportComplete.v1'] === ownership.record.transition;
    if (!state.completeAuthority && !legacyImportComplete) for (const queue of state.queues) for (const item of queue.items) {
      if (state.authority?.outbox.some((q) => q.queueId === item.id)) continue;
      const target = 'session:' + queue.instance;
      const mid = hash([ownership.record.transition, queue.instance, item.id]).slice(0, 32);
      const prior = authority.snapshot().entries.find((entry) => entry.mid === mid && entry.principal === 'local:legacy' && entry.target === target);
      const answer = await currentState.dispatch({ authenticated: true, principal: 'local:legacy', target, role: 'conversation',
        seat: { id: 'legacy-import', local: true, control: true, editor: false } }, {
        type: 'send', text: item.text, ...(item.sent ? { sent: item.sent } : {}), attachments: item.attachments || [],
        snippets: item.snippets || [], scope: authority.snapshot().scope, mid,
        issuedAt: prior?.issuedAt ?? Math.max(Date.now(), authority.snapshot().clockHighWater) });
      if (answer?.outcome === 'rejected') throw fail('IMPORT_QUEUE_REFUSED', 'A legacy queued input could not be admitted');
    }
    // Provider/service admission comes after this fsynced marker. Its absence
    // under the recorded startup contract proves unregistered legacy prompts
    // are still pending work, rather than inputs the provider may have seen.
    if (!state.completeAuthority && !legacyImportComplete) await authority.commit((saved) => {
      assertCurrent(); saved.values['engine.legacyImportComplete.v1'] = ownership.record.transition;
    });
    const resources = createRemoteResources({ home: selection.home });
    const runProjectTool = dependencies.prRun || ((name, args, options = {}) => new Promise((resolve) => {
      try { ownership.assertCurrent(); } catch (_) { resolve({ ok: false, stdout: '', code: 'WRITER_FENCED' }); return; }
      const executable = name === 'git' ? '/usr/bin/git' : name === 'gh' ? composition.tools.gh?.path : null;
      if (!executable || !settings.get('watchCIAfterPush', true)) { resolve({ ok: false, stdout: '', code: 'TOOL_MISSING' }); return; }
      require('child_process').execFile(executable, args, { ...options, env: composition.childEnv, timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => resolve({ ok: !error, stdout: String(stdout || ''), code: error ? 'PROJECT_TOOL_UNAVAILABLE' : null }));
    }));
    engine.createPrCi({ runners: { links: runProjectTool, feed: runProjectTool, ci: runProjectTool },
      autoWatch: (session) => settings.forProject(session?.cwd).get('watchCIAfterPush', true) });
    const info = { id: authority.snapshot().engineId, boot: crypto.randomBytes(16).toString('hex'), version: require('../package.json').version, mode: 'service' };
    const host = createMachineHost({ manager: engine.manager, settings, ledger: engine.ledger, devices: engine.delivery.devices,
      codex: () => engine.codex, prFeed: engine.prCi.feed, editor: { providers: () => bridge?.providers() || [] },
      env: { home: selection.home, reach: { sealed: true, appOnly: true } } });
    const remote = engine.createRemote({ root: path.resolve(__dirname, '..'), host, resources, localKey: new LocalKey(), codex: engine.codex,
      applicationProtocol: { engine: info, caps: [...CORE, 'editor-route-v1'], receipts: () => currentState.dispatcher.receiptInfo() },
      ownership: { terminals: 'owned', voice: 'owned', appUpdate: 'owned' }, requireSealed: () => true, appOnly: () => true,
      projects: () => settingsProjects(), createInstance: ({ cwd }) => {
        ownership.assertCurrent(); if (!running || !settingsProjects().includes(cwd)) throw fail('PROJECT_APPROVAL_REQUIRED', 'Choose an approved project');
        return engine.manager.create({ cwd, autoStart: false });
      }, report: () => status() });
    const settingsProjects = () => authority.snapshot().values[DOMAIN].settings.projects.map((p) => p.root);
    bridge = createDevelopmentBridge({ paths, secrets: store, remote, currentState, engineInfo: info,
      fingerprint: store.get('nikd.selection').fingerprint, running: () => running, management: () => management, mode: 'production' });
    management = createDaemonManagement({ engine, paths, authority, currentState, settings, secrets: store,
      generation, running: () => running, bridge: () => bridge, keeper, canRun: true,
      provenance: { profile: ownership.record.profile, workspace: paths.root, rawScope: 'service' }, approvedProjects: settingsProjects,
      adapters: { menu: (...args) => menu.command(...args) } });
    desktop = createDesktopNotifications({ engine, engineID: info.id, authority, changed: () => menu?.changed() });
    engine.delivery.notifier.eventIdentity = desktop.identity;
    function status() {
      return { ok: true, mode: 'production', root: paths.root, generation, pid: process.pid, engine: info, state: phase,
        lifecycle: { phase }, bridge: bridge.status(), account: { home: engine.account.home, borrowed: engine.codex.client.ownership === 'borrowed' },
        listener: { host: '127.0.0.1', port: remote.port }, tools: composition.tools, blockers: [], warnings: exposure?.warnings || [], policy: engine.policy.state(),
        keeper: { runs: engine.manager.list.filter((s) => s.proc?.kept).map((s) => ({ instance: s.id, runID: s.proc.runId, childPID: s.proc.pid, directory: s.proc.link.dir })) },
        authority: { writable: authority.status().writable, currentState: currentState.status() } };
    }
    menu = createMenuManagement({ paths, authority, engine, status, bridge: () => bridge, desktop,
      activeSettings: { ...defaults(selection.home), codexHome: engine.account.home }, pinnedNode: process.execPath,
      refreshTools: async () => {} });
    devices = createLocalDeviceEnrollment({ authority, devices: engine.delivery.devices, identity: engine.delivery.identity,
      engine: info, generation, port: () => remote.port, running: () => running });
    const routes = require('./routeContinuity').transferredRoutes(state.sources);
    await composition.start(); await remote.start(routes[0]?.localPort ?? settings.get('remote.port', 4517), { exactly: true });
    exposure = await require('./routeContinuity').attachRoutes({ sources: state.sources, remote,
      ...(dependencies.tailscale ? { tailscale: dependencies.tailscale } : {}) });
    phase = 'running'; running = true; currentState.start();
    enableIsolatedProtocol({ remote, engine, currentState, authority, paths, bridge, running: () => running });
    control = await createControl({ paths, connect: (r, s, i) => bridge.connect(r, s, i), observe: (r, s) => menu.observe(r, s),
      handle: async (request, { progress }) => {
        if (['status', 'doctor'].includes(request.op)) return status();
        if (request.op === 'transition.stop') {
          const journal = (await ownership.owner.recover()).transition;
          if (journal?.to !== 'window' || journal.generation !== ownership.record.generation) return { ok: false, code: 'STALE_COORDINATOR' };
          drainingTransition = journal.token;
          setTimeout(() => { void stop().catch(() => { process.exitCode = 1; }); }, 25).unref();
          return { ok: true };
        }
        if (request.op === 'transition.review') {
          try { await exposure.review(); return { ok: true, warnings: exposure.warnings,
            ...require('./engineHandoff').plannedTransitionReadiness({ currentState, engine, resources, keeper }) }; }
          catch (e) { return { ok: true, ready: false, code: e.code, blockerDetails: [e.diagnostics || { code: e.code, message: e.message }] }; }
        }
        if (request.op === 'transition.export') {
          try {
            if (returnExport && returnToken === request.transition) return { ok: true, exported: returnExport };
            returnToken = request.transition;
            drainingTransition = returnToken;
            const gate = require('./engineTransfer').createParticipantGate({ owner: ownership.owner, member: ownership.record.member });
            const select = (source, keys) => ({ keys: () => keys.filter((key) => source.get(key) !== undefined), get: source.get.bind(source) });
            let captured;
            returnExport = await gate.quiesce(returnToken, {
              progress,
              readiness: async () => { await exposure.review(); return require('./engineHandoff').plannedTransitionReadiness({ currentState, engine, resources, keeper }); },
              closeAdmission() { running = false; phase = 'returning'; currentState.beginDrain(); disableIsolatedProtocol(remote); bridge.dispose(); },
              cancel() {}, drain: () => currentState.flush(), flush: async () => { engine.flush(); await desktop.flush(); await currentState.flush(); },
              async detach(advance) {
                const global = { get: (key) => ['nikui.devices', 'nikui.deviceTrail'].includes(key) ? store.get(key) : mirrors.globalState.get(key) };
                captured = await exportSelectedContext({ progress: advance, context: { globalState: select(global, GLOBAL_KEYS),
                  workspaceState: select(mirrors.workspaceState, WORKSPACE_KEYS) }, engine,
                  settings: authority.snapshot().values[DOMAIN].settings,
                  provenance: { profile: ownership.record.profile, workspace: selection.root, rawScope: 'service-current' },
                  selection: store.get('nikd.selection'), secrets: { get: store.get.bind(store) },
                  files: { sessions: () => engine.manager.list.map((s) => s.snapshot()), keeper: () => keeper ? { directory: keeper.dir } : null,
                    keepers: () => keeper?.directories || [], routes: () => exposure.routes, routeWarnings: () => exposure.warnings,
                    workspaces: () => state.sources }, authority, completeAuthority: true, keeper: { metaVersion: 1, runs: [] } });
                const sessions = engine.manager.list.slice();
                if (keeper) {
                  captured.keeper = await require('./keeperContinuity').releaseKeeper(keeper, sessions);
                }
              },
              async releaseResources() { await remote.stop(); await desktop.dispose(); await currentState.dispose(); await composition.dispose(); snapshotsClosed = true; await keeper?.close();
                return { released: true, owned: ['service-writer', 'power-policy', 'loopback-listener'] }; },
              exportState: () => captured,
              saveExport: (value) => require('./cutoverRecovery').saveExport(path.join(selection.root, 'production-return-export.json'), value, secretAdapter, returnToken)
            });
            return { ok: true, exported: returnExport };
          } catch (e) { return { ok: false, code: e.code || 'CURRENT_STATE_EXPORT_REQUIRED' }; }
        }
        if (request.op === 'local') return bridge.localRequest(request);
        if (request.op === 'enroll' && running) return request.device !== undefined ? devices.enroll(request) : bridge.enroll(request);
        return { ok: false, code: 'CONTROL_UNSUPPORTED' };
      } });
    const journal = (await ownership.owner.recover()).transition;
    if (journal.phase !== 'released') {
      await ownership.owner.started(journal.token, { generation: ownership.record.generation, target: selection.label,
        hash: journal.hash, oldResourcesReleased: true }); await ownership.owner.release(journal.token);
    }
    atomicJson(path.join(selection.root, 'production-health.json'), { version: 1, generation, pid: process.pid, engineID: info.id });
    return { engine, authority, currentState, status, stop, ownership, importer, paths, resources, keeper };
  } catch (e) { await stop(); throw e; }
}
function mergeFolders(sources) {
  const folders = new Map(), assign = {}, byConversation = {};
  for (const source of sources) {
    for (const folder of source.folders.folders) folders.set(folder.id, folder);
    Object.assign(assign, source.folders.assign); Object.assign(byConversation, source.folders.byConversation);
  }
  return { folders: [...folders.values()], assign, byConversation };
}
module.exports = { startProductionRuntime, mergeFolders };
