'use strict';
const fs = require('fs'), path = require('path');
const { productionFixture } = require('./helpers/production-cutover');
const { createProductionCutover } = require('../src/productionCutover');
const { hash, atomicJson } = require('../src/engineOwner');
const { inventory, sourceRequest, processProofs } = require('../src/legacySource');
const legacy = require('../src/legacyExtensionSource'), recovery = require('../src/cutoverRecovery');
const errorCode = async (fn) => { try { await fn(); return null; } catch (error) { return error.code; } };

module.exports = async () => {
  suite('R19 disposed sources cannot export empty conversations during an abort reload');
  const aborted = await productionFixture(2);
  try {
    for (const slot of aborted.slots) {
      const session = slot.engine.manager.get('session-' + slot.i);
      session.items.push({ id: 'retained-transcript-' + slot.i, kind: 'text', text: 'Full transcript before abort' });
      session.queue = [{ id: 'typed-' + slot.i, text: 'Full typed prompt', snippets: ['expanded snippet'],
        attachments: [{ mediaType: 'image/png', data: Buffer.from('typed image').toString('base64') }] }];
    }
    const coordinator = createProductionCutover({ selection: aborted.selection, secretAdapter: aborted.adapter,
      fault(stage) { if (stage === 'imported') throw Object.assign(Error('crash'), { code: 'TEST_CRASH', crash: true }); } });
    checkEqual('both windows freeze before the simulated loss', await errorCode(async () => coordinator.move(await coordinator.review())), 'TEST_CRASH');
    await coordinator.restore();
    const refused = await coordinator.review();
    check('disposed sources remain unavailable until actual reactivation', !refused.ready && refused.blockers.includes('SOURCE_RELOADING') &&
      aborted.slots.every((slot) => slot.engine.manager.list.length === 0 && !slot.source.legacy));
    const bytes = aborted.slots.map((slot) => fs.readFileSync(slot.source.snapshotsFile));
    checkEqual('a premature retry is refused before exporting empty managers', await errorCode(() => coordinator.move(refused)), 'SOURCE_RELOADING');
    check('refused retry does not replace any saved snapshot', aborted.slots.every((slot, i) => fs.readFileSync(slot.source.snapshotsFile).equals(bytes[i])));
    for (const slot of aborted.slots) { await aborted.close(slot); await aborted.open(slot); }
    check('each reactivated window contains its own original conversation and transcript', aborted.slots.every((slot) =>
      slot.source.legacy && slot.engine.manager.get('session-' + slot.i)?.items.some((item) => item.id === 'retained-transcript-' + slot.i)));
    check('every reactivated queue retains full typed text, snippets and image bytes', aborted.slots.every((slot) =>
      slot.engine.manager.get('session-' + slot.i).queue[0]?.attachments[0].data === Buffer.from('typed image').toString('base64') &&
      slot.engine.manager.get('session-' + slot.i).queue[0].snippets[0] === 'expanded snippet'));
    check('only rebuilt writers become eligible for the next Move', (await coordinator.review()).ready);
  } finally { await aborted.cleanup(); }

  suite('R19 barrier-time teardown retains a seed even before its memento completes');
  const barrier = await productionFixture(2);
  try {
    const b = barrier.slots[1];
    b.engine.manager.get('session-1').items.push({ id: 'before-freeze', kind: 'text', text: 'Saved before source.freeze' });
    let reloaded = false;
    const coordinator = createProductionCutover({ selection: barrier.selection, secretAdapter: barrier.adapter,
      async checkpoint(stage) {
        if (stage !== 'barrier' || reloaded) return;
        reloaded = true; await barrier.close(b);
        await b.original.workspaceState.update('nikui.sessions.v1', undefined);
        await barrier.open(b);
      } });
    await errorCode(async () => coordinator.move(await coordinator.review()));
    await coordinator.restore();
    for (const slot of barrier.slots) { await barrier.close(slot); await barrier.open(slot); }
    check('the source snapshot recovers a conversation missing from the final memento', b.engine.manager.get('session-1')?.items.some((item) => item.id === 'before-freeze'));
  } finally { await barrier.cleanup(); }

  suite('R19 explicit settings-conflict exit preserves current settings and all returned work');
  const f = await productionFixture(2);
  try {
    const b = f.slots[1], coordinator = f.coordinator();
    await coordinator.move(await coordinator.review()); await f.start(); await coordinator.finish();
    const session = f.runtime.engine.manager.get('session-1');
    session.items.push({ id: 'moved-text', kind: 'text', text: 'Work while moved' });
    session.pausedUntil = Date.now() + 3600000;
    const queued = await session.enqueue('Returned full input', [{ name: 'returned.png', mediaType: 'image/png', data: Buffer.from('returned-image').toString('base64') }], { snippets: ['returned snippet'] });
    checkEqual('the full moved-period input is actually admitted', queued.outcome, 'applied');
    f.runtime.currentState.beginDrain(); await f.runtime.currentState.flush();
    await f.close(b); await coordinator.restore(); await f.stop();
    b.workspace.model = 'git-checkout-model'; b.folder.fontSize = 27;
    await f.open(b);
    check('changed settings expose recovery without constructing a writer', b.source.recovering && !b.engine && b.source.recoveryProblem === 'RESTORE_SUPERSEDED');
    const saved = recovery.entry(b.original, b.project), adapters = legacy.returnAdapters(b.source, b.original, b.vscode);
    const delivery = { directory: f.directory, profile: f.profile, install: saved.install, workspace: b.project, context: b.original,
      validate: adapters.canDeliverWorkspace, apply: adapters.importWorkspace, keepSettings: true };
    checkEqual('a settings override requires an explicit action', await errorCode(() => recovery.deliver(delivery)), 'RESTORE_CONFIRMATION_REQUIRED');
    const baseline = b.original.workspaceState.get('nikui.sessions.v1');
    await b.original.workspaceState.update('nikui.sessions.v1', [...baseline, { id: 'later-editor-work', cwd: b.project }]);
    checkEqual('keeping settings cannot overwrite later conversation changes', await errorCode(() => recovery.deliver({ ...delivery, explicit: true })), 'RESTORE_SUPERSEDED');
    await b.original.workspaceState.update('nikui.sessions.v1', baseline);
    checkEqual('confirmed conversation import succeeds with the same ownership and memento checks', await recovery.deliver({ ...delivery, explicit: true }), true);
    checkEqual('workspace and folder settings remain at their current exact scopes', [b.workspace.model, b.folder.fontSize], ['git-checkout-model', 27]);
    await f.close(b); await f.open(b);
    const restored = b.engine.manager.get('session-1');
    check('returned transcript and full queued input are usable after reload', b.source.legacy && restored.items.some((item) => item.id === 'moved-text') &&
      restored.queue[0]?.text === 'Returned full input' && restored.queue[0].snippets[0] === 'returned snippet' &&
      restored.queue[0].attachments[0].data === Buffer.from('returned-image').toString('base64'));
    check('successful explicit delivery removes the Move blocker', (await coordinator.review()).ready);
  } finally { await f.cleanup(); }

  suite('R19 missing-folder returns have a confirmed encrypted archive exit');
  const missing = await productionFixture(2);
  try {
    const b = missing.slots[1], a = missing.slots[0], coordinator = missing.coordinator();
    await coordinator.move(await coordinator.review()); await missing.start(); await coordinator.finish();
    missing.runtime.engine.manager.get('session-1').pausedUntil = Date.now() + 3600000;
    await missing.runtime.engine.manager.get('session-1').enqueue('Archived typed work', [], { snippets: ['archive snippet'] });
    missing.runtime.currentState.beginDrain(); await missing.runtime.currentState.flush();
    await missing.close(b); await coordinator.restore(); await missing.stop();
    fs.renameSync(b.project, b.project + '-renamed');
    const review = await coordinator.review(), saved = review.pendingReturns.find((item) => item.workspace === b.project);
    check('review identifies the exact missing folder and preserves its blocker', saved?.missing === true && review.blockers.includes('PENDING_FOLDER_RETURNS'));
    const original = fs.readFileSync(recovery.payloadFile(b.original, b.project));
    checkEqual('the coordinator refuses an unconfirmed forget', await errorCode(() => coordinator.forgetReturn({ ...saved, profile: missing.profile })), 'RESTORE_CONFIRMATION_REQUIRED');
    checkEqual('stale confirmations cannot forget a changed return', await errorCode(() => coordinator.forgetReturn({ ...saved, hash: 'stale', profile: missing.profile, confirmed: true })), 'RESTORE_SUPERSEDED');
    const before = JSON.stringify({ global: missing.global.values, secrets: [...missing.secrets.values], user: missing.user, writes: a.writes });
    const adapters = legacy.returnAdapters(a.source, a.original, a.vscode);
    checkEqual('conflicting staging fails before shared settings, global state or secrets change', await errorCode(() => adapters.importShared({ sources: [{}], returnSecrets: {} },
      { generation: 99, transition: 'later-transition', binding: { profile: missing.profile }, workspaces: {} })), 'PENDING_FOLDER_RETURNS');
    checkEqual('a rejected stage has no shared-state side effects', JSON.stringify({ global: missing.global.values, secrets: [...missing.secrets.values], user: missing.user, writes: a.writes }), before);
    const identity = missing.global.get('nikui.identity');
    const rename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (String(to).includes('/cutover-archives/')) {
          const sealed = JSON.parse(fs.readFileSync(to)); sealed.tag = Buffer.alloc(16).toString('base64'); fs.writeFileSync(to, JSON.stringify(sealed));
        }
      };
      checkEqual('archive authentication failure retains the original return', await errorCode(() => coordinator.forgetReturn({ ...saved, profile: missing.profile, confirmed: true })), 'RESTORE_STATE_UNAVAILABLE');
    } finally { fs.renameSync = rename; }
    check('archive failure leaves the payload byte-identical and still pending', fs.readFileSync(recovery.payloadFile(b.original, b.project)).equals(original) && recovery.pending(b.original, b.project));
    const result = await coordinator.forgetReturn({ ...saved, profile: missing.profile, confirmed: true });
    const sealed = JSON.parse(fs.readFileSync(result.archive)), archived = recovery.unseal(sealed, identity);
    const file = archived.files.find((file) => file.name === path.basename(recovery.payloadFile(b.original, b.project)));
    check('the encrypted archive authenticates the original complete return bytes', Buffer.from(file.data, 'base64').equals(original) && archived.receipt.workspace === b.project);
    check('archived plaintext never appears in the file and access stays private', !fs.readFileSync(result.archive, 'utf8').includes('Archived typed work') &&
      (fs.statSync(result.archive).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(result.archive)).mode & 0o777) === 0o700);
    check('confirmed archive removes only this pending return and unblocks Move', !recovery.pending(b.original, b.project) &&
      !fs.existsSync(recovery.payloadFile(b.original, b.project)) && (await coordinator.review()).ready && !!a.engine.manager.get('session-0'));
  } finally { await missing.cleanup(); }

  suite('R19 recovery UI confirms both exits and cancellation leaves work intact');
  const ui = await productionFixture();
  try {
    const slot = ui.slots[0], commands = new Map(), warnings = [], actions = [];
    let answer, imports = 0, forgotten = 0;
    const workspace = slot.project, key = recovery.pendingKey(workspace);
    await ui.global.update(key, { workspace, hash: 'fixture', transition: 'fixture' });
    const vscode = { workspace: slot.vscode.workspace, commands: {
      registerCommand(name, fn) { commands.set(name, fn); return { dispose() {} }; },
      async executeCommand(name) { actions.push(name); return commands.get(name)?.(); } }, window: {
      async showWarningMessage(...args) { warnings.push(args); return answer; }, showInformationMessage() {},
      createStatusBarItem() { return { show() {}, dispose() {} }; }, createTreeView() { return { dispose() {} }; }
    } };
    slot.original.subscriptions = [];
    const panel = require('../src/legacyRecoveryUI').showRecovery(slot.original, vscode, {
      async deliverRestore(options) { imports++; check('confirmed import requests only the explicit settings override', options.explicit && options.keepSettings); return true; },
      async forgetRestore() { forgotten++; return { archive: '/encrypted/archive' }; }
    }, { recovery: true });
    await commands.get('nikui.importSavedConversations')(); await commands.get('nikui.discardSavedReturn')();
    check('cancelling either modal performs no import, forget or reload', imports === 0 && forgotten === 0 && !actions.length && recovery.pending(slot.original, workspace));
    check('both recovery decisions use modal confirmation dialogs', warnings.length === 2 && warnings.every((args) => args[1].modal === true));
    answer = 'Import Conversations'; await commands.get('nikui.importSavedConversations')();
    answer = 'Discard Saved Return'; await commands.get('nikui.discardSavedReturn')();
    check('confirmed exits run once and request fresh editor activation', imports === 1 && forgotten === 1 && actions.filter((name) => name.endsWith('reloadWindow')).length === 2);
    panel.dispose(); await ui.global.update(key, undefined);
  } finally { await ui.cleanup(); }

  suite('R19 local Claude processes block Move only while work is in flight');
  for (const keeperDown of [false, true]) {
  const idle = await productionFixture();
  const windowInventory = require('../src/sourceWindowInventory'), originalInventory = windowInventory.sourceWindowInventory;
  try {
    const slot = idle.slots[0]; await idle.close(slot);
    slot.original.subscriptions = [];
    slot.vscode.commands = { registerCommand() { return { dispose() {} }; } };
    slot.vscode.window = { createStatusBarItem() { return { show() {}, dispose() {} }; }, createTreeView() { return { dispose() {} }; } };
    windowInventory.sourceWindowInventory = async () => ({ complete: true, pids: [process.pid], windows: 1 });
    let unavailableRequests = 0;
    const keeper = keeperDown ? { dir: path.join(idle.home, 'unavailable-keeper'), metaVersion: null,
      async request() { unavailableRequests++; throw Error('Keeper is down'); }, async close() {} } : undefined;
    await idle.open(slot, { productionAdapters: true, keeper });
    const session = slot.engine.manager.get('session-0'), coordinator = idle.coordinator();
    session._attaching = Promise.resolve(false);
    check('an unresolved attachment blocks Move before a process is available', (await coordinator.review()).blockers.includes('CLAUDE_OWNED_BUSY'));
    session._attaching = null; session.start();
    const proc = session.proc;
    check('a local idle process with no keeper is eligible for Move', !!proc && !proc.kept && !session.inTurn && (await coordinator.review()).ready);
    session._setStatus('working');
    check('an actual in-flight local turn still blocks Move', (await coordinator.review()).blockers.includes('CLAUDE_OWNED_BUSY'));
    session._setStatus('idle'); session.backgroundTasks.push({ id: 'background', type: 'local_bash', description: 'watcher' });
    check('background work remains protected even between turns', (await coordinator.review()).blockers.includes('CLAUDE_OWNED_BUSY'));
    session.backgroundTasks = [];
    proc.state = 'pending'; proc.kept = true;
    check('a pending keeper spawn cannot cross the Move barrier', (await coordinator.review()).blockers.includes('CLAUDE_OWNED_BUSY'));
    delete proc.state; proc.kept = false;
    if (keeperDown) {
      proc.kept = true;
      check('a genuinely keeper-held process still requires keeper metadata', (await coordinator.review()).blockers.includes('KEEPER_METADATA_INCOMPLETE'));
      proc.kept = false;
    }
    await coordinator.move(await coordinator.review());
    check('Move closes the quiescent source input before it commits', proc.stdin.writableEnded && !session.proc && slot.engine.manager.list.length === 0 && coordinator.saved().stage === 'launchable');
    if (keeperDown) check('an unavailable keeper with no held sessions is neither queried nor exported', unavailableRequests === 0 &&
      JSON.parse(fs.readFileSync(path.join(idle.selection.root, 'generation-import.json'))).records[0].state.sources[0].files.keepers.length === 0);
    await coordinator.restore();
    check('handback after the idle-process Move retains its conversation', !!slot.engine.manager.get('session-0') && slot.source.legacy);
  } finally { windowInventory.sourceWindowInventory = originalInventory; await idle.cleanup(); }
  }

  suite('R19 stale source process identities never wait for an unrelated reused PID');
  const stale = await productionFixture();
  try {
    const slot = stale.slots[0];
    const original = (await inventory(stale.directory))[0];
    await stale.close(slot);
    const descriptor = { ...original, processProof: 'a'.repeat(64) }; delete descriptor.review;
    const staleFile = path.join(stale.directory, descriptor.id + '.json'); atomicJson(staleFile, descriptor);
    const started = Date.now();
    check('a reused live PID with a different process identity is skipped before wake/socket waiting',
      (await inventory(stale.directory, { processSnapshot: () => new Map([[descriptor.pid, 'b'.repeat(64)]]) })).length === 0 && Date.now() - started < 1000);
    fs.unlinkSync(staleFile);
    const proofs = processProofs([12], () => ({ status: 0, stdout: ' 12 Sun Nov 22 12:34:56 2026   fixture --argument\n' }));
    check('process identities normalize ps column padding', proofs.get(12) === hash('Sun Nov 22 12:34:56 2026 fixture --argument'));
  } finally { await stale.cleanup(); }
};
