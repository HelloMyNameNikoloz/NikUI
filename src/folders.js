'use strict';

const STORE_KEY = 'nikui.folders.v1';

let seq = 0;

/**
 * User-made folders for organising instances, and which instance sits in which.
 * Kept in workspaceState so it survives a reload alongside the instances.
 */
class FolderStore {
  constructor(context) {
    this.context = context;
    const saved = context.workspaceState.get(STORE_KEY, null);
    this.folders = (saved && Array.isArray(saved.folders)) ? saved.folders : [];
    this.assign = (saved && saved.assign && typeof saved.assign === 'object') ? saved.assign : {};
  }

  save() {
    this.context.workspaceState.update(STORE_KEY, { folders: this.folders, assign: this.assign });
  }

  list() {
    return this.folders.slice();
  }

  get(id) {
    return this.folders.find((f) => f.id === id) || null;
  }

  create(name) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const folder = { id: 'f' + Date.now().toString(36) + (seq++).toString(36), name: clean };
    this.folders.push(folder);
    this.save();
    return folder;
  }

  rename(id, name) {
    const folder = this.get(id);
    const clean = String(name || '').trim();
    if (!folder || !clean) return false;
    folder.name = clean;
    this.save();
    return true;
  }

  remove(id) {
    const before = this.folders.length;
    this.folders = this.folders.filter((f) => f.id !== id);
    for (const sessionId of Object.keys(this.assign)) {
      if (this.assign[sessionId] === id) delete this.assign[sessionId];
    }
    if (this.folders.length !== before) { this.save(); return true; }
    return false;
  }

  /** folderId of null takes the instance back out to the top level. */
  place(sessionId, folderId) {
    if (!sessionId) return;
    if (folderId && this.get(folderId)) this.assign[sessionId] = folderId;
    else delete this.assign[sessionId];
    this.save();
  }

  folderOf(sessionId) {
    const id = this.assign[sessionId];
    return id ? this.get(id) : null;
  }

  /** Forget assignments for instances that no longer exist. */
  prune(liveIds) {
    const live = new Set(liveIds);
    let changed = false;
    for (const sessionId of Object.keys(this.assign)) {
      if (!live.has(sessionId)) { delete this.assign[sessionId]; changed = true; }
    }
    if (changed) this.save();
  }
}

module.exports = { FolderStore };
