'use strict';
const { DaemonKeeper } = require('./daemonKeeper');
const { KeeperLink } = require('./keeperLink');
const { fail, privateDirectory, privateFile } = require('./daemonPaths');
const { processSnapshot, validateProof, uniqueRun } = require('./keeperContinuity');

// A borrowed runner has no launch/fallback path. An authenticated source
// export, process identity and immutable build supply the missing old metadata.
class LegacyKeeper extends DaemonKeeper {
  constructor(options) {
    super({ ...options, existingOnly: true });
    this.processSnapshot = options.processSnapshot || processSnapshot;
  }
  _launch() { throw fail('KEEPER_ATTACH_ONLY', 'A borrowed keeper cannot be started'); }
  spawner() { throw fail('KEEPER_ATTACH_ONLY', 'New runs require the current keeper'); }
  async _holdUnproven(session, row) {
    if (session.proc?.link === this && !session.proc.released) return;
    const proof = this.manifest.get(session.id);
    if (!proof?.legacy || this.keeperPid !== proof.legacy.keeper.pid || row.pid !== proof.legacy.child.pid) return;
    // The custodian already proved the unique physical binding. Claim only a
    // blocked logical driver; no input is allowed without fresh OS evidence.
    const reply = await KeeperLink.prototype.request.call(this, { t: 'attach', key: session.id, runId: row.runId }, 2000);
    if (reply.runId === row.runId && (reply.pid === undefined || reply.pid === row.pid) && (reply.ok || reply.message === 'unreplayable'))
      this._holdBlocked(session, { ...reply, pid: row.pid });
  }
  async _ready() {
    privateDirectory(this.dir, false); privateFile(this.socketPath, { socket: true });
    if (this.fenced || !await this.connect() || !this.socket) throw fail('KEEPER_UNAVAILABLE', 'The selected legacy keeper is unavailable');
    if (this.metaVersion !== null) throw fail('KEEPER_PROCESS_CHANGED', 'The selected legacy keeper changed');
  }
  async _list() {
    await this._ready();
    if (this.attachListing) return this.attachListing;
    const reply = await KeeperLink.prototype.request.call(this, { t: 'list' }, 4000);
    if (!Array.isArray(reply.runs)) throw fail('KEEPER_METADATA_INCOMPLETE', 'Legacy keeper listing is unavailable');
    const live = reply.runs.filter((r) => !r.exit && [...this.manifest.values()].some((p) => p.runId === r.runId));
    if (!live.length) return reply.runs;
    let facts, failed;
    try { facts = await this.processSnapshot([this.keeperPid, ...live.map((r) => r.pid)]); }
    catch (_) {
      // Isolate a small batch where possible, with a hard per-listing budget.
      // Persistent ps denial costs at most three children, never N+1.
      failed = new Map(await Promise.all(live.slice(0, 2).map(async (row) => {
        try { return [row.runId, await this.processSnapshot([this.keeperPid, row.pid])]; }
        catch (error) { return [row.runId, error]; }
      })));
    }
    return reply.runs.map((row) => {
      const proof = this.manifest.get(row.key);
      if (row.exit || !proof || proof.runId !== row.runId) return row;
      let blocker;
      try {
        const snapshot = facts || failed.get(row.runId);
        if (!snapshot || snapshot instanceof Error) throw fail('KEEPER_PROCESS_UNPROVEN', 'Could not read legacy process identities');
        validateProof(proof.legacy, this, snapshot); uniqueRun(reply.runs, row, proof.legacy.build);
        if (row.pid !== proof.legacy.child.pid) throw fail('KEEPER_PROCESS_CHANGED', 'The kept child changed');
      } catch (e) { blocker = e.code || 'KEEPER_PROCESS_UNPROVEN'; }
      return { ...row, meta: proof.meta, legacy: proof.legacy, ...(proof.rescue ? { rescue: proof.rescue } : {}),
        directory: this.dir, ...(blocker ? { blocker } : {}) };
    });
  }
  _remember(runId, meta) {
    const prior = this.manifest.get(meta?.instance);
    if (!prior || prior.runId !== runId) throw fail('KEEPER_PROCESS_CHANGED', 'Borrowed run identity changed');
    super._remember(runId, meta);
  }
  send(msg) {
    // In particular, hydration/reconnect failures must never forget a live run:
    // every legacy build implements forget as stop + kill escalation.
    if (msg.t === 'spawn') return false;
    if (['kill', 'stop', 'end', 'forget'].includes(msg.t)) {
      const proc = this.procs.get(msg.runId);
      if (!proc || proc.released || proc.state !== 'kept') return false;
    }
    return super.send(msg);
  }
  async request(msg, ms) {
    if (msg.t === 'reclaim') {
      const proof = [...this.manifest.values()].find((p) => p.runId === msg.runId);
      if (!proof) return { ok: false, message: 'KEEPER_NOT_ELIGIBLE' };
      let rows;
      try { rows = await this._list(); }
      catch (_) { return { ok: false, message: 'keeper gone' }; }
      const row = rows.find((r) => r.runId === proof.runId);
      if (row?.blocker) return { ok: false, message: row.blocker };
      return KeeperLink.prototype.request.call(this, msg, ms);
    }
    if (msg.t === 'attach') {
      const proof = this.manifest.get(msg.key);
      if (!proof || proof.runId !== msg.runId) return { ok: false, message: 'KEEPER_NOT_ELIGIBLE' };
      return KeeperLink.prototype.request.call(this, { t: 'attach', key: msg.key, runId: msg.runId }, ms);
    }
    if (msg.guard || !['hello', 'list'].includes(msg.t)) return { ok: false, message: 'KEEPER_ATTACH_ONLY' };
    return KeeperLink.prototype.request.call(this, msg, ms);
  }
  // DaemonKeeper's attach performs the same checkpoint/schema/session checks
  // after _list has supplied the independently verified routing metadata.
  _lose(proc, why) {
    if (why === 'none') { proc.finish({ code: 0 }); return Promise.resolve(); }
    // Unknown exit never completes a Stop or authorizes a replacement. The
    // custodian still owns the original run; retain its pending controls.
    proc.state = 'pending'; this.procs.set(proc.runId, proc);
    this._block(proc.session, 'KEEPER_UNAVAILABLE');
    this.onBlocked?.(proc.session);
    return Promise.resolve();
  }
  forget(proc) {
    if (!proc.released && proc.exitCode === null && proc.signalCode === null) {
      // Explicit user Forget: retain the owner until the exit is observed,
      // then forget it. Otherwise the old script stops without an exit event
      // and this idle client would pin the keeper forever.
      this.send({ t: 'kill', runId: proc.runId, signal: 'SIGTERM' }); return;
    }
    super.forget(proc);
    this.disconnectIdle();
  }
}
module.exports = { LegacyKeeper };
