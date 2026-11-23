'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { keeperFixture, multiRoutes } = require('./production-round27.test');
const { releaseKeeper, captureKeeper, BUILDS } = require('../src/keeperContinuity');
const { rescueRequest } = require('../src/keeperRescue');
const { LegacyKeeper } = require('../src/legacyKeeper');
const { DaemonKeeper } = require('../src/daemonKeeper');
const { createProductionKeeper } = require('../src/productionKeeper');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
async function wait(test, ms = 5000) { const end = Date.now() + ms; do { if (await test()) return; await pause(20); } while (Date.now() < end); throw Error('R31_WAIT_TIMEOUT'); }
const memory = () => { const m = new Map(); return { get: (k, d) => m.has(k) ? m.get(k) : d, update: (k, v) => m.set(k, structuredClone(v)) }; };
async function caseOf(name, action) { if (process.env.NIKUI_TEST_PROGRESS === '1') console.error(name); try { await action(); check(name, true); } catch (e) { checkEqual(name, e.stack || e.message, 'PASS'); } }
const factory = (f, snapshot = f.snapshot) => (o) => o.legacy ? new LegacyKeeper({ ...o, processSnapshot: snapshot }) : new DaemonKeeper(o);

module.exports = async () => {
  suite('R31 N1 live borrowed keys always exclude a second spawn');
  await caseOf('an unproved borrowed row reserves its key and cannot look like an idle conversation', async () => {
    const dir = fs.mkdtempSync('/tmp/n31-exclude-'), meta = { instance: 'proved', cwd: dir, conversation: 'conv' };
    const links = [];
    const link = createProductionKeeper({ root: dir, store: memory(), probe: async () => 'live',
      sources: [{ files: { keepers: [path.join(dir, 'old')] }, keeper: { transferred: [{ runId: 'a', meta }] } }],
      factory: (options) => {
        const borrowed = !!options.existingOnly;
        const value = { ...options, dir: options.dir, socketPath: path.join(options.dir, 'k1.sock'), socket: {}, procs: new Map(),
          manifest: new Map(borrowed ? [['proved', { runId: 'a', meta }]] : []), spawner: () => () => {},
          _list: async () => borrowed ? [{ runId: 'b', key: 'unproved', pid: 42, owned: true, exit: null }] : [],
          _block: DaemonKeeper.prototype._block, blockers: new Map(), disconnectIdle() { this.disconnected = true; }, close() {} };
        links.push(value); return value;
      } });
    try {
      const rows = await link._list(); assert(rows.some((r) => r.key === 'unproved'));
      assert.throws(() => DaemonKeeper.prototype._check.call(links[0], { instance: 'unproved', cwd: dir, conversation: null }, rows), { code: 'KEEPER_INSTANCE_LIVE' });
      const session = { id: 'unproved', cwd: dir };
      assert.equal(await link.attach(session), 'elsewhere'); assert(session.keeperRefusal);
      assert(links[1].disconnected, 'N8: a read-only observer disconnects after every listing');
    } finally { await link.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await caseOf('partial rescue returns both runs even when the engine never attached the second', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      f.env.FAKE_SESSION_ID = 'second-conversation'; const second = f.session(f.source, 'second-chat'); second.send('second turn');
      await wait(() => second.proc?.pid && second.claudeSessionId); f.pids.add(second.proc.pid);
      const t = await releaseKeeper(f.source, [f.original, second], { snapshot: f.snapshot }); await f.source.close();
      const engine = f.service(t), a = f.session(engine), b = f.session(engine, 'second-chat');
      assert.equal(await engine.attach(a), true);
      const borrowed = engine.links[1], attach = borrowed.attach.bind(borrowed);
      borrowed.attach = (s) => s.id === b.id ? borrowed._block(s, 'KEEPER_OWNED_ELSEWHERE') : attach(s);
      assert.equal(await engine.attach(b), 'elsewhere'); assert.equal(b.proc, null);
      assert((await rescueRequest(t.transferred[1], 'check')).held.includes(t.transferred[1].runId));
      const returned = await releaseKeeper(engine, [a, b]); await engine.close();
      assert.deepEqual(returned.transferred.map((r) => r.key).sort(), [a.id, b.id].sort());
      const back = f.service(returned), editor = f.session(back, b.id);
      assert.equal(await back.attach(editor), true); assert.equal(editor.proc.pid, t.transferred[1].pid);
      assert.equal(f.log().filter((r) => r.event === 'start').length, 2); assert.equal(f.log().filter((r) => r.type === 'user').length, 2);
      editor.stop(); await wait(() => !alive(t.transferred[1].pid));
    } finally { await f.close(); }
  });
  await caseOf('N8 a borrowed listing disconnects an observer while another client still owns a run', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const observer = f.service(t); await observer.request({ t: 'list' });
      assert.equal(observer.links[1].procs.size, 0); assert.equal(observer.links[1].socket, null);
    } finally { await f.close(); }
  });

  suite('R31 N2/N4 crash-safe leases and automatic proof retries');
  await caseOf('N4 an engine boot with an R29 proof and failed ps retains an owned blocked lease', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const transferred = await captureKeeper(f.source, [f.original], { snapshot: f.snapshot });
      for (const proof of transferred.transferred) { proof.released = true; proof.owned = false; }
      f.original.detach(); await f.source.close();
      let failed = true;
      const engine = createProductionKeeper({ root: path.join(f.dir, 'r29-restart'), store: memory(), retryMs: 40,
        factory: factory(f, (pids) => failed ? Promise.reject(Object.assign(Error('transient ps failure'), { code: 'KEEPER_PROCESS_UNPROVEN' })) : f.snapshot(pids)),
        sources: [{ files: { keepers: [f.source.dir] }, keeper: transferred }] }); f.links.push(engine);
      const session = f.session(engine); assert.equal(await engine.attach(session), 'elsewhere');
      assert.equal(session.keeperRefusal, 'KEEPER_PROCESS_UNPROVEN');
      assert(session.proc?.blocked && !session.proc.released, 'failed ps must adopt a blocked lease rather than leave the run orphaned');
      assert((await session.proc.link.request({ t: 'list' }, 1000)).runs[0].owned);
      failed = false; await wait(() => !session.keeperRefusal); assert.equal(session.proc.pid, transferred.transferred[0].pid);
      session.stop(); await wait(() => !alive(transferred.transferred[0].pid));
    } finally { await f.close(); }
  });
  await caseOf('source quit leaves independent custody while a transient proof failure retries', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      assert((await rescueRequest(t.transferred[0], 'status')).held.includes(t.transferred[0].runId));
      let failed = true;
      const engine = createProductionKeeper({ root: path.join(f.dir, 'retry-engine'), store: memory(), retryMs: 40,
        factory: factory(f, (pids) => failed ? Promise.reject(Error('ps timeout')) : f.snapshot(pids)),
        sources: [{ files: { keepers: [f.source.dir] }, keeper: t }] }); f.links.push(engine);
      const session = f.session(engine); assert.equal(await engine.attach(session), 'elsewhere');
      assert(session.proc?.blocked); failed = false;
      await wait(() => !session.keeperRefusal); assert.equal(session.proc.pid, t.transferred[0].pid);
      session.stop(); await wait(() => !alive(t.transferred[0].pid));
    } finally { await f.close(); }
  });
  await caseOf('Restore can pause indefinitely without any source observer or custody handoff timer', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const first = await rescueRequest(t.transferred[0], 'status'); await pause(80);
      const second = await rescueRequest(t.transferred[0], 'status');
      assert.equal(first.pid, second.pid); assert.deepEqual(first.held, second.held);
    } finally { await f.close(); }
  });
  await caseOf('a current meta1 run also keeps independent custody when its source host closes', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const source = new (require('../src/keeperLink').KeeperLink)({ dir: path.join(f.dir, 'current'), env: f.env }); f.links.push(source);
      f.env.FAKE_SESSION_ID = 'current-conversation'; const live = f.session(source, 'current-chat'); live.send('current turn');
      await wait(() => live.proc?.pid && live.claudeSessionId); f.pids.add(live.proc.pid); f.pids.add(source.keeperPid);
      const transferred = await releaseKeeper(source, [live]); await source.close(); const proof = transferred.transferred[0];
      assert(!proof.legacy); assert(proof.keeperCustody); assert(!proof.rescue);
      assert(!fs.existsSync(require('../src/keeperRescue').socketFor(source.dir)));
      const engine = createProductionKeeper({ root: path.join(f.dir, 'current-engine'), store: memory(),
        sources: [{ files: { keepers: [source.dir] }, keeper: transferred }] }); f.links.push(engine);
      const resumed = f.session(engine, live.id); assert.equal(await engine.attach(resumed), true); assert.equal(resumed.proc.pid, proof.pid);
      resumed.stop(); await wait(() => !alive(proof.pid));
    } finally { await f.close(); }
  });

  suite('R31 N3 failed or ambiguous status reads can never authorize a serve mutation');
  for (const [name, out] of [
    ['timeout', { code: 1, stderr: 'timed out' }], ['unreadable JSON', { code: 0, stdout: 'no json' }],
    ['empty output', { code: 0, stdout: '' }], ['invalid Web', { code: 0, stdout: '{"Web":[]}' }],
    ['ambiguous roots', { code: 0, stdout: JSON.stringify({ Web: { 'a.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4517' } } },
      'b.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4518' } } } } }) }],
    ['foreign handler', { code: 0, stdout: '{"Web":{"a.ts.net:443":{"Handlers":{"/":{"Text":"foreign"}}}}}' }]
  ]) await caseOf(name + ' refuses forwarding discovery', async () => {
    const tailscale = new (require('../src/tunnel').Tailscale)({ binary: '/fixture/tailscale', run: async () => out });
    await assert.rejects(() => tailscale.forwardedPort());
  });
  await caseOf('background discovery has a long deadline; review has one cached 650ms read', async () => {
    const calls = [], tailscale = new (require('../src/tunnel').Tailscale)({ binary: '/fixture/tailscale', run: async (argv, options) => {
      calls.push({ argv, options }); return { code: 0, stdout: JSON.stringify(multiRoutes(4517)) };
    } });
    assert.equal(await tailscale.forwardedPort(), 4517); assert.equal(calls[0].options.timeout, 15000);
    const review = require('../src/routeContinuity').routeCheck(tailscale); await Promise.all([review.serveConfig(), review.serveConfig()]);
    assert.equal(calls.length, 2); assert.equal(calls[1].options.timeout, 650);
  });
  await caseOf('a slow failed background read and an unknown explicit Reach perform zero expose calls', async () => {
    const { install, fakeContext } = require('./helpers/vscode-stub'), vscode = install(), saved = { ...vscode.__config };
    Object.assign(vscode.__config, { 'remote.autoStart': false, 'remote.port': 0, 'remote.tailnet': true, 'voice.enabled': false });
    let exposes = 0; const unhandled = [], listener = (e) => unhandled.push(e); process.on('unhandledRejection', listener);
    const tailscale = { forwardedPort: async () => { await pause(30); throw Error('unknown'); },
      status: async () => ({ installed: true, running: true, https: true, name: 'fixture.ts.net' }), expose: async () => { exposes++; return { ok: true }; } };
    const server = require('../src/extension').serveLocally(fakeContext(), { list: [], get() {}, on() {}, off() {} }, { state: () => null }, null, { tailscale });
    try {
      await vscode.__registered.commands['nikui.remoteStart'](); await pause(80);
      await vscode.__registered.commands['nikui.reachFromPhone']();
      assert.equal(exposes, 0); assert.equal(unhandled.length, 0);
    } finally { await server.dispose(); process.removeListener('unhandledRejection', listener); Object.keys(vscode.__config).forEach((k) => delete vscode.__config[k]); Object.assign(vscode.__config, saved); }
  });
  await caseOf('an explicit exposure-record failure is caught and never becomes an unhandled rejection', async () => {
    const { install, fakeContext } = require('./helpers/vscode-stub'), vscode = install(), saved = { ...vscode.__config };
    Object.assign(vscode.__config, { 'remote.autoStart': false, 'remote.port': 0, 'remote.tailnet': true, 'voice.enabled': false });
    let exposes = 0; const unhandled = [], listener = (e) => unhandled.push(e); process.on('unhandledRejection', listener);
    const tailscale = { forwardedPort: async () => null, serveConfig: async () => { throw Error('record read timed out'); },
      status: async () => ({ installed: true, running: true, https: true, name: 'fixture.ts.net' }),
      expose: async () => { exposes++; return { ok: true, host: 'fixture.ts.net' }; } };
    const server = require('../src/extension').serveLocally(fakeContext(), { list: [], get() {}, on() {}, off() {} }, { state: () => null }, null, { tailscale });
    try { await vscode.__registered.commands['nikui.remoteStart'](); await pause(80); await vscode.__registered.commands['nikui.reachFromPhone'](); assert.equal(exposes, 1); assert.deepEqual(unhandled, []); }
    finally { await server.dispose(); process.removeListener('unhandledRejection', listener); Object.keys(vscode.__config).forEach((k) => delete vscode.__config[k]); Object.assign(vscode.__config, saved); }
  });

  suite('R31 N5 review preserves route evidence through transient absence');
  await caseOf('an absent review warns but never deletes the recorded handler', async () => {
    const { install, fakeContext } = require('./helpers/vscode-stub'), vscode = install(), saved = { ...vscode.__config };
    Object.assign(vscode.__config, { 'remote.autoStart': false, 'remote.port': 0, 'remote.tailnet': false, 'voice.enabled': false });
    const context = fakeContext(), { ROUTE_KEY, routeRecord } = require('../src/routeContinuity');
    let config = {}; const tailscale = { serveConfig: async () => config, forwardedPort: async () => null };
    const server = require('../src/extension').serveLocally(context, { list: [], get() {}, on() {}, off() {} }, { state: () => null }, null, { tailscale });
    try {
      await server.start(0); config = multiRoutes(server.port); await server.recordPhoneRoute(); const record = routeRecord('fixture.tail123.ts.net', server.port);
      config = {}; await server.sourceReleaseReadiness(); assert.deepEqual(context.workspaceState.get(ROUTE_KEY), record);
      assert.equal(server.sourceReleaseWarnings.length, 1); assert.equal(server.sourceRouteRecord(), null);
      config = multiRoutes(server.port); await server.sourceReleaseReadiness(); assert.deepEqual(server.sourceRouteRecord(), record);
    } finally { await server.dispose(); Object.keys(vscode.__config).forEach((k) => delete vscode.__config[k]); Object.assign(vscode.__config, saved); }
  });

  suite('R31 H3 bounded offline Restore and N6 single in-flight watchdog');
  await caseOf('a keeper that never answers reserves each original run and does not block offline export', async () => {
    const { offlineKeeperRuns } = require('../src/offlineProductionExport');
    const proofs = ['a', 'b'].map((key) => ({ runId: 'run-' + key, key, pid: 42, meta: { instance: key, cwd: '/tmp', conversation: key } }));
    let destroyed = false;
    const link = { connect: () => new Promise(() => {}), socket: { destroy() { destroyed = true; } } };
    const before = Date.now(), rows = await offlineKeeperRuns(link, proofs, { timeoutMs: 40 });
    assert(Date.now() - before < 300); assert(destroyed); assert.equal(rows.length, 2);
    assert(rows.every((r) => r.blocker === 'KEEPER_UNAVAILABLE' && r.owned && r.lease === 'blocked'));
  });
  await caseOf('offline Restore completes when the legacy keeper listing hangs forever', async () => {
    const kept = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    const f = await require('./helpers/production-cutover').productionFixture(); let runtime, timer;
    const listing = LegacyKeeper.prototype._list;
    try {
      const slot = await require('./production-round29.test').sourceAdapters(f, { keeper: kept.source, keeperSnapshot: kept.snapshot });
      slot.source.keeperFile = path.join(slot.original.globalStorageUri.fsPath, 'r31-hung.keepers'); const file = slot.source.keeperFile;
      const live = slot.engine.manager.create({ id: kept.original.id, cwd: kept.dir, autoStart: false });
      live.hydrate(kept.original.snapshot()); live.proc = kept.original.proc; kept.original.proc = null;
      live.proc.session = live; live._wire(live.proc); slot.engine.manager.persist(); slot.engine.flush();
      const coordinator = f.coordinator({ offlineDependencies: { keeperSnapshot: kept.snapshot } });
      await coordinator.move(await coordinator.review()); runtime = await f.start({ keeperFactory: factory(kept) }); await coordinator.finish();
      await runtime.stop(); runtime = null;
      LegacyKeeper.prototype._list = () => new Promise(() => {});
      const result = await Promise.race([coordinator.handback(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('RESTORE_BLOCKED_BY_HUNG_KEEPER')), 7000); })]);
      assert.equal(result.stage, 'returned');
      const proof = require('../src/daemonPaths').readPrivateJson(file).keeper.transferred[0];
      assert.equal(proof.blocker, 'KEEPER_UNAVAILABLE'); assert.equal(proof.pid, [...kept.pids][0]); assert(alive(proof.pid));
    } finally { clearTimeout(timer); LegacyKeeper.prototype._list = listing; await runtime?.stop(); await f.cleanup(); await kept.close(); }
  });
  await caseOf('concurrent restored clients cannot both claim a retained legacy run', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const one = f.service(t), two = f.service(t), a = f.session(one), b = f.session(two);
      const results = await Promise.all([one.attach(a), two.attach(b)]);
      assert.equal(results.filter((r) => r === true).length, 1);
      assert.equal(results.filter((r) => r === 'elsewhere').length, 1);
      (a.proc || b.proc).stdin.end(); await wait(() => !alive(t.transferred[0].pid));
    } finally { await f.close(); }
  });

  suite('R31 N7 dropped stop across reconnect and bounded visible restart');
  await caseOf('an unconfirmed kept stop reports a bounded notice and never starts another process', async () => {
    const { Session } = require('../src/session'), { EventEmitter } = require('events');
    const session = new Session({ id: 'stopping', cwd: '/tmp', claudePath: '/fixture/claude' });
    const proc = Object.assign(new EventEmitter(), { kept: true, exitCode: null, signalCode: null });
    session._stoppingProc = proc; let spawned = 0; session.spawner = () => { spawned++; };
    const original = global.setTimeout;
    try { global.setTimeout = (fn, ms, ...args) => original(fn, ms === 10000 ? 1 : ms, ...args); session.start(); }
    finally { global.setTimeout = original; }
    await pause(25); assert(session.items.some((i) => i.kind === 'notice' && /Stop has not been confirmed/.test(i.text)));
    assert.equal(spawned, 0); session.disposed = true; proc.emit('exit');
  });
  await caseOf('a lost stop is resent after reconnect before any replacement starts', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const engine = f.service(t), s = f.session(engine); assert.equal(await engine.attach(s), true);
      const link = s.proc.link, send = link.send.bind(link); let dropped = false;
      link.send = (msg) => { if (msg.t === 'stop' && !dropped) { dropped = true; link.socket.destroy(); return false; } return send(msg); };
      s.stop(); s.start(); await wait(() => !alive(t.transferred[0].pid), 8000); assert(dropped);
      assert(f.log().filter((r) => r.event === 'start').length <= 2);
      if (s.proc?.pid) { f.pids.add(s.proc.pid); f.pids.add(s.proc.link.keeperPid); s.stop(); }
    } finally { await f.close(); }
  });

  suite('R31 native failure regressions');
  await caseOf('join saves the actual listener before a reload can happen ahead of freeze', async () => {
    const f = await require('./helpers/production-cutover').productionFixture();
    try {
      f.user['remote.port'] = 54321;
      const slot = await require('./production-round29.test').sourceAdapters(f, {
        server: { listening: true, port: 54322, stop() {}, sourceReleaseReadiness: async () => [] }
      });
      const coordinator = f.coordinator({ inspectPort: async () => ({ available: true, port: 54321 }),
        checkpoint: async (stage) => { if (stage === 'barrier') throw Object.assign(Error('reload before freeze'), { crash: true }); } });
      await assert.rejects(async () => coordinator.move(await coordinator.review()));
      const saved = require('../src/legacyExtensionSource').returnListener(slot.source, 54321);
      assert.equal(saved?.port, 54322); assert.equal(saved.configuredPort, 54321);
      assert.equal(fs.existsSync(slot.source.snapshotsFile), false, 'join cannot save an early queue snapshot over later legacy edits');
      let port;
      await require('../src/legacyExtensionSource').startReturnedListener({ async start(value) { port = value; this.port = value; } }, slot.source, 54321);
      assert.equal(port, 54322, 'a fallback window must not take its sibling’s configured fixed port on abort');
    } finally { await f.cleanup(); }
  });
  await caseOf('the original native legacy child receives the fixture log and conversation environment', async () => {
    let options; const spawn = require('../scripts/test-mac-cutover').legacyFixtureSpawner({ spawner: () => (_cmd, _args, value) => { options = value; } },
      { FAKE_LOG: '/tmp/fixture/log', FAKE_SESSION_ID: 'native' });
    spawn('claude', [], { env: { PATH: '/bin' } }, {});
    assert.equal(options.env.FAKE_LOG, '/tmp/fixture/log'); assert.equal(options.env.FAKE_SESSION_ID, 'native'); assert.equal(options.env.PATH, '/bin');
  });
  await caseOf('first-run cleanup signals only captured app births and verifies their absence', async () => {
    const { quitOpenedApp } = require('../scripts/test-mac-app');
    let clock = 0, present = true; const sent = [], executable = '/tmp/final/NikUI.app/Contents/MacOS/NikUI';
    const proof = { pid: 42, started: 'birth', command: executable };
    const result = await quitOpenedApp({ executable, launched: [proof], now: () => clock, graceMs: 20, killMs: 20,
      sleep: async () => { clock += 10; }, cli: (op, ...args) => { if (op === 'quit-app') assert.deepEqual(args, ['42']); return { pids: present ? [42] : [] }; },
      snapshot: async () => new Map(present ? [[42, proof], [43, { ...proof, pid: 43, command: '/Applications/NikUI.app/Contents/MacOS/NikUI' }]] : []),
      kill: (pid, signal) => { sent.push([pid, signal]); present = false; } });
    assert(result.absent); assert.deepEqual(sent, [[42, 'SIGTERM']]);
  });

  suite('R31 ownership invariant across real immutable keeper crash and timeout matrices');
  for (const build of Object.keys(BUILDS)) for (const failure of ['source-exits-before-boot', 'engine-exits-after-attach', 'ps-fails-at-boot', 'Restore-pauses']) {
    await caseOf(build + ' / ' + failure + ': one owner or one bounded handoff, one process and one turn', async () => {
      const f = await keeperFixture(build, 'never-exiting-claude.js');
      try {
        const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
        const proof = t.transferred[0];
        assert((await rescueRequest(proof, 'status')).held.includes(proof.runId));
        if (failure === 'Restore-pauses') await pause(50);
        let failedProbe = failure === 'ps-fails-at-boot';
        const engine = createProductionKeeper({ root: path.join(f.dir, 'matrix'), store: memory(),
          factory: factory(f, (pids) => failedProbe ? Promise.reject(Object.assign(Error('slow ps'), { code: 'KEEPER_PROCESS_UNPROVEN' })) : f.snapshot(pids)),
          sources: [{ files: { keepers: [f.source.dir] }, keeper: t }] }); f.links.push(engine);
        const s = f.session(engine), outcome = await engine.attach(s);
        assert.equal(outcome, failedProbe ? 'elsewhere' : true);
        assert(s.proc?.kept && !s.proc.released, 'even an unproved live run has a lease');
        const rows = await s.proc.link.request({ t: 'list' }, 1000); assert(rows.runs.find((r) => r.runId === proof.runId).owned);
        assert(!(await rescueRequest(proof, 'status')).held.includes(proof.runId), 'custodian and engine never both own');
        if (failedProbe) { failedProbe = false; await engine.retryBlocked(); assert(!s.proc.blocked); }
        if (failure === 'engine-exits-after-attach') {
          await engine.close(); await rescueRequest(proof, 'check');
          // Yield has a five-second bounded handoff; do not wait out the
          // 180-second immutable orphan grace to establish recovery.
          await wait(async () => (await rescueRequest(proof, 'check')).held.includes(proof.runId), 6500);
          const next = f.service(t), recovered = f.session(next); assert.equal(await next.attach(recovered), true); recovered.stop();
        } else s.stop();
        await wait(() => !alive(proof.pid), 7000);
        assert.equal(f.log().filter((r) => r.event === 'start').length, 1); assert.equal(f.log().filter((r) => r.type === 'user').length, 1);
      } finally { await f.close(); }
    });
  }
};
