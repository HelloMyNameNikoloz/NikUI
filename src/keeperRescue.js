'use strict';

// Immutable keepers need a persistent connection to avoid their orphan kill.
// Hold it once and change only the downstream driver. No periodic inventory.
const fs = require('fs'), path = require('path'), net = require('net');
const { KeeperLink } = require('./keeperLink');
const { controlRequest } = require('./daemonControl');
const { privateDirectory, privateFile, fail } = require('./daemonPaths');
const { probeSocket } = require('./daemonLock');
const socketFor = (directory) => path.join(directory, 'r1.sock');
const stateFor = (directory) => path.join(directory, 'r1-state.json');
const custodyTimeout = (proof) => 8000 + Math.min(120000, Math.ceil((proof.checkpointBytes || 0) / (1024 * 1024)) * 1000);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function rescueRequest(proof, op, extra = {}) {
  if (!proof.rescue) return { ok: true, held: [], runs: [] };
  if (proof.rescue.socket !== socketFor(proof.directory)) throw fail('KEEPER_RESCUE_INVALID', 'Custody directory changed');
  const reply = await controlRequest({ socket: proof.rescue.socket }, { op, runId: proof.runId, ...extra },
    { timeoutMs: op === 'check' ? custodyTimeout(proof) + 4000 : 8000, maxReplyBytes: 4 * 1024 * 1024 });
  if (!reply?.ok || reply.custodyVersion !== 1) throw fail(reply?.code || 'KEEPER_RESCUE_UNAVAILABLE', 'Custody was not acknowledged');
  return reply;
}
function registerHeld(proof, proofs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proof.rescue.socket); let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(fail('KEEPER_UNAVAILABLE', 'Custody registration timed out')); }, 8000);
    socket.on('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ op: 'add', proofs, hold: true }) + '\n'));
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      try {
        const reply = JSON.parse(data);
        if (!reply.ok || reply.custodyVersion !== 1) throw fail('KEEPER_UNAVAILABLE', 'Custody registration failed');
        resolve(socket);
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.once('close', () => { clearTimeout(timer); reject(fail('KEEPER_UNAVAILABLE', 'Custody registration closed')); });
  });
}
async function protectReleased(captured, { registrations, statuses } = {}) {
  const groups = new Map();
  for (const proof of captured.transferred || []) if (proof.legacy || proof.rescue || proof.keeperPID && !proof.keeperCustody) {
    proof.rescue = { socket: socketFor(proof.directory) };
    if (!groups.has(proof.directory)) groups.set(proof.directory, []);
    groups.get(proof.directory).push(proof);
  }
  for (const [directory, proofs] of groups) {
    try { privateDirectory(directory, false); }
    catch (_) { throw fail('KEEPER_RESCUE_SUPERVISION_DIRECTORY_UNAVAILABLE', 'The private custody directory is missing or unsafe'); }
    const ping = async () => {
      if (registrations) return registrations.push(await registerHeld(proofs[0], proofs));
      const status = await rescueRequest(proofs[0], 'add', { proofs }); statuses?.push(status); return status;
    };
    try { await ping(); continue; } catch (_) { /* Source still owns its runs. */ }
    const failure = require('./keeperSupervisor').startupFailure(directory);
    if (failure?.terminal) throw fail(failure.code, 'Custody startup needs repair before these chats can move');
    privateDirectory(directory, false);
    const socket = socketFor(directory), entry = privateFile(socket, { socket: true, optional: true });
    if (entry) {
      if (await probeSocket(socket) !== 'absent') throw fail('KEEPER_RESCUE_UNAVAILABLE', 'Custody endpoint is busy or incompatible');
      const current = privateFile(socket, { socket: true, optional: true });
      if (current?.ino === entry.ino && current.dev === entry.dev) fs.unlinkSync(socket);
    }
    await module.exports.supervise(directory);
    const deadline = Date.now() + 5000; let registered = false;
    do {
      await pause(40);
      try { await ping(); registered = true; break; } catch (_) { /* Finite startup only. */ }
    } while (Date.now() < deadline);
    if (!registered) throw fail('KEEPER_RESCUE_UNAVAILABLE', 'Could not retain legacy custody');
  }
  return captured;
}

async function serveRescue(directory, { factory = (dir) => new KeeperLink({ dir, existingOnly: true, attachOnly: true, connectTimeoutMs: 30000 }), deadline = custodyTimeout,
  retryMs = 250, maxRetryMs = 30000, listTimeoutMs = 2000 } = {}) {
  privateDirectory(directory, false);
  const link = factory(directory), records = new Map(), held = new Set(), clients = new Set();
  let closed = false, closing, startup, takeover, recoveryTimer, retry = 0, listing, blocker, stateUnavailable = false, lane = Promise.resolve();
  const previousFailure = require('./keeperSupervisor').startupFailure(directory)?.code;
  if (['KEEPER_RESCUE_SUPERVISION_STATE_UNAVAILABLE', 'KEEPER_RESCUE_SUPERVISION_PROOF_INVALID',
    'KEEPER_RESCUE_SUPERVISION_PROCESS_CHANGED'].includes(previousFailure)) blocker = previousFailure;
  const degraded = (code) => { blocker = code; require('./keeperSupervisor').writeFailure(directory, code); };
  function settleBlocker() {
    const problem = stateUnavailable ? 'KEEPER_RESCUE_SUPERVISION_STATE_UNAVAILABLE' :
      [...records.values()].some((r) => r.invalid) ? 'KEEPER_RESCUE_SUPERVISION_PROOF_INVALID' :
        [...records.values()].find((r) => r.problem)?.problem;
    if (problem) { if (problem !== blocker) degraded(problem); return; }
    if (blocker) {
      try {
        const supervisor = require('./keeperSupervisor');
        if (supervisor.startupFailure(directory)?.code === blocker) fs.unlinkSync(supervisor.failureFor(directory));
      } catch (_) { /* Storage may still be unavailable; the live status remains authoritative. */ }
      blocker = null;
    }
  }
  const persist = () => {
    try {
      require('./engineOwner').atomicJson(stateFor(directory), { version: 1, proofs: [...records.values()].map((r) => r.proof) });
      stateUnavailable = false; settleBlocker();
    }
    catch (error) { stateUnavailable = true; degraded('KEEPER_RESCUE_SUPERVISION_STATE_UNAVAILABLE'); throw error; }
  };
  const validProof = (proof) => proof && proof.directory === directory && Number.isSafeInteger(proof.legacy?.keeper?.pid || proof.keeperPID) &&
    proof.key === proof.meta?.instance && Number.isSafeInteger(proof.pid) && typeof proof.runId === 'string';
  if (privateFile(stateFor(directory), { optional: true })) {
    const saved = require('./daemonPaths').readPrivateJson(stateFor(directory));
    if (saved.version !== 1 || !Array.isArray(saved.proofs)) throw fail('KEEPER_RESCUE_SUPERVISION_PROOF_INVALID', 'Saved custody proof is invalid');
    for (const [index, proof] of saved.proofs.entries()) {
      const invalid = !validProof(proof) || records.has(proof.runId);
      records.set(invalid ? 'invalid-' + index : proof.runId, { proof, owner: null, invalid });
      if (invalid) degraded('KEEPER_RESCUE_SUPERVISION_PROOF_INVALID');
    }
  }
  const serial = (fn) => { const result = lane.then(() => fn()); lane = result.catch(() => {}); return result; };
  const status = () => ({ ok: true, custodyVersion: 1, pid: process.pid,
    held: [...held].filter((id) => !records.get(id)?.owner), adopting: [...records].filter(([, r]) => r.adopting).map(([id]) => id),
    unverified: [...records].filter(([id, r]) => !held.has(id) || r.invalid || r.problem).map(([id]) => id), ...(blocker ? { blocker } : {}),
    runs: [...records.values()].map((r) => r.proof) });
  const send = (client, message) => {
    if (!client || client.socket.destroyed) return;
    if (client.socket.writableLength > 32 * 1024 * 1024) { client.socket.destroy(); return; }
    client.socket.write(JSON.stringify(message) + '\n');
  };
  const retire = () => { if (!records.size) setImmediate(() => { if (!records.size) void close().catch(() => {
    require('./keeperSupervisor').writeFailure(directory, 'KEEPER_RESCUE_SUPERVISION_CLEANUP');
  }); }); };
  const saveAndRetire = () => { try { persist(); } finally { retire(); } };
  const needsRecovery = () => [...records].some(([id, r]) => !held.has(id) && !r.foreign);
  function recoverLater() {
    if (closed || recoveryTimer || !needsRecovery()) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void serial(inventory).catch(() => {}).finally(recoverLater);
    }, Math.min(maxRetryMs, retryMs * 2 ** Math.min(retry++, 12)));
  }
  const dispatch = link._dispatch.bind(link);
  link._dispatch = (message) => {
    dispatch(message);
    const record = records.get(message.runId);
    if (!record || message.t === 'reply') return;
    if (record.queue) record.queue.push(message); else send(record.owner, message);
    if (message.t === 'exit') {
      link.send({ t: 'forget', runId: message.runId });
      records.delete(message.runId); held.delete(message.runId);
      try { saveAndRetire(); } catch (_) { /* Retirement survives deleted/unwritable storage. */ }
    }
  };
  // Upstream failure is a crash event, never an idle poll. Downstream links
  // reconnect from exact manifests; a borrowed keeper is never spawned.
  link._recover = () => {
    held.clear(); listing = null;
    for (const record of records.values()) delete record.adopting;
    for (const client of clients) client.socket.destroy();
    for (const [id, record] of records) {
      record.foreign = false;
      if (!record.invalid && require('./daemonLock').pidState(record.proof.pid) === 'dead') records.delete(id);
    }
    try { saveAndRetire(); } catch (_) { /* Preserve recovery state. */ }
    return records.size ? serial(inventory).catch(() => {}).finally(recoverLater) : Promise.resolve();
  };
  async function inventory(only) {
    // An earlier observation of a foreign owner is not a current ownership
    // proof when this check fails (the source may have released meanwhile).
    for (const [id, record] of records) if (!only || id === only) record.foreign = false;
    if (!await link.connect()) {
      const keepers = [...records.values()].filter((r) => !r.invalid).map((r) => r.proof.legacy?.keeper.pid || r.proof.keeperPID);
      if (await probeSocket(link.socketPath || path.join(directory, 'k1.sock')) === 'absent' &&
          keepers.length === records.size && keepers.every((pid) => require('./daemonLock').pidState(pid) === 'dead')) {
        records.clear(); held.clear(); saveAndRetire();
      }
      throw fail('KEEPER_UNAVAILABLE', 'Legacy keeper is unavailable');
    }
    // Keep a slow request on its original connection. Cancelling every list
    // after two seconds would make a consistently slow keeper unrecoverable.
    if (!listing || listing.socket !== link.socket) {
      const pending = listing = { socket: link.socket, reply: null };
      pending.promise = link.request({ t: 'list' }).then((reply) => {
        pending.reply = reply;
        if (pending.timedOut && !closed && listing === pending) void serial(inventory).catch(() => {}).finally(recoverLater);
        return reply;
      });
    }
    const pending = listing; let listTimer;
    const reply = pending.reply || await Promise.race([pending.promise, new Promise((resolve) => {
      listTimer = setTimeout(() => resolve({}), listTimeoutMs);
    })]);
    clearTimeout(listTimer);
    if (!pending.reply) pending.timedOut = true;
    else if (listing === pending) listing = null;
    if (!Array.isArray(reply.runs)) throw fail('KEEPER_UNAVAILABLE', 'Legacy keeper did not answer');
    for (const [id, record] of records) {
      if (only && id !== only) continue;
      if (record.invalid) continue;
      const proof = record.proof, row = reply.runs.find((r) => r.runId === id);
      if (link.keeperPid !== (proof.legacy?.keeper.pid || proof.keeperPID) || row && (row.pid !== proof.pid || row.key !== proof.key)) {
        record.foreign = false; record.problem = 'KEEPER_RESCUE_SUPERVISION_PROCESS_CHANGED'; degraded(record.problem); continue;
      }
      delete record.problem;
      if (!row || row.exit) {
        send(record.owner, { t: 'exit', runId: id, exit: row?.exit || { code: 0 } });
        records.delete(id); held.delete(id); try { saveAndRetire(); } catch (_) {} continue;
      }
      // A deadline does not revoke an attach already accepted upstream. A
      // fresh list on this very connection reconciles the eventual reply.
      if (record.adopting) {
        const adoption = record.adopting;
        if (!adoption.reply) continue;
        if (adoption.socket === link.socket && row.owned && accepted(adoption.reply, record)) held.add(id);
        delete record.adopting;
      }
      record.foreign = !held.has(id) && !record.adopting && row.owned;
      if (held.has(id) || row.owned) continue;
      if (reply.runs.filter((r) => r.key === proof.key && !r.exit).length !== 1) continue;
      (link.blockedRuns ||= new Set()).add(id);
      const adoption = { socket: link.socket, reply: null }; record.adopting = adoption;
      let active = true, timer;
      const pending = link.request({ t: 'attach', key: proof.key, runId: id }).then((reply) => {
        adoption.reply = reply;
        if (!active && !closed) void serial(() => inventory(id)).catch(() => {}).finally(recoverLater);
        return reply;
      });
      const adopted = await Promise.race([pending, new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), deadline(proof));
      })]);
      active = false; clearTimeout(timer);
      link.held.delete(id);
      if (adopted) {
        if (adoption.socket === link.socket && accepted(adopted, record)) held.add(id);
        delete record.adopting;
      }
    }
    settleBlocker();
    if (!needsRecovery()) { clearTimeout(recoveryTimer); recoveryTimer = null; retry = 0; }
    else recoverLater();
    retire();
    return reply.runs.map((row) => {
      const record = records.get(row.runId);
      return record ? { ...row, meta: record.proof.meta, owned: held.has(row.runId) ? !!record.owner : row.owned } : row;
    });
  }
  function accepted(reply, record) {
    return reply.runId === record.proof.runId && (reply.pid === undefined || reply.pid === record.proof.pid) &&
      (reply.ok || reply.message === 'unreplayable');
  }
  const pruneUnheld = (ids) => {
    for (const id of ids) if (!held.has(id) && records.get(id)?.foreign && !records.get(id)?.adopting) records.delete(id);
    try { saveAndRetire(); } finally { recoverLater(); }
  };
  async function handle(client, msg) {
    if (msg.op) {
      if (msg.op === 'add') {
        clearTimeout(startup);
        for (const proof of msg.proofs || []) {
          if (!validProof(proof)) throw fail('KEEPER_RESCUE_INVALID', 'Invalid custody proof');
          const prior = records.get(proof.runId);
          if (prior && (prior.proof.pid !== proof.pid || prior.proof.key !== proof.key)) throw fail('KEEPER_RESCUE_INVALID', 'Custody identity changed');
          if (!prior) records.set(proof.runId, { proof, owner: null });
        }
        persist(); // launchd can recover without any app, editor or engine.
        // One bounded initial takeover also covers a source crash immediately
        // after registration. A still-owned aborted source remains untouched.
        if (msg.hold) client.preparing = new Set((msg.proofs || []).map((p) => p.runId));
        if (!msg.hold && [...records.keys()].some((id) => !held.has(id)) && !takeover) takeover = setTimeout(() => {
          takeover = null;
          void serial(async () => {
            try { await inventory(); } finally {
              pruneUnheld(records.keys());
            }
          }).catch(() => {});
        }, 1000);
      } else if (!['check', 'status', 'retire'].includes(msg.op)) throw fail('KEEPER_RESCUE_INVALID', 'Unknown custody operation');
      if (msg.op !== 'status') {
        try { await inventory(msg.op === 'check' ? msg.runId : null); } finally { recoverLater(); }
        if (blocker) throw fail(blocker, 'Custody is degraded; its original attachment is retained');
        if (msg.op === 'check' && !records.has(msg.runId)) {
          const live = (await inventory()).some((r) => r.runId === msg.runId && !r.exit);
          if (live) throw fail('KEEPER_NOT_IN_CUSTODY', 'The source still owns this live run');
        }
      }
      if ([...records.keys()].every((id) => held.has(id))) { clearTimeout(takeover); takeover = null; }
      return status();
    }
    if (msg.t === 'hello') {
      if (!await link.connect()) throw fail('KEEPER_UNAVAILABLE', 'Legacy keeper is unavailable');
      return { proto: 1, pid: link.keeperPid, metaVersion: link.metaVersion,
        capabilities: { ...link.capabilities, custody: 1 } };
    }
    if (msg.t === 'list') return { metaVersion: link.metaVersion, runs: await inventory() };
    if (msg.t === 'attach' && !msg.runId) {
      const selected = [...records.values()].filter((r) => r.proof.key === msg.key);
      if (selected.length === 1) msg.runId = selected[0].proof.runId;
    }
    const record = records.get(msg.runId), row = record?.proof;
    if (!record || msg.key && msg.key !== row.key) {
      const live = (await inventory()).some((r) => !r.exit && (msg.runId ? r.runId === msg.runId : r.key === msg.key));
      return { ok: false, message: live ? 'KEEPER_NOT_IN_CUSTODY' : 'none' };
    }
    if (msg.t === 'attach' || msg.t === 'reclaim') {
      if (record.owner && record.owner !== client && !record.owner.socket.destroyed) return { ok: false, message: 'owned' };
      if (!held.has(msg.runId)) await inventory();
      if (!held.has(msg.runId)) return { ok: false, message: 'owned' };
      if (msg.guard && (msg.guard.instance !== row.key || msg.guard.cwd !== row.meta.cwd ||
        msg.guard.conversation !== null && msg.guard.conversation !== row.meta.conversation)) return { ok: false, message: 'KEEPER_META_INCOMPLETE' };
      record.queue = [];
      let reply;
      if (record.stopping && msg.t === 'reclaim') {
        const rows = await inventory();
        reply = { ok: true, runId: row.runId, pid: row.pid, lines: [], seq: msg.after, exit: rows.find((r) => r.runId === row.runId)?.exit || null };
      } else {
        reply = await link.request({ t: 'attach', key: row.key, runId: row.runId }, custodyTimeout(row));
        if (reply.ok && msg.t === 'reclaim') reply = reply.checkpointSeq > msg.after
          ? { ok: false, message: 'unreplayable', runId: row.runId, pid: row.pid }
          : { ...reply, lines: (reply.tail || []).filter((line) => line.seq > msg.after) };
      }
      if (reply.ok || reply.message === 'unreplayable') record.owner = client.socket.destroyed ? null : client; // Atomic logical owner swap.
      const queued = record.queue; delete record.queue;
      send(client, { ...reply, t: 'reply', re: msg.id });
      for (const event of queued) send(client, event);
      return null;
    }
    if (record.owner !== client) return { ok: false, message: 'owned' };
    if (msg.t === 'release') { record.owner = null; return null; } // Upstream remains owned.
    if (!['write', 'checkpoint', 'stop', 'end', 'kill', 'forget'].includes(msg.t)) return { ok: false, message: 'KEEPER_ATTACH_ONLY' };
    if (msg.t === 'checkpoint' && msg.meta?.instance === row.key) {
      const bytes = Math.ceil(Buffer.byteLength(JSON.stringify(msg.snapshot ?? null)) / (1024 * 1024)) * 1024 * 1024;
      const changed = JSON.stringify(row.meta) !== JSON.stringify(msg.meta) || bytes > (row.checkpointBytes || 0);
      row.meta = msg.meta; row.checkpointBytes = Math.max(row.checkpointBytes || 0, bytes);
      if (changed) persist();
    }
    if (msg.t === 'forget') msg = { t: 'stop', runId: row.runId };
    if (msg.t === 'stop') record.stopping = true;
    if (!link.send(msg)) throw fail('KEEPER_UNAVAILABLE', 'Legacy transport is unavailable');
    return null;
  }
  const server = net.createServer((socket) => {
    const client = { socket, buf: '' }; clients.add(client); socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (client.buf.length + chunk.length > 70 * 1024 * 1024) { socket.destroy(); return; }
      let start = 0, at;
      while ((at = chunk.indexOf('\n', start)) >= 0) {
        const line = client.buf + chunk.slice(start, at); client.buf = ''; start = at + 1;
        let msg; try { msg = JSON.parse(line); } catch (_) { socket.destroy(); return; }
        // Read-only status must stay available while a large takeover waits.
        const execute = msg.op === 'status' ? (fn) => Promise.resolve().then(fn) : serial;
        void execute(async () => {
          const reply = await handle(client, msg);
          if (reply && msg.op && !msg.hold) client.socket.end(JSON.stringify(reply) + '\n');
          else if (reply && msg.hold) send(client, reply);
          else if (reply) send(client, { ...reply, t: 'reply', re: msg.id });
        }).catch((error) => {
          if (msg.op) client.socket.end(JSON.stringify({ ok: false, code: error.code }) + '\n');
          else send(client, { t: 'reply', re: msg.id, ok: false, message: error.code || 'KEEPER_UNAVAILABLE' });
          retire();
        });
      }
      client.buf += chunk.slice(start);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clients.delete(client); for (const record of records.values()) if (record.owner === client) record.owner = null;
      if (client.preparing) void (async () => {
        // Only this initial transaction needs a bounded retry: the legacy
        // socket's close can arrive just after the preparation socket's close.
        for (let attempt = 0; !closed && attempt < 5; attempt++) {
          if ([...client.preparing].every((id) => !records.has(id) || held.has(id))) return;
          if (attempt) await pause(50 * 2 ** attempt);
          try { await serial(inventory); } catch (_) { /* Bounded crash recovery. */ }
        }
        try { pruneUnheld(client.preparing); } catch (_) { /* status retains the storage blocker */ }
      })().catch(recoverLater);
    });
  });
  const stale = privateFile(socketFor(directory), { socket: true, optional: true });
  if (stale && await probeSocket(socketFor(directory)) === 'absent') {
    const current = privateFile(socketFor(directory), { socket: true, optional: true });
    if (current?.ino === stale.ino && current.dev === stale.dev) fs.unlinkSync(socketFor(directory));
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketFor(directory), resolve); });
  fs.chmodSync(socketFor(directory), 0o600);
  startup = setTimeout(retire, 10000);
  if (records.size) {
    clearTimeout(startup);
    // Retain unverified proofs indefinitely. Backoff runs only during an
    // incident; a healthy retained custodian has no idle recovery timer.
    void (async () => {
      for (let attempt = 0; !closed && attempt < 5; attempt++) {
        if (attempt) await pause(50 * 2 ** attempt);
        try { await serial(inventory); } catch (_) { /* Finite crash sequence. */ }
        if ([...records.keys()].every((id) => held.has(id))) return;
      }
      await serial(() => pruneUnheld(records.keys()));
    })().catch(() => {}).finally(recoverLater);
  }
  function close() {
    if (closing) return closing;
    closed = true; clearTimeout(startup); clearTimeout(takeover); clearTimeout(recoveryTimer);
    return closing = (async () => {
      // Flush the final empty inventory/exit before retiring the endpoint.
      // Bound a peer that keeps its half of the socket open during cleanup.
      for (const client of clients) client.socket.end();
      const force = setTimeout(() => { for (const client of clients) client.socket.destroy(); }, 1000);
      try { await link.close(); await new Promise((resolve) => server.close(resolve)); }
      finally { clearTimeout(force); }
      if (!records.size && process.env.NIKUI_CUSTODY_JOB_LABEL === require('./keeperSupervisor').jobFor(directory).label)
        await require('./keeperSupervisor').removeJob(directory, { emptyProven: true });
    })();
  }
  return { records, held, check: () => serial(inventory), close, get closed() { return closed; } };
}
async function startRescue(directory) {
  try { return await serveRescue(directory); }
  catch (error) {
    const supervisor = require('./keeperSupervisor');
    const code = error.code?.startsWith('KEEPER_RESCUE_SUPERVISION_') ? error.code :
      error.code === 'EADDRINUSE' ? 'KEEPER_RESCUE_SUPERVISION_ENDPOINT_BUSY' : 'KEEPER_RESCUE_SUPERVISION_STARTUP_FAILED';
    supervisor.writeFailure(directory, code);
    if (process.env.NIKUI_CUSTODY_JOB_LABEL === supervisor.jobFor(directory).label) {
      // One configuration attempt per explicit repair. Preserve every proof
      // and the plist/diagnostic; never report a successful empty retirement.
      try { await supervisor.command(['bootout', 'gui/' + process.getuid() + '/' + supervisor.jobFor(directory).label]); } catch (_) {}
      return setInterval(() => {}, 86400000); // only if self-bootout failed
    }
    process.exitCode = 78;
  }
}
if (require.main === module) void startRescue(process.argv[2]);
module.exports = { protectReleased, rescueRequest, serveRescue, socketFor, stateFor, custodyTimeout,
  startRescue, supervise: require('./keeperSupervisor').supervise, retireCustody: require('./keeperSupervisor').removeJob };
