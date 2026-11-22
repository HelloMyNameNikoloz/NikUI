'use strict';
const fs = require('fs'), path = require('path');
const { startDaemon } = require('../../../src/daemonRuntime');
const { controlRequest } = require('../../../src/daemonControl');
const { createLocalDeviceEnrollment, proofText, LEDGER, REVOKED, keyHash } = require('../../../src/localDeviceEnrollment');
const { makeDevice } = require('../../helpers/device');
const { browser, until } = require('../../helpers/browser-client');
const ws = require('../../helpers/ws');
const { CORE } = require('../../../src/protocolV2');
module.exports = async () => {
  suite('P3 local P-256 enrollment over private control socket');
  const root = path.join(fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT), 'local-device'); fs.mkdirSync(root, { mode: 0o700 });
  const adapters = { tools: { knownDirs: [], lookup: async () => ({ tools: {} }) } };
  let daemon = await startDaemon({ root, adapters }), page;
  const device = await makeDevice('Mac fixture');
  const request = async (changes = {}) => {
    const d = { engineId: daemon.status().engine.id, generation: daemon.generation, publicKey: device.publicKey, ...changes };
    d.signature = await device.sign(proofText(d));
    return { op: 'enroll', kind: 'local', protocol: 2, device: d };
  };
  const enroll = async (changes) => controlRequest(daemon.paths, await request(changes));
  try {
    const management = await controlRequest(daemon.paths, { op: 'enroll', kind: 'local', protocol: 2 });
    checkEqual('original management schema is preserved', [management.kind, management.protocol, management.editorMethods], ['local', 2, []]);
    const first = await enroll(); device.id = first.device;
    checkEqual('owner enrolls a distinct full-control local device seat', first.seat, { id: first.device, local: true, control: true, editor: false });
    check('management key never authenticates the device seat', first.device !== management.id && !('key' in first));
    checkEqual('device pins and loopback endpoint are selected by the engine', [first.serverKey, first.fingerprint, first.baseURL],
      [daemon.engine.delivery.identity.publicKeySpki, daemon.engine.delivery.identity.fingerprint, 'http://127.0.0.1:' + daemon.engine.remote.port]);
    checkEqual('a reconnect retains the enrolled device identity', (await enroll()).device, first.device);
    checkEqual('ledger persists one enrollment, rather than one per reconnect', daemon.graph.authority.snapshot().values[LEDGER].length, 1);
    checkEqual('wrong generation refuses', (await enroll({ generation: 'old' })).code, 'STALE_GENERATION');
    checkEqual('wrong engine refuses', (await enroll({ engineId: '0'.repeat(32) })).code, 'ENGINE_IDENTITY_MISMATCH');
    const forged = await request(); forged.device.signature = 'a'.repeat(86);
    checkEqual('forged possession proof refuses', (await controlRequest(daemon.paths, forged)).code, 'LOCAL_DEVICE_PROOF_INVALID');
    const extra = await request(); extra.device.browserKey = management.key;
    checkEqual('unknown device credential fields refuse', (await controlRequest(daemon.paths, extra)).code, 'ENGINE_IDENTITY_MISMATCH');
    const s = daemon.engine.manager.create({ cwd: daemon.paths.home, autoStart: false });
    const origin = first.baseURL;
    const legacy = browser({ device, config: { origin, socket: origin.replace('http:', 'ws:') + '/socket', hostFingerprint: first.fingerprint },
      transportSource: fs.readFileSync(path.join(__dirname, '../transport-main-v1.js'), 'utf8') });
    try {
      legacy.socket(); // main's seat() sends no ready unless the page asked.
      try { await until(() => legacy.messages.some((m) => m.type === 'fleet'), 'main receive-only client immediately receives fleet'); }
      catch (e) { e.message += JSON.stringify({ frames: legacy.frames, messages: legacy.messages, sockets: legacy.sockets.map((s) => ({ state: s.readyState, received: s.received })) }); throw e; }
      checkEqual('shipped main client sends neither hello nor unsolicited ready', legacy.frames.filter((m) => ['hello', 'ready'].includes(m.type)), []);
      checkEqual('legacy receives the immediate application seat', legacy.messages.filter((m) => ['@welcome', 'fleet'].includes(m.type)).map((m) => m.type).slice(0, 2), ['@welcome', 'fleet']);
    } finally { legacy.close(); }
    page = browser({ device, fakeTimers: false, config: { session: s.id, origin,
      socket: origin.replace('http:', 'ws:') + '/socket?session=' + encodeURIComponent(s.id), hostFingerprint: first.fingerprint } });
    const transport = page.socket(); transport.postMessage({ type: 'ready' });
    await until(() => page.messages.some((m) => m.type === 'init'), 'locally enrolled sealed protocol init');
    await until(() => page.messages.some((m) => m.type === 'protocol' && m.ready), 'local device seat');
    const welcome = page.messages.find((m) => m.type === 'protocol' && m.ready);
    checkEqual('local device reuses real P-256 sealed channel and v2 negotiation', [transport.sealed(), transport.application.proto, welcome.seat.local, welcome.seat.control], [true, 2, true, true]);
    checkEqual('enrollment never opens tailnet pairing', daemon.engine.delivery.pairing?.active || false, false);
    // A phone's control grant and even a claimed Mac client kind cannot confer
    // owner-only local actions on the network protocol.
    const phone = await makeDevice('Control-capable phone');
    phone.id = daemon.engine.delivery.devices.add({ name: phone.name, publicKey: phone.publicKey }).id;
    daemon.engine.delivery.devices.setControl(phone.id, true);
    const phoneSocket = await ws.connect(origin.replace('http:', 'ws:') + '/socket?applicationProtocol=2');
    try {
      phoneSocket.send(await phone.answer(await phoneSocket.waitFor('@challenge'), phone.id)); phoneSocket.seal(phone.box);
      await phoneSocket.waitFor('@welcome');
      checkEqual('notification broadcast cannot precede negotiating application welcome', daemon.engine.remote.notifyDevices({ to: phone.id, kind: 'needs-you', title: 'negotiation test' }), 0);
      checkEqual('no application broadcast arrives before negotiation', phoneSocket.messages.map((m) => m.type), ['@challenge', '@welcome']);
      phoneSocket.send({ type: 'hello', proto: { min: 1, max: 2 }, caps: CORE,
        client: { id: 'a'.repeat(32), kind: 'mac', version: 'fixture', local: true } });
      const welcome = await phoneSocket.waitFor('welcome'), seat = welcome.seat;
      checkEqual('control-capable phone never receives a local seat', [seat.id, seat.control, seat.local, seat.editor], [phone.id, true, false, false]);
      phoneSocket.send({ type: 'slack:settings', mid: 'b'.repeat(32), scope: welcome.receipts.scope, issuedAt: welcome.receipts.now });
      checkEqual('daemon refuses local-only mutation from a controlling phone', (await phoneSocket.waitFor('ack')).error.code, 'LOCAL_REQUIRED');
      const conflict = { engineId: daemon.status().engine.id, generation: daemon.generation, publicKey: phone.publicKey };
      conflict.signature = await phone.sign(proofText(conflict));
      checkEqual('private enrollment cannot silently promote a paired phone key', (await controlRequest(daemon.paths, { op: 'enroll', kind: 'local', protocol: 2, device: conflict })).code, 'LOCAL_DEVICE_IDENTITY_CONFLICT');
    } finally { phoneSocket.destroy(); }

    const candidate = await makeDevice('Failed local enrollment'), binding = { engineId: daemon.status().engine.id, generation: daemon.generation, publicKey: candidate.publicKey };
    binding.signature = await candidate.sign(proofText(binding));
    const candidateRequest = { op: 'enroll', kind: 'local', protocol: 2, device: binding };
    let failLedger = true;
    const service = () => createLocalDeviceEnrollment({ authority: { snapshot: () => daemon.graph.authority.snapshot(), commit: (fn) => {
      if (failLedger) throw Object.assign(new Error('fixture fsync failure'), { code: 'STORAGE_UNAVAILABLE' });
      return daemon.graph.authority.commit(fn);
    } }, devices: daemon.engine.delivery.devices, identity: daemon.engine.delivery.identity,
    engine: daemon.status().engine, generation: daemon.generation, port: () => daemon.engine.remote.port, running: () => true });
    checkEqual('ledger failure refuses enrollment', (await service().enroll(candidateRequest)).code, 'STORAGE_UNAVAILABLE');
    const reservation = daemon.engine.delivery.devices.list().find((d) => d.publicKey === candidate.publicKey);
    checkEqual('failed ledger never leaves a full-control or local seat', [reservation.control, reservation.local === true], [false, false]);
    failLedger = false;
    const recovered = await service().enroll(candidateRequest);
    checkEqual('retry after failed ledger or restart recovers the same reserved key/id', [recovered.ok, recovered.device], [true, reservation.id]);
    checkEqual('recovered reservation has exactly one durable ledger binding', daemon.graph.authority.snapshot().values[LEDGER].filter((r) => r.publicKey === candidate.publicKey).length, 1);
    daemon.engine.delivery.devices.setControl(recovered.device, false);
    checkEqual('a recovered seat cannot regain a revoked grant', (await service().enroll(candidateRequest)).code, 'LOCAL_DEVICE_REVOKED');
    const interrupted = await makeDevice('Ledger committed before grant'), nextBinding = { engineId: daemon.status().engine.id, generation: daemon.generation, publicKey: interrupted.publicKey };
    nextBinding.signature = await interrupted.sign(proofText(nextBinding));
    const interruptedRequest = { op: 'enroll', kind: 'local', protocol: 2, device: nextBinding };
    const devices = daemon.engine.delivery.devices, save = devices.save.bind(devices);
    devices.save = (all) => {
      if (all.some((d) => d.publicKey === interrupted.publicKey && d.local === true)) throw Object.assign(new Error('fixture device write failure'), { code: 'STORAGE_UNAVAILABLE' });
      return save(all);
    };
    try { checkEqual('failure after ledger fsync refuses before publishing a seat', (await service().enroll(interruptedRequest)).code, 'STORAGE_UNAVAILABLE'); }
    finally { devices.save = save; }
    const committed = daemon.graph.authority.snapshot().values[LEDGER].find((r) => r.publicKey === interrupted.publicKey);
    checkEqual('interrupted final grant remains read-only with a durable key binding', [!!committed, devices.get(committed.id).control], [true, false]);
    checkEqual('retry after a ledger-first crash retains its original device identity', (await service().enroll(interruptedRequest)).device, committed.id);
    const cancelled = await makeDevice('Revoked during ledger write'), cancelledBinding = { engineId: daemon.status().engine.id, generation: daemon.generation, publicKey: cancelled.publicKey };
    cancelledBinding.signature = await cancelled.sign(proofText(cancelledBinding));
    const cancelledRequest = { op: 'enroll', kind: 'local', protocol: 2, device: cancelledBinding };
    const racing = createLocalDeviceEnrollment({ authority: { snapshot: () => daemon.graph.authority.snapshot(), commit: async (fn) => {
      const saved = await daemon.graph.authority.commit(fn);
      devices.setControl(devices.list().find((d) => d.publicKey === cancelled.publicKey).id, false); return saved;
    } }, devices, identity: daemon.engine.delivery.identity, engine: daemon.status().engine,
    generation: daemon.generation, port: () => daemon.engine.remote.port, running: () => true });
    checkEqual('revocation during ledger fsync prevents the final grant', (await racing.enroll(cancelledRequest)).code, 'LOCAL_DEVICE_REVOKED');
    checkEqual('retry cannot promote a concurrently revoked reservation', (await service().enroll(cancelledRequest)).code, 'LOCAL_DEVICE_REVOKED');
    daemon.engine.delivery.devices.setControl(first.device, false);
    await until(() => page.sockets.every((s) => s.readyState === 3), 'revoked local socket closes');
    check('revocation closes the already authenticated local socket', page.sockets.every((s) => s.readyState === 3));
    daemon.engine.delivery.devices.setControl(first.device, true);
    page.close(); page = null;
    await daemon.stop(); daemon = await startDaemon({ root, adapters });
    checkEqual('device identity and selected pins survive a generation change', [(await enroll()).device, daemon.engine.delivery.identity.fingerprint], [first.device, first.fingerprint]);
    daemon.engine.delivery.devices.setControl(first.device, false);
    checkEqual('revoked control cannot be promoted again by enrollment', (await enroll()).code, 'LOCAL_DEVICE_REVOKED');
    daemon.engine.delivery.devices.forget(first.device);
    checkEqual('forgotten identity cannot silently create a replacement seat', (await enroll()).code, 'LOCAL_DEVICE_REVOKED');
    checkEqual('revocation and forget preserve the enrollment tombstone', daemon.graph.authority.snapshot().values[LEDGER].filter((r) => r.id === first.device).length, 1);
    for (let index = 0; index < 40; index++) {
      const fresh = await makeDevice('reset ' + index);
      const binding = { engineId: daemon.status().engine.id, generation: daemon.generation, publicKey: fresh.publicKey };
      binding.signature = await fresh.sign(proofText(binding));
      const result = await controlRequest(daemon.paths, { op: 'enroll', kind: 'local', protocol: 2, device: binding });
      checkEqual('reset beyond ledger cap succeeds ' + index, result.ok, true);
      daemon.engine.delivery.devices.forget(result.device);
    }
    check('revoked records are compacted without consuming the active seat limit', daemon.graph.authority.snapshot().values[LEDGER].length < 32);
    check('compaction retains revoked key hash', daemon.graph.authority.snapshot().values[REVOKED].includes(keyHash(device.publicKey)));
    checkEqual('compacted revoked key cannot enroll again', (await enroll()).code, 'LOCAL_DEVICE_REVOKED');
  } finally { page?.close(); await daemon.stop(); }
};
