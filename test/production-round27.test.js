'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { KeeperLink } = require('../src/keeperLink');
const { Session } = require('../src/session');
const { createProductionKeeper } = require('../src/productionKeeper');
const { BUILDS, captureKeeper, releaseKeeper, keeperProblem } = require('../src/keeperContinuity');
const { routeRecord, routeProblem, attachRoutes, verifyRoute } = require('../src/routeContinuity');
const { Tailscale } = require('../src/tunnel');
const fixtures = path.join(__dirname, 'fixtures/keepers');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
async function wait(test, ms = 5000) { const end = Date.now() + ms; do { if (await test()) return true; await pause(25); } while (Date.now() < end); return false; }
const text = (s) => s.items.filter((i) => ['assistant', 'text'].includes(i.kind)).map((i) => i.text).join('');
const errorCode = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };
const memory = () => { const values = new Map(); return { get: (k, fallback) => values.get(k) || fallback, update: (k, v) => values.set(k, structuredClone(v)) }; };
function multiRoutes(port) {
  const proxy = (n) => ({ Proxy: 'http://127.0.0.1:' + n });
  return { TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true }, 9443: { HTTPS: true }, 10000: { HTTPS: true } }, Web: {
    'fixture.tail123.ts.net:443': { Handlers: { '/': proxy(port), '/plans': proxy(4600) } },
    'fixture.tail123.ts.net:8443': { Handlers: { '/demos': proxy(4601), '/plans': proxy(4600) } },
    'fixture.tail123.ts.net:9443': { Handlers: { '/': proxy(9444) } },
    'fixture.tail123.ts.net:10000': { Handlers: { '/': proxy(9445) } } },
    AllowFunnel: { 'fixture.tail123.ts.net:8443': true, 'fixture.tail123.ts.net:10000': true } };
}
async function keeperFixture(build, cli = 'streaming-claude.js', { graceMs = 15000, prefix = '/tmp/n27-' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(prefix)), links = [], pids = new Set();
  const env = { PATH: '/usr/bin:/bin', HOME: dir, NIKUI_KEEPER_GRACE_MS: String(graceMs), NIKUI_KEEPER_IDLE_MS: '150',
    FAKE_LOG: path.join(dir, 'fake.log'), FAKE_SESSION_ID: 'r27-conversation', FAKE_MS: '15' };
  // Managed hosts deny ps. Portable processes publish their own fixture
  // identities through a preload; the native rehearsal uses real OS facts.
  const preload = path.join(dir, 'birth.cjs');
  fs.writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(dir)} + '/birth-' + process.pid + '.json', JSON.stringify({ pid: process.pid, parent: process.ppid, started: String(process.hrtime.bigint()), command: [process.execPath, ...process.argv.slice(1)].join(' ') }), {mode: 0o600});`, { mode: 0o600 });
  env.NODE_OPTIONS = '--require=' + preload;
  const snapshot = async (pids) => new Map(pids.filter((pid) => alive(pid) && fs.existsSync(path.join(dir, 'birth-' + pid + '.json')))
    .map((pid) => [pid, JSON.parse(fs.readFileSync(path.join(dir, 'birth-' + pid + '.json')))]));
  const source = new KeeperLink({ dir: path.join(dir, 'old'), source: path.join(fixtures, 'keeper-' + build + '.js'), env }); links.push(source);
  const session = (link, id = 'r27-chat') => {
    const spawn = link.spawner();
    return new Session({ id, cwd: dir, maxItems: 0, claudePath: process.execPath,
      spawner: (_cmd, args, options, s) => spawn(process.execPath, [path.join(fixtures, cli), ...args], { ...options, env }, s) });
  };
  const original = session(source); original.send('exactly one turn');
  if (!await wait(() => /w3 /.test(text(original)))) throw Error('LEGACY_FIXTURE_DID_NOT_STREAM');
  pids.add(original.proc.pid); pids.add(source.keeperPid);
  const service = (transfer, store = memory()) => {
    const link = createProductionKeeper({ root: path.join(dir, 'engine'), store,
      factory: (options) => options.legacy ? new (require('../src/legacyKeeper').LegacyKeeper)({ ...options, processSnapshot: snapshot }) : new (require('../src/daemonKeeper').DaemonKeeper)(options),
      sources: [{ files: { keepers: [source.dir] }, keeper: transfer }] }); links.push(link); return link;
  };
  const log = () => fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  return { dir, env, source, original, session, service, log, pids, links, snapshot, async close() {
    for (const link of links) await link.close();
    // Only PIDs obtained from this test's freshly minted runners are signaled.
    for (const pid of pids) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    const rescueSocket = require('../src/keeperRescue').socketFor(source.dir);
    if (fs.existsSync(rescueSocket)) {
      await pause(30);
      try { await require('../src/daemonControl').controlRequest({ socket: rescueSocket }, { op: 'check' }); } catch (_) { /* already retired */ }
    }
    await require('./helpers/custody-supervisor').stop(source.dir);
    await pause(30); fs.rmSync(dir, { recursive: true, force: true });
  } };
}
module.exports = async () => {
  suite('R27 real immutable legacy keeper builds: Move, streaming, reconnect and handback');
  for (const build of Object.keys(BUILDS)) {
    const f = await keeperFixture(build);
    try {
      checkEqual(build + ' fixture bytes retain the real build hash', crypto.createHash('sha256').update(fs.readFileSync(path.join(fixtures, 'keeper-' + build + '.js'))).digest('hex'), BUILDS[build].sha256);
      const proof = await captureKeeper(f.source, [f.original], { snapshot: f.snapshot });
      checkEqual(build + ' binds child, keeper, session and run ID', [proof.transferred[0].legacy.build,
        proof.transferred[0].legacy.child.parent, proof.transferred[0].meta.conversation], [build, f.source.keeperPid, 'r27-conversation']);
      const moved = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const engine = f.service(moved), session = f.session(engine);
      checkEqual(build + ' attaches without a new keeper or child', await engine.attach(session), true);
      const oldText = text(session);
      check(build + ' keeps streaming across Move', await wait(() => text(session).length > oldText.length + 15));
      checkEqual(build + ' attaches the same child PID', session.proc?.pid, moved.transferred[0].pid);
      session.proc.link.socket.destroy();
      check(build + ' reconnects using its actual supported protocol', await wait(() => session.proc?.state === 'kept' && text(session).length > oldText.length + 50));
      const returned = await releaseKeeper(engine, [session]); await engine.close();
      const back = f.service(returned), editor = f.session(back);
      checkEqual(build + ' handback attaches the original keeper and run', await back.attach(editor), true);
      check(build + ' the handback child remains alive', alive(editor.proc?.pid));
      const content = text(editor), tokens = content.trim().split(/\s+/);
      check(build + ' transcript replay has no missing or duplicate streamed word', tokens.every((token, i) => token === 'w' + (i + 1)));
      checkEqual(build + ' no duplicate turn or process', [f.log().filter((e) => e.event === 'start').length,
        f.log().filter((e) => e.type === 'user').length], [1, 1]);
      const bad = structuredClone(returned); bad.transferred[0].legacy.child.started = 'reused pid';
      editor.detach(); await back.close();
      const blocked = f.service(bad), refused = f.session(blocked);
      checkEqual(build + ' changed OS identity blocks attachment', await blocked.attach(refused), 'elsewhere');
      check(build + ' failed proof never kills the kept child', alive(moved.transferred[0].pid));
      await blocked.close();
      const drain = f.service(returned), final = f.session(drain);
      checkEqual(build + ' can recover after a failed proof', await drain.attach(final), true);
      final.proc.stdin.write(JSON.stringify({ type: 'fixture.finish' }) + '\n');
      check(build + ' original keeper retires by itself after the run drains', await wait(() => !alive(f.source.keeperPid), 4000));
    } finally { await f.close(); }
  }
  suite('R27 source drain/upgrade starts new runs only in the current metaVersion-1 keeper');
  const upgrade = await keeperFixture('d7129af02c46');
  try {
    const old = await releaseKeeper(upgrade.source, [upgrade.original], { snapshot: upgrade.snapshot }); await upgrade.source.close();
    const window = require('../src/keeperLink').createWindowKeeper({ dir: upgrade.source.dir, env: upgrade.env }); upgrade.links.push(window);
    const restored = upgrade.session(window);
    checkEqual('a current source reload attaches the old kept run without replacing it', await window.attach(restored), true);
    const spawn = window.spawner(), next = new Session({ id: 'new-source-chat', cwd: upgrade.dir, claudePath: process.execPath,
      spawner: (_cmd, args, options, s) => spawn(process.execPath, [path.join(fixtures, 'streaming-claude.js'), ...args],
        { ...options, env: { ...upgrade.env, FAKE_SESSION_ID: 'new-current-conversation' } }, s) });
    next.send('new current keeper turn');
    check('a new source turn streams from a separate current keeper', await wait(() => /w3 /.test(text(next))));
    upgrade.pids.add(next.proc.pid); upgrade.pids.add(next.proc.link.keeperPid);
    checkEqual('new source runs use only keeper/meta1', next.proc.link.dir, path.join(upgrade.source.dir, 'meta1'));
    const hello = await next.proc.link.request({ t: 'hello' }, 1000);
    checkEqual('new keepers advertise additive versioned capabilities', [hello.proto, hello.metaVersion, hello.capabilities],
      [1, 1, { version: 1, exactAttach: 1, reclaim: 1, checkpointTail: 1, guardedMetadata: 1, release: 1, retainCustody: 1 }]);
    check('the old run remains in the same old keeper', restored.proc.pid === old.transferred[0].pid && alive(restored.proc.pid));
    const transferred = await releaseKeeper(window, [restored, next], { snapshot: upgrade.snapshot });
    checkEqual('a mixed old/current source exports both exact directories', transferred.transferred.map((r) => r.directory).sort(),
      [upgrade.source.dir, path.join(upgrade.source.dir, 'meta1')].sort());
  } finally { await upgrade.close(); }
  suite('R27 missing OS facts, changed bytes and ambiguous legacy keys refuse without signals');
  const { processSnapshot } = require('../src/keeperContinuity');
  const facts = await processSnapshot([7, 8, 7], (_file, args, options, done) => {
    check('process identities are read in one bounded request', args[2] === '7,8' && options.timeout === 2000);
    done(null, ' 7  1  Sun Nov  1 12:34:56 2026 /node /private/path with spaces/keeper.js sock\n 8 7 Sun Nov 1 12:35:00 2026 claude --resume conversation\n');
  });
  checkEqual('process start padding and full argv are preserved', [facts.get(7).started, facts.get(7).command, facts.get(8).parent],
    ['Sun Nov 1 12:34:56 2026', '/node /private/path with spaces/keeper.js sock', 7]);
  checkEqual('a denied OS probe has a specific blocker', await errorCode(() => processSnapshot([7], () => { throw Error('denied'); })), 'KEEPER_PROCESS_UNPROVEN');
  for (const problem of ['changed-bytes', 'ambiguous-key']) {
    const f = await keeperFixture('d7129af02c46');
    try {
      if (problem === 'changed-bytes') fs.appendFileSync(path.join(f.source.dir, 'keeper-d7129af02c46.js'), '\n');
      else {
        const reply = await f.source.request({ t: 'spawn', runId: crypto.randomUUID(), key: f.original.id, cmd: process.execPath,
          args: ['-e', 'process.stdin.resume()'], cwd: f.dir, env: f.env, snapshot: f.original.snapshot() }, 1000); f.pids.add(reply.pid);
      }
      checkEqual(problem + ' blocks before detachment', await errorCode(() => captureKeeper(f.source, [f.original], { snapshot: f.snapshot })),
        problem === 'changed-bytes' ? 'KEEPER_LEGACY_BUILD_UNSUPPORTED' : 'KEEPER_LEGACY_AMBIGUOUS');
      check(problem + ' leaves the original running chat alive', alive(f.original.proc.pid));
    } finally { await f.close(); }
  }
  suite('R27 actual client-process death at handoff boundaries keeps the original child recoverable');
  for (const build of Object.keys(BUILDS)) {
    const f = await keeperFixture(build), actors = [];
    try {
      const transfer = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      fs.writeFileSync(path.join(f.dir, 'actor-transfer.json'), JSON.stringify(transfer), { mode: 0o600 });
      const start = async () => {
        const actor = require('child_process').fork(path.join(fixtures, 'continuity-client.js'), [f.dir], { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); actors.push(actor);
        let stderr = ''; actor.stderr.on('data', (s) => { stderr += s; });
        const message = () => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('ACTOR_TIMEOUT: ' + stderr)), 5000);
          actor.once('message', (value) => { clearTimeout(timeout); resolve(value); });
          actor.once('exit', (code) => { clearTimeout(timeout); reject(Error('ACTOR_EXIT_' + code + ': ' + stderr)); });
        });
        const ready = await message(); return { actor, ready, message };
      };
      for (const boundary of ['source released', 'engine attached', 'app quit during Move', 'engine released for handback', 'source returned']) {
        const a = await start();
        check(build + ' recovered same streaming child after ' + boundary, a.ready.attached && a.ready.pid === transfer.transferred[0].pid && a.ready.text.includes('w1 '));
        if (boundary.includes('released')) { const next = a.message(); a.actor.send('release'); await next; }
        const ended = new Promise((resolve) => a.actor.once('exit', resolve)); a.actor.kill('SIGKILL'); await ended;
        check(build + ' real client crash at ' + boundary + ' leaves the run alive', alive(transfer.transferred[0].pid));
      }
      checkEqual(build + ' all crash recoveries keep the original single turn', f.log().filter((e) => e.type === 'user').length, 1);
    } finally { for (const actor of actors) if (actor.exitCode === null && actor.signalCode === null) actor.kill('SIGKILL'); await f.close(); }
  }
  suite('R27 real source bridge and production runtime Move/Restore with a kept legacy run');
  for (const offline of [false, true]) {
  const kept = await keeperFixture('d7129af02c46'), f = await require('./helpers/production-cutover').productionFixture();
  let runtime, returned;
  try {
    const slot = f.slots[0]; await f.close(slot); slot.original.subscriptions = [];
    slot.vscode.commands = { registerCommand: () => ({ dispose() {} }),
      executeCommand: async () => `CPU %\tMem MB\t PID\tProcess\n0\t0\t${process.pid}\textension-host\n0\t0\t1\twindow [1] (fixture)\n` };
    slot.vscode.window = { createStatusBarItem: () => ({ show() {}, dispose() {} }), createTreeView: () => ({ dispose() {} }), showWarningMessage: async () => {} };
    await f.open(slot, { productionAdapters: true, keeper: kept.source, keeperSnapshot: kept.snapshot });
    slot.source.keeperFile = path.join(slot.original.globalStorageUri.fsPath, 'round27.keepers');
    const live = slot.engine.manager.create({ id: kept.original.id, cwd: kept.dir, autoStart: false });
    live.hydrate(kept.original.snapshot()); live.proc = kept.original.proc; kept.original.proc = null;
    live.proc.session = live; live._wire(live.proc); slot.engine.manager.persist(); slot.engine.flush();
    const coordinator = require('../src/productionCutover').createProductionCutover({ selection: f.selection, secretAdapter: f.adapter,
      offlineDependencies: { keeperSnapshot: kept.snapshot } });
    const review = await coordinator.review();
    checkEqual('32-state-compatible real source review accepts exact legacy keeper proof', review.blockers, []);
    await coordinator.move(review); await kept.source.close();
    runtime = await f.start({ keeperFactory: (options) => options.legacy ? new (require('../src/legacyKeeper').LegacyKeeper)({ ...options, processSnapshot: kept.snapshot }) : new (require('../src/daemonKeeper').DaemonKeeper)(options) });
    await coordinator.finish();
    const running = runtime.engine.manager.get(live.id), before = text(running);
    check('real production runtime attaches original kept run', running.proc?.pid === [...kept.pids][0]);
    check('real Move continues live streaming with no new input', await wait(() => text(running).length > before.length + 15));
    checkEqual('Restore review permits proved kept turns', (await coordinator.handbackReview()).blockers, []);
    if (offline) { await runtime.stop(); runtime = null; check('offline Restore begins with the legacy child still alive', alive([...kept.pids][0])); }
    await coordinator.handback(); await runtime?.stop(); runtime = null;
    const transfer = require('../src/daemonPaths').readPrivateJson(slot.source.keeperFile);
    returned = require('../src/legacyExtensionSource').returnedKeeper({ ...slot.source, keeperTransfer: transfer }, {
      ownDirectory: path.join(kept.dir, 'returned-meta1'), factory: (options) => options.legacy ? new (require('../src/legacyKeeper').LegacyKeeper)({ ...options, processSnapshot: kept.snapshot }) : new (require('../src/daemonKeeper').DaemonKeeper)(options) });
    const editor = kept.session(returned); checkEqual((offline ? 'offline' : 'live') + ' current-state handback reattaches the same run in the editor', await returned.attach(editor), true);
    checkEqual('full Move/Restore never duplicates the running turn', kept.log().filter((e) => e.type === 'user').length, 1);
    editor.detach();
  } finally { await runtime?.stop(); await returned?.close(); await f.cleanup(); await kept.close(); }
  }
  suite('R27 real app SIGKILL at every Move publication boundary with an active legacy run');
  for (const boundary of ['reviewed', 'joined', 'barrier', 'source.freeze', 'imported', 'committed', 'launchable']) {
    const kept = await keeperFixture('d7129af02c46'), f = await require('./helpers/production-cutover').productionFixture();
    let app, runtime, back;
    try {
      const slot = f.slots[0]; await f.close(slot); slot.original.subscriptions = [];
      slot.vscode.commands = { registerCommand: () => ({ dispose() {} }),
        executeCommand: async () => `CPU %\tMem MB\t PID\tProcess\n0\t0\t${process.pid}\textension-host\n0\t0\t1\twindow [1] (fixture)\n` };
      slot.vscode.window = { createStatusBarItem: () => ({ show() {}, dispose() {} }), createTreeView: () => ({ dispose() {} }), showWarningMessage: async () => {} };
      await f.open(slot, { productionAdapters: true, keeper: kept.source, keeperSnapshot: kept.snapshot });
      slot.source.keeperFile = path.join(slot.original.globalStorageUri.fsPath, 'round27.keepers');
      const live = slot.engine.manager.create({ id: kept.original.id, cwd: kept.dir, autoStart: false });
      live.hydrate(kept.original.snapshot()); live.proc = kept.original.proc; kept.original.proc = null;
      live.proc.session = live; live._wire(live.proc); slot.engine.manager.persist(); slot.engine.flush();
      const keychain = path.join(kept.dir, 'test-keychain.json'), config = path.join(kept.dir, 'app-config.json');
      require('../src/engineOwner').atomicJson(keychain, { service: f.adapter.service, values: {} });
      require('../src/engineOwner').atomicJson(config, { selection: f.selection, keychain, boundary });
      app = require('child_process').spawn(process.execPath, [path.join(fixtures, 'cutover-app.js'), config], { env: kept.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; app.stderr.on('data', (s) => { stderr += s; });
      if (!await wait(() => fs.existsSync(path.join(kept.dir, 'app-boundary.json')), 10000)) throw Error('APP_BOUNDARY_TIMEOUT: ' + stderr);
      const end = new Promise((resolve) => app.once('exit', resolve)); app.kill('SIGKILL'); await end;
      check(boundary + ' actual app death leaves the exact child alive', alive([...kept.pids][0]));
      const adapter = require('./fixtures/keepers/file-keychain')(keychain);
      const coordinator = require('../src/productionCutover').createProductionCutover({ selection: f.selection, secretAdapter: adapter,
        offlineDependencies: { keeperSnapshot: kept.snapshot } });
      const { review } = JSON.parse(fs.readFileSync(path.join(kept.dir, 'app-boundary.json')));
      await coordinator.move(review); await kept.source.close();
      runtime = await require('../src/productionRuntime').startProductionRuntime({ selection: f.selection, secretAdapter: adapter,
        dependencies: { ...f.dependencies, keeperFactory: (options) => options.legacy ? new (require('../src/legacyKeeper').LegacyKeeper)({ ...options, processSnapshot: kept.snapshot }) : new (require('../src/daemonKeeper').DaemonKeeper)(options) } });
      await coordinator.finish();
      check(boundary + ' retry recovers the original streaming run', runtime.engine.manager.get(live.id)?.proc?.pid === [...kept.pids][0]);
      await coordinator.handback(); await runtime.stop(); runtime = null;
      const transferred = require('../src/daemonPaths').readPrivateJson(slot.source.keeperFile);
      back = kept.service(transferred.keeper); const editor = kept.session(back);
      checkEqual(boundary + ' Restore returns the same run after actual app crash', await back.attach(editor), true);
      checkEqual(boundary + ' crash never repeats the original input', kept.log().filter((s) => s.type === 'user').length, 1);
      editor.detach();
    } finally {
      if (app && app.exitCode === null && app.signalCode === null) app.kill('SIGKILL');
      await runtime?.stop(); await back?.close(); await f.cleanup(); await kept.close();
    }
  }
  suite('R27 exact tailnet handler transfer with a fake executable on PATH');
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/n27-ts-')), saved = { PATH: process.env.PATH, config: process.env.NIKUI_R27_TAILSCALE_CONFIG, log: process.env.NIKUI_R27_TAILSCALE_LOG };
  try {
    const binary = path.join(dir, 'tailscale'), file = path.join(dir, 'routes.json'), log = path.join(dir, 'calls.jsonl');
    fs.writeFileSync(binary, fs.readFileSync(path.join(fixtures, 'fake-tailscale.js'), 'utf8').replace('#!/usr/bin/env node', '#!' + process.execPath), { mode: 0o700 });
    const config = multiRoutes(4517), bytes = JSON.stringify(config); fs.writeFileSync(file, bytes, { mode: 0o600 });
    process.env.PATH = dir + ':' + saved.PATH; process.env.NIKUI_R27_TAILSCALE_CONFIG = file; process.env.NIKUI_R27_TAILSCALE_LOG = log;
    const tailscale = new Tailscale({ binary: 'tailscale', probe: async () => true }), record = routeRecord('fixture.tail123.ts.net', 4517);
    checkEqual('forwardedPort selects HTTPS 443 root among all ports and paths', await tailscale.forwardedPort(), 4517);
    const remote = { port: 4517 }, sources = [{ files: { routes: [record] } }];
    const exposure = await attachRoutes({ sources, remote, tailscale }); await exposure.review();
    checkEqual('engine uses the original tailnet hostname', remote.publicHost, record.host);
    await attachRoutes({ sources, remote: { port: 4517 }, tailscale });
    checkEqual('Move and handback leave every config byte unchanged', fs.readFileSync(file, 'utf8'), bytes);
    check('Move and handback issue only status reads', fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).every((a) => a.join(' ') === 'serve status --json'));
    for (const kind of ['proxy', 'funnel', 'tcp', 'missing', 'extra-handler-field']) {
      const changed = structuredClone(config);
      if (kind === 'proxy') changed.Web['fixture.tail123.ts.net:443'].Handlers['/'].Proxy = 'http://127.0.0.1:7777';
      if (kind === 'funnel') changed.AllowFunnel['fixture.tail123.ts.net:443'] = true;
      if (kind === 'tcp') changed.TCP[443] = { TCPForward: '127.0.0.1:4517' };
      if (kind === 'missing') delete changed.Web['fixture.tail123.ts.net:443'].Handlers['/'];
      if (kind === 'extra-handler-field') changed.Web['fixture.tail123.ts.net:443'].Handlers['/'].Text = 'changed';
      fs.writeFileSync(file, JSON.stringify(changed));
      checkEqual(kind + ' mismatch blocks without route changes', await errorCode(() => verifyRoute(tailscale, record)), 'ROUTE_OWNER_MISMATCH');
      check(kind + ' UI names the exact route and action', /fixture.tail123.ts.net.*Refresh/.test(routeProblem(record, changed).message));
    }
    fs.writeFileSync(file, bytes);
    checkEqual('explicit Stop removes only the exact recorded root', (await tailscale.hide(record)).ok, true);
    const after = JSON.parse(fs.readFileSync(file)); delete config.Web['fixture.tail123.ts.net:443'].Handlers['/'];
    checkEqual('all non-NikUI paths, ports and Funnels remain identical', JSON.stringify(after), JSON.stringify(config));
  } finally {
    process.env.PATH = saved.PATH;
    for (const [key, value] of [['NIKUI_R27_TAILSCALE_CONFIG', saved.config], ['NIKUI_R27_TAILSCALE_LOG', saved.log]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const problem = keeperProblem('KEEPER_LEGACY_BUILD_UNSUPPORTED', [{ id: 'one', customTitle: 'Kept research', proc: { kept: true } }]);
  check('unsupported build text gives chat name, count and exact remedy', /Kept research.*Stop these 1 running chats, then Refresh/.test(problem.message));
};
module.exports.keeperFixture = keeperFixture;
module.exports.multiRoutes = multiRoutes;
