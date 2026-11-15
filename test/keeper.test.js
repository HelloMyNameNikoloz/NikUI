'use strict';

// Reloading the window does not end an instance: the keeper holds its
// process, and the next window picks it up exactly where it was.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { Session } = require('../src/session.js');
const { KeeperLink } = require('../src/keeperLink.js');

const FAKE = path.join(__dirname, 'helpers', 'fake-claude.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, ms) {
  const until = Date.now() + (ms || 5000);
  while (Date.now() < until) { if (what()) return true; await sleep(20); }
  return !!what();
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const text = (s) => s.items.filter((i) => i.kind === 'assistant' || i.kind === 'text').map((i) => i.text).join('|');
const users = (s) => s.items.filter((i) => i.kind === 'user').map((i) => i.text);

module.exports = async function () {
  suite('instances survive a window reload');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-'));
  const fakeLog = path.join(dir, 'fake.log');
  const read = () => fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  process.env.FAKE_LOG = fakeLog;
  process.env.NIKUI_KEEPER_GRACE_MS = '1500';
  process.env.NIKUI_KEEPER_IDLE_MS = '800';
  const keeperDir = path.join(dir, 'k');
  // What one window is: a link to the keeper and the instances it shows.
  const windowWith = () => new KeeperLink({ dir: keeperDir, nodePath: process.execPath });
  const instance = (link, id) => new Session({ id: id || 'nik-test-a', cwd: dir, claudePath: FAKE, spawner: link.spawner(), maxItems: 0 });
  const reload = async (link, sessions) => {
    for (const s of sessions) if (!s.detach()) s.dispose();
    await link.close();
  };
  const pickUp = async (link, s) => {
    const trying = link.attach(s);
    s._attaching = trying;
    const ok = await trying;
    s.attached();
    return ok;
  };

  // ---- mid-turn ----------------------------------------------------------------
  let link = windowWith();
  let s = instance(link);
  s.send('hello');
  check('the first window starts the instance through the keeper', await waitFor(() => /w3 /.test(text(s))));
  const pid = (read().find((e) => e.pid) || {}).pid;
  check('as a process of its own', pid > 0 && pid !== process.pid);
  check('the keeper is a process of its own too', link.keeperPid > 0 && link.keeperPid !== process.pid);
  check('and the instance does not know the difference', s.isRunning && s.status === 'working');

  await reload(link, [s]);
  check('a reload lets go of the instance without stopping it', alive(pid));
  await sleep(150);

  link = windowWith();
  s = instance(link);
  check('the next window picks it up', await pickUp(link, s));
  check('the same process, not a second one', read().filter((e) => e.pid).length === 1 && alive(pid));
  check('mid-turn, still working', s.status === 'working' && s.isRunning);
  check('with what was said before the reload', /w1 w2 w3 /.test(text(s)));
  check('and the prompt that started it', users(s).join() === 'hello');
  check('the turn finishes in the new window', await waitFor(() => s.status === 'done', 4000));
  checkEqual('every word exactly once', text(s), 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 ');
  checkEqual('what it cost, counted once', s.totalCost, 0.5);
  checkEqual('one turn', s.turns, 1);

  s.send('again');
  check('and it carries on talking', await waitFor(() => s.turns === 2 && s.status === 'done', 4000));
  checkEqual('costing what the process says, not twice that', s.totalCost, 1);

  // ---- a turn that finishes while nobody is looking ----------------------------
  s.send('third');
  await waitFor(() => /w2 /.test(s.items[s.items.length - 1].text || ''));
  await reload(link, [s]);
  await sleep(900); // the turn ends with no window
  link = windowWith();
  s = instance(link);
  check('a turn that ended between windows is picked up too', await pickUp(link, s));
  check('finished', s.status === 'done' && s.turns === 3);
  checkEqual('its cost included once', s.totalCost, 1.5);
  checkEqual('all three prompts, once each', users(s).join(), 'hello,again,third');

  // ---- a question waiting on an answer -----------------------------------------
  s.send('ASK first');
  check('a permission prompt is waiting', await waitFor(() => s.status === 'waiting'));
  await reload(link, [s]);
  link = windowWith();
  s = instance(link);
  await pickUp(link, s);
  const asked = s.items.find((i) => i.kind === 'permission' && !i.resolved);
  check('after the reload it is still waiting, unanswered', s.status === 'waiting' && !!asked);
  s.respondToPermission(asked.requestId, true);
  asked.resolved = 'allow';
  s.respondToPermission(asked.requestId, true);
  check('answered, it carries on', await waitFor(() => s.turns === 4 && s.status === 'done', 4000));
  checkEqual('an answer given twice reaches it once',
    read().filter((e) => e.got === 'control_response').length, 1);

  // ---- a reload before anything was said ---------------------------------------
  const quiet = instance(link, 'nik-test-quiet');
  quiet.start();
  await waitFor(() => quiet.proc && quiet.proc.pid);
  await sleep(100);
  await reload(link, [s, quiet]);
  link = windowWith();
  s = instance(link);
  const quiet2 = instance(link, 'nik-test-quiet');
  check('one started but never spoken to is picked up as well', await pickUp(link, quiet2));
  await pickUp(link, s);
  quiet2.send('hi');
  check('and answers', await waitFor(() => quiet2.status === 'done'));

  // ---- a prompt typed while it is being picked up ------------------------------
  await reload(link, [s, quiet2]);
  link = windowWith();
  s = instance(link);
  const trying = link.attach(s);
  s._attaching = trying;
  s.send('typed during the pickup');
  await trying;
  s.attached();
  check('a prompt typed while picking up goes to the same process', await waitFor(() => s.turns === 5 && s.status === 'done', 4000));
  check('no second process for it', read().filter((e) => e.pid).length === 2);

  // ---- the connection drops, the keeper does not -------------------------------
  const lastText = () => (s.items.filter((i) => i.kind === 'assistant' || i.kind === 'text').pop() || {}).text || '';
  s.send('dropped');
  await waitFor(() => s.turns === 5 && /w2 /.test(lastText()));
  link.socket.destroy();
  check('a dropped connection is picked back up, and the turn finishes', await waitFor(() => s.turns === 6 && s.status === 'done', 6000));
  check('in the same process', read().filter((e) => e.pid).length === 2 && alive(pid));
  checkEqual('every word once across the drop', lastText(), 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 ');
  s.send('after the drop');
  check('and it still takes prompts', await waitFor(() => s.turns === 7 && s.status === 'done', 4000));

  // ---- closing an instance stops it -------------------------------------------
  const quietPid = read().filter((e) => e.pid)[1].pid;
  quiet2.dispose();
  check('closing an instance on purpose stops its process', await waitFor(() => !alive(quietPid), 8000));

  // ---- a window closed, not reloaded ------------------------------------------
  await reload(link, [s]);
  check('a window that never comes back leaves it running for the grace period', alive(pid));
  check('and then it is stopped', await waitFor(() => !alive(pid), 6000));
  const sock = path.join(keeperDir, 'k1.sock');
  check('with nothing left, the keeper leaves too', await waitFor(() => !fs.existsSync(sock), 4000));

  // ---- stopped, then the window reloads at once -----------------------------------
  link = windowWith();
  let stopper = instance(link, 'nik-test-stop');
  stopper.send('hi');
  await waitFor(() => stopper.status === 'done');
  const stopPid = read().filter((e) => e.pid).pop().pid;
  stopper.stop();
  await reload(link, [stopper]);
  link = windowWith();
  stopper = instance(link, 'nik-test-stop');
  check('an instance stopped just before a reload is not picked up again', !(await pickUp(link, stopper)));
  check('and its process still ends', await waitFor(() => !alive(stopPid), 9000));
  stopper.dispose();
  await link.close();

  // ---- two windows starting a keeper at the same moment ---------------------------
  const raceDir = path.join(dir, 'race');
  fs.mkdirSync(raceDir, { mode: 0o700 });
  const raceSock = path.join(raceDir, 'k1.sock');
  fs.writeFileSync(raceSock, ''); // what a keeper that died leaves behind
  const { spawn } = require('child_process');
  const racers = [1, 2, 3].map(() => spawn(process.execPath, [path.join(__dirname, '..', 'src', 'keeper.js'), raceSock], {
    stdio: 'ignore', env: Object.assign({}, process.env, { NIKUI_KEEPER_IDLE_MS: '3000' })
  }));
  await sleep(700);
  const standing = racers.filter((c) => c.exitCode === null && c.signalCode === null);
  checkEqual('of keepers started together, one stays', standing.length, 1);
  const answers = await new Promise((res) => {
    const c = net.connect(raceSock);
    c.once('connect', () => { c.destroy(); res(true); });
    c.once('error', () => res(false));
  });
  check('and it is the one on the socket', answers);
  for (const c of racers) { try { c.kill('SIGKILL'); } catch (_) { /* gone */ } }
  await sleep(100);
  const again = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'keeper.js'), raceSock], {
    stdio: 'ignore', env: Object.assign({}, process.env, { NIKUI_KEEPER_IDLE_MS: '3000' })
  });
  const answering = () => new Promise((res) => { const c = net.connect(raceSock); c.once('connect', () => { c.destroy(); res(true); }); c.once('error', () => res(false)); });
  let answered = false;
  for (let i = 0; i < 30 && !answered; i++) { await sleep(100); answered = again.exitCode === null && await answering(); }
  check('one that died is replaced by the next', answered);
  again.kill('SIGKILL');

  // ---- the keeper is gone, or cannot start --------------------------------------
  const broken = new KeeperLink({ dir: path.join(dir, 'k2'), nodePath: '/nonexistent/node' });
  const local = instance(broken, 'nik-test-local');
  local.send('without a keeper');
  check('with no keeper an instance still runs, as the window\'s own child', await waitFor(() => local.status === 'done', 8000));
  check('and a reload simply ends it, as it always did', !local.detach());
  local.dispose();

  // The socket is this user's alone.
  const st = fs.statSync(keeperDir);
  checkEqual('the keeper\'s folder is private', (st.mode & 0o777).toString(8), '700');

  fs.rmSync(dir, { recursive: true, force: true });
};
