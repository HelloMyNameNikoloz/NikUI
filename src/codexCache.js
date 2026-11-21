'use strict';

// What NikUI keeps of Codex conversations between windows, so opening one is
// instant: its turns as Codex gave them (less the pictures, which live on
// disk anyway), and small copies of the pictures themselves. A conversation's
// turns are trusted for a week, then read again in full; anything not opened
// for a week is thrown away.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// A picture up to this size is sent as it is; a bigger one is made smaller.
const SMALL_BYTES = 150 * 1024;
const LARGEST_BYTES = 8 * 1024 * 1024;
const THUMB_PX = 1200;

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const sha = (text) => crypto.createHash('sha1').update(text).digest('hex');

function touch(file) {
  const now = new Date();
  try { fs.utimesSync(file, now, now); } catch (_) { /* gone, or not ours */ }
}

/** The turns worth keeping: a generated image is a file on disk, so not also kept as data. */
function lean(turn) {
  return Object.assign({}, turn, {
    items: (turn.items || []).map((item) => {
      if (item && item.type === 'imageGeneration' && item.savedPath && item.result) {
        const copy = Object.assign({}, item);
        delete copy.result;
        return copy;
      }
      return item;
    })
  });
}

class CodexCache {
  constructor({ dir, maxAgeMs, shrink, writeDelayMs } = {}) {
    // Without a home of its own (tests, a window with no storage) the turns
    // are not kept, but pictures are still made small somewhere temporary.
    this.dir = dir || null;
    this.thumbDir = path.join(dir || path.join(os.tmpdir(), 'nikui-codex'), 'pictures');
    this.threadDir = dir ? path.join(dir, 'threads') : null;
    this.maxAgeMs = maxAgeMs || WEEK_MS;
    this.shrink = shrink || sipsShrink;
    this.writeDelayMs = writeDelayMs != null ? writeDelayMs : 2000;
    this._running = 0;
    this._waiting = [];
    this._making = new Map();
    this._writes = new Map();
  }

  _threadFile(threadId) {
    return this.threadDir ? path.join(this.threadDir, threadId.replace(/[^\w.-]/g, '_') + '.json') : null;
  }

  /** The kept turns of a conversation, or null if none or a week old. Reading counts as using. */
  read(threadId) {
    const file = this._threadFile(threadId);
    if (!file) return null;
    try {
      const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
      touch(file);
      if (!kept || !Array.isArray(kept.turns) || Date.now() - (kept.savedAt || 0) > this.maxAgeMs) return null;
      return kept;
    } catch (_) {
      return null;
    }
  }

  /**
   * Keep a conversation's turns, oldest first. `fresh` is when they were last
   * read in full from Codex; until a week after that, opening only reads
   * what is new.
   */
  write(threadId, { turns, more, savedAt }) {
    const file = this._threadFile(threadId);
    if (!file) return;
    // Written once things settle: a running turn rereads its history often.
    // (A window closing within the wait loses the write; the next open is slower.)
    clearTimeout(this._writes.get(threadId));
    const timer = setTimeout(() => {
      this._writes.delete(threadId);
      try {
        fs.mkdirSync(this.threadDir, { recursive: true });
        const tmp = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ savedAt: savedAt || Date.now(), more: !!more, turns: turns.map(lean) }));
        fs.renameSync(tmp, file);
      } catch (_) { /* a cache: losing a write costs one slow open */ }
    }, this.writeDelayMs);
    if (timer.unref) timer.unref();
    this._writes.set(threadId, timer);
  }

  /** Throw away what nothing has opened for a week. */
  sweep() {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const dir of [this.threadDir, this.thumbDir]) {
      if (!dir) continue;
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { continue; }
      for (const name of names) {
        const file = path.join(dir, name);
        try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch (_) { /* already gone */ }
      }
    }
  }

  /** A picture as the panel shows it, {mediaType, data, name}, made small if it is big; null if unreadable. */
  async picture(src) {
    const ref = String(src || '').trim();
    const inline = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(ref);
    if (inline) {
      const data = inline[2].replace(/\s+/g, '');
      if (data.length <= SMALL_BYTES * 1.37) return { mediaType: inline[1], data, name: 'image' };
      // Too big to send as it is: put it on disk once, then shrink that.
      const ext = (inline[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
      const file = path.join(this.thumbDir, sha(data) + '.src.' + ext);
      try {
        if (!fs.existsSync(file)) { fs.mkdirSync(this.thumbDir, { recursive: true }); fs.writeFileSync(file, Buffer.from(data, 'base64')); }
      } catch (_) { return null; }
      return this.picture(file);
    }
    let file = ref;
    if (/^file:\/\//i.test(file)) {
      try { file = decodeURIComponent(new URL(file).pathname); } catch (_) { return null; }
    }
    if (file.startsWith('~/')) file = path.join(os.homedir(), file.slice(2));
    if (!path.isAbsolute(file)) return null;
    const type = IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()];
    if (!type) return null;
    let stat;
    try { stat = await fs.promises.stat(file); } catch (_) { return null; }
    if (!stat.isFile()) return null;
    const name = path.basename(file);
    try {
      if (stat.size <= SMALL_BYTES || type === 'image/gif') {
        if (stat.size > LARGEST_BYTES) return null;
        return { mediaType: type, data: (await fs.promises.readFile(file)).toString('base64'), name };
      }
      const small = path.join(this.thumbDir, sha(file + '|' + stat.size + '|' + stat.mtimeMs) + '.jpg');
      if (!fs.existsSync(small)) await this._once(small, () => this._limit(() => this.shrink(file, small, THUMB_PX)));
      if (fs.existsSync(small)) {
        touch(small);
        return { mediaType: 'image/jpeg', data: (await fs.promises.readFile(small)).toString('base64'), name };
      }
      // Could not be made smaller here: the original, if it is not huge.
      if (stat.size > LARGEST_BYTES) return null;
      return { mediaType: type, data: (await fs.promises.readFile(file)).toString('base64'), name };
    } catch (_) {
      return null;
    }
  }

  // The same picture asked for twice at once is made once.
  _once(key, make) {
    if (!this._making.has(key)) {
      this._making.set(key, Promise.resolve().then(make).catch(() => {}).finally(() => this._making.delete(key)));
    }
    return this._making.get(key);
  }

  // A conversation with dozens of pictures does not start dozens of processes at once.
  _limit(job) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this._running += 1;
        Promise.resolve().then(job).then(resolve, reject).finally(() => {
          this._running -= 1;
          const next = this._waiting.shift();
          if (next) next();
        });
      };
      if (this._running < 3) run();
      else this._waiting.push(run);
    });
  }
}

/** macOS's own image tool: a JPEG no wider or taller than `px`. */
function sipsShrink(src, out, px) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.' + process.pid + '.tmp.jpg';
  return new Promise((resolve) => {
    execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', String(px), src, '--out', tmp],
      { timeout: 30000 }, (err) => {
        if (!err) { try { fs.renameSync(tmp, out); } catch (_) { /* left as it was */ } }
        else { try { fs.unlinkSync(tmp); } catch (_) { /* never made */ } }
        resolve();
      });
  });
}

module.exports = { CodexCache, WEEK_MS, lean };
