'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { provider, tick, deferred } = require('./fakes');
const { install, fakeContext } = require('../../helpers/vscode-stub');
const stub = install();
const checks = [], equal = (name, actual, expected) => checks.push([name, actual, expected]);
const home = process.env.NIKUI_ENGINE_FIXTURE_ROOT;
const source = stub.workspace.getConfiguration();
const config = stub.__config;
Object.assign(config, { codexPath: '/fixture/codex', codexAccount: 'work', codexComputerUse: false, codexXcode: false });
fs.mkdirSync(path.join(home, '.codex-work'));
const cx = provider({ 'thread/list': { data: [] } });
require('child_process').spawn = cx.spawnFn;
let external = 0;
const forbidden = () => { external++; throw new Error('real external effect in a window fixture'); };
require('child_process').execFile = forbidden;
require('net').createConnection = forbidden;
global.fetch = forbidden;
const services = [];
class FakeSlack extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.starts = 0; this.stops = 0; this.live = { conversations: [] }; services.push(this); }
  async start() { this.starts++; this.emit('state'); }
  stop() { this.stops++; }
  state() { return this.live; }
}
let coreResolution = 0, vscodeLoads = 0, providers = 0;
Object.defineProperty(stub.env, 'sessionId', { get() { providers++; return 'fixture-editor'; } });
const original = Module._load;
Module._load = function (name, parent) {
  if (name === 'vscode') {
    vscodeLoads++;
    if (parent && /\/src\/(?:engine|machineHost|manager|session|history|codex|slackRuntime)\.js$/.test(parent.filename)) {
      coreResolution++; throw new Error('vscode poisoned in the core graph');
    }
  }
  if (parent && parent.filename.endsWith('/src/slackRuntime.js')) {
    if (name === './slack/service') return { SlackService: FakeSlack };
    if (name === './slack/api') return { cleanSession: require('../../../src/slack/api').cleanSession,
      createApi: () => ({ call: async () => ({ user: 'fixture-user', user_id: 'UME' }) }) };
  }
  if (parent && parent.filename.endsWith('/src/host.js') && name === './codexLimits') {
    return { codexLimits: () => ({ current: () => ['fixture-limits'] }) };
  }
  return original.apply(this, arguments);
};

(async () => {
  const { createWindowEngine, createWindowDelivery, createWindowRemote, createWindowPrCi } = require('../../../src/extensionEngine');
  const claude = provider();
  const context = fakeContext({ globalStorageUri: { fsPath: path.join(home, 'storage') } });
  const cacheRoot = path.join(home, 'storage', 'codex-cache');
  for (const name of ['threads', 'pictures', 'keep-account']) {
    fs.mkdirSync(path.join(cacheRoot, name), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, name, 'sentinel'), name);
  }
  fs.writeFileSync(path.join(home, '.codex-work', 'sentinel'), 'provider-owned');
  const core = createWindowEngine(context, { spawner: claude.spawnFn });
  try {
    equal('R04: only the two legacy cache directories are removed',
      ['threads', 'pictures', 'keep-account'].map((name) => fs.existsSync(path.join(cacheRoot, name))), [false, false, true]);
    equal('R04: cache cleanup never touches provider-owned data', fs.readFileSync(path.join(home, '.codex-work', 'sentinel'), 'utf8'), 'provider-owned');
    const legacy = core.manager.create({ cwd: home, autoStart: false });
    equal('R04: window IDs keep the legacy timestamp/counter shape', /^nik-[a-z0-9]+-[a-z0-9]+$/.test(legacy.id), true);
    equal('R04: window IDs retain the current base36 timestamp', Math.abs(parseInt(legacy.id.split('-')[1], 36) - Date.now()) < 5000, true);
    equal('the adapter resolves one Work account', core.account.home, path.join(home, '.codex-work'));
    equal('off the app account it injects no daemon or IPC', [core.codex.client.daemonFn, core.codex.ipc], [null, null]);
    equal('construction has no provider start side effect', [cx.spawned.length, claude.spawned.length], [0, 0]);
    let legacyRemovals = 0;
    const quietIo = Object.create(fs);
    quietIo.rmSync = (file, options) => { legacyRemovals++; return fs.rmSync(file, options); };
    const quietCleanup = createWindowEngine(context, { spawner: claude.spawnFn, fs: quietIo });
    equal('R06: absent legacy directories take the stat-only fast path', legacyRemovals, 0);
    quietCleanup.dispose();
    const deliveryLines = [];
    const logged = createWindowDelivery(fakeContext(), { log: (line) => deliveryLines.push(line) });
    await logged.notifier.announce('needs-you', { title: 'Fixture attention' });
    equal('R06: delivery preserves the original push diagnostic prefix', deliveryLines,
      ['push: "Fixture attention" not sent: nothing can reach this window']);
    logged.dispose();
    config['remote.terminal'] = false; config['voice.enabled'] = false;
    const windowRemote = createWindowRemote(context, { engine: core, host: { home } });
    equal('P1-07: the window uses the engine-owned factory without auto-listening', [core.remote === windowRemote, windowRemote.listening], [true, false]);
    equal('P1-07: window resource paths keep extension assets and private storage',
      [windowRemote.root, windowRemote.voice.dir, windowRemote.voice.package],
      [fs.realpathSync(context.extensionUri.fsPath), path.join(home, 'storage'), path.join(context.extensionUri.fsPath, 'voice')]);
    equal('P1-07: window disable settings reach current handlers', [windowRemote.terminals, (await windowRemote.voice.state()).code], [null, 'OFF']);
    equal('P1-07: editor panels and the server retain their shared hub registry', windowRemote.hubs === require('../../../src/hub'), true);
    await windowRemote.dispose();
    delete config['remote.terminal']; delete config['voice.enabled'];
    config.claudePath = '/fixture/new-claude';
    equal('the adapter retains the fresh editor settings reader', core.manager.config.claudePath, '/fixture/new-claude');
    config.codexAccount = 'personal';
    equal('account setting changes cannot retarget an existing engine', core.account.home, path.join(home, '.codex-work'));
    equal('durable window storage and ledger are installed through the adapter',
      [core.manager.durable.dir, core.ledger.dir], [path.join(home, 'storage'), path.join(home, 'storage')]);
    await core.codex.refresh();
    equal('the adapter forwards resolved account/spawner/executable to the factory', [cx.spawned[0].cmd,
      cx.spawned[0].opts.env.CODEX_HOME], ['/fixture/codex', path.join(home, '.codex-work')]);
    const logs = [];
    const damaged = path.join(home, 'dangling-account');
    fs.symlinkSync(path.join(home, 'absent-target'), damaged);
    for (const account of [damaged, path.join(home, 'missing-account')]) {
      config.codexAccount = account;
      const unavailable = createWindowEngine(fakeContext(), { spawner: claude.spawnFn, log: (line) => logs.push(line) });
      const beforeSpawn = cx.spawned.length;
      equal('R04: an unavailable account leaves the manager usable', !!unavailable.manager.create({ cwd: home, autoStart: false }), true);
      await unavailable.codex.refresh();
      equal('R04: a broken/missing account reports a named refusal without spawning',
        [unavailable.codex.available, /Codex account\/cache unavailable/.test(unavailable.codex.error), cx.spawned.length - beforeSpawn], [false, true, 0]);
      unavailable.dispose(); unavailable.dispose();
    }
    equal('R04: account failures are logged during window construction', logs.length >= 2, true);
    config.codexAccount = 'work';
    const workHome = path.join(home, '.codex-work'), savedWork = path.join(home, 'saved-work');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.renameSync(workHome, savedWork);
    fs.symlinkSync(path.join(home, 'absent-work-target'), workHome);
    const brokenWork = createWindowEngine(fakeContext(), { spawner: claude.spawnFn });
    equal('R04: a dangling Work symlink cannot silently select the healthy Personal account',
      [brokenWork.codex.available, brokenWork.account.home], [false, null]);
    brokenWork.dispose(); fs.unlinkSync(workHome); fs.renameSync(savedWork, workHome);
    const blocked = path.join(home, 'blocked-storage');
    const deniedIo = Object.create(fs);
    deniedIo.realpathSync = (file) => {
      if (file === blocked) { const err = new Error('fixture unreadable storage'); err.code = 'EACCES'; throw err; }
      return fs.realpathSync(file);
    };
    const denied = createWindowEngine(fakeContext({ globalStorageUri: { fsPath: blocked } }), { spawner: claude.spawnFn, fs: deniedIo });
    equal('R04: unreadable storage preserves activation and names the Codex failure',
      [denied.codex.available, /storage unavailable/.test(denied.codex.error), !!denied.manager.create({ cwd: home, autoStart: false })], [false, true, true]);
    denied.dispose();
    const brokenCacheStorage = path.join(home, 'broken-cache-storage');
    fs.mkdirSync(brokenCacheStorage);
    fs.symlinkSync(path.join(home, 'absent-cache'), path.join(brokenCacheStorage, 'codex-cache'));
    const brokenCache = createWindowEngine(fakeContext({ globalStorageUri: { fsPath: brokenCacheStorage } }), { spawner: claude.spawnFn });
    equal('R04: a dangling cache symlink cannot break window construction',
      [brokenCache.codex.available, /account\/cache unavailable/.test(brokenCache.codex.error), !!brokenCache.manager.create({ cwd: home, autoStart: false })], [false, true, true]);
    brokenCache.dispose();
    const linkedStorage = path.join(home, 'linked-storage'), outside = path.join(home, 'outside-cache');
    fs.mkdirSync(linkedStorage); fs.mkdirSync(path.join(outside, 'threads'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'threads', 'sentinel'), 'outside');
    fs.symlinkSync(outside, path.join(linkedStorage, 'codex-cache'));
    const linked = createWindowEngine(fakeContext({ globalStorageUri: { fsPath: linkedStorage } }), { spawner: claude.spawnFn });
    equal('R04: legacy cleanup refuses a cache-root symlink outside globalStorage',
      fs.readFileSync(path.join(outside, 'threads', 'sentinel'), 'utf8'), 'outside');
    linked.dispose();
    const temporary = createWindowEngine(fakeContext(), { spawner: claude.spawnFn });
    const temporaryRoot = temporary.codex.cache.cleanupDir;
    fs.mkdirSync(temporary.account.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(temporary.account.cacheDir, 'derived'), 'temporary');
    temporary.dispose(); temporary.dispose();
    equal('R04: storage-less window disposal removes its entire private cache root', fs.existsSync(temporaryRoot), false);
    const lateCache = createWindowEngine(fakeContext(), { spawner: claude.spawnFn });
    const lateRoot = lateCache.codex.cache.cleanupDir;
    const sourcePicture = path.join(home, 'provider-image.png');
    fs.writeFileSync(sourcePicture, Buffer.alloc(160 * 1024));
    const shrinking = deferred(), finishShrink = deferred();
    lateCache.codex.cache.shrink = async (_src, dest) => {
      shrinking.resolve(); await finishShrink.promise;
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'fixture-thumbnail');
    };
    const picture = lateCache.codex.cache.picture(sourcePicture);
    await shrinking.promise;
    lateCache.dispose(); finishShrink.resolve(); await picture;
    equal('R04: an in-flight thumbnail cannot resurrect a disposed temporary cache',
      [fs.existsSync(lateRoot), fs.existsSync(sourcePicture)], [false, true]);
    const { createHost, installHost, describeEnv, forgetHost } = require('../../../src/host');
    const host = installHost(createHost(context, core.manager, { ledger: core.ledger, codex: () => core.codex }));
    const getConfiguration = stub.workspace.getConfiguration, configScopes = [];
    stub.workspace.getConfiguration = (...args) => {
      configScopes.push(args);
      return args[1] ? { get: () => 'UNEXPECTED_PROJECT_OVERRIDE' } : getConfiguration(...args);
    };
    equal('R10: window host config(cwd) retains the unscoped window reader', host.config(home).model, host.config().model);
    equal('R10: window host never passes a resource for project overrides', configScopes.every((args) => args.length === 1 && args[0] === 'nikui'), true);
    stub.workspace.getConfiguration = getConfiguration;
    const prCalls = [];
    const runPr = async (file, args, options) => {
      prCalls.push([file, args, options.cwd]);
      return { ok: true, stdout: args[0] === 'run' ? '[]' : JSON.stringify({ url: 'https://github.com/fixture/window/pull/5', number: 5, state: 'MERGED' }) };
    };
    const windowPr = createWindowPrCi(context, { engine: core, runners: { links: runPr, feed: runPr, ci: runPr } });
    windowPr.start(); windowPr.start(); await tick();
    equal('P1-08: window composition retains the current branch PR query', prCalls[0], ['gh', ['pr', 'view', '--json', 'url'], home]);
    const prHost = createHost(context, core.manager, { prFeed: windowPr.feed, setPr: windowPr.setPr });
    equal('P1-08: the window host borrows the engine-owned PR services', [prHost.prFeed === windowPr.feed, core.prCi === windowPr], [true, true]);
    config.watchCIAfterPush = false;
    const prCount = prCalls.length; core.manager.emit('pushed', legacy, home); await tick();
    equal('P1-08: the fresh window auto-watch setting still disables CI', prCalls.length, prCount);
    config.watchCIAfterPush = true; core.manager.emit('pushed', legacy, home); await tick();
    equal('P1-08: enabling it reaches the same current CI query', prCalls.at(-1),
      ['gh', ['pr', 'view', '--json', 'number,url,title,state,headRefOid,statusCheckRollup'], home]);
    const prKey = legacy.id;
    prHost.prFeed.watch(prKey, { url: legacy.prUrl, cwd: home, active: false });
    prHost.prFeed.unwatch(prKey);
    equal('P1-08: a closing window viewer cannot dispose the shared service', windowPr.feed.disposed, false);
    windowPr.dispose(); windowPr.dispose();
    equal('P1-08: its owner removes the window CI/PR subscriptions', [core.manager.listenerCount('pushed'), core.manager.listenerCount('session-changed'), windowPr.feed.disposed], [0, 0, true]);
    delete config.watchCIAfterPush;
    const before = providers, loaded = vscodeLoads;
    const info = describeEnv(context, core.manager, { cwd: '/fixture', claudeSessionId: 'fixture' });
    equal('describeEnv reuses the installed host instead of building another editor', providers - before, 0);
    equal('reachState uses its module import without requiring vscode again', vscodeLoads - loaded, 0);
    equal('reused reporting keeps the existing Codex limits reader', info.codexLimits, ['fixture-limits']);
    describeEnv(context, { list: [], knownCommands: () => [] }, { cwd: '/fixture' });
    equal('another manager cannot borrow the installed editor host', providers - before, 1);
    forgetHost();

    const { startSlack, USER_TOKEN, APP_TOKEN, SESSION_TOKEN, SESSION_COOKIE } = require('../../../src/slackHome');
    const masked = [], answers = [];
    stub.window.showInputBox = async (opts) => { masked.push(opts); return answers.shift(); };
    const facade = startSlack(context, {});
    const runtime = context.subscriptions.find((sub) => sub.keepSession);
    await runtime.ready;
    equal('the Slack facade still returns its shared room and open function', facade.room === runtime.room && typeof facade.open === 'function', true);
    answers.push('xoxp-window', 'xapp-window');
    await stub.__registered.commands['nikui.slack.connect']();
    equal('the masked app command keeps both values in SecretStorage', [await context.secrets.get(USER_TOKEN),
      await context.secrets.get(APP_TOKEN)], ['xoxp-window', 'xapp-window']);
    equal('the UI command starts a single service despite secret events', services.map((service) => service.starts), [1]);
    equal('app sign-in stays enabled in the shared room', [facade.room.stateFor({ local: true }).enabled,
      facade.room.stateFor({ local: true }).authMode], [true, 'app']);
    services[0].live = { conversations: [{ id: 'D1', pending: true, title: 'Fixture VIP' }] };
    services[0].emit('state');
    const bar = stub.__registered.statusBars.at(-1);
    equal('the window facade still paints the waiting count and command', [bar.shown, bar.text, bar.command],
      [true, '$(comment-discussion) 1', 'nikui.slack.open']);
    answers.push('xoxc-window', 'xoxd-window');
    await stub.__registered.commands['nikui.slack.signIn']();
    equal('the masked session command keeps the session pair', [await context.secrets.get(SESSION_TOKEN),
      await context.secrets.get(SESSION_COOKIE), await context.secrets.get(USER_TOKEN) || null], ['xoxc-window', 'xoxd-window', null]);
    equal('every token/cookie prompt remains masked and ignores focus loss', masked.length === 4 && masked.every((opts) => opts.password && opts.ignoreFocusOut), true);
    equal('switching auth mode stops exactly its predecessor', services.map((service) => service.stops), [1, 0]);
    await stub.__registered.commands['nikui.slack.disconnect']();
    equal('the disconnect command clears all token keys', context.secrets.__store.size, 0);
    equal('disconnect hides the waiting bar and retires its service once', [bar.shown, services[1].stops], [false, 1]);
    for (const sub of context.subscriptions) if (sub.dispose) sub.dispose();
    equal('facade cleanup cannot dispose an already retired service twice', services.map((service) => service.stops), [1, 1]);
    equal('window adapters never resolved vscode from core modules', coreResolution, 0);
    equal('window fixtures made no external effect', external, 0);
    await tick();
  } finally { core.dispose(); }
  process.stdout.write(JSON.stringify(checks));
})().catch((err) => { console.error(err); process.exitCode = 1; });
