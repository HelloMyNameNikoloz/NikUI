'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const { createProductionComposition, productionPaths, createMacPower } = require('../src/productionComposition');
const { loadIdentity } = require('../src/identity');
const { loadVapid } = require('../src/push');
const { context, settings, provider } = require('./fixtures/engine/fakes');
module.exports = async () => {
  suite('Production provider composition against an explicit test account');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nik-prod-composition-')));
  const selection = { ...productionPaths(home), flavour: 'prod' }, project = path.join(home, 'project'), account = path.join(home, '.codex-work');
  for (const directory of [selection.root, project, account, path.join(home, '.claude/projects')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const state = context(), source = settings({ claudePath: '/resolved/claude', codexPath: '/resolved/codex', keepAwake: false, lidClosed: false, notifyWhenDone: true });
  const secretStore = { get: (key, fallback) => state.globalState.get(key, fallback), update: (key, value) => { state.globalState.values[key] = value; } };
  const identity = loadIdentity(secretStore), vapid = loadVapid(secretStore);
  const claude = provider(), codex = provider({ 'thread/list': { data: [] }, 'model/list': { data: [] } });
  const calls = [], assertions = []; let current = true, lookups = 0, composition;
  const options = { selection, generation: 'committed-generation', ownership: { committed: true, generation: 'committed-generation',
    assertCurrent() { if (!current) throw Object.assign(new Error('fenced'), { code: 'WRITER_FENCED' }); } },
    context: state, secretStore, settings: source, approvedProjects: [project], codexHome: account,
    selectedPins: { fingerprint: identity.fingerprint, applicationServerKey: vapid.applicationServerKey },
    dependencies: { account: () => ({ homedir: home }), resolver: { async resolveAll() { lookups++; return {
      tools: { claude: { path: '/resolved/claude' }, codex: { path: '/resolved/codex' } }, childEnv: { PATH: '/resolved:/usr/bin:/bin' } }; } },
      spawn: (file, args, opts) => { calls.push({ file, args, opts }); return (file.endsWith('/claude') ? claude : codex).spawnFn(file, args, opts); },
      power: { recover: (g) => assertions.push(['recover', g]), awake: (g, held) => assertions.push(['awake', g, held]), lid() {}, release: (g) => assertions.push(['release', g]) },
      codexCache: { read: () => null, write() {}, sweep() {}, dispose() {}, picture: async () => null } }
  };
  try {
    let refused;
    try { await createProductionComposition({ ...options, ownership: { ...options.ownership, committed: false } }); } catch (e) { refused = e.code; }
    checkEqual('uncommitted source cannot resolve tools or start providers', [refused, lookups, calls.length], ['SERVICE_OWNERSHIP_REQUIRED', 0, 0]);
    try { await createProductionComposition({ ...options, selection: { ...selection, home: '/unselected' } }); } catch (e) { refused = e.code; }
    checkEqual('production account root cannot be retargeted by HOME or selection', refused, 'PRODUCTION_ROOT_INVALID');
    composition = await createProductionComposition(options);
    checkEqual('construction remains inactive with exposure off', [calls.length, assertions.length, composition.exposure, composition.engine.remote], [0, 0, 'off', null]);
    await composition.start();
    checkEqual('app-owned notification policy is a nonthrowing publisher boundary', composition.engine.policy.notify({ id: 'fixture-event', title: 'Finished', body: '' }), true);
    checkEqual('activation acquires generation-owned power policy', assertions[0], ['recover', 'committed-generation']);
    composition.engine.manager.create({ cwd: project });
    await composition.engine.codex.client.start();
    checkEqual('both providers use resolved tools', calls.map((call) => call.file), ['/resolved/claude', '/resolved/codex']);
    check('provider environment uses selected account and explicit provider home', calls.every((call) => call.opts.env.HOME === home && call.opts.env.CODEX_HOME === account && call.opts.env.NIKUI_KEEPER_DIR === path.join(selection.root, 'keeper')));
    check('test production composition owns its Codex process', composition.engine.codex.client.ownership === 'owned');
    current = false;
    try { await composition.start(); } catch (e) { refused = e.code; }
    checkEqual('retired generation cannot activate again', refused, 'WRITER_FENCED');
    await composition.dispose(); composition = null;
    checkEqual('disposal releases only this generation', assertions.at(-1), ['release', 'committed-generation']);
  } finally { if (composition) await composition.dispose(); fs.rmSync(home, { recursive: true, force: true }); }

  suite('Real macOS assertion adapter with an injected process');
  const spawned = [], process = new EventEmitter(); process.kill = (signal) => { spawned.push(signal); queueMicrotask(() => process.emit('exit', 0)); }; process.unref = () => {};
  const power = createMacPower({ platform: 'darwin', pid: 123, launch: (...args) => { spawned.push(args); return process; } });
  power.recover('owned'); power.awake('owned', true); await power.release('owned');
  checkEqual('assertion uses the absolute system tool and dies with its owning PID', spawned[0].slice(0, 2), ['/usr/bin/caffeinate', ['-i', '-s', '-w', '123']]);
  checkEqual('release awaits the exact owned process exit', spawned[1], 'SIGTERM');
};
