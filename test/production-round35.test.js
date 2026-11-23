'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { keeperFixture, multiRoutes } = require('./production-round27.test');
const { releaseKeeper, BUILDS } = require('../src/keeperContinuity');
const rescue = require('../src/keeperRescue');
const { KeeperLink, createWindowKeeper } = require('../src/keeperLink');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
async function wait(test, ms = 6000) {
  const end = Date.now() + ms;
  do { if (await test()) return; await pause(20); } while (Date.now() < end);
  throw Error('R35_WAIT_TIMEOUT');
}
async function caseOf(name, fn) {
  if (process.env.NIKUI_TEST_PROGRESS === '1') console.error(name);
  try { await fn(); check(name, true); } catch (error) { checkEqual(name, error.stack || error.message, 'PASS'); }
}
module.exports = async () => {
  suite('R35 N-A failed eleven-run Move restores every driver');
  for (const boundary of ['list', 'check']) await caseOf(boundary + ' timeout after detach: abort, preconnected raw window, reload and Stop', async () => {
    const kept = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    const f = await require('./helpers/production-cutover').productionFixture();
    const request = kept.source.request.bind(kept.source), rescueRequest = rescue.rescueRequest;
    try {
      const slot = await require('./production-round29.test').sourceAdapters(f, { keeper: kept.source, keeperSnapshot: kept.snapshot });
      const originals = [kept.original], live = [];
      for (let i = 1; i < 11; i++) {
        kept.env.FAKE_SESSION_ID = 'r35-conversation-' + i;
        const s = kept.session(kept.source, 'r35-chat-' + i); s.send('one original turn');
        await wait(() => s.proc?.pid && s.claudeSessionId); kept.pids.add(s.proc.pid); originals.push(s);
      }
      const originalPids = originals.map((s) => s.proc.pid);
      for (const s of originals) {
        const target = slot.engine.manager.create({ id: s.id, cwd: s.cwd, autoStart: false });
        target.hydrate(s.snapshot()); target.proc = s.proc; s.proc = null;
        target.proc.session = target; target._wire(target.proc); live.push(target);
      }
      slot.engine.manager.persist(); slot.engine.flush();
      const window = createWindowKeeper({ dir: kept.source.dir, env: kept.env }); kept.links.push(window);
      await window.connect(); assert(window.links[0].socket, 'activation has already connected to the raw keeper');
      let injected = 0;
      kept.source.request = async (msg, ms) => {
        if (boundary === 'list' && msg.t === 'list' && live.some((s) => s.disposed)) {
          injected++; await pause(25); return { ok: false, message: 'no answer' };
        }
        return request(msg, ms);
      };
      rescue.rescueRequest = async (proof, op, extra) => {
        if (boundary === 'check' && op === 'check') { injected++; await pause(25); throw Object.assign(Error('deadline'), { code: 'CONTROL_TIMEOUT' }); }
        return rescueRequest(proof, op, extra);
      };
      const coordinator = f.coordinator(), review = await coordinator.review(); assert(review.ready);
      await assert.rejects(() => coordinator.move(review));
      assert(injected > 0); assert(slot.restored, 'the source abort must rebuild after a partially failed detach');
      kept.source.request = request; rescue.rescueRequest = rescueRequest;
      const resumed = live.map((s) => kept.session(window, s.id));
      for (const s of resumed) assert.equal(await window.attach(s), true);
      assert.deepEqual(resumed.map((s) => s.proc.pid), originalPids);
      const pids = resumed.map((s) => s.proc.pid);
      assert(pids.every(alive)); assert.equal(new Set(pids).size, 11);
      for (const s of resumed) s.detach(); await window.close();
      const reload = createWindowKeeper({ dir: kept.source.dir, env: kept.env }); kept.links.push(reload); await reload.connect();
      const again = live.map((s) => kept.session(reload, s.id));
      for (let i = 0; i < again.length; i++) { assert.equal(await reload.attach(again[i]), true); assert.equal(again[i].proc.pid, pids[i]); }
      for (const s of again) s.stop(); await wait(() => pids.every((pid) => !alive(pid)));
      assert.equal(kept.log().filter((r) => r.event === 'start').length, 11);
      assert.equal(kept.log().filter((r) => r.type === 'user').length, 11);
    } finally { kept.source.request = request; rescue.rescueRequest = rescueRequest; await f.cleanup(); await kept.close(); }
  });

  suite('R35 N-B custodian liveness belongs to an independent exit observer');
  for (const build of Object.keys(BUILDS)) await caseOf(build + ': SIGKILL with no clients survives beyond the shortened orphan grace', async () => {
    const f = await keeperFixture(build, 'never-exiting-claude.js', { graceMs: 1000 });
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const proof = t.transferred[0], old = await rescue.rescueRequest(proof, 'status');
      assert.deepEqual(old.held, [proof.runId]); process.kill(old.pid, 'SIGKILL');
      // There is no driver/engine/window connection to trigger recreation.
      await pause(1400); assert(alive(proof.pid));
      const status = await rescue.rescueRequest(proof, 'status'); assert.notEqual(status.pid, old.pid); assert(status.held.includes(proof.runId));
      const engine = f.service(t), session = f.session(engine); assert.equal(await engine.attach(session), true);
      assert.equal(session.proc.pid, proof.pid); session.stop(); await wait(() => !alive(proof.pid));
      assert.equal(f.log().filter((r) => r.event === 'start').length, 1);
    } finally { await f.close(); }
  });
  await caseOf('the launchd job restarts crashes, stops after drain, and refuses a foreign registration', async () => {
    const { supervise, jobFor, jobPlist } = require('../src/keeperSupervisor');
    const directory = fs.realpathSync(fs.mkdtempSync('/tmp/r35-job-')), calls = [];
    let loaded = false;
    try {
      const interpreter = '/private/tmp/nik-mac/build/p3/final/NikUI Dev.app/Contents/Resources/engine/node';
      const program = require('../src/keeperSupervisor').stage(directory, { interpreter });
      const job = jobFor(directory), plist = jobPlist(directory, program);
      assert(plist.includes('<key>SuccessfulExit</key><false/>')); assert(plist.includes('<key>ThrottleInterval</key><integer>10</integer>'));
      await supervise(directory, { interpreter, ready: async () => {}, run: async (args) => {
        calls.push(args);
        if (args[0] === 'print') {
          if (!loaded) throw Object.assign(Error('absent'), { code: 113, stderr: 'Could not find service "' + job.label + '"' });
          return 'job {\n path = ' + job.file + '\n}';
        }
        if (args[0] === 'bootstrap') loaded = true;
        return '';
      } });
      assert.equal(calls.filter((a) => a[0] === 'bootstrap').length, 1);
      assert(calls.some((a) => a[0] === 'kickstart' && !a.includes('-k')));
      const prior = calls.length; await pause(50); assert.equal(calls.length, prior);
      await assert.rejects(() => supervise(directory, { interpreter, run: async () => 'job {\n path = /foreign/file.plist\n}' }), { code: 'KEEPER_RESCUE_SUPERVISION_UNPROVEN' });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('native cleanup removes only the deterministic job inside its minted scope', async () => {
    const { cleanupCustodyJobs } = require('../scripts/native-command'), root = '/private/tmp/nik-mac/build/p3';
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(root + '/r35-cleanup-'), { label, file } = require('../src/keeperSupervisor').jobFor(directory);
    fs.writeFileSync(file, 'fixture', { mode: 0o600 }); let loaded = true; const calls = [];
    try {
      const jobs = await cleanupCustodyJobs([directory], [root], (_file, args) => {
        calls.push(args);
        if (args[0] === 'bootout') { loaded = false; return ''; }
        if (loaded) return 'job {\n path = ' + file + '\n}';
        throw Object.assign(Error('absent'), { status: 113, stderr: 'Could not find service "' + label + '"' });
      });
      assert(jobs[0].absent && jobs[0].wasRegistered); assert.equal(calls.filter((a) => a[0] === 'bootout').length, 1);
      await assert.rejects(() => cleanupCustodyJobs([directory], [directory + '-foreign']), /NATIVE_CUSTODY_SCOPE_INVALID/);
      await assert.rejects(() => cleanupCustodyJobs([directory], [root], () => 'job {\n path = /foreign.plist\n}'), /NATIVE_CUSTODY_JOB_UNPROVEN/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  suite('R35 N-C retry budgets belong to incidents');
  await caseOf('recovery and a fresh socket failure each restore a bounded exponential budget', async () => {
    const directory = fs.mkdtempSync('/tmp/r35-retry-'), meta = { instance: 'chat', cwd: directory, conversation: 'conv' };
    let fail = true, attempts = 0;
    const api = require('../src/productionKeeper').createProductionKeeper({ root: directory, retryMs: 8,
      store: { get: (_k, d) => d, update() {} }, probe: async () => 'live',
      sources: [{ files: { keepers: [directory + '/old'] }, keeper: { transferred: [{ runId: 'r', meta }] } }],
      factory: (o) => ({ dir: o.dir, socketPath: o.dir + '/k1.sock', socket: {}, manifest: new Map(o.existingOnly ? [['chat', { runId: 'r', meta }]] : []),
        _list: async () => o.existingOnly ? [{ runId: 'r', key: 'chat', meta, exit: null }] : [],
        attach: async (s) => { attempts++; if (!fail) return true; s.keeperRefusal = 'KEEPER_UNAVAILABLE'; return 'elsewhere'; },
        spawner: () => () => {}, close() {} }) });
    const session = { id: 'chat', cwd: directory };
    try {
      await api.attach(session); await pause(140); assert.equal(attempts, 4);
      fail = false; await api.retryBlocked(); assert.equal(attempts, 5);
      fail = true; await api.attach(session); await pause(140); assert.equal(attempts, 9);
      api.links[1].onBlocked(session); await pause(140); assert.equal(attempts, 12);
      await pause(90); assert.equal(attempts, 12);
    } finally { await api.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  suite('R35 N-D late takeover reconciles actual keeper ownership');
  await caseOf('a late four-MiB adoption stays reserved and becomes drivable after fresh upstream inventory', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js'); let server;
    try {
      const backend = new KeeperLink({ dir: f.source.dir, existingOnly: true, attachOnly: true });
      const request = backend.request.bind(backend); let delayed = false, reconciled = false;
      backend.request = async (msg, ms) => {
        const reply = await request(msg, ms);
        if (msg.t === 'attach' && !delayed) { delayed = true; await pause(140); }
        else if (msg.t === 'list' && delayed && reply.runs?.[0]?.owned) reconciled = true;
        return reply;
      };
      const snapshot = f.original.snapshot.bind(f.original);
      f.original.snapshot = () => ({ ...snapshot(), largeFixture: 'x'.repeat(4 * 1024 * 1024) });
      server = await rescue.serveRescue(f.source.dir, { factory: () => backend, deadline: () => 30 });
      await assert.rejects(() => releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }), { code: 'KEEPER_CUSTODY_PENDING' });
      const proof = { directory: f.source.dir, runId: [...f.source.procs.keys()][0], rescue: { socket: rescue.socketFor(f.source.dir) } };
      await wait(async () => (await rescue.rescueRequest(proof, 'status')).held.length === 1);
      assert(reconciled); assert(rescue.custodyTimeout({ checkpointBytes: 4 * 1024 * 1024 }) > rescue.custodyTimeout({}));
      const window = createWindowKeeper({ dir: f.source.dir, env: f.env }); f.links.push(window);
      const session = f.session(window); assert.equal(await window.attach(session), true);
      assert.equal(session.proc.pid, [...f.pids][0]); session.stop(); await wait(() => !alive([...f.pids][0]));
    } finally { await server?.close(); await f.close(); }
  });
  await caseOf('a fragmented four-MiB checkpoint scans only new input bytes', async () => {
    const link = new KeeperLink({ dir: '/tmp/r35-parser-unused' }), frame = JSON.stringify({ t: 'reply', re: 1, checkpoint: 'x'.repeat(4 * 1024 * 1024) }) + '\n';
    const indexOf = String.prototype.indexOf; let scanned = 0, parsed;
    link._dispatch = (msg) => { parsed = msg; };
    try {
      String.prototype.indexOf = function (needle, start = 0) { if (needle === '\n') scanned += this.length - start; return indexOf.call(this, needle, start); };
      for (let at = 0; at < frame.length; at += 4096) link._data(frame.slice(at, at + 4096));
    } finally { String.prototype.indexOf = indexOf; }
    assert.equal(parsed.checkpoint.length, 4 * 1024 * 1024); assert(scanned <= frame.length * 2, 'do not repeatedly scan the accumulated checkpoint');
  });
  await caseOf('a live upstream row missing from custody is refused as such, never reported gone', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js'); let server;
    try {
      server = await rescue.serveRescue(f.source.dir);
      const link = new KeeperLink({ dir: f.source.dir, existingOnly: true }); link.transportPath = rescue.socketFor(f.source.dir); f.links.push(link);
      assert(await link.connect());
      assert.equal((await link.request({ t: 'attach', key: f.original.id, runId: f.original.proc.runId }, 1000)).message, 'KEEPER_NOT_IN_CUSTODY');
    } finally { await server?.close(); await f.close(); }
  });

  suite('R35 LOW custodian retires with its original keeper');
  await caseOf('keeper SIGKILL retires custody even while its quiet child is still alive', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      f.original.interrupt(); await wait(() => !f.original.inTurn);
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const proof = t.transferred[0], status = await rescue.rescueRequest(proof, 'status'); process.kill(f.source.keeperPid, 'SIGKILL');
      await wait(() => !alive(status.pid)); assert(alive(proof.pid));
      assert.deepEqual(JSON.parse(fs.readFileSync(rescue.stateFor(proof.directory))).proofs, []);
    } finally { await f.close(); }
  });

  suite('R35 route creation requires exact window and port intent');
  for (const intent of ['none', 'other-window', 'other-port', 'exact']) await caseOf('startup and sixty-second loop with ' + intent + ' intent', async () => {
    const { install, fakeContext } = require('./helpers/vscode-stub'), vscode = install(), context = fakeContext();
    Object.assign(vscode.__config, { 'remote.autoStart': false, 'remote.port': 0, 'remote.tailnet': true, 'voice.enabled': false });
    vscode.env.sessionId = 'this-window'; let exposes = 0, config = {}, held = null;
    const tailscale = { forwardedPort: async () => held, serveConfig: async () => config,
      status: async () => ({ installed: true, running: true, https: true, name: 'fixture.tail123.ts.net' }),
      expose: async (port) => { exposes++; held = port; config = multiRoutes(port); return { ok: true, host: 'fixture.tail123.ts.net' }; } };
    tailscale.hide = async () => { held = null; config = {}; return { ok: true }; };
    const intervals = [], original = global.setInterval;
    let server;
    try {
      global.setInterval = (fn, ms, ...args) => { if (ms === 60000) { intervals.push(fn); return { unref() {} }; } return original(fn, ms, ...args); };
      server = require('../src/extension').serveLocally(context, { list: [], get() {}, on() {}, off() {} }, { state: () => null }, null, { tailscale });
      await vscode.__registered.commands['nikui.remoteStart'](); await pause(40); assert.equal(exposes, 0);
      if (intent !== 'none') context.workspaceState.update('nikui.remote.tailnetIntent.v1', { version: 1, window: intent === 'other-window' ? 'another-window' : 'this-window', port: intent === 'other-port' ? server.port + 1 : server.port });
      for (const fn of intervals) fn(); await pause(40); assert.equal(exposes, intent === 'exact' ? 1 : 0);
      if (intent === 'exact') {
        await vscode.__registered.commands['nikui.stopReaching']();
        assert.equal(context.workspaceState.get('nikui.remote.tailnetIntent.v1'), undefined);
        const now = Date.now;
        try { Date.now = () => now() + 61000; for (const fn of intervals) fn(); await pause(40); }
        finally { Date.now = now; }
        assert.equal(exposes, 1);
      }
    } finally { global.setInterval = original; await server?.dispose(); for (const s of context.subscriptions) s?.dispose?.(); }
  });
  await caseOf('explicit Reach and Record persist this window and port; an old ownership record alone grants no intent', async () => {
    const { install, fakeContext } = require('./helpers/vscode-stub'), vscode = install(), context = fakeContext();
    Object.assign(vscode.__config, { 'remote.autoStart': false, 'remote.port': 0, 'remote.tailnet': true, 'voice.enabled': false });
    vscode.env.sessionId = 'explicit-window'; let config = {}, exposes = 0;
    context.workspaceState.update('nikui.remote.route.v1', require('../src/routeContinuity').routeRecord('fixture.tail123.ts.net', 12345));
    const tailscale = { forwardedPort: async () => null, serveConfig: async () => config,
      status: async () => ({ installed: true, running: true, https: true, name: 'fixture.tail123.ts.net' }),
      expose: async (port) => { exposes++; config = multiRoutes(port); return { ok: true, host: 'fixture.tail123.ts.net' }; } };
    const server = require('../src/extension').serveLocally(context, { list: [], get() {}, on() {}, off() {} }, { state: () => null }, null, { tailscale });
    try {
      await vscode.__registered.commands['nikui.remoteStart'](); await pause(30); assert.equal(exposes, 0);
      await vscode.__registered.commands['nikui.reachFromPhone'](); assert.equal(exposes, 1);
      const intent = { version: 1, window: 'explicit-window', port: server.port };
      assert.deepEqual(context.workspaceState.get('nikui.remote.tailnetIntent.v1'), intent);
      context.workspaceState.update('nikui.remote.tailnetIntent.v1', undefined);
      await server.recordPhoneRoute(); assert.deepEqual(context.workspaceState.get('nikui.remote.tailnetIntent.v1'), intent);
    } finally { await server.dispose(); for (const s of context.subscriptions) s?.dispose?.(); }
  });
};
