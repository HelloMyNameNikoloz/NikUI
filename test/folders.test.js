'use strict';
const { FolderStore } = require('../src/folders.js');
const { memoryState } = require('./helpers/vscode-stub.js');

module.exports = function () {
  suite('folder store');

  const workspaceState = memoryState();
  const context = { workspaceState };
  const store = new FolderStore(context);

  const work = store.create('Review queue');
  const spikes = store.create('Experiments');
  store.place('s1', work.id);
  store.place('s2', work.id);
  store.place('s3', spikes.id);

  check('creates folders', store.list().length === 2);
  check('assigns an instance', store.folderOf('s1').name === 'Review queue');
  check('ignores a blank name', store.create('   ') === null);

  store.rename(spikes.id, 'Spikes');
  store.place('s2', null);
  store.prune(['s1', 's3']);

  // A second store over the same storage proves it round-trips.
  const reloaded = new FolderStore(context);
  check('rename survives a reload', reloaded.list().some((f) => f.name === 'Spikes'));
  check('assignment survives a reload', reloaded.folderOf('s1').name === 'Review queue');
  check('unassign survives a reload', reloaded.folderOf('s2') === null);
  check('prune forgets dead instances', !('s2' in reloaded.assign));

  reloaded.remove(reloaded.list().find((f) => f.name === 'Spikes').id);
  check('deleting a folder frees its instances', reloaded.folderOf('s3') === null);
  check('deleting a folder leaves the others', reloaded.list().length === 1);
};
