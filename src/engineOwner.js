'use strict';

// The lock covers admission, source membership, acknowledgments and commit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { privateRoot, privateFile, readPrivateJson, fail } = require('./daemonPaths');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const token = () => crypto.randomBytes(16).toString('hex');
const requireThat = (ok, code) => { if (!ok) throw fail(code, code); };
const validString = (s) => typeof s === 'string' && s.length > 0 && s.length <= 4096 && !['__proto__', 'constructor', 'prototype'].includes(s);

function atomicJson(file, value) {
  privateFile(file, { optional: true });
  const tmp = file + '.' + token() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function createSyntheticOwner({ root, profile, install, testOnly = false, now = Date.now, waitMs = 5000, fault = () => {} } = {}) {
  requireThat(testOnly === true, 'PRODUCTION_CUTOVER_DISABLED');
  return createOwner({ root, profile, install, now, waitMs, fault });
}
function createOwner({ root, profile, install, now = Date.now, waitMs = 5000, fault = () => {} } = {}) {
  requireThat(validString(profile) && validString(install), 'OWNER_SCOPE_REQUIRED');
  requireThat(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 5000, 'OWNER_WAIT_INVALID');
  const paths = privateRoot(root), file = path.join(paths.root, 'engine-owner.json');
  const membersFile = file + '.participants', journalFile = file + '.transition', lockFile = file + '.lock';
  const scope = Object.freeze({ root: paths.root, profile, install });
  const livenessFile = membersFile + '.liveness';
  let syncDepth = 0;
  const sameScope = (s) => s && s.root === scope.root && s.profile === profile && s.install === install;
  const read = (p, optional = false) => {
    try { return privateFile(p, { optional }) ? readPrivateJson(p) : null; }
    catch (_) { throw fail('OWNER_CORRUPT', 'Private ownership state is unreadable; no fallback'); }
  };
  function owner() {
    const value = read(file);
    requireThat(value && Object.keys(value).sort().join(',') === 'by,generation,mode,since' &&
      Number.isSafeInteger(value.generation) && value.generation >= 0 && ['window', 'service'].includes(value.mode) &&
      Number.isSafeInteger(value.since) && value.since >= 0 && validString(value.by), 'OWNER_CORRUPT');
    return value;
  }
  function members() {
    const value = read(membersFile);
    requireThat(value?.version === 1 && sameScope(value.scope) && Array.isArray(value.members) &&
      value.members.every((m) => validString(m.id) && validString(m.lease) && validString(m.build) && sameScope(m.scope) &&
        /^[a-f0-9]{32}$/.test(m.lease) && ['writer', 'client'].includes(m.role) && Number.isSafeInteger(m.generation) && m.generation >= 0 &&
        Number.isSafeInteger(m.revision) && m.revision >= 0 && typeof m.connected === 'boolean' && typeof m.busy === 'boolean') &&
      new Set(value.members.map((m) => m.id)).size === value.members.length, 'OWNER_CORRUPT');
    const generation = owner().generation;
    requireThat(value.members.every((m) => m.generation <= generation), 'OWNER_CORRUPT');
    return value;
  }
  function journal() {
    const value = read(journalFile, true);
    if (!value) return null;
    requireThat(value.version === 1 && sameScope(value.scope) && /^[a-f0-9]{32}$/.test(value.token) &&
      Number.isSafeInteger(value.generation) && value.generation >= 0 && ['window', 'service'].includes(value.from) &&
      ['window', 'service'].includes(value.to) && value.to !== value.from && validString(value.target) &&
      ['barrier', 'exported', 'imported', 'committed', 'started', 'released', 'aborted'].includes(value.phase) &&
      Number.isSafeInteger(value.created) && /^[a-f0-9]{64}$/.test(value.inventoryHash) &&
      Array.isArray(value.sources) && value.sources.length > 0 && new Set(value.sources.map((s) => s.id)).size === value.sources.length &&
      value.sources.every((s) => validString(s.id) && validString(s.build) && sameScope(s.scope) && /^[a-f0-9]{32}$/.test(s.lease) &&
        s.generation === value.generation && s.role === 'writer' && s.connected === true && s.metaVersion === 1 &&
        Number.isSafeInteger(s.revision) && s.revision >= 0) &&
      value.acks && !Array.isArray(value.acks) && typeof value.acks === 'object', 'OWNER_CORRUPT');
    for (const [id, ack] of Object.entries(value.acks)) {
      const source = value.sources.find((s) => s.id === id);
      requireThat(source && ack?.lease === source.lease && ack.generation === value.generation && ack.quiescent === true &&
        ack.exported === true && ack.sealed === true && ack.resourcesReleased === true &&
        Number.isSafeInteger(ack.deadline) && /^[a-f0-9]{64}$/.test(ack.hash) && /^[a-f0-9]{64}$/.test(ack.resourcesHash), 'OWNER_CORRUPT');
    }
    if (['exported', 'imported', 'committed', 'started', 'released'].includes(value.phase))
      requireThat(/^[a-f0-9]{64}$/.test(value.hash) && value.sources.every((s) => value.acks[s.id]), 'OWNER_CORRUPT');
    if (['imported', 'committed', 'started', 'released'].includes(value.phase))
      requireThat(value.receipt?.version === 1 && value.receipt.id === value.token && value.receipt.hash === value.hash &&
        value.receipt.generation === value.generation + 1 && value.receipt.target === value.target && value.receipt.inactive === true &&
        validString(value.receipt.root) && value.receipt.root !== scope.root, 'OWNER_CORRUPT');
    const o = owner();
    const old = o.generation === value.generation && o.mode === value.from;
    const committed = o.generation === value.generation + 1 && o.mode === value.to && o.by === value.target;
    requireThat(['committed', 'started', 'released'].includes(value.phase) ? committed
      : value.phase === 'imported' ? old || committed : old, 'OWNER_CORRUPT');
    return value;
  }
  const pending = (j) => j && !['released', 'aborted'].includes(j.phase);
  async function locked(fn, timeout = waitMs) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let fd;
      try { fd = require('./privateLock').open(lockFile); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        privateFile(lockFile);
        if (Date.now() >= deadline) throw fail('OWNER_ADMISSION_TIMEOUT', 'Ownership lock unavailable; no writer started');
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now())))); continue;
      }
      const stat = fs.fstatSync(fd);
      try {
        return fn(); // All mutations under this lock are synchronous.
      } finally {
        fs.closeSync(fd);
        const current = privateFile(lockFile, { optional: true });
        if (current?.ino === stat.ino && current.dev === stat.dev) fs.unlinkSync(lockFile);
      }
    }
  }
  function exact(t, expectedPhases) {
    const j = journal(), o = owner();
    requireThat(j && j.token === t && expectedPhases.includes(j.phase), 'STALE_COORDINATOR');
    requireThat(o.generation === j.generation && o.mode === j.from ||
      ['committed', 'started'].includes(j.phase) && o.generation === j.generation + 1 && o.mode === j.to && o.by === j.target, 'STALE_GENERATION');
    return j;
  }
  function checkSources(j) {
    const current = members().members.filter((m) => m.role === 'writer' && m.generation === j.generation);
    requireThat(current.length === j.sources.length, 'PARTICIPANTS_CHANGED');
    for (const source of j.sources) {
      const member = current.find((m) => m.id === source.id);
      requireThat(member?.connected && member.lease === source.lease && member.build === source.build && member.revision === source.revision &&
        member.metaVersion === 1 && !member.busy, 'PARTICIPANTS_CHANGED');
    }
  }
  function checkAcks(j) {
    checkSources(j);
    requireThat(j.sources.every((s) => j.acks[s.id]?.lease === s.lease && j.acks[s.id].generation === j.generation &&
      j.acks[s.id].quiescent === true && j.acks[s.id].exported === true && j.acks[s.id].sealed === true &&
      j.acks[s.id].resourcesReleased === true && /^[a-f0-9]{64}$/.test(j.acks[s.id].resourcesHash) &&
      /^[a-f0-9]{64}$/.test(j.acks[s.id].hash)), 'QUIESCENCE_INCOMPLETE');
  }
  function syncLocked(change, wait = true) {
    if (syncDepth) return change();
    let fd;
    const deadline = Date.now() + waitMs;
    for (;;) {
      try { fd = require('./privateLock').open(lockFile); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (!wait) throw fail('WRITER_FENCED', 'Generation transition is locked');
        if (Date.now() >= deadline) throw fail('OWNER_ADMISSION_TIMEOUT', 'Generation lock did not become available');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    const st = fs.fstatSync(fd);
    try {
      syncDepth++;
      const value = change(); requireThat(!value || typeof value.then !== 'function', 'ASYNC_WRITER_UNSUPPORTED'); return value;
    } finally {
      syncDepth--;
      fs.closeSync(fd); const current = privateFile(lockFile, { optional: true });
      if (current?.ino === st.ino && current.dev === st.dev) fs.unlinkSync(lockFile);
    }
  }
  const api = {
    scope, file,
    participant(lease) {
      const member = members().members.find((m) => m.lease === lease);
      requireThat(member?.connected, 'STALE_PARTICIPANT'); return structuredClone(member);
    },
    async initialize() {
      return locked(() => {
        if (!privateFile(file, { optional: true })) {
          // The only recoverable partial initialization is the empty roster
          // we fsynced immediately before the first owner record.
          const prior = read(membersFile, true);
          requireThat(!read(journalFile, true) && (!prior || prior.version === 1 && sameScope(prior.scope) && prior.members?.length === 0), 'OWNER_CORRUPT');
          if (!prior) atomicJson(membersFile, { version: 1, scope, members: [] });
          atomicJson(file, { generation: 0, mode: 'window', since: now(), by: 'source-initial' });
        }
        members(); journal(); return owner();
      });
    },
    async admit({ id, build, metaVersion, busy = false, requested = 'window', liveness }) {
      requireThat(validString(id) && validString(build) && typeof busy === 'boolean' &&
        (metaVersion === undefined || Number.isSafeInteger(metaVersion) && metaVersion >= 0) &&
        ['window', 'service'].includes(requested), 'PARTICIPANT_INVALID');
      const deadline = Date.now() + waitMs;
      for (;;) {
        const answer = await locked(() => {
          const o = owner(), j = journal();
          if (pending(j)) return null;
          const saved = members();
          requireThat(!saved.members.some((m) => m.id === id && m.connected), 'PARTICIPANT_EXISTS');
          const role = o.mode === 'window' && requested === 'window' || o.mode === 'service' && requested === 'service' && o.by === id ? 'writer' : 'client';
          const member = { id, build, metaVersion, busy, scope, generation: o.generation, lease: token(), connected: true, role, revision: 0 };
          saved.members = saved.members.filter((m) => m.id !== id).concat(member); atomicJson(membersFile, saved);
          if (liveness) {
            requireThat(Number.isSafeInteger(liveness.pid) && liveness.pid > 0 && path.isAbsolute(liveness.socket || ''), 'PARTICIPANT_INVALID');
            const live = read(livenessFile, true) || {};
            live[id] = { ...liveness, lease: member.lease }; atomicJson(livenessFile, live);
          }
          return structuredClone(member);
        }, Math.max(0, deadline - Date.now()));
        if (answer) return answer;
        if (Date.now() >= deadline) throw fail('OWNER_TRANSITION_PENDING', 'Admission barrier did not finish; no writer started');
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
      }
    },
    async disconnect(lease) {
      return locked(() => {
        const saved = members(), member = saved.members.find((m) => m.lease === lease);
        requireThat(member, 'STALE_PARTICIPANT'); member.connected = false; atomicJson(membersFile, saved);
      });
    },
    async retireClosed(lease) {
      return locked(() => {
        const saved = members(), member = saved.members.find((m) => m.lease === lease);
        if (!member) return;
        requireThat(!pending(journal()), 'OWNER_TRANSITION_PENDING');
        member.connected = false; member.role = 'client'; atomicJson(membersFile, saved);
      });
    },
    async retireWindowTarget(t) {
      return locked(() => {
        const j = journal(), o = owner();
        requireThat(j?.token === t && j.phase === 'released' && j.to === 'window' && o.mode === 'window' && o.generation === j.generation + 1, 'STALE_COORDINATOR');
        const saved = members();
        saved.members = saved.members.filter((m) => !(m.id === j.target && m.generation === o.generation));
        atomicJson(membersFile, saved);
      });
    },
    async pruneDead() {
      const live = read(livenessFile, true) || {}, gone = [];
      for (const [id, proof] of Object.entries(live)) {
        if (require('./daemonLock').pidState(proof.pid) === 'dead' || await require('./daemonLock').probeSocket(proof.socket) === 'absent') gone.push({ id, lease: proof.lease });
      }
      return locked(() => {
        requireThat(!pending(journal()), 'OWNER_TRANSITION_PENDING');
        const saved = members();
        for (const proof of gone) for (const member of saved.members) if (member.id === proof.id && member.lease === proof.lease) {
          member.connected = false; member.role = 'client';
        }
        atomicJson(membersFile, saved); return gone;
      });
    },
    assertWriter(lease, generation, { transition = null, drain = false } = {}) {
      const o = owner(), j = journal(), member = members().members.find((m) => m.lease === lease);
      requireThat(member?.connected && member.role === 'writer' && member.generation === generation && o.generation === generation, 'STALE_GENERATION');
      const committedTarget = ['committed', 'started'].includes(j?.phase) && j.generation + 1 === generation && member.id === j.target;
      requireThat(!pending(j) || committedTarget || drain && j.token === transition && !j.acks[member.id] && j.generation === generation, 'WRITER_FENCED');
      return true;
    },
    effect(lease, generation, change, options) {
      // Synchronous writer adapters (Durable and mementos included) use the
      // same lock as admission/commit. Contending windows wait for the short
      // synchronous transaction; nested command/store guards are reentrant.
      return syncLocked(() => { api.assertWriter(lease, generation, options); return change(); });
    },
    transitionEffect(t, phases, change) {
      return syncLocked(() => { exact(t, phases); return change(); }, false);
    },
    async updateParticipant(lease, { busy }) {
      requireThat(typeof busy === 'boolean', 'PARTICIPANT_INVALID');
      return locked(() => {
        const saved = members(), member = saved.members.find((m) => m.lease === lease);
        requireThat(member?.connected, 'STALE_PARTICIPANT'); member.busy = busy; member.revision++; atomicJson(membersFile, saved);
      });
    },
    async begin({ generation, to, target, inventory }) {
      return locked(() => {
        const o = owner(); requireThat(o.generation === generation, 'STALE_GENERATION');
        requireThat(['window', 'service'].includes(to) && to !== o.mode && validString(target), 'TRANSITION_INVALID');
        requireThat(!pending(journal()), 'OWNER_TRANSITION_PENDING');
        requireThat(inventory?.complete === true && sameScope(inventory.scope) && Array.isArray(inventory.ids) &&
          new Set(inventory.ids).size === inventory.ids.length && Array.isArray(inventory.otherScopes), 'PARTICIPANT_INVENTORY_INCOMPLETE');
        const others = inventory.otherScopes.filter((s) => !s || !['closed', 'fenced'].includes(s.state) || !validString(s.evidence));
        if (others.length) throw Object.assign(fail('OTHER_SCOPE_UNFENCED', 'Other active scopes lack a closed/fenced proof'),
          { blockers: others.map((s) => ({ id: validString(s?.id) ? s.id : 'unknown', build: validString(s?.build) ? s.build : 'unknown', code: 'OTHER_SCOPE_UNFENCED' })) });
        const sources = members().members.filter((m) => m.role === 'writer' && m.generation === generation);
        const blockers = [];
        for (const id of new Set([...inventory.ids, ...sources.map((m) => m.id)])) {
          const s = sources.find((m) => m.id === id);
          const code = !s || !inventory.ids.includes(id) ? 'SOURCE_UNACCOUNTED' : !s.connected ? 'SOURCE_DISCONNECTED' :
            s.metaVersion !== 1 ? 'KEEPER_META_UNSUPPORTED' : s.busy ? 'SOURCE_BUSY' : null;
          if (code) blockers.push({ id, build: s?.build || 'unknown', code });
        }
        requireThat(sources.length > 0, 'SOURCE_UNACCOUNTED');
        if (blockers.length) throw Object.assign(fail('CUTOVER_BLOCKED', 'Source participants block the transition'), { blockers });
        const j = { version: 1, scope, token: token(), generation, from: o.mode, to, target,
          phase: 'barrier', sources, acks: {}, created: now(), inventoryHash: hash(inventory) };
        atomicJson(journalFile, j); return structuredClone(j);
      });
    },
    async acknowledge(t, id, ack) {
      return locked(() => {
        const j = exact(t, ['barrier']); checkSources(j);
        const source = j.sources.find((s) => s.id === id);
        requireThat(source && ack?.lease === source.lease && ack.generation === j.generation && ack.quiescent === true &&
          ack.exported === true && ack.sealed === true && ack.resourcesReleased === true &&
          Number.isSafeInteger(ack.deadline) && Date.now() <= ack.deadline &&
          /^[a-f0-9]{64}$/.test(ack.resourcesHash) && /^[a-f0-9]{64}$/.test(ack.hash), 'QUIESCENCE_INCOMPLETE');
        requireThat(!j.acks[id] || hash(j.acks[id]) === hash(ack), 'EXPORT_CHANGED');
        j.acks[id] = structuredClone(ack); atomicJson(journalFile, j);
      });
    },
    async exported(t, payloadHash) {
      return locked(() => {
        const j = exact(t, ['barrier']); checkAcks(j);
        requireThat(/^[a-f0-9]{64}$/.test(payloadHash), 'EXPORT_INVALID');
        j.hash = payloadHash; j.phase = 'exported'; atomicJson(journalFile, j); return structuredClone(j);
      });
    },
    async imported(t, receipt) {
      return locked(() => {
        const j = exact(t, ['exported']); checkAcks(j);
        requireThat(receipt?.version === 1 && receipt.inactive === true && receipt.hash === j.hash && receipt.target === j.target &&
          receipt.generation === j.generation + 1 && receipt.id === j.token && validString(receipt.root) && receipt.root !== scope.root, 'IMPORT_INVALID');
        j.receipt = structuredClone(receipt); j.phase = 'imported'; atomicJson(journalFile, j);
      });
    },
    verifyExport(envelope) {
      const j = journal(), v = envelope?.value;
      requireThat(j && v && j.token === v.transition && j.hash === envelope.hash && envelope.hash === hash(v) &&
        j.generation === v.sourceGeneration && j.target === v.target && j.to === v.to &&
        ['exported', 'imported', 'committed', 'started', 'released'].includes(j.phase), 'STALE_EXPORT');
      if (['exported', 'imported'].includes(j.phase)) checkAcks(j);
      requireThat(v.sources.length === j.sources.length && v.sources.every((s) =>
        j.acks[s.member.id]?.hash === hash(s.state) && j.acks[s.member.id]?.lease === s.member.lease), 'STALE_EXPORT');
      return true;
    },
    async commit(t, { verifyImport } = {}) {
      return locked(() => {
        const j = exact(t, ['imported']); checkAcks(j);
        if (j.receipt.storage === 'keychain-generation-v1') {
          requireThat(typeof verifyImport === 'function', 'IMPORT_REVALIDATION_REQUIRED');
          const proof = verifyImport(structuredClone(j.receipt));
          requireThat(proof === true, 'IMPORT_REVALIDATION_REQUIRED');
        }
        const next = { generation: j.generation + 1, mode: j.to, since: now(), by: j.target };
        // The owner record is the commit point. Recovery also recognizes the
        // new generation if the following journal write never happens.
        atomicJson(file, next); fault('owner:committed'); j.phase = 'committed'; atomicJson(journalFile, j); return next;
      });
    },
    async recover() {
      return locked(() => {
        const o = owner(), j = journal();
        if (pending(j) && o.generation === j.generation + 1 && o.mode === j.to && o.by === j.target) {
          if (['barrier', 'exported'].includes(j.phase)) throw fail('OWNER_CORRUPT', 'Committed owner lacks a verified import');
          if (j.phase === 'imported') { j.phase = 'committed'; atomicJson(journalFile, j); }
          return { owner: o, action: 'recover-target', transition: structuredClone(j) };
        }
        if (pending(j)) { requireThat(o.generation === j.generation && o.mode === j.from, 'OWNER_CORRUPT'); return { owner: o, action: 'remain-quiescent', transition: structuredClone(j) }; }
        return { owner: o, action: o.mode === 'service' ? 'service-client' : 'admit', transition: j };
      });
    },
    async targetLease(t, { build, metaVersion }) {
      return locked(() => {
        const j = exact(t, ['committed', 'started']), saved = members();
        requireThat(validString(build) && metaVersion === 1, 'KEEPER_META_UNSUPPORTED');
        const prior = saved.members.find((m) => m.id === j.target && m.generation === j.generation + 1);
        if (prior) { requireThat(prior.connected && prior.role === 'writer', 'OWNER_UNAVAILABLE'); return structuredClone(prior); }
        const member = { id: j.target, scope, lease: token(), generation: j.generation + 1,
          role: 'writer', connected: true, busy: false, build, metaVersion, revision: 0 };
        saved.members = saved.members.filter((m) => m.id !== j.target).concat(member); atomicJson(membersFile, saved);
        return structuredClone(member);
      });
    },
    async started(t, proof) {
      return locked(() => {
        const j = exact(t, ['committed', 'started']);
        requireThat(j.sources.every((s) => j.acks[s.id]?.resourcesReleased === true), 'RESOURCE_RELEASE_UNPROVEN');
        requireThat(proof?.generation === j.generation + 1 && proof.target === j.target && proof.hash === j.hash &&
          proof.oldResourcesReleased === true, 'TARGET_START_UNPROVEN');
        j.phase = 'started'; atomicJson(journalFile, j);
      });
    },
    async release(t) {
      return locked(() => {
        const j = exact(t, ['started']), saved = members();
        for (const m of saved.members) if (m.generation === j.generation) m.role = 'client';
        atomicJson(membersFile, saved); j.phase = 'released'; atomicJson(journalFile, j); return owner();
      });
    },
    async abort(t, proof) {
      return locked(() => {
        const j = exact(t, ['barrier', 'exported', 'imported']);
        requireThat(proof?.targetInactive === true && proof.importDiscarded === true, 'ABORT_UNPROVEN');
        const saved = members(), current = saved.members.filter((m) => m.role === 'writer' && m.generation === j.generation);
        const settled = proof.sourcesSettled;
        requireThat(current.length === j.sources.length && j.sources.every((s) => current.some((m) => m.id === s.id && m.lease === s.lease &&
          (proof.allSourcesReachable === true && m.connected || settled?.some((p) => p.id === s.id && ['live', 'gone'].includes(p.state))))), 'ABORT_UNPROVEN');
        for (const member of current) if (settled?.some((p) => p.id === member.id && p.state === 'gone')) { member.connected = false; member.role = 'client'; }
        atomicJson(membersFile, saved); j.phase = 'aborted'; atomicJson(journalFile, j); return owner();
      });
    },
    status() {
      const o = owner(), j = journal();
      return { mode: o.mode, generation: o.generation, by: o.by, admission: pending(j) ? 'closed' : 'open',
        phase: j?.phase || 'idle', participants: members().members.map(({ id, build, connected, role, generation }) => ({ id, build, connected, role, generation })),
        acknowledged: j ? Object.keys(j.acks) : [], productionActivation: false };
    }
  };
  return api;
}

module.exports = { createSyntheticOwner, createOwner, atomicJson, hash };
