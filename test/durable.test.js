'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Durable, placeOf } = require('../src/durable.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-durable-'));
}

module.exports = function () {
  suite('durable store');

  const dir = tmpDir();
  const a = new Durable({ dir, place: 'folder:/repo' });

  check('starts empty', a.get('k') === undefined);
  a.set('k', { v: 1 });
  check('reads back what it set', a.get('k').v === 1);

  // A second instance over the same dir and place proves it round-trips
  // through the file rather than just living in memory.
  const b = new Durable({ dir, place: 'folder:/repo' });
  check('a second instance over the same file sees it', b.get('k').v === 1);

  // A different place does not see another place's values.
  const other = new Durable({ dir, place: 'folder:/elsewhere' });
  check('a different place sees nothing', other.get('k') === undefined);
  other.set('k', { v: 2 });
  check('places do not clobber each other', a.get('k').v === 1 && other.get('k').v === 2);

  // Writing is atomic: the file never disappears mid-write, and a missing
  // tmp file after a successful set() means the rename happened.
  check('no leftover tmp file', !fs.existsSync(path.join(dir, 'remembered.json.tmp')));

  // A corrupt file is treated as empty, never thrown, and kept as .bad.
  const badDir = tmpDir();
  fs.writeFileSync(path.join(badDir, 'remembered.json'), '{ not json');
  const corrupt = new Durable({ dir: badDir, place: 'empty' });
  let threw = false;
  let value;
  try { value = corrupt.get('k'); } catch (_) { threw = true; }
  check('a corrupt file does not throw', !threw);
  check('a corrupt file reads as empty', value === undefined);
  corrupt.set('k', 1);
  check('a corrupt file keeps a .bad copy', fs.readFileSync(path.join(badDir, 'remembered.json.bad'), 'utf8') === '{ not json');
  check('a corrupt file does not block the next write', corrupt.get('k') === 1);

  // The directory is created on first write, not on construction.
  const freshDir = path.join(tmpDir(), 'nested', 'deeper');
  const fresh = new Durable({ dir: freshDir, place: 'empty' });
  check('no directory yet', !fs.existsSync(freshDir));
  fresh.set('k', 1);
  check('the directory is created on first write', fs.existsSync(freshDir));

  // At most 20 places: the oldest (by last write) is dropped first.
  const boundDir = tmpDir();
  for (let i = 0; i < 25; i++) {
    const d = new Durable({ dir: boundDir, place: 'place' + i });
    d.set('k', i);
  }
  const raw = JSON.parse(fs.readFileSync(path.join(boundDir, 'remembered.json'), 'utf8'));
  check('at most 20 places are kept', Object.keys(raw.places).length === 20);
  const last = new Durable({ dir: boundDir, place: 'place24' });
  const first = new Durable({ dir: boundDir, place: 'place0' });
  check('the newest place survives', last.get('k') === 24);
  check('the oldest place was dropped', first.get('k') === undefined);

  // placeOf.
  const uriOf = (s) => ({ toString: () => s });
  check('a workspace file wins', placeOf({
    workspaceFile: uriOf('file:///x.code-workspace'),
    workspaceFolders: [{ uri: uriOf('file:///a') }]
  }) === 'workspace:file:///x.code-workspace');
  check('an untitled workspace file is ignored', placeOf({
    workspaceFile: { scheme: 'untitled', toString: () => 'untitled:x' },
    workspaceFolders: [{ uri: uriOf('file:///a') }]
  }) === 'folder:file:///a');
  check('folders are sorted and joined', placeOf({
    workspaceFile: null,
    workspaceFolders: [{ uri: uriOf('file:///b') }, { uri: uriOf('file:///a') }]
  }) === 'folder:file:///a|file:///b');
  check('no folder and no workspace file is empty', placeOf({ workspaceFile: null, workspaceFolders: [] }) === 'empty');
};
