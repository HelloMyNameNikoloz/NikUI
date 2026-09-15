/* Shell-style prompt recall for the composer: Up walks back through what has
   already been sent, Down walks forward again and hands back the draft. */
(function (root) {
  'use strict';

  const LIMIT = 200;

  function PromptHistory(limit) {
    this.entries = [];        // oldest first
    this.seen = new Set();    // item ids already folded in
    this.limit = limit || LIMIT;
    this.index = null;        // null while the box is the user's own text
    this.draft = '';
  }

  /**
   * Record a prompt. `id` is the transcript item it came from, so the echo of a
   * prompt this panel just sent — and a replayed transcript seen twice — only
   * ever lands once.
   */
  PromptHistory.prototype.remember = function (text, id) {
    const value = String(text == null ? '' : text).trim();
    if (!value) return false;
    if (id != null) {
      if (this.seen.has(id)) return false;
      this.seen.add(id);
    }
    if (this.entries[this.entries.length - 1] === value) return false;
    this.entries.push(value);
    if (this.entries.length > this.limit) this.entries.shift();
    return true;
  };

  PromptHistory.prototype.browsing = function () { return this.index !== null; };

  /** What recall last put in the box, so an edit can be told from a recall. */
  PromptHistory.prototype.current = function () {
    return this.index === null ? null : this.entries[this.index];
  };

  /** Up: one prompt older. Returns null when there is nothing to recall. */
  PromptHistory.prototype.older = function (draft) {
    if (!this.entries.length) return null;
    if (this.index === null) {
      this.draft = String(draft == null ? '' : draft);
      this.index = this.entries.length;
    }
    if (this.index > 0) this.index--;
    return this.entries[this.index];
  };

  /**
   * Down: one prompt newer, and past the newest, back to the draft the recall
   * started from — so arrowing too far is always undoable.
   */
  PromptHistory.prototype.newer = function () {
    if (this.index === null) return null;
    if (this.index >= this.entries.length - 1) {
      const draft = this.draft;
      this.reset();
      return draft;
    }
    this.index++;
    return this.entries[this.index];
  };

  PromptHistory.prototype.reset = function () { this.index = null; this.draft = ''; };

  root.PromptHistory = PromptHistory;
  if (typeof module !== 'undefined' && module.exports) module.exports = { PromptHistory, LIMIT };
})(typeof window !== 'undefined' ? window : globalThis);
