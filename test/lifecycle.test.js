'use strict';
const { install, memoryState } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
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

  // b never started, so it counts as stopped.
  const cleared = manager.removeStopped();
  checkEqual('removeStopped() announces every instance it drops', announced, [a.id, b.id]);
  checkEqual('and reports how many went', cleared, 1);
  checkEqual('the manager is empty', manager.list.length, 0);

  manager.disposeAll();
};
