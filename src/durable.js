'use strict';

const path = require('path');

const FILE_NAME = 'remembered.json';
// Bounded so the file stays a handful of windows' worth of memory, not a
// history of every window the user has ever opened.
const MAX_PLACES = 20;

/**
 * What VS Code calls this window, for keying the file below. A folder or a
 * .code-workspace file identifies a window across restarts; an empty window
 * does not, so every empty window shares one bucket.
 */
function placeOf(vscodeWorkspace) {
  const file = vscodeWorkspace.workspaceFile;
  if (file && file.scheme !== 'untitled') return 'workspace:' + file.toString();
  const folders = vscodeWorkspace.workspaceFolders || [];
  if (folders.length) return 'folder:' + folders.map((f) => f.uri.toString()).sort().join('|');
  return 'empty';
}

/**
 * A JSON file in globalStorage, so a handful of small facts survive a window
 * that workspaceState cannot tell apart from a brand-new one: an empty window
 * is keyed by VS Code's internal window id, which changes every time one is
 * closed and reopened.
 */
class Durable {
  constructor({ dir, place, fs = require('fs') }) {
    this.dir = dir;
    this.place = place;
    this.fs = fs;
  }

  _file() {
    return path.join(this.dir, FILE_NAME);
  }

  /** Never throws: a file that cannot be read is treated as if it were empty. */
  _read() {
    const fs = this.fs;
    let text;
    try {
      text = fs.readFileSync(this._file(), 'utf8');
    } catch (_) {
      return { version: 1, places: {} };
    }
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && data.places && typeof data.places === 'object') return data;
      return { version: 1, places: {} };
    } catch (_) {
      // Keep the broken file around to look at, but never let it block a
      // fresh write: the next set() starts clean, just like a missing file.
      try { fs.writeFileSync(this._file() + '.bad', text); } catch (_) { /* best effort */ }
      return { version: 1, places: {} };
    }
  }

  _write(data) {
    const fs = this.fs;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) { /* already there */ }
    const file = this._file();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  /** Drop the places used longest ago, keeping the file to a handful of windows. */
  _prune(data) {
    const names = Object.keys(data.places);
    if (names.length <= MAX_PLACES) return;
    const lastUsed = (name) => {
      const entries = Object.values(data.places[name] || {});
      return entries.reduce((max, e) => Math.max(max, e && e.at || 0), 0);
    };
    names.sort((a, b) => lastUsed(a) - lastUsed(b));
    for (const name of names.slice(0, names.length - MAX_PLACES)) delete data.places[name];
  }

  get(key) {
    const data = this._read();
    const here = data.places[this.place];
    const entry = here && here[key];
    return entry ? entry.value : undefined;
  }

  set(key, value) {
    const data = this._read();
    if (!data.places[this.place]) data.places[this.place] = {};
    data.places[this.place][key] = { value, at: Date.now() };
    this._prune(data);
    try { this._write(data); } catch (_) { /* a failed write just means next time tries again */ }
  }
}

module.exports = { Durable, placeOf };
