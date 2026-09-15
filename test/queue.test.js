'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');

module.exports = function () {
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
};
