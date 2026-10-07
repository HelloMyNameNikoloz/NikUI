'use strict';

const path = require('path');

/**
 * What every instance NikUI has ever run has cost, machine-wide. A window's
 * fleet totals only know about the instances it has open; this is the one
 * file every window — past, present, Slack, remote — shares, so the number
 * on /status can finally answer "how much has this thing cost me, lifetime".
 *
 * Keyed by instance id, not by conversation. Reopening a conversation starts
 * a new instance id, and that instance's running total starts again at zero
 * in NikUI (the CLI itself has no notion of a lifetime cost to hand back) —
 * so each id's cost only ever grows, and summing by id never double-counts
 * the same spend twice under two names.
 */
class Ledger {
  constructor({ dir, fs = require('fs'), now = Date.now } = {}) {
    this.dir = dir;
    this.fs = fs;
    this.now = now;
    this.file = path.join(dir, 'ledger.json');
    this.pending = false; // an upsert since the last write hit disk
    this.lastWriteAt = -Infinity; // so the very first write is never throttled
    this.data = this.load();
  }

  load() {
    let text = '';
    try { text = this.fs.readFileSync(this.file, 'utf8'); } catch (_) { return { version: 1, instances: {} }; }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.instances && typeof parsed.instances === 'object') {
        return { version: 1, instances: parsed.instances };
      }
    } catch (_) { /* falls through to quarantine below */ }
    // Corrupt rather than merely missing: keep the evidence instead of
    // silently overwriting whatever was actually on disk.
    try { this.fs.renameSync(this.file, this.file + '.bad'); } catch (_) { /* best effort */ }
    return { version: 1, instances: {} };
  }

  /**
   * Fold whatever is on disk into what is already in memory, so a write from
   * another window is never lost — and, just as important, so a write this
   * window made but has not yet flushed (held back by the throttle) is never
   * clobbered by an older copy still sitting on disk.
   */
  reload() {
    const fresh = this.load();
    for (const [id, row] of Object.entries(fresh.instances)) {
      const existing = this.data.instances[id];
      if (!existing) { this.data.instances[id] = row; continue; }
      this.data.instances[id] = {
        cost: Math.max(row.cost || 0, existing.cost || 0),
        tokens: Math.max(row.tokens || 0, existing.tokens || 0),
        turns: Math.max(row.turns || 0, existing.turns || 0),
        cwd: existing.cwd || row.cwd || null,
        label: existing.label || row.label || null,
        claudeSessionId: existing.claudeSessionId || row.claudeSessionId || null,
        firstAt: Math.min(existing.firstAt || row.firstAt || 0, row.firstAt || existing.firstAt || 0),
        lastAt: Math.max(existing.lastAt || 0, row.lastAt || 0)
      };
    }
  }

  /**
   * Fold a batch of session-like objects in, each counting only if its
   * running total has grown since the last time this id was recorded. Never
   * throws: a bad write here must not take an instance down.
   */
  record(sessions) {
    try { this.reload(); } catch (_) { /* work from what we had */ }
    const at = this.now();
    let changed = false;
    for (const s of sessions || []) {
      if (!s || !s.id) continue;
      const usage = s.usage || {};
      const cost = s.totalCost || 0;
      const turns = s.turns || 0;
      const tokens = (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheCreate || 0);
      if (!cost && !turns) continue; // nothing to show for this instance yet

      const existing = this.data.instances[s.id];
      const merged = {
        cost: Math.max(cost, existing ? existing.cost : 0),
        tokens: Math.max(tokens, existing ? existing.tokens : 0),
        turns: Math.max(turns, existing ? existing.turns : 0),
        cwd: s.cwd || (existing && existing.cwd) || null,
        label: s.label || (existing && existing.label) || null,
        claudeSessionId: s.claudeSessionId || (existing && existing.claudeSessionId) || null,
        // When the instance started, if it says; an import of old data would
        // otherwise read as all having begun today.
        firstAt: Math.min(existing ? existing.firstAt : at, s.startedAt || at),
        lastAt: at
      };
      if (!existing || merged.cost !== existing.cost || merged.tokens !== existing.tokens ||
          merged.turns !== existing.turns) changed = true;
      this.data.instances[s.id] = merged;
    }
    if (changed) {
      this.pending = true;
      this.maybeWrite();
    }
  }

  /** Same merge as record(), for importing a one-off batch of old data. */
  seed(entries) {
    this.record(entries);
    this.flush();
  }

  /** Write now if the throttle allows it; otherwise leave it pending. */
  maybeWrite() {
    const at = this.now();
    if (at - this.lastWriteAt < 5000) return;
    this.writeNow();
  }

  /** Force the pending write out, regardless of the throttle. */
  flush() {
    if (this.pending) this.writeNow();
  }

  writeNow() {
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      this.fs.writeFileSync(tmp, JSON.stringify(this.data));
      this.fs.renameSync(tmp, this.file);
      this.pending = false;
      this.lastWriteAt = this.now();
    } catch (_) {
      // Disk trouble is not this instance's problem; the totals still live
      // in memory and the next successful write carries everything along.
    }
  }

  /** The lifetime figures /status wants, over whatever is recorded so far — including anything still only pending in memory. */
  totals() {
    const rows = Object.values(this.data.instances);
    let cost = 0, tokens = 0, turns = 0, since = null;
    const projects = new Set();
    for (const row of rows) {
      cost += row.cost || 0;
      tokens += row.tokens || 0;
      turns += row.turns || 0;
      if (row.cwd) projects.add(row.cwd);
      if (row.firstAt && (since === null || row.firstAt < since)) since = row.firstAt;
    }
    return { cost, tokens, turns, instances: rows.length, projects: projects.size, since };
  }
}

module.exports = { Ledger };
