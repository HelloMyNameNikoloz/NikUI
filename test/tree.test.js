'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const { install, memoryState } = require('./helpers/vscode-stub.js');

const stub = install();
const { SessionTree, projectRoot, describe: describeRow, lookFor, ASLEEP, MIME, DONE_FADES_AFTER_MS } = require('../src/tree.js');
const { FolderStore } = require('../src/folders.js');

const instance = (id, cwd, label, busy) => ({
  id, cwd, label, status: busy ? 'working' : 'idle', isBusy: !!busy,
  totalCost: 0.5, ticket: null, meta: {}, claudeSessionId: null, lastError: null
});

module.exports = async function () {
  suite('project grouping');

  const sessions = [
    instance('s1', '/Users/nikoloz/Codes/Peuka', 'alpha'),
    instance('s2', '/Users/nikoloz/Codes/Peuka/backend', 'beta', true),
    instance('s3', '/Users/nikoloz/Codes/Peuka/backend/.claude/worktrees/692-phase3a', 'gamma'),
    instance('s4', '/Users/nikoloz/Codes/NikUI', 'delta'),
    instance('s5', '/tmp', 'epsilon')
  ];
  const manager = Object.assign(new EventEmitter(), { list: sessions });
  const folders = new FolderStore({ workspaceState: memoryState() });
  const tree = new SessionTree(manager, folders);

  checkEqual('a worktree groups with its project', path.basename(projectRoot(sessions[2].cwd)), 'Peuka');
  checkEqual('a subdirectory groups with its project', path.basename(projectRoot(sessions[1].cwd)), 'Peuka');
  checkEqual('a separate repo is its own project', path.basename(projectRoot(sessions[3].cwd)), 'NikUI');

  const roots = tree.getChildren();
  checkEqual('auto nests once there are several projects', roots.map((g) => g.label), ['NikUI', 'Peuka', 'tmp']);
  const peuka = roots.find((g) => g.label === 'Peuka');
  checkEqual('the project holds its instances', peuka.sessions.map((s) => s.id), ['s1', 's2', 's3']);

  const item = tree.groupItem(peuka);
  check('the group counts what is working', /1 working/.test(item.description));
  check('the group sums cost', /\$1\.50/.test(item.description));
  check('groups start expanded', item.collapsibleState === 2);
  check('identity is stable between calls', tree.getChildren().find((g) => g.label === 'Peuka') === peuka);
  check('getParent maps an instance to its group', tree.getParent(sessions[1]) === peuka);

  stub.__config.groupByProject = 'never';
  check('never flattens', tree.getChildren().length === 5);
  stub.__config.groupByProject = 'auto';

  manager.list = [sessions[0], sessions[1]];
  tree.refresh();
  check('auto stays flat for a single project', tree.getChildren().every((x) => !x.__group));
  manager.list = sessions;
  tree.refresh();

  suite('user folders and drag and drop');

  const queue = folders.create('Review queue');
  tree.refresh();
  const withFolder = tree.getChildren();
  check('a folder appears above the projects', withFolder[0].__folder === true);
  check('projects still show the unfiled instances', withFolder.some((x) => x.__group));

  const transfer = new Map();
  tree.handleDrag([sessions[0], sessions[1]], transfer);
  await tree.handleDrop(tree.getChildren().find((x) => x.__folder), transfer);
  const filed = tree.getChildren().find((x) => x.__folder);
  checkEqual('dragging files both instances', filed.sessions.map((s) => s.id), ['s1', 's2']);
  checkEqual('a filled folder shows what a project row shows',
    tree.folderItem(filed).description, '2 · 1 working · $1.00');

  const single = new Map();
  tree.handleDrag([sessions[0]], single);
  await tree.handleDrop(undefined, single);
  checkEqual('dropping on empty space unfiles', tree.getChildren().find((x) => x.__folder).sessions.map((s) => s.id), ['s2']);

  // VS Code can hand the payload back as a string across the drag boundary.
  const asString = new Map();
  asString.set(MIME, { value: JSON.stringify(['s5']) });
  await tree.handleDrop(tree.getChildren().find((x) => x.__folder), asString);
  checkEqual('a stringified payload still works', tree.getChildren().find((x) => x.__folder).sessions.map((s) => s.id).sort(), ['s2', 's5']);

  check('getParent finds the user folder', tree.getParent(sessions[1]).__folder === true);
  check('an empty folder invites a drop', /drag instances here/.test(tree.folderItem({ id: queue.id, label: 'x', sessions: [] }).description));

  // Closing an instance must not leave a dangling assignment.
  manager.list = sessions.filter((s) => s.id !== 's2');
  manager.emit('changed');
  check('assignments are pruned when an instance goes away', !('s2' in folders.assign));

  suite('every row reads the same way');

  const row = (session) => describeRow(session, lookFor(session));

  checkEqual('a row starts with what the instance is doing',
    row(instance('r1', '/Users/nikoloz/Codes/Peuka', 'alpha', true)), 'working · $0.50');
  checkEqual('having a ticket does not change the grammar',
    row(Object.assign(instance('r2', '/Users/nikoloz/Codes/Peuka', 'beta'), { ticket: '1327' })), 'idle · $0.50');
  checkEqual('a worktree says which folder it is in',
    row(instance('r3', '/Users/nikoloz/Codes/Peuka/backend/.claude/worktrees/692-phase3a', 'gamma')),
    'idle · 692-phase3a · $0.50');
  checkEqual('an instance at the project root does not repeat it',
    row(instance('r4', '/Users/nikoloz/Codes/Peuka', 'delta')), 'idle · $0.50');
  checkEqual('a free instance shows no price',
    row(Object.assign(instance('r5', '/Users/nikoloz/Codes/Peuka', 'eps'), { totalCost: 0 })), 'idle');

  suite('a reload gives a row back the state it had');

  const restored = Object.assign(instance('r6', '/Users/nikoloz/Codes/Peuka', 'zeta'), {
    isAsleep: true, status: 'done', finishedAt: Date.now() - 86400000
  });
  checkEqual('a conversation that finished comes back finished', row(restored), 'done · $0.50');
  checkEqual('in the colour it had', lookFor(restored).color, 'charts.green');
  check('however long ago that was', lookFor(restored).color === 'charts.green');
  checkEqual('but wearing the icon of something with no process', lookFor(restored).icon, ASLEEP.icon);
  check('which is not the icon of a live instance', ASLEEP.icon !== lookFor(instance('r7', '/tmp', 'eta')).icon);

  const failed = Object.assign(instance('r8', '/tmp', 'theta'), { isAsleep: true, status: 'error' });
  checkEqual('an instance that ended badly comes back red', lookFor(failed).color, 'charts.red');
  checkEqual('and says so', row(failed), 'error · $0.50');

  const sleeper = new SessionTree(Object.assign(new EventEmitter(), { list: [restored] }), folders);
  const sleeperRow = sleeper.sessionItem(restored);
  check('the tooltip explains what asleep means', /Opening it starts the process/.test(sleeperRow.tooltip.value));

  suite('a project is not somewhere you can drop things');

  const dropTree = new SessionTree(manager, folders);
  folders.place('s1', queue.id);
  const before = folders.folderOf('s1');
  check('the instance starts in a folder', before && before.id === queue.id);

  const payload = new Map();
  payload.set(MIME, { value: ['s1'] });
  payload.get = payload.get.bind(payload);
  dropTree.handleDrop({ __group: true, root: '/Users/nikoloz/Codes/Peuka', sessions: [] }, payload);
  const stillFiled = folders.folderOf('s1');
  check('dropping it on a project leaves it where it was', stillFiled && stillFiled.id === queue.id);

  dropTree.handleDrop(undefined, payload);
  checkEqual('while dropping on empty space still takes it out', folders.folderOf('s1'), null);

  suite('a queue you can see from the sidebar');

  const withQueue = Object.assign(instance('q1', '/Users/nikoloz/Codes/Peuka', 'queued one', true), {
    queue: [{ id: 'a' }, { id: 'b' }], meta: {}
  });
  checkEqual('the row counts what is waiting', row(withQueue), 'working · 2 queued · $0.50');
  const queueRow = dropTree.sessionItem(withQueue);
  check('and the tooltip spells it out', /2 prompts waiting/.test(queueRow.tooltip.value));
  checkEqual('an empty queue says nothing',
    row(instance('q2', '/Users/nikoloz/Codes/Peuka', 'quiet')), 'idle · $0.50');

  suite('green stops meaning "just finished"');

  const fresh = Object.assign(instance('d1', '/Users/nikoloz/Codes/Peuka', 'fresh'), {
    status: 'done', finishedAt: Date.now()
  });
  checkEqual('a turn that just ended is green', lookFor(fresh).color, 'charts.green');

  const stale = Object.assign(instance('d2', '/Users/nikoloz/Codes/Peuka', 'stale'), {
    status: 'done', finishedAt: Date.now() - DONE_FADES_AFTER_MS - 1000
  });
  checkEqual('an hour later it reads as idle', lookFor(stale).word, 'idle');
  check('and stops being green', lookFor(stale).color !== 'charts.green');
  checkEqual('the instance itself still knows it finished', stale.status, 'done');
};
