'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { SessionHub, hubFor, closeHub, closeAllHubs, STATUS_REFRESH_MS } = require('../src/hub.js');

/** A client is anything with an id and a post: a webview, a socket, this. */
function viewer(id) {
  const got = [];
  return {
    id,
    got,
    post: (m) => got.push(m),
    ofType: (type) => got.filter((m) => m.type === type),
    last: (type) => got.filter((m) => m.type === type).pop()
  };
}

function quietSession(opts) {
  const s = new Session(Object.assign({ cwd: '/tmp' }, opts || {}));
  s.start = function () { this.everStarted = true; };
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

const host = (session, extra) => Object.assign({
  config: () => ({ showThinking: true, promptSnippets: { table: 'TABLE' }, fontSize: 13 }),
  home: '/home',
  knownCommands: () => ['status', 'effort'],
  fleet: () => [session],
  env: () => ({ vscode: 'test' })
}, extra || {});

module.exports = async function () {
  suite('a hub serves more than one client');

  const session = quietSession();
  const hub = new SessionHub(session, host(session));
  const laptop = viewer('laptop');
  const phone = viewer('phone');

  hub.attach(laptop);
  hub.attach(phone);
  checkEqual('both are attached', hub.size, 2);

  session._upsert({ id: 'x1', kind: 'notice', text: 'before anyone is ready' });
  checkEqual('nothing is sent to a client that has not loaded', laptop.got.length, 0);

  await hub.receive('laptop', { type: 'ready' });
  checkEqual('the one that says hello gets the whole picture', laptop.ofType('init').length, 1);
  checkEqual('and the other still gets nothing', phone.got.length, 0);

  await hub.receive('phone', { type: 'ready' });
  checkEqual('until it says hello too', phone.ofType('init').length, 1);
  checkEqual('and then it has the same conversation',
    phone.last('init').items.length, laptop.last('init').items.length);

  suite('what happens to one is told to all');

  laptop.got.length = 0;
  phone.got.length = 0;
  session._upsert({ id: 'x2', kind: 'notice', text: 'something happened' });
  await new Promise((r) => setTimeout(r, 80)); // the item flush is debounced

  check('both are told about the item', laptop.ofType('items').length === 1 && phone.ofType('items').length === 1);
  check('and both get the counters with it', laptop.ofType('stats').length >= 1 && phone.ofType('stats').length >= 1);

  session.enqueue('queued from somewhere');
  check('both see the queue', laptop.ofType('queue').length >= 1 && phone.ofType('queue').length >= 1);

  suite('but an answer goes back to whoever asked');

  laptop.got.length = 0;
  phone.got.length = 0;
  await hub.receive('laptop', { type: 'status' });
  checkEqual('a report goes to the one that asked for it', laptop.ofType('statusReport').length, 1);
  checkEqual('and nobody else', phone.ofType('statusReport').length, 0);

  await hub.receive('phone', { type: 'editQueued', id: session.queue[0].id });
  checkEqual('a reclaimed prompt comes back to that composer', phone.ofType('editPrompt').length, 1);
  checkEqual('not to the other one', laptop.ofType('editPrompt').length, 0);
  checkEqual('and it really left the queue', session.queue.length, 0);

  suite('the sheet is open per client, not per session');

  await hub.receive('laptop', { type: 'statusOpen', open: true });
  const seat = (id) => hub.clients.get(id);
  check('one client has it open', seat('laptop').statusOpen === true);
  check('the other does not', seat('phone').statusOpen === false);

  hub.refreshStatus();
  check('only the open one has a redraw pending', !!seat('laptop').statusTimer && !seat('phone').statusTimer);
  await new Promise((r) => setTimeout(r, STATUS_REFRESH_MS + 100));
  checkEqual('which arrives, once', laptop.ofType('statusReport').length, 2);
  checkEqual('and never reaches the client with no sheet', phone.ofType('statusReport').length, 0);

  suite('a client leaving does not take the session with it');

  hub.detach('laptop');
  checkEqual('one is left', hub.size, 1);
  phone.got.length = 0;
  session._upsert({ id: 'x3', kind: 'notice', text: 'still going' });
  await new Promise((r) => setTimeout(r, 80));
  check('and it is still being told things', phone.ofType('items').length >= 1);

  hub.detach('phone');
  checkEqual('with nobody watching, the hub is empty', hub.size, 0);
  session._upsert({ id: 'x4', kind: 'notice', text: 'nobody is listening' });
  check('and the session carries on regardless', session.items.some((i) => i.id === 'x4'));

  suite('a client that has gone away is not fatal');

  const broken = { id: 'broken', post: () => { throw new Error('socket is gone'); } };
  hub.attach(broken);
  await hub.receive('broken', { type: 'ready' });
  const alive = viewer('alive');
  hub.attach(alive);
  await hub.receive('alive', { type: 'ready' });
  session._upsert({ id: 'x5', kind: 'notice', text: 'after the break' });
  await new Promise((r) => setTimeout(r, 80));
  check('the working client still hears everything', alive.ofType('items').length >= 1);

  hub.dispose();
  checkEqual('disposing lets every client go', hub.size, 0);
  session.dispose();

  suite('one hub per session, however many transports ask');

  const shared = quietSession();
  const first = hubFor(shared, host(shared));
  const second = hubFor(shared, host(shared));
  check('the second asker joins the first', first === second);
  first.attach(viewer('a'));
  second.attach(viewer('b'));
  checkEqual('so both clients are on the same hub', first.size, 2);
  check('closing it is announced once', closeHub(shared.id) === true);
  check('and again is a no-op', closeHub(shared.id) === false);
  closeAllHubs();
  shared.dispose();
};
