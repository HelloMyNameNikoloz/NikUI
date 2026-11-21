'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createEngine } = require('./engine');
const { createMachineHost } = require('./machineHost');
const { createRemoteResources } = require('./remoteRuntime');
const { createSelectedDelivery } = require('./daemonDelivery');
const { loadIdentity } = require('./identity');
const { loadVapid } = require('./push');
const { LocalKey } = require('./auth');
const { CodexCache } = require('./codexCache');
const { createPolicyAuthority, createFakePolicyAdapters } = require('./policyOwner');
const { privateRoot, privateDirectory, privateFile, readPrivateJson, checkPrivateTree, noSymlinks, inside, fail } = require('./daemonPaths');
const { createTestStore } = require('./daemonStore');
const { createKeychainStore } = require('./keychainStore');
const { acquireRootLock } = require('./daemonLock');
const { createToolResolver } = require('./toolResolver');
const { createDaemonConfig } = require('./daemonConfig');
const { createControl } = require('./daemonControl');
const { DaemonKeeper } = require('./daemonKeeper');
const { openAuthority } = require('./jsonlAuthority');
const { DOMAIN, initializeEngineState, createEngineState } = require('./engineState');
const { CORE } = require('./protocolV2');
const { createDevelopmentBridge } = require('./developmentBridge');
const { createDaemonManagement } = require('./daemonManagement');
const { createMenuManagement, SETTINGS: MENU_SETTINGS, defaults: menuDefaults, validateSettings: validateMenuSettings } = require('./menuManagement');
const { enableIsolatedProtocol, disableIsolatedProtocol } = require('./isolatedProtocol');

const disabled = () => { throw fail('ISOLATED_PROVIDER_DISABLED', 'P1 isolated daemon cannot launch real providers or machine tools'); };
const noDelivery = async () => ({ ok: false, gone: false, reason: 'Isolated P1 transport' });
const noQuery = async () => ({ stdout: '[]', stderr: '', code: 0 });

/** Private P1 composition only: no installed host, keeper adoption, source
 * import, exposure command, production credentials, hardware or provider
 * fallback. adapters are in-process fixture dependencies, never a CLI plugin.
 */
async function startDaemon({ root, port = 0, adapters = {} } = {}) {
  const paths = privateRoot(root);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw fail('PORT_INVALID', 'Use an explicit loopback port between 0 and 65535');
  const lock = await acquireRootLock(paths);
  const generation = crypto.randomUUID();
  let engine, control, secrets, state, workspaceState, keeper, authority, currentState, bridge, management, menu, closing, running = false;
  const lifecycle = { phase: 'starting', stage: 'composition', completed: [], failed: [] };
  const owned = [], graph = {}, peers = new Set();
  async function stop() {
    if (!closing) closing = (async () => {
      running = false; // Admission closes before any asynchronous disposal.
      lifecycle.phase = 'draining';
      if (engine?.remote) disableIsolatedProtocol(engine.remote);
      currentState?.beginDrain();
      bridge?.dispose();
      menu?.dispose();
      const remoteClosing = engine && engine.remote && engine.remote.stop();
      const failures = [];
      for (const [stage, close] of [['control', () => control && control.dispose()], ['local-management', () => management?.flush()], ['engine-flush', () => engine && engine.flush()],
        ['current-state', () => currentState && currentState.dispose()], ['engine', () => engine && engine.dispose()],
        ['keeper', () => keeper && keeper.close()], ['listener', () => remoteClosing],
        ['peers', () => { for (const socket of peers) socket.destroy(); }],
        ['secrets', () => secrets && secrets.dispose()], ['mirrors', () => { state?.dispose(); workspaceState?.dispose(); }],
        ['authority', () => authority && authority.close()]]) {
        lifecycle.stage = stage;
        try { await close(); lifecycle.completed.push(stage); } catch (err) { failures.push(err); lifecycle.failed.push(stage); }
      }
      // A failed resource release retains the ownership fence; a crash is
      // nonzero and cannot admit a simultaneous replacement generation.
      if (!failures.length) lock.release();
      lifecycle.phase = failures.length ? 'failed' : 'stopped'; lifecycle.stage = null;
      if (failures.length) throw fail('DRAIN_FAILED', 'A private daemon resource failed to drain');
    })();
    return closing;
  }
  try {
    checkPrivateTree(paths.root);
    for (const dir of [paths.home, paths.state, path.join(paths.home, 'tmp'), path.join(paths.home, '.claude'),
      path.join(paths.home, '.claude', 'projects'), path.join(paths.home, '.codex-work'), path.join(paths.home, '.codex'),
      path.join(paths.root, 'keeper'), path.join(paths.state, 'voice'), path.join(paths.state, 'models')]) privateDirectory(dir);
    const configEntry = privateFile(paths.config, { optional: true });
    let config;
    try { config = configEntry ? readPrivateJson(paths.config) : { version: 1, user: {}, projects: [] }; }
    catch (_) { throw fail('CONFIG_INVALID', 'Private configuration is unreadable or corrupt'); }
    if (config.version !== 1) throw fail('CONFIG_INVALID', 'Unsupported private configuration version');
    state = createTestStore(path.join(paths.state, 'engine.test.json'), { testOnly: true });
    workspaceState = createTestStore(path.join(paths.state, 'workspace.test.json'), { testOnly: true });
    authority = await openAuthority({ ...adapters.authority, file: path.join(paths.state, 'authority.jsonl') });
    if (!authority.status().writable) throw fail('AUTHORITY_UNAVAILABLE', 'The private JSONL authority requires inspection; no mutations were admitted');
    const persisted = state.get('nikd.settings');
    await initializeEngineState(authority, { settings: persisted || config, root: paths.home });
    const settings = createDaemonConfig({ ...authority.snapshot().values[DOMAIN].settings, root: paths.home,
      persist: async (next, change) => {
        const committed = await authority.commit((saved) => {
          saved.values[DOMAIN].settings.user[change.key] = change.value;
        });
        const applied = committed.values[DOMAIN].settings;
        state.update('nikd.settings', applied); // service mirror, never receipt authority
        return applied;
      } });
    // Config is never printed or accepted over HTTP. Only explicit owner paths
    // reach the resolver; contributed defaults such as "claude" are not paths.
    const configured = { ...(config.tools || {}), ...(adapters.toolPaths || {}) };
    const configuredUser = authority.snapshot().values[DOMAIN].settings.user;
    for (const [name, key] of [['claude', 'claudePath'], ['codex', 'codexPath']]) {
      if (configuredUser[key]) configured[name] = configuredUser[key];
    }
    const activeMenuSettings = validateMenuSettings(authority.snapshot().values[MENU_SETTINGS] || {
      ...menuDefaults(paths.home), codexHome: path.join(paths.home, settings.get('codexAccount') === 'personal' ? '.codex' : '.codex-work')
    }, { home: paths.home, pinnedNode: adapters.package ? process.execPath : null, requireExecutable: false });
    for (const [name, value] of Object.entries(activeMenuSettings.tools)) if (value !== null) configured[name] = value;
    const resolver = createToolResolver({ home: paths.home, configured, env: {}, ...adapters.tools });
    let resolved = await resolver.resolveAll();
    // Every session sees the resolved executable, including project readers.
    // Missing tools retain a private non-executable target, never a PATH name.
    const scopedSettings = (source) => ({ ...source, get: (key, fallback) => key === 'claudePath'
      ? resolved.tools.claude.path || path.join(paths.home, 'missing-claude') : source.get(key, fallback) });
    const engineSettings = (cwd) => scopedSettings(cwd ? settings.forProject(cwd) : settings);
    const accountHome = activeMenuSettings.codexHome;
    privateDirectory(accountHome);
    if (adapters.codexIpc) {
      const endpoint = adapters.codexIpc.sockPath;
      if (!path.isAbsolute(endpoint || '') || !inside(paths.root, endpoint)) throw fail('ISOLATED_PROVIDER_DISABLED', 'Fixture IPC must name its private socket');
      noSymlinks(endpoint); privateFile(endpoint, { socket: true });
    }
    let codexCache;
    if (adapters.codexSpawn) {
      const dir = path.join(paths.state, 'codex-cache', crypto.createHash('sha256').update(accountHome).digest('hex').slice(0, 24));
      for (const entry of [dir, path.join(dir, 'threads'), path.join(dir, 'pictures')]) privateDirectory(entry);
      // Even a provider fixture must never fall back to native sips or read a
      // provider-supplied image reference outside this private generation.
      codexCache = new CodexCache({ dir, home: paths.home, shrink: async () => false });
      const picture = codexCache.picture.bind(codexCache);
      codexCache.picture = (src) => {
        const ref = String(src || '').trim();
        if (/^data:image\//i.test(ref)) return picture(ref);
        let file = ref;
        try {
          if (/^file:/i.test(file)) file = require('url').fileURLToPath(file);
          if (file.startsWith('~/')) file = path.join(paths.home, file.slice(2));
          if (!path.isAbsolute(file) || !inside(paths.root, path.resolve(file))) return Promise.resolve(null);
          noSymlinks(file);
        } catch (_) { return Promise.resolve(null); }
        return picture(file);
      };
    }
    const childEnv = { ...resolved.childEnv, HOME: paths.home, USERPROFILE: paths.home, ZDOTDIR: paths.home,
      TMPDIR: path.join(paths.home, 'tmp'), CODEX_HOME: accountHome, NIKUI_KEEPER_DIR: path.join(paths.root, 'keeper') };
    function cwdInRoot(cwd) {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !inside(paths.home, path.resolve(cwd))) throw fail('CWD_OUTSIDE_ROOT', 'Only private fixture folders may run');
      noSymlinks(cwd);
      return cwd;
    }
    const spawnInRoot = (spawn = disabled) => (cmd, args, opts = {}, session) => spawn(cmd, args, { ...opts, cwd: cwdInRoot(opts.cwd || paths.home), env: { ...childEnv } }, session);
    // Only an explicit in-process fixture can enable this supervisor in P1.
    // Its directory is fixed by the root; no inherited/live socket is used.
    if (adapters.keeper) keeper = new DaemonKeeper({ ...adapters.keeper,
      dir: path.join(paths.root, 'keeper'), store: state, env: { ...adapters.keeper.env, ...childEnv } });
    secrets = adapters.keychain
      ? createKeychainStore({ adapter: adapters.keychain.adapter, account: adapters.keychain.account })
      : createTestStore(paths.secrets, { testOnly: true });
    // Bootstrap fresh synthetic keys exactly once. An existing incomplete or
    // corrupt selection refuses; loadSelected never regenerates it.
    let selection = secrets.get('nikd.selection');
    if (!selection) {
      if (adapters.keychain) throw fail('IDENTITY_UNAVAILABLE', 'Selected Keychain identity is missing; no bootstrap or fallback');
      if (secrets.get('nikui.identity') || secrets.get('nikui.vapid')) throw fail('IDENTITY_UNAVAILABLE', 'Private synthetic identity selection is incomplete');
      const identity = loadIdentity(secrets), vapid = loadVapid(secrets);
      selection = { fingerprint: identity.fingerprint, applicationServerKey: vapid.applicationServerKey };
      secrets.update('nikd.selection', selection);
    }
    if (adapters.keychain) {
      try { loadIdentity(secrets, { required: true, fingerprint: selection.fingerprint });
        loadVapid(secrets, { required: true, applicationServerKey: selection.applicationServerKey }); }
      catch (_) { throw fail('IDENTITY_UNAVAILABLE', 'Selected Keychain keys are invalid; no regeneration or fallback'); }
    }
    const localKey = new LocalKey(); // Enrollment keys expire with the generation.
    engine = createEngine({ context: { globalState: state, workspaceState }, settings: engineSettings,
      paths: { home: paths.home, projects: path.join(paths.home, '.claude', 'projects'), storage: paths.state,
        codexCache: path.join(paths.state, 'codex-cache') },
      spawner: spawnInRoot(keeper ? keeper.spawner() : adapters.claudeSpawn), nextId: () => generation + ':' + crypto.randomUUID(),
      codex: { home: accountHome, codexPath: resolved.tools.codex.path || path.join(paths.home, 'missing-codex'),
        unavailableReason: adapters.codexSpawn ? null : 'Isolated P1 provider execution is disabled',
        spawnFn: spawnInRoot(adapters.codexSpawn), env: childEnv, cache: codexCache, ipc: adapters.codexIpc || null },
      delivery: { create: (services) => createSelectedDelivery({ ...services,
        selection: { ...selection, store: secrets, onDidChange: (fn) => secrets.onDidChange((event) => {
          if (['nikui.identity', 'nikui.vapid', 'nikd.selection'].includes(event.key)) fn(event);
        }) }, paths: { apnsKeyFile: null },
        send: noDelivery, sendApple: noDelivery, readApnsKey: disabled }) },
      slack: { secrets, settings, onDidChangeConfiguration: (fn) => settings.onDidChangeConfiguration(fn),
        createApi: adapters.slackApi || (() => ({ call: disabled })), createSocket: adapters.slackSocket || disabled }
    });
    currentState = await createEngineState({ authority, engine, root: paths.home, refreshSettings: (values) => settings.refresh(values),
      startQueued: !!(adapters.claudeSpawn || keeper),
      authorize: ({ access, context, message }) => {
        if (context.principal === 'local:legacy' || context.principal === 'local:browser') return context.seat?.local === true;
        if (context.principal.startsWith('local-client:')) return context.seat?.local === true &&
          secrets.get('nikd.developmentClients.v1', []).some((c) => !c.revoked && context.principal === 'local-client:' + c.id);
        const device = context.principal.startsWith('device:') && engine.delivery.devices.get(context.principal.slice(7));
        return !!device && (access === 'view' || require('./mutationGrants').mayMutate({ ...context,
          seat: { ...context.seat, control: device.control === true } }, message));
      } });
    currentState.restoreEngine();
    owned.push('engine', 'delivery', 'slack');
    const fakePolicy = createFakePolicyAdapters();
    const policy = engine.createPolicy({ authority: createPolicyAuthority(), generation, ...fakePolicy,
      codexBusy: () => engine.codex.list.filter((s) => s.isBusy).length, serving: () => !!(engine.remote && engine.remote.listening) });
    owned.push('power/notifications:fake');
    const prCi = engine.createPrCi({ runners: { links: adapters.prRun || noQuery, feed: adapters.prRun || noQuery,
      ci: adapters.prRun || noQuery }, autoWatch: (session) => settings.forProject(session && session.cwd).get('watchCIAfterPush', true) });
    owned.push('pr/ci');
    const host = createMachineHost({ manager: engine.manager, settings, ledger: engine.ledger, devices: engine.delivery.devices,
      codex: () => engine.codex, prFeed: prCi.feed, editor: { providers: () => bridge?.providers() || [], timeoutMs: adapters.editorTimeoutMs || 15000 },
      env: { home: paths.home, reach: { sealed: true, appOnly: true } } });
    const resources = createRemoteResources({ home: paths.home,
      terminal: adapters.terminalSpawn ? { spawn: spawnInRoot(adapters.terminalSpawn), shell: path.join(paths.home, 'fixture-shell'), env: childEnv } : null,
      voice: { dir: path.join(paths.state, 'voice'), tmp: path.join(paths.home, 'tmp'), package: path.join(paths.state, 'voice'),
        models: path.join(paths.state, 'models'), run: adapters.voiceRun || disabled, env: childEnv,
        binary: adapters.voiceRun ? path.join(paths.state, 'voice', 'fixture-voice') : undefined,
        platform: adapters.voiceRun ? 'darwin' : 'fixture', arch: adapters.voiceRun ? 'arm64' : 'fixture', enabled: () => !!adapters.voiceRun },
      appUpdate: { file: path.join(paths.state, 'fixture.apk') } });
    const engineInfo = { id: authority.snapshot().engineId, boot: crypto.randomBytes(16).toString('hex'),
      version: require('../package.json').version, mode: 'service' };
    const caps = [...CORE, 'editor-route-v1', ...(adapters.prRun ? ['pr-v1'] : []),
      ...(adapters.slackApi && settings.get('slack.enabled') ? ['slack-v1'] : []),
      ...(adapters.terminalSpawn ? ['terminal-v1'] : []), ...(adapters.voiceRun ? ['voice-v1'] : [])];
    const remote = engine.createRemote({ root: path.resolve(__dirname, '..'), host, localKey, resources,
      applicationProtocol: { engine: engineInfo, caps, receipts: () => currentState.dispatcher.receiptInfo() },
      ownership: { terminals: 'owned', voice: 'owned', appUpdate: 'owned' }, slack: () => engine.slack.room,
      codex: engine.codex, requireSealed: () => true, appOnly: () => true,
      projects: () => management?.projects() || bridge?.projects() || [], createInstance: adapters.claudeSpawn || keeper ? ({ cwd }) => {
        if (!running) throw fail('DRAINING', 'The daemon is draining');
        return engine.manager.create({ cwd: cwdInRoot(cwd), autoStart: false });
      } : null, report: () => status(), log: () => {} });
    owned.push('remote', adapters.terminalSpawn ? 'terminal:fake' : 'terminal:disabled',
      adapters.voiceRun ? 'voice:fake' : 'voice:disabled', 'appUpdate:fixture');
    bridge = createDevelopmentBridge({ paths, secrets, remote, currentState, engineInfo,
      fingerprint: selection.fingerprint, running: () => running, management: () => management, timeoutMs: adapters.editorTimeoutMs || 15000 });
    management = createDaemonManagement({ engine, paths, authority, currentState, settings, secrets, generation,
      running: () => running, bridge: () => bridge, keeper, canRun: !!(adapters.claudeSpawn || keeper),
      adapters: { ...adapters.management, menu: (...args) => menu.command(...args) } });
    require('./wireMutations').reconcileDeviceRevocations(authority, engine.delivery.devices, engine.delivery.audience);
    graph.host = host; graph.resources = resources; graph.fakePolicy = fakePolicy; graph.keeper = keeper; graph.authority = authority; graph.currentState = currentState; graph.bridge = bridge; graph.management = management;
    function status() {
      return { ok: true, mode: 'isolated-p1', protocol: 2, generation, engine: engineInfo, pid: process.pid, state: lifecycle.phase,
        lifecycle: structuredClone(lifecycle), bridge: bridge.status(),
        localManagement: { version: 1, generation, authority: 'private-enrolled-client', productionActivation: false,
          menuObservers: menu?.observerCount || 0 },
        root: paths.root, account: { provider: 'codex', home: accountHome, borrowed: false },
        ...(adapters.package ? { package: { ...adapters.package, node: process.version, executable: process.execPath,
          arch: process.arch, home: process.env.HOME, path: process.env.PATH, childPath: childEnv.PATH,
          keychainBackend: adapters.keychain?.adapter.backend } } : {}),
        listener: { host: '127.0.0.1', port: remote.port }, control: { socket: paths.socket, mode: '0600', directoryMode: '0700', enrollment: 'local-owner-only' },
        services: owned.slice(), policy: policy.state(), secrets: '[redacted]', tools: resolved.tools, loginShell: resolved.loginShell,
        authority: { version: 1, writable: authority.status().writable && !currentState.status().issue, networkReceipts: running,
          currentState: currentState.status() },
        wrappers: resolved.wrappers, blockers: [{ code: 'ISOLATED_P1', hint: 'Real provider execution, trust setup, exposure, power and production import are disabled.' },
          ...(keeper ? [...keeper.blockers.values()] : []),
          ...Object.entries(resolved.tools).filter(([, tool]) => tool.status === 'missing').map(([tool, value]) => ({ code: 'TOOL_MISSING', tool, hint: value.hint }))] };
    }
    menu = createMenuManagement({ paths, authority, engine, status, bridge: () => bridge, activeSettings: activeMenuSettings,
      pinnedNode: adapters.package ? process.execPath : null,
      refreshTools: async () => { resolved = await resolver.refresh(); } });
    if (keeper) { await engine.manager.reattach(keeper); currentState.project(); }
    engine.manager.restorePause(); // authority/unknown barriers were recovered first
    await engine.start();
    currentState.start();
    await remote.start(port || activeMenuSettings.port, { exactly: true });
    remote.server.on('connection', (socket) => { peers.add(socket); socket.once('close', () => peers.delete(socket)); });
    policy.reconsider();
    running = true;
    enableIsolatedProtocol({ remote, engine, currentState, authority, paths, bridge, running: () => running });
    lifecycle.phase = 'running'; lifecycle.stage = null;
    control = await createControl({ paths, connect: (request, socket, initial) => bridge.connect(request, socket, initial),
      observe: (request, socket) => menu.observe(request, socket), handle: (request) => {
      if (!request || typeof request !== 'object') return { ok: false, code: 'CONTROL_INVALID' };
      if (request.op === 'status' || request.op === 'doctor') return status();
      if (request.op === 'local') return bridge.localRequest(request);
      if (request.op === 'enroll' && running && ['local', 'editor'].includes(request.kind || 'local')) {
        if (request.kind === 'editor') return bridge.enroll(request);
        if (request.protocol === 2 && request.kind === 'local') return bridge.enroll(request);
        // The legacy local key remains generation-local; it has no editor seat.
        return { ok: true, kind: request.kind || 'local', key: localKey.key, generation, protocol: 1, editorMethods: [] };
      }
      if (running && adapters.control) return adapters.control(request);
      return { ok: false, code: running ? 'CONTROL_UNSUPPORTED' : 'DRAINING' };
    } });
    return { paths, engine, status, stop, graph, generation, lifecycle: () => structuredClone(lifecycle) };
  } catch (err) { await stop(); throw err; }
}

module.exports = { startDaemon };
