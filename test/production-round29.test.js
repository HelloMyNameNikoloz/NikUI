'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { keeperFixture, multiRoutes } = require('./production-round27.test');
const { captureKeeper, releaseKeeper, BUILDS } = require('../src/keeperContinuity');
const { LegacyKeeper } = require('../src/legacyKeeper');
const { DaemonKeeper } = require('../src/daemonKeeper');
const { createProductionKeeper } = require('../src/productionKeeper');
const { routeRecord, recordWindowRoute, attachRoutes } = require('../src/routeContinuity');
const { Tailscale, STATUS_TIMEOUT_MS } = require('../src/tunnel');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
async function wait(test, ms = 5000) { const end = Date.now() + ms; do { if (await test()) return true; await pause(20); } while (Date.now() < end); return false; }
const memory = () => { const m = new Map(); return { get: (k, d) => m.has(k) ? m.get(k) : d, update: (k, v) => m.set(k, structuredClone(v)) }; };
async function caseOf(name, action) { try { await action(); check(name, true); } catch (e) { checkEqual(name, e.stack || e.message, 'PASS'); } }
const factory = (f, snapshot = f.snapshot) => (o) => o.legacy ? new LegacyKeeper({ ...o, processSnapshot: snapshot }) : new DaemonKeeper(o);
async function sourceAdapters(f, options = {}) {
  const slot = f.slots[0]; await f.close(slot); slot.original.subscriptions = [];
  slot.vscode.commands = { registerCommand: () => ({ dispose() {} }), executeCommand: async () => `CPU %\tMem MB\t PID\tProcess\n0\t0\t${process.pid}\textension-host\n0\t0\t1\twindow [1] (fixture)\n` };
  slot.vscode.window = { createStatusBarItem: () => ({ show() {}, dispose() {} }), createTreeView: () => ({ dispose() {} }), showWarningMessage: async () => {} };
  await f.open(slot, { productionAdapters: true, ...options }); return slot;
}
module.exports = async () => {
  suite('R29 H1 user controls, restart and retirement with a Claude that never exits on its own');
  for (const phase of ['Move', 'Restore']) for (const action of ['interrupt-stop', 'sleep', 'close', 'restart', 'phone-restart', 'forget']) {
    await caseOf(phase + ' allows ' + action + ' and drains the legacy keeper', async () => {
      const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js'); let returned;
      try {
        const transfer = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
        let link = f.service(transfer), source;
        if (phase === 'Restore') {
          await link.close();
          source = { keeperFile: path.join(f.dir, 'returned.keepers'), keeperTransfer: { files: { keepers: [f.source.dir] }, keeper: transfer } };
          require('../src/engineOwner').atomicJson(source.keeperFile, source.keeperTransfer);
          returned = require('../src/legacyExtensionSource').returnedKeeper(source, { ownDirectory: path.join(f.dir, 'returned-meta1'), factory: factory(f) }); link = returned;
        }
        const s = f.session(link); assert.equal(await link.attach(s), true);
        const pid = s.proc.pid, old = s.proc;
        if (action === 'interrupt-stop') {
          s.interrupt(); assert(await wait(() => !s.inTurn)); assert(alive(pid), 'result keeps interactive Claude alive');
          assert(f.log().some((r) => r.type === 'control_request')); s.stop();
        } else if (action === 'restart' || action === 'phone-restart') {
          if (action === 'phone-restart') {
            const engine = { manager: { get: () => s, settingsSource: () => ({ get: (k, d) => k === 'claudePath' ? process.execPath : d }) }, codex: { get() {} }, flush() {} };
            const management = require('../src/localManagement').createLocalManagement({ engine, generation: 'test', admitting: () => true,
              authorize: () => true, store: memory(), root: f.dir });
            const result = await management.dispatch({ authenticated: true, principal: 'local:fixture', seat: { local: true, control: true } },
              { type: 'local:request', version: 1, id: 'a'.repeat(32), generation: 'test', op: 'session.restart', args: { id: s.id, mode: 'context' } });
            assert.equal(result.ok, true);
          }
          else s.restart();
          assert(await wait(() => s.proc?.pid && s.proc.pid !== pid && s.proc.state === 'kept', 7500), 'restart starts a new current run after old exit');
          f.pids.add(s.proc.pid); f.pids.add(s.proc.link.keeperPid);
          assert.equal(s.proc.link.metaVersion, 1); s.stop();
        } else if (action === 'forget') old.link.forget(old);
        else if (action === 'close') s.dispose();
        else require('../src/manager').SessionManager.prototype.sleep.call({ sessions: new Map([[s.id, s]]), _changed() {} }, s.id);
        assert(await wait(() => !alive(pid), 6000), 'owned user stop reaches keeper');
        assert(await wait(() => !alive(f.source.keeperPid), 4500), 'no clients pin an empty old keeper');
        if (returned) {
          await returned.endAttach();
          assert.equal(returned.borrowed, false); assert.equal(source.keeperTransfer, null);
          assert(!fs.existsSync(source.keeperFile));
        }
      } finally { await returned?.close(); await f.close(); }
    });
  }
  suite('R29 H3 individual process proofs and parent reparenting');
  await caseOf('an idle second window inventories foreign legacy runs without pinning their keeper', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const service = f.service(t), s = f.session(service); assert.equal(await service.attach(s), true);
      const observer = require('../src/keeperLink').createWindowKeeper({ dir: f.source.dir, env: f.env }); f.links.push(observer);
      assert.equal(await observer.attach(f.session(observer, 'other-window')), false); await observer.endAttach?.();
      const inventory = await captureKeeper(observer, []);
      assert.equal(inventory.legacyInventory[0].runs[0].runId, t.transferred[0].runId);
      assert.equal(observer.links[0].socket, null);
      s.stop(); assert(await wait(() => !alive(t.transferred[0].pid)));
      assert(await wait(() => !alive(f.source.keeperPid), 4500), 'an open idle window does not prevent retirement');
    } finally { await f.close(); }
  });
  await caseOf('Restore grants each window only its own returned run manifests', async () => {
    const original = (id) => ({ id, provenance: { workspace: '/tmp/' + id }, workspace: {}, settings: { projects: [] },
      files: { exportedSessionIDs: [id], sourceFolders: ['/tmp/' + id] } });
    const runs = ['a', 'b'].map((id) => ({ key: id, runId: 'run-' + id, directory: '/tmp/keeper-' + id }));
    const selected = { files: { workspaces: [original('a'), original('b')], keepers: runs.map((r) => r.directory), sessions: [] },
      settings: { projects: [] }, folders: { folders: [], assign: {}, byConversation: {} } };
    const payload = require('../src/legacyExtensionSource').workspaceReturn({ sources: [selected], instances: ['a', 'b'].map((id) => ({ id, cwd: '/tmp/' + id })),
      returnKeeper: { metaVersion: 1, runs, transferred: runs } }, '/tmp/a', 'a');
    assert.deepEqual(payload.keepers.keeper.transferred.map((r) => r.key), ['a']);
    assert.deepEqual(payload.keepers.files.keepers, ['/tmp/keeper-a']);
  });
  for (const bad of ['child-exited', 'ps-timeout', 'hung-keeper', 'keeper-reparented']) await caseOf(bad + ' is isolated to its known conversations', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      f.env.FAKE_SESSION_ID = 'second-conversation'; const second = f.session(f.source, 'second-chat'); second.send('second');
      assert(await wait(() => second.proc?.pid && second.claudeSessionId)); f.pids.add(second.proc.pid);
      const transfer = await releaseKeeper(f.source, [f.original, second], { snapshot: f.snapshot }); await f.source.close();
      const snapshot = async (pids) => {
        if (bad === 'ps-timeout' && pids.includes(transfer.transferred[1].pid)) throw Object.assign(Error('ps timed out'), { code: 'KEEPER_PROCESS_UNPROVEN' });
        const facts = await f.snapshot(pids);
        if (bad === 'child-exited') facts.delete(transfer.transferred[1].pid);
        if (bad === 'keeper-reparented') facts.get(f.source.keeperPid).parent = 1;
        return facts;
      };
      const link = createProductionKeeper({ root: path.join(f.dir, 'engine'), store: memory(), sources: [{ files: { keepers: [f.source.dir] }, keeper: transfer }], factory: factory(f, snapshot) }); f.links.push(link);
      if (bad === 'hung-keeper') link.links[1]._list = async () => { throw Object.assign(Error('hung'), { code: 'KEEPER_UNAVAILABLE' }); };
      await link.beginAttach(); const a = f.session(link), b = f.session(link, 'second-chat');
      assert.equal(await link.attach(a), bad === 'hung-keeper' ? 'elsewhere' : true);
      assert.equal(await link.attach(b), bad === 'keeper-reparented' ? true : 'elsewhere');
      if (bad !== 'keeper-reparented') assert(/^KEEPER_/.test(b.keeperRefusal));
      const listing = await link.request({ t: 'list' }); assert.equal(listing.runs.length, 2);
      link.endAttach();
      const fresh = f.session(link, 'new-chat'); fresh.send('unrelated new conversation');
      assert(await wait(() => fresh.proc?.state === 'kept'), 'unrelated spawn remains available');
      f.pids.add(fresh.proc.pid); f.pids.add(fresh.proc.link.keeperPid);
      assert(!fresh.keeperRefusal); fresh.stop();
    } finally { await f.close(); }
  });
  suite('R29 M4 metadata changes and failed storage retain the owned run');
  await caseOf('cwd/session updates persist; a failed manifest write never releases a live borrowed run', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const link = f.service(t), s = f.session(link); assert.equal(await link.attach(s), true);
      s.claudeSessionId = 'updated-conversation'; s.cwd = path.join(f.dir, 'updated'); fs.mkdirSync(s.cwd);
      s.proc.checkpoint(); await pause(30);
      const borrowed = s.proc.link, proof = borrowed.manifest.get(s.id);
      assert.equal(proof.meta.cwd, s.cwd); assert.equal(proof.meta.conversation, s.claudeSessionId); assert(proof.legacy);
      borrowed.store.update = () => { throw Error('disk full'); }; s.claudeSessionId = 'next-conversation'; s.proc.checkpoint();
      assert.equal(s.keeperRefusal, 'KEEPER_MANIFEST_UNAVAILABLE'); assert.equal(s.proc.released, false);
      assert((await borrowed.request({ t: 'list' }, 1000)).runs[0].owned); assert(alive(s.proc.pid));
      s.stop(); assert(await wait(() => !alive(t.transferred[0].pid)));
    } finally { await f.close(); }
  });
  suite('R29 H2 route availability is optional at startup and offline Restore');
  for (const mode of ['absent', 'quit', 'logged-out', 'slow', 'handler-removed']) await caseOf(mode + ' does not stop engine startup or Restore', async () => {
    const f = await require('./helpers/production-cutover').productionFixture(); let runtime;
    try {
      const probe = require('net').createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise((r) => probe.close(r));
      const route = routeRecord('fixture.tail123.ts.net', port);
      const server = { port, listening: false, stop() {}, sourceReleaseReadiness: async () => [], sourceRouteRecord: () => route, sourceRelease() {} };
      await sourceAdapters(f, { server });
      const tailscale = mode === 'handler-removed' ? { serveConfig: async () => ({}) } : mode === 'slow'
        ? new Tailscale({ binary: process.execPath, run: async (_argv, options) => { await pause(options?.timeout || 650); return { code: 1, stderr: 'timeout' }; } })
        : { serveConfig: async () => { throw Error(mode); } };
      const coordinator = f.coordinator({ offlineDependencies: { tailscale } }); await coordinator.move(await coordinator.review());
      const started = Date.now(); runtime = await f.start({ tailscale }); assert(Date.now() - started < 2000);
      assert.equal(runtime.status().state, 'running'); assert.equal(runtime.engine.remote.exposed, false);
      assert.equal(runtime.status().warnings.length, 1); await coordinator.finish();
      assert.equal((await coordinator.handbackReview()).ready, true);
      await runtime.stop(); runtime = null; await coordinator.handback();
      assert.equal(f.slots[0].original.workspaceState.get(require('../src/routeContinuity').ROUTE_KEY), undefined);
    } finally { await runtime?.stop(); await f.cleanup(); }
  });
  suite('R29 M5/M6 recorded routes use only the current window port and no serve mutation');
  await caseOf('Record action reads only status once and rejects another port', async () => {
    let calls = 0; const original = multiRoutes(49219), bytes = JSON.stringify(original);
    const tailscale = new Tailscale({ binary: '/private/fixture/tailscale', run: async (argv) => {
      assert.deepEqual(argv.slice(1), ['serve', 'status', '--json']); calls++; return { code: 0, stdout: bytes };
    } });
    assert.deepEqual(await recordWindowRoute(tailscale, 49219), routeRecord('fixture.tail123.ts.net', 49219)); assert.equal(calls, 1);
    await assert.rejects(() => recordWindowRoute(tailscale, 49220)); assert.equal(JSON.stringify(original), bytes);
  });
  await caseOf('a reopened window cannot export or remove its old port’s route; absent records can be cleared', async () => {
    const { install, fakeContext } = require('./helpers/vscode-stub');
    const stub = install(), savedConfig = { ...stub.__config };
    Object.assign(stub.__config, { 'remote.port': 0, 'remote.autoStart': false, 'remote.tailnet': false, 'voice.enabled': false });
    const context = fakeContext(), key = require('../src/routeContinuity').ROUTE_KEY;
    await context.workspaceState.update(key, routeRecord('fixture.tail123.ts.net', 49219));
    let hidden = 0, reads = 0, config = multiRoutes(49219);
    const tailscale = { serveConfig: async () => { reads++; return config; }, forwardedPort: async () => null, hide: async () => { hidden++; return { ok: true }; } };
    const manager = { list: [], get() {}, on() {}, off() {} };
    const server = require('../src/extension').serveLocally(context, manager, { state: () => null }, null, { tailscale });
    try {
      await server.start(0); assert.equal(server.sourceRouteRecord(), null);
      await stub.__registered.commands['nikui.stopReaching'](); assert.equal(hidden, 0);
      assert.equal(context.workspaceState.get(key), undefined);
      config = multiRoutes(server.port);
      await stub.__registered.commands['nikui.recordPhoneRoute']();
      assert.equal(context.workspaceState.get(key).localPort, server.port);
      reads = 0; await server.sourceReleaseReadiness(); await server.sourceReleaseReadiness({ reuse: true }); assert.equal(reads, 1);
      delete config.Web['fixture.tail123.ts.net:443'].Handlers['/'];
      await server.sourceReleaseReadiness(); assert.equal(context.workspaceState.get(key).localPort, server.port);
      assert.equal(server.sourceRouteRecord(), null); assert.equal(hidden, 0);
    } finally { await server.dispose(); for (const k of Object.keys(stub.__config)) delete stub.__config[k]; Object.assign(stub.__config, savedConfig); }
  });
  await caseOf('a real subprocess hung at the app binary path is killed within the status deadline', async () => {
    const dir = fs.mkdtempSync('/tmp/n29-ts-timeout-'), binary = path.join(dir, 'Applications/Tailscale.app/Contents/MacOS/Tailscale');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!' + process.execPath + '\nprocess.on("SIGTERM",()=>{});setInterval(()=>{},10000);', { mode: 0o700 });
    try { const before = Date.now(); await assert.rejects(() => new Tailscale({ binary }).serveConfig({ timeout: STATUS_TIMEOUT_MS }));
      const elapsed = Date.now() - before; assert(elapsed >= STATUS_TIMEOUT_MS && elapsed < 1200, 'hard timeout includes CLI startup cost');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  suite('R29 M7 detach uses the current runs instead of the review snapshot');
  await caseOf('a run started after keeper review is exported and released exactly once', async () => {
    const f = await require('./helpers/production-cutover').productionFixture();
    const { KeeperLink } = require('../src/keeperLink');
    const env = { PATH: '/usr/bin:/bin', HOME: f.home, NIKUI_KEEPER_IDLE_MS: '100', FAKE_LOG: path.join(f.home, 'late-inputs.jsonl') };
    const link = new KeeperLink({ dir: path.join(f.home, 'late-keeper'), env });
    let pid;
    try {
      let calls = 0, late, completingSpawn = false;
      const server = { port: 0, listening: false, stop() {}, sourceRelease() {}, async sourceReleaseReadiness() {
        calls++;
        if (completingSpawn) {
          completingSpawn = false;
          // Complete an already admitted asynchronous spawn at the barrier.
          // No new panel input is admitted after closeAdmission.
          require('../src/session').Session.prototype.start.call(late);
          assert(await wait(() => late.proc?.state === 'kept' && late.proc.pid)); pid = late.proc.pid;
        }
        return [];
      } };
      const slot = await sourceAdapters(f, { keeper: link, server });
      late = slot.engine.manager.create({ id: 'late-chat', cwd: slot.project, autoStart: false });
      late.spawner = (cmd, args, options, s) => link.spawner()(process.execPath, [path.join(__dirname, 'fixtures/keepers/never-exiting-claude.js'), ...args], { ...options, env }, s);
      slot.engine.manager.persist(); slot.engine.flush();
      const coordinator = f.coordinator({ request: async (source, request) => {
        if (request.op === 'source.freeze') completingSpawn = true;
        return require('../src/legacySource').sourceRequest(source, request);
      } }); const review = await coordinator.review(); assert.equal(calls, 1);
      await coordinator.move(review);
      assert(!slot.source.keeperWatchdog, 'new keeper custody requires no window watchdog');
      const owner = require('../src/engineOwner').createOwner({ root: coordinator.saved().ownerRoot, profile: f.profile, install: coordinator.saved().install });
      const importer = require('../src/engineImport').createSelectedImporter({ root: f.selection.root, target: f.selection.label, owner, secretAdapter: f.adapter });
      try { const t = importer.snapshot().records[0].transfer.sources[0].state.keeper;
        assert.equal(t.transferred.length, 1); assert.equal(t.transferred[0].pid, pid); assert.equal(t.transferred[0].released, true);
      } finally { importer.dispose(); }
      assert(alive(pid));
      assert.equal(fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.event === 'start').length, 1);
    } finally { await f.cleanup(); await link.close(); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); if (link.keeperPid && alive(link.keeperPid)) process.kill(link.keeperPid, 'SIGKILL'); }
  });
  suite('R29 native R27 Restore failure: known legacy run plus explicitly transferred idle run');
  await caseOf('legacy/current mixed handback accepts an idle run before first init, unknown runs still block', async () => {
    const { transferredRun } = require('../src/engineHandoff');
    const known = { runId: 'legacy', key: 'known', pid: 1, owned: false, exit: null, meta: { instance: 'known', cwd: '/tmp', conversation: 'conversation' }, released: true, compatible: true };
    const idle = { ...known, runId: 'idle', key: 'idle', meta: { instance: 'idle', cwd: '/tmp', conversation: null } };
    const options = { hello: { metaVersion: 1 }, runs: [known, idle], transferred: [known, idle], requested: known.meta };
    assert.equal(transferredRun(options).runId, 'legacy');
    assert.throws(() => transferredRun({ ...options, transferred: [known] }), { code: 'KEEPER_META_INCOMPLETE' });
  });
  await caseOf('native first-run inspects final products with the sticky development label', async () => {
    const entries = require('../scripts/test-mac-app').firstRunEntries(({ app, flavour }) => ({ app, flavour, label: require('../src/macFlavour').identityForBuild(flavour).label }));
    assert(entries.every((e) => e.app.includes('/final/'))); assert.equal(entries[1].label, 'com.nikui.engine.development');
  });
  await caseOf('an unreplayable old attach retains a visible user-stoppable lease, including replies without pid', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      f.source.send({ t: 'checkpoint', runId: f.original.proc.runId, seq: f.original.proc.seq, snapshot: null });
      f.original.snapshot = () => null;
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const link = f.service(t), s = f.session(link); assert.equal(await link.attach(s), 'elsewhere');
      assert.equal(s.keeperRefusal, 'KEEPER_UNREPLAYABLE'); assert.equal(s.proc?.pid, t.transferred[0].pid);
      assert.equal(s.proc.released, false); assert.equal(s.proc.link.held.size, 0);
      assert.throws(() => s.proc.stdin.write('{"type":"user"}\n'), (e) => e.delivery === 'not_written');
      assert.equal(s.proc.send({ t: 'checkpoint', runId: s.proc.runId, snapshot: {} }), false);
      assert((await s.proc.link.request({ t: 'list' }, 1000)).runs[0].owned);
      s.stop(); assert(await wait(() => !alive(t.transferred[0].pid)));
    } finally { await f.close(); }
  });
  suite('R29 M8 window rollback survives source release and engine failure');
  await caseOf('explicit Restore releases a rescued lease and returns the same never-exiting child end to end', async () => {
    const kept = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    const f = await require('./helpers/production-cutover').productionFixture(); let returned;
    try {
      const slot = await sourceAdapters(f, { keeper: kept.source, keeperSnapshot: kept.snapshot });
      slot.source.keeperFile = path.join(slot.original.globalStorageUri.fsPath, 'rescued.keepers');
      const live = slot.engine.manager.create({ id: kept.original.id, cwd: kept.dir, autoStart: false });
      live.hydrate(kept.original.snapshot()); live.proc = kept.original.proc; kept.original.proc = null;
      live.proc.session = live; live._wire(live.proc); slot.engine.manager.persist(); slot.engine.flush();
      const coordinator = f.coordinator({ offlineDependencies: { keeperSnapshot: kept.snapshot } });
      const file = slot.source.keeperFile;
      await coordinator.move(await coordinator.review());
      const proof = require('../src/daemonPaths').readPrivateJson(path.join(f.selection.root, 'generation-import.json'));
      assert(proof, 'the exact custody proof survives app/engine absence');
      await coordinator.handback();
      const transfer = require('../src/daemonPaths').readPrivateJson(file);
      returned = require('../src/legacyExtensionSource').returnedKeeper({ keeperFile: file, keeperTransfer: transfer },
        { ownDirectory: path.join(kept.dir, 'rescue-return-meta1'), factory: factory(kept) });
      const editor = kept.session(returned); assert.equal(await returned.attach(editor), true);
      assert.equal(editor.proc.pid, [...kept.pids][0]); assert.equal(kept.log().filter((r) => r.type === 'user').length, 1);
      editor.stop(); assert(await wait(() => !alive([...kept.pids][0])));
    } finally { await returned?.close(); await f.cleanup(); await kept.close(); }
  });
  for (const stage of ['app-before-attach', 'engine-crash-before-finish']) await caseOf(stage + ' retains custody without a window observer', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      if (stage === 'engine-crash-before-finish') {
        const service = f.service(t), session = f.session(service); assert.equal(await service.attach(session), true);
        await service.close();
      }
      const status = await require('../src/keeperRescue').rescueRequest(t.transferred[0], 'check');
      assert(status.held.includes(t.transferred[0].runId)); assert(alive(t.transferred[0].pid));
      const next = f.service(t), session = f.session(next); assert.equal(await next.attach(session), true);
      session.stop(); assert(await wait(() => !alive(t.transferred[0].pid)));
    } finally { await f.close(); }
  });
};
module.exports.sourceAdapters = sourceAdapters;
