'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FolderStore } = require('../src/folders.js');
const { Durable } = require('../src/durable.js');
const { memoryState } = require('./helpers/vscode-stub.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-folders-'));
}

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

  // A conversation reopened under a new id lands back in its old folder.
  const convContext = { workspaceState: memoryState() };
  const convStore = new FolderStore(convContext);
  const home = convStore.create('Home');
  convStore.place({ id: 'old-id', claudeSessionId: 'conv-1' }, home.id);
  check('a plain id lookup still works after a session-object place', convStore.folderOf('old-id').name === 'Home');
  const found = convStore.folderOf({ id: 'new-id', claudeSessionId: 'conv-1' });
  check('a reopened conversation under a new id finds its folder', found && found.name === 'Home');
  check('the new id is backfilled', convStore.assign['new-id'] === home.id);

  // remember() lets a session note its conversation once it learns one, ahead
  // of any lookup by conversation.
  const rememberContext = { workspaceState: memoryState() };
  const rememberStore = new FolderStore(rememberContext);
  const inbox = rememberStore.create('Inbox');
  rememberStore.place('plain-id', inbox.id);
  rememberStore.remember({ id: 'plain-id', claudeSessionId: 'conv-2' });
  check('remember() ties the conversation to the folder',
    rememberStore.folderOf({ id: 'another-id', claudeSessionId: 'conv-2' }).name === 'Inbox');

  // Removing a folder clears byConversation too.
  rememberStore.remove(inbox.id);
  check('removing a folder clears the conversation map', rememberStore.folderOf({ id: 'x', claudeSessionId: 'conv-2' }) === null);

  // prune() only touches assign, not byConversation — a conversation reopened
  // later should still find its folder even once its old id is gone.
  const pruneContext = { workspaceState: memoryState() };
  const pruneStore = new FolderStore(pruneContext);
  const folder = pruneStore.create('Folder');
  pruneStore.place({ id: 'dead-id', claudeSessionId: 'conv-3' }, folder.id);
  pruneStore.prune([]);
  check('prune forgets the dead id', !('dead-id' in pruneStore.assign));
  const refound = pruneStore.folderOf({ id: 'reborn-id', claudeSessionId: 'conv-3' });
  check('prune does not forget the conversation', refound && refound.name === 'Folder');

  // Old saves without byConversation still load.
  const oldSaveContext = { workspaceState: memoryState() };
  oldSaveContext.workspaceState.update('nikui.folders.v1', {
    folders: [{ id: 'f1', name: 'Old' }], assign: { s1: 'f1' }
  });
  const oldSaveStore = new FolderStore(oldSaveContext);
  check('a save from before byConversation still loads', oldSaveStore.folderOf('s1').name === 'Old');
  check('byConversation defaults to empty', Object.keys(oldSaveStore.byConversation).length === 0);
  oldSaveStore.place({ id: 's2', claudeSessionId: 'conv-4' }, 'f1');
  check('a session object still works on top of an old save', oldSaveStore.byConversation['conv-4'] === 'f1');

  suite('folder store · durable');

  const dir = tmpDir();
  const durable = new Durable({ dir, place: 'folder:/repo' });

  // A fresh window (new workspaceState) in the same place adopts what the
  // durable remembers.
  const first = new FolderStore({ workspaceState: memoryState() }, durable);
  const team = first.create('Team');
  first.place('s1', team.id);

  const reopened = new FolderStore({ workspaceState: memoryState() }, durable);
  check('an empty window adopts the durable folders', reopened.list().length === 1);
  check('an empty window adopts the durable assignment', reopened.folderOf('s1').name === 'Team');

  // A different place does not see it.
  const elsewhere = new Durable({ dir, place: 'folder:/elsewhere' });
  const differentPlace = new FolderStore({ workspaceState: memoryState() }, elsewhere);
  check('a different place does not adopt another place\'s folders', differentPlace.list().length === 0);

  // A window that already has folders in workspaceState does not get
  // overwritten by the durable's copy.
  const existingState = memoryState();
  existingState.update('nikui.folders.v1', { folders: [{ id: 'f9', name: 'Mine' }], assign: {} });
  const withOwnState = new FolderStore({ workspaceState: existingState }, durable);
  check('a window with its own folders keeps them', withOwnState.list().length === 1 && withOwnState.list()[0].name === 'Mine');
};

