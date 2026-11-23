'use strict';
const path = require('path');
const { DaemonKeeper } = require('./daemonKeeper');
const { probeSocket } = require('./daemonLock');
const { hash } = require('./engineOwner');

// New runs always belong to our directory. A live source keeper is used only
// for the exact released run IDs in the reviewed transfer, never as a place
// to launch a replacement keeper after logout or reboot.
function createProductionKeeper({ root, store, sources, ownDirectory = path.join(root, 'keeper'),
  factory = (options) => options.legacy ? new (require('./legacyKeeper').LegacyKeeper)(options) : new DaemonKeeper(options), probe = probeSocket,
  retryMs = 10000 }) {
  const ownStore = { get: (_key, fallback) => store.get('nikd.keeper.owned.v1', fallback),
    update: (_key, value) => store.update('nikd.keeper.owned.v1', value) };
  const own = factory({ dir: ownDirectory, store: ownStore });
  const borrowed = [];
  const directories = [...new Set(sources.flatMap((s) => s.files.keepers || (s.files.keeper?.directory ? [s.files.keeper.directory] : [])))];
  for (const dir of directories.filter((d) => d !== ownDirectory)) {
    const namespace = 'nikd.keeper.source.' + hash(dir).slice(0, 12);
    const runs = sources.flatMap((s) => s.keeper?.transferred || []).filter((r) => !r.directory || r.directory === dir);
    if (!runs.length) continue;
    const prior = store.get(namespace);
    if (!prior) store.update(namespace, { version: 1, runs: structuredClone(runs) });
    else if (prior.version === 1 && Array.isArray(prior.runs)) {
      // Older manifests omitted meta1 PID custody evidence. Recover it only
      // from the same reviewed run, retaining newer saved routing metadata.
      const merged = prior.runs.map((saved) => ({ ...runs.find((r) => r.runId === saved.runId), ...saved }));
      if (JSON.stringify(merged) !== JSON.stringify(prior.runs)) store.update(namespace, { ...prior, runs: merged });
    }
    const scoped = { get: (_key, fallback) => store.get(namespace, fallback), update: (_key, value) => store.update(namespace, value) };
    borrowed.push(factory({ dir, store: scoped, existingOnly: true, legacy: runs.some((r) => r.legacy) }));
  }
  async function liveList(link) {
    if (link.drained) return [];
    if (!link.socket && await probe(link.socketPath) === 'absent') {
      const retained = [...link.manifest.values()].filter((r) => r.legacy && require('./daemonLock').pidState(r.legacy.child.pid) !== 'dead');
      return retained.map((r) => ({ ...r, key: r.meta.instance, pid: r.legacy.child.pid, owned: true, exit: null,
        directory: link.dir, blocker: 'KEEPER_UNAVAILABLE' }));
    }
    try { return await link._list(); }
    catch (e) {
      // Unavailability reserves only this link's known conversations. Startup,
      // unrelated spawns and Restore listing remain usable.
      return [...link.manifest.values()].map((r) => ({ ...r, key: r.meta.instance, pid: r.legacy?.child.pid || null,
        owned: true, exit: null, directory: link.dir, blocker: e.code || 'KEEPER_UNAVAILABLE' }));
    } finally { link.disconnectIdle?.(); }
  }
  const ownList = own._list.bind(own);
  own._list = async () => [...await ownList(), ...(await Promise.all(borrowed.map(liveList))).flat()
    .map((r) => ({ ...r, borrowed: true }))];
  const waiting = new Map(); let retryTimer, retrying, closed = false, attempts = 0;
  function armRetry() {
    if (!waiting.size) { clearTimeout(retryTimer); retryTimer = null; attempts = 0; }
    if (retrying || retryTimer) return;
    if (!closed && waiting.size && attempts < 3) {
      retryTimer = setTimeout(() => { retryTimer = null; attempts++; void retryBlocked(); }, retryMs * 2 ** attempts); retryTimer.unref?.();
    }
  }
  function blocked(session, incident = false) {
    if (!retrying && (incident || !waiting.has(session.id))) {
      attempts = 0; clearTimeout(retryTimer); retryTimer = null;
    }
    waiting.set(session.id, session); armRetry();
  }
  async function retryBlocked() {
    if (retrying) return retrying;
    retrying = (async () => {
      for (const [id, session] of waiting) {
        if (session.disposed && !session._stoppingProc) { waiting.delete(id); continue; }
        try {
          const stopping = session._stoppingProc;
          if (stopping?.stopRequested && stopping.state === 'pending') {
            await stopping.link._recover();
            if (stopping.exitCode !== null || stopping.signalCode !== null) waiting.delete(id);
            continue;
          }
          const result = await api.attach(session);
          if (result === true && stopping && session.proc !== stopping) {
            const replacement = session.proc;
            replacement.once('exit', (code, signal) => stopping.finish({ code, signal }));
            replacement.stdin.end();
          }
          if (result === true || result === false) {
            waiting.delete(id); session.elsewhere = false; session.attached?.();
          }
        } catch (_) { /* The lease stays held; retry after the probe recovers. */ }
      }
    })().finally(() => { retrying = null; armRetry(); });
    return retrying;
  }
  const api = {
    dir: own.dir, directories: [own.dir, ...borrowed.map((s) => s.dir)], links: [own, ...borrowed], metaVersion: 1,
    _list: () => own._list(),
    async beginAttach() {
      // One identity snapshot per restoration batch; never N+1 ps fallbacks.
      for (const link of borrowed) if (link instanceof require('./legacyKeeper').LegacyKeeper) {
        link.attachListing = await liveList(link);
      }
    },
    endAttach() { for (const link of borrowed) { link.attachListing = null; link.disconnectIdle?.(); } },
    spawner: () => own.spawner(),
    async attach(session) {
      const link = [own, ...borrowed].find((s) => s.manifest.has(session.id));
      if (!link) {
        for (const candidate of borrowed) if ((await liveList(candidate)).some((r) => !r.exit && r.key === session.id))
          return candidate._block(session, 'KEEPER_NOT_ELIGIBLE');
        return false;
      }
      const eligible = link.manifest.get(session.id);
      let runs;
      try { runs = await liveList(link); }
      catch (e) { return link._block ? link._block(session, e.code) : 'elsewhere'; }
      if (!runs.some((r) => r.runId === eligible.runId && r.key === session.id && !r.exit)) {
        // A keeper may have restarted at this directory after reboot. A
        // complete current listing proves the old run gone; do not turn its
        // stale manifest into a permanent "owned elsewhere" refusal.
        try { DaemonKeeper.prototype._check.call(link, eligible.meta, runs); }
        catch (e) { return link._block ? link._block(session, e.code) : 'elsewhere'; }
        delete session.keeperRefusal; return false;
      }
      // Legacy attach can retain an input-free lease when ps is temporarily
      // unavailable. A refusal never means the child may be replaced.
      const result = await link.attach(session);
      if (result === 'elsewhere' && ['KEEPER_OWNED_ELSEWHERE', 'KEEPER_PROCESS_UNPROVEN', 'KEEPER_UNAVAILABLE'].includes(session.keeperRefusal)) {
        blocked(session);
      } else { waiting.delete(session.id); armRetry(); }
      return result;
    },
    async request(message) {
      if (message.t !== 'list') throw Error('KEEPER_OPERATION_UNAVAILABLE');
      const rows = [...(!own.socket && await probe(own.socketPath) === 'absent' ? [] : await ownList()),
        ...(await Promise.all(borrowed.map(liveList))).flat()];
      // own._list includes borrowed rows for spawn exclusion. Export each run
      // once and retain its directory for a later exact handoff.
      return { ok: true, metaVersion: 1, runs: [...new Map(rows.map((r) => [r.runId, { ...r,
        directory: r.directory || ([own, ...borrowed].find((s) => s.manifest.get(r.key)?.runId === r.runId)?.dir || own.dir) }])).values()] };
    },
    retryBlocked,
    async close() { closed = true; clearTimeout(retryTimer); await retrying; await Promise.all([own, ...borrowed].map((s) => s.close())); }
  };
  for (const link of [own, ...borrowed]) link.onBlocked = (session) => blocked(session, true);
  return api;
}
module.exports = { createProductionKeeper };
