'use strict';

const crypto = require('crypto');
const path = require('path');
const { KeeperLink, KeptProc, sessionMeta } = require('./keeperLink');
const { privateDirectory, privateFile, fail } = require('./daemonPaths');

const MANIFEST = 'nikd.keeper.v1';
const complete = (meta) => meta && typeof meta.instance === 'string' && !!meta.instance &&
  typeof meta.cwd === 'string' && path.isAbsolute(meta.cwd) &&
  (meta.conversation === null || typeof meta.conversation === 'string' && !!meta.conversation);

/** Strict service policy; the window's KeeperLink keeps its legacy fallback.
 * The store is the isolated daemon's synchronous, fsynced manifest adapter.
 * There is no API here for adopting arbitrary orphans or importing source IDs.
 */
class DaemonKeeper extends KeeperLink {
  constructor({ dir, store, ...options } = {}) {
    if (!dir || !path.isAbsolute(dir) || !store) throw fail('KEEPER_CONFIG', 'A private keeper directory and ownership store are required');
    privateDirectory(dir);
    super({ ...options, dir });
    this.store = store;
    this.blockers = new Map();
    this.actions = Promise.resolve();
    this.fenced = false;
    const saved = store.get(MANIFEST, { version: 1, runs: [] });
    if (!saved || saved.version !== 1 || !Array.isArray(saved.runs) || saved.runs.some((run) =>
      !run || !complete(run.meta) || typeof run.runId !== 'string' || !run.runId)) {
      throw fail('KEEPER_MANIFEST_INVALID', 'Keeper ownership manifest is incomplete');
    }
    this.manifest = new Map(saved.runs.map((run) => [run.meta.instance, run]));
    if (this.manifest.size !== saved.runs.length) throw fail('KEEPER_MANIFEST_INVALID', 'Keeper ownership manifest contains duplicate instances');
  }

  _serial(fn) {
    const result = this.actions.then(fn);
    this.actions = result.catch(() => {});
    return result;
  }

  _block(session, code) {
    const named = /^KEEPER_[A-Z_]+$/.test(code) ? code : code === 'owned' ? 'KEEPER_OWNED_ELSEWHERE' : 'KEEPER_UNAVAILABLE';
    this.blockers.set(session.id, { code: named, instance: session.id,
      hint: 'Keeper continuity or exclusive conversation ownership could not be proved; no replacement process was started.' });
    session.keeperRefusal = named;
    session.elsewhere = true;
    if (!session.disposed && typeof session._notice === 'function') session._notice(named + ': resume refused; inspect keeper ownership before retrying.', 'error');
    return 'elsewhere';
  }

  _remember(runId, meta) {
    if (!complete(meta)) throw fail('KEEPER_META_INCOMPLETE', 'Keeper metadata is incomplete');
    const runs = new Map(this.manifest);
    runs.set(meta.instance, { runId, meta: { ...meta } });
    try {
      const result = this.store.update(MANIFEST, { version: 1, runs: [...runs.values()] });
      if (result && typeof result.then === 'function') throw fail('KEEPER_MANIFEST_UNAVAILABLE', 'Manifest adapter must commit synchronously');
    } catch (_) { throw fail('KEEPER_MANIFEST_UNAVAILABLE', 'Keeper ownership could not be committed'); }
    this.manifest = runs;
  }

  async _ready() {
    if (this.fenced) throw fail('KEEPER_MANIFEST_UNAVAILABLE', 'Keeper ownership manifest is fenced');
    privateDirectory(this.dir, false);
    privateFile(this.socketPath, { socket: true, optional: true });
    if (!(await this.connect()) || !this.socket) throw fail('KEEPER_UNAVAILABLE', 'Keeper is unavailable');
    if (this.metaVersion !== 1) throw fail('KEEPER_META_UNSUPPORTED', 'This keeper does not enforce guarded metadata operations');
  }

  async _list() {
    await this._ready();
    const reply = await this.request({ t: 'list' }, 4000);
    if (reply.metaVersion !== 1 || !Array.isArray(reply.runs)) throw fail('KEEPER_META_UNAVAILABLE', 'Keeper metadata cannot be read');
    if (reply.runs.some((run) => !run || typeof run.runId !== 'string' || typeof run.key !== 'string' || !Object.hasOwn(run, 'exit'))) {
      throw fail('KEEPER_META_INCOMPLETE', 'Keeper listing is incomplete');
    }
    return reply.runs;
  }

  _check(meta, runs, except = null) {
    if (!complete(meta)) throw fail('KEEPER_META_INCOMPLETE', 'Instance metadata is incomplete');
    for (const run of runs) {
      if (run === except || run.exit) continue;
      if (run.key === meta.instance) throw fail('KEEPER_INSTANCE_LIVE', 'The instance already has a live run');
      if (meta.conversation === null) continue;
      if (!complete(run.meta) || run.meta.instance !== run.key || run.meta.conversation === null) throw fail('KEEPER_META_INCOMPLETE', 'A live conversation is not identified');
      if (run.meta.conversation === meta.conversation) throw fail('KEEPER_CONVERSATION_LIVE', 'The conversation is already live under another instance');
    }
  }

  send(msg) {
    if (msg.guard && this.metaVersion !== 1) return false;
    if (this.fenced && !['release', 'forget'].includes(msg.t)) return false;
    if (msg.t === 'checkpoint') {
      try {
        const owned = this.manifest.get(msg.meta && msg.meta.instance);
        if (!owned || owned.runId !== msg.runId) throw fail('KEEPER_NOT_ELIGIBLE', 'Checkpoint is not in the ownership manifest');
        this._remember(msg.runId, msg.meta);
      } catch (_) {
        this.fenced = true;
        const proc = this.procs.get(msg.runId);
        if (proc && proc.session) this._block(proc.session, 'KEEPER_MANIFEST_UNAVAILABLE');
        return false;
      }
    }
    return super.send(msg);
  }

  request(msg, ms) {
    // Old keepers silently ignore unknown fields. Never send a guard until
    // this connection's hello has proved that the keeper enforces it.
    if ((msg.guard || msg.t === 'reclaim') && this.metaVersion !== 1) {
      return Promise.resolve({ ok: false, message: 'KEEPER_META_UNSUPPORTED' });
    }
    if (msg.t === 'reclaim') {
      const owned = [...this.manifest.values()].find((run) => run.runId === msg.runId);
      if (!owned || this.metaVersion !== 1) return Promise.resolve({ ok: false, message: 'KEEPER_NOT_ELIGIBLE' });
      msg = { ...msg, guard: owned.meta };
    }
    return super.request(msg, ms);
  }

  spawner() {
    return (cmd, args, opts, session) => {
      if (!session) throw fail('KEEPER_NOT_ELIGIBLE', 'An owned instance is required');
      const runId = crypto.randomUUID(), proc = new KeptProc(this, runId, session);
      this.procs.set(runId, proc);
      void this._serial(async () => {
        try {
          const meta = sessionMeta(session), runs = await this._list();
          if (this.closed || this.fenced || session.disposed || proc.released) throw fail('KEEPER_UNAVAILABLE', 'Owner is closing');
          this._check(meta, runs);
          this._remember(runId, meta); // durable eligibility precedes the spawn
          const reply = await this.request({ t: 'spawn', runId, key: session.id, cmd, args,
            cwd: opts.cwd, env: opts.env, snapshot: session.snapshot(), meta, guard: meta }, 4000);
          if (!reply.ok) throw fail(reply.message, 'Keeper refused or did not confirm spawn');
          proc.pid = reply.pid;
          proc.kept_();
          if (this.fenced) throw fail('KEEPER_MANIFEST_UNAVAILABLE', 'Checkpoint eligibility could not be committed');
          this.blockers.delete(session.id); delete session.keeperRefusal;
        } catch (error) {
          this._block(session, error.code);
          // A lost reply is not non-acceptance. Leave any kept run to grace;
          // do not fall back, signal an unproved pid, or respawn beside it.
          this.send({ t: 'release', runId });
          proc.outbox = []; proc.released = true; proc.state = 'local';
          proc.finish({ code: null, signal: 'SIGHUP' });
        }
      });
      return proc;
    };
  }

  attach(session) {
    return this._serial(async () => {
      let adopted = null;
      try {
        const owned = this.manifest.get(session.id);
        if (!owned || owned.meta.cwd !== session.cwd || session.claudeSessionId &&
            owned.meta.conversation && session.claudeSessionId !== owned.meta.conversation) {
          throw fail('KEEPER_NOT_ELIGIBLE', 'Instance is absent from this daemon ownership manifest');
        }
        const runs = await this._list(), found = runs.find((run) => run.runId === owned.runId && run.key === session.id);
        if (!found) throw fail('KEEPER_RUN_LOST', 'Owned run is no longer within keeper grace');
        if (!complete(found.meta) || found.meta.instance !== session.id || found.meta.cwd !== session.cwd ||
            owned.meta.conversation && found.meta.conversation !== owned.meta.conversation) throw fail('KEEPER_META_INCOMPLETE', 'Owned run metadata is incomplete');
        if (found.owned) throw fail('KEEPER_OWNED_ELSEWHERE', 'Another live connection owns this run');
        this._check(found.meta, runs, found);
        const reply = await this.request({ t: 'attach', key: session.id, runId: owned.runId, guard: found.meta }, 4000);
        if (!reply.ok) throw fail(reply.message === 'none' ? 'KEEPER_RUN_LOST' : reply.message, 'Keeper refused adoption');
        adopted = reply.runId;
        const snap = reply.checkpoint;
        if (!snap || snap.$v !== session.snapshot().$v || snap.id !== session.id || snap.cwd !== session.cwd ||
            (snap.claudeSessionId || null) !== found.meta.conversation || !Array.isArray(snap.items) ||
            snap.items.some((item) => !item || typeof item !== 'object' || typeof item.id !== 'string')) {
          throw fail('KEEPER_CHECKPOINT_INCOMPATIBLE', 'Checkpoint cannot safely restore this instance');
        }
        if (!this._attached(session, reply)) throw fail('KEEPER_CHECKPOINT_INCOMPATIBLE', 'Checkpoint hydration failed');
        if (session._engineControls?.reattach()) session.proc.checkpoint();
        if (this.fenced) throw fail('KEEPER_MANIFEST_UNAVAILABLE', 'Checkpoint eligibility could not be committed');
        this.blockers.delete(session.id); delete session.keeperRefusal;
        return true;
      } catch (error) {
        if (adopted) {
          this.send({ t: 'release', runId: adopted }); this.held.delete(adopted);
          const proc = this.procs.get(adopted);
          if (proc) { proc.released = true; proc.outbox = []; proc.state = 'local'; proc.finish({ code: null, signal: 'SIGHUP' }); }
        }
        return this._block(session, error.code || 'KEEPER_CHECKPOINT_INCOMPATIBLE');
      }
    });
  }

  _lose(proc, why) {
    this._block(proc.session, why === 'none' ? 'KEEPER_RUN_LOST' : why);
    proc.outbox = []; proc.released = true; proc.state = 'local';
    proc.finish({ code: null, signal: 'SIGHUP' });
    return Promise.resolve();
  }

  forget(proc) {
    this.procs.delete(proc.runId);
    if (!proc.released) super.forget(proc);
  }

  _end() { return Promise.resolve(false); }

  async close() {
    this.closed = true;
    await this.actions;
    return super.close();
  }
}

module.exports = { DaemonKeeper, MANIFEST };
