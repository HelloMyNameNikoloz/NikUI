'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { startDaemon } = require('../../../src/daemonRuntime');
const { openDevelopmentClient, CORE } = require('../../../src/developmentBridge');
const { controlRequest } = require('../../../src/daemonControl');
const { Secrets, provider, tick } = require('./fakes');
const { makeDevice } = require('../../helpers/device');
const { browser, until } = require('../../helpers/browser-client');
const ws = require('../../helpers/ws');
const { rpcFixture, ipcFixture, DROP } = require('../../helpers/engine-provider');

module.exports = async function () {
  const root = path.join(fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT), 'e2e');
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ version: 1, user: { codexAccount: 'personal' }, projects: [] }), { mode: 0o600 });
  const claude = provider(), codex = rpcFixture({ 'model/list': { data: [] }, 'thread/list': { data: [] }, 'turn/start': () => DROP });
  const ipcDir = path.join(root, 'ipc'); fs.mkdirSync(ipcDir, { mode: 0o700 });
  const ipc = await ipcFixture(ipcDir, () => DROP); fs.chmodSync(ipc.ipc.sockPath, 0o600);
  const adapters = { claudeSpawn: (...args) => { const proc = claude.spawnFn(...args); proc.exitCode = null; proc.killed = false; return proc; }, codexSpawn: codex.spawn, codexIpc: ipc.ipc,
    tools: { knownDirs: [], lookup: async () => ({ path: '/fixture', tools: {} }) }, editorTimeoutMs: 40 };
  let daemon = await startDaemon({ root, adapters });
  const browsers = [], connections = [], apps = [];
  const calls = [], localSecrets = [new Secrets(), new Secrets()];
  let omitEditorReply = false;
  function hello(link) { link.send({ type: 'hello', proto: { min: 2, max: 2 }, caps: daemon.engine.remote.applicationProtocol.caps,
    client: { id: require('crypto').randomBytes(16).toString('hex'), kind: 'extension', version: 'fixture' } }); }
  async function editor(index, workspaces, focused) {
    const messages = [], held = [];
    let link;
    const receive = (m) => {
      messages.push(m);
      if (!link) { held.push(m); return; }
      if (m.type === '@welcome') hello(link);
      if (m.type === 'welcome') link.send({ type: 'editor:register', methods: ['openFile', 'openUrl', 'runInTerminal', 'switchTo'], workspaces, focused });
      if (m.type === 'editor:request') { calls.push({ index, ...m }); if (!omitEditorReply) link.send({ type: 'editor:result', id: m.id, result: true }); }
    };
    link = await openDevelopmentClient({ root, secrets: localSecrets[index], provider: true, onMessage: receive });
    connections.push(link); for (const m of held.splice(0)) receive(m);
    await until(() => messages.some((m) => m.type === 'editor:registered'), 'registered editor');
    return { link, messages };
  }
  function diskStorage(name) {
    const file = path.join(root, name + '.json');
    return { read: () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
      write: (text) => fs.writeFileSync(file, text, { mode: 0o600 }) };
  }
  async function localView(index, session, storage = diskStorage('view-' + index)) {
    const b = browser({ fakeTimers: true }); browsers.push(b);
    const frames = [], emitted = [], queued = [];
    let link;
    const app = b.negotiatedClient({ config: { session, hostFingerprint: daemon.engine.delivery.identity.fingerprint, clientKind: 'extension' },
      send: (m) => link ? link.send(m) : queued.push(m), emit: (m) => emitted.push(m), storage });
    apps.push(app); app.post({ type: 'ready' });
    link = await openDevelopmentClient({ root, secrets: localSecrets[index], target: session,
      onMessage: (m) => { frames.push(m); if (!app.receive(m)) emitted.push(m); } });
    connections.push(link); for (const m of queued.splice(0)) link.send(m);
    await until(() => emitted.some((m) => m.type === 'init'), 'development conversation init');
    return { app, link, frames, emitted, storage };
  }
  try {
    suite('P1-24 T01/T03/T09/T39/T43/T46: real daemon/disk/shared JS/editor bridge');
    checkEqual('complete composition advertises durable network authority', [daemon.status().protocol, daemon.status().authority.networkReceipts], [2, true]);
    const firstEditor = await editor(0, [pathToFileURL(daemon.paths.home).href], true);
    const nested = path.join(daemon.paths.home, 'nested'); fs.mkdirSync(nested, { mode: 0o700 });
    await editor(1, [pathToFileURL(nested).href], false);
    checkEqual('only connected announced private projects enter service set', daemon.graph.bridge.projects().sort(), [daemon.paths.home, nested].sort());
    checkEqual('extension enrollment keys are held in each SecretStorage', localSecrets.map((s) => s.values.size), [1, 1]);
    const peersBeforeFailure = daemon.graph.bridge.status().connected;
    let secretFailure;
    try { await openDevelopmentClient({ root, secrets: { get: async () => undefined, store: async () => { throw new Error('locked fixture'); } } }); }
    catch (_) { secretFailure = true; }
    checkEqual('failed extension SecretStorage persistence cannot open a memory-only client', [secretFailure, daemon.graph.bridge.status().connected], [true, peersBeforeFailure]);
    const refusedFrames = [];
    let legacyDev;
    const reply = (m) => { refusedFrames.push(m); if (m.type === '@welcome') legacyDev.send({ type: 'ready' }); };
    legacyDev = await openDevelopmentClient({ root, secrets: localSecrets[0], onMessage: reply }); connections.push(legacyDev);
    await until(() => refusedFrames.some((m) => m.type === 'protocol:error'), 'unenveloped development request refusal');
    checkEqual('enrolled development client cannot bypass receipts through legacy mode', refusedFrames.find((m) => m.type === 'protocol:error').code, 'NO_COMMON_PROTOCOL');
    const session = daemon.engine.manager.create({ cwd: nested, autoStart: false });
    await daemon.graph.currentState.flush();
    const view = await localView(0, session.id);
    checkEqual('one daemon manager/process serves the dev window', claude.spawned.length, 1);
    session._handleSystem({ type: 'system', subtype: 'init', session_id: 'synthetic-e2e-conversation' });
    session._handleResult({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    const file = view.app.post({ type: 'openFile', path: 'original.txt', line: 7 });
    await until(() => view.app.records().some((r) => r.mid === file.mid && r.state === 'completed'), 'editor action receipt');
    checkEqual('enrolled operation origin wins over more-specific other workspace', [calls.at(-1).index, calls.at(-1).request.path, calls.at(-1).request.line], [0, path.join(nested, 'original.txt'), 7]);
    const exact = view.app.records().find((r) => r.mid === file.mid).payload;
    view.link.send(exact); await tick(); await tick();
    checkEqual('duplicate editor receipt does not dispatch another UI operation', calls.length, 1);
    const unsupported = view.app.post({ type: 'allSettings' });
    await until(() => view.app.records().find((r) => r.mid === unsupported.mid)?.state === 'rejected', 'unsupported editor receipt');
    checkEqual('unsupported local management is explicit without fallback', view.app.records().find((r) => r.mid === unsupported.mid).ack.error.code, 'EDITOR_UNAVAILABLE');
    omitEditorReply = true;
    const ambiguous = view.app.post({ type: 'runInTerminal', command: 'insert only' });
    await until(() => view.app.records().find((r) => r.mid === ambiguous.mid)?.state === 'unknown', 'lost editor reply');
    view.link.send(view.app.records().find((r) => r.mid === ambiguous.mid).payload);
    await tick();
    checkEqual('lost editor reply retains unknown and never retargets/retries', calls.filter((c) => c.method === 'runInTerminal').length, 1);
    omitEditorReply = false;
    firstEditor.link.close();
    await until(() => daemon.graph.bridge.status().editors === 1, 'editor disconnect');
    const disconnected = view.app.post({ type: 'openFile', path: 'after-disconnect.txt' });
    await until(() => view.app.records().find((r) => r.mid === disconnected.mid)?.state === 'rejected', 'origin disconnect refusal');
    checkEqual('disconnected origin never uses the other focused/workspace editor', calls.length, 2);
    checkEqual('disconnect removes unsaved announcements', daemon.graph.bridge.projects(), [nested]);

    suite('P1-24 T11/T35/T38: actual shared JS P-256/AES reconnect and lost ack');
    const device = await makeDevice('Synthetic phone');
    device.id = daemon.engine.delivery.devices.add({ name: device.name, publicKey: device.publicKey }).id;
    daemon.engine.delivery.devices.setControl(device.id, true);
    let dropAck = true;
    let holdSend = false, holding = false, releaseSend;
    const heldFrames = [];
    const stored = { get: (key) => { const f = path.join(root, 'browser-' + require('crypto').createHash('sha256').update(key).digest('hex') + '.json');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; },
      set: (key, value) => fs.writeFileSync(path.join(root, 'browser-' + require('crypto').createHash('sha256').update(key).digest('hex') + '.json'), value, { mode: 0o600 }) };
    const phone = browser({ storage: stored, device, config: { session: session.id,
      origin: 'http://127.0.0.1:' + daemon.engine.remote.port, socket: 'ws://127.0.0.1:' + daemon.engine.remote.port + '/socket?session=' + encodeURIComponent(session.id),
      hostFingerprint: daemon.engine.delivery.identity.fingerprint } });
    browsers.push(phone);
    const clientBox = phone.window.nikSecure.clientBox;
    phone.window.nikSecure.clientBox = (...args) => clientBox(...args).then((box) => {
      const open = box.open.bind(box);
      const originalSeal = box.seal.bind(box);
      const seal = (text) => originalSeal(text).then((frame) => {
        return frame;
      });
      box.seal = (text) => {
        if (holdSend && JSON.parse(text).type === 'send') {
          holdSend = false; holding = true;
          return new Promise((resolve) => { releaseSend = () => resolve(seal(text).then((frame) => { heldFrames.push(JSON.stringify(frame)); return frame; })); });
        }
        return seal(text);
      };
      box.open = (frame) => Promise.resolve(open(frame)).then((text) => {
        const m = JSON.parse(text);
        if (dropAck && m.type === 'ack' && m.what === 'send') { dropAck = false; phone.sockets.at(-1).drop(); return JSON.stringify({ type: 'fixture:lost-reply' }); }
        return text;
      }); return box;
    });
    const transport = phone.socket(); transport.postMessage({ type: 'ready' });
    await until(() => phone.messages.some((m) => m.type === 'init'), 'sealed JS init').catch((error) => {
      error.message += JSON.stringify({ events: phone.messages.map((m) => [m.type, m.code]),
        sent: phone.frames.map((m) => m.type), link: transport.__state(), received: phone.sockets.map((s) => s.received.map((m) => m.type)),
        app: transport.application.records().map((r) => [r.payload.type, r.ack?.error?.code]) }); throw error;
    });
    checkEqual('shared JS negotiates after actual sealed authenticated welcome', [transport.application.proto, transport.sealed()], [2, true]);
    const payload = { type: 'send', text: 'exact expanded prompt ქართული 👋 ' + 'x'.repeat(9000), sent: 'original draft',
      snippets: ['first', 'second'], attachments: [{ name: 'synthetic.png', mediaType: 'image/png', data: 'aW1hZ2U=' }] };
    const send = transport.postMessage(payload, { draftVersion: 1, draft: 'original draft' });
    await until(() => !dropAck && phone.sockets[0].readyState === 3, 'ack dropped after commit');
    checkEqual('lost ack leaves the complete pending JS intent', transport.application.records().find((r) => r.mid === send.mid).payload.text, payload.text);
    await daemon.graph.currentState.drain('session:' + session.id);
    checkEqual('fixture provider accepted one foreground input through the durable drain',
      [session.isRunning, session.inTurn, session.isPaused, session.elsewhere || false, daemon.graph.currentState.status().issue], [true, true, false, false, null]);
    checkEqual('one fake provider input crossed before reconnect', claude.spawned[0].proc.calls.filter((m) => m.type === 'user').length, 1);
    transport.reconnect();
    await until(() => transport.application.records().find((r) => r.mid === send.mid)?.state === 'accepted', 'original receipt recovered');
    checkEqual('receipt lookup recovers same mid without a second provider send', [transport.application.records().find((r) => r.mid === send.mid).ack.status,
      claude.spawned[0].proc.calls.filter((m) => m.type === 'user').length], ['duplicate', 1]);
    const one = phone.sockets[0].sent.filter((m) => m.type === '@box'), two = phone.sockets[1].sent.filter((m) => m.type === '@box');
    check('reconnect uses independent ciphertext/counters, never replays a saved box', one.length > 0 && two.length > 0 && two.every((b) => !one.some((a) => JSON.stringify(a) === JSON.stringify(b))));
    const receipt = daemon.graph.authority.snapshot().entries.find((e) => e.mid === send.mid);
    const outbox = daemon.graph.authority.snapshot().outbox.find((e) => e.mid === send.mid);
    checkEqual('server disk holds the same complete immutable input as shared JS', outbox.payload.message, transport.application.records().find((r) => r.mid === send.mid).payload);
    checkEqual('durable acceptance is separate from provider completion', [receipt.outcome, receipt.result.code, outbox.state], ['applied', 'accepted', 'accepted']);
    const previousSocket = phone.sockets.at(-1);
    holdSend = true;
    const missing = transport.postMessage({ type: 'send', text: 'persisted before any frame', sent: 'second draft', attachments: payload.attachments });
    await until(() => holding && transport.application.records().some((r) => r.mid === missing.mid), 'durable client intent before old frame');
    const missingPlaintext = transport.application.records().find((r) => r.mid === missing.mid).plaintext;
    // The outgoing chain is now held. Earlier receipt/operation queries can
    // legitimately finish before this point, so sample at the disconnect.
    const previousFrames = previousSocket.sent.length;
    transport.reconnect(); // before the old channel's asynchronous seal/write
    releaseSend();
    await until(() => transport.application.records().find((r) => r.mid === missing.mid)?.state === 'accepted', 'same-mid retry after authoritative missing');
    checkEqual('disconnect before first write cannot leak a queued old-channel frame', previousSocket.sent.length, previousFrames);
    checkEqual('the held old-channel seal actually completed', heldFrames.length, 1);
    checkEqual('held old-channel ciphertext never reaches any socket', phone.frames.filter((f) => heldFrames.includes(JSON.stringify(f))), []);
    checkEqual('fresh-channel missing retry preserves exact plaintext, images, mid and issuedAt',
      JSON.stringify(daemon.graph.authority.snapshot().outbox.find((q) => q.mid === missing.mid).payload.message), missingPlaintext);
    checkEqual('queued retry waits behind the active provider turn', claude.spawned[0].proc.calls.filter((m) => m.type === 'user').length, 1);
    session._handleResult({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    await daemon.graph.currentState.drain('session:' + session.id);
    checkEqual('safe identical-mid retry reaches the provider once', claude.spawned[0].proc.calls.filter((m) => m.type === 'user').length, 2);
    const raw = JSON.stringify(await controlRequest(daemon.paths, { op: 'doctor', secret: 'synthetic-do-not-echo' }));
    check('diagnostics exclude plaintext, image, key and input payload', !raw.includes(payload.text) && !raw.includes('aW1hZ2U=') &&
      !raw.includes(firstEditor.link.enrollment.key) && !raw.includes('synthetic-do-not-echo'));

    // A committed operation remains discoverable on fleet after its instance
    // goes away; fleet queries keep the original target from the receipt.
    session._handleResult({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    await daemon.graph.currentState.flush();
    daemon.engine.manager.remove(session.id); await daemon.graph.currentState.flush();
    const local = await controlRequest(daemon.paths, { op: 'enroll', kind: 'local' });
    const fleet = await ws.connect('ws://127.0.0.1:' + daemon.engine.remote.port + '/socket');
    connections.push({ close: () => fleet.destroy() });
    const challenge = await fleet.waitFor('@challenge');
    fleet.send(await device.answer(challenge, device.id)); fleet.seal(device.box); await fleet.waitFor('@welcome'); hello(fleet); await fleet.waitFor('welcome');
    fleet.send({ type: 'receipt:get', scope: outbox.scope, mid: outbox.mid });
    checkEqual('deleted-target receipt remains queryable through authenticated fleet', (await fleet.waitFor('ack')).target, 'session:' + session.id);
    check('local key is distinct from SecretStorage editor enrollment', local.key !== firstEditor.link.enrollment.key);

    suite('P1-24 T28/T34: actual composed RPC/IPC lost replies through shared JS/dev bridge');
    const unknowns = [];
    for (const writer of ['engine', 'external']) {
      await daemon.engine.codex.client.start();
      const cx = daemon.engine.codex._adopt({ id: 'fixture-' + writer, cwd: nested, model: 'fixture-model' });
      cx.loaded = true; cx.writerAuthority = writer; cx.readOnly = writer === 'external';
      await daemon.graph.currentState.flush();
      const cxView = await localView(1, cx.id, diskStorage('codex-' + writer));
      const action = cxView.app.post({ type: 'send', text: 'frozen ' + writer + ' input', sent: 'expanded ' + writer,
        snippets: ['fixture'], attachments: [] });
      await until(() => cxView.app.records().find((r) => r.mid === action.mid)?.state === 'accepted', 'Codex outbox receipt');
      await daemon.graph.currentState.drain('session:' + cx.id);
      cxView.app.reconcile();
      await until(() => cxView.app.records().find((r) => r.mid === action.mid)?.operation?.state === 'unknown', 'Codex lost reply operation');
      const record = cxView.app.records().find((r) => r.mid === action.mid);
      const saved = daemon.graph.authority.snapshot().outbox.find((r) => r.mid === action.mid);
      unknowns.push(saved);
      const beforeCount = writer === 'engine' ? codex.calls.filter((c) => c.method === 'turn/start').length : ipc.calls.filter((c) => c.method === 'thread-follower-start-turn').length;
      cxView.link.send(record.payload); await daemon.graph.currentState.drain('session:' + cx.id);
      checkEqual(writer + ' writer lost reply keeps receipt accepted and operation unknown', [record.ack.outcome, record.operation.state, saved.payload.message], ['applied', 'unknown', record.payload]);
      checkEqual(writer + ' writer duplicate never replays RPC/IPC', writer === 'engine' ? codex.calls.filter((c) => c.method === 'turn/start').length
        : ipc.calls.filter((c) => c.method === 'thread-follower-start-turn').length, beforeCount);
      checkEqual(writer + ' writer identity and dispatch marker are durable', [saved.provider.writer, saved.dispatchPhase], [writer, writer === 'engine' ? 'direct-dispatching' : 'follower-dispatching']);
    }

    suite('P1-24 T58/T59/T62: no-viewer lifetime and diagnosable drain/restart');
    for (const b of browsers) b.close(); for (const c of connections) c.close(); for (const a of apps) a.disconnect();
    await tick();
    checkEqual('closing all viewers leaves daemon running', daemon.status().state, 'running');
    const before = daemon.graph.authority.snapshot();
    await daemon.stop();
    checkEqual('drain stages complete without secrets or hidden failures', [daemon.status().state, daemon.status().lifecycle.failed, daemon.status().authority.currentState.admitting], ['stopped', [], false]);
    checkEqual('all editor requests and connections drain', daemon.graph.bridge.status().pendingEditorRequests, 0);
    daemon = await startDaemon({ root, adapters });
    checkEqual('real disk reopen preserves engine/scope and original acceptance', [daemon.graph.authority.snapshot().engineId, daemon.graph.authority.snapshot().scope,
      daemon.graph.authority.snapshot().entries.find((e) => e.mid === send.mid).result], [before.engineId, before.scope, receipt.result]);
    checkEqual('restart does not replay accepted/completed sends', claude.spawned.reduce((n, p) => n + p.proc.calls.filter((m) => m.type === 'user').length, 0), 2);
    check('both RPC/IPC unknown operations survive real daemon reopen with original correlations', unknowns.every((old) =>
      daemon.graph.authority.snapshot().outbox.some((q) => q.mid === old.mid && q.state === 'unknown' && q.correlation === old.correlation)));
    const reloaded = browser({ storage: stored, device, config: { origin: 'http://127.0.0.1:' + daemon.engine.remote.port,
      socket: 'ws://127.0.0.1:' + daemon.engine.remote.port + '/socket', hostFingerprint: daemon.engine.delivery.identity.fingerprint } });
    browsers.push(reloaded); const reloadedTransport = reloaded.socket(); reloadedTransport.postMessage({ type: 'ready' });
    await until(() => reloadedTransport.application.records().some((r) => r.mid === send.mid && r.operation?.state === 'completed'), 'client reload after daemon port/boot change');
    checkEqual('browser disk outbox is pairing-scoped across process reload/new boot/port',
      [reloadedTransport.application.records().find((r) => r.mid === send.mid).ack.result.code, claude.spawned.reduce((n, p) => n + p.proc.calls.filter((m) => m.type === 'user').length, 0)], ['accepted', 2]);
    const faultRoot = path.join(path.dirname(root), 'drain-fault');
    const fault = await startDaemon({ root: faultRoot, adapters: { tools: adapters.tools } });
    fault.engine.flush = () => { throw new Error('synthetic private failure must not enter status'); };
    let drainFailure;
    try { await fault.stop(); } catch (error) { drainFailure = error.code; }
    checkEqual('failed drain names its stage and retains the ownership fence', [drainFailure, fault.lifecycle().phase, fault.lifecycle().failed, fs.existsSync(fault.paths.lock)], ['DRAIN_FAILED', 'failed', ['engine-flush'], true]);
  } finally {
    for (const b of browsers) b.close(); for (const c of connections) c.close(); for (const a of apps) a.disconnect();
    await daemon.stop();
    await ipc.close();
  }
};
