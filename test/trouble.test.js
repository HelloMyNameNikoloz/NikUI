'use strict';
const { EventEmitter } = require('events');
const { install } = require('./helpers/vscode-stub.js');

install();
const { watchForTrouble, watchForCrowding } = require('../src/extension.js');
const { Session } = require('../src/session.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

module.exports = async function () {
  suite('a CLI that will not start says so out loud');

  const missing = new Session({ cwd: '/tmp', claudePath: '/nope/claude-does-not-exist' });
  const failure = new Promise((resolve) => missing.on('failed', (message, code) => resolve({ message, code })));
  missing.start();
  const failed = await Promise.race([failure, new Promise((r) => setTimeout(() => r(null), 4000))]);

  check('the instance announces the failure', !!failed);
  check('the message names the missing binary', /claude-does-not-exist/.test(failed.message));
  check('and says how to fix it', /nikui\.claudePath/.test(failed.message));
  checkEqual('the reason is passed along', failed.code, 'ENOENT');
  checkEqual('and the instance is marked as errored', missing.status, 'error');
  check('while the transcript keeps a copy', missing.items.some((i) => i.kind === 'notice' && i.level === 'error'));
  missing.dispose();

  suite('nothing important happens quietly');

  const manager = new EventEmitter();
  const shown = [];
  const opened = [];
  let answer;
  let visible = false;
  let notify = true;

  watchForTrouble(manager, (session) => opened.push(session.id), {
    window: {
      showErrorMessage: async (message, ...actions) => { shown.push({ kind: 'error', message, actions }); return answer; },
      showWarningMessage: async (message, ...actions) => { shown.push({ kind: 'warning', message, actions }); return answer; }
    },
    readConfig: () => ({ notifyOnAttention: notify }),
    isVisible: () => visible
  });

  const waiting = {
    id: 's1', label: '1327', status: 'waiting',
    items: [{ kind: 'permission', requestId: 'r1', name: 'Bash', resolved: null }]
  };

  // ---- blocked out of sight --------------------------------------------

  answer = undefined;
  manager.emit('session-changed', waiting);
  await settle();
  checkEqual('an instance waiting out of sight is reported', shown.length, 1);
  check('the message names it and what it wants', /1327 is waiting/.test(shown[0].message) && /Bash/.test(shown[0].message));
  checkEqual('and offers to take you there', shown[0].actions, ['Open instance']);

  manager.emit('session-changed', waiting);
  manager.emit('session-changed', waiting);
  await settle();
  checkEqual('it is not repeated while it keeps waiting', shown.length, 1);

  // Answered, then blocked again: that is a new thing to know about.
  manager.emit('session-changed', Object.assign({}, waiting, { status: 'working' }));
  manager.emit('session-changed', waiting);
  await settle();
  checkEqual('but a second question is reported again', shown.length, 2);

  // ---- not worth interrupting for --------------------------------------

  shown.length = 0;
  visible = true;
  manager.emit('session-changed', Object.assign({}, waiting, { id: 's2', status: 'working' }));
  manager.emit('session-changed', Object.assign({}, waiting, { id: 's2' }));
  await settle();
  checkEqual('an instance you are looking at is not announced', shown.length, 0);

  visible = false;
  notify = false;
  manager.emit('session-changed', Object.assign({}, waiting, { id: 's3' }));
  await settle();
  checkEqual('and nothing is announced with notifications off', shown.length, 0);

  // ---- a failure reaches the window ------------------------------------

  notify = true;
  answer = 'Open instance';
  manager.emit('failed', { id: 's4', label: 'broken' }, 'Could not run "claude".');
  await settle();
  checkEqual('a failed instance is reported as an error', shown.filter((s) => s.kind === 'error').length, 1);
  check('with a way to open it and a way to fix it',
    shown[0].actions.indexOf('Open instance') === 0 && shown[0].actions.indexOf('Settings') === 1);
  checkEqual('and taking the offer opens it', opened, ['s4']);

  suite('a window full of processes says so, once');

  const crowd = new EventEmitter();
  const said = [];
  crowd.list = [];
  watchForCrowding(crowd, {
    limit: 4,
    window: { showInformationMessage: async (message) => { said.push(message); return undefined; } }
  });

  const running = (n) => { crowd.list = Array.from({ length: n }, () => ({ isRunning: true })); crowd.emit('changed'); };

  running(3);
  checkEqual('a handful is nobody\'s business', said.length, 0);
  running(4);
  checkEqual('the fourth is worth a word', said.length, 1);
  check('and it says what they cost', /own CLI process/.test(said[0]));
  running(6);
  checkEqual('but only the once', said.length, 1);
  running(1);
  running(5);
  checkEqual('it speaks up again after the crowd cleared', said.length, 2);
};
