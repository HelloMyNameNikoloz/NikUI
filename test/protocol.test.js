'use strict';
const fs = require('fs');
const path = require('path');
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { SessionHub } = require('../src/hub.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The protocol, written down. Every transport carries exactly this, and the
 * checks below fail if either side grows a message the other has never heard
 * of — which is how a phone client and the panel would quietly drift apart.
 */
const TO_HOST = [
  'ready', 'send', 'interrupt', 'permission', 'openFile', 'switch',
  'status', 'statusOpen', 'unqueue', 'clearQueue', 'promoteQueued', 'editQueued'
];

const TO_CLIENT = [
  'init', 'items', 'status', 'stats', 'meta', 'queue', 'reset',
  'statusReport', 'openStatus', 'editPrompt', 'focus'
];

function quietSession() {
  const s = new Session({ cwd: '/tmp' });
  s.start = function () { this.everStarted = true; };
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

module.exports = async function () {
  suite('the protocol is the same on both sides');

  // What the client sends, and what the hub is prepared to hear. Read off the
  // source rather than listed by hand, so a message added to one side and
  // forgotten on the other fails here instead of at a user.
  const client = read('media/panel.js');
  const hub = read('src/hub.js');

  const clientSends = new Set(
    [...client.matchAll(/vscode\.postMessage\(\s*\{\s*type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1])
  );
  const hubHears = new Set([...hub.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]));

  checkEqual('the client sends nothing the protocol does not list',
    [...clientSends].filter((t) => !TO_HOST.includes(t)).sort(), []);
  checkEqual('the hub hears nothing the protocol does not list',
    [...hubHears].filter((t) => !TO_HOST.includes(t)).sort(), []);
  checkEqual('and it hears every message the protocol lists',
    TO_HOST.filter((t) => !hubHears.has(t)), []);
  checkEqual('so every message the client sends is one the hub hears',
    [...clientSends].filter((t) => !hubHears.has(t)).sort(), []);

  // The client's inbound switch, not the whole file: it has switches of its own.
  const inbound = client.slice(client.indexOf("window.addEventListener('message'"));
  const dispatch = inbound.slice(0, inbound.indexOf('\n    }\n  });'));
  const clientHears = new Set([...dispatch.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]));
  const hubSends = new Set([...hub.matchAll(/type: '([a-zA-Z]+)'/g)].map((m) => m[1])
    .filter((t) => t !== 'user'));

  checkEqual('the hub sends nothing the protocol does not list',
    [...hubSends].filter((t) => !TO_CLIENT.includes(t)).sort(), []);
  checkEqual('the client draws nothing the protocol does not list',
    [...clientHears].filter((t) => !TO_CLIENT.includes(t)).sort(), []);
  checkEqual('and it draws every message the protocol lists',
    TO_CLIENT.filter((t) => !clientHears.has(t)), []);
  checkEqual('so every message the hub sends is one the client draws',
    [...hubSends].filter((t) => !clientHears.has(t)).sort(), []);

  suite('a transport carries all of it');

  // Any object with an id and a post is a transport. This one is a list.
  const session = quietSession();
  const carried = [];
  const hubUnderTest = new SessionHub(session, {
    config: () => ({ showThinking: true, promptSnippets: {} }),
    home: '/home',
    knownCommands: () => ['status'],
    fleet: () => [session],
    env: () => ({ vscode: 'test' }),
    openFile: (req) => carried.push({ host: 'openFile', req }),
    switchTo: (id) => carried.push({ host: 'switchTo', id })
  });

  const seen = [];
  hubUnderTest.attach({ id: 'anything', post: (m) => seen.push(m) });
  const say = (msg) => hubUnderTest.receive('anything', msg);
  const sawType = (type) => seen.some((m) => m.type === type);

  await say({ type: 'ready' });
  check('ready is answered with init', sawType('init'));

  await say({ type: 'send', text: 'hello', sent: 'hello', snippets: [] });
  check('a prompt reaches the session', session.items.some((i) => i.kind === 'user' && i.text === 'hello'));
  check('and the turn it starts is announced', sawType('status') && sawType('stats'));

  session._upsert({ id: 'p1', kind: 'permission', requestId: 'r1', name: 'Bash', input: {}, resolved: null });
  await say({ type: 'permission', requestId: 'r1', allow: true });
  checkEqual('a permission answer is recorded', session.items.find((i) => i.id === 'p1').resolved, 'allow');
  check('and the resolved prompt is redrawn', sawType('items'));

  await say({ type: 'interrupt' });
  await say({ type: 'status' });
  check('status is answered with a report', sawType('statusReport'));
  await say({ type: 'statusOpen', open: true });
  check('and the sheet state is taken', hubUnderTest.clients.get('anything').statusOpen === true);

  session.rename('renamed');
  check('a change of name reaches the client', sawType('meta'));

  session.enqueue('one');
  session.enqueue('two');
  check('the queue is announced', sawType('queue'));
  await say({ type: 'promoteQueued', id: session.queue[1].id });
  checkEqual('promoting reorders it', session.queue[0].text, 'two');
  await say({ type: 'editQueued', id: session.queue[0].id });
  check('reclaiming answers the asker', sawType('editPrompt'));
  await say({ type: 'unqueue', id: session.queue[0].id });
  await say({ type: 'clearQueue' });
  checkEqual('and the queue can be emptied', session.queue.length, 0);

  await say({ type: 'openFile', path: 'src/session.js', line: 12 });
  await say({ type: 'switch', id: 'other-instance' });
  checkEqual('editor-only work is handed to the host',
    carried.map((c) => c.host), ['openFile', 'switchTo']);
  checkEqual('with what it needs', carried[0].req.path, 'src/session.js');

  session.resetConversation();
  check('a reset is passed on', sawType('reset'));
  hubUnderTest.focusInput('anything');
  check('so is a nudge to the composer', sawType('focus'));
  hubUnderTest.openStatus('anything');
  check('and opening the sheet', sawType('openStatus'));

  checkEqual('so every message the host can send has been seen',
    TO_CLIENT.filter((t) => !sawType(t)), []);

  suite('a transport that misbehaves is survived');

  await say({ type: 'nonsense-from-the-future' });
  await say(null);
  await hubUnderTest.receive('nobody', { type: 'send', text: 'from a client that left' });
  check('unknown messages, empty ones and strangers change nothing', session.queue.length === 0);

  hubUnderTest.dispose();
  session.dispose();
};
