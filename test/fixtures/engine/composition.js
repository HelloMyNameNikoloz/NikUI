'use strict';

const fs = require('fs');
const path = require('path');
const { createEngine, resolvedPath } = require('../../../src/engine');
const { createMachineHost } = require('../../../src/machineHost');
const { SessionManager } = require('../../../src/manager');
const { createHistory, useNames } = require('../../../src/history');
const { defaultCommandCatalog } = require('../../../src/commandCatalog');
const { accountHome } = require('../../../src/codexHome');
const { context, settings, clock, provider, deferred, processFixture, tick, Secrets } = require('./fakes');
const { EventEmitter } = require('events');
const root = process.env.NIKUI_ENGINE_FIXTURE_ROOT;

module.exports = async function () {
  const engines = [];
  function options(name) {
    const home = path.join(root, name);
    fs.mkdirSync(home, { recursive: true });
    const cx = provider({ 'thread/list': { data: [{ id: 'same', name, cwd: home }] },
      'thread/start': { thread: { id: 'new', name, cwd: home } },
      'model/list': { data: [{ id: name }] }, 'thread/turns/list': { data: [] }, 'thread/goal/read': {} });
    const claude = provider();
    const timers = clock();
    return { context: context(), settings: settings({ claudePath: '/fixture/claude-' + name }),
      paths: { home, projects: path.join(home, 'projects'), storage: path.join(home, 'storage'),
        codexCache: path.join(root, 'shared-cache') },
      spawner: claude.spawnFn, now: timers.now, timers,
      codex: { home: path.join(home, '.codex-work'), codexPath: '/fixture/codex-' + name,
        spawnFn: cx.spawnFn, args: ['-c', 'fixture=' + name], env: { FIXTURE: name } }, cx, claude };
  }
  const make = (opts) => { const engine = createEngine(opts); engines.push(engine); return engine; };
  const put = (projects, id, text) => {
    const dir = path.join(projects, '-fixture-work'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: '/fixture/work', timestamp: '2026-11-20T10:00:00Z',
      message: { role: 'user', content: text + ' '.repeat(200) } }) + '\n');
    return file;
  };
  try {
    suite('T02/T03: services stay with their engine in a poisoned child');
    const oa = options('alpha'), ob = options('beta');
    const a = make(oa), b = make(ob);
    const idOptions = options('injected-ids');
    let idSeq = 0;
    idOptions.nextId = () => 'fixture-generation-' + idSeq++;
    const ids = make(idOptions);
    checkEqual('R04: instance ID generation is injected and explicit restored IDs survive', [
      ids.manager.create({ cwd: root, autoStart: false }).id,
      ids.manager.create({ id: 'restored-legacy-id', cwd: root, autoStart: false }).id,
      ids.manager.create({ cwd: root, autoStart: false }).id], ['fixture-generation-0', 'restored-legacy-id', 'fixture-generation-1']);
    oa.codex.env.FIXTURE = 'changed-after-construction';
    const ha = createMachineHost({ manager: a.manager, settings: oa.settings, ledger: a.ledger, codex: () => a.codex });
    const hb = createMachineHost({ manager: b.manager, settings: ob.settings, ledger: b.ledger, codex: () => b.codex });
    checkEqual('construction starts no Claude or Codex process', [oa.cx.spawned.length, ob.cx.spawned.length,
      oa.claude.spawned.length, ob.claude.spawned.length], [0, 0, 0, 0]);
    check('engines share no mutable service or catalog object', ['manager', 'history', 'folders', 'ledger', 'codex', 'commandCatalog']
      .every((key) => a[key] !== b[key]));
    checkEqual('plain constructors still use manifest defaults without a platform',
      new SessionManager(context()).config.claudePath, 'claude');
    await ha.setSetting('thinking', false);
    await hb.setSetting('thinking', true);
    await ha.saveCommand({ name: 'fixture', prompt: 'alpha only' });
    checkEqual('settings writes and snippets remain independent', [ha.config().showThinking, hb.config().showThinking,
      a.manager.config.promptSnippets.fixture, b.manager.config.promptSnippets.fixture || null], [false, true, 'alpha only', null]);
    oa.settings.values.claudePath = '/fixture/alpha-changed';
    checkEqual('interleaved readers stay fresh', [a.manager.config.claudePath, b.manager.config.claudePath],
      ['/fixture/alpha-changed', '/fixture/claude-beta']);
    const sa = a.manager.create({ id: 'same-instance', cwd: '/fixture/work', title: 'Alpha named', resume: 'same', autoStart: false });
    const sb = b.manager.create({ id: 'same-instance', cwd: '/fixture/work', title: 'Beta named', resume: 'same', autoStart: false });
    check('sessions receive their engine dependencies by identity', sa.history === a.history && sb.history === b.history
      && sa.commandCatalog === a.commandCatalog && sb.commandCatalog === b.commandCatalog);
    a.commandCatalog.offerCommandArgs('engineOnly', [{ value: 'alpha' }]);
    sb.commandCatalog.learnCommandArgs('Usage: /betaOnly <yes|no>');
    sa._onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Usage: /alphaReply <one|two>' }] } }));
    checkEqual('the live session learns into its own catalog', (a.commandCatalog.commandArgs().alphaReply || []).map((v) => v.value), ['one', 'two']);
    checkEqual('neither catalog contaminates another engine or the legacy catalog', [b.commandCatalog.commandArgs().engineOnly,
      a.commandCatalog.commandArgs().betaOnly, defaultCommandCatalog.commandArgs().engineOnly].map((v) => v || null), [null, null, null]);
    a.manager.persist(); b.manager.persist();
    checkEqual('the same conversation id keeps independent names', [oa.context.globalState.get('nikui.names.v1').same,
      ob.context.globalState.get('nikui.names.v1').same], ['Alpha named', 'Beta named']);
    const fa = a.folders.create('Alpha folder'), fb = b.folders.create('Beta folder');
    a.folders.place(sa, fa.id); b.folders.place(sb, fb.id);
    checkEqual('folder stores can interleave even with identical instance ids', [a.folders.folderOf(sa).name,
      b.folders.folderOf(sb).name], ['Alpha folder', 'Beta folder']);
    checkEqual('workspace mirrors are separate stores', [oa.context.workspaceState.get('nikui.folders.v1').folders[0].name,
      ob.context.workspaceState.get('nikui.folders.v1').folders[0].name], ['Alpha folder', 'Beta folder']);
    sa.totalCost = 2; sa.turns = 1; sb.totalCost = 7; sb.turns = 3;
    a.flush(); b.flush();
    checkEqual('ledger totals do not merge across roots', [ha.lifetime().cost, hb.lifetime().cost], [2, 7]);
    checkEqual('disk mirrors record only their own ledger', [JSON.parse(fs.readFileSync(a.ledger.file)).instances['same-instance'].cost,
      JSON.parse(fs.readFileSync(b.ledger.file)).instances['same-instance'].cost], [2, 7]);
    const afile = fs.realpathSync(put(oa.paths.projects, 'same', 'alpha transcript'));
    const bfile = fs.realpathSync(put(ob.paths.projects, 'same', 'beta transcript'));
    useNames(() => ({ same: 'legacy pollution' }));
    const histories = await Promise.all([a.history.listSessions(), b.history.listSessions()]);
    checkEqual('history roots, cache and names stay private', histories.map((entries) => [entries[0].title, entries[0].label]),
      [['alpha transcript', 'Alpha named'], ['beta transcript', 'Beta named']]);
    checkEqual('same conversation id resolves within each root', [a.history.transcriptPath('/fixture/work', 'same'),
      b.history.transcriptPath('/fixture/work', 'same')], [afile, bfile]);
    await Promise.all([sa.replayTranscript(), sb.replayTranscript()]);
    checkEqual('session replay uses those injected roots', [sa.items.some((i) => /alpha transcript/.test(i.text || '')),
      sb.items.some((i) => /beta transcript/.test(i.text || ''))], [true, true]);
    checkEqual('reports use the engine transcript resolver', [ha.env(sa).transcriptPath, hb.env(sb).transcriptPath], [afile, bfile]);
    const independent = createHistory({ root: oa.paths.projects, names: () => ({ same: 'third reader' }) });
    checkEqual('a new reader over the same file cannot replace engine names', [(await independent.listSessions())[0].label,
      (await a.history.listSessions())[0].label], ['third reader', 'Alpha named']);
    independent.dispose();
    const closingReader = createHistory({ root: oa.paths.projects });
    const reading = closingReader.listSessions();
    closingReader.dispose(); closingReader.dispose();
    checkEqual('disposing a history reader closes its in-flight stream without retaining results', await reading, []);
    checkEqual('headless lazy editor paths refuse without loading chrome', [ha.openFile({ path: 'a', cwd: '/fixture' }).status,
      ha.runInTerminal({ command: 'never execute' }).status, ha.openAllSettings().status], ['unavailable', 'unavailable', 'unavailable']);
    checkEqual('an absent external opener reports unavailable', ha.openUrl('https://example.invalid').reason, 'SYSTEM_OPENER_UNAVAILABLE');
    checkEqual('headless quota confirmation does not open UI', await ha.confirmPausedSend({ isPaused: true }), false);
    ha.knownCommands(); ha.fleet(); ha.settings(); ha.commands();
    await ha.removeCommand('fixture');

    suite('R02-1: environment and host limits are read lazily');
    let facts = { codexLimits: { current: () => ['first'] } };
    const dynamic = createMachineHost({ manager: a.manager, settings: oa.settings, env: () => facts });
    checkEqual('initial report reads the supplied limits', dynamic.env(sa).codexLimits, ['first']);
    const replacement = { current: () => ['replacement'] };
    facts = { codexLimits: replacement };
    checkEqual('later environment facts reach reports', dynamic.env(sa).codexLimits, ['replacement']);
    check('later environment facts reach the host property', dynamic.codexLimits === replacement);
    facts = {};
    checkEqual('removing a reader removes stale limits', [dynamic.codexLimits, dynamic.env(sa).codexLimits], [null, null]);

    suite('T02/T31/T40: Codex threads, model catalogs, caches and disposal stay private');
    await Promise.all([a.codex.refresh(), b.codex.refresh()]);
    checkEqual('the same thread id belongs to its own workspace', [a.codex.get('cx-same').label, b.codex.get('cx-same').label], ['alpha', 'beta']);
    checkEqual('one account is passed to each injected provider', [oa.cx.spawned[0].opts.env.CODEX_HOME,
      ob.cx.spawned[0].opts.env.CODEX_HOME], [a.account.home, b.account.home]);
    checkEqual('provider environments do not inherit the parent account', [oa.cx.spawned[0].opts.env.FIXTURE,
      ob.cx.spawned[0].opts.env.FIXTURE, oa.cx.spawned[0].opts.env.HOME || null], ['alpha', 'beta', null]);
    checkEqual('each provider receives its own executable and arguments', [oa.cx.spawned[0].cmd, ob.cx.spawned[0].args],
      ['/fixture/codex-alpha', ['app-server', '-c', 'fixture=beta']]);
    checkEqual('model responses and their promise caches do not cross accounts', (await Promise.all([a.codex.models(), b.codex.models()]))
      .map((models) => models[0].id), ['alpha', 'beta']);
    check('cache directories include the canonical account identity', a.account.cacheDir !== b.account.cacheDir
      && a.codex.cache.dir === a.account.cacheDir && b.codex.cache.dir === b.account.cacheDir);
    for (const engine of [a, b]) engine.codex.cache.writeDelayMs = 0;
    a.codex.cache.write('same', { turns: [{ id: 'alpha', items: [] }] });
    b.codex.cache.write('same', { turns: [{ id: 'beta', items: [] }] });
    await new Promise((resolve) => setTimeout(resolve, 15));
    checkEqual('identical disk cache keys retain each account history', [a.codex.cache.read('same').turns[0].id,
      b.codex.cache.read('same').turns[0].id], ['alpha', 'beta']);
    sa.start(); sb.start();
    checkEqual('Claude also uses only the injected spawners', [oa.claude.spawned.length, ob.claude.spawned.length], [1, 1]);
    a.dispose(); a.dispose();
    checkEqual('disposing A closes its own transports', [oa.cx.spawned[0].proc.kills, oa.claude.spawned[0].proc.stdin.writableEnded], [1, true]);
    checkEqual('disposing A cannot stop B', [ob.cx.spawned[0].proc.kills, ob.claude.spawned[0].proc.kills], [0, 0]);
    checkEqual('owned client listeners are removed on disposal', oa.cx.spawned[0].proc === a.codex.client.proc, false);
    checkEqual('manager callbacks and remembering timer are retired', [a.manager.listenerCount('changed'), oa.timers.tasks.size], [0, 0]);
    await b.codex.create({ cwd: '/fixture/new' });
    await b.codex.refresh();
    check('B keeps operating after A is gone', b.codex.get('cx-new') && !sb.disposed);
    checkEqual('A cannot start its disposed client again', await a.codex.client.start().then(() => '', (err) => err.message), 'Codex client is closed');
    let managerClosed = '';
    try { a.manager.create({ cwd: '/fixture', autoStart: true }); } catch (err) { managerClosed = err.message; }
    checkEqual('a disposed owner cannot resurrect its manager', managerClosed, 'Session manager is closed');
    checkEqual('history disposal retires only the closed engine reader', [await a.history.listSessions(),
      (await b.history.listSessions())[0].label], [[], 'Beta named']);

    suite('T31: one stable resolved account; no implicit daemon or IPC discovery');
    const fallbackOpts = options('fallback');
    fallbackOpts.codex.home = accountHome('work', fallbackOpts.paths.home);
    const fallback = make(fallbackOpts);
    fs.mkdirSync(path.join(fallbackOpts.paths.home, '.codex-work'));
    checkEqual('later work-home creation cannot retarget a resolved engine', fallback.account.home,
      resolvedPath(path.join(fallbackOpts.paths.home, '.codex')));
    checkEqual('even an app account has no implicit provider discovery', [fallback.codex.client.daemonFn, fallback.codex.ipc], [null, null]);
    const alias = options('alias');
    fs.symlinkSync(fallback.account.home, alias.codex.home);
    alias.paths.home = fallbackOpts.paths.home;
    alias.paths.codexCache = fallbackOpts.paths.codexCache;
    // The target need not exist yet; the resolver follows an existing symlink
    // once its target is present, exactly as it will be in a real account.
    fs.mkdirSync(fallback.account.home, { recursive: true });
    const sameAccount = make(alias);
    checkEqual('different labels/paths to the same canonical account share a namespace', [sameAccount.account.home,
      sameAccount.account.cacheDir], [fallback.account.home, fallback.account.cacheDir]);
    for (const second of [[fallbackOpts.codex, alias.codex], { ...fallbackOpts.codex, accounts: ['second'] }]) {
      let error = '';
      try { createEngine({ ...fallbackOpts, codex: second }); } catch (err) { error = err.message; }
      check('P1 rejects a simultaneous second account', /Exactly one resolved/.test(error));
    }
    for (const injected of [{ daemonFn: () => Promise.resolve(null) }, { ipc: { dispose() {} } }]) {
      let error = '';
      try { createEngine({ ...ob, codex: { ...ob.codex, ...injected } }); } catch (err) { error = err.message; }
      check('a non-app account cannot borrow app connections', /Only the resolved app account/.test(error));
    }
    const dangling = options('dangling');
    fs.symlinkSync(path.join(root, 'missing-account-target'), dangling.codex.home);
    let unresolved = '';
    try { createEngine(dangling); } catch (err) { unresolved = err.message; }
    check('an unresolved account symlink refuses instead of guessing a canonical identity', /unresolved symlink/.test(unresolved));

    suite('T03/T04: a borrowed writer and its owned reader keep injected paths/spawners');
    const borrowOpts = options('borrowed');
    borrowOpts.codex.home = path.join(borrowOpts.paths.home, '.codex');
    const borrowed = processFixture(); let borrowedConnections = 0, ipcDisposals = 0;
    borrowOpts.codex.daemonFn = async () => { borrowedConnections++; return borrowed; };
    borrowOpts.codex.ipc = { dispose: () => ipcDisposals++ };
    const owner = make(borrowOpts);
    const reader = await owner.codex.reader();
    checkEqual('the writer borrows once and history has one owned reader', [borrowedConnections, owner.codex.client.viaDaemon,
      borrowOpts.cx.spawned.length], [1, true, 1]);
    checkEqual('the reader inherits the resolved account, env and args', [reader.home, borrowOpts.cx.spawned[0].opts.env.CODEX_HOME,
      borrowOpts.cx.spawned[0].opts.env.FIXTURE, borrowOpts.cx.spawned[0].args],
      [owner.account.home, owner.account.home, 'borrowed', ['app-server', '-c', 'fixture=borrowed']]);
    check('readers cannot borrow a second connection', reader.daemonFn === null);
    check('reader construction is cached per workspace', await owner.codex.reader() === reader);
    owner.dispose(); owner.dispose();
    checkEqual('one owner closes its borrowed connection and owned reader/IPC once',
      [borrowed.closes, borrowed.kills, borrowOpts.cx.spawned[0].proc.kills, ipcDisposals], [1, 0, 1, 1]);

    suite('T04: disposing during async provider opening cannot resurrect an engine');
    const lateOpts = options('late');
    lateOpts.codex.home = path.join(lateOpts.paths.home, '.codex');
    const opening = deferred(), lateProc = processFixture();
    lateOpts.codex.daemonFn = () => opening.promise;
    const late = make(lateOpts);
    const starting = late.codex.client.start().then(() => 'started', (err) => err.message);
    await tick(); late.dispose(); opening.resolve(lateProc);
    checkEqual('a late borrowed connection is closed instead of initialized', await starting, 'Codex client is closed');
    checkEqual('no fallback spawn, provider initialization or adoption follows disposal',
      [lateOpts.cx.spawned.length, lateProc.calls.length, lateProc.closes, lateProc.kills, late.codex.list.length], [0, 0, 1, 0, 0]);

    suite('T04/T40: injected cache ownership and failed cleanup stay scoped');
    const cacheCounts = { left: 0, right: 0 }, swept = [];
    const makeCache = (name) => ({ read: () => ({ turns: [{ id: name }] }), write() {},
      picture: async () => ({ data: name }), sweep: () => swept.push(name), dispose: () => cacheCounts[name]++ });
    const leftOpts = options('cache-left'), rightOpts = options('cache-right');
    leftOpts.codex.cache = makeCache('left'); rightOpts.codex.cache = makeCache('right');
    leftOpts.codex.home = path.join(leftOpts.paths.home, '.codex');
    let failedIpc = 0;
    leftOpts.codex.ipc = { dispose: () => { failedIpc++; throw new Error('fixture cleanup failure'); } };
    const cacheLeft = make(leftOpts), cacheRight = make(rightOpts);
    await Promise.all([cacheLeft.codex.refresh(), cacheRight.codex.refresh()]);
    checkEqual('injected caches are swept once in their own graph', swept, ['left', 'right']);
    checkEqual('cache reads and image adapters remain independent', [cacheLeft.codex.cache.read('same').turns[0].id,
      (await cacheRight.codex.cache.picture('same')).data], ['left', 'right']);
    cacheLeft.dispose(); cacheLeft.dispose();
    checkEqual('a failing IPC cleanup cannot skip the owned client or cache', [failedIpc, leftOpts.cx.spawned[0].proc.kills,
      cacheCounts.left], [1, 1, 1]);
    checkEqual('disposal never calls the other cache or client', [cacheCounts.right, rightOpts.cx.spawned[0].proc.kills], [0, 0]);
    check('cache failure does not prevent manager closure', cacheLeft.manager.disposed === true);

    suite('T04: optional Slack is owned by its engine, independently of viewers');
    const slackOpts = options('slack-owner');
    const secret = new Secrets({ 'nikui.slack.userToken': 'xoxp-fixture' });
    slackOpts.settings.values['slack.enabled'] = true;
    let slackStarts = 0, slackStops = 0;
    slackOpts.slack = { secrets: secret,
      createApi: () => ({}), createService: () => Object.assign(new EventEmitter(), {
        start: async () => slackStarts++, stop: () => slackStops++, state: () => ({ conversations: [] }) }) };
    const withSlack = make(slackOpts);
    await Promise.all([withSlack.start(), withSlack.start()]);
    withSlack.slack.room.join('viewer', { local: true }, () => {});
    withSlack.slack.room.leave('viewer');
    checkEqual('starting twice/closing a viewer starts once and stops nothing', [slackStarts, slackStops], [1, 0]);
    withSlack.dispose(); withSlack.dispose();
    checkEqual('engine disposal owns Slack cleanup exactly once', [slackStops, secret.disposals, secret.listeners.size], [1, 1, 0]);
  } finally { for (const engine of engines.reverse()) engine.dispose(); }
};
