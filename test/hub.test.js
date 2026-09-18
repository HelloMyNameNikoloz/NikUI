'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { SessionHub, hubFor, closeHub, closeAllHubs, STATUS_REFRESH_MS, STATS_MIN_MS } = require('../src/hub.js');

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
  await new Promise((r) => setTimeout(r, 300)); // the item flush is debounced

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
  await new Promise((r) => setTimeout(r, 300));
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
  await new Promise((r) => setTimeout(r, 300));
  check('the working client still hears everything', alive.ofType('items').length >= 1);

  hub.dispose();
  checkEqual('disposing lets every client go', hub.size, 0);
  session.dispose();

  suite('watching is not starting');

  // Not quietSession(): this one has to look stopped, which is the whole case.
  const sleeping = new Session({ cwd: '/tmp' });
  let started = 0;
  sleeping.start = function () { started++; this.everStarted = true; };
  sleeping._write = function () {};
  const guarded = new SessionHub(sleeping, host(sleeping));

  const onlooker = viewer('onlooker');
  guarded.attach({ id: onlooker.id, post: onlooker.post, device: { id: 'd0', name: 'A phone', kind: 'device', control: false } });
  await guarded.receive('onlooker', { type: 'ready' });
  checkEqual('a device that may only watch does not spawn a process', started, 0);
  check('but it still sees the conversation', !!onlooker.last('init'));

  const steerer = viewer('steerer');
  guarded.attach({ id: steerer.id, post: steerer.post, device: { id: 'd1', name: 'A trusted phone', kind: 'device', control: true } });
  await guarded.receive('steerer', { type: 'ready' });
  checkEqual('a device that may steer does', started, 1);

  guarded.dispose();
  sleeping.dispose();

  suite('settings reach a page that is already open');

  const settings = { showThinking: true, fontSize: 13, promptSnippets: {} };
  const live2 = quietSession();
  const hubWithSettings = new SessionHub(live2, host(live2, { config: () => settings }));
  const reader = viewer('reader');
  hubWithSettings.attach(reader);
  await hubWithSettings.receive('reader', { type: 'ready' });
  checkEqual('the first message carries them', reader.last('init').fontSize, 13);

  settings.fontSize = 18;
  settings.showThinking = false;
  hubWithSettings.broadcast(hubWithSettings.metaMessage());
  checkEqual('and so does a later one, so nothing waits for a reload',
    [reader.last('meta').fontSize, reader.last('meta').showThinking], [18, false]);
  hubWithSettings.dispose();
  live2.dispose();

  suite('the running totals are a summary, not a stream');

  const streaming = quietSession();
  const throttled = new SessionHub(streaming, host(streaming));
  const counting = viewer('counting');
  throttled.attach(counting);
  await throttled.receive('counting', { type: 'ready' });
  for (let i = 0; i < 12; i++) throttled.broadcastStats();
  checkEqual('a burst of changes is one message, not twelve',
    counting.ofType('stats').length, 1);
  await new Promise((r) => setTimeout(r, STATS_MIN_MS + 80));
  check('and the last word still goes out', counting.ofType('stats').length >= 2);
  throttled.dispose();
  streaming.dispose();

  suite('a client that has just loaded has no sheet open');

  const returning = quietSession();
  const backAgain = new SessionHub(returning, host(returning));
  const tab = viewer('tab');
  backAgain.attach(tab);
  await backAgain.receive('tab', { type: 'ready' });
  await backAgain.receive('tab', { type: 'statusOpen', open: true });
  checkEqual('the host knows the sheet is open', backAgain.clients.get('tab').statusOpen, true);

  // VS Code throws a hidden webview away and rebuilds it; the same client id
  // says hello again with a fresh, empty DOM.
  await backAgain.receive('tab', { type: 'ready' });
  checkEqual('coming back, the host believes the fresh page, not the old one',
    backAgain.clients.get('tab').statusOpen, false);
  backAgain.refreshStatus();
  checkEqual('so nothing opens the dashboard by itself',
    backAgain.clients.get('tab').statusTimer, null);
  backAgain.dispose();
  returning.dispose();

  suite('two live views of one instance');

  const shared2 = quietSession();
  const switched = [];
  const both = new SessionHub(shared2, host(shared2, { switchTo: (id) => switched.push(id) }));

  const desk = viewer('desk');
  const handset = viewer('handset');
  both.attach(desk);
  both.attach({ id: handset.id, post: handset.post, device: { id: 'd1', name: 'A phone', kind: 'device', control: true } });
  await both.receive('desk', { type: 'ready' });
  await both.receive('handset', { type: 'ready' });

  const seen = desk.last('presence');
  checkEqual('each client is told who else is attached', seen.clients.length, 2);
  checkEqual('the editor is named as itself',
    seen.clients.find((c) => c.kind === 'editor').name, 'This editor');
  checkEqual('and the device by its own name',
    seen.clients.find((c) => c.kind === 'device').name, 'A phone');
  check('with its own row identifiable', desk.last('init').client === 'desk');

  await both.receive('handset', { type: 'send', text: 'from the phone', sent: 'from the phone', snippets: [] });
  await both.receive('desk', { type: 'send', text: 'from the editor', sent: 'from the editor', snippets: [] });
  // Items are flushed on a tick rather than per keystroke, so the assertion
  // waits for the same flush a client would.
  await new Promise((r) => setTimeout(r, 300));
  const onPhone = JSON.stringify(handset.ofType('items').concat(handset.ofType('queue')));
  const onEditor = JSON.stringify(desk.ofType('items').concat(desk.ofType('queue')));
  check('a prompt sent from either appears on both',
    onPhone.indexOf('from the phone') > 0 && onEditor.indexOf('from the phone') > 0 &&
    onPhone.indexOf('from the editor') > 0 && onEditor.indexOf('from the editor') > 0);

  // A draft is not in the protocol at all, in either direction: the only way to
  // clobber one would be to send it somewhere, and nothing does.
  const everything = JSON.stringify(desk.got.concat(handset.got));
  check('and nothing anywhere carries a draft', everything.indexOf('draft') < 0);

  shared2._upsert({ id: 'p9', kind: 'permission', requestId: 'r9', name: 'Bash', input: {}, resolved: null });
  await both.receive('handset', { type: 'permission', requestId: 'r9', allow: true });
  checkEqual('a permission answered on one is answered for the instance',
    shared2.items.find((i) => i.id === 'p9').resolved, 'allow');
  check('and both are shown the answer',
    JSON.stringify(desk.ofType('items')).indexOf('"resolved":"allow"') > 0 &&
    JSON.stringify(handset.ofType('items')).indexOf('"resolved":"allow"') > 0);

  await both.receive('handset', { type: 'switch', id: 'another-one' });
  checkEqual('a device choosing another instance moves only itself',
    handset.last('@navigate').session, 'another-one');
  checkEqual('and does not rearrange the editor', switched, []);
  await both.receive('desk', { type: 'switch', id: 'another-one' });
  checkEqual('while the editor still opens a tab', switched, ['another-one']);

  both.detach('desk');
  const afterwards = handset.last('presence');
  checkEqual('when one leaves, the other is told', afterwards.clients.length, 1);
  checkEqual('and it is the one still there', afterwards.clients[0].kind, 'device');
  await both.receive('handset', { type: 'send', text: 'still working', sent: 'still working', snippets: [] });
  check('a closed panel leaves the handset working',
    shared2.items.some((i) => i.text === 'still working') ||
    shared2.queue.some((q) => q.text === 'still working'));

  both.dispose();
  shared2.dispose();

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
