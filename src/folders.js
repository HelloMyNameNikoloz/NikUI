'use strict';

const STORE_KEY = 'nikui.folders.v1';

let seq = 0;

// byConversation keeps this many entries, dropping the oldest by insertion
// order once it fills up — enough conversations to matter, not a growing log.
const MAX_CONVERSATIONS = 500;

/** An id string (the current callers) or a session object: either names an instance. */
function idOf(sessionOrId) {
  return typeof sessionOrId === 'string' ? sessionOrId : (sessionOrId && sessionOrId.id) || null;
}

function conversationOf(sessionOrId) {
  if (typeof sessionOrId === 'string') return null;
  return (sessionOrId && sessionOrId.claudeSessionId) || null;
}

/**
 * User-made folders for organising instances, and which instance sits in which.
 * Kept in workspaceState so it survives a reload alongside the instances —
 * and, if a durable is given, in globalStorage too, so an empty window (which
 * VS Code keys by a window id that changes every reopen) does not lose them.
 */
class FolderStore {
  constructor(context, durable) {
    this.context = context;
    this.durable = durable || null;

    const saved = context.workspaceState.get(STORE_KEY, null);
    let folders = (saved && Array.isArray(saved.folders)) ? saved.folders : [];
    let assign = (saved && saved.assign && typeof saved.assign === 'object') ? saved.assign : {};
    let byConversation = (saved && saved.byConversation && typeof saved.byConversation === 'object')
      ? saved.byConversation : {};

    if (!folders.length && this.durable) {
      const remembered = this.durable.get(STORE_KEY);
      if (remembered && Array.isArray(remembered.folders) && remembered.folders.length) {
        folders = remembered.folders;
        assign = (remembered.assign && typeof remembered.assign === 'object') ? remembered.assign : assign;
        byConversation = (remembered.byConversation && typeof remembered.byConversation === 'object')
          ? remembered.byConversation : byConversation;
        context.workspaceState.update(STORE_KEY, { folders, assign, byConversation });
      }
    }

    this.folders = folders;
    this.assign = assign;
    this.byConversation = byConversation;
  }

  save() {
    const data = { folders: this.folders, assign: this.assign, byConversation: this.byConversation };
    this.context.workspaceState.update(STORE_KEY, data);
    if (this.durable) this.durable.set(STORE_KEY, data);
  }

  /** Note the folder against the conversation, bounding the map as it grows. */
  _rememberConversation(claudeSessionId, folderId) {
    delete this.byConversation[claudeSessionId]; // re-insert at the end, as the most recent
    this.byConversation[claudeSessionId] = folderId;
    const keys = Object.keys(this.byConversation);
    if (keys.length > MAX_CONVERSATIONS) {
      for (const key of keys.slice(0, keys.length - MAX_CONVERSATIONS)) delete this.byConversation[key];
    }
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
    for (const conversation of Object.keys(this.byConversation)) {
      if (this.byConversation[conversation] === id) delete this.byConversation[conversation];
    }
    if (this.folders.length !== before) { this.save(); return true; }
    return false;
  }

  /**
   * folderId of null takes the instance back out to the top level. Accepts
   * either an id (the current callers) or a session object, in which case the
   * conversation behind it is remembered too — so reopening it under a new id
   * still finds its folder.
   */
  place(sessionOrId, folderId) {
    const id = idOf(sessionOrId);
    const conversation = conversationOf(sessionOrId);
    if (!id) return;
    if (folderId && this.get(folderId)) {
      this.assign[id] = folderId;
      if (conversation) this._rememberConversation(conversation, folderId);
    } else {
      delete this.assign[id];
      if (conversation) delete this.byConversation[conversation];
    }
    this.save();
  }

  /**
   * Accepts either an id or a session object. An id-only assignment is tried
   * first; failing that, the conversation behind the session — which survives
   * the instance being reopened under a new id — is tried, and the id is
   * backfilled so the next lookup is a plain hit again.
   */
  folderOf(sessionOrId) {
    const id = idOf(sessionOrId);
    let folderId = id ? this.assign[id] : null;
    if (!folderId) {
      const conversation = conversationOf(sessionOrId);
      if (conversation && this.byConversation[conversation]) {
        folderId = this.byConversation[conversation];
        if (id) { this.assign[id] = folderId; this.save(); }
      }
    }
    return folderId ? this.get(folderId) : null;
  }

  /**
   * Called once a session learns its claudeSessionId, so a folder chosen
   * before that is still found by conversation after a reopen.
   */
  remember(session) {
    if (!session || !session.id || !session.claudeSessionId) return;
    const folderId = this.assign[session.id];
    if (!folderId || this.byConversation[session.claudeSessionId] === folderId) return;
    this._rememberConversation(session.claudeSessionId, folderId);
    this.save();
  }

  /**
   * Forget assignments for instances that no longer exist. byConversation is
   * left alone here — on purpose: a conversation reopened later should still
   * land back in its folder, which is the whole point of keeping it.
   */
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
