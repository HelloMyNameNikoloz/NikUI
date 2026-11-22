'use strict';

// Source-context bridge. Merely loading a legacy window does not enroll it,
// change its writer mode, or construct a service. Only the app's reviewed
// handshake installs the shared generation fence.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { createControl, controlRequest } = require('./daemonControl');
const { privateDirectory, privateFile, readPrivateJson, noSymlinks, fail } = require('./daemonPaths');
const { createOwner, atomicJson, hash } = require('./engineOwner');
const { createParticipantGate } = require('./engineTransfer');
const insist = (ok, code) => { if (!ok) throw fail(code, code); };
const sourceDirectory = (home) => path.join(home, 'Library/Application Support/NikUI/sources');
const profileID = (storage) => hash(path.resolve(storage));
const SOURCE_BUILD = 'p3-source-v8';
function processProofs(pids, run = require('child_process').spawnSync) {
  const result = run('/bin/ps', ['-p', [...new Set(pids)].join(','), '-o', 'pid=,lstart=,command='],
    { encoding: 'utf8', timeout: 2000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  // Managed test hosts can deny ps. Keep the authenticated socket check in
  // that case; a native host uses one process snapshot for the whole review.
  if (result.error || ![0, 1].includes(result.status) || result.status !== 0 && String(result.stderr || '').trim()) return null;
  return new Map(String(result.stdout || '').split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    return match ? [[Number(match[1]), hash(match[2].replace(/\s+/g, ' '))]] : [];
  }));
}

function sourceRequest(descriptor, request) {
  return controlRequest({ socket: descriptor.socket }, { ...request, nonce: descriptor.nonce },
    { timeoutMs: 30000, maxReplyBytes: 64 * 1024 * 1024, onProgress: require('./cutoverProgress').note });
}
async function inventory(directory, { tolerateUnresponsive = false, processSnapshot = processProofs } = {}) {
  noSymlinks(directory);
  if (!fs.existsSync(directory)) return [];
  privateDirectory(directory, false);
  const files = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{16}\.json$/.test(name));
  const records = files.map((file) => ({ file, descriptor: readPrivateJson(path.join(directory, file)) }));
  for (const { file, descriptor } of records) insist(descriptor.version === 1 && descriptor.id + '.json' === file &&
    descriptor.socket === path.join(directory, descriptor.id + '.sock') && /^[a-f0-9]{32}$/.test(descriptor.nonce) &&
    Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0, 'SOURCE_MANIFEST_INCOMPLETE');
  const proofs = records.length ? processSnapshot(records.map(({ descriptor }) => descriptor.pid)) : new Map();
  const wakeFile = path.join(directory, 'review.request'), nonce = crypto.randomBytes(16).toString('hex');
  if (files.length) atomicJson(wakeFile, { nonce });
  const result = [];
  try {
    for (const { file, descriptor } of records) {
      insist(descriptor.version === 1 && descriptor.id + '.json' === file &&
        descriptor.socket === path.join(directory, descriptor.id + '.sock') && /^[a-f0-9]{32}$/.test(descriptor.nonce) &&
        Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0, 'SOURCE_MANIFEST_INCOMPLETE');
      if (proofs && descriptor.processProof && descriptor.processProof !== proofs.get(descriptor.pid)) continue;
      let alive = true;
      try { process.kill(descriptor.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
      if (!alive) continue;
      const wakeDeadline = Date.now() + 5000;
      let nextWake = Date.now() + 250;
      while (await require('./daemonLock').probeSocket(descriptor.socket) === 'absent' && Date.now() < wakeDeadline) {
        try { process.kill(descriptor.pid, 0); } catch (e) { if (e.code === 'ESRCH') { alive = false; break; } else throw e; }
        // FSEvents can coalesce a wake while a host reloads. The reviewer
        // retries the same bounded request; idle legacy windows never poll.
        if (Date.now() >= nextWake) { atomicJson(wakeFile, { nonce }); nextWake = Date.now() + 250; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!alive) continue;
      let response;
      try { response = await sourceRequest(descriptor, { op: 'source.review' }); }
      catch (_) {
        if (tolerateUnresponsive) { result.push({ ...descriptor, review: { ready: false, blockers: ['SOURCE_UNRESPONSIVE'] } }); continue; }
        throw fail('SOURCE_UNRESPONSIVE', 'A loaded source window did not answer');
      }
      if (!response.ok && tolerateUnresponsive) { result.push({ ...descriptor, review: { ready: false, blockers: [response.code || 'SOURCE_UNRESPONSIVE'] } }); continue; }
      insist(response.ok && response.id === descriptor.id && response.profile === descriptor.profile && response.version === 1, 'SOURCE_BUILD_OLD');
      result.push({ ...descriptor, review: response });
    }
    return result;
  } finally {
    if (privateFile(wakeFile, { optional: true }) && readPrivateJson(wakeFile).nonce === nonce) fs.unlinkSync(wakeFile);
  }
}

function createLegacyActivation(context, { home, install, workspace, directory = sourceDirectory(home) }) {
  const profile = profileID(context.globalStorageUri.fsPath), marker = path.join(directory, profile + '.mode');
  const id = crypto.randomBytes(8).toString('hex');
  let gate, owner, member, transition, exported, control, descriptor, watcher, wakeWatcher, starting, disposed = false, mode = 'legacy', pending = new Set();
  const revokeWorkspace = require('./cutoverRecovery').workspaceRevoker(context, workspace);
  let remembered, unauthorizedMarker;
  try {
    remembered = fs.existsSync(marker) ? readPrivateJson(marker) : null;
    if (remembered) insist(remembered.profile === profile && remembered.install === install &&
      typeof remembered.ownerRoot === 'string' && typeof remembered.engineRoot === 'string', 'SOURCE_MANIFEST_INCOMPLETE');
    if (remembered && !require('./cutoverRecovery').authorized(context, remembered)) {
      if (require('./cutoverRecovery').superseded(context, remembered)) {
        require('./cutoverRecovery').logDiscard('SOURCE_FENCE_SUPERSEDED'); remembered = null;
      } else { mode = 'recovery'; unauthorizedMarker = remembered; remembered = null; }
    }
  } catch (e) {
    // Only a coordinator may remove a shared fence. Unknown identity, corrupt
    // ownership or an unreadable marker cannot authorize a second writer.
    console.error('[NikUI recovery] Ownership recovery required:', e.code || 'MODE_UNAVAILABLE'); remembered = null; mode = 'recovery';
  }
  let engineRoot = remembered?.engineRoot;
  try { if (remembered) {
    owner = createOwner({ root: remembered.ownerRoot, profile, install });
    const status = owner.status();
    if (status.mode === 'service') mode = 'client';
    else if (status.admission !== 'open') mode = 'recovery';
    // Only the coordinator removes a valid shared marker. A new legacy
    // window must join its owner even before the admission barrier begins.
  } } catch (e) {
    console.error('[NikUI recovery] Ownership recovery required:', e.code || 'OWNER_UNAVAILABLE');
    remembered = null; owner = null; engineRoot = null; mode = 'recovery';
  }
  function write(change) {
    insist(mode === 'legacy' || mode === 'quiescing', 'WRITER_SEALED');
    return gate ? gate.write(change) : change();
  }
  function admit(change) {
    insist(mode === 'legacy' && (!gate || gate.phase === 'open'), 'WRITER_FENCED');
    let result;
    if (owner && member) owner.effect(member.lease, member.generation, () => { result = change(); });
    else result = change();
    return track(result);
  }
  const track = (result) => {
    if (!result?.then) return result;
    if (gate) gate.track(result);
    pending.add(result); result.finally(() => pending.delete(result)).catch(() => {}); return result;
  };
  const mutate = (change) => { let result; write(() => { result = change(); }); return track(result); };
  const wrap = (store, secret = false, workspaceStore = false) => ({
    get: store.get.bind(store), keys: store.keys?.bind(store),
    update: (key, value) => mutate(() => {
      if (workspaceStore && mode === 'legacy') revokeWorkspace(() => JSON.stringify(store.get(key)) !== JSON.stringify(value));
      return store.update(key, value);
    }),
    ...(secret ? { store: (key, value) => mutate(() => store.store(key, value)),
      delete: (key) => mutate(() => store.delete(key)), onDidChange: store.onDidChange.bind(store) } : {})
  });
  const wrapped = Object.create(context);
  Object.defineProperties(wrapped, { globalState: { value: wrap(context.globalState) }, workspaceState: { value: wrap(context.workspaceState, false, true) },
    secrets: { value: wrap(context.secrets, true) }, sourceAdmission: { value: admit }, sourceWrite: { value: write } });
  return {
    context: wrapped, write, admit, profile, install, revokeWorkspace,
    requireRecovery() { mode = 'recovery'; },
    get legacy() { return mode === 'legacy'; },
    get engineRoot() { return engineRoot; },
    get service() { return mode === 'client' ? { root: engineRoot, service: true } : undefined; },
    get recovering() { return mode === 'recovery'; },
    get needsRecoverySnapshot() { return !!owner && owner.status().mode === 'window' && owner.status().admission === 'closed'; },
    get needsAdmission() { return !!owner && mode === 'legacy' && !member; },
    async ready() {
      if (owner && !member) {
        try {
          member = await owner.admit({ id, build: SOURCE_BUILD, metaVersion: 1,
            liveness: { pid: process.pid, socket: path.join(directory, id + '.sock') } });
          if (member.role === 'writer') gate = createParticipantGate({ owner, member });
          else mode = 'client';
        } catch (e) {
          if (!['OWNER_TRANSITION_PENDING', 'OWNER_ADMISSION_TIMEOUT'].includes(e.code)) throw e;
          mode = 'recovery';
        }
      }
    },
    async listen(adapters) {
      privateDirectory(directory);
      const socket = path.join(directory, id + '.sock');
      insist(Buffer.byteLength(socket) < 104, 'SOCKET_PATH_TOO_LONG');
      descriptor = { version: 1, id, pid: process.pid, processProof: processProofs([process.pid])?.get(process.pid), profile, install, workspace, socket,
        nonce: crypto.randomBytes(16).toString('hex'), build: SOURCE_BUILD };
      async function handle(request, progress) {
        try {
          insist(request.nonce === descriptor.nonce, 'SOURCE_AUTHORITY_REQUIRED');
          progress();
          if (request.op === 'source.review') {
            const review = await adapters.review(), pendingReturns = require('./cutoverRecovery').pendingReturns(context), pendingFolders = pendingReturns.map((item) => item.workspace);
            return { ok: true, version: 1, id, profile, install, workspace, ...review, mode, pendingFolders, pendingReturns,
              ready: review.ready && mode !== 'reloading' && !pendingFolders.length,
              blockers: [...new Set([...(review.blockers || []), ...(mode === 'reloading' ? ['SOURCE_RELOADING'] : []), ...(pendingFolders.length ? ['PENDING_FOLDER_RETURNS'] : [])])] };
          }
          if (request.op === 'source.return.forget') {
            insist(request.confirmed === true, 'RESTORE_CONFIRMATION_REQUIRED');
            const receipt = context.globalState.get(require('./cutoverRecovery').pendingKey(request.workspace));
            insist(receipt?.profile === profile && receipt.install === install, 'RESTORE_SCOPE_MISMATCH');
            return { ok: true, ...await require('./cutoverRecovery').forget(context, request.workspace, request) };
          }
          if (request.op === 'source.join') {
            restoring = null;
            insist(mode === 'legacy' && request.profile === profile && request.install === install, 'SOURCE_SELECTION_CHANGED');
            if (!owner) owner = createOwner({ root: request.ownerRoot, profile, install });
            const fence = readPrivateJson(marker);
            insist(fence.ownerRoot === request.ownerRoot && fence.engineRoot === request.engineRoot &&
              fence.profile === profile && fence.install === install && fence.fingerprint === request.fingerprint, 'SOURCE_FENCE_MISSING');
            await owner.initialize();
            require('./cutoverRecovery').grant(context, { profile, install, ownerRoot: request.ownerRoot,
              engineRoot: request.engineRoot, generation: owner.status().generation + 1 });
            member ||= await owner.admit({ id, build: descriptor.build, metaVersion: 1,
              liveness: { pid: process.pid, socket: descriptor.socket } });
            gate ||= createParticipantGate({ owner, member });
            engineRoot = request.engineRoot;
            await adapters.prepareRecovery?.(request);
            return { ok: true, member };
          }
          if (request.op === 'source.freeze') {
            insist(owner && member && request.transition, 'SOURCE_HANDSHAKE_UNAVAILABLE');
            const fence = readPrivateJson(marker);
            insist(fence.ownerRoot === owner.scope.root && fence.engineRoot === engineRoot &&
              fence.profile === profile && fence.install === install, 'SOURCE_FENCE_MISSING');
            if (exported && transition === request.transition) return { ok: true, exported };
            transition = request.transition;
            exported = await gate.quiesce(transition, {
              progress,
              readiness: async () => {
                const review = await adapters.review();
                insist(review.hostInventory?.complete === true && hash(review.hostInventory.pids) === hash(request.expectedPIDs), 'SOURCE_MANIFEST_INCOMPLETE');
                return review;
              },
              // A validation failure before teardown must leave the live
              // engine usable after abort, without scheduling a reload.
              closeAdmission: () => { adapters.closeAdmission(); mode = 'quiescing'; },
              cancel: adapters.cancel, drain: async () => { await Promise.all([...pending].map((work) => work.then(progress))); await adapters.drain(); progress(); },
              flush: async () => { await adapters.flush(); progress(); },
              detach: (advance) => adapters.detach(advance),
              releaseResources: async () => { const result = await adapters.releaseResources(); progress(); return result; },
              exportState: async () => {
                mode = 'sealed';
                const state = await adapters.exportState(), { WORKSPACE_KEYS } = require('./engineTransfer');
                // Dispose can persist a final stopped status after detach.
                // Baseline comparison must use the final drained memento,
                // while full prompts/transcripts remain in the captured state.
                const baseline = {};
                for (const key of WORKSPACE_KEYS) {
                  const value = await context.workspaceState.get(key);
                  if (value !== undefined) baseline[key] = structuredClone(value);
                }
                state.files.legacyWorkspace = baseline; state.fileHashes.legacyWorkspace = hash(baseline);
                return state;
              }
            });
            return { ok: true, exported };
          }
          if (request.op === 'source.client') {
            const status = owner.status();
            insist(status.mode === 'service' && status.admission === 'open', 'SERVICE_OWNERSHIP_REQUIRED');
            if (mode !== 'client') { await adapters.becomeClient(request.engineRoot); mode = 'client'; }
            return { ok: true };
          }
          if (request.op === 'source.abort') {
            if (!owner && request.ownerRoot) { owner = createOwner({ root: request.ownerRoot, profile, install }); restoring = null; }
            if (owner) insist(owner.status().mode === 'window' && owner.status().admission === 'open', 'ABORT_UNPROVEN');
            await restore(); return { ok: true };
          }
          if (request.op === 'source.return.prepare') {
            // Reloaded sources join recovery before constructing an engine.
            if (!owner && request.ownerRoot) owner = createOwner({ root: request.ownerRoot, profile, install });
            insist(owner && owner.status().mode === 'service', 'SERVICE_OWNERSHIP_REQUIRED');
            await adapters.validateReturn(request.state);
            return { ok: true, hash: hash(request.state) };
          }
          if (['source.return.shared', 'source.return.apply'].includes(request.op)) {
            if (!owner && request.ownerRoot) owner = createOwner({ root: request.ownerRoot, profile, install });
            const current = owner.status();
            insist(current.mode === 'window' && current.admission === 'closed' && current.generation === request.generation && current.by === request.target, 'STALE_GENERATION');
            if (request.op === 'source.return.shared') {
              await adapters.importShared(request.state, { generation: request.generation, transition: request.transition,
                binding: { profile, install, ownerRoot: owner.scope.root }, workspaces: request.workspaces, progress });
            } else {
              await adapters.importWorkspace(request.payload, { progress });
              if (workspace) await require('./cutoverRecovery').delivered(context, workspace, request);
              mode = 'returned';
            }
            return { ok: true };
          }
          if (request.op === 'source.return.resume') {
            if (!owner && request.ownerRoot) { owner = createOwner({ root: request.ownerRoot, profile, install }); restoring = null; }
            if (!owner && mode === 'legacy') return { ok: true };
            insist(owner.status().mode === 'window' && owner.status().admission === 'open', 'STALE_GENERATION');
            await restore(); return { ok: true };
          }
          return { ok: false, code: 'SOURCE_OPERATION_UNAVAILABLE' };
        } catch (e) {
          console.error('[NikUI source]', e.code || 'SOURCE_UNAVAILABLE', JSON.stringify(e.diagnostics || {}));
          return { ok: false, code: e.code || 'SOURCE_UNAVAILABLE', ...(e.diagnostics ? { diagnostics: e.diagnostics } : {}) };
        }
      }
      let restoring;
      function restore() { return restoring ||= (async () => {
        const reload = mode !== 'legacy';
        const frozen = gate && gate.phase !== 'open';
        if (owner) {
          const current = owner.status();
          insist(current.mode === 'window' && current.admission === 'open', 'STALE_GENERATION');
          require('./cutoverRecovery').complete(context, { profile, install, ownerRoot: owner.scope.root, generation: current.generation });
        }
        if (owner && member) await owner.retireClosed(member.lease);
        if (engineRoot && context.secrets?.delete) {
          const key = 'nikui.serviceClient.' + crypto.createHash('sha256').update(engineRoot).digest('hex');
          if (await context.secrets.get(key) !== undefined) await context.secrets.delete(key);
        }
        gate = null; member = null; owner = null; transition = null; exported = null;
        // The old engine may already be disposed. It cannot advertise a
        // legacy writer until a new activation has rebuilt its conversations.
        mode = reload ? 'reloading' : 'legacy'; if (reload) await adapters.restoreLegacy({ reload: !!frozen || reload });
      })().catch((e) => { restoring = null; throw e; }); }
      let lane = Promise.resolve();
      const startControl = () => starting ||= (async () => {
        if (disposed) return;
        control = await createControl({ paths: { socket }, handle(request, { progress }) {
          if (['source.abort', 'source.return.resume'].includes(request.op)) return handle(request, progress);
          const next = lane.then(() => handle(request, progress)); lane = next.catch(() => {}); return next;
        }, maxRequestBytes: 64 * 1024 * 1024 });
      })().catch((error) => { starting = null; throw error; });
      // Never-moved windows publish only a descriptor and an idle filesystem
      // watch. The app's review wakes endpoints; normal writes do no I/O here.
      const wakeFile = path.join(directory, 'review.request');
      const wakeUnavailable = () => {
        // Restricted hosts can deny FSEvents. An idle private socket is a
        // cheaper fallback than polling every never-moved window forever.
        wakeWatcher?.close(); void startControl().catch(() => {});
      };
      try {
        wakeWatcher = fs.watch(directory, { persistent: false }, (_event, name) => {
          if ((!name || String(name) === 'review.request') && fs.existsSync(wakeFile)) void startControl().catch(() => {});
        });
        wakeWatcher.on('error', wakeUnavailable);
      } catch (_) { wakeUnavailable(); }
      atomicJson(path.join(directory, id + '.json'), descriptor);
      if (owner || mode !== 'legacy' || fs.existsSync(path.join(directory, 'review.request'))) await startControl();
      // The app may disappear just after opening the generation. A sealed or
      // reloaded source resumes itself instead of waiting for an RPC forever.
      watcher = setInterval(() => {
        try {
          // An unauthorized marker cannot grant a writer. It can, however,
          // become authorized by the editor's own receipt while this host is
          // waiting. Recheck those receipts rather than stranding the window.
          if (!owner && unauthorizedMarker && mode === 'recovery') {
            const recovery = require('./cutoverRecovery');
            if (recovery.superseded(context, unauthorizedMarker)) {
              mode = 'reloading'; void Promise.resolve(adapters.restoreLegacy({ reload: true })).catch(() => { mode = 'recovery'; }); return;
            }
            if (recovery.authorized(context, unauthorizedMarker)) {
              owner = createOwner({ root: unauthorizedMarker.ownerRoot, profile, install });
              engineRoot = unauthorizedMarker.engineRoot; unauthorizedMarker = null;
            }
          }
          if (!owner || mode === 'legacy') return;
          const status = owner.status();
          if (status.mode === 'window' && status.admission === 'open') void restore().catch(() => {});
        } catch (_) { /* retain recovery endpoint for the app */ }
      }, 500);
      watcher.unref?.();
      return descriptor;
    },
    async dispose() {
      disposed = true; wakeWatcher?.close();
      clearInterval(watcher);
      await starting;
      await control?.dispose();
      await Promise.all([...pending]);
      if (owner && member && (!gate || gate.phase === 'open') && owner.status().admission === 'open') await owner.retireClosed(member.lease);
      if (descriptor) { const file = path.join(directory, descriptor.id + '.json'); if (privateFile(file, { optional: true })) fs.unlinkSync(file); }
    }
  };
}
module.exports = { sourceDirectory, profileID, inventory, sourceRequest, createLegacyActivation, SOURCE_BUILD, processProofs };
