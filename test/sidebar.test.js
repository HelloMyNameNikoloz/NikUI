'use strict';
const { install, fakeContext } = require('./helpers/vscode-stub.js');

const stub = install();
const extension = require('../src/extension.js');
const { Session } = require('../src/session.js');
const { SessionPanel } = require('../src/panel.js');

module.exports = async function () {
  suite('starting an instance inside a folder');

  extension.activate(fakeContext());
  const tree = stub.__registered.treeViews['nikui.sessions'].provider;
  const manager = tree.manager;
  const folders = tree.folders;
  const run = stub.__registered.commands;

  // Nothing here may spawn a CLI.
  const realStart = Session.prototype.start;
  Session.prototype.start = function () { this.everStarted = true; };

  let offered = null;
  let pick = null;
  stub.window.showQuickPick = async (items) => { offered = items; return pick; };

  const folder = folders.create('Review queue');
  pick = { path: '/Users/nikoloz/Codes/Peuka' };
  await run['nikui.newSessionInFolder']({ __folder: true, id: folder.id });

  const made = manager.list[manager.list.length - 1];
  check('an instance was started', !!made);
  checkEqual('it runs where the picker said', made.cwd, '/Users/nikoloz/Codes/Peuka');
  check('and it lands in the folder it was started from',
    (folders.folderOf(made.id) || {}).id === folder.id);

  await run['nikui.newSessionInFolder']({ __folder: true, id: 'gone' });
  checkEqual('a folder that no longer exists starts nothing', manager.list.length, 1);

  suite('the folder picker asks one question');

  const rows = offered.filter((i) => i.kind === undefined);
  check('it offers the workspace folder', rows.some((i) => i.path === '/Users/nikoloz/Codes/Peuka'));
  check('it never offers to resume a conversation', rows.every((i) => !i.resume));
  check('every row it offers is a folder', rows.every((i) => i.path || i.browse));
  check('and it can still browse anywhere', rows.some((i) => i.browse));
  check('the list is grouped, not a flat pile',
    offered.some((i) => i.kind !== undefined && /workspace/i.test(i.label)));

  suite('moving between instances from the keyboard');

  const a = made;
  const b = manager.create({ cwd: '/Users/nikoloz/Codes/NikUI', autoStart: false });
  const c = manager.create({ cwd: '/tmp', autoStart: false });

  await run['nikui.open'](a.id);
  checkEqual('opening one makes it the active instance', manager.active.id, a.id);

  await run['nikui.nextInstance']();
  checkEqual('next moves along the list', manager.active.id, b.id);
  await run['nikui.nextInstance']();
  checkEqual('and again', manager.active.id, c.id);
  await run['nikui.nextInstance']();
  checkEqual('and wraps around at the end', manager.active.id, a.id);

  await run['nikui.previousInstance']();
  checkEqual('previous wraps the other way', manager.active.id, c.id);
  await run['nikui.previousInstance']();
  checkEqual('and walks back', manager.active.id, b.id);

  for (const s of manager.list) SessionPanel.close(s.id);
  manager.disposeAll();
  Session.prototype.start = realStart;
};
