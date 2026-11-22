'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { productionFixture } = require('./helpers/production-cutover');
const recovery = require('../src/cutoverRecovery');
const { atomicJson, createOwner, hash } = require('../src/engineOwner');
const { createLegacyActivation, inventory } = require('../src/legacySource');
const { returnAdapters, prepare } = require('../src/legacyExtensionSource');
const errorCode = async (action) => { try { await action(); return null; } catch (e) { return e.code; } };

module.exports = async () => {
  suite('R15 original queued work imports once and cannot replay on restart');
  const realNow = Date.now; let elapsed = 0;
  Date.now = () => realNow() + elapsed;
  const imported = await productionFixture();
  try {
    const slot = imported.slots[0], before = slot.engine.manager.get('session-0');
    before.queue = [{ id: 'original-queue', text: 'pending original queue', attachments: [], snippets: ['original snippet'] }];
    const coordinator = imported.coordinator(); await coordinator.move(await coordinator.review());
    const first = await imported.start(); first.currentState.beginDrain();
    const original = first.currentState.snapshot().outbox.filter((q) => q.payload.message?.text === 'pending original queue');
    check('Move imports an original legacy queue with the required timestamp and full payload', original.length === 1 &&
      Number.isSafeInteger(original[0].payload.message.issuedAt) && original[0].payload.message.snippets[0] === 'original snippet');
    await imported.stop(); const second = await imported.start(); second.currentState.beginDrain();
    checkEqual('restart does not allocate or redeliver another copy of the imported input',
      second.currentState.snapshot().outbox.filter((q) => q.payload.message?.text === 'pending original queue').map((q) => q.mid), original.map((q) => q.mid));
    // Model retention after an input has been consumed and its receipt/outbox
    // have aged out. The durable completed-import marker must still win.
    await second.authority.commit((state) => {
      for (const item of state.outbox) if (item.queueId) {
        item.state = 'discarded'; item.revision++; item.at = state.clockHighWater;
        item.error = { code: 'CANCELLED', message: 'Consumed fixture input', retryable: false };
        require('../src/jsonlAuthority').reserveOperation(item);
      }
    });
    elapsed += require('../src/jsonlAuthority').LIMITS.retentionMs + require('../src/jsonlAuthority').LIMITS.skewMs + 1000;
    await second.authority.prune();
    await imported.stop(); const third = await imported.start(); third.currentState.beginDrain();
    checkEqual('a completed import never replays Move-time inputs after receipt retention', third.currentState.snapshot().outbox, []);
    await imported.stop(); await coordinator.restore();
    await imported.close(slot); await imported.open(slot);
    checkEqual('handback after restart returns the consumed current queue, without the Move-time snapshot', slot.engine.manager.get('session-0').queue, []);
    check('original queued-work recovery ends in a usable legacy engine', slot.source.legacy && !!slot.engine);
  } finally { try { await imported.cleanup(); } finally { Date.now = realNow; } }
  suite('R15 never-moved windows have lazy sockets and zero per-write filesystem work');
  const lazy = await productionFixture();
  try {
    check('an ordinary legacy window has no control socket before app review', !fs.readdirSync(lazy.directory).some((s) => s.endsWith('.sock')));
    const slot = lazy.slots[0], originals = {}, calls = [];
    const stringify = JSON.stringify; let serializations = 0;
    try {
      JSON.stringify = (...args) => { serializations++; return stringify(...args); };
      for (const name of ['existsSync', 'readdirSync', 'lstatSync', 'statSync', 'readFileSync', 'openSync', 'unlinkSync']) {
        originals[name] = fs[name]; fs[name] = (...args) => { calls.push(name); return originals[name](...args); };
      }
      for (let i = 0; i < 50; i++) {
        slot.source.admit(() => true); slot.source.write(() => true);
        await slot.source.context.workspaceState.update('ordinary-work', i);
        await slot.source.context.globalState.update('ordinary-shared', i);
      }
    } finally { for (const [name, fn] of Object.entries(originals)) fs[name] = fn; JSON.stringify = stringify; }
    checkEqual('admission and changed/unchanged mementos do no per-write filesystem access before Move', calls, []);
    checkEqual('never-moved memento writes skip recovery baseline serialization entirely', serializations, 0);
    checkEqual('review wakes the lazy endpoint and retains a usable legacy source', (await inventory(lazy.directory)).map((s) => s.review.mode), ['legacy']);
    check('a completed review removes its wake request', !fs.existsSync(path.join(lazy.directory, 'review.request')));
    const coordinator = lazy.coordinator(); await coordinator.move(await coordinator.review()); await coordinator.restore();
    await lazy.close(slot); await lazy.open(slot);
    check('a lazy source still completes Move and returns to a working legacy engine', !!slot.engine && slot.source.legacy);
  } finally { await lazy.cleanup(); }

  suite('R15 real configuration event adapter revokes only its own workspace');
  const configuration = await productionFixture(2);
  let prepared;
  try {
    const [a, b] = configuration.slots;
    await recovery.stage(a.original, { profile: configuration.profile, install: 'nikoloz.nikui',
      ownerRoot: path.join(configuration.selection.root, 'o'), generation: 2, transition: 'e'.repeat(32) },
    { [a.project]: { workspace: a.project }, [b.project]: { workspace: b.project } });
    let listener;
    a.vscode.workspace.onDidChangeConfiguration = (callback) => { listener = callback; return { dispose() { listener = null; } }; };
    a.original.extensionMode = 1; a.original.extension = { id: 'nikoloz.nikui' }; a.original.subscriptions = [];
    const home = os.homedir;
    try { os.homedir = () => configuration.home; prepared = prepare(a.original, a.vscode); } finally { os.homedir = home; }
    const scopes = [];
    listener({ affectsConfiguration(key, resource) { scopes.push(resource?.fsPath); return false; } });
    check('unrelated configuration events preserve both pending returns', fs.existsSync(recovery.permitFile(a.original, a.project)) && fs.existsSync(recovery.permitFile(b.original, b.project)));
    listener({ affectsConfiguration(key, resource) { scopes.push(resource?.fsPath); return key === 'nikui.fontSize' && resource?.fsPath === a.project; } });
    check('a project-setting event revokes its own return through the actual prepare adapter', !fs.existsSync(recovery.permitFile(a.original, a.project)));
    check('that event preserves the other closed folder\'s permit and full payload', fs.existsSync(recovery.permitFile(b.original, b.project)) && fs.existsSync(recovery.payloadFile(b.original, b.project)));
    check('configuration matching always uses this window\'s workspace resource', scopes.length > 0 && scopes.every((scope) => scope === a.project));
    for (const item of a.original.subscriptions) item.dispose();
  } finally { await prepared?.dispose(); await configuration.cleanup(); }

  suite('R15 extension updates and unknown ownership never fork legacy writers');
  for (const local of [false, true]) {
    const f = await productionFixture();
    try {
      const slot = f.slots[0], originalHome = os.homedir;
      slot.original.extensionMode = 1; slot.original.subscriptions = [];
      slot.original.extension = { id: 'nikoloz.nikui', packageJSON: { version: '0.2.0' } };
      slot.original.extensionUri = { fsPath: '/fixture/extensions/nikoloz.nikui-0.2.0' };
      let source;
      try { os.homedir = () => f.home; source = prepare(slot.original, slot.vscode); }
      finally { os.homedir = originalHome; }
      checkEqual('installation binds to extension id, independently of versioned path', source.install, 'nikoloz.nikui');
      await source.dispose(); slot.install = 'nikoloz.nikui';
      await f.close(slot); await f.open(slot);
      const coordinator = f.coordinator(); await coordinator.move(await coordinator.review()); await f.start(); await coordinator.finish();
      f.runtime.engine.manager.create({ id: 'work-during-update', cwd: slot.project, autoStart: false }); await f.runtime.currentState.flush();
      await f.close(slot);
      slot.original.extensionUri = { fsPath: '/fixture/extensions/nikoloz.nikui-0.3.0' };
      slot.original.extension.packageJSON.version = '0.3.0';
      try { os.homedir = () => f.home; source = prepare(slot.original, slot.vscode); }
      finally { os.homedir = originalHome; }
      check('reloading vN+1 while moved selects the existing service before engine construction', !!source.service && !source.legacy && !source.recovering);
      await source.dispose();
      const fence = path.join(f.directory, f.profile + '.mode'), bytes = fs.readFileSync(fence);
      const wrong = createLegacyActivation(slot.original, { home: f.home, install: 'unknown.extension', workspace: slot.project });
      check('a valid fence with an unknown install enters recovery and stays byte-identical', wrong.recovering && !wrong.legacy && fs.readFileSync(fence).equals(bytes));
      await wrong.dispose();
      const state = coordinator.saved(), owner = createOwner({ root: state.ownerRoot, profile: f.profile, install: slot.install });
      const ownerBytes = fs.readFileSync(owner.file); fs.writeFileSync(owner.file, '{', { mode: 0o600 });
      const unavailable = createLegacyActivation(slot.original, { home: f.home, install: slot.install, workspace: slot.project });
      check('an owner.status failure retains the fence and exposes recovery', unavailable.recovering && !unavailable.legacy && fs.readFileSync(fence).equals(bytes));
      await unavailable.dispose(); fs.writeFileSync(owner.file, ownerBytes);
      await f.open(slot);
      if (local) {
        const config = path.join(slot.original.globalStorageUri.fsPath, 'cutover-recovery.json');
        atomicJson(config, { version: 1, ...f.selection, profile: f.profile, install: slot.install, app: '/fixture/NikUI.app',
          service: f.adapter.service, helper: path.join(path.dirname(config), 'cutover-recovery/NikKeychain.app') });
        checkEqual('local editor Restore accepts the same stable installation after an update',
          (await require('../src/localCutoverRestore').restore(config, { createAdapter: () => f.adapter, run() { throw Error('disposable job absent'); } })).ok, true);
      } else await coordinator.restore();
      await f.stop(); await f.close(slot); await f.open(slot);
      check((local ? 'local Restore' : 'app handback') + ' after the update returns current work to a usable legacy engine',
        slot.source.legacy && !!slot.engine.manager.get('work-during-update'));
    } finally { await f.cleanup(); }
  }

  suite('R15 per-workspace handback, bounded files and explicit expired recovery');
  const f = await productionFixture(2);
  try {
    const [a, b] = f.slots, coordinator = f.coordinator();
    await coordinator.move(await coordinator.review()); const runtime = await f.start(); await coordinator.finish();
    const changed = runtime.engine.manager.get('session-1');
    atomicJson(b.source.snapshotsFile, { version: 1, sessions: [{ ...changed.snapshot(),
      queue: [{ id: 'stale-move-queue', text: 'already consumed before handback', attachments: [] }] }] });
    changed.rename('Moved-period title');
    changed.items.push({ id: 'moved-transcript', kind: 'text', text: 'Retained while folder B was closed' });
    runtime.engine.manager.create({ id: 'new-in-closed-b', cwd: b.project, autoStart: false });
    await runtime.authority.commit((state) => { state.values['engine.current.v1'].settings.projects.find((p) => p.root === b.project).values.fontSize = 24; });
    const queued = await changed.enqueue('queued during Move', [], { snippets: ['moved snippet'] });
    runtime.currentState.beginDrain(); // retain a current pending queue without starting a synthetic provider
    checkEqual('moved-period input is admitted through the real durable queue', queued.outcome, 'applied');
    await runtime.currentState.flush(); await f.close(b); await coordinator.restore(); await f.stop();
    const entry = recovery.entry(b.original, b.project), receipt = f.global.get(recovery.pendingKey(b.project));
    check('globalState contains only a small receipt, with full workspace payload in its private file',
      !receipt.payload && JSON.stringify(receipt).length < 1024 && entry.payload.instances.some((i) => i.id === 'new-in-closed-b') &&
      (fs.statSync(recovery.payloadFile(b.original, b.project)).mode & 0o777) === 0o600);
    await a.source.context.workspaceState.update('only-a', 'A changed');
    await a.source.context.globalState.update('nikui.names.v1', { shared: 'new value' });
    a.source.admit(() => true);
    check('folder A writes and commands retain folder B authorization', fs.existsSync(recovery.permitFile(b.original, b.project)));
    const binding = Object.fromEntries(['profile', 'install', 'ownerRoot', 'generation', 'transition'].map((key) => [key, entry[key]]));
    const proof = fs.readFileSync(recovery.permitFile(b.original, b.project));
    checkEqual('storage bounds refuse before changing an existing delivery', await errorCode(() => recovery.stage(b.original, binding,
      { [b.project]: entry.payload }, { limits: { workspaces: 1, bytes: 1 } })), 'RESTORE_STORAGE_FULL');
    check('a failed bounded stage leaves the original return permit intact', fs.readFileSync(recovery.permitFile(b.original, b.project)).equals(proof));
    await recovery.stage(b.original, binding, { [b.project]: entry.payload }, { now: () => Date.now() - recovery.LIMITS.automaticAgeMs - 1000 });
    const adapters = returnAdapters({ profile: f.profile, snapshotsFile: path.join(b.original.globalStorageUri.fsPath,
      'cutover-' + hash(b.project).slice(0, 12) + '.snapshots') }, b.original, b.vscode);
    const delivery = { directory: f.directory, profile: f.profile, install: entry.install, workspace: b.project, context: b.original,
      apply: adapters.importWorkspace, validate: adapters.canDeliverWorkspace };
    checkEqual('expired work requires explicit Restore instead of automatic import', await errorCode(() => recovery.deliver(delivery)), 'RESTORE_EXPIRED');
    check('expiry retains both payload and authorization without loading it into globalState', fs.existsSync(recovery.payloadFile(b.original, b.project)) && fs.existsSync(recovery.permitFile(b.original, b.project)));
    checkEqual('explicit Restore revalidates and imports the expired workspace', await recovery.deliver({ ...delivery, explicit: true }), true);
    await f.open(b);
    const restored = b.engine.manager.get('session-1');
    check('closed folder B retains moved-period conversations after A writes', !!b.engine.manager.get('new-in-closed-b'));
    checkEqual('closed folder B retains its moved-period title', restored.customTitle, 'Moved-period title');
    check('closed folder B retains its moved-period transcript', restored.items.some((i) => i.id === 'moved-transcript'));
    checkEqual('closed folder B retains its moved-period folder setting', b.folder.fontSize, 24);
    checkEqual('handback retains moved-period queue data and does not replay the Move-time queue', restored.queue.map((q) => [q.text, q.snippets]), [['queued during Move', ['moved snippet']]]);
    check('successful delivery expires its full payload and permit', !fs.existsSync(recovery.payloadFile(b.original, b.project)) && !fs.existsSync(recovery.permitFile(b.original, b.project)));
    b.source.admit(() => true); await b.source.context.workspaceState.update('usable', true);
    check('explicit recovery ends with a working legacy writer', b.original.workspaceState.get('usable') === true && b.source.legacy);
  } finally { await f.cleanup(); }
};
