'use strict';
const path = require('path'), os = require('os'), fs = require('fs');
const { createLegacyActivation } = require('./legacySource');
const { exportSelectedContext } = require('./engineImport');
const { disposition, PROJECT } = require('./daemonConfig');
const { identity: workspaceIdentity, roots: workspaceRoots } = require('./sourceWorkspace');

function prepare(context, vscode) {
  const production = context.extensionMode === (vscode.ExtensionMode?.Production ?? 1);
  const rehearsal = context.extensionMode === (vscode.ExtensionMode?.Test ?? 3) && process.env.NIKUI_P3_LEGACY_REHEARSAL === '1' &&
    os.homedir().startsWith('/private/tmp/nik-mac/build/');
  if (!production && !rehearsal || !context.globalStorageUri?.fsPath) return null;
  // Extension paths include the version. The extension id and selected
  // profile are the durable installation identity across updates/relocation.
  const install = context.extension?.id || require('../package.json').publisher + '.' + require('../package.json').name;
  const workspace = workspaceIdentity(vscode.workspace);
  const source = createLegacyActivation(context, { home: os.homedir(), install,
    workspace });
  source.recoveryVSCode = vscode;
  const directory = require('./legacySource').sourceDirectory(os.homedir());
  const scope = require('./engineOwner').hash(workspace).slice(0, 12);
  const recovery = require('./cutoverRecovery'), storage = context.globalStorageUri.fsPath;
  source.snapshotsFile = workspace ? path.join(storage, 'cutover-' + scope + '.snapshots') : null;
  source.listenerFile = workspace ? path.join(storage, 'cutover-' + scope + '.listener') : null;
  source.authorityFile = path.join(storage, 'cutover.authority');
  source.keeperFile = workspace ? path.join(storage, 'cutover-' + scope + '.keepers') : null;
  for (const extension of ['snapshots', 'keepers', 'keepers.store']) {
    const obsolete = path.join(directory, source.profile + '.' + scope + '.' + extension);
    recovery.obsolete(obsolete, 'OBSOLETE_' + extension.toUpperCase());
  }
  recovery.obsolete(path.join(directory, source.profile + '.authority'), 'OBSOLETE_AUTHORITY');
  if (source.keeperFile && fs.existsSync(source.keeperFile)) {
    try { source.keeperTransfer = require('./daemonPaths').readPrivateJson(source.keeperFile); }
    catch (e) { source.requireRecovery(); source.recoveryProblem = e.code || 'KEEPER_ARTIFACT_CORRUPT'; }
  }
  recovery.obsolete(recovery.restoreFile(directory, source.profile, workspace));
  source.pendingRestore = recovery.pending(context, workspace);
  const adapters = returnAdapters(source, context, vscode);
  source.deliverRestore = (options = {}) => require('./cutoverRecovery').deliver({ directory, profile: source.profile,
    install, workspace, context, ...options,
    apply: adapters.importWorkspace, validate: adapters.canDeliverWorkspace });
  source.forgetRestore = (expected) => recovery.forget(context, workspace, expected);
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (source.legacy && workspaceRoots(vscode.workspace).some((root) =>
      [...PROJECT].some((key) => event.affectsConfiguration('nikui.' + key, vscode.Uri.file(root))))) source.revokeWorkspace();
  }));
  return source;
}
function returnListener(source, configuredPort) {
  if (!source?.listenerFile || !fs.existsSync(source.listenerFile)) return null;
  const saved = require('./daemonPaths').readPrivateJson(source.listenerFile);
  if (saved.version !== 1 || saved.listening !== true || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535 ||
      saved.configuredPort !== configuredPort) { require('./cutoverRecovery').discard(source.listenerFile); return null; }
  return saved;
}
async function startReturnedListener(server, source, configuredPort, notify = () => {}) {
  const returned = returnListener(source, configuredPort);
  await server.start(returned?.port ?? configuredPort);
  if (returned) {
    require('./cutoverRecovery').discard(source.listenerFile);
    if (server.port !== returned.port) notify(
      `NikUI returned to VS Code on port ${server.port}. Its previous port ${returned.port} is in use; reconnect using this window’s new address.`);
  }
  return server;
}
function returnedKeeper(source, options = {}) {
  const recovery = require('./cutoverRecovery');
  const store = require('./privateStore').createPrivateStore(source.keeperFile + '.store');
  const keeper = require('./productionKeeper').createProductionKeeper({ root: path.dirname(source.keeperFile), store,
    ownDirectory: new (require('./keeperLink').KeeperLink)().dir, sources: [source.keeperTransfer], ...options });
  const transferred = new Set((source.keeperTransfer.keeper?.transferred || []).map((run) => run.runId));
  let ended = false;
  const cleanup = () => { recovery.discard(source.keeperFile); recovery.discard(source.keeperFile + '.store'); };
  async function prune() {
    try {
      const listing = await keeper.request({ t: 'list' });
      if (listing.ok && !listing.runs.some((run) => transferred.has(run.runId) && !run.exit)) { ended = true; cleanup(); }
    } catch (_) { /* Unavailable is not proof that a borrowed run ended. */ }
  }
  return { ...keeper,
    async attach(session) {
      const attached = await keeper.attach(session);
      if (attached === true) session.proc?.once('exit', () => { void prune(); });
      await prune(); return attached;
    },
    async close() {
      await prune(); await keeper.close(); store.dispose();
      if (ended) cleanup();
    }
  };
}
function restoreSnapshots(source, engine) {
  if (!source.snapshotsFile || !fs.existsSync(source.snapshotsFile)) return;
  try {
    const saved = require('./daemonPaths').readPrivateJson(source.snapshotsFile);
    const retained = [];
    for (const snapshot of saved.sessions) {
      const session = engine.manager.get(snapshot.id) || engine.manager.create({ ...snapshot, title: snapshot.customTitle,
        resume: snapshot.claudeSessionId, autoStart: false });
      if (session && session.cwd === snapshot.cwd && !session.proc) session.hydrate(snapshot);
      else retained.push(snapshot);
    }
    if (retained.length) { require('./engineOwner').atomicJson(source.snapshotsFile, { ...saved, sessions: retained }); return; }
  } catch (e) { require('./cutoverRecovery').logDiscard(e.code || 'SNAPSHOT_CORRUPT'); }
  // A recovery snapshot is a one-time delivery. Replaying it on a later
  // ordinary reload could resurrect a queue the user has since sent/deleted.
  require('./cutoverRecovery').discard(source.snapshotsFile);
}
function saveSnapshots(source, engine) {
  if (source.snapshotsFile) require('./engineOwner').atomicJson(source.snapshotsFile,
    { version: 1, sessions: engine.manager.list.map((s) => s.snapshot()) });
}
function protect(engine, source) {
  const dispose = engine.dispose.bind(engine);
  let closing = false;
  engine.dispose = () => {
    if (!closing) {
      closing = true;
      // A window can reload at the barrier before source.freeze reaches it.
      // Its slim memento cannot preserve transcript/attachment bytes alone.
      if (source.needsRecoverySnapshot) saveSnapshots(source, engine);
    }
    return dispose();
  };
  const guard = (object, names) => { if (!object) return; for (const name of names) if (typeof object[name] === 'function') {
    const original = object[name]; object[name] = function (...args) { return source.admit(() => original.apply(this, args)); };
  } };
  guard(engine.manager, ['create', 'remove', 'removeStopped', 'sleep', 'setLimits', 'resumeFromLimit']);
  guard(engine.codex, ['create', 'resume']);
  guard(engine.codex.client, ['_write']);
  if (engine.codex.ipc) guard(engine.codex.ipc, ['_write']);
  const previous = engine.manager.prepareSession;
  engine.manager.prepareSession = (session) => {
    previous?.(session);
    let proc = session.proc;
    Object.defineProperty(session, 'proc', { configurable: true, enumerable: true,
      get: () => proc, set(value) {
        proc = value;
        if (value?.stdin && !value.stdin._sourceFenced) {
          const write = value.stdin.write.bind(value.stdin);
          value.stdin.write = (...args) => source.admit(() => write(...args)); value.stdin._sourceFenced = true;
        }
      } });
    guard(session, ['start', 'send', 'submit', 'enqueue', 'interrupt', 'answerPermission', 'answerQuestion', 'stopTask', 'restart']);
  };
}
function capturedSettings(vscode, engine, profile) {
  const keys = Object.keys(require('../package.json').contributes.configuration.properties).map((s) => s.slice(6));
  const config = vscode.workspace.getConfiguration('nikui'), user = {};
  for (const key of keys) {
    if (disposition(key) === 'editor-only') continue;
    const raw = config.inspect(key);
    if (raw?.globalValue !== undefined) user[key] = structuredClone(raw.globalValue);
  }
  const scopes = [];
  const projects = [...new Set([...(vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    ...engine.manager.list.map((s) => s.cwd), ...engine.codex.list.map((s) => s.cwd)])].map((root) => {
    const cfg = vscode.workspace.getConfiguration('nikui', vscode.Uri.file(root)), values = {}, workspace = {}, folder = {};
    for (const key of PROJECT) {
      const raw = cfg.inspect(key), value = raw?.workspaceFolderValue ?? raw?.workspaceValue;
      if (value !== undefined) values[key] = structuredClone(value);
      if (raw?.workspaceValue !== undefined) workspace[key] = structuredClone(raw.workspaceValue);
      if (raw?.workspaceFolderValue !== undefined) folder[key] = structuredClone(raw.workspaceFolderValue);
    }
    scopes.push({ root, workspace, folder });
    return { root, approved: true, provenance: { profile, workspace: root, rawScope: 'workspace' }, values };
  });
  return { version: 1, user, projects, editorScopes: { user: structuredClone(user), projects: scopes } };
}
async function listen(source, { context, originalContext = context, vscode, engine, keeper, awake, server, becomeClient, restoreLegacy, transferPanels = () => [] }) {
  let exported, detached = false, serverClosing, requiredSessionIDs = [];
  let wasListening = server?.listening, previousPort = server?.port;
  let wasServing = originalContext.workspaceState.get('nikui.remote.wasServing');
  const workspace = workspaceIdentity(vscode.workspace);
  let originalSubscriptions = [];
  function blockers() {
    const result = [];
    const sessions = [...engine.manager.list, ...engine.codex.list];
    if (sessions.some((s) => (s.items || []).some((i) => i.kind === 'permission' && !i.resolved))) result.push('PENDING_APPROVAL');
    if (engine.manager.list.some((s) => s.catchingUp || s._attaching || s.proc?.state === 'pending' ||
      s.proc && !s.proc.kept && (s.inTurn || s.isBusy || s.backgroundTasks?.length))) result.push('CLAUDE_OWNED_BUSY');
    if (engine.codex.list.some((s) => s.inTurn || s.isBusy)) result.push(engine.codex.client.ownership === 'owned' ? 'CODEX_OWNED_BUSY' : 'BORROWED_CODEX_BUSY');
    if (engine.manager.list.some((s) => s.proc?.kept) && keeper?.metaVersion !== 1) result.push('KEEPER_METADATA_INCOMPLETE');
    if (awake?.state().lid?.held) result.push('LID_CONTINUITY_UNPROVEN');
    if (server?.sourceReleaseReadiness) result.push(...server.sourceReleaseReadiness());
    return result;
  }
  await source.listen({
    review: async () => {
      const issues = blockers();
      let hostInventory;
      try { hostInventory = await require('./sourceWindowInventory').sourceWindowInventory(vscode); }
      catch (_) { issues.push('SOURCE_MANIFEST_INCOMPLETE'); }
      return { ready: issues.length === 0, blockers: issues, fingerprint: engine.delivery.identity.fingerprint,
        storageKeys: { global: await originalContext.globalState.keys?.() || [], workspace: await originalContext.workspaceState.keys?.() || [],
          secrets: await originalContext.secrets.keys?.() || require('./engineTransfer').SECRET_KEYS },
        sourceVersion: context.extension?.packageJSON?.version || require('../package.json').version,
        hostInventory,
        listener: { configuredPort: vscode.workspace.getConfiguration('nikui').get('remote.port', 4517),
          listening: server?.listening === true, port: server?.port || 0 },
        conversations: engine.manager.list.length + engine.codex.list.length,
        devices: engine.delivery.devices.list().length, queues: [...engine.manager.list, ...engine.codex.list].reduce((n, s) => n + s.queue.length, 0) };
    },
    closeAdmission() {
      wasListening = server?.listening; previousPort = server?.port;
      wasServing = originalContext.workspaceState.get('nikui.remote.wasServing');
      requiredSessionIDs = (originalContext.workspaceState.get('nikui.sessions.v1') || []).map((s) => s.id);
      require('./engineTransfer').requireConversations(requiredSessionIDs, [...engine.manager.list, ...engine.codex.list]);
      // Abort/recovery may reload this host even before export completes.
      // Preserve full prompts, attachments and transcript bytes before the
      // legacy memento's intentionally slim dispose-time persistence runs.
      saveSnapshots(source, engine);
      if (source.listenerFile) require('./engineOwner').atomicJson(source.listenerFile,
        { version: 1, listening: server?.listening === true, port: server?.port || 0,
          configuredPort: vscode.workspace.getConfiguration('nikui').get('remote.port', 4517) });
      originalSubscriptions = context.subscriptions.filter((subscription) => subscription !== source);
      serverClosing = server?.stop();
    }, cancel() {}, drain: () => serverClosing, flush: async () => { engine.flush(); },
    async detach(progress) {
      const transferKeeper = keeper?.metaVersion === 1 ? keeper : null;
      const state = await exportSelectedContext({ context, engine, progress, requiredSessionIDs,
        settings: capturedSettings(vscode, engine, source.profile),
        provenance: { profile: source.profile, workspace, rawScope: 'selected-profile' },
        selection: { fingerprint: engine.delivery.identity.fingerprint, applicationServerKey: engine.delivery.vapid.applicationServerKey },
        secrets: context.secrets,
        authority: source.authorityFile && fs.existsSync(source.authorityFile) ? { snapshot: () => require('./daemonPaths').readPrivateJson(source.authorityFile).authority } : null,
        files: { sessions: () => engine.manager.list.map((s) => s.snapshot()), sourceFolders: () => workspaceRoots(vscode.workspace),
          remoteListener: () => ({ version: 1, listening: !!wasListening, port: previousPort || 0,
            configuredPort: vscode.workspace.getConfiguration('nikui').get('remote.port', 4517) }),
          keeper: () => transferKeeper ? { directory: transferKeeper.dir } : null,
          keepers: () => transferKeeper?.directories || (transferKeeper ? [transferKeeper.dir] : []) }, keeper: { metaVersion: 1, runs: [] } });
      if (wasServing === undefined) delete state.workspace['nikui.remote.wasServing']; else state.workspace['nikui.remote.wasServing'] = wasServing;
      state.inventory.workspace = state.inventory.workspace.filter((e) => e.key !== 'nikui.remote.wasServing');
      if (wasServing !== undefined) state.inventory.workspace.push({ key: 'nikui.remote.wasServing', disposition: 'authoritative' });
      const instances = engine.manager.list.slice();
      for (const s of instances) if (s.proc?.kept) s.detach();
      if (transferKeeper) {
        const listing = await transferKeeper.request({ t: 'list' }, 4000);
        if (listing.metaVersion !== 1 || !Array.isArray(listing.runs)) throw Object.assign(new Error('Keeper proof missing'), { code: 'KEEPER_METADATA_INCOMPLETE' });
        const transferred = listing.runs.filter((r) => instances.some((s) => s.id === r.key) && !r.exit)
          .map((r) => ({ ...r, released: !r.owned, compatible: true }));
        state.keeper = { metaVersion: 1, runs: listing.runs, transferred };
      }
      exported = state; detached = true;
    },
    async releaseResources() {
      await server?.sourceRelease?.();
      source.transferredPanels = transferPanels();
      await engine.dispose(); await keeper?.close();
      for (const subscription of originalSubscriptions) await subscription?.dispose();
      // Remove registrations as well as their callbacks before installing the
      // service client. The bridge itself was added after this captured list.
      for (const subscription of originalSubscriptions) {
        const index = context.subscriptions.indexOf(subscription);
        if (index >= 0) context.subscriptions.splice(index, 1);
      }
      source.recoveryUI?.dispose();
      source.recoveryUI = require('./legacyRecoveryUI').showRecovery(originalContext, source.recoveryVSCode || vscode, source, { recovery: true });
      return { released: true, owned: ['window-writer', 'loopback-listener', 'desktop-presentation'] };
    },
    exportState: () => exported,
    async becomeClient(root) {
      source.recoveryUI?.dispose();
      await becomeClient(root);
      source.recoveryUI = require('./legacyRecoveryUI').showRecovery(originalContext, source.recoveryVSCode || vscode, source);
    },
    ...returnAdapters(source, originalContext, vscode, engine),
    async restoreLegacy({ reload = false } = {}) {
      // A proved abort may have detached the source. Rebuild through its
      // existing activation path; keeper-owned runs remain in keeper grace.
      if (originalContext.workspaceState.get('nikui.remote.wasServing') !== wasServing) await originalContext.workspaceState.update('nikui.remote.wasServing', wasServing);
      if (detached || reload) await restoreLegacy();
      else if (wasListening && !server.listening) await server.start(previousPort, { exactly: true });
    }
  });
  context.subscriptions.push(source);
}

// Materialize only the state owned by one workspace. Shared state and secrets
// never enter a deferred delivery.
function workspaceReturn(state, workspace, id = workspace) {
  if (!workspace) return null;
  const selected = state.sources[0], service = selected.files.workspaces || [];
  const original = service.find((s) => s.id === id) || service.find((s) => s.provenance.workspace === workspace);
  const exportedSessionIDs = original?.files.exportedSessionIDs || (original?.workspace['nikui.sessions.v1'] || []).map((s) => s.id);
  const deletedSessionIDs = state.completeAuthority ? state.authority?.values[require('./engineState').DOMAIN]?.retiredInstances || [] : [];
  const oldIDs = new Set(exportedSessionIDs);
  const roots = original?.files.sourceFolders || [workspace];
  const allRoots = service.filter((s) => !state.returnTargets || state.returnTargets.includes(s.provenance.workspace))
    .flatMap((s) => s.files.sourceFolders || [s.provenance.workspace]);
  const allOldIDs = new Set(service.filter((s) => !state.returnTargets || state.returnTargets.includes(s.provenance.workspace))
    .flatMap((s) => s.files.exportedSessionIDs || (s.workspace['nikui.sessions.v1'] || []).map((s) => s.id)));
  const instances = state.instances.filter((s) => oldIDs.has(s.id) || !allOldIDs.has(s.id) &&
    (roots.includes(s.cwd) || workspace === state.returnTargetWorkspace && !allRoots.includes(s.cwd)));
  require('./engineTransfer').requireConversations(exportedSessionIDs, instances, deletedSessionIDs);
  const before = original?.settings || selected.settings;
  return { version: 1, workspace, instances, exportedSessionIDs, deletedSessionIDs, folders: selected.folders,
    beforeWorkspace: original?.files?.legacyWorkspace || original?.workspace || {},
    wasServing: original?.workspace['nikui.remote.wasServing'],
    listener: original?.files.remoteListener,
    projects: roots.map((root) => ({ project: selected.settings.projects.find((p) => p.root === root) || before.projects.find((p) => p.root === root),
      beforeProject: before.projects.find((p) => p.root === root), scopes: before.editorScopes?.projects.find((p) => p.root === root) })),
    sessions: (selected.files.sessions || []).filter((s) => instances.some((i) => i.id === s.id)),
    ...(state.returnKeeper?.transferred?.length ? { keepers: { files: { keepers: selected.files.keepers || [] }, keeper: state.returnKeeper } } : {}) };
}
function returnAdapters(source, originalContext, vscode, engine = null) {
  const workspace = workspaceIdentity(vscode.workspace);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const api = {
    prepareRecovery: (request) => require('./legacyRecoveryUI').retainHelper(originalContext, request),
    async validateReturn(state) {
      if (!state?.instances || !state.queues || (!state.authority || !state.completeAuthority) && !state.returnNeverActivated) {
        throw Object.assign(new Error('Current authority required'), { code: 'CURRENT_STATE_EXPORT_REQUIRED' });
      }
      if (state.authority) require('./jsonlAuthority').validateState(state.authority, require('./jsonlAuthority').LIMITS);
    },
    canDeliverWorkspace(payload, { keepSettings = false } = {}) {
      if (payload?.workspace !== workspace) return false;
      for (const key of require('./engineTransfer').WORKSPACE_KEYS) if (!same(originalContext.workspaceState.get(key), payload.beforeWorkspace?.[key])) return false;
      for (const { project, scopes } of payload.projects || [payload]) if (!keepSettings && scopes && project) {
        const config = vscode.workspace.getConfiguration('nikui', vscode.Uri.file(project.root));
        for (const key of PROJECT) {
          const raw = config.inspect(key);
          if (!same(raw?.workspaceValue, scopes.workspace[key]) || !same(raw?.workspaceFolderValue, scopes.folder[key])) return false;
        }
      }
      return true;
    },
    async importShared(state, { generation, transition, binding, workspaces, progress = () => {} }) {
      if (originalContext.globalState.get('nikui.cutover.shared.v1') === transition) return;
      const selected = state.sources[0];
      const selectedSecrets = state.returnSecrets;
      if (!selectedSecrets) throw Object.assign(new Error('Selected secrets missing'), { code: 'IDENTITY_UNAVAILABLE' });
      // Check bounds and conflicting pending receipts before changing any
      // shared settings, global memento, secrets, ledger or authority.
      await require('./cutoverRecovery').stage(originalContext, { ...binding, generation, transition }, workspaces);
      const configuration = vscode.workspace.getConfiguration('nikui');
      for (const setting of Object.keys(require('../package.json').contributes.configuration.properties)) {
        const key = setting.slice(6);
        if (disposition(key) !== 'editor-only' && !same(configuration.inspect(key)?.globalValue, selected.settings.user[key]))
          await configuration.update(key, selected.settings.user[key], vscode.ConfigurationTarget.Global);
        progress();
      }
      for (const [key, value] of Object.entries(selected.global)) { await originalContext.globalState.update(key, value); progress(); }
      for (const [key, value] of Object.entries(selectedSecrets)) {
        if (['nikui.identity', 'nikui.vapid', 'nikui.devices', 'nikui.deviceTrail'].includes(key)) await originalContext.globalState.update(key, value);
        else await originalContext.secrets.store(key, value);
        progress();
      }
      for (const key of require('./engineTransfer').SECRET_KEYS) if (!Object.hasOwn(selectedSecrets, key) && await originalContext.secrets.get(key) !== undefined)
        await originalContext.secrets.delete(key);
      for (const key of ['nikui.devices', 'nikui.deviceTrail']) if (!Object.hasOwn(selectedSecrets, key)) await originalContext.globalState.update(key, undefined);
      const serviceClientKey = 'nikui.serviceClient.' + require('crypto').createHash('sha256').update(selected.provenance.workspace).digest('hex');
      if (await originalContext.secrets.get(serviceClientKey) !== undefined) await originalContext.secrets.delete(serviceClientKey);
      const ledger = engine?.ledger || new (require('./ledger').Ledger)({ dir: originalContext.globalStorageUri.fsPath });
      ledger.data = state.ledger; ledger.pending = true; ledger.flush();
      if (source.authorityFile) require('./engineOwner').atomicJson(source.authorityFile, { version: 1, generation, authority: state.authority });
      // Each editor-owned receipt authorizes one folder. Only that folder's
      // own later writes revoke its permit; its saved payload remains intact.
      await originalContext.globalState.update('nikui.cutover.shared.v1', transition);
    },
    async importWorkspace(payload, { progress = () => {}, keepSettings = false } = {}) {
      if (!workspace && !payload) return;
      if (payload?.version !== 1 || payload.workspace !== workspace || !Array.isArray(payload.instances) || !Array.isArray(payload.sessions))
        throw Object.assign(Error('Invalid workspace return'), { code: 'RESTORE_SCOPE_MISMATCH' });
      require('./engineTransfer').requireConversations(payload.exportedSessionIDs || (payload.beforeWorkspace?.['nikui.sessions.v1'] || []).map((s) => s.id),
        payload.instances, payload.deletedSessionIDs || []);
      const projects = payload.projects || [payload], shared = {};
      // Multi-folder editor settings share a workspace scope. Keep that
      // baseline and represent differing project changes at folder scope;
      // importing one root must not undo (or change) another root's setting.
      if (projects.length > 1) for (const key of PROJECT) shared[key] = projects.some(({ project }) => project?.values[key] === undefined)
        ? undefined : projects[0].scopes?.workspace[key];
      for (const { project, beforeProject, scopes } of projects) if (!keepSettings && project) {
        const configuration = vscode.workspace.getConfiguration('nikui', vscode.Uri.file(project.root));
        const before = beforeProject?.values || {};
        for (const key of PROJECT) {
          const raw = configuration.inspect(key), unchanged = same(before[key], project.values[key]);
          const folderHadKey = scopes && Object.hasOwn(scopes.folder, key), workspaceHadKey = scopes && Object.hasOwn(scopes.workspace, key);
          const workspaceValue = projects.length > 1 ? shared[key] : scopes ? unchanged || folderHadKey ? scopes.workspace[key]
            : workspaceHadKey ? project.values[key] : scopes.workspace[key] : project.values[key];
          const folderValue = projects.length > 1 ? unchanged && same(workspaceValue, scopes?.workspace[key]) ? scopes?.folder[key]
            : same(project.values[key], workspaceValue) ? undefined : project.values[key]
            : scopes ? unchanged ? scopes.folder[key] : folderHadKey || !workspaceHadKey ? project.values[key] : scopes.folder[key] : undefined;
          if (!same(raw?.workspaceValue, workspaceValue)) await configuration.update(key, workspaceValue, vscode.ConfigurationTarget.Workspace);
          if (!same(raw?.workspaceFolderValue, folderValue)) await configuration.update(key, folderValue, vscode.ConfigurationTarget.WorkspaceFolder);
          progress();
        }
      }
      await originalContext.workspaceState.update('nikui.sessions.v1', payload.instances);
      await originalContext.workspaceState.update('nikui.folders.v1', payload.folders);
      if (originalContext.workspaceState.get('nikui.remote.wasServing') !== payload.wasServing)
        await originalContext.workspaceState.update('nikui.remote.wasServing', payload.wasServing);
      const { Durable, placeOf } = require('./durable');
      const durable = new Durable({ dir: originalContext.globalStorageUri.fsPath, place: placeOf(vscode.workspace) });
      durable.set('nikui.sessions.v1', payload.instances); durable.set('nikui.folders.v1', payload.folders);
      if (source.snapshotsFile) require('./engineOwner').atomicJson(source.snapshotsFile, { version: 1, sessions: payload.sessions });
      if (source.listenerFile && payload.listener) require('./engineOwner').atomicJson(source.listenerFile, payload.listener);
      if (source.keeperFile) {
        if (payload.keepers) require('./engineOwner').atomicJson(source.keeperFile, payload.keepers);
        else {
          require('./cutoverRecovery').discard(source.keeperFile);
          require('./cutoverRecovery').discard(source.keeperFile + '.store');
        }
      }
    }
  };
  return api;
}
async function listenClient(source, { context, vscode, runtime }) {
  await source.listen({
    review: async () => ({ ready: runtime.available, blockers: runtime.available ? [] : ['SERVICE_UNAVAILABLE'],
      hostInventory: await require('./sourceWindowInventory').sourceWindowInventory(vscode),
      fingerprint: runtime.fingerprint || 'unavailable', conversations: (runtime.fleet?.instances?.length || 0) + (runtime.fleet?.codex?.length || 0),
      queues: 0, devices: 0 }),
    ...returnAdapters(source, context, vscode),
    becomeClient() {},
    restoreLegacy() {
      runtime.dispose();
      setTimeout(() => { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }, 250);
    }
  });
  source.recoveryUI = require('./legacyRecoveryUI').showRecovery(context, source.recoveryVSCode || vscode, source);
  context.subscriptions.push(source);
}

async function listenRecovery(source, { context, vscode }) {
  await source.listen({
    review: async () => ({ ready: true, blockers: [], fingerprint: require('./identity').loadIdentity(context.globalState, { required: true }).fingerprint,
      hostInventory: await require('./sourceWindowInventory').sourceWindowInventory(vscode), conversations: 0, queues: 0, devices: 0 }),
    ...returnAdapters(source, context, vscode),
    restoreLegacy() { setTimeout(() => { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }, 50); }
  });
  source.recoveryUI = require('./legacyRecoveryUI').showRecovery(context, source.recoveryVSCode || vscode, source, { recovery: true });
  context.subscriptions.push(source);
}

module.exports = { prepare, protect, listen, capturedSettings, saveSnapshots, restoreSnapshots, listenClient, listenRecovery, returnAdapters, workspaceReturn, returnedKeeper, returnListener, startReturnedListener };
