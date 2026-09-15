'use strict';
const { install, fakeContext, memoryState } = require('./helpers/vscode-stub.js');

const stub = install();
const extension = require('../src/extension.js');

// Instances as the previous window would have left them: a conversation each,
// no process, never opened since.
const SAVED = [
  { id: 'old1', cwd: '/Users/nikoloz/Codes/Peuka', customTitle: 'Review queue', autoLabel: null, ticket: null,
    claudeSessionId: 'aaaa-1111', totalCost: 1.5, usage: { input: 1, output: 2, cacheRead: 3, cacheCreate: 0 } },
  { id: 'old2', cwd: '/Users/nikoloz/Codes/NikUI', customTitle: null, autoLabel: null, ticket: '1327',
    claudeSessionId: 'bbbb-2222', totalCost: 0.25, usage: { input: 1, output: 2, cacheRead: 3, cacheCreate: 0 } }
];

module.exports = async function () {
  suite('destructive actions');

  const workspaceState = memoryState();
  workspaceState.update('nikui.sessions.v1', SAVED);
  extension.activate(fakeContext({ workspaceState }));

  const manager = stub.__registered.treeViews['nikui.sessions'].provider.manager;
  const run = stub.__registered.commands;

  // Every confirmation goes through here, so a test can both see it and answer.
  const asked = [];
  let answer;
  stub.window.showWarningMessage = async (message, options, ...actions) => {
    asked.push({ message, detail: options && options.detail, actions });
    return answer;
  };

  checkEqual('a reload brings the instances back', manager.list.map((s) => s.id).sort(), ['old1', 'old2']);

  // ---- the button that used to wipe the sidebar ---------------------------

  await run['nikui.clearStopped']();
  checkEqual('clearing right after a reload removes nothing', manager.list.length, 2);
  checkEqual('and it does not even ask, because there is nothing to clear', asked.length, 0);

  // One of them ran and its process has since exited.
  manager.get('old1').everStarted = true;
  answer = undefined; // the user dismisses the dialog
  await run['nikui.clearStopped']();
  checkEqual('a real stopped instance is asked about', asked.length, 1);
  check('the dialog names it', /Review queue/.test(asked[0].detail || ''));
  check('the dialog says the conversation survives', /History/.test(asked[0].detail || ''));
  checkEqual('dismissing the dialog removes nothing', manager.list.length, 2);

  answer = 'Remove';
  await run['nikui.clearStopped']();
  checkEqual('confirming removes only the stopped one', manager.list.map((s) => s.id), ['old2']);

  // ---- the × on a row -----------------------------------------------------

  asked.length = 0;
  answer = undefined;
  await run['nikui.stop']('old2');
  checkEqual('closing an instance with a conversation asks first', asked.length, 1);
  check('and says where the conversation goes', /History/.test(asked[0].detail || ''));
  checkEqual('dismissing keeps the instance', manager.list.length, 1);

  answer = 'Close instance';
  await run['nikui.stop']('old2');
  checkEqual('confirming closes it', manager.list.length, 0);

  // An instance with nothing in it is not worth a dialog.
  asked.length = 0;
  const fresh = manager.create({ cwd: '/tmp', autoStart: false });
  await run['nikui.stop'](fresh.id);
  checkEqual('an empty instance closes without a dialog', asked.length, 0);
  checkEqual('and is gone', manager.list.length, 0);

  // ---- folders and transcripts --------------------------------------------

  asked.length = 0;
  const folders = stub.__registered.treeViews['nikui.sessions'].provider.folders;
  const empty = folders.create('Empty shelf');
  await run['nikui.deleteFolder']({ __folder: true, id: empty.id });
  checkEqual('deleting an empty folder does not ask', asked.length, 0);
  check('and it is gone', !folders.get(empty.id));

  const full = folders.create('Review queue');
  const filed = manager.create({ cwd: '/tmp', autoStart: false });
  folders.place(filed.id, full.id);
  answer = undefined;
  await run['nikui.deleteFolder']({ __folder: true, id: full.id });
  checkEqual('deleting a folder with instances in it asks', asked.length, 1);
  check('and says what happens to them', /move back to the top level/.test(asked[0].detail || ''));
  check('dismissing keeps the folder', !!folders.get(full.id));
  answer = 'Delete folder';
  await run['nikui.deleteFolder']({ __folder: true, id: full.id });
  check('confirming removes the folder', !folders.get(full.id));
  check('but never the instance that was in it', manager.list.some((s) => s.id === filed.id));

  // A refusal is a plain warning; a confirmation carries buttons.
  const confirmations = () => asked.filter((a) => a.actions.length > 0);

  asked.length = 0;
  await run['nikui.deleteHistory']({ sessionId: 'x', label: 'x', file: '/etc/passwd' });
  checkEqual('a transcript command will not offer to delete anything else', confirmations().length, 0);
  check('it says why', /not a transcript/.test(asked[0].message || ''));

  const openOne = manager.create({ cwd: '/tmp', autoStart: false });
  openOne.claudeSessionId = 'sess-open';
  await run['nikui.deleteHistory']({
    sessionId: 'sess-open', label: 'open one',
    file: require('path').join(require('../src/history.js').projectsRoot(), 'p', 'sess-open.jsonl')
  });
  checkEqual('nor the transcript of a conversation that is open', confirmations().length, 0);
  check('and it says which instance has it', /still open on that conversation/.test((asked[1] || {}).message || ''));
  manager.remove(openOne.id);
  manager.remove(filed.id);

  // ---- stopping the process without losing the instance -------------------

  const kept = manager.create({ cwd: '/tmp', autoStart: false });
  let stopped = false;
  kept.stop = function () { stopped = true; };
  Object.defineProperty(kept, 'isRunning', { get: () => !stopped });

  await run['nikui.sleep'](kept.id);
  check('sleeping stops the process', stopped);
  checkEqual('but keeps the instance in the list', manager.list.map((s) => s.id), [kept.id]);

  manager.disposeAll();
};
