'use strict';
const path = require('path');
const { DaemonKeeper } = require('./daemonKeeper');
const { probeSocket } = require('./daemonLock');
const { hash } = require('./engineOwner');

// New runs always belong to our directory. A live source keeper is used only
// for the exact released run IDs in the reviewed transfer, never as a place
// to launch a replacement keeper after logout or reboot.
function createProductionKeeper({ root, store, sources, ownDirectory = path.join(root, 'keeper'), factory = (options) => new DaemonKeeper(options), probe = probeSocket }) {
  const ownStore = { get: (_key, fallback) => store.get('nikd.keeper.owned.v1', fallback),
    update: (_key, value) => store.update('nikd.keeper.owned.v1', value) };
  const own = factory({ dir: ownDirectory, store: ownStore });
  const borrowed = [];
  const directories = [...new Set(sources.flatMap((s) => s.files.keepers || (s.files.keeper?.directory ? [s.files.keeper.directory] : [])))];
  for (const dir of directories.filter((d) => d !== ownDirectory)) {
    const namespace = 'nikd.keeper.source.' + hash(dir).slice(0, 12);
    const runs = sources.flatMap((s) => s.keeper?.transferred || []).filter((r) => !r.directory || r.directory === dir);
    if (!store.get(namespace)) store.update(namespace, { version: 1, runs: runs.map(({ runId, meta }) => ({ runId, meta })) });
    const scoped = { get: (_key, fallback) => store.get(namespace, fallback), update: (_key, value) => store.update(namespace, value) };
    borrowed.push(factory({ dir, store: scoped, existingOnly: true }));
  }
  async function liveList(link) {
    if (!link.socket && await probe(link.socketPath) === 'absent') return [];
    return link._list();
  }
  const ownList = own._list.bind(own);
  own._list = async () => [...await ownList(), ...(await Promise.all(borrowed.map(liveList))).flat()];
  return {
    dir: own.dir, directories: [own.dir, ...borrowed.map((s) => s.dir)], metaVersion: 1,
    spawner: () => own.spawner(),
    async attach(session) {
      const link = [own, ...borrowed].find((s) => s.manifest.has(session.id));
      if (!link) return false;
      if (!link.socket && await probe(link.socketPath) === 'absent') return false;
      const eligible = link.manifest.get(session.id), runs = await liveList(link);
      if (!runs.some((r) => r.runId === eligible.runId && r.key === session.id && !r.exit)) {
        // A keeper may have restarted at this directory after reboot. A
        // complete current listing proves the old run gone; do not turn its
        // stale manifest into a permanent "owned elsewhere" refusal.
        try { DaemonKeeper.prototype._check.call(link, eligible.meta, runs); }
        catch (e) { return link._block ? link._block(session, e.code) : 'elsewhere'; }
        delete session.keeperRefusal; return false;
      }
      return link.attach(session);
    },
    async request(message) {
      if (message.t !== 'list') throw Error('KEEPER_OPERATION_UNAVAILABLE');
      const rows = [...await liveList(own), ...(await Promise.all(borrowed.map(liveList))).flat()];
      // own._list includes borrowed rows for spawn exclusion. Export each run
      // once and retain its directory for a later exact handoff.
      return { ok: true, metaVersion: 1, runs: [...new Map(rows.map((r) => [r.runId, { ...r,
        directory: r.directory || ([own, ...borrowed].find((s) => s.manifest.get(r.key)?.runId === r.runId)?.dir || own.dir) }])).values()] };
    },
    async close() { await Promise.all([own, ...borrowed].map((s) => s.close())); }
  };
}
module.exports = { createProductionKeeper };
