'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { productionFixture } = require('./helpers/production-cutover');
const { sourceRequest } = require('../src/legacySource');
const { atomicJson, hash } = require('../src/engineOwner');
const recovery = require('../src/cutoverRecovery');
const crash = () => Object.assign(Error('isolated process loss'), { code: 'TEST_CRASH', crash: true });
const install = '/fixture/compatible-extension';
const returnStages = ['returning', 'return:imported', 'return:published', 'source.return.prepare', 'return:committed',
  'source.return.shared', 'source.return.apply', 'return:applied', 'return:released', 'returned', 'return:cleaned', 'source.return.resume'];

module.exports = async () => {
  suite('R13 owner-authoritative source fence');
  const joined = await productionFixture(2);
  try {
    await joined.close(joined.slots[1]);
    let raced = false;
    const coordinator = joined.coordinator({ request: async (source, request) => {
      const reply = await sourceRequest(source, request);
      if (request.op === 'source.join' && !raced) {
        raced = true; await joined.open(joined.slots[1]);
        check('a new window between join and barrier retains the shared mode file', fs.existsSync(path.join(joined.directory, joined.profile + '.mode')));
        await joined.close(joined.slots[1]);
      }
      return reply;
    } });
    await coordinator.move(await coordinator.review());
    await joined.close(joined.slots[0]); await joined.open(joined.slots[0]);
    check('the original source reloads as a service client after the racing window closes', raced && joined.slots[0].source.service && !joined.slots[0].engine);
    await coordinator.restore();
  } finally { await joined.cleanup(); }
  const missing = await productionFixture();
  try {
    const coordinator = missing.coordinator({ fault(stage) {
      if (stage.startsWith('source.freeze:')) fs.unlinkSync(path.join(missing.directory, missing.profile + '.mode'));
    } });
    let code;
    try { await coordinator.move(await coordinator.review()); } catch (e) { code = e.code; }
    checkEqual('commit rejects a missing shared fence after every source acknowledged', code, 'SOURCE_FENCE_MISSING');
    checkEqual('failed fence verification returns the original writer generation', missing.coordinator().saved().stage, 'aborted');
  } finally { await missing.cleanup(); }

  suite('R13 shared return completes once, with an editor acknowledgement');
  const offline = await productionFixture(2);
  try {
    const coordinator = offline.coordinator(); await coordinator.move(await coordinator.review()); await offline.start(); await coordinator.finish();
    for (const slot of offline.slots) await offline.close(slot);
    let blocked;
    try { await coordinator.restore(); } catch (e) { blocked = e.code; }
    const state = coordinator.saved();
    const owner = require('../src/engineOwner').createOwner({ root: state.ownerRoot, profile: offline.profile, install });
    check('all editors closed retains a fence and Keychain state instead of completing a deferred shared replay',
      blocked === 'SOURCE_RETURN_TARGET_REQUIRED' && owner.status().admission === 'closed' && offline.adapter.values.size > 0);
    await offline.open(offline.slots[0]); await coordinator.restore(); await offline.stop();
    await offline.slots[0].source.context.globalState.update('nikui.names.v1', { afterReturn: true });
    await coordinator.restore();
    check('a reopened editor acknowledges shared restoration and a repeated Restore cannot replay it',
      owner.status().admission === 'open' && offline.adapter.values.size === 0 && offline.global.get('nikui.names.v1').afterReturn && !offline.slots[0].source.needsAdmission);
    for (const slot of offline.slots) await offline.close(slot);
    let repeated;
    try { await coordinator.restore(); } catch (e) { repeated = e.code; }
    checkEqual('an engine journal completion flag cannot bypass the editor-owned acknowledgement on retry', repeated, 'SOURCE_RETURN_TARGET_REQUIRED');
  } finally { await offline.cleanup(); }
  for (const edit of [false, true]) {
    const f = await productionFixture(2);
    try {
      const coordinator = f.coordinator(); await coordinator.move(await coordinator.review()); await f.start(); await coordinator.finish();
      const changed = f.runtime.engine.manager.get('session-1'); changed.customTitle = 'Latest app title';
      f.runtime.engine.manager.persist(); await f.runtime.currentState.flush();
      await f.close(f.slots[1]); await coordinator.restore(); await f.stop();
      if (edit) f.slots[1].workspace.model = 'manual edit while closed';
      await f.open(f.slots[1]);
      check(edit ? 'an offline workspace setting edit retains the return in recovery without overwriting that edit'
        : 'an untouched closed workspace consumes only its current workspace return', edit ?
        f.slots[1].workspace.model === 'manual edit while closed' && !f.slots[1].engine && f.slots[1].source.recovering &&
          fs.existsSync(recovery.payloadFile(f.slots[1].original, f.slots[1].project)) :
        f.slots[1].engine.manager.get('session-1').customTitle === 'Latest app title');
    } finally { await f.cleanup(); }
  }
  const duringReturn = await productionFixture(2);
  try {
    let hit = false;
    const coordinator = duringReturn.coordinator({ fault(stage) {
      if (!hit && stage.startsWith('source.return.shared:')) { hit = true; throw crash(); }
    } });
    await coordinator.move(await coordinator.review()); await duringReturn.start(); await coordinator.finish();
    duringReturn.runtime.engine.manager.get('session-1').customTitle = 'Current return in progress';
    duringReturn.runtime.engine.manager.persist(); await duringReturn.runtime.currentState.flush();
    await duringReturn.close(duringReturn.slots[1]);
    try { await coordinator.restore(); } catch (e) { if (e.code !== 'TEST_CRASH') throw e; }
    await duringReturn.open(duringReturn.slots[1]);
    check('a workspace reopening before release keeps its genuine pending delivery and exposes recovery',
      hit && duringReturn.slots[1].source.recovering && fs.existsSync(recovery.permitFile(duringReturn.slots[1].original, duringReturn.slots[1].project)));
    await duringReturn.coordinator().restore(); await duringReturn.stop();
    await duringReturn.close(duringReturn.slots[1]); await duringReturn.open(duringReturn.slots[1]);
    check('retry after that reopen imports its current workspace before legacy starts',
      duringReturn.slots[1].engine.manager.get('session-1').customTitle === 'Current return in progress');
  } finally { await duringReturn.cleanup(); }

  suite('R13 closed-folder crash matrix: released returns cannot overwrite later legacy edits');
  for (const stage of returnStages) for (const secondCycle of [false, true]) {
    if (process.env.NIKUI_RELEASE_CASE && stage !== process.env.NIKUI_RELEASE_CASE) continue;
    const f = await productionFixture(2);
    let armed = false, hit = false;
    try {
      const coordinator = f.coordinator({ fault(value) {
        if (armed && !hit && (value === stage || value.startsWith(stage + ':'))) { hit = true; throw crash(); }
      } });
      await coordinator.move(await coordinator.review()); await f.start(); await coordinator.finish();
      const originalOwner = coordinator.saved().ownerRoot;
      const replay = Object.fromEntries(['engine-owner.json', 'engine-owner.json.participants', 'engine-owner.json.transition']
        .map((name) => [path.join(originalOwner, name), fs.readFileSync(path.join(originalOwner, name))]));
      replay[path.join(f.directory, f.profile + '.mode')] = fs.readFileSync(path.join(f.directory, f.profile + '.mode'));
      f.runtime.engine.manager.create({ id: 'app-work', cwd: f.slots[0].project, autoStart: false });
      await f.runtime.currentState.flush(); await f.close(f.slots[1]); armed = true;
      try { await coordinator.restore(); } catch (e) { if (e.code !== 'TEST_CRASH') throw e; }
      await f.coordinator().restore(); await f.stop();
      const oldState = f.slots[0].returned, oldRequest = f.coordinator().saved();
      const payload = recovery.entry(f.slots[1].original, f.slots[1].project).payload;
      check(stage + ' closed-folder delivery has workspace data only', hit && payload &&
        !['sources', 'returnSecrets', 'global', 'ledger', 'authority'].some((key) => Object.hasOwn(payload, key)));
      const phoneKey = require('../src/identity').readPublicKey((await require('./helpers/device').makeDevice('New phone')).publicKey);
      const newPhone = { id: 'new-phone', name: 'New phone', publicKey: phoneKey.spki, fingerprint: phoneKey.fingerprint,
        pairedAt: 1, lastSeenAt: 1, lastAddress: null, control: true, protection: 'software', biometric: false, local: true };
      if (secondCycle) {
        check(stage + ' requires the closed folder to return before a second Move', (await f.coordinator().review()).blockers.includes('PENDING_FOLDER_RETURNS'));
        await f.open(f.slots[1]); await f.close(f.slots[1]);
      }
      // Shared writes cannot revoke another folder's pending work. Its own
      // later workspace edit below must still supersede that deferred return.
      await f.slots[0].source.context.globalState.update('nikui.names.v1', { later: stage });
      await f.secrets.store('nikui.slack.userToken', 'newer-token');
      await f.global.update('nikui.devices', [newPhone]);
      f.user.model = 'later-user-model'; f.slots[1].workspace.model = 'later-workspace-model';
      const ledger = path.join(f.slots[0].original.globalStorageUri.fsPath, 'ledger.json');
      fs.writeFileSync(ledger, JSON.stringify({ version: 1, instances: { later: { cost: 42 } } }), { mode: 0o600 });
      if (secondCycle) {
        await f.close(f.slots[0]); await f.open(f.slots[0]);
        const next = f.coordinator(); await next.move(await next.review()); await f.start(); await next.finish();
        await next.restore(); await f.stop();
        await f.slots[0].source.context.globalState.update('nikui.names.v1', { later: stage });
        await f.secrets.store('nikui.slack.userToken', 'newer-token');
        await f.global.update('nikui.devices', [newPhone]);
      }
      const staleFile = recovery.restoreFile(f.directory, f.profile, f.slots[1].project);
      atomicJson(staleFile, recovery.seal(oldState, f.global.get('nikui.identity'), {
        profile: f.profile, install, ownerRoot: oldRequest.ownerRoot, generation: 2, transition: oldRequest.returnTransition, workspace: f.slots[1].project }));
      for (const extension of ['snapshots', 'keepers', 'authority']) atomicJson(path.join(f.directory,
        f.profile + '.' + hash(f.slots[1].project).slice(0, 12) + '.' + extension), { corrupt: 'old generation' });
      atomicJson(path.join(f.selection.root, 'cutover-return-state.json'), { corrupt: 'must never be read' });
      for (const [file, bytes] of Object.entries(replay)) fs.writeFileSync(file, bytes, { mode: 0o600 });
      await f.open(f.slots[1]);
      check(stage + (secondCycle ? ' after completed returns and second Move+handback reopens as a usable legacy writer' : ' retains mismatched folder work in recovery'),
        !f.slots[1].source.service && !fs.existsSync(staleFile) && (secondCycle ? !!f.slots[1].engine && !f.slots[1].source.recovering :
          !f.slots[1].engine && f.slots[1].source.recovering && fs.existsSync(recovery.payloadFile(f.slots[1].original, f.slots[1].project))));
      check(stage + ' released files cannot revert shared settings, credentials, devices, ledger or workspace edits',
        f.global.get('nikui.names.v1').later === stage && f.secrets.values.get('nikui.slack.userToken') === 'newer-token' &&
        f.global.get('nikui.devices')[0].id === 'new-phone' && f.user.model === 'later-user-model' &&
        f.slots[1].workspace.model === 'later-workspace-model' && fs.readFileSync(ledger, 'utf8').includes('later'));
      check(stage + ' valid old mode and owner records cannot reactivate a released service generation',
        !f.slots[1].source.service && !f.slots[1].source.needsAdmission);
      check(stage + ' successful return leaves no secret-bearing return cache or generation accounts',
        !fs.existsSync(path.join(f.selection.root, 'production-return-export.json')) && f.adapter.values.size === 0);
    } finally { await f.cleanup(); }
  }

  suite('R15 unknown fences retain recovery without admitting a second writer');
  const corrupt = await productionFixture();
  try {
    const slot = corrupt.slots[0]; await corrupt.close(slot);
    slot.original.extensionMode = 1; slot.original.extensionUri = { fsPath: install }; slot.original.subscriptions = [];
    const home = os.homedir; os.homedir = () => corrupt.home;
    try {
      for (const body of ['{', JSON.stringify({ profile: 'wrong' })]) {
        fs.writeFileSync(path.join(corrupt.directory, corrupt.profile + '.mode'), body, { mode: 0o600 });
        fs.writeFileSync(recovery.restoreFile(corrupt.directory, corrupt.profile, slot.project), '{bad delivery', { mode: 0o600 });
        const source = require('../src/legacyExtensionSource').prepare(slot.original, slot.vscode);
        check('unknown fence selects recovery and remains available to the coordinator', !source.service && source.recovering &&
          !source.needsAdmission && fs.existsSync(path.join(corrupt.directory, corrupt.profile + '.mode')));
        checkEqual('undeliverable restore is discarded without throwing', await source.deliverRestore(), false);
        await source.dispose();
      }
    } finally { os.homedir = home; }
  } finally { await corrupt.cleanup(); }
};
