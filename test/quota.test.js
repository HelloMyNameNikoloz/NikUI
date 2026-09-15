'use strict';
const { install, memoryState } = require('./helpers/vscode-stub.js');

const stub = install();
const { Session, looksRateLimited } = require('../src/session.js');
const { SessionManager, pickReset, RESUME_GRACE_MS, BLIND_RETRY_MS } = require('../src/manager.js');

/** A session that talks to nothing: every write is recorded instead. */
function fake(manager, opts) {
  const s = manager.create(Object.assign({ cwd: '/tmp', autoStart: false }, opts || {}));
  s.sent = [];
  s._write = function (obj) {
    const content = (obj.message && obj.message.content) || [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (text) this.sent.push(text);
  };
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

const rejected = (resetsAt) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt,
    unifiedWindows: { five_hour: { utilization: 1, resetsAt } }
  }
});

module.exports = function () {
  suite('when the quota runs out overnight');

  const context = { workspaceState: memoryState(), globalState: memoryState() };
  const manager = new SessionManager(context);

  const working = fake(manager);   // cut off mid-turn, nothing queued
  const queueing = fake(manager);   // idle, but holding a queue
  const both = fake(manager);       // cut off mid-turn *and* holding a queue
  const idle = fake(manager);       // nothing going on at all

  working.send('do the long thing');
  checkEqual('one instance is mid-turn', working.status, 'working');

  queueing.send('first');
  queueing._handleResult({ type: 'result', is_error: false, usage: {} });
  queueing.enqueue('second');
  queueing.enqueue('third');
  checkEqual('another is idle with work stacked up', queueing.queue.length, 2);

  both.send('the long thing');
  both.enqueue('then this');
  checkEqual('and one has both', [both.status, both.queue.length], ['working', 1]);

  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  working._handle(rejected(resetsAt));

  check('the window notices', !!manager.pause);
  checkEqual('and waits until a minute past the reset',
    manager.pause.until, resetsAt * 1000 + RESUME_GRACE_MS);
  check('every instance is held, not just the one that heard',
    [working, queueing, both, idle].every((s) => s.isPaused));
  check('and each says so in its own conversation',
    [working, queueing, both, idle].every((s) => s.items.some((i) => /usage limit is spent/.test(i.text || ''))));

  suite('nothing queued is lost or sent early');

  checkEqual('the queue is exactly as it was', queueing.queue.map((q) => q.text), ['second', 'third']);
  check('and it is not draining', !queueing.isReadyForQueue());

  const before = queueing.sent.length;
  queueing.submit('something I typed while it was paused');
  checkEqual('a prompt sent meanwhile goes nowhere', queueing.sent.length, before);
  checkEqual('it joins the back of the queue',
    queueing.queue.map((q) => q.text), ['second', 'third', 'something I typed while it was paused']);

  suite('and when the quota comes back');

  const woken = manager.resumeFromLimit();
  checkEqual('everything is released', woken, 4);
  check('nothing is still holding', [working, queueing, both, idle].every((s) => !s.isPaused));

  const nudged = (s) => s.sent.filter((t) => /Carry on with the task/.test(t)).length;
  checkEqual('the instance that was cut off is told to carry on', nudged(working), 1);
  checkEqual('the one that was only holding a queue is not nudged', nudged(queueing), 0);
  checkEqual('an idle instance with nothing to do is left alone', idle.sent.length, 0);

  checkEqual('the queue is still intact, in order',
    queueing.queue.map((q) => q.text), ['second', 'third', 'something I typed while it was paused']);
  check('and it is free to drain again', queueing.isReadyForQueue());

  suite('an instance with both gets the nudge first, and keeps its queue');

  checkEqual('the nudge goes out straight away', nudged(both), 1);
  checkEqual('it is sent, not queued', both.queue.map((q) => q.text), ['then this']);
  checkEqual('so the interrupted work is picked up before the queued work',
    both.sent[both.sent.length - 1].slice(0, 20), 'Your usage limit res'.slice(0, 20));

  suite('a pause outlives the window');

  const second = new SessionManager(context);
  const revived = fake(second);
  second.restorePause();
  checkEqual('nothing is held once the quota has been served', second.pause, null);
  check('so a fresh instance runs', !revived.isPaused);

  const third = new SessionManager({ workspaceState: memoryState(), globalState: memoryState() });
  const held = fake(third);
  held._handle(rejected(Math.floor(Date.now() / 1000) + 7200));
  const afterReload = new SessionManager(third.context);
  check('a pause written down is read back', !!afterReload.pause);
  const late = fake(afterReload);
  check('and an instance made during it is held too', late.isPaused);
  check('including one restored after the reload', afterReload.restorePause());

  suite('when the CLI only says it in words');

  const wordy = fake(manager);
  check('the wording is recognised', looksRateLimited('Claude usage limit reached — resets at 3pm'));
  check('and something else is not', !looksRateLimited('the build failed'));
  wordy._handleResult({ type: 'result', is_error: true, result: 'usage limit reached', usage: {} });
  check('so a turn that fails that way pauses the window too', !!manager.pause);

  suite('where the reset time comes from');

  checkEqual('the spent window has the final say', pickReset({
    type: 'five_hour', resetsAt: 9000, windows: { fiveHour: { used: 1, resetsAt: 5000 } }
  }), 5000);
  checkEqual('otherwise the headline one', pickReset({ type: null, resetsAt: 9000, windows: {} }), 9000);
  checkEqual('and with no reset at all, none', pickReset({ windows: {} }), null);
  check('a blind pause still ends', BLIND_RETRY_MS > 0);

  manager.disposeAll();
  second.disposeAll();
  third.disposeAll();
  afterReload.disposeAll();
};
