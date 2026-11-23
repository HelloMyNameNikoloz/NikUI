'use strict';

// Compatibility is tied to bytes, not an optimistic protocol-1 guess. These
// immutable scripts are retained verbatim in test/fixtures/keepers.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFile } = require('child_process');
const { privateDirectory, privateFile, fail } = require('./daemonPaths');
const { sessionMeta } = require('./keeperLink');
const BUILDS = Object.freeze({
  db9409823c19: { sha256: 'db9409823c199a9c3610a6821d604d2bc0a08b81c166bd04ccc5e4ef950ed24e', reclaim: true, exactAttach: false },
  d7129af02c46: { sha256: 'd7129af02c465e22915c53e90cc7f6992bd95cb18b3e1c03eeed45617945ef9f', reclaim: true, exactAttach: false },
  c4fa098ac301: { sha256: 'c4fa098ac301630539705122ff23f65669026508676541c6516e3af89e184978', reclaim: true, exactAttach: false },
  '4c273e3d137f': { sha256: '4c273e3d137f6bd5b9d78a017b89bb9b150a2cb43b4c58c1429cf10133d3d2f1', reclaim: false, exactAttach: false },
  '6fecfe9d10d8': { sha256: '6fecfe9d10d80d57d1fc2d678b4fd29d058df2a36e741731b0e810366e5cada3', reclaim: false, exactAttach: true }
});
const insist = (value, code = 'KEEPER_LEGACY_UNPROVEN') => { if (!value) throw fail(code, code); };
function processSnapshot(pids, run = execFile) {
  if (!pids.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    try { run('/bin/ps', ['-ww', '-p', [...new Set(pids)].join(','), '-o', 'pid=,ppid=,lstart=,command='],
    { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
    (error, stdout) => {
      if (error && error.code !== 1) return reject(fail('KEEPER_PROCESS_UNPROVEN', 'Could not read keeper process identities'));
      const rows = new Map();
      for (const line of String(stdout || '').split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
        if (match) rows.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]),
          started: match[3].replace(/\s+/g, ' '), command: match[4] });
      }
      resolve(rows);
    }); } catch (_) { reject(fail('KEEPER_PROCESS_UNPROVEN', 'Could not read keeper process identities')); }
  });
}
const sameProcess = (a, b) => a && b && a.pid === b.pid && a.started === b.started && a.command === b.command;
function keeperIdentity(link, facts) {
  privateDirectory(link.dir, false); privateFile(link.socketPath, { socket: true });
  const keeper = facts.get(link.keeperPid);
  insist(keeper, 'KEEPER_PROCESS_UNPROVEN');
  const build = Object.keys(BUILDS).find((id) => keeper.command.endsWith(' ' + path.join(link.dir, 'keeper-' + id + '.js') + ' ' + link.socketPath));
  insist(build, 'KEEPER_LEGACY_BUILD_UNSUPPORTED');
  const script = path.join(link.dir, 'keeper-' + build + '.js'); privateFile(script);
  insist(crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex') === BUILDS[build].sha256, 'KEEPER_LEGACY_BUILD_UNSUPPORTED');
  return { version: 1, build, keeper };
}
function validateProof(proof, link, facts) {
  insist(proof?.version === 1 && BUILDS[proof.build], 'KEEPER_LEGACY_BUILD_UNSUPPORTED');
  const identity = keeperIdentity(link, facts);
  insist(identity.build === proof.build && sameProcess(identity.keeper, proof.keeper), 'KEEPER_PROCESS_CHANGED');
  insist(sameProcess(proof.child, facts.get(proof.child?.pid)) && facts.get(proof.child.pid).parent === proof.keeper.pid, 'KEEPER_PROCESS_CHANGED');
  return proof;
}
function uniqueRun(runs, run, build) {
  insist(run && typeof run.runId === 'string' && typeof run.key === 'string' && typeof run.owned === 'boolean' && run.exit === null);
  // The key-only versions choose a run themselves. With one row for that key
  // their selection is unambiguous; never send runId and assume it is honored.
  insist(BUILDS[build].exactAttach || runs.filter((r) => r.key === run.key).length === 1, 'KEEPER_LEGACY_AMBIGUOUS');
}
async function captureKeeper(link, sessions, { snapshot = link.processSnapshot || processSnapshot, released = false, allowBlocked = false } = {}) {
  if (link.links) {
    const states = await Promise.all(link.links.map(async (child) => {
      const selected = sessions.filter((s) => s.proc?.link === child || child.manifest?.has(s.id));
      try { return await captureKeeper(child, selected, { snapshot: child.processSnapshot || snapshot, released, allowBlocked }); }
      catch (e) { e.sessions ||= selected; throw e; }
    }));
    return { metaVersion: 1, runs: states.flatMap((s) => s.runs), transferred: states.flatMap((s) => s.transferred),
      ...(states.some((s) => s.legacyInventory) ? { legacyInventory: states.flatMap((s) => s.legacyInventory || []) } : {}) };
  }
  if (link instanceof require('./legacyKeeper').LegacyKeeper) {
    const listing = await link._list();
    const transferred = listing.filter((r) => !r.exit && sessions.some((s) => s.id === r.key) && link.manifest.has(r.key)).map((r) => {
      if (r.blocker && !allowBlocked) throw fail(r.blocker, 'Keeper proof failed for this run');
      return { ...r, rescue: link.manifest.get(r.key).rescue, released, compatible: true };
    });
    return { metaVersion: 1, runs: transferred, transferred,
      legacyInventory: [{ directory: link.dir, runs: listing.filter((r) => !r.exit) }] };
  }
  const kept = sessions.filter((s) => s.proc?.kept && !s.proc.released);
  if (!kept.length && !link.socket) {
    if (!link.existingOnly || !fs.existsSync(link.socketPath)) return { metaVersion: 1, runs: [], transferred: [] };
    insist(await link.connect(), 'KEEPER_UNAVAILABLE');
  }
  if (link.metaVersion !== 1) insist(link.socket && !link.socket.destroyed && Number.isSafeInteger(link.keeperPid), 'KEEPER_METADATA_INCOMPLETE');
  const listing = await link.request({ t: 'list' }, 4000);
  insist(Array.isArray(listing.runs), 'KEEPER_METADATA_INCOMPLETE');
  if (listing.runs.some((r) => r.blocker && kept.some((s) => s.proc.runId === r.runId)))
    throw fail(listing.runs.find((r) => r.blocker).blocker, 'Keeper proof failed for this run');
  if (!kept.length && link.metaVersion !== 1) {
    link.disconnectIdle?.();
    return { metaVersion: 1, runs: [], transferred: [],
      legacyInventory: [{ directory: link.dir, runs: listing.runs.filter((r) => !r.exit) }] };
  }
  if (link.metaVersion === 1) return { metaVersion: 1, runs: listing.runs,
    transferred: kept.map((session) => {
      const row = listing.runs.find((r) => r.runId === session.proc.runId && r.key === session.id);
      insist(row && row.meta?.instance === session.id && row.meta.cwd === session.cwd &&
        row.meta.conversation === (session.claudeSessionId || null), 'KEEPER_METADATA_INCOMPLETE');
      return { ...row, keeperPID: link.keeperPid, ...(link.capabilities?.retainCustody ? { keeperCustody: true } : {}),
        directory: row.directory || session.proc.link?.dir || link.dir, released, compatible: true };
    }) };
  const facts = await snapshot([link.keeperPid, ...kept.map((s) => s.proc.pid)]), identity = keeperIdentity(link, facts);
  const transferred = kept.map((session) => {
    const row = listing.runs.find((r) => r.runId === session.proc.runId && r.key === session.id);
    uniqueRun(listing.runs, row, identity.build);
    const child = facts.get(row.pid);
    insist(child && child.pid === session.proc.pid && child.parent === identity.keeper.pid, 'KEEPER_PROCESS_UNPROVEN');
    return { ...row, meta: sessionMeta(session), directory: link.dir, released, compatible: true,
      legacy: { ...identity, child } };
  });
  return { metaVersion: 1, runs: transferred, transferred,
    legacyInventory: [{ directory: link.dir, runs: listing.runs.filter((r) => !r.exit) }] };
}
async function releaseKeeper(link, sessions, options = {}) {
  // Capture while the source still owns the exact KeptProc. release/checkpoint
  // and this same socket's list form an ordered acknowledgement.
  const captured = await captureKeeper(link, sessions, { ...options, allowBlocked: true });
  for (const proof of captured.transferred) {
    const session = sessions.find((s) => s.id === proof.key);
    if (session?.snapshot) proof.checkpointBytes = Buffer.byteLength(JSON.stringify(session.snapshot()));
  }
  const registrations = [];
  try {
    await require('./keeperRescue').protectReleased(captured, { registrations });
    for (const proof of captured.transferred.filter((r) => r.keeperCustody)) {
      const owner = (link.links || [link]).find((child) => child.dir === proof.directory);
      const reply = await owner.request({ t: 'retain', runId: proof.runId }, 2000);
      insist(reply.ok && reply.runId === proof.runId, 'KEEPER_UNAVAILABLE');
    }
    for (const session of sessions) if (session.proc?.kept) session.detach();
    if (!captured.transferred.length) return captured;
    const listing = await link.request({ t: 'list' }, 4000);
    insist(Array.isArray(listing.runs), 'KEEPER_METADATA_INCOMPLETE');
    const transferred = captured.transferred.flatMap((proof) => {
      const row = listing.runs.find((r) => r.runId === proof.runId && r.key === proof.key);
      if (!row || row.exit) return []; // completed naturally during release
      insist(row.pid === proof.pid && (!row.owned || proof.rescue), 'KEEPER_OWNED_ELSEWHERE');
      return [{ ...proof, owned: row.owned, released: true }];
    });
    for (const proof of transferred.filter((r) => r.rescue)) {
      // Each run has its own size-scaled deadline. A sequential inventory of
      // eleven checkpoints cannot spend one shared eight-second budget.
      const status = await require('./keeperRescue').rescueRequest(proof, 'check');
      if (!status.runs.some((r) => r.runId === proof.runId)) { transferred.splice(transferred.indexOf(proof), 1); continue; }
      insist(status.held.includes(proof.runId), 'KEEPER_CUSTODY_PENDING');
      proof.owned = true; proof.lease = 'rescue';
    }
    const known = new Map(transferred.map((r) => [r.runId, r]));
    return { metaVersion: 1, runs: captured.legacyInventory ? transferred : listing.runs.map((r) => known.get(r.runId) || r), transferred,
      ...(captured.legacyInventory ? { legacyInventory: captured.legacyInventory.map(({ directory }) => ({ directory,
        runs: listing.runs.filter((r) => !r.exit && (!r.directory || r.directory === directory)) })) } : {}) };
  } finally { for (const socket of registrations) socket.end(); }
}
function keeperProblem(code, sessions) {
  const chats = sessions.filter((s) => s.proc?.kept).map((s) => ({ id: s.id, name: s.customTitle || s.label || s.id }));
  if (code.startsWith('KEEPER_RESCUE_SUPERVISION_')) return { code, chats,
    message: `Legacy chat custody needs repair for ${chats.map((s) => '“' + s.name + '”').join(', ')} (${code}). Keep their current owner open. Repair NikUI or its private custody files, then choose Retry Custody in the Mac app. Recovery proofs are retained.` };
  return { code, chats, message: `Cannot safely attach to the keeper for ${chats.map((s) => '“' + s.name + '”').join(', ')} (${code}). Stop these ${chats.length} running chats, then Refresh.` };
}
module.exports = { BUILDS, processSnapshot, sameProcess, keeperIdentity, validateProof, uniqueRun, captureKeeper, releaseKeeper, keeperProblem };
