'use strict';
const { install, fakeContext } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { SessionPanel } = require('../src/panel.js');
const { lookFor, UNREAD, DONE_FADES_AFTER_MS } = require('../src/tree.js');
const { SessionHub } = require('../src/hub.js');

module.exports = async function () {
  suite('a finished instance nobody has opened');

  {
    const s = new Session({ cwd: '/p/a' });
    s._setStatus('working');
    s._setStatus('done');
    check('finishing a turn makes it unread', s.unread);
    checkEqual('in blue', lookFor(s).color, UNREAD.color);
    s.finishedAt = Date.now() - DONE_FADES_AFTER_MS - 1000;
    checkEqual('which does not fade like green does', lookFor(s).color, UNREAD.color);
    const told = [];
    s.on('unread', (v) => told.push(v));
    s.setUnread(false);
    s.setUnread(false);
    checkEqual('reading it says so, once', told, [false]);
    check('and it is green again, or faded', lookFor(s).color !== UNREAD.color);
    s._setStatus('working');
    s._setStatus('done');
    check('the next finish marks it again', s.unread);
    s._setStatus('working');
    check('working again is not unread', !s.unread);
  }

  {
    const s = new Session({ cwd: '/p/a' });
    s._setStatus('idle');
    s._setStatus('done');
    check('only a turn finishing counts, not a restored status', !s.unread);
    check('a restored unread one is still unread', new Session({ cwd: '/p/a', unread: true }).unread);
  }

  {
    const context = fakeContext();
    const s = new Session({ cwd: '/p/b' });
    s.start = function () { this.status = 'idle'; };
    const manager = { list: [s], get: (id) => (id === s.id ? s : null), focus() {}, knownCommands: () => [] };
    const panel = SessionPanel.show(s, context, manager);
    panel.panel.visible = false;
    s._setStatus('working');
    s._setStatus('done');
    check('finished in a tab that is not in view: unread', s.unread);
    check('and the tab says so in blue', panel.panel.title.startsWith('🔵'));
    check('with the blue dot for an icon', String(panel.panel.iconPath.light.path || panel.panel.iconPath.light).includes('unread.svg'));
    panel.panel.visible = true;
    panel.markSeen();
    check('brought into view, it is read', !s.unread);
    check('and the tab is green again', panel.panel.title.startsWith('🟢'));
    s._setStatus('working');
    s._setStatus('done');
    check('finishing in front of you is seen finishing', !s.unread);
    panel.dispose();
  }

  suite('a phone looking at it has seen it');
  {
    const s = new Session({ cwd: '/p/d' });
    s.start = function () { this.status = 'idle'; };
    s.items.push({ id: 'u1', kind: 'user', text: 'hi', at: Date.now() });
    const hub = new SessionHub(s, { config: () => ({}), knownCommands: () => [] });
    const sent = [];
    const phone = { kind: 'device', id: 'p1', name: 'Phone', control: true };
    hub.attach({ id: 'panel', post: () => {} });
    await hub.receive('panel', { type: 'ready' });
    s._setStatus('working');
    s._setStatus('done');
    check('the editor panel alone does not count as a phone', s.unread);
    hub.attach({ id: 'ph', device: phone, post: (m) => sent.push(m) });
    await hub.receive('ph', { type: 'ready' });
    check('opened on the phone: read', !s.unread);
    s._setStatus('working');
    s._setStatus('done');
    check('on the phone\'s screen as it finishes: read', !s.unread);
    await hub.receive('ph', { type: 'visible', on: false });
    s._setStatus('working');
    s._setStatus('done');
    check('in a pocket as it finishes: still unread', s.unread);
    await hub.receive('ph', { type: 'visible', on: true });
    check('brought back to the front: read', !s.unread);
    hub.detach('ph');
    s._setStatus('working');
    s._setStatus('done');
    hub.attach({ id: 'ph2', device: phone, post: () => {} });
    await hub.receive('ph2', { type: 'ready', hidden: true });
    check('a page that opens behind something has not been seen', s.unread);
    hub.dispose && hub.dispose();
  }

  suite('a reload brings back the colours it had');
  for (const [was, now] of [['done', 'done'], ['stopped', 'idle'], ['error', 'idle']]) {
    const s = new Session({ cwd: '/tmp', claudePath: '/bin/cat', status: was });
    s.status = was;
    s.start();
    checkEqual(`${was}, and its process starts: ${now}`, s.status, now);
    s.stop();
  }

  suite('NikUI’s commands come first in the palette');
  {
    const s = new Session({ cwd: '/p/c' });
    s.meta = Object.assign({}, s.meta, { slashCommands: Array.from({ length: 60 }, (_, i) => 'cli' + i).concat(['status']) });
    const hub = new SessionHub(s, { config: () => ({}), knownCommands: () => [] });
    const list = hub.commandList();
    checkEqual('status, settings, commands, slack and watch lead', list.slice(0, 5), ['status', 'settings', 'commands', 'slack', 'watch']);
    checkEqual('and nothing is listed twice', list.filter((c) => c === 'status').length, 1);
    hub.dispose && hub.dispose();
  }
};
