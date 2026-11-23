'use strict';
const fs = require('fs'), path = require('path');
const { privateRoot, privateFile, readPrivateJson, fail } = require('./daemonPaths');
const { acquireRootLock, probeSocket } = require('./daemonLock');
const { hash, atomicJson } = require('./engineOwner');
const { createParticipantGate } = require('./engineTransfer');
const { saveExport, readExport } = require('./cutoverRecovery');

async function offlineKeeperRuns(link, proofs, { timeoutMs = 1500 } = {}) {
  let timer;
  try {
    const listing = await Promise.race([(async () => {
      if (!await link.connect()) throw fail('KEEPER_UNAVAILABLE', 'Current keeper is unavailable');
      return link instanceof require('./legacyKeeper').LegacyKeeper ? { runs: await link._list() }
        : await link.request({ t: 'list' }, timeoutMs);
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('KEEPER_UNAVAILABLE', 'Keeper listing timed out')), timeoutMs); })]);
    if (!Array.isArray(listing.runs)) throw fail('KEEPER_METADATA_INCOMPLETE', 'Current keeper listing is unavailable');
    return listing.runs;
  } catch (e) {
    // Restore retains each exact imported proof as a blocked lease. Missing
    // replies cannot prove an exit, authorize input, or permit a second run.
    link.closed = true; link.socket?.destroy();
    return proofs.map((proof) => ({ ...proof, key: proof.key || proof.meta.instance,
      pid: proof.pid || proof.legacy?.child.pid, exit: null, owned: true, lease: 'blocked',
      blocker: e.code || 'KEEPER_UNAVAILABLE' }));
  } finally { clearTimeout(timer); }
}

async function offlineProductionExport({ selection, owner, importer, transition, holdLease, keeperSnapshot, tailscale }) {
  const saved = importer.snapshot(), record = saved.records.find((r) => r.id === saved.current);
  const store = require('./keychainStore').createKeychainStore({ adapter: importer.secretAdapter, account: record.account });
  const cache = path.join(selection.root, 'production-return-export.json');
  let lease, authority;
  const links = [];
  try {
    const paths = privateRoot(selection.root, { create: false });
    // Keep the service root until the coordinator publishes the window
    // generation. A launchd retry cannot enter between export and release.
    lease = await acquireRootLock(paths);
    if (privateFile(cache, { optional: true })) {
      const encrypted = readPrivateJson(cache);
      if (encrypted.binding.transition === transition.token) {
        const value = readExport(cache, importer.secretAdapter, transition.token);
        if (holdLease) { holdLease(lease); lease = null; }
        return value;
      }
    }
    // Acquiring the service root proves its recorded process is dead and its
    // endpoint absent. The owner barrier prevents another provider boot.
    let current = structuredClone(record.state), currentSettings, queueImportPending = false, globals;
    const authorityFile = path.join(paths.state, 'authority.jsonl');
    const neverActivated = !privateFile(authorityFile, { optional: true });
    if (!neverActivated) {
      authority = await require('./jsonlAuthority').openAuthority({ file: authorityFile, readOnly: true });
      if (authority.status().issue) throw fail('CURRENT_STATE_EXPORT_REQUIRED', 'Current receipt authority is unavailable');
      const snapshot = authority.inspect().state, domain = snapshot.values[require('./engineState').DOMAIN];
      const checkpointFile = path.join(selection.root, 'production-state-generation.json');
      const checkpoint = privateFile(checkpointFile, { optional: true }) ? readPrivateJson(checkpointFile) : null;
      queueImportPending = !record.state.completeAuthority && checkpoint?.generation === record.receipt.generation &&
        checkpoint.legacyQueueBarrier === true && snapshot.values['engine.legacyImportComplete.v1'] !== record.id;
      current.authority = snapshot; current.completeAuthority = !queueImportPending; currentSettings = domain.settings;
      current.instances = domain.instances.map((instance) => ({ ...instance, queue: snapshot.outbox.filter((q) =>
        q.state === 'queued' && q.target === 'session:' + instance.id).map((q) => ({ id: q.queueId, text: q.payload.message.text,
          sent: q.payload.message.sent ?? null, snippets: q.payload.message.snippets || [], attachments: q.payload.message.attachments || [] })) }));
      if (queueImportPending) for (const queue of record.state.queues) for (const item of queue.items) {
        const mid = hash([record.id, queue.instance, item.id]).slice(0, 32);
        const registered = snapshot.outbox.some((q) => q.queueId === item.id || q.mid === mid) ||
          snapshot.entries.some((r) => r.principal === 'local:legacy' && r.mid === mid);
        const instance = current.instances.find((s) => s.id === queue.instance);
        if (!registered && instance && !instance.queue.some((q) => q.id === item.id)) instance.queue.push(structuredClone(item));
      }
      current.queues = current.instances.map((s) => ({ instance: s.id, items: s.queue, hash: hash(s.queue) }));
      for (const source of current.sources) {
        source.account = { limits: domain.account.limits, pause: domain.account.pause, limitOverride: domain.account.limitOverride };
        source.folders = domain.folders;
      }
      const ledgerFile = path.join(paths.state, 'ledger.json');
      if (privateFile(ledgerFile, { optional: true })) current.ledger = readPrivateJson(ledgerFile);
      const globalFile = path.join(paths.state, 'global.json');
      if (privateFile(globalFile, { optional: true })) {
        const values = readPrivateJson(globalFile).values; globals = values;
        for (const source of current.sources) source.global = Object.fromEntries(Object.entries(values).filter(([key]) => require('./engineTransfer').GLOBAL_KEYS.includes(key)));
      }
    }
    const directories = [...new Set([path.join(selection.root, 'keeper'), ...record.transfer.sources.flatMap((s) =>
      s.state.files.keepers || (s.state.files.keeper?.directory ? [s.state.files.keeper.directory] : []))])];
    const runs = [];
    for (const directory of directories) {
      const socket = path.join(directory, 'k1.sock');
      const original = record.transfer.sources.flatMap((s) => s.state.keeper?.transferred || []).filter((r) => r.directory === directory);
      const namespace = directory === path.join(selection.root, 'keeper') ? 'nikd.keeper.owned.v1'
        : 'nikd.keeper.source.' + hash(directory).slice(0, 12);
      const proofs = globals?.[namespace]?.runs || original;
      if (await probeSocket(socket) === 'absent') {
        for (const proof of proofs) if (proof.legacy && require('./daemonLock').pidState(proof.legacy.child.pid) !== 'dead')
          runs.push({ ...proof, key: proof.key || proof.meta.instance, pid: proof.legacy.child.pid, directory,
            owned: true, exit: null, lease: 'blocked', blocker: 'KEEPER_UNAVAILABLE' });
        continue;
      }
      const legacy = proofs.some((r) => r.legacy);
      const memory = { version: 1, runs: proofs };
      const link = legacy ? new (require('./legacyKeeper').LegacyKeeper)({ dir: directory,
        store: { get: () => memory, update() {} }, ...(keeperSnapshot ? { processSnapshot: keeperSnapshot } : {}) }) : new (require('./keeperLink').KeeperLink)({ dir: directory, existingOnly: true }); links.push(link);
      const listing = await offlineKeeperRuns(link, proofs);
      let rescueStatus;
      for (const row of listing) {
        // An R29 manifest or a failed save can predate the custodian. Its
        // private endpoint can prove exact current custody independently.
        const rescueSocket = require('./keeperRescue').socketFor(directory);
        if (!row.rescue && privateFile(rescueSocket, { socket: true, optional: true })) row.rescue = { socket: rescueSocket };
        if (row.rescue && row.owned) {
          try {
            const status = rescueStatus ||= await require('./keeperRescue').rescueRequest({ ...row, directory }, 'status');
            if (status.held.includes(row.runId)) row.lease = 'rescue';
          } catch (_) { row.lease = 'blocked'; row.blocker ||= 'KEEPER_UNAVAILABLE'; }
        }
        runs.push({ ...row, directory });
      }
    }
    const keeper = { metaVersion: 1, runs, transferred: runs.filter((r) => !r.exit && current.instances.some((s) => s.id === r.key))
      .map((r) => ({ ...r, released: !r.owned || r.lease === 'rescue' || r.lease === 'blocked', compatible: true })) };
    const routeState = await require('./routeContinuity').transferableRoutes(tailscale || new (require('./tunnel').Tailscale)(),
      require('./routeContinuity').transferredRoutes(record.state.sources));
    const gate = createParticipantGate({ owner, member: importer.member() });
    const exported = await gate.quiesce(transition.token, {
      closeAdmission() {}, cancel() {}, drain() {}, flush() {}, detach() {},
      releaseResources: () => ({ released: true, owned: [], offline: true }),
      exportState() {
        const value = importer.exportCurrent({ transition: transition.token, currentState: current,
          provenance: { profile: record.transfer.scope.profile, workspace: selection.root, rawScope: 'offline-current' }, keeper });
        const snapshots = path.join(paths.state, 'current-snapshots.json');
        const original = current.sources.flatMap((s) => s.files.sessions || []);
        const latest = privateFile(snapshots, { optional: true }) ? readPrivateJson(snapshots).sessions : [];
        // Transcript checkpoints can lag metadata/outbox commits. Never let
        // a stale snapshot resurrect a prompt already sent or deleted.
        value.files.sessions = [...new Map([...original, ...latest].map((s) => [s.id, s])).values()]
          .filter((s) => current.instances.some((i) => i.id === s.id)).map((s) => ({ ...s,
            ...structuredClone(current.instances.find((i) => i.id === s.id)) }));
        value.files.workspaces = structuredClone(record.state.sources);
        if (currentSettings) value.settings = currentSettings;
        value.files.keepers = directories; value.files.routes = routeState.routes; value.files.routeWarnings = routeState.warnings;
        value.files.neverActivated = neverActivated || queueImportPending;
        value.fileHashes = Object.fromEntries(Object.entries(value.files).map(([key, value]) => [key, hash(value)])); return value;
      },
      saveExport: (value) => saveExport(cache, value, importer.secretAdapter, transition.token)
    });
    if (holdLease) { holdLease(lease); lease = null; }
    return exported;
  } finally { store.dispose(); await authority?.close(); await Promise.all(links.map((s) => s.close())); lease?.release(); }
}
module.exports = { offlineProductionExport, offlineKeeperRuns };
