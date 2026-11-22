'use strict';
const fs = require('fs'), path = require('path');
const { startDaemon } = require('../../../src/daemonRuntime');
const { createAcceptanceFixture } = require('../../../src/acceptanceFixture');
const { controlRequest } = require('../../../src/daemonControl');
const { proofText } = require('../../../src/localDeviceEnrollment');
const { makeDevice } = require('../../helpers/device');
const { browser, until } = require('../../helpers/browser-client');
module.exports = async () => {
  suite('P3 portable fixture contract for the pending native core gate');
  const root = path.join(fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT), 'mac-core'); fs.mkdirSync(root, { mode: 0o700 });
  const fixture = createAcceptanceFixture({ root, testOnly: true });
  const daemon = await startDaemon({ root, adapters: { ...fixture.adapters,
    tools: { knownDirs: [], lookup: async () => ({ tools: {} }) } } }); fixture.attach(daemon);
  let page;
  const call = (action) => controlRequest(daemon.paths, { op: 'acceptance-p2', action });
  try {
    await call('seed');
    const device = await makeDevice('P3 native protocol fixture');
    const d = { engineId: daemon.status().engine.id, generation: daemon.generation, publicKey: device.publicKey };
    d.signature = await device.sign(proofText(d));
    const enrollment = await controlRequest(daemon.paths, { op: 'enroll', kind: 'local', protocol: 2, device: d }); device.id = enrollment.device;
    page = browser({ device, config: { session: 'p2-claude', origin: enrollment.baseURL,
      socket: enrollment.baseURL.replace('http:', 'ws:') + '/socket?session=p2-claude', hostFingerprint: enrollment.fingerprint } });
    const transport = page.socket(); transport.postMessage({ type: 'ready' });
    await until(() => page.messages.some((m) => m.type === 'init'), 'local init');
    const send = await transport.postMessage({ type: 'send', text: 'P3 portable native fixture contract' }, { draftVersion: 1, draft: 'P3 portable native fixture contract' });
    await until(() => transport.application.records().some((r) => r.mid === send.mid && r.state === 'accepted'), 'local send ack');
    await until(() => daemon.graph.currentState.snapshot().outbox.some((q) => q.mid === send.mid && q.state === 'accepted'), 'provider accepted send');
    checkEqual('one immutable local-device prompt reaches the fixture', (await call('state')).effects.claude, 1);
    checkEqual('stream-start requires an admitted active turn', (await call('mac-core-stream-start')).ok, true);
    await until(() => page.messages.some((m) => m.type === 'items' && m.items.some((i) => i.id === 'p3-native-reply:0' && i.streaming && i.text)), 'streaming reply');
    check('streamed cumulative text travels over the real sealed conversation socket', page.messages.some((m) => m.type === 'items' && m.items.some((i) => i.id === 'p3-native-reply:0' && i.text.includes('Streamed reply'))));
    await call('mac-core-stream-end'); await call('pending');
    await until(() => page.messages.some((m) => m.type === 'items' && m.items.some((i) => i.requestId === 'p2-approval')), 'permission');
    const permission = page.messages.filter((m) => m.type === 'items').flatMap((m) => m.items).find((i) => i.requestId === 'p2-approval');
    const approval = await transport.postMessage({ type: 'permission', requestId: permission.requestId, run: permission.run, allow: true });
    await until(() => transport.application.records().some((r) => r.mid === approval.mid && r.state === 'completed'), 'permission ack');
    checkEqual('approval reaches exactly the fixture issuing run', (await call('state')).effects.approvals, 1);
    const queued = await transport.postMessage({ type: 'send', text: 'durable queue' }, { draftVersion: 2, draft: 'durable queue' });
    await until(() => transport.application.records().some((r) => r.mid === queued.mid && r.state === 'accepted'), 'queue accepted');
    await until(() => page.messages.some((m) => m.type === 'queue' && m.queue.some((q) => q.mid === queued.mid && q.state === 'queued')), 'full local queue');
    const row = page.messages.filter((m) => m.type === 'queue').flatMap((m) => m.queue).find((q) => q.mid === queued.mid && q.state === 'queued');
    checkEqual('local queue advertises only supported operations and keeps full payload', [row.text, row.attachments, row.actions], ['durable queue', [], ['unqueue', 'promoteQueued']]);
    checkEqual('queued work remains undelivered while the turn is busy', (await call('state')).effects.claude, 1);
    const removing = await transport.postMessage({ type: 'unqueue', id: row.id });
    await until(() => transport.application.records().some((r) => r.mid === removing.mid && r.state === 'completed'), 'unqueue ack');
    const stopping = await transport.postMessage({ type: 'interrupt', run: permission.run });
    await until(() => transport.application.records().some((r) => r.mid === stopping.mid && r.state === 'completed'), 'interrupt ack');
    await until(() => daemon.engine.manager.get('p2-claude').items.some((i) => i.kind === 'result' && i.interrupted), 'provider interrupt result');
    checkEqual('captured Stop reaches the fixture exactly once', (await call('state')).effects.interrupts, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    check('Stop leaves the captured turn ended, with its interrupted result, after the drain interval',
      !daemon.engine.manager.get('p2-claude').inTurn && daemon.engine.manager.get('p2-claude').items.some((i) => i.kind === 'result' && i.interrupted));
    checkEqual('unqueue prevents the next prompt from racing the Stop observation', (await call('state')).effects.claude, 1);
    checkEqual('Stop does not stop the engine service', daemon.status().state, 'running');
    check('removed queue retains its original mid and terminal disposition after Stop', daemon.graph.currentState.snapshot().outbox.some((q) => q.mid === queued.mid && q.state === 'discarded'));
    const active = await transport.postMessage({ type: 'send', text: 'Second active turn' });
    await until(() => daemon.graph.currentState.snapshot().outbox.some((q) => q.mid === active.mid && q.state === 'accepted'), 'second active turn');
    const surviving = await transport.postMessage({ type: 'send', text: 'Queued prompt survives Stop' });
    await until(() => daemon.graph.currentState.snapshot().outbox.some((q) => q.mid === surviving.mid && q.state === 'queued'), 'surviving queue admitted');
    checkEqual('the second queued prompt is still pending before Stop', (await call('state')).effects.claude, 2);
    const stopWithQueue = await transport.postMessage({ type: 'interrupt', run: daemon.engine.manager.get('p2-claude')._engineControls.run() });
    await until(() => transport.application.records().some((r) => r.mid === stopWithQueue.mid && r.state === 'completed'), 'queued Stop ack');
    await until(() => daemon.graph.currentState.snapshot().outbox.some((q) => q.mid === surviving.mid && q.state === 'accepted'), 'queued prompt runs after Stop');
    await until(() => page.messages.some((message) => message.type === 'queue' && message.queue.some((q) => q.mid === surviving.mid && q.state === 'accepted')), 'accepted surviving queue row');
    check('a running accepted prompt remains visible without queue actions until completion', page.messages.some((message) =>
      message.type === 'queue' && message.queue.some((q) => q.mid === surviving.mid && q.state === 'accepted' && q.actions.length === 0)));
    checkEqual('the queued prompt survives Stop and runs exactly once afterwards', [(await call('state')).effects.claude, (await call('state')).effects.interrupts], [3, 2]);
    check('the surviving prompt starts a new turn with its original full text', daemon.engine.manager.get('p2-claude').inTurn &&
      daemon.engine.manager.get('p2-claude').items.some((item) => item.text === 'Queued prompt survives Stop'));
    await call('finish');
  } finally { page?.close(); await daemon.stop(); }
};
