'use strict';
const { Awake, shouldHold } = require('../src/awake.js');

/** caffeinate, without a machine to keep awake. */
function fakeSpawn() {
  const calls = [];
  const spawned = [];
  const spawn = (command, args, options) => {
    const proc = {
      command, args, options, killed: false,
      handlers: {},
      on(event, fn) { this.handlers[event] = fn; return this; },
      kill() { this.killed = true; if (this.handlers.exit) this.handlers.exit(0); },
      unref() { this.unreffed = true; }
    };
    calls.push([command].concat(args).join(' '));
    spawned.push(proc);
    return proc;
  };
  return { spawn, calls, spawned };
}

module.exports = async function () {
  suite('holding the machine awake');

  const mac = fakeSpawn();
  const awake = new Awake({ spawn: mac.spawn, platform: 'darwin', pid: 4242 });

  checkEqual('nothing is held to begin with', awake.held, false);
  check('holding it works', awake.hold('1327 is working'));
  checkEqual('with the right assertion', mac.calls[0], 'caffeinate -i -s -w 4242');
  check('and it is now held', awake.held);
  checkEqual('for a reason it can say out loud', awake.state().reason, '1327 is working');
  check('since a time it can report', typeof awake.state().since === 'number');

  check('the screen is left alone', mac.calls[0].indexOf('-d') < 0);
  check('and it dies with this process rather than outliving it',
    /-w 4242$/.test(mac.calls[0]));

  awake.hold('something else is working');
  checkEqual('holding twice does not hold twice', mac.calls.length, 1);
  checkEqual('but the reason is kept current', awake.state().reason, 'something else is working');

  check('releasing works', awake.release());
  checkEqual('and kills what it started', mac.spawned[0].killed, true);
  checkEqual('leaving nothing held', awake.held, false);
  checkEqual('releasing again is a no-op', awake.release(), false);

  awake.hold('again');
  awake.dispose();
  checkEqual('disposing lets go too', awake.held, false);

  suite('when it cannot');

  const linux = new Awake({ spawn: fakeSpawn().spawn, platform: 'linux' });
  checkEqual('a platform with no way to do it says so', linux.supported, false);
  checkEqual('and refuses rather than pretending', linux.hold('x'), false);
  checkEqual('so nothing is ever held', linux.held, false);

  const broken = new Awake({
    platform: 'darwin',
    spawn: () => { throw new Error('caffeinate is not installed'); }
  });
  checkEqual('a machine without caffeinate is survived', broken.hold('x'), false);
  checkEqual('and nothing is left held', broken.held, false);

  const dies = fakeSpawn();
  const fragile = new Awake({ spawn: dies.spawn, platform: 'darwin' });
  fragile.hold('x');
  dies.spawned[0].handlers.exit(1);
  checkEqual('a helper that exits on its own leaves nothing pretending', fragile.held, false);

  suite('when it should be held at all');

  const idle = { label: 'a', isBusy: false, isRunning: true };
  const working = { label: '1327', isBusy: true, isRunning: true };
  const asleep = { label: 'b', isBusy: false, isRunning: false };

  checkEqual('never with the setting off',
    shouldHold({ enabled: false, sessions: [working], serving: true }).hold, false);
  checkEqual('an instance working is reason enough',
    shouldHold({ enabled: true, sessions: [working], serving: false }).hold, true);
  checkEqual('and the reason names it',
    shouldHold({ enabled: true, sessions: [working], serving: false }).reason, '1327 is working');
  checkEqual('several are counted, not listed',
    shouldHold({ enabled: true, sessions: [working, working], serving: false }).reason,
    '2 instances are working');

  checkEqual('an idle instance on its own is not worth a sleepless laptop',
    shouldHold({ enabled: true, sessions: [idle], serving: false }).hold, false);
  checkEqual('but an idle instance something can reach is',
    shouldHold({ enabled: true, sessions: [idle], serving: true }).hold, true);
  check('and says why',
    /running and reachable/.test(shouldHold({ enabled: true, sessions: [idle], serving: true }).reason));
  checkEqual('an instance that is not running keeps nothing awake',
    shouldHold({ enabled: true, sessions: [asleep], serving: true }).hold, false);
  checkEqual('nor does an empty window',
    shouldHold({ enabled: true, sessions: [], serving: true }).hold, false);
};
