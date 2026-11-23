'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { EventEmitter } = require('events');
const { keeperFixture, multiRoutes } = require('./production-round27.test');
const { releaseKeeper, BUILDS } = require('../src/keeperContinuity');
const { rescueRequest, serveRescue, socketFor } = require('../src/keeperRescue');
const { KeeperLink, KeptProc } = require('../src/keeperLink');
const { DaemonKeeper } = require('../src/daemonKeeper');
const { LegacyKeeper } = require('../src/legacyKeeper');
const { createProductionKeeper } = require('../src/productionKeeper');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
async function wait(test, ms = 6000) { const end = Date.now() + ms; do { if (await test()) return; await pause(20); } while (Date.now() < end); throw Error('R33_WAIT_TIMEOUT'); }
const memory = () => { const m = new Map(); return { get: (k, d) => m.has(k) ? m.get(k) : d, update: (k, v) => m.set(k, structuredClone(v)) }; };
async function caseOf(name, fn) {
  if (process.env.NIKUI_TEST_PROGRESS === '1') console.error(name);
  try { await fn(); check(name, true); } catch (e) { checkEqual(name, e.stack || e.message, 'PASS'); }
}
module.exports = async () => {
  suite('R33 F1 stopped or refused runs never disrupt shared custody');
  await caseOf('one semantic kill refusal keeps the shared socket and every other run intact', async () => {
    let destroyed = 0, recovered = 0;
    const link = { procs: new Map(), socket: { destroyed: false, destroy() { destroyed++; } }, send: () => false, _recover() { recovered++; } };
    const proc = new KeptProc(link, 'one', {}); proc.state = 'kept'; link.procs.set(proc.runId, proc);
    assert.equal(proc.send({ t: 'kill', runId: proc.runId }), false);
    assert.equal(destroyed, 0); assert.equal(recovered, 0); assert.deepEqual(proc.outbox, []);
    proc.exitCode = 0; let sent = 0; link.send = () => { sent++; return true; }; proc.kill('SIGTERM');
    assert.equal(sent, 0);
  });
  await caseOf('Session Stop checks observed exit before its delayed SIGTERM', async () => {
    const { Session } = require('../src/session'), original = global.setTimeout, timers = [];
    const s = new Session({ id: 'eof', cwd: '/tmp' }); let kills = 0;
    const proc = { exitCode: null, signalCode: null, stdin: { end() { proc.exitCode = 0; } }, kill() { kills++; } };
    s.proc = proc;
    try { global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }; s.stop(); }
    finally { global.setTimeout = original; }
    for (const timer of timers.filter((t) => t.ms === 1500 || t.ms === 5000)) timer.fn();
    assert.equal(kills, 0);
  });
  for (const cli of ['eof-exiting-claude.js', 'never-exiting-claude.js']) for (const phase of ['Move', 'Restore']) {
    await caseOf(phase + ' / ' + cli + ': stopping one of two borrowed chats preserves the other owner', async () => {
      const f = await keeperFixture('d7129af02c46', cli);
      try {
        f.env.FAKE_SESSION_ID = 'second'; const b = f.session(f.source, 'second'); b.send('other');
        await wait(() => b.proc?.pid && b.claudeSessionId); f.pids.add(b.proc.pid);
        let t = await releaseKeeper(f.source, [f.original, b], { snapshot: f.snapshot }); await f.source.close();
        let engine = f.service(t), one = f.session(engine), two = f.session(engine, 'second');
        assert.equal(await engine.attach(one), true); assert.equal(await engine.attach(two), true);
        if (phase === 'Restore') {
          t = await releaseKeeper(engine, [one, two]); await engine.close();
          engine = f.service(t); one = f.session(engine); two = f.session(engine, 'second');
          assert.equal(await engine.attach(one), true); assert.equal(await engine.attach(two), true);
        }
        const link = two.proc.link, socket = link.socket, pid = one.proc.pid, seq = two.proc.seq;
        let recoveries = 0; const recover = link._recover.bind(link); link._recover = () => { recoveries++; return recover(); };
        one.stop(); await wait(() => !alive(pid)); await pause(1700);
        assert.equal(link.socket, socket); assert.equal(recoveries, 0); assert(two.proc.seq > seq);
        assert.equal(two.proc.state, 'kept'); assert(alive(two.proc.pid));
        two.stop(); await wait(() => !alive(two._stoppingProc.pid));
      } finally { await f.close(); }
    });
  }

  suite('R33 F2 idle observers cannot disconnect queued or in-flight attaches');
  await caseOf('pending requests and queued serial work both prevent disconnectIdle', async () => {
    const link = new KeeperLink({ dir: '/tmp/r33-not-connected' }); let ended = 0;
    const socket = { end() { ended++; } }; link.socket = socket;
    link.pending.set(1, {}); link.disconnectIdle(); assert.equal(link.socket, socket);
    link.pending.clear(); link._serialWork = 1; link.disconnectIdle(); assert.equal(link.socket, socket);
    link._serialWork = 0; link.disconnectIdle(); assert.equal(ended, 1);
  });
  await caseOf('a client that dies before its attach reply cannot occupy the driver slot', async () => {
    const dir = fs.mkdtempSync('/tmp/r33-slot-'); let n = 0, entered, resume, server;
    const started = new Promise((r) => { entered = r; }), gate = new Promise((r) => { resume = r; });
    const row = { runId: 'r', key: 'chat', pid: 12345, exit: null }, sends = [];
    const backend = { keeperPid: 12344, held: new Map(), _dispatch() {}, connect: async () => true,
      request: async (m) => {
        if (m.t === 'list') return { runs: [{ ...row, owned: n > 0 }] };
        if (++n === 2) { entered(); await gate; } return { ok: true, ...row, tail: [], checkpointSeq: 0, seq: 0 };
      }, send(m) { sends.push(m.t); return true; }, close() {} };
    const a = new KeeperLink({ dir, existingOnly: true }), b = new KeeperLink({ dir, existingOnly: true });
    a.transportPath = b.transportPath = socketFor(dir);
    try {
      server = await serveRescue(dir, { factory: () => backend });
      const proof = { ...row, directory: dir, meta: { instance: row.key, cwd: dir, conversation: null }, keeperPID: 12344, rescue: { socket: socketFor(dir) } };
      await rescueRequest(proof, 'add', { proofs: [proof] }); assert(await a.connect()); assert.equal(a.capabilities.custody, 1);
      const pending = a.request({ t: 'attach', key: row.key, runId: row.runId }, 2000); await started;
      a.closed = true; a.socket.destroy(); await pause(20); resume(); await pending;
      assert(await b.connect()); assert.equal((await b.request({ t: 'attach', key: row.key, runId: row.runId }, 2000)).ok, true);
      b.send({ t: 'release', runId: row.runId }); await b.request({ t: 'list' }, 2000);
      assert(!sends.includes('release'), 'logical release must retain physical custody');
    } finally { resume(); await a.close(); await b.close(); await server?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await caseOf('own spawner interleaved with a first borrowed attach cannot drop its socket', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const engine = f.service(t); await engine.beginAttach(); const link = engine.links[1];
      let entered, resume; const started = new Promise((r) => { entered = r; }), gate = new Promise((r) => { resume = r; });
      const request = link.request.bind(link); link.request = async (m, ms) => { if (m.t === 'attach') { entered(); await gate; } return request(m, ms); };
      const s = f.session(engine), attaching = engine.attach(s); await started; const socket = link.socket;
      const fresh = f.session(engine, 'fresh'); fresh.send('new chat');
      await wait(() => fresh.proc?.pid); f.pids.add(fresh.proc.pid); f.pids.add(fresh.proc.link.keeperPid);
      const current = link.socket; resume(); assert.equal(current, socket); assert.equal(await attaching, true); engine.endAttach();
      s.stop(); fresh.stop(); await wait(() => !alive(t.transferred[0].pid));
    } finally { await f.close(); }
  });

  suite('R33 F3 a dead custodian is recreated without a yield prerequisite');
  await caseOf('source crash during a long preparation triggers custody without any polling', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js'), registrations = [];
    try {
      const t = await require('../src/keeperContinuity').captureKeeper(f.source, [f.original], { snapshot: f.snapshot });
      await require('../src/keeperRescue').protectReleased(t, { registrations });
      await pause(1200); // Preparation may exceed the old handoff timer.
      assert.equal((await rescueRequest(t.transferred[0], 'status')).held.length, 0);
      f.source.closed = true; f.source.socket.destroy(); for (const socket of registrations) socket.destroy();
      await wait(async () => (await rescueRequest(t.transferred[0], 'status')).held.includes(t.transferred[0].runId), 2500);
      assert(alive(t.transferred[0].pid));
    } finally { for (const socket of registrations) socket.destroy(); await f.close(); }
  });
  for (const build of Object.keys(BUILDS)) await caseOf(build + ': custodian SIGKILL while held recovers the original run', async () => {
    const f = await keeperFixture(build, 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const engine = f.service(t), s = f.session(engine); assert.equal(await engine.attach(s), true);
      const old = await rescueRequest(t.transferred[0], 'status'); process.kill(old.pid, 'SIGKILL');
      await wait(async () => {
        try { return s.proc?.state === 'kept' && s.proc.link.socket && (await rescueRequest(t.transferred[0], 'status')).pid !== old.pid; }
        catch (_) { return false; }
      });
      assert.equal(s.proc.pid, t.transferred[0].pid); s.stop(); await wait(() => !alive(t.transferred[0].pid));
      assert.equal(f.log().filter((r) => r.event === 'start').length, 1);
    } finally { await f.close(); }
  });
  await caseOf('stale custody socket cannot block a regular source window attach', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const t = await releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const status = await rescueRequest(t.transferred[0], 'status'); process.kill(status.pid, 'SIGKILL'); await wait(() => !alive(status.pid));
      const window = require('../src/keeperLink').createWindowKeeper({ dir: f.source.dir, env: f.env }); f.links.push(window);
      const s = f.session(window); assert.equal(await window.attach(s), true); assert.equal(s.proc.pid, t.transferred[0].pid);
      s.stop(); await wait(() => !alive(t.transferred[0].pid));
    } finally { await f.close(); }
  });

  suite('R33 F4 event-driven custody, bounded retries and capped proof cost');
  await caseOf('a retained custodian performs zero repeated inventory while idle', async () => {
    const dir = fs.mkdtempSync('/tmp/r33-idle-'); let requests = 0, owned = false;
    const row = { runId: 'r', key: 'a', pid: 12345, exit: null };
    const link = { keeperPid: 12344, held: new Map(), _dispatch() {}, connect: async () => true,
      request: async (m) => { requests++; if (m.t === 'list') return { runs: [{ ...row, owned }] }; owned = true; return { ok: true, ...row }; },
      send() { return true; }, close() {}, disconnectIdle() {} };
    let server;
    try {
      server = await serveRescue(dir, { delayMs: 15, factory: () => link });
      const proof = { ...row, directory: dir, meta: { instance: 'a', cwd: dir, conversation: null },
        keeperPID: 12344, rescue: { socket: socketFor(dir) } };
      await rescueRequest(proof, 'add', { proofs: [proof] }); const before = requests;
      await pause(90); assert.equal(requests, before);
    } finally { await server?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await caseOf('persistent blocked proofs get three exponential retries then no recurring timer', async () => {
    const dir = fs.mkdtempSync('/tmp/r33-retry-'), meta = { instance: 'chat', cwd: dir, conversation: 'conv' }, attempts = [];
    const api = createProductionKeeper({ root: dir, store: memory(), retryMs: 10, probe: async () => 'live',
      sources: [{ files: { keepers: [path.join(dir, 'old')] }, keeper: { transferred: [{ runId: 'r', meta }] } }],
      factory: (o) => ({ dir: o.dir, socketPath: path.join(o.dir, 'k1.sock'), socket: {},
        manifest: new Map(o.existingOnly ? [['chat', { runId: 'r', meta }]] : []), blockers: new Map(),
        _list: async () => o.existingOnly ? [{ runId: 'r', key: 'chat', meta, owned: true, exit: null }] : [],
        attach: async (s) => { attempts.push(Date.now()); s.keeperRefusal = 'KEEPER_PROCESS_UNPROVEN'; return 'elsewhere'; },
        _block: DaemonKeeper.prototype._block, spawner: () => () => {}, close() {} }) });
    try {
      await api.attach({ id: 'chat', cwd: dir }); await pause(220); assert.equal(attempts.length, 4);
      assert(attempts[2] - attempts[1] >= 15); assert(attempts[3] - attempts[2] >= 30);
      const n = attempts.length; await pause(90); assert.equal(attempts.length, n);
    } finally { await api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await caseOf('11 failed identities cost at most three ps probes per listing', async () => {
    let probes = 0;
    const rows = Array.from({ length: 11 }, (_, i) => ({ runId: 'r' + i, key: 'k' + i, pid: i + 2, owned: false, exit: null }));
    const link = { dir: '/tmp', keeperPid: 1, nextId: 1, pending: new Map(), procs: new Map(), held: new Map(), _ready: async () => {},
      manifest: new Map(rows.map((r) => [r.key, { ...r, meta: { instance: r.key, cwd: '/tmp', conversation: r.key }, legacy: {} }])),
      processSnapshot: async () => { probes++; throw Error('ps denied'); }, send(msg) {
        queueMicrotask(() => KeeperLink.prototype._dispatch.call(this, { t: 'reply', re: msg.id, runs: rows })); return true;
      } };
    const listing = await LegacyKeeper.prototype._list.call(link); assert.equal(listing.length, 11);
    assert(listing.every((r) => r.blocker === 'KEEPER_PROCESS_UNPROVEN')); assert(probes <= 3);
  });
  await caseOf('new keepers retain custody without any detached helper', async () => {
    const f = await keeperFixture('d7129af02c46');
    try {
      const source = new KeeperLink({ dir: path.join(f.dir, 'current'), env: f.env }); f.links.push(source);
      const s = f.session(source, 'current'); s.send('current'); await wait(() => s.proc?.pid && s.claudeSessionId);
      f.pids.add(s.proc.pid); f.pids.add(source.keeperPid);
      const t = await releaseKeeper(source, [s]); await source.close(); assert(t.transferred[0].keeperCustody);
      assert(!fs.existsSync(socketFor(source.dir))); assert(!t.transferred[0].rescue);
    } finally { await f.close(); }
  });

  suite('R33 F5 serialized boot cannot expire custody while later attaches queue');
  await caseOf('three slow serialized attaches exceed the former 5s handoff and all keep the original children', async () => {
    const f = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    try {
      const sessions = [f.original];
      for (let i = 1; i < 3; i++) {
        f.env.FAKE_SESSION_ID = 'conv-' + i; const s = f.session(f.source, 'slow-' + i); s.send('turn');
        await wait(() => s.proc?.pid && s.claudeSessionId); f.pids.add(s.proc.pid); sessions.push(s);
      }
      const t = await releaseKeeper(f.source, sessions, { snapshot: f.snapshot }); await f.source.close();
      const engine = f.service(t); await engine.beginAttach(); const link = engine.links[1], request = link.request.bind(link);
      link.request = async (m, ms) => { if (m.t === 'attach') await pause(1850); return request(m, ms); };
      const resumed = sessions.map((s) => f.session(engine, s.id)); const result = await Promise.all(resumed.map((s) => engine.attach(s)));
      engine.endAttach(); assert.deepEqual(result, [true, true, true]);
      assert.deepEqual(resumed.map((s) => s.proc.pid), t.transferred.map((r) => r.pid));
      for (const s of resumed) s.stop(); await wait(() => t.transferred.every((r) => !alive(r.pid)));
    } finally { await f.close(); }
  });

  suite('R33 F6 raw foreign rows reserve only their own key');
  await caseOf('an unidentified legacy run does not block unrelated known resumes', async () => {
    const meta = { instance: 'mine', cwd: '/tmp', conversation: 'my-conversation' };
    const unknown = { runId: 'foreign-run', key: 'foreign-chat', owned: true, exit: null, borrowed: true };
    assert.doesNotThrow(() => DaemonKeeper.prototype._check(meta, [unknown]));
    assert.throws(() => DaemonKeeper.prototype._check({ ...meta, instance: unknown.key }, [unknown]), { code: 'KEEPER_INSTANCE_LIVE' });
    assert.throws(() => DaemonKeeper.prototype._check(meta, [{ ...unknown, meta: { ...meta, instance: unknown.key } }]), { code: 'KEEPER_CONVERSATION_LIVE' });
  });

  suite('R33 F7/N7 Stop remains pending and restart waits are finite');
  await caseOf('a meta1 Stop cannot become a confirmed exit when transport recovery expires', async () => {
    let finished = 0, retried = 0;
    const link = { procs: new Map(), blockers: new Map(), _block: DaemonKeeper.prototype._block, onBlocked() { retried++; } };
    const proc = { runId: 'retained-current', session: { id: 'current' }, stopRequested: true, state: 'kept', released: false,
      outbox: [{ t: 'stop', runId: 'retained-current' }], finish() { finished++; } };
    await DaemonKeeper.prototype._lose.call(link, proc, 'unheard');
    assert.equal(finished, 0); assert.equal(proc.released, false); assert.equal(proc.state, 'pending');
    assert.equal(link.procs.get(proc.runId), proc); assert.equal(proc.outbox.length, 1); assert.equal(retried, 1);
  });
  await caseOf('a user retry after the automatic retry budget starts pending Stop recovery', async () => {
    const { Session } = require('../src/session'), s = new Session({ id: 'retry-stop', cwd: '/tmp' }); let recoveries = 0;
    const proc = Object.assign(new EventEmitter(), { kept: true, exitCode: null, signalCode: null, state: 'pending', stopRequested: true,
      link: { _recover() { recoveries++; return Promise.resolve(); } } });
    s._stoppingProc = proc; const original = global.setTimeout;
    try { global.setTimeout = (fn, ms, ...args) => original(fn, ms === 10000 ? 1 : ms, ...args); s.start(); }
    finally { global.setTimeout = original; }
    await pause(25); assert.equal(recoveries, 1); assert.equal(proc.listenerCount('exit'), 0); s.disposed = true;
  });
  await caseOf('unconfirmed Stop removes the wait listener after 10s and preserves the live reservation', async () => {
    const { Session } = require('../src/session'), s = new Session({ id: 'pending', cwd: '/tmp' });
    const proc = Object.assign(new EventEmitter(), { kept: true, exitCode: null, signalCode: null });
    s._stoppingProc = proc; let starts = 0; s.spawner = () => { starts++; };
    const original = global.setTimeout;
    try { global.setTimeout = (fn, ms, ...args) => original(fn, ms === 10000 ? 1 : ms, ...args); s.start(); }
    finally { global.setTimeout = original; }
    await pause(25); assert.equal(proc.listenerCount('exit'), 0); assert.equal(s._stoppedWait, false);
    assert.equal(s._stoppingProc, proc); assert.equal(starts, 0); assert(s.items.some((i) => /Stop has not been confirmed/.test(i.text)));
  });
  await caseOf('a stopping session is retried and the pending stop reaches its replacement lease', async () => {
    const dir = fs.mkdtempSync('/tmp/r33-stop-'), meta = { instance: 'stopping', cwd: dir, conversation: 'conv' };
    let blocked = true, stopped = false; const old = Object.assign(new EventEmitter(), { finish() { stopped = true; } });
    const session = { id: meta.instance, cwd: dir, _stoppingProc: old };
    const api = createProductionKeeper({ root: dir, store: memory(), retryMs: 10, probe: async () => 'live',
      sources: [{ files: { keepers: [path.join(dir, 'old')] }, keeper: { transferred: [{ runId: 'r', meta }] } }],
      factory: (o) => ({ dir: o.dir, socketPath: path.join(o.dir, 'k1.sock'), socket: {},
        manifest: new Map(o.existingOnly ? [[meta.instance, { runId: 'r', meta }]] : []),
        _list: async () => [{ runId: 'r', key: meta.instance, meta, owned: true, exit: null }],
        attach: async (s) => {
          if (blocked) { s.keeperRefusal = 'KEEPER_UNAVAILABLE'; return 'elsewhere'; }
          const proc = new EventEmitter(); proc.stdin = { end() { proc.emit('exit', 0, null); } }; s.proc = proc; return true;
        }, spawner: () => () => {}, close() {} }) });
    try { await api.attach(session); blocked = false; await wait(() => stopped, 1000); }
    finally { await api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  suite('R33 native failures are reproducible without native side effects');
  await caseOf('engine restart after every source quits attaches custody without a source handshake', async () => {
    const kept = await keeperFixture('d7129af02c46', 'never-exiting-claude.js');
    const f = await require('./helpers/production-cutover').productionFixture(); let runtime;
    try {
      const slot = await require('./production-round29.test').sourceAdapters(f, { keeper: kept.source, keeperSnapshot: kept.snapshot });
      const live = slot.engine.manager.create({ id: kept.original.id, cwd: kept.dir, autoStart: false });
      live.hydrate(kept.original.snapshot()); live.proc = kept.original.proc; kept.original.proc = null;
      live.proc.session = live; live._wire(live.proc); slot.engine.manager.persist(); slot.engine.flush();
      const factory = (o) => o.legacy ? new LegacyKeeper({ ...o, processSnapshot: kept.snapshot }) : new DaemonKeeper(o);
      const coordinator = f.coordinator(); await coordinator.move(await coordinator.review());
      runtime = await f.start({ keeperFactory: factory }); await coordinator.finish();
      await runtime.stop(); runtime = null; for (const source of f.slots) await source.source.dispose();
      const begin = Date.now(); runtime = await f.start({ keeperFactory: factory });
      assert(Date.now() - begin < 5000); assert.equal(runtime.engine.manager.get(live.id).proc.pid, [...kept.pids][0]);
    } finally { await runtime?.stop(); await f.cleanup(); await kept.close(); }
  });
  await caseOf('native process selection includes only exact minted roots and their descendants', async () => {
    const { ownedProcesses } = require('../scripts/native-command');
    const line = (pid, parent, argv) => ` ${pid} ${parent} Sun Nov 22 15:00:00 2026 ${argv}`;
    const rows = [line(41, 1, '/node /private/tmp/nik-mac/build/p3/r33-test/node script'),
      line(42, 41, '/fixture-claude'), line(43, 1, '/node /private/tmp/nik-mac/build/p3/r33-test-other/node'),
      line(44, 1, '/Applications/NikUI.app/Contents/MacOS/NikUI')].join('\n');
    assert.deepEqual(ownedProcesses(['/private/tmp/nik-mac/build/p3/r33-test'], () => rows).map((p) => p.pid), [41, 42]);
  });
  await caseOf('a temporary listener gap cannot move the fake tailnet root to a second window', async () => {
    const { install, fakeContext } = require('./helpers/vscode-stub'), vscode = install(), saved = { ...vscode.__config };
    Object.assign(vscode.__config, { 'remote.autoStart': false, 'remote.port': 0, 'remote.tailnet': true, 'voice.enabled': false });
    let exposes = 0; const config = multiRoutes(12345), before = JSON.stringify(config);
    const tailscale = { forwardedPort: async () => 12345, serveConfig: async () => config,
      status: async () => ({ installed: true, running: true, https: true, name: 'fixture.ts.net' }), expose: async () => { exposes++; return { ok: true }; } };
    const server = require('../src/extension').serveLocally(fakeContext(), { list: [], get() {}, on() {}, off() {} }, { state: () => null }, null, { tailscale });
    try { await vscode.__registered.commands['nikui.remoteStart'](); await pause(100); assert.equal(exposes, 0); assert.equal(JSON.stringify(config), before); }
    finally { await server.dispose(); Object.keys(vscode.__config).forEach((k) => delete vscode.__config[k]); Object.assign(vscode.__config, saved); }
  });
  await caseOf('quit controller rejection still runs the exact-PID cleanup fallback', async () => {
    const { quitOpenedApp } = require('../scripts/test-mac-app'); let clock = 0, present = true;
    const executable = '/tmp/NikUI.app/Contents/MacOS/NikUI', proof = { pid: 42, started: 'birth', command: executable }, sent = [];
    const result = await quitOpenedApp({ executable, launched: [proof], now: () => clock, graceMs: 20, killMs: 20,
      sleep: async () => { clock += 10; }, cli(op) { if (op === 'quit-app') throw Object.assign(Error('refused'), { code: 'CONTROLLER_ARGUMENT_INVALID' }); return { pids: present ? [42] : [] }; },
      snapshot: async () => new Map(present ? [[42, proof]] : []), kill(pid, signal) { sent.push([pid, signal]); present = false; } });
    assert(result.absent); assert.deepEqual(sent, [[42, 'SIGTERM']]); assert.equal(result.quitFailure.code, 'CONTROLLER_ARGUMENT_INVALID');
  });
};
