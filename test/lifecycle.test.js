'use strict';
const { install, memoryState } = require('./helpers/vscode-stub.js');
install();
const { Session, restoredStatus } = require('../src/session.js');
const { SessionManager } = require('../src/manager.js');

module.exports = function () {
  suite('a disposed instance stays dead');

  const z = new Session({ cwd: '/tmp' });
  let spawned = 0;
  const realStart = Session.prototype.start;
  z.start = function () { if (this.isRunning || this.disposed) return; spawned++; };

  check('a fresh instance is not disposed', z.disposed === false);
  z.dispose();
  check('dispose marks the instance', z.disposed === true);
  z.start();
  checkEqual('a disposed instance cannot be started', spawned, 0);

  // The guard lives in the real start(), not just the stub above.
  check('the real start() refuses a disposed instance', /this\.isRunning \|\| this\.disposed/.test(realStart.toString()));

  suite('removing an instance announces itself');

  const context = { workspaceState: memoryState(), globalState: memoryState() };
  const manager = new SessionManager(context);
  // Keep the test offline: creating must not spawn anything.
  const noSpawn = { autoStart: false };

  const a = manager.create(Object.assign({ cwd: '/tmp' }, noSpawn));
  const b = manager.create(Object.assign({ cwd: '/tmp' }, noSpawn));
  const announced = [];
  manager.on('removed', (s) => announced.push(s.id));

  manager.remove(a.id);
  checkEqual('remove() announces the instance', announced, [a.id]);
  check('and drops it from the list', !manager.list.includes(a));

  suite('asleep is not stopped');

  // b was restored from a previous window: no process, but never started.
  check('a restored instance reports itself asleep', b.isAsleep === true);
  checkEqual('nothing counts as stopped yet', manager.stopped().length, 0);
  checkEqual('so clearing removes nothing', manager.removeStopped(), 0);
  check('and the restored instance is still there', manager.list.includes(b));

  // c ran and its process exited — that is what "stopped" means.
  const c = manager.create(Object.assign({ cwd: '/tmp' }, noSpawn));
  c.everStarted = true;
  check('an instance whose process has gone is not asleep', c.isAsleep === false);
  checkEqual('it is the only one that counts as stopped', manager.stopped().map((s) => s.id), [c.id]);

  const cleared = manager.removeStopped();
  checkEqual('clearing takes it and nothing else', cleared, 1);
  checkEqual('it was announced', announced, [a.id, c.id]);
  checkEqual('the asleep instance survived', manager.list.map((s) => s.id), [b.id]);

  suite('closing asks when there is something to lose');

  check('a fresh instance has nothing behind it', b.hasHistory === false);
  b.claudeSessionId = 'abc-123';
  check('one with a conversation says so', b.hasHistory === true);

  suite('a reload remembers as many as it restores');

  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'manager.js'), 'utf8');
  const persisted = (src.match(/update\(STORAGE_KEY, data\.slice\(-(\w+)\)\)/) || [])[1];
  const restored = (src.match(/for \(const entry of saved\.slice\(-(\w+)\)\)/) || [])[1];
  check('both sides use the same limit', !!persisted && persisted === restored);

  manager.disposeAll();

  suite('a reload keeps the story behind the numbers');

  const ctx2 = { workspaceState: memoryState(), globalState: memoryState() };
  const before = new SessionManager(ctx2);
  const live = before.create({ cwd: '/Users/nikoloz/Codes/Peuka', autoStart: false });
  live.claudeSessionId = 'sess-1';
  live.totalCost = 1.25;
  live.turns = 80;
  live.errors = 2;
  live.interrupts = 1;
  live.startedAt = 1700000000000;
  live.turnLog = Array.from({ length: 80 }, (_, i) => ({
    n: i + 1, at: 1700000000000 + i * 1000, durationMs: 1000, costUsd: 0.01,
    input: 1, output: 2, cacheRead: 3, cacheCreate: 0, contextTokens: 100 * i,
    tools: Array.from({ length: 20 }, (_, k) => 'Tool' + k),
    model: 'claude-x', interrupted: false, isError: false
  }));
  before.persist();

  const stored = ctx2.workspaceState.get('nikui.sessions.v1', [])[0];
  checkEqual('only the recent turns are written down', stored.turnLog.length, 60);
  checkEqual('and the newest one is among them', stored.turnLog[stored.turnLog.length - 1].n, 80);
  checkEqual('a turn does not carry a hundred tool names', stored.turnLog[0].tools.length, 8);
  checkEqual('the start time is remembered', stored.startedAt, 1700000000000);

  const after = new SessionManager(ctx2);
  after.restoreOpen();
  const back = after.list[0];
  checkEqual('the turns come back', back.turnLog.length, 60);
  checkEqual('the cost comes back with them', back.totalCost, 1.25);
  checkEqual('so the two agree about how many turns there were', back.turns, 80);
  checkEqual('the counters come back', [back.errors, back.interrupts], [2, 1]);
  checkEqual('and the instance knows how old it is', back.startedAt, 1700000000000);
  check('a restored instance is still asleep', back.isAsleep === true);

  suite('a reload gives an instance back the state it ended in');

  const ctx3 = { workspaceState: memoryState(), globalState: memoryState() };
  const closing = new SessionManager(ctx3);
  const finished = closing.create({ cwd: '/tmp', autoStart: false });
  finished.claudeSessionId = 'sess-done';
  finished.status = 'done';
  finished.finishedAt = 1700000000000;
  const failed = closing.create({ cwd: '/tmp', autoStart: false });
  failed.claudeSessionId = 'sess-error';
  failed.status = 'error';
  const midTurn = closing.create({ cwd: '/tmp', autoStart: false });
  midTurn.claudeSessionId = 'sess-working';
  midTurn.status = 'working';
  closing.persist();

  const reopened = new SessionManager(ctx3);
  reopened.restoreOpen();
  const byId = (id) => reopened.list.find((s) => s.claudeSessionId === id);
  checkEqual('a conversation that finished comes back finished', byId('sess-done').status, 'done');
  checkEqual('with the moment it finished', byId('sess-done').finishedAt, 1700000000000);
  checkEqual('one that errored comes back errored', byId('sess-error').status, 'error');
  checkEqual('and one cut off mid-turn comes back stopped, not still working',
    byId('sess-working').status, 'stopped');
  check('none of them is running', reopened.list.every((s) => !s.isRunning && s.isAsleep));
  checkEqual('the state a fresh instance starts in is unchanged', restoredStatus(undefined), 'idle');

  closing.disposeAll();
  reopened.disposeAll();

  before.disposeAll();
  after.disposeAll();

  suite('two instances with the same name');

  const named = new SessionManager({ workspaceState: memoryState(), globalState: memoryState() });
  const only = named.create({ cwd: '/Users/x/Codes/Peuka', autoStart: false, ticket: '1327' });
  checkEqual('one of a name needs no explaining', named.displayName(only), '1327');

  const twin = named.create({ cwd: '/Users/x/Codes/NikUI', autoStart: false, ticket: '1327' });
  checkEqual('a second one is told apart by its folder', named.displayName(twin), '1327 · NikUI');
  checkEqual('and so is the first', named.displayName(only), '1327 · Peuka');

  const triplet = named.create({ cwd: '/Users/x/Codes/NikUI', autoStart: false, ticket: '1327' });
  checkEqual('two in the same folder are numbered', named.displayName(triplet), '1327 · NikUI 2');
  checkEqual('in the order they were made', named.displayName(twin), '1327 · NikUI 1');

  named.remove(triplet.id);
  named.remove(twin.id);
  checkEqual('and the name goes back to plain once it is alone', named.displayName(only), '1327');
  named.disposeAll();

  suite('a queued prompt can jump the line or come back');

  const q = new Session({ cwd: '/tmp' });
  q._write = function () {};
  Object.defineProperty(q, 'isRunning', { get: () => true });
  q.status = 'working';

  q.enqueue('first');
  q.enqueue('second');
  q.enqueue('third');
  checkEqual('three are waiting', q.queue.map((x) => x.text), ['first', 'second', 'third']);

  q.promote(q.queue[2].id);
  checkEqual('promoting one moves it to the front', q.queue.map((x) => x.text), ['third', 'first', 'second']);
  check('promoting the front one changes nothing', q.promote(q.queue[0].id) === true);
  checkEqual('the order holds', q.queue.map((x) => x.text), ['third', 'first', 'second']);
  check('and an id nobody has is refused', q.promote('nope') === false);

  const taken = q.reclaim(q.queue[1].id);
  checkEqual('reclaiming hands the text back', taken.text, 'first');
  checkEqual('and takes it out of the queue', q.queue.map((x) => x.text), ['third', 'second']);
  checkEqual('reclaiming nothing returns nothing', q.reclaim('nope'), null);
  q.dispose();

  suite('the plan\u2019s limits belong to the window, not to one instance');

  const shared = { workspaceState: memoryState(), globalState: memoryState() };
  const account = new SessionManager(shared);
  const one = account.create({ cwd: '/tmp', autoStart: false });
  const two = account.create({ cwd: '/tmp', autoStart: false });

  const reading = { status: 'allowed', windows: { fiveHour: { used: 0.5, resetsAt: 1 } }, at: 1000 };
  one._handle({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1 } } }
  });

  check('the instance that heard it knows', one.limits && one.limits.windows.fiveHour.used === 0.5);
  check('so does the window', account.limits && account.limits.windows.fiveHour.used === 0.5);
  check('and so does every other instance', two.limits && two.limits.windows.fiveHour.used === 0.5);

  const older = Object.assign({}, reading, { at: 1, windows: { fiveHour: { used: 0.1, resetsAt: 1 } } });
  account.rememberLimits(older);
  check('a stale reading does not overwrite a fresh one', account.limits.windows.fiveHour.used === 0.5);

  check('and it outlives the window', !!shared.globalState.get('nikui.limits.v1', null));
  const later = new SessionManager(shared);
  check('so a reload starts out knowing', later.limits && later.limits.windows.fiveHour.used === 0.5);
  const fresh = later.create({ cwd: '/tmp', autoStart: false });
  check('including instances made afterwards', fresh.limits && fresh.limits.windows.fiveHour.used === 0.5);

  account.disposeAll();
  later.disposeAll();

  suite('a reload keeps the prompts nobody has answered yet');

  // The pause that makes a queue long is remembered across a reload — so
  // forgetting the queue itself would be the worst possible pair to keep.
  const ctxQueue = { workspaceState: memoryState(), globalState: memoryState() };
  const typed = new SessionManager(ctxQueue);
  const waiting = typed.create({ cwd: '/Users/nikoloz/Codes/Peuka', autoStart: false });
  waiting.claudeSessionId = 'sess-queue';
  waiting.enqueue('finish the migration');
  waiting.enqueue('then write it up', [{ name: 'shot.png', mediaType: 'image/png', data: 'AAAA' }]);
  typed.persist();

  const written = JSON.stringify(ctxQueue.workspaceState.get('nikui.sessions.v1', []));
  check('the prompts are written down', written.indexOf('finish the migration') > 0);
  check('their images are not — that would be a copy of the conversation',
    written.indexOf('AAAA') < 0);

  const afterQueueReload = new SessionManager(ctxQueue);
  afterQueueReload.restoreOpen();
  const queued = afterQueueReload.get(waiting.id);
  checkEqual('both come back, in order', queued.queue.map((q) => q.text),
    ['finish the migration', 'then write it up']);
  checkEqual('and one of them says it lost a picture',
    queued.queue.map((q) => q.lostImages), [0, 1]);
  check('with nothing pretending the image is still there',
    queued.queue.every((q) => q.attachments.length === 0));

  afterQueueReload.disposeAll();
  typed.disposeAll();
};
