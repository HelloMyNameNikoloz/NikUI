'use strict';
const fs = require('fs'), path = require('path');
const { productionFixture } = require('./helpers/production-cutover');
const { createOwner } = require('../src/engineOwner');
const { createKeychainStore } = require('../src/keychainStore');
const recovery = require('../src/cutoverRecovery');
const crash = () => Object.assign(Error('simulated process loss'), { code: 'TEST_CRASH', crash: true });
const code = async (fn) => { try { await fn(); return null; } catch (e) { if (e.code === 'TEST_CRASH') return e.code; throw e; } };

module.exports = async () => {
  suite('R11 abort preserves full typed work across a recovery reload');
  const aborted = await productionFixture(2);
  try {
    const session = aborted.slots[0].engine.manager.get('session-0');
    const queue = [{ id: 'full-abort-queue', text: 'full prompt ქართული '.repeat(1500), sent: '/expanded untruncated',
      snippets: ['expanded snippet'], attachments: [{ mediaType: 'image/png', data: Buffer.from('original typed image bytes').toString('base64') }] }];
    session.queue = structuredClone(queue); session.items.push({ id: 'abort-transcript', kind: 'text', text: 'Transcript before a failed Move' });
    let failed = false, freezing;
    const moving = aborted.coordinator({ fault(stage) { if (!failed && stage === freezing) { failed = true; throw crash(); } } });
    const review = await moving.review();
    freezing = 'source.freeze:' + review.sources.find((s) => s.workspace === aborted.slots[0].project).id;
    await code(() => moving.move(review));
    await aborted.coordinator().restore();
    // The fixture now performs the scheduled recovery reload before Restore
    // returns. A second ordinary reload has no provider transcript fixture.
    const restored = aborted.slots[0].engine.manager.get('session-0');
    checkEqual('an aborted Move retains full queue text, sent text, snippets and attachment bytes', restored.queue, queue);
    check('abort reload retains in-memory transcript text', failed && restored.items.some((i) => i.id === 'abort-transcript' && i.text === 'Transcript before a failed Move'));
    restored.queue = []; aborted.slots[0].engine.manager.persist();
    await aborted.close(aborted.slots[0]); await aborted.open(aborted.slots[0]);
    checkEqual('a later normal reload never resurrects a consumed recovery queue', aborted.slots[0].engine.manager.get('session-0').queue, []);
  } finally { await aborted.cleanup(); }

  suite('R11 offline startup and stale checkpoint queue recovery');
  const starting = await productionFixture(1);
  try {
    const session = starting.slots[0].engine.manager.get('session-0');
    const queue = [{ id: 'before-runtime-start', text: 'full pending legacy input', sent: '/expanded', snippets: ['snippet'],
      attachments: [{ mediaType: 'image/png', data: Buffer.from('pending image').toString('base64') }] }];
    session.queue = structuredClone(queue);
    const coordinator = starting.coordinator(); await coordinator.move(await coordinator.review());
    let stopped;
    try { await starting.start({ fault(stage) { if (stage === 'runtime:authority-open') throw crash(); } }); } catch (e) { stopped = e.code; }
    await coordinator.restore();
    check('startup loss is exercised after authority creation and before queue registration', stopped === 'TEST_CRASH' && starting.slots[0].returned.returnNeverActivated);
    checkEqual('offline restore retains legacy inputs not yet registered in the new outbox', starting.slots[0].returned.instances[0].queue, queue);
  } finally { await starting.cleanup(); }
  const stale = await productionFixture(1);
  try {
    const coordinator = stale.coordinator(); await coordinator.move(await coordinator.review());
    const runtime = await stale.start(); await coordinator.finish();
    const snapshot = runtime.engine.manager.get('session-0').snapshot();
    await stale.stop();
    require('../src/engineOwner').atomicJson(path.join(stale.selection.root, 'state/current-snapshots.json'), { version: 1,
      sessions: [{ ...snapshot, queue: [{ id: 'already-gone', text: 'must never reappear', attachments: [] }] }] });
    await coordinator.restore();
    await stale.close(stale.slots[0]); await stale.open(stale.slots[0]);
    checkEqual('offline handback uses current outbox rather than a stale snapshot queue', stale.slots[0].engine.manager.get('session-0').queue, []);
  } finally { await stale.cleanup(); }

  suite('R11 real context inventory, exact restoration and retired credentials');
  const f = await productionFixture(3);
  try {
    const coordinator = f.coordinator(), review = await coordinator.review();
    const oldSource = f.coordinator({ sources: async () => (await require('../src/legacySource').inventory(f.directory)).map((s) => ({ ...s, build: 'p3-source-v2' })) });
    check('a previously loaded bridge without the recovery contract is refused before joining', (await oldSource.review()).blockers.includes('SOURCE_BUILD_OLD') && !fs.existsSync(f.selection.root));
    await coordinator.move(review);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.selection.root, 'generation-import.json')));
    check('async SecretStorage keys export and unknown keys are explicitly preserved in place',
      manifest.records[0].transfer.sources.every((s) => s.state.inventory.secrets.some((e) => e.key === 'future.secret' && e.disposition === 'preserved-in-place') &&
        s.state.inventory.global.some((e) => e.key === 'future.global' && e.disposition === 'preserved-in-place')));
    const runtime = await f.start(); await coordinator.finish();
    const device = await require('./helpers/device').makeDevice('R11 Mac');
    const binding = { engineId: runtime.status().engine.id, generation: runtime.status().generation, publicKey: device.publicKey };
    binding.signature = await device.sign(require('../src/localDeviceEnrollment').proofText(binding));
    const local = await require('../src/daemonControl').controlRequest(runtime.paths, { op: 'enroll', kind: 'local', protocol: 2, device: binding });
    check('the real local Mac enrollment precedes the handback regression', local.ok && local.seat.local);
    runtime.engine.manager.create({ id: 'created-in-app', cwd: f.slots[0].project, autoStart: false });
    await runtime.currentState.flush();
    const selected = runtime.importer.snapshot().records.find((r) => r.id === runtime.importer.snapshot().current);
    const secrets = createKeychainStore({ adapter: f.adapter, account: selected.account });
    secrets.update('nikui.slack.userToken', undefined); secrets.dispose();
    await coordinator.restore();
    checkEqual('deleted app credential is deleted from VS Code rather than resurrected', await f.secrets.get('nikui.slack.userToken'), undefined);
    checkEqual('all production generation and evidence Keychain items are retired after handback', f.adapter.values.size, 0);
    check('handback retains the enrolled local-device record', f.global.get('nikui.devices').some((d) => d.id === local.device && d.local));
    check('unknown source keys and secret stay at their exact original scopes', f.global.get('future.global').retained === true &&
      await f.secrets.get('future.secret') === 'stay-in-vscode' && f.slots.every((s) => s.original.workspaceState.get('future.workspace').i === s.i));
    check('unchanged settings are never rewritten or moved between workspace and folder scopes', f.slots.every((s) => s.writes.length === 0 &&
      s.workspace.model === 'workspace-model-' + s.i && s.folder.fontSize === 13 + s.i));
    check('handback restores app-created conversations through the current state', f.slots.some((s) => s.original.workspaceState.get('nikui.sessions.v1').some((v) => v.id === 'created-in-app')));
    check('handback removes mode and delivered recovery files', !fs.existsSync(path.join(f.directory, f.profile + '.mode')) &&
      !fs.readdirSync(f.directory).some((name) => name.endsWith('.restore')));
    for (const slot of f.slots) {
      slot.source.admit(() => true);
      await slot.source.context.workspaceState.update('normal-save', slot.i);
    }
    check('three restored windows send and save without the cutover effect lock', f.slots.every((s) => s.original.workspaceState.get('normal-save') === s.i));
    await f.stop();
    // A second Move must use source changes made after the first handback.
    for (const slot of f.slots) { await f.close(slot); await f.open(slot); }
    f.slots[0].engine.manager.create({ id: 'created-after-return', cwd: f.slots[0].project, autoStart: false });
    await coordinator.move(await coordinator.review());
    const second = await f.start();
    check('a later Move imports current legacy state instead of reopening the previous service authority', !!second.engine.manager.get('created-after-return'));
    await coordinator.restore();
  } finally { await f.cleanup(); }

  suite('R11 every durable Move and handback stage: close, reload, quit and reboot');
  const moveStages = ['reviewed', 'source.join', 'joined', 'barrier', 'source.freeze', 'imported', 'committed', 'launchable', 'source.client', 'ready'];
  const returnStages = ['returning', 'return:imported', 'return:published', 'source.return.prepare', 'return:committed', 'source.return.apply', 'return:applied', 'return:released', 'returned', 'return:cleaned', 'source.return.resume'];
  const losses = ['app-crash', 'window-close', 'window-reload', 'vscode-quit', 'app-quit', 'reboot'];
  for (const windows of [1, 3]) for (const direction of ['move', 'return']) for (const stage of direction === 'move' ? moveStages : returnStages) for (const loss of losses) {
    if (process.env.NIKUI_RECOVERY_CASE && ![windows, direction, stage, loss].join(' ').includes(process.env.NIKUI_RECOVERY_CASE)) continue;
    if (process.env.NIKUI_TEST_PROGRESS === '1' && loss === 'app-crash') console.error('Recovery matrix: ' + [windows, direction, stage].join(' '));
    const f = await productionFixture(windows);
    let hit = false;
    try {
      let armed = false;
      const coordinator = f.coordinator({ fault(value) { if (armed && !hit && (value === stage || value.startsWith(stage + ':'))) { hit = true; throw crash(); } } });
      const review = await coordinator.review();
      if (direction === 'return' || stage === 'source.client' || stage === 'ready') {
        await coordinator.move(review); await f.start();
        f.runtime.engine.manager.create({ id: 'after-move', cwd: f.slots[0].project, autoStart: false });
        await f.runtime.currentState.flush();
        if (direction === 'return') await coordinator.finish();
      }
      armed = true;
      await code(() => direction === 'return' ? coordinator.handback() : ['source.client', 'ready'].includes(stage) ? coordinator.finish() : coordinator.move(review));
      if (['window-close', 'window-reload'].includes(loss)) {
        await f.close(f.slots[0]);
        if (loss === 'window-reload') await f.open(f.slots[0]);
      } else if (['vscode-quit', 'reboot'].includes(loss)) for (const slot of f.slots) await f.close(slot);
      if (loss === 'reboot') await f.stop();
      const restarted = f.coordinator();
      try { await restarted.restore(); } catch (e) {
        if (e.code !== 'SOURCE_RETURN_TARGET_REQUIRED') throw e;
        await f.open(f.slots[0]); await restarted.restore();
      }
      await f.stop();
      for (const slot of f.slots) { await f.close(slot); await f.open(slot); }
      const state = restarted.saved(), owner = createOwner({ root: state.ownerRoot, profile: f.profile, install: '/fixture/compatible-extension' });
      const usable = owner.status().mode === 'window' && owner.status().admission === 'open' &&
        !fs.existsSync(path.join(f.directory, f.profile + '.mode')) &&
        f.slots.every((s) => !s.source.service && !s.source.recovering && !s.source.needsAdmission && !!s.engine);
      check(windows + 'w ' + direction + ' ' + stage + ' / ' + loss + ' restores usable legacy', hit && usable);
      if (direction === 'return' || stage === 'source.client' || stage === 'ready') {
        check(windows + 'w ' + stage + ' / ' + loss + ' preserves current app work and retires secrets',
          f.slots.some((s) => s.engine.manager.get('after-move')) && f.adapter.values.size === 0);
      }
      for (const slot of f.slots) {
        slot.source.admit(() => true);
        await slot.source.context.workspaceState.update('post-recovery', true);
      }
      await restarted.restore();
    } catch (e) {
      e.message = windows + 'w ' + direction + ' ' + stage + ' / ' + loss + ': ' + e.message;
      throw e;
    } finally { await f.cleanup(); }
  }
};

