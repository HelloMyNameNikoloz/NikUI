'use strict';
const fs = require('fs'), path = require('path');
const { privateRoot, privateDirectory, privateFile, readPrivateJson, fail } = require('./daemonPaths');
const { createOwner, atomicJson, hash } = require('./engineOwner');
const { createSelectedImporter, buildSelectedTransfer } = require('./engineImport');
const { inventory, sourceRequest, sourceDirectory, SOURCE_BUILD } = require('./legacySource');
const recovery = require('./cutoverRecovery');
const insist = (v, code) => { if (!v) throw fail(code, code); };

function createProductionCutover({ selection, secretAdapter, sources = (options) => inventory(sourceDirectory(selection.home), options),
  request = sourceRequest, fault = () => {}, checkpoint = async () => {}, inspectPort, returnWaitMs = 5000, helper }) {
  const file = path.join(selection.root, 'cutover-request.json'), directory = sourceDirectory(selection.home);
  const saved = () => privateFile(file, { optional: true }) ? readPrivateJson(file) : null;
  const save = (state, stage) => { state.stage = stage; atomicJson(file, state); require('./cutoverProgress').note(); fault(stage); };
  const ownerFor = (state) => createOwner({ root: state.ownerRoot, profile: state.profile, install: state.install });
  const importerFor = (state, owner) => createSelectedImporter({ root: selection.root, target: selection.label, owner, secretAdapter });
  const selectedSources = async (state, options) => (await sources(options)).filter((s) => s.profile === state.profile && s.install === state.install).sort((a, b) => a.id.localeCompare(b.id));
  function clearLegacyArtifacts(state) {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) if (name.startsWith(state.profile + '.') && /\.(restore|keepers|keepers\.store|snapshots)$/.test(name)) recovery.discard(path.join(directory, name));
  }
  function verifyFence(state, owner) {
    let marker;
    try { marker = readPrivateJson(path.join(directory, state.profile + '.mode')); }
    catch (_) { throw fail('SOURCE_FENCE_MISSING', 'The coordinator source fence disappeared'); }
    const status = owner.status();
    insist(marker.profile === state.profile && marker.install === state.install && marker.ownerRoot === state.ownerRoot &&
      marker.engineRoot === selection.root && marker.fingerprint === state.fingerprint &&
      status.admission === 'closed' && status.acknowledged.length === state.sources.length, 'SOURCE_FENCE_MISSING');
  }
  async function exclusive(action) {
    const paths = privateRoot(selection.root);
    const lease = await require('./daemonLock').acquireRootLock({ ...paths,
      lock: path.join(paths.root, 'cutover-operation.lock'), socket: path.join(paths.root, 'cutover-operation.sock') });
    try { return await action(); } catch (e) {
      atomicJson(path.join(selection.root, 'cutover-diagnostics.json'), { code: e.code || 'CUTOVER_UNAVAILABLE',
        ...(e.diagnostics ? { diagnostics: e.diagnostics } : {}), stage: saved()?.stage });
      throw e;
    } finally { lease.release(); }
  }
  async function call(source, value) {
    const reply = await request(source, value);
    require('./cutoverProgress').note();
    if (!reply?.ok) throw Object.assign(fail(reply?.code || 'SOURCE_UNRESPONSIVE', 'Source operation failed'),
      { ...(reply?.diagnostics ? { diagnostics: reply.diagnostics } : {}) });
    fault(value.op + ':' + source.id); return reply;
  }
  async function notifyLive(state, value) {
    for (const source of await selectedSources(state, { tolerateUnresponsive: true })) {
      try {
        await call(source, value);
      }
      catch (e) {
        if (e.crash) throw e;
        if (value.op !== 'source.client') {
          atomicJson(path.join(selection.root, 'cutover-delivery-diagnostics.json'), { source: source.id, operation: value.op, code: e.code || 'SOURCE_UNRESPONSIVE' });
          continue; // The durable delivery/reload path remains authoritative.
        }
        if (await require('./daemonLock').probeSocket(source.socket) !== 'absent' && require('./daemonLock').pidState(source.pid) !== 'dead') throw e;
      }
    }
  }
  async function acknowledgeLegacy(state, operation) {
    // A flag in the engine journal is not an editor-owned completion proof.
    // Even a repeated Restore obtains an acknowledgement from a live context.
    let acknowledged = false, complete = false;
    const deadline = Date.now() + returnWaitMs, failures = [];
    do {
      const active = await selectedSources(state, { tolerateUnresponsive: true });
      complete = active.length > 0;
      // Reload replaces the descriptor and socket. An empty sample is a gap,
      // not proof that no editor will acknowledge the already-open owner.
      for (const source of active) {
        try { await call(source, { op: operation, ownerRoot: state.ownerRoot }); acknowledged = true; }
        catch (e) { if (e.crash) throw e; complete = false; failures.push({ source: source.id, code: e.code || 'SOURCE_UNRESPONSIVE' }); }
      }
      if (complete || Date.now() >= deadline) break;
      require('./cutoverProgress').note();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if (!acknowledged || !complete) throw Object.assign(fail('SOURCE_RETURN_TARGET_REQUIRED', 'Open a NikUI editor window to finish restoring'),
      { diagnostics: { operation, failures: failures.slice(-16) } });
    state.releaseAcknowledged = true; save(state, state.stage);
  }
  async function review(profile) {
    const all = await sources();
    if (!all.length) return { ready: false, blockers: ['SOURCE_HANDSHAKE_UNAVAILABLE'], sources: [], canRestore: !!saved() };
    const profiles = [...new Set(all.map((s) => s.profile))]; profile ||= profiles.length === 1 ? profiles[0] : null;
    if (!profile) return { ready: false, blockers: ['SOURCE_SELECTION_REQUIRED'], sources: all.map(({ id, profile, install, workspace }) => ({ id, profile, install, workspace })), canRestore: !!saved() };
    const selected = all.filter((s) => s.profile === profile).sort((a, b) => a.id.localeCompare(b.id));
    const blockers = [...new Set(selected.flatMap((s) => s.review.blockers || (s.review.ready ? [] : ['SOURCE_UNRESPONSIVE'])))];
    if (selected.some((s) => s.build !== SOURCE_BUILD)) blockers.push('SOURCE_BUILD_OLD');
    if (selected.some((s) => s.review.mode && s.review.mode !== 'legacy')) blockers.push('OWNER_TRANSITION_PENDING');
    if (all.some((s) => s.profile !== profile)) blockers.push('OTHER_SCOPE_UNFENCED');
    if (new Set(selected.map((s) => s.install)).size !== 1) blockers.push('SOURCE_SELECTION_CHANGED');
    if (new Set(selected.map((s) => s.review.fingerprint)).size !== 1) blockers.push('EXPORT_IDENTITY_CONFLICT');
    const pids = selected.map((s) => s.pid).sort((a, b) => a - b);
    if (selected.some((s) => s.review.hostInventory?.complete !== true || s.review.hostInventory.windows !== selected.length ||
      hash(s.review.hostInventory.pids) !== hash(pids))) blockers.push('SOURCE_MANIFEST_INCOMPLETE');
    const listener = await require('./cutoverPort').reviewPort(selected, inspectPort);
    if (!listener.ready) blockers.push(listener.code || 'PORT_IN_USE');
    const reviewed = selected.map((s) => ({ id: s.id, profile: s.profile, install: s.install, build: s.build, ...s.review }));
    const pendingFolders = [...new Set(selected.flatMap((s) => s.review.pendingFolders || []))].sort();
    const pendingReturns = [...new Map(selected.flatMap((s) => s.review.pendingReturns || []).map((item) => [item.workspace, item])).values()];
    if (pendingFolders.length && !blockers.includes('PENDING_FOLDER_RETURNS')) blockers.push('PENDING_FOLDER_RETURNS');
    return { ready: blockers.length === 0, blockers, listener, pendingFolders, pendingReturns, profile, sourceID: selected[0]?.id, install: selected[0]?.install,
      token: hash(reviewed), fingerprint: selected[0]?.review.fingerprint, canRestore: !!saved(),
      windows: selected.length, conversations: selected.reduce((n, s) => n + (s.review.conversations || 0), 0),
      queues: selected.reduce((n, s) => n + (s.review.queues || 0), 0), devices: selected[0]?.review.devices || 0, sources: reviewed };
  }
  async function forgetReturn(value) {
    insist(value?.confirmed === true, 'RESTORE_CONFIRMATION_REQUIRED');
    const ready = await review(value.profile), savedReturn = ready.pendingReturns?.find((item) => item.workspace === value.workspace);
    insist(savedReturn && savedReturn.hash === value.hash && savedReturn.transition === value.transition, 'RESTORE_SUPERSEDED');
    const source = (await sources()).find((source) => source.profile === ready.profile && source.install === ready.install);
    insist(source, 'SOURCE_RETURN_TARGET_REQUIRED');
    return call(source, { ...value, op: 'source.return.forget' });
  }
  async function abortMove(state, owner) {
    const importer = importerFor(state, owner);
    try {
      const current = await owner.recover();
      insist(current.owner.mode === 'window' && (!current.transition || current.transition.to !== 'window' || current.transition.phase === 'released'), 'SERVICE_OWNERSHIP_REQUIRED');
      if (current.transition && !['released', 'aborted'].includes(current.transition.phase)) {
        importer.discard(current.transition.token);
        // The target never committed. Every source lease still belongs to the
        // original generation, including windows that closed while draining.
        const settled = [];
        for (const source of current.transition.sources) {
          const descriptor = state.sources.find((s) => s.id === source.id);
          const gone = descriptor && (require('./daemonLock').pidState(descriptor.pid) === 'dead' ||
            await require('./daemonLock').probeSocket(descriptor.socket) === 'absent');
          settled.push({ id: source.id, state: gone ? 'gone' : 'live' });
        }
        await owner.abort(current.transition.token, { targetInactive: true, importDiscarded: true,
          sourcesSettled: settled });
      }
      recovery.remove(path.join(directory, state.profile + '.mode'));
      clearLegacyArtifacts(state); recovery.discard(path.join(selection.root, 'cutover-return-state.json'));
      await owner.pruneDead(); save(state, 'aborted');
      await acknowledgeLegacy(state, 'source.abort');
      return { ok: true, stage: 'returned', generation: current.owner.generation };
    } finally { importer.dispose(); }
  }
  async function move({ profile, token }) {
    let state = saved();
    if (state && ['ready', 'launchable'].includes(state.stage)) {
      const ownership = require('./productionOwnership').committedOwnership(selection.root);
      return { ok: true, generation: ownership.record.generation, stage: state.stage };
    }
    if (!state || ['aborted', 'returned'].includes(state.stage)) {
      const ready = await review(profile); insist(ready.ready, ready.blockers[0]); insist(ready.token === token, 'SOURCE_SELECTION_CHANGED');
      privateRoot(selection.root); const ownerRoot = path.join(selection.root, 'o'); privateDirectory(ownerRoot);
      state = { version: 1, profile: ready.profile, install: ready.install, token, ownerRoot,
        sourceID: ready.sourceID, fingerprint: ready.fingerprint, sources: await selectedSources(ready) };
      save(state, 'reviewed');
    }
    insist(state.profile === profile, 'SOURCE_SELECTION_CHANGED');
    const owner = ownerFor(state); await owner.initialize();
    const importer = importerFor(state, owner);
    try {
      let recovered = await owner.recover(), transition = recovered.transition;
      if (recovered.owner.mode === 'window') {
        const active = await selectedSources(state);
        if (hash(active.map((s) => s.id)) !== hash(state.sources.map((s) => s.id))) {
          throw fail('SOURCE_SELECTION_CHANGED', 'The live source set changed; review it again');
        }
        if (!transition || ['aborted', 'released'].includes(transition.phase)) {
          const ready = await review(profile); insist(ready.ready && ready.token === token, 'SOURCE_SELECTION_CHANGED');
          state.sources = active;
          privateDirectory(directory); clearLegacyArtifacts(state);
          atomicJson(path.join(directory, profile + '.mode'), { profile, install: state.install, ownerRoot: state.ownerRoot,
            engineRoot: selection.root, fingerprint: state.fingerprint });
          for (const source of active) await call(source, { op: 'source.join', profile, install: state.install,
            ownerRoot: state.ownerRoot, engineRoot: selection.root, fingerprint: state.fingerprint, helper,
            recoveryConfig: { home: selection.home, root: selection.root, label: selection.label, service: secretAdapter.service } });
          save(state, 'joined'); await owner.pruneDead();
          transition = await owner.begin({ generation: recovered.owner.generation, to: 'service', target: selection.label,
            inventory: { complete: true, scope: owner.scope, ids: active.map((s) => s.id), otherScopes: [] } });
        }
        state.transition = transition.token; save(state, 'barrier');
        await checkpoint('barrier', state);
        if (['barrier', 'exported'].includes(transition.phase)) {
          const exported = [];
          for (const source of state.sources) exported.push((await call(source, { op: 'source.freeze', transition: transition.token,
            expectedPIDs: state.sources.map((s) => s.pid).sort((a, b) => a - b) })).exported);
          const envelope = buildSelectedTransfer(transition, exported, { selectedSource: state.sourceID });
          if (transition.phase === 'barrier') await owner.exported(transition.token, envelope.hash);
          const receipt = importer.import(envelope); await owner.imported(transition.token, receipt); save(state, 'imported');
        }
        recovered = await owner.recover();
        if (recovered.owner.mode === 'window') await importer.commit(transition.token, { verifyFence: () => verifyFence(state, owner) });
      }
      save(state, 'committed');
      transition = (await owner.recover()).transition;
      const member = await importer.commitRuntimeMember(transition.token);
      atomicJson(path.join(selection.root, 'production-owner.json'), { version: 1, committed: true, ownerRoot: state.ownerRoot,
        profile, install: state.install, transition: transition.token, generation: member.generation, member, target: selection.label });
      save(state, 'launchable'); return { ok: true, generation: member.generation, stage: state.stage };
    } catch (e) {
      if (e.crash) throw e;
      if ((await owner.recover()).owner.mode === 'window' && saved()?.stage !== 'aborted') {
        try { await abortMove(state, owner); }
        catch (restoreError) {
          if (restoreError.crash) throw restoreError;
          e.diagnostics = { ...e.diagnostics, recovery: { code: restoreError.code || 'CUTOVER_RECOVERY_REQUIRED', diagnostics: restoreError.diagnostics } };
        }
      }
      throw e;
    } finally { importer.dispose(); }
  }
  const serviceCall = (value) => require('./daemonControl').controlRequest(privateRoot(selection.root, { create: false }), value,
    { timeoutMs: 30000, maxReplyBytes: 64 * 1024 * 1024, onProgress: require('./cutoverProgress').note });
  async function finish() {
    const state = saved(); insist(state && ['launchable', 'ready'].includes(state.stage), 'SERVICE_OWNERSHIP_REQUIRED');
    const status = await serviceCall({ op: 'status' }), owner = ownerFor(state);
    insist(status.ok && status.mode === 'production' && owner.status().mode === 'service' && owner.status().admission === 'open', 'SERVICE_UNAVAILABLE');
    await notifyLive(state, { op: 'source.client', engineRoot: selection.root });
    save(state, 'ready'); return { ok: true, stage: 'ready', generation: status.generation };
  }
  async function handbackReview() {
    const state = saved();
    if (!state) return { ok: true, ready: true, blockers: [] };
    const status = ownerFor(state).status();
    if (status.mode === 'window' || state.stage === 'returning') return { ok: true, ready: true, blockers: [] };
    try {
      const ready = await serviceCall({ op: 'transition.review' });
      return { ok: true, ready: ready.ready === true, blockers: ready.ready ? [] : [ready.code || 'CURRENT_STATE_EXPORT_REQUIRED'] };
    } catch (_) { return { ok: true, ready: true, blockers: [], offline: true }; }
  }
  function cleanup(state, owner) {
    const production = importerFor(state, owner);
    const returned = state.returnTransition ? createSelectedImporter({ root: path.join(state.ownerRoot, 'return'), target: state.returnTarget, owner, secretAdapter }) : null;
    try { production.cleanupReturned(); returned?.cleanupReturned(); }
    finally { production.dispose(); returned?.dispose(); }
    recovery.remove(path.join(selection.root, 'production-owner.json'));
    recovery.remove(path.join(selection.root, 'production-health.json'));
    recovery.discard(path.join(selection.root, 'cutover-return-state.json')); clearLegacyArtifacts(state);
    recovery.discard(path.join(selection.root, 'production-return-export.json'));
    if (state.returnTransition) secretAdapter.delete('recovery.' + state.returnTransition);
  }
  async function handback() {
    const state = saved(); if (!state) return { ok: true, stage: 'returned' };
    const owner = ownerFor(state); await owner.initialize();
    let recovered = await owner.recover(), transition = recovered.transition;
    if (recovered.owner.mode === 'window' && transition?.to !== 'window') return abortMove(state, owner);
    if (state.stage === 'returned') {
      cleanup(state, owner); await acknowledgeLegacy(state, 'source.return.resume');
      return { ok: true, stage: 'returned' };
    }
    if (recovered.owner.mode === 'window' && transition?.to === 'window' && transition.phase === 'released') {
      await owner.retireWindowTarget(transition.token);
      recovery.remove(path.join(directory, state.profile + '.mode'));
      save(state, 'returned'); cleanup(state, owner);
      await acknowledgeLegacy(state, 'source.return.resume');
      return { ok: true, stage: 'returned', generation: recovered.owner.generation };
    }
    if (recovered.owner.mode === 'service' && transition?.to === 'service' && transition.phase !== 'released') {
      const inactive = importerFor(state, owner);
      try { await inactive.commitRuntimeMember(transition.token); } finally { inactive.dispose(); }
      await owner.started(transition.token, { generation: recovered.owner.generation, target: selection.label, hash: transition.hash, oldResourcesReleased: true });
      await owner.release(transition.token); recovered = await owner.recover(); transition = recovered.transition;
    }
    if (recovered.owner.mode === 'service' && transition?.to !== 'window') {
      const readiness = await handbackReview(); insist(readiness.ready, readiness.blockers[0]);
      const active = await selectedSources(state), previous = state.sources.find((s) => s.id === state.sourceID) || state.sources[0];
      state.returnTarget = 'legacy-return';
      state.returnTargetWorkspace = active.find((s) => s.workspace === previous?.workspace && s.workspace)?.workspace ||
        active.find((s) => s.workspace)?.workspace || previous.workspace;
      // The target ID is import authority, not a promise that this particular
      // extension-host process will survive through release.
      transition = await owner.begin({ generation: recovered.owner.generation, to: 'window', target: state.returnTarget,
        inventory: { complete: true, scope: owner.scope, ids: [selection.label], otherScopes: [] } });
      state.returnTransition = transition.token; save(state, 'returning');
    }
    insist(transition?.to === 'window', 'SERVICE_OWNERSHIP_REQUIRED');
    state.returnTarget ||= transition.target; state.returnTransition = transition.token;
    state.returnTargetWorkspace ||= state.sources.find((s) => s.id === state.sourceID)?.workspace || state.sources[0].workspace;
    save(state, 'returning');
    const importer = createSelectedImporter({ root: path.join(state.ownerRoot, 'return'), target: transition.target, owner, secretAdapter });
    const production = importerFor(state, owner);
    let offlineLease;
    try {
      if (['barrier', 'exported'].includes(transition.phase)) {
        let response;
        try { response = await serviceCall({ op: 'transition.export', transition: transition.token }); } catch (_) { /* offline proof below */ }
        if (!response?.ok) {
          // A failed quiescence may have left a live but sealed graph. Ask
          // only this service to close, then export its durable current state.
          try { await serviceCall({ op: 'transition.stop' }); } catch (_) { /* lock acquisition must still prove absence */ }
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && await require('./daemonLock').probeSocket(path.join(selection.root, 'c.sock')) === 'live')
            await new Promise((resolve) => setTimeout(resolve, 25));
          response = { ok: true, exported: await require('./offlineProductionExport').offlineProductionExport({ selection, owner, importer: production, transition,
            holdLease: (lease) => { offlineLease = lease; } }) };
        }
        insist(response.ok, response.code || 'CURRENT_STATE_EXPORT_REQUIRED');
        const currentTransition = (await owner.recover()).transition;
        if (!currentTransition.acks[response.exported.member.id]) {
          response.exported.ack.deadline = Date.now() + 5000;
          await owner.acknowledge(transition.token, response.exported.member.id, response.exported.ack);
        }
        const envelope = buildSelectedTransfer(transition, [response.exported], { selectedSource: selection.label });
        if (transition.phase === 'barrier') await owner.exported(transition.token, envelope.hash);
        const receipt = importer.import(envelope); await owner.imported(transition.token, receipt); fault('return:imported');
      }
      const record = importer.snapshot().records.find((r) => r.id === transition.token);
      let current;
      const store = require('./keychainStore').createKeychainStore({ adapter: secretAdapter, account: record.account });
      try {
          const keys = [...require('./engineTransfer').SECRET_KEYS, 'nikui.identity', 'nikui.vapid', 'nikui.devices', 'nikui.deviceTrail'];
          current = { ...record.state, returnTargets: [...new Set(state.sources.map((s) => s.workspace))], returnTargetWorkspace: state.returnTargetWorkspace,
            returnNeverActivated: record.state.sources[0].files.neverActivated === true,
            returnKeeper: record.transfer.sources[0].state.keeper,
            returnSecrets: Object.fromEntries(keys.filter((key) => store.get(key) !== undefined).map((key) => [key, store.get(key)])) };
      } finally { store.dispose(); }
      // Compare with the immutable Move receipt, independently of the
      // baselines carried back by the running service.
      const moved = production.snapshot().records.find((r) => r.id === state.transition);
      insist(moved?.initial, 'CURRENT_STATE_EXPORT_REQUIRED');
      require('./engineTransfer').requireConversations(moved.initial.instances.map((s) => s.id), current.instances,
        current.completeAuthority ? current.authority?.values[require('./engineState').DOMAIN]?.retiredInstances || [] : []);
      // Runtime accounting/folder projections can update its source copies.
      // Workspace routing and editor comparison always use the original ones.
      current.sources[0] = { ...current.sources[0], files: { ...current.sources[0].files,
        workspaces: structuredClone(moved.initial.sources) } };
      const workspaces = Object.fromEntries([...new Set([...current.returnTargets, current.returnTargetWorkspace])].filter(Boolean)
        .map((workspace) => [workspace, require('./legacyExtensionSource').workspaceReturn(current, workspace)]));
      fault('return:published');
      if ((await owner.recover()).owner.mode === 'service') {
        await notifyLive(state, { op: 'source.return.prepare', ownerRoot: state.ownerRoot, state: current });
        await importer.commit(transition.token); fault('return:committed');
      }
      const journal = (await owner.recover()).transition;
      const member = journal.phase === 'released' ? record.member : await importer.commitRuntimeMember(transition.token);
      if (state.sharedApplied !== transition.token) {
        let applied = false;
        for (const source of await selectedSources(state, { tolerateUnresponsive: true })) {
          try {
            await call(source, { op: 'source.return.shared', state: current, workspaces, ownerRoot: state.ownerRoot,
              transition: transition.token, target: transition.target, generation: member.generation });
            applied = true; break;
          } catch (e) { if (e.crash) throw e; }
        }
        insist(applied, 'SOURCE_RETURN_TARGET_REQUIRED');
        state.sharedApplied = transition.token; save(state, 'returning');
      }
      for (const source of await selectedSources(state, { tolerateUnresponsive: true })) {
        try { await call(source, { op: 'source.return.apply', payload: workspaces[source.workspace], ownerRoot: state.ownerRoot,
          transition: transition.token, target: transition.target, generation: member.generation }); }
        catch (e) { if (e.crash) throw e; }
      }
      fault('return:applied');
      if (journal.phase !== 'released') {
        await owner.started(transition.token, { generation: member.generation, target: transition.target, hash: record.hash, oldResourcesReleased: true });
        await owner.release(transition.token);
      }
      await owner.retireWindowTarget(transition.token); fault('return:released');
      recovery.remove(path.join(directory, state.profile + '.mode'));
      save(state, 'returned');
      cleanup(state, owner); fault('return:cleaned');
      await acknowledgeLegacy(state, 'source.return.resume');
      return { ok: true, stage: 'returned', generation: member.generation };
    } finally { importer.dispose(); production.dispose(); offlineLease?.release(); }
  }
  function canCancelRegistration() {
    const state = saved();
    if (!state) return { ok: true, legacy: !privateFile(path.join(selection.root, 'production-owner.json'), { optional: true }) };
    const status = ownerFor(state).status(); return { ok: true, legacy: status.mode === 'window' && status.admission === 'open' };
  }
  return { review, forgetReturn: (value) => exclusive(() => forgetReturn(value)), canCancelRegistration, move: (value) => exclusive(() => move(value)), finish: () => exclusive(finish),
    handbackReview, handback: () => exclusive(handback), restore: () => exclusive(handback), saved };
}
module.exports = { createProductionCutover };

