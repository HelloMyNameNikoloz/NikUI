'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');

module.exports = async function () {
  suite('queued prompts');

  const s = new Session({ cwd: '/tmp' });
  const sent = [];
  s.send = function (text) { sent.push(text); this._setStatus('working'); };
  s.start = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });

  checkEqual('an idle instance sends straight away', s.submit('one'), 'sent');
  checkEqual('a busy instance queues', s.submit('two'), 'queued');
  checkEqual('and keeps stacking', s.submit('three'), 'queued');
  checkEqual('the queue holds them in order', s.queue.map((q) => q.text), ['two', 'three']);
  checkEqual('empty submissions are ignored', s.submit('   '), null);

  check('not ready while working', s.isReadyForQueue() === false);
  s._setStatus('done');
  check('ready once the turn is over', s.isReadyForQueue() === true);

  // A tool still running must hold the queue back.
  s._upsert({ id: 't1', kind: 'tool', name: 'Bash', input: {}, status: 'running' });
  check('a tool still running blocks the queue', s.isReadyForQueue() === false);
  s._itemIndex.get('t1').status = 'done';
  check('ready again once the tool finishes', s.isReadyForQueue() === true);

  // The countdown must start from the end of the turn, not from when it was typed.
  s._setStatus('working');
  s._handleResult({ type: 'result', is_error: false, total_cost_usd: 0.001, usage: {} });
  const wait = s.drainAt - Date.now();
  check('the countdown restarts on the result', wait > 4500 && wait <= 5000);
  checkEqual('the delay is five seconds', s.queueDelayMs, 5000);

  s.unqueue(s.queue[0].id);
  checkEqual('an item can be removed', s.queue.map((q) => q.text), ['three']);
  s.clearQueue();
  checkEqual('the queue can be cleared', s.queue.length, 0);
  check('clearing cancels the countdown', s.drainAt === null);

  s.dispose();

  suite('a tool nobody finished does not hold the queue shut');

  // The case this was written for: a conversation read back from disk that ends
  // in a tool call, or a process killed mid-tool. The item stays in the
  // transcript forever, and it used to mean nothing queued ever went out again.
  const stale = new Session({ cwd: '/tmp' });
  stale.start = function () { this.everStarted = true; };
  const went = [];
  stale.send = function (text) { went.push(text); };
  Object.defineProperty(stale, 'isRunning', { get: () => true });
  stale._upsert({ id: 'u1', kind: 'user', text: 'do it', images: [] });
  stale._upsert({ id: 't1', kind: 'tool', name: 'Bash', input: {}, status: 'running' });

  checkEqual('while the tool is running, the queue waits', stale.isReadyForQueue(), false);
  stale._handleResult({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} });
  checkEqual('a turn that ends leaves nothing running',
    stale.items.find((i) => i.kind === 'tool').status, 'stopped');
  checkEqual('so the queue can move again', stale.isReadyForQueue(), true);

  stale.enqueue('this one has to go out');
  await new Promise((r) => setTimeout(r, stale.queueDelayMs + 300));
  checkEqual('and it does', went, ['this one has to go out']);
  checkEqual('leaving nothing behind', stale.queue.length, 0);
  stale.dispose();

  const stopped = new Session({ cwd: '/tmp' });
  stopped._write = function () {};
  stopped._upsert({ id: 't2', kind: 'tool', name: 'Bash', input: {}, status: 'running' });
  stopped.stop();
  checkEqual('stopping an instance ends its tools too',
    stopped.items.find((i) => i.kind === 'tool').status, 'stopped');
  stopped.dispose();

  suite('the window still applies with an abandoned tool in it');

  const capped = new Session({ cwd: '/tmp', maxItems: 10 });
  capped._write = function () {};
  capped._upsert({ id: 'head', kind: 'tool', name: 'Bash', input: {}, status: 'running' });
  capped._handleResult({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} });
  for (let i = 0; i < 200; i++) capped._upsert({ id: 'x' + i, kind: 'text', text: 'line ' + i });
  checkEqual('the cap is the cap', capped.items.length, 10);
  check('and what went is counted', capped.droppedItems > 180);
  capped.dispose();

  const live = new Session({ cwd: '/tmp', maxItems: 10 });
  live._write = function () {};
  live._upsert({ id: 'head', kind: 'tool', name: 'Bash', input: {}, status: 'running' });
  for (let i = 0; i < 40; i++) live._upsert({ id: 'y' + i, kind: 'text', text: 'line ' + i });
  check('a tool that really is running is still not dropped from under it',
    live.items[0].id === 'head');
  live.dispose();
};
