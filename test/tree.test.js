'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const { install, memoryState } = require('./helpers/vscode-stub.js');

const stub = install();
const { SessionTree, projectRoot, MIME } = require('../src/tree.js');
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
  checkEqual('a filled folder shows its count and activity', tree.folderItem(filed).description, '2 · 1 working');

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
};
