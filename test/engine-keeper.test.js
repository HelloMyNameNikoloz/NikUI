'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { KeeperLink } = require('../src/keeperLink');
const { DaemonKeeper, MANIFEST } = require('../src/daemonKeeper');
const { Session } = require('../src/session');
const { createTestStore } = require('../src/daemonStore');
const { privateRoot } = require('../src/daemonPaths');

const FAKE = path.join(__dirname, 'helpers/fake-claude.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test, ms = 5000) { const until = Date.now() + ms; while (Date.now() < until) { if (await test()) return true; await sleep(10); } return !!(await test()); }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const text = (session) => session.items.filter((item) => item.kind === 'assistant' || item.kind === 'text').map((item) => item.text).join('|');

function fixture({ old = false, grace = 1200 } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/nk11-')), keeperDir = dir + '/k', links = [], sessions = [], pids = new Set(), stores = [];
  const env = { HOME: dir, TMPDIR: dir, PATH: '/usr/bin:/bin', NIKUI_KEEPER_GRACE_MS: String(grace), NIKUI_KEEPER_IDLE_MS: '200' };
  let source = path.resolve(__dirname, '../src/keeper.js');
  if (old) {
    source = dir + '/old-keeper.js';
    const code = fs.readFileSync(path.resolve(__dirname, '../src/keeper.js'), 'utf8')
      .replaceAll(', metaVersion: 1', '').replace(', meta: this.meta', '');
    fs.writeFileSync(source, code, { mode: 0o600 });
  }
  const store = (name = 'manifest') => { const value = createTestStore(dir + '/' + name + '.json', { testOnly: true }); stores.push(value); return value; };
  function window() { const link = new KeeperLink({ dir: keeperDir, nodePath: process.execPath, source, env }); links.push(link); return link; }
  function daemon(saved = store()) { const link = new DaemonKeeper({ dir: keeperDir, nodePath: process.execPath, source, env, store: saved }); links.push(link); return link; }
  function session(link, id, conversation = null, namedConversation = 'fresh-' + id) {
    const spawn = link.spawner();
    const s = new Session({ id, cwd: dir, claudePath: process.execPath, claudeSessionId: conversation, maxItems: 0,
      spawner: (_cmd, args, opts, owner) => spawn(process.execPath, [FAKE, ...args], { ...opts, env: {
        ...env, FAKE_LOG: dir + '/fake.log', FAKE_SESSION_ID: namedConversation, FAKE_WORDS: '30', FAKE_MS: '10'
      } }, owner) });
    sessions.push(s); return s;
  }
  const list = async (link) => (await link.request({ t: 'list' }, 1000)).runs;
  const log = () => fs.existsSync(dir + '/fake.log') ? fs.readFileSync(dir + '/fake.log', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  async function raw(link, id, meta, snapshot = null, guarded = false) {
    await link.connect();
    const reply = await link.request({ t: 'spawn', runId: crypto.randomUUID(), key: id, meta, ...(guarded ? { guard: meta } : {}),
      cmd: process.execPath, args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], cwd: dir, env, snapshot }, 1000);
    if (reply.pid) pids.add(reply.pid);
    return { ...reply, run: (await list(link)).find((run) => run.key === id) };
  }
  return { dir, keeperDir, env, source, store, window, daemon, session, list, log, raw, async dispose() {
    for (const s of sessions) if (!s.disposed) { if (s.proc && s.proc.pid) pids.add(s.proc.pid); s.dispose(); }
    for (const link of links) await link.close();
    await waitFor(() => [...pids].every((pid) => !alive(pid)), grace + 3000);
    for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    await waitFor(() => !fs.existsSync(keeperDir + '/k1.sock'), 3000);
    // These pids were obtained only from this freshly created fixture keeper.
    for (const link of links) if (link.keeperPid && alive(link.keeperPid)) { try { process.kill(link.keeperPid, 'SIGKILL'); } catch (_) {} }
    for (const saved of stores) saved.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

module.exports = async function () {
  suite('T32/D19/O11: protocol-1 spawn, init-learned ID and every checkpoint expose metadata');
  const meta = fixture();
  try {
    const link = meta.window(), s = meta.session(link, 'window-a'); s.start();
    check('fixture starts a fresh window run', await waitFor(() => s.proc && s.proc.pid));
    checkEqual('fresh spawn publishes explicit null conversation without parsing the snapshot', (await meta.list(link))[0].meta,
      { conversation: null, instance: 'window-a', cwd: meta.dir });
    s.send('ASK hold before first result');
    check('conversation ID learned at init reaches describe before any result', await waitFor(async () => (await meta.list(link))[0].meta.conversation === 'fresh-window-a'));
    checkEqual('init metadata does not require a completed turn', s.turns, 0);
    s.claudeSessionId = 'checkpoint-updated'; s.proc.checkpoint();
    checkEqual('every checkpoint refreshes metadata independently of the opaque snapshot', (await meta.list(link))[0].meta.conversation, 'checkpoint-updated');
    const hello = await link.request({ t: 'hello' }, 1000);
    checkEqual('additive metadata keeps keeper protocol 1', [hello.proto, hello.metaVersion], [1, 1]);
    link.send({ t: 'checkpoint', runId: s.proc.runId, seq: s.proc.seq, snapshot: s.snapshot() });
    checkEqual('metadata-less checkpoint conservatively removes earlier metadata', (await meta.list(link))[0].meta, undefined);
    const blocked = meta.daemon(), retry = meta.session(blocked, 'cannot-resume', 'checkpoint-updated'); retry.start();
    check('metadata-less live run blocks guarded resume', await waitFor(() => retry.keeperRefusal === 'KEEPER_META_INCOMPLETE'));
    s.proc.checkpoint();
    s.detach(); await link.close();
    const observer = meta.window(); await observer.connect();
    checkEqual('release retains checkpoint metadata for the next owner', (await meta.list(observer))[0].meta,
      { conversation: 'checkpoint-updated', instance: 'window-a', cwd: meta.dir });
  } finally { await meta.dispose(); }

  suite('T32/T54: another owner and incomplete live metadata block resume by name');
  for (const kind of ['another-owner', 'missing', 'partial', 'unidentified', 'wrong-instance']) {
    const f = fixture();
    try {
      const owner = f.window();
      const mapping = kind === 'another-owner' ? { conversation: 'conversation-live', instance: 'legacy', cwd: f.dir }
        : kind === 'partial' ? { instance: 'legacy', cwd: f.dir } : kind === 'unidentified' ? { conversation: null, instance: 'legacy', cwd: f.dir }
          : kind === 'wrong-instance' ? { conversation: 'different-conversation', instance: 'wrong', cwd: f.dir } : undefined;
      const live = await f.raw(owner, 'legacy', mapping);
      const service = f.daemon(), s = f.session(service, 'alternate-id', 'conversation-live');
      s.send('must not reach a second process');
      check(kind + ' produces a named refusal', await waitFor(() => !!s.keeperRefusal));
      checkEqual(kind + ' never spawns or falls back to a direct child', [f.log().length, s.keeperRefusal],
        [0, kind === 'another-owner' ? 'KEEPER_CONVERSATION_LIVE' : 'KEEPER_META_INCOMPLETE']);
      s.start();
      const runs = await f.list(owner);
      checkEqual(kind + ' preserves the other owner and original PID', runs.map((run) => [run.pid, run.owned]), [[live.pid, true]]);
      checkEqual(kind + ' leaves the refused instance blocked', s.elsewhere, true);
    } finally { await f.dispose(); }
  }

  suite('T32: live old keeper remains usable by window mode and is never replaced');
  const old = fixture({ old: true });
  try {
    const window = old.window(), original = old.session(window, 'old-window'); original.send('ASK old window');
    check('window mode works against a keeper with no metadata capability', await waitFor(() => original.status === 'waiting'));
    const pid = window.keeperPid, child = original.proc.pid;
    checkEqual('old describe has no metadata', (await old.list(window))[0].meta, undefined);
    original.detach(); await window.close();
    const nextWindow = old.window(), restored = old.session(nextWindow, 'old-window');
    checkEqual('legacy key attachment still works without metadata', await nextWindow.attach(restored), true);
    const service = old.daemon(), refused = old.session(service, 'service', 'fresh-old-window'); refused.start();
    check('old keeper resume gets its own diagnostic', await waitFor(() => refused.keeperRefusal === 'KEEPER_META_UNSUPPORTED'));
    for (const t of ['spawn', 'attach', 'reclaim']) {
      checkEqual('old hello refuses guarded ' + t + ' before writing', await service.request({ t, guard: { instance: 'service', cwd: old.dir, conversation: null } }),
        { ok: false, message: 'KEEPER_META_UNSUPPORTED' });
    }
    checkEqual('refusal never restarts the live old keeper or steals its run', [nextWindow.keeperPid, restored.proc.pid, fcount(old.log())], [pid, child, 1]);
  } finally { await old.dispose(); }

  suite('T33: only persisted eligible IDs attach; unrelated orphans remain unowned');
  const eligible = fixture({ grace: 2000 });
  try {
    const saved = eligible.store(), first = eligible.daemon(saved), s = eligible.session(first, 'eligible'); s.send('continuity');
    check('daemon fixture starts through the keeper', await waitFor(() => s.proc && s.proc.pid && /w3 /.test(text(s))));
    const pid = s.proc.pid, runId = s.proc.runId;
    const outsider = eligible.window(), orphan = await eligible.raw(outsider, 'unrelated', { conversation: 'other-conversation', instance: 'unrelated', cwd: eligible.dir });
    outsider.send({ t: 'release', runId: orphan.run.runId }); await eligible.list(outsider);
    s.detach(); await first.close();
    const second = eligible.daemon(eligible.store('manifest')), next = eligible.session(second, 'eligible');
    checkEqual('restart attaches its persisted instance within grace', await second.attach(next), true);
    checkEqual('continuity retains the provider PID and run identity', [next.proc.pid, next.proc.runId], [pid, runId]);
    check('the in-flight turn finishes after reattachment', await waitFor(() => next.status === 'done'));
    checkEqual('every word and cost is counted once across daemon reattachment', [text(next), next.totalCost, fcount(eligible.log())],
      [Array.from({ length: 30 }, (_, n) => 'w' + (n + 1) + ' ').join(''), 0.5, 1]);
    const unknown = eligible.session(second, 'unrelated', 'other-conversation');
    checkEqual('an unrelated matching orphan ID is ineligible', await second.attach(unknown), 'elsewhere');
    checkEqual('ineligible adoption has a named diagnostic', unknown.keeperRefusal, 'KEEPER_NOT_ELIGIBLE');
    checkEqual('known-instance restoration does not bulk-adopt unrelated orphans', (await eligible.list(outsider)).find((run) => run.key === 'unrelated').owned, false);
  } finally { await eligible.dispose(); }

  suite('T33/T54: owned, incompatible and expired eligible runs never trigger replacement');
  for (const kind of ['owned', 'incompatible', 'malformed', 'unreplayable', 'expired']) {
    const f = fixture({ grace: kind === 'expired' ? 100 : 1200 });
    try {
      const owner = f.window(), saved = f.store(), mapping = { conversation: 'known', instance: 'eligible', cwd: f.dir };
      const s0 = f.session(owner, 'eligible', 'known'), snapshot = s0.snapshot();
      if (kind === 'incompatible') snapshot.$v++;
      if (kind === 'malformed') snapshot.items = null;
      const live = await f.raw(owner, 'eligible', mapping, kind === 'unreplayable' ? null : snapshot);
      saved.update(MANIFEST, { version: 1, runs: [{ runId: live.run.runId, meta: mapping }] });
      if (kind !== 'owned') { owner.send({ t: 'release', runId: live.run.runId }); await f.list(owner); }
      if (kind === 'expired') await waitFor(async () => !(await f.list(owner)).length);
      const service = f.daemon(saved), s = f.session(service, 'eligible', 'known');
      checkEqual(kind + ' eligible run refuses unsafe recovery', await service.attach(s), 'elsewhere');
      checkEqual(kind + ' recovery has a named loss/blocker', s.keeperRefusal,
        { owned: 'KEEPER_OWNED_ELSEWHERE', incompatible: 'KEEPER_CHECKPOINT_INCOMPATIBLE', malformed: 'KEEPER_CHECKPOINT_INCOMPATIBLE', unreplayable: 'KEEPER_UNREPLAYABLE', expired: 'KEEPER_RUN_LOST' }[kind]);
      s.send('not a replacement'); await sleep(20);
      checkEqual(kind + ' recovery never starts a new provider', f.log().length, 0);
      if (kind !== 'owned' && kind !== 'expired') checkEqual(kind + ' recovery does not retain ownership of the incompatible run', (await f.list(owner))[0].owned, false);
    } finally { await f.dispose(); }
  }

  suite('T32: concurrent guarded resumes serialize at the keeper and unavailable never falls back');
  const race = fixture();
  try {
    const a = race.window(), b = race.window(); await Promise.all([a.connect(), b.connect()]);
    const replies = await Promise.all([race.raw(a, 'race-a', { conversation: 'same-conversation', instance: 'race-a', cwd: race.dir }, {}, true),
      race.raw(b, 'race-b', { conversation: 'same-conversation', instance: 'race-b', cwd: race.dir }, {}, true)]);
    checkEqual('only one simultaneous resume is spawned', replies.filter((reply) => reply.ok).length, 1);
    checkEqual('the racing loser receives a named conversation refusal', replies.find((reply) => !reply.ok).message, 'KEEPER_CONVERSATION_LIVE');
    const service = race.daemon(); service.connect = async () => false;
    const s = race.session(service, 'unavailable'); s.start();
    check('unavailable keeper returns a named refusal', await waitFor(() => s.keeperRefusal === 'KEEPER_UNAVAILABLE'));
    checkEqual('strict service mode never uses window-mode direct-child fallback', fcount(race.log()), 0);
  } finally { await race.dispose(); }

  suite('T32/T33: manifest I/O failures preserve named refusals and never fall back');
  for (const stage of ['spawn', 'checkpoint']) {
    const f = fixture();
    try {
      const saved = f.store(), update = saved.update; let writes = 0;
      saved.update = (key, value) => {
        if (key === MANIFEST && ++writes === (stage === 'spawn' ? 1 : 2)) throw Object.assign(new Error('fixture manifest disk full'), { code: 'ENOSPC' });
        return update(key, value);
      };
      const service = f.daemon(saved), s = f.session(service, 'failed-manifest'); s.send('not a fallback');
      check(stage + ' manifest failure is named', await waitFor(() => s.keeperRefusal === 'KEEPER_MANIFEST_UNAVAILABLE'));
      const observer = f.window(); await observer.connect();
      checkEqual(stage + ' manifest failure does not retain ownership of an uncheckpointed run', (await f.list(observer)).some((run) => run.key === s.id && run.owned), false);
      checkEqual(stage + ' refusal remains visible in daemon diagnostics', [...service.blockers.values()].map((blocker) => blocker.code), ['KEEPER_MANIFEST_UNAVAILABLE']);
      checkEqual(stage + ' failure never starts a direct child replacement', fcount(f.log()) <= (stage === 'spawn' ? 0 : 1), true);
    } finally { await f.dispose(); }
  }

  suite('T05/T23/T33: actual daemon worker crash and restart retain only its own kept fixture run');
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/nkd11-')), root = home + '/d', paths = privateRoot(root), children = [];
  fs.mkdirSync(paths.home, { mode: 0o700 });
  const cli = paths.home + '/fixture-cli', log = paths.home + '/provider.log';
  const code = fs.readFileSync(FAKE, 'utf8').replace(/^#![^\n]*\n/, '#!' + process.execPath + '\n' +
    'process.env.FAKE_LOG = ' + JSON.stringify(log) + '; process.env.FAKE_WORDS = "10"; process.env.FAKE_MS = "10";\n');
  fs.writeFileSync(cli, code, { mode: 0o700 });
  fs.writeFileSync(paths.config, JSON.stringify({ version: 1, user: { claudePath: cli }, projects: [] }), { mode: 0o600 });
  function launch() {
    const child = cp.fork(path.join(__dirname, 'fixtures/engine/keeper-daemon.js'), [root], { silent: true,
      env: { HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', NIKUI_KEEPER_DIR: home + '/MUST-NOT-BE-USED' } });
    let stderr = ''; child.stderr.on('data', (data) => { stderr += data; });
    const wait = () => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Daemon fixture timed out: ' + stderr)), 8000);
      child.once('message', (message) => { clearTimeout(timeout); resolve(message); });
      child.once('exit', (status) => { clearTimeout(timeout); reject(new Error('Daemon fixture exited ' + status + ': ' + stderr)); });
    });
    const done = new Promise((resolve) => child.once('exit', (status, signal) => resolve({ status, signal })));
    const fixture = { child, wait, done }; children.push(fixture); return fixture;
  }
  let keeperPid, providerPid;
  try {
    const first = launch(), before = await first.wait(); providerPid = before.pid;
    checkEqual('first daemon fixture is waiting on one kept approval', [before.restored, before.status, before.requests, before.protocol], [false, 'waiting', 1, 2]);
    first.child.send('crash'); checkEqual('worker crashes itself without normal cleanup', (await first.done).status, 77);
    checkEqual('the provider survives its daemon worker crash', alive(before.pid), true);
    const second = launch(), after = await second.wait();
    checkEqual('new daemon restores the same instance, conversation and provider within grace', [after.restored, after.pid, after.instance, after.conversation, after.requests, after.refusal],
      [true, before.pid, before.instance, before.conversation, 1, null]);
    check('daemon generation changes across restart', after.generation !== before.generation);
    check('P1-15 keeper continuity rotates old controls while the fresh snapshot can answer', after.run.id !== before.run.id && after.run.turn !== null);
    checkEqual('restart spawned only one fake provider in its independent log', fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((row) => row.pid).length, 1);
    const oldControl = second.wait(); second.child.send({ type: 'stale-answer', run: before.run });
    const refusedControl = await oldControl;
    checkEqual('P1-15 pre-crash approval cannot answer the reattached execution', [refusedControl.answer?.error?.code, refusedControl.status], ['STALE_RUN', 'waiting']);
    const answered = second.wait(); second.child.send('answer'); const result = await answered;
    checkEqual('restored provider finishes once after the new daemon answers', [result.status, result.turns, result.cost], ['done', 1, 0.5]);
    keeperPid = Number(fs.readFileSync(root + '/keeper/keeper.pid', 'utf8'));
    second.child.send('stop'); checkEqual('restarted daemon drains intentionally with exit 0', (await second.done).status, 0);
    checkEqual('inherited live-keeper overrides were ignored', fs.existsSync(home + '/MUST-NOT-BE-USED'), false);
  } finally {
    for (const worker of children) if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill('SIGKILL'); await worker.done; }
    await waitFor(() => !providerPid || !alive(providerPid), 8000);
    if (providerPid && alive(providerPid)) { try { process.kill(providerPid, 'SIGKILL'); } catch (_) {} }
    await waitFor(() => !keeperPid || !alive(keeperPid), 3000);
    if (keeperPid && alive(keeperPid)) { try { process.kill(keeperPid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
};
function fcount(log) { return log.filter((row) => row.pid).length; }
