'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { EventEmitter } = require('events');
const { Session } = require('../src/session.js');
const { SessionHub } = require('../src/hub.js');
const { PrLinks } = require('../src/prlink.js');

function viewer(id, device) {
  const got = [];
  return { id, device, got, post: (m) => got.push(m), last: (type) => got.filter((m) => m.type === type).pop(),
    ofType: (type) => got.filter((m) => m.type === type) };
}

function quietSession(opts) {
  const s = new Session(Object.assign({ cwd: '/tmp' }, opts || {}));
  s.start = function () {};
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

/** Stands in for PrFeed: remembers what it was told, answers from a script. */
function fakeFeed() {
  const feed = new EventEmitter();
  feed.watched = new Map();
  feed.calls = [];
  feed.known = new Map();
  feed.watch = (key, opts) => feed.watched.set(key, opts);
  feed.unwatch = (key) => feed.watched.delete(key);
  feed.get = (url) => feed.known.get(url) || null;
  feed.refresh = (url) => feed.calls.push(['refresh', url]);
  feed.diff = async (url) => { feed.calls.push(['diff', url]); return { ok: true, diff: 'diff --git a/x b/x', truncated: false }; };
  feed.reply = async (url, id, body) => { feed.calls.push(['reply', id, body]); return { ok: true, message: 'Replied.' }; };
  feed.resolve = async (url, id, on) => { feed.calls.push(['resolve', id, on]); return { ok: true, message: '' }; };
  feed.comment = async (url, body) => { feed.calls.push(['comment', body]); return { ok: true, message: '' }; };
  feed.rerunFailed = async (url) => { feed.calls.push(['rerun', url]); return { ok: false, message: 'nope' }; };
  feed.failedLog = async (url, runId) => { feed.calls.push(['log', runId]); return { ok: true, log: 'Error: boom' }; };
  return feed;
}

const URL = 'https://github.com/o/r/pull/7';
const SNAP = {
  url: URL, number: 7, repo: 'o/r', title: 'Fix', checks: [{ name: 'test', status: 'fail', runId: 99, url: 'https://github.com/o/r/actions/runs/99' }],
  checkSummary: { total: 1, pass: 0, fail: 1, pending: 0 },
  threads: [{ id: 'T1', resolved: false, path: 'a.js', line: 3, diffHunk: '@@ -1 +1 @@\n-a\n+b', comments: [{ author: 'rev', body: 'Rename this' }] }],
  comments: [], files: [], reviewers: [], reviews: []
};

module.exports = async function () {
  suite('the GitHub pane, through the hub');

  const session = quietSession();
  const feed = fakeFeed();
  const opened = [];
  const pinned = [];
  const hub = new SessionHub(session, {
    config: () => ({}), home: '/home', knownCommands: () => [], fleet: () => [session], env: () => ({}),
    prFeed: feed, openUrl: async (u) => opened.push(u), setPr: (s, u) => pinned.push(u), pickPr: async () => pinned.push('picked')
  });
  const laptop = viewer('laptop');
  hub.attach(laptop);
  await hub.receive('laptop', { type: 'ready' });

  checkEqual('the pane starts closed', laptop.last('init').meta.prPane.open, false);
  checkEqual('no PR, nothing watched', feed.watched.size, 0);

  session.prUrl = URL;
  session.emit('meta');
  checkEqual('a PR is watched, quietly while the pane is closed', feed.watched.get(session.id).active, false);
  checkEqual('with the instance folder to run gh in', feed.watched.get(session.id).cwd, '/tmp');

  await hub.receive('laptop', { type: 'pr:pane', open: true, tab: 'checks', width: 500 });
  checkEqual('opening it makes the watch active', feed.watched.get(session.id).active, true);
  checkEqual('and is remembered on the instance', JSON.stringify(session.prPane), JSON.stringify({ open: true, tab: 'checks', width: 500, full: false }));
  checkEqual('and told to every client in meta', laptop.last('meta').meta.prPane.tab, 'checks');

  await hub.receive('laptop', { type: 'pr:pane', open: true, tab: 'comments', width: 500, full: true });
  checkEqual('the old tab names still land', session.prPane.tab, 'threads');
  checkEqual('and full width is remembered', session.prPane.full, true);
  await hub.receive('laptop', { type: 'pr:pane', open: true, tab: 'checks', width: 500 });
  checkEqual('a message without it keeps it', session.prPane.full, true);
  await hub.receive('laptop', { type: 'pr:pane', open: true, tab: 'nonsense', width: 'wide' });
  checkEqual('an unknown tab keeps the last one', session.prPane.tab, 'checks');
  checkEqual('and a bad width keeps the last one', session.prPane.width, 500);

  await hub.receive('laptop', { type: 'visible', on: false });
  checkEqual('a hidden tab stops the fast polling', feed.watched.get(session.id).active, false);
  await hub.receive('laptop', { type: 'visible', on: true });
  checkEqual('and coming back starts it again', feed.watched.get(session.id).active, true);

  feed.known.set(URL, { prUrl: URL, state: SNAP, loading: false, error: null });
  feed.emit('state', URL, feed.known.get(URL));
  checkEqual('state for this PR is sent on', laptop.last('pr:state').state.number, 7);
  const before = laptop.ofType('pr:state').length;
  feed.emit('state', 'https://github.com/o/r/pull/8', { state: SNAP });
  checkEqual('state for another PR is not', laptop.ofType('pr:state').length, before);

  const late = viewer('late');
  hub.attach(late);
  await hub.receive('late', { type: 'ready' });
  checkEqual('a client arriving later gets the last state at once', late.last('pr:state').state.number, 7);

  await hub.receive('laptop', { type: 'pr:refresh' });
  checkEqual('refresh asks the feed', feed.calls.some((c) => c[0] === 'refresh'), true);
  await hub.receive('laptop', { type: 'pr:diff' });
  checkEqual('the diff goes back to the one who asked', laptop.last('pr:diff').diff, 'diff --git a/x b/x');
  checkEqual('and only to them', late.ofType('pr:diff').length, 0);

  await hub.receive('laptop', { type: 'pr:reply', threadId: 'T1', body: 'done' });
  checkEqual('a reply goes to the feed', JSON.stringify(feed.calls.find((c) => c[0] === 'reply')), JSON.stringify(['reply', 'T1', 'done']));
  checkEqual('and says it went', laptop.last('pr:done').ok, true);
  await hub.receive('laptop', { type: 'pr:rerun' });
  checkEqual('a failure is reported back', laptop.last('pr:done').message, 'nope');
  checkEqual('naming the action', laptop.last('pr:done').action, 'rerun');

  await hub.receive('laptop', { type: 'pr:askThread', threadId: 'T1' });
  const asked = laptop.last('editPrompt');
  check('Ask Claude puts the comment in the composer', asked && /Rename this/.test(asked.text) && /a\.js/.test(asked.text));
  await hub.receive('laptop', { type: 'pr:askCheck', runId: 99, name: 'test' });
  check('and a failing check brings its log', /Error: boom/.test(laptop.last('editPrompt').text));
  checkEqual('which it fetched for that run', JSON.stringify(feed.calls.find((c) => c[0] === 'log')), JSON.stringify(['log', 99]));

  await hub.receive('laptop', { type: 'pr:open', url: 'https://github.com/o/r/pull/7/files' });
  await hub.receive('laptop', { type: 'pr:open', url: 'https://evil.example/' });
  checkEqual('only github.com is opened', JSON.stringify(opened), JSON.stringify(['https://github.com/o/r/pull/7/files']));

  await hub.receive('laptop', { type: 'pr:link' });
  checkEqual('linking opens the picker on the laptop', pinned[0], 'picked');

  suite('a watch-only phone and the GitHub pane');
  const phone = viewer('phone', { id: 'd1', name: 'Phone', kind: 'phone', control: false });
  hub.attach(phone, { device: { id: 'd1', name: 'Phone', kind: 'phone', control: false } });
  await hub.receive('phone', { type: 'ready' });
  const calls = feed.calls.length;
  await hub.receive('phone', { type: 'pr:comment', body: 'hi' });
  checkEqual('cannot write to the PR', feed.calls.length, calls);

  suite('a phone reading the PR on its own screen');
  await hub.receive('laptop', { type: 'pr:pane', open: false });
  checkEqual('with the laptop pane closed, nothing is polled fast', feed.watched.get(session.id).active, false);
  await hub.receive('phone', { type: 'pr:watch', on: true });
  checkEqual('a phone looking keeps it fresh, watch-only or not', feed.watched.get(session.id).active, true);
  checkEqual('without opening the pane for everybody', session.prPane.open, false);
  await hub.receive('phone', { type: 'visible', on: false });
  checkEqual('a phone in a pocket does not', feed.watched.get(session.id).active, false);
  await hub.receive('phone', { type: 'visible', on: true });
  await hub.receive('phone', { type: 'pr:watch', on: false });
  checkEqual('and closing it there stops it', feed.watched.get(session.id).active, false);

  hub.dispose();
  checkEqual('closing the hub stops watching', feed.watched.size, 0);

  suite('a PR picked by hand stays picked');
  const links = new PrLinks({ run: async () => ({ ok: true, stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/1' }) }) });
  const s2 = quietSession();
  links.pin(s2, URL);
  checkEqual('pinned', s2.prPinned, true);
  await links.link(s2);
  checkEqual('detection does not replace it', s2.prUrl, URL);
  await links.pin(s2, null);
  checkEqual('unpinning goes back to detection', s2.prPinned, false);
};
