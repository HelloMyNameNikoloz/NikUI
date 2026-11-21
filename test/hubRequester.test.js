'use strict';
// Every editor action carries who asked for it, taken when the request arrives:
// with one engine and many clients, "the window" is no longer an answer.
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { SessionHub } = require('../src/hub.js');

function viewer(id, extra) {
  const got = [];
  return Object.assign({ id, got, post: (m) => got.push(m), ofType: (t) => got.filter((m) => m.type === t) }, extra || {});
}

function quietSession() {
  const s = new Session({ cwd: '/work' });
  s.start = function () { this.everStarted = true; };
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

module.exports = async function () {
  suite('editor actions say who asked');

  const session = quietSession();
  const calls = [];
  const host = {
    config: () => ({ promptSnippets: {} }),
    home: '/home',
    knownCommands: () => [],
    fleet: () => [session],
    env: () => ({}),
    openFile: async (req, from) => { calls.push(['openFile', req, from]); },
    runInTerminal: async (req, from) => { calls.push(['runInTerminal', req, from]); },
    switchTo: (id, at, from) => { calls.push(['switchTo', id, from]); }
  };
  const hub = new SessionHub(session, host);
  const editor = viewer('panel-1', { editor: 'window-A' });
  const phone = viewer('sock-9', { device: { id: 'phone-1', kind: 'device', control: true } });
  hub.attach(editor);
  hub.attach(phone);
  await hub.receive('panel-1', { type: 'ready' });
  await hub.receive('sock-9', { type: 'ready' });

  await hub.receive('panel-1', { type: 'openFile', path: 'src/a.js', line: 7 });
  const opened = calls.find((c) => c[0] === 'openFile');
  checkEqual('the file and its line are passed on as before', opened && [opened[1].path, opened[1].line, opened[1].cwd], ['src/a.js', 7, '/work']);
  checkEqual('with the editor window that asked', opened && opened[2], { client: 'panel-1', device: null, local: true, editor: 'window-A' });

  await hub.receive('sock-9', { type: 'runInTerminal', command: 'ls' });
  const typed = calls.find((c) => c[0] === 'runInTerminal');
  checkEqual('a phone asking is named as the phone', typed && typed[2], { client: 'sock-9', device: 'phone-1', local: false, editor: null });
  check('and what the host is given cannot be changed by it', typed && Object.isFrozen(typed[2]));

  suite('a fork goes to whoever asked for it, not whoever spoke last');

  Object.defineProperty(session, 'provider', { value: 'codex', configurable: true });
  let release;
  const landed = new Promise((r) => { release = r; });
  session.submit = function (text, attachments, opts) {
    if (/^\/fork/.test(text)) setTimeout(() => { session.emit('open', 'cx-forked', opts && opts.from); release(); }, 10);
  };
  await hub.receive('sock-9', { type: 'send', text: '/fork' });
  // The editor says something before the fork lands.
  await hub.receive('panel-1', { type: 'send', text: 'meanwhile' });
  await landed;
  checkEqual('the phone that asked is the one sent there', phone.ofType('@navigate').map((m) => m.session), ['cx-forked']);
  check('and the editor is left where it was', !calls.some((c) => c[0] === 'switchTo'));

  const fromEditor = new Promise((r) => { release = r; });
  await hub.receive('panel-1', { type: 'send', text: '/fork' });
  await fromEditor;
  const switched = calls.find((c) => c[0] === 'switchTo');
  checkEqual('a fork the editor asked for opens in that editor window', switched && [switched[1], switched[2] && switched[2].editor], ['cx-forked', 'window-A']);
};
