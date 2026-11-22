'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { productionFixture } = require('./helpers/production-cutover');
const { createOwner, atomicJson, hash } = require('../src/engineOwner');
const recovery = require('../src/cutoverRecovery');
const legacy = require('../src/legacyExtensionSource');
const { sourceRequest } = require('../src/legacySource');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorCode = async (action) => { try { await action(); return null; } catch (e) { return e.code; } };

module.exports = async () => {
  suite('R17 reload during Move, then delayed disposal writes settle before ownership commits');
  const reload = await productionFixture(2);
  try {
    let reloaded = false;
    const interrupted = reload.coordinator({ async checkpoint(stage) {
      if (stage === 'barrier' && !reloaded) {
        reloaded = true; await reload.close(reload.slots[1]); await reload.open(reload.slots[1]);
        check('the reloaded source enters recovery behind the admission barrier', reload.slots[1].source.recovering && !reload.slots[1].engine);
      }
    } });
    const aborted = await errorCode(async () => interrupted.move(await interrupted.review()));
    check('a changed live source set aborts safely', ['SOURCE_UNRESPONSIVE', 'CONTROL_UNAVAILABLE', 'ENOENT'].includes(aborted) && interrupted.saved().stage === 'aborted');
    for (const slot of reload.slots) { await reload.close(slot); await reload.open(slot); }
    let pending = 0, completed = 0, disposalStarted = false;
    const slot = reload.slots[1], update = slot.original.workspaceState.update.bind(slot.original.workspaceState);
    slot.original.workspaceState.update = (key, value) => {
      const result = update(key, value);
      if (!disposalStarted && key !== 'disposal-follow-up') return result;
      pending++;
      return delay(35).then(async () => {
        await result; completed++;
        if (key === 'nikui.sessions.v1') await slot.source.context.workspaceState.update('disposal-follow-up', completed);
      }).finally(() => pending--);
    };
    const dispose = slot.engine.dispose.bind(slot.engine);
    slot.engine.dispose = () => { disposalStarted = true; try { return dispose(); } finally { disposalStarted = false; } };
    const coordinator = reload.coordinator({ async request(source, request) {
      const response = await sourceRequest(source, request);
      if (request.op === 'source.freeze' && source.workspace === slot.project)
        check('final stopped-status writes and their follow-up complete before the source acknowledges', response.ok && pending === 0 && completed >= 2);
      return response;
    } });
    await coordinator.move(await coordinator.review()); await reload.start(); await coordinator.finish();
    reload.runtime.engine.manager.create({ id: 'after-reloaded-move', cwd: slot.project, autoStart: false });
    await reload.runtime.currentState.flush(); await coordinator.restore(); await reload.stop();
    for (const current of reload.slots) { await reload.close(current); await reload.open(current); }
    check('reload/retry completes Move, service start, handback and usable editor restoration end to end',
      reload.slots.every((s) => s.source.legacy && s.engine) && !!slot.engine.manager.get('after-reloaded-move'));
  } finally { await reload.cleanup(); }

  suite('R17 closed-folder handback survives a refused and cancelled later Move');
  for (const mismatch of [false, true]) {
    const f = await productionFixture(2);
    try {
      const [a, b] = f.slots, coordinator = f.coordinator();
      await coordinator.move(await coordinator.review()); await f.start(); await coordinator.finish();
      const session = f.runtime.engine.manager.get('session-1');
      session.rename('B work while moved'); session.items.push({ id: 'r17-transcript', kind: 'text', text: 'Moved-period work for B' });
      const queued = await session.enqueue('R17 B pending input', [], { snippets: ['saved snippet'] });
      f.runtime.currentState.beginDrain(); checkEqual('moved-period input is admitted before drain', queued.outcome, 'applied');
      f.runtime.engine.manager.create({ id: 'r17-b-new', cwd: b.project, autoStart: false });
      await f.runtime.currentState.flush(); await f.close(b); await coordinator.restore(); await f.stop();
      const payload = fs.readFileSync(recovery.payloadFile(b.original, b.project));
      const snapshotFile = path.join(b.original.globalStorageUri.fsPath, 'cutover-' + hash(b.project).slice(0, 12) + '.snapshots');
      const snapshot = fs.readFileSync(snapshotFile);
      const ready = await coordinator.review();
      check('review blocks another Move and names the still-closed folder', !ready.ready && ready.blockers.includes('PENDING_FOLDER_RETURNS') &&
        ready.pendingFolders.includes(b.project) && !ready.pendingFolders.includes(a.project));
      checkEqual('a direct Move call enforces the same pending-folder blocker', await errorCode(() => coordinator.move(ready)), 'PENDING_FOLDER_RETURNS');
      await coordinator.restore(); // Same recovery operation used after cancelling Move.
      check('cancel leaves the closed-folder payload byte-identical', fs.readFileSync(recovery.payloadFile(b.original, b.project)).equals(payload));
      if (mismatch) {
        // Reproduce the pre-fix cancelled-Move journal without bypassing the
        // new review in production. Its phase changes, generation does not.
        const state = coordinator.saved(), owner = createOwner({ root: state.ownerRoot, profile: f.profile, install: state.install });
        b.releasedJournal = fs.readFileSync(owner.file + '.transition');
        const member = await owner.admit({ id: 'old-build-cancelled-move', build: 'fixture', metaVersion: 1 });
        const transition = await owner.begin({ generation: owner.status().generation, to: 'service', target: f.selection.label,
          inventory: { complete: true, scope: owner.scope, ids: [member.id], otherScopes: [] } });
        await owner.abort(transition.token, { targetInactive: true, importDiscarded: true, allSourcesReachable: true });
        await owner.retireClosed(member.lease);
      }
      await f.open(b);
      if (mismatch) {
        check('an aborted later journal retains the full return and exposes recovery before constructing a writer', b.source.recovering &&
          b.source.recoveryProblem === 'RESTORE_SUPERSEDED' && !b.engine && recovery.pending(b.original, b.project) &&
          fs.readFileSync(recovery.payloadFile(b.original, b.project)).equals(payload) && fs.existsSync(recovery.permitFile(b.original, b.project)) &&
          fs.readFileSync(snapshotFile).equals(snapshot));
        await f.close(b);
        const state = coordinator.saved(), owner = createOwner({ root: state.ownerRoot, profile: f.profile, install: state.install });
        fs.writeFileSync(owner.file + '.transition', b.releasedJournal);
        const entry = recovery.entry(b.original, b.project); entry.generation--;
        atomicJson(recovery.payloadFile(b.original, b.project), entry);
        atomicJson(recovery.permitFile(b.original, b.project), { transition: entry.transition, hash: hash(entry) });
        await b.original.globalState.update(recovery.pendingKey(b.project), { ...f.global.get(recovery.pendingKey(b.project)), generation: entry.generation, hash: hash(entry) });
        await f.open(b);
        check('a released but different generation likewise retains its payload and never constructs a legacy writer',
          owner.status().phase === 'released' && b.source.recovering && !b.engine && recovery.entry(b.original, b.project).generation === entry.generation &&
          recovery.pending(b.original, b.project) && fs.existsSync(recovery.permitFile(b.original, b.project)) && fs.readFileSync(snapshotFile).equals(snapshot));
      } else {
        const restored = b.engine.manager.get('session-1');
        check('opening B after cancel restores all moved-period conversations and transcript', b.source.legacy && !!b.engine.manager.get('r17-b-new') &&
          restored.customTitle === 'B work while moved' && restored.items.some((item) => item.id === 'r17-transcript'));
        checkEqual('opening B after cancel preserves the full pending input', restored.queue.map((q) => [q.text, q.snippets]), [['R17 B pending input', ['saved snippet']]]);
        check('a completed folder return unblocks the next Move', (await coordinator.review()).ready);
      }
    } finally { await f.cleanup(); }
  }

  suite('R17 workspace-file/folder-set identity and empty-window returns');
  const f = await productionFixture();
  const prepared = [];
  try {
    const slot = f.slots[0], home = os.homedir;
    slot.original.extensionMode = 1; slot.original.extension = { id: 'nikoloz.nikui' }; slot.original.subscriptions = [];
    const make = () => {
      try { os.homedir = () => f.home; const source = legacy.prepare(slot.original, slot.vscode); prepared.push(source); return source; }
      finally { os.homedir = home; }
    };
    slot.vscode.workspace.workspaceFile = { fsPath: path.join(f.home, 'a.code-workspace'), scheme: 'file' };
    const a = make();
    slot.vscode.workspace.workspaceFile = { fsPath: path.join(f.home, 'b.code-workspace'), scheme: 'file' };
    const b = make();
    check('two workspace files sharing their first folder have distinct recovery artifacts', a.snapshotsFile !== b.snapshotsFile && a.keeperFile !== b.keeperFile);
    delete slot.vscode.workspace.workspaceFile;
    const roots = [slot.project, path.join(f.home, 'extra')];
    slot.vscode.workspace.workspaceFolders = roots.map((fsPath) => ({ uri: { fsPath } }));
    const first = make(); slot.vscode.workspace.workspaceFolders.reverse(); const reordered = make();
    slot.vscode.workspace.workspaceFolders.push({ uri: { fsPath: path.join(f.home, 'another') } }); const changed = make();
    check('folder-set identity is order-independent and changes when the set changes', first.snapshotsFile === reordered.snapshotsFile && first.snapshotsFile !== changed.snapshotsFile);
    slot.vscode.workspace.workspaceFolders = [];
    const empty = make();
    check('empty windows have no workspace snapshots, keeper payload or automatic return', !empty.snapshotsFile && !empty.keeperFile && !empty.pendingRestore &&
      await empty.deliverRestore() === false && legacy.workspaceReturn({}, '') === null);
  } finally { for (const source of prepared) await source.dispose(); await f.cleanup(); }

  for (const kind of ['workspace file', 'folder set', 'empty window']) {
    const f = await productionFixture();
    try {
      const slot = f.slots[0], extra = path.join(f.home, 'second-root'); fs.mkdirSync(extra, { mode: 0o700 });
      await f.close(slot);
      slot.vscode.workspace.workspaceFolders = kind === 'empty window' ? [] : [slot.project, extra].map((fsPath) => ({ uri: { fsPath } }));
      const folderSettings = new Map([[slot.project, { fontSize: 13 }], [extra, { fontSize: 15 }]]);
      if (kind !== 'empty window') slot.vscode.workspace.getConfiguration = (_section, resource) => {
        const folder = folderSettings.get(resource?.fsPath);
        return { inspect: (key) => ({ globalValue: f.user[key], workspaceValue: resource ? slot.workspace[key] : undefined, workspaceFolderValue: folder?.[key] }),
          async update(key, value, target) {
            const settings = target === 1 ? f.user : target === 2 ? slot.workspace : folder;
            if (value === undefined) delete settings[key]; else settings[key] = structuredClone(value);
          } };
      };
      if (kind === 'workspace file') slot.vscode.workspace.workspaceFile = { scheme: 'file', fsPath: path.join(f.home, 'selected.code-workspace') };
      await f.open(slot);
      const coordinator = f.coordinator(); await coordinator.move(await coordinator.review()); await f.start(); await coordinator.finish();
      if (kind !== 'empty window') f.runtime.engine.manager.create({ id: 'created-in-second-root', cwd: extra, autoStart: false });
      if (kind !== 'empty window') await f.runtime.authority.commit((state) => {
        state.values['engine.current.v1'].settings.projects.find((project) => project.root === extra).values.model = 'changed-only-in-second-root';
      });
      await f.runtime.currentState.flush(); await coordinator.restore(); await f.stop();
      await f.close(slot); await f.open(slot);
      check(kind + ' completes Move and handback using its exact source scope', slot.source.legacy && !!slot.engine &&
        (kind === 'empty window' ? recovery.pendingWorkspaces(slot.original).length === 0 : !!slot.engine.manager.get('created-in-second-root')));
      if (kind !== 'empty window') check(kind + ' restores the second root setting without changing the first root',
        slot.workspace.model === 'workspace-model-0' && !folderSettings.get(slot.project).model && folderSettings.get(extra).model === 'changed-only-in-second-root');
    } finally { await f.cleanup(); }
  }

  suite('R17 keeper return remains eligible through two editor reloads');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r17-keeper-')), file = path.join(home, 'return.keepers');
  const run = { runId: 'exact-borrowed-run', key: 'kept', meta: { instance: 'kept', cwd: home, conversation: 'same-conversation' }, exit: null, released: true, compatible: true };
  const transfer = { files: { keepers: [path.join(home, 'borrowed')] }, keeper: { transferred: [run] } };
  let live = true, attachments = 0;
  const factory = (options) => ({ ...options, socket: null, socketPath: options.dir + '/k.sock',
    manifest: new Map(options.store.get('nikd.keeper.v1', { runs: [] }).runs.map((r) => [r.meta.instance, r])),
    _list: async () => options.existingOnly && live ? [run] : [], spawner() { return () => {}; },
    async attach() { attachments++; return true; }, async close() {} });
  try {
    atomicJson(file, transfer);
    for (let reload = 0; reload < 2; reload++) {
      const keeper = legacy.returnedKeeper({ keeperFile: file, keeperTransfer: JSON.parse(fs.readFileSync(file)) },
        { ownDirectory: path.join(home, 'own'), factory, probe: async () => 'live' });
      check('reload ' + (reload + 1) + ' reattaches the exact released run', await keeper.attach({ id: 'kept', cwd: home }));
      await keeper.close();
      check('reload ' + (reload + 1) + ' keeps both keeper manifest and private ownership store while the run is live', fs.existsSync(file) && fs.existsSync(file + '.store'));
    }
    const keeper = legacy.returnedKeeper({ keeperFile: file, keeperTransfer: transfer }, { ownDirectory: path.join(home, 'own'), factory, probe: async () => 'live' });
    live = false; await keeper.close();
    check('proof that the returned runs ended removes both keeper artifacts', attachments === 2 && !fs.existsSync(file) && !fs.existsSync(file + '.store'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
};
