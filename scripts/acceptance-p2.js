#!/usr/bin/env node
'use strict';

// Default = portable rehearsal. Native effects have one explicit entry gate.
// All endpoints, client profiles and stores are minted by this invocation.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), crypto = require('crypto'), net = require('net'), http = require('http');
const { spawn, fork } = require('child_process');
const { privateDirectory, privateFile, noSymlinks, fail } = require('../src/daemonPaths');
const { controlRequest } = require('../src/daemonControl');
const { browser } = require('../test/helpers/browser-client');
const { makeDevice } = require('../test/helpers/device');
const ws = require('../test/helpers/ws');
const REPO = path.resolve(__dirname, '..'), BASE = '/private/tmp/nik-mac/p2';
const IDS = [...Array.from({ length: 12 }, (_, i) => 'A' + String(i + 1).padStart(2, '0')),
  ...Array.from({ length: 10 }, (_, i) => 'T' + (i + 63))];
const PENDING = 'native: pending Claude run';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, name, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do { const value = await fn(); if (value) return value; await delay(40); } while (Date.now() < deadline);
  throw fail('ACCEPTANCE_TIMEOUT', name);
}
function options(args) {
  const known = new Set(['--native', '--editor', '--real-tools', '--help']);
  if (new Set(args).size !== args.length || args.some((a) => !known.has(a))) throw fail('ARGUMENT_INVALID', 'Usage: acceptance-p2.sh [--native [--editor] [--real-tools]]');
  if (!args.includes('--native') && args.some((a) => ['--editor', '--real-tools'].includes(a))) {
    throw fail('NATIVE_OPT_IN_REQUIRED', '--editor and --real-tools require --native');
  }
  return { native: args.includes('--native'), editor: args.includes('--editor'), realTools: args.includes('--real-tools'), help: args.includes('--help') };
}
function save(file, value) {
  noSymlinks(file); privateFile(file, { optional: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
function diskStorage(dir) {
  privateDirectory(dir);
  const file = (key) => path.join(dir, crypto.createHash('sha256').update(key).digest('hex') + '.json');
  return { get: (key) => fs.existsSync(file(key)) ? fs.readFileSync(file(key), 'utf8') : null,
    set: (key, value) => fs.writeFileSync(file(key), value, { mode: 0o600 }) };
}
async function observe(paths, credential, generation) {
  const frames = [], socket = net.createConnection({ path: paths.socket }); let buffer = '';
  socket.setEncoding('utf8'); socket.on('error', () => {});
  socket.on('data', (chunk) => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) {
    frames.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1);
  } });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(JSON.stringify({ op: 'menu-observe', id: credential.id, key: credential.key, generation }) + '\n');
  await until(() => frames.some((m) => m.type === 'menu:snapshot'), 'menu protocol observer');
  return { frames, close: () => socket.destroy() };
}
async function stream(origin, secret) {
  return new Promise((resolve, reject) => {
    const result = { text: '', status: null, closed: false };
    const request = http.get(new URL('/notify/listen', origin), { headers: { authorization: 'Bearer ' + secret } }, (response) => {
      result.status = response.statusCode;
      response.setEncoding('utf8'); response.on('data', (s) => { result.text += s; }); response.on('close', () => { result.closed = true; });
      result.close = () => { response.destroy(); request.destroy(); }; resolve(result);
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(fail('SSE_TIMEOUT', 'SSE did not open')));
  });
}

async function disconnectBeforeWrite({ current, transport, call }) {
  const message = { type: 'send', text: 'P2 synthetic identical resend', sent: 'expanded resend' };
  const original = current.window.nikSecure.clientBox;
  const trace = { factories: 0, boxes: 0, opened: [], seals: [], advertisement: null, welcome: null };
  let stage = 'finish-previous-operation', action, atPost, preNegotiation;
  let hold = true, held = false, heldPlaintext, release, negotiationHeld = false, releaseNegotiation, succeeded = false;
  const negotiation = new Promise((resolve) => { releaseNegotiation = resolve; });
  function diagnostics() {
    const records = transport.application.records();
    const record = records.find((r) => r.mid === action?.mid);
    return { stage, proto: transport.application.proto, ready: transport.application.ready, sealed: transport.sealed(),
      seat: trace.welcome?.seat || null, allowed: transport.application.allowed(message),
      socket: { index: current.sockets.length - 1, readyState: current.sockets.at(-1)?.readyState },
      postResult: action ?? null, outbox: { mid: action?.mid || null, state: record?.state || 'absent',
        records: records.map((r) => ({ mid: r.mid, type: r.payload.type, state: r.state, quarantined: !!r.quarantined,
          ack: r.ack && { status: r.ack.status, outcome: r.ack.outcome, code: r.ack.error?.code }, operation: r.operation?.state })) },
      held, trace: JSON.parse(JSON.stringify(trace)) };
  }
  try {
    await call('finish');
    current.window.nikSecure.clientBox = (...args) => {
      trace.factories++;
      return original(...args).then((box) => {
        trace.boxes++;
        const open = box.open.bind(box), seal = box.seal.bind(box);
        box.open = (frame) => Promise.resolve(open(frame)).then((text) => {
          const m = JSON.parse(text);
          trace.opened.push(m.type); trace.opened = trace.opened.slice(-16);
          if (m.type === '@welcome') trace.advertisement = { proto: m.proto, caps: m.caps, control: m.device?.control };
          if (m.type === 'welcome') {
            trace.welcome = { proto: m.proto, caps: m.caps, seat: m.seat };
            // Deliberately separate crypto readiness from application readiness
            // on both runtimes. A fast in-process fixture hid this ordering.
            negotiationHeld = true;
            return negotiation.then(() => text);
          }
          if (m.type === '@device' && trace.welcome) trace.welcome.seat.control = !!m.device?.control;
          return text;
        });
        box.seal = (text) => {
          const m = JSON.parse(text);
          trace.seals.push({ type: m.type, mid: m.mid }); trace.seals = trace.seals.slice(-16);
          if (hold && m.type === 'send') {
            hold = false; held = true; heldPlaintext = text;
            return new Promise((resolve) => { release = () => resolve(seal(text)); });
          }
          return seal(text);
        };
        return box;
      });
    };
    stage = 'sealed-before-negotiation';
    transport.reconnect();
    await until(() => negotiationHeld, 'resend negotiation welcome');
    assert.equal(transport.sealed(), true);
    assert.equal(transport.application.ready, false);
    assert.equal(transport.application.proto, null);
    const countBeforeProbe = transport.application.records().length;
    assert.equal(transport.postMessage({ type: 'send', text: 'P2 synthetic pre-negotiation probe' }), false);
    assert.equal(transport.application.records().length, countBeforeProbe);
    preNegotiation = diagnostics();
    stage = 'application-ready';
    const ready = until(() => {
      if (!transport.application.ready) return false;
      if (transport.application.proto !== 2) throw fail('RESEND_PROTOCOL_MISMATCH', 'Identical-mid resend requires negotiated protocol 2');
      if (!transport.application.allowed(message)) throw fail('RESEND_CONTROL_UNAVAILABLE', 'Negotiated seat does not allow send');
      return transport.sealed();
    }, 'negotiated resend channel');
    let readySettled = false;
    ready.then(() => { readySettled = true; }, () => { readySettled = true; });
    await delay(0);
    assert.equal(readySettled, false, 'Channel wait must remain pending while the negotiated welcome is held');
    releaseNegotiation();
    await ready;
    const before = (await call('state')).effects.claude;
    stage = 'persist-and-hold-send';
    action = transport.postMessage(message);
    atPost = diagnostics();
    if (!action?.mid) throw fail('RESEND_SEND_REFUSED', 'Send was refused before outbox persistence');
    await until(() => held, 'plaintext persisted before crypto/write');
    const pending = transport.application.records().find((r) => r.mid === action.mid);
    assert.equal(pending?.state, 'pending', 'Held send must be durably pending');
    assert.equal(pending.plaintext, heldPlaintext, 'Seal must hold the exact persisted send');
    const beforeDisconnect = diagnostics();
    const socket = current.sockets.at(-1), count = socket.sent.length;
    stage = 'reconnect-and-reconcile';
    transport.reconnect(); release(); release = null;
    await until(() => transport.application.records().find((r) => r.mid === action.mid)?.state === 'accepted', 'same-mid authoritative-miss retry');
    assert.equal(socket.sent.length, count);
    assert.equal(transport.application.records().find((r) => r.mid === action.mid).plaintext, pending.plaintext);
    await until(async () => (await call('state')).effects.claude === before + 1, 'one resend effect');
    await call('finish'); succeeded = true;
    return { mid: action.mid, oldChannelWrites: 0, effects: 1, preNegotiationRefused: true, readinessWaitBlocked: true,
      preNegotiation, beforeDisconnect };
  } catch (error) {
    error.diagnostics = { ...diagnostics(), atPost, preNegotiation };
    const d = error.diagnostics, sent = atPost || d;
    const cause = !sent.ready || sent.proto === null ? 'APPLICATION_NOT_READY' : sent.proto !== 2 ? 'PROTOCOL_MISMATCH'
      : !sent.allowed ? 'CONTROL_UNAVAILABLE' : action === false ? 'SEND_REFUSED'
        : !trace.factories ? 'CLIENT_BOX_NOT_CREATED' : d.outbox.state === 'absent' ? 'OUTBOX_NOT_PERSISTED'
          : !held ? 'SEND_NOT_SEALED' : 'RESEND_NOT_RECONCILED';
    error.diagnostics.cause = cause;
    error.message += `; cause=${cause} stage=${stage} proto=${sent.proto} ready=${sent.ready} seat.control=${sent.seat?.control ?? 'unknown'} outbox=${d.outbox.state}`;
    throw error;
  } finally {
    current.window.nikSecure.clientBox = original;
    // Never leave an unresolved hook or allow a failed held action to write.
    if (!succeeded && release) transport.__socket()?.close();
    releaseNegotiation(); release?.();
  }
}

async function scenarios({ run, paths, restart, native = false, assetsRoot, editor, realTools }) {
  const evidence = path.join(run, 'p2-scenarios.json');
  const report = { version: 1, mode: native ? 'signed-native' : 'portable', ok: false, root: paths.root, checks: [],
    clients: { currentPhone: 'shared web JS/P-256/AES; protocol client', oldPhone: 'sealed v1 web protocol client; no hello',
      menu: native ? 'actual signed menu app' : 'local menu protocol observer', editor: editor ? PENDING : 'opt-in unrun',
      physicalPhones: 'manual: pending' }, delivery: { sse: 'pending', apns: 'unconfigured/unrun', webPush: 'unconfigured/unrun' } };
  const resources = [], clientFailures = [];
  async function closeClients() {
    while (resources.length) { try { await resources.pop().close(); } catch (e) { clientFailures.push(e.code || 'CLIENT_CLEANUP_FAILED'); } }
  }
  let credential, status, current, transport, old;
  const call = (action) => controlRequest(paths, { op: 'acceptance-p2', action }, { timeoutMs: 30000 });
  async function localResult(op, args = {}) {
    return controlRequest(paths, { op: 'local', id: credential.id, key: credential.key, request: {
      type: 'local:request', version: 1, id: crypto.randomBytes(16).toString('hex'), generation: status.generation, op, args } });
  }
  async function local(op, args = {}) {
    const reply = await localResult(op, args);
    assert.equal(reply.ok, true, op + ': ' + reply.code); return reply.data;
  }
  async function check(name, ids, fn) {
    const item = { name, ids, status: 'running', evidence }; report.checks.push(item); save(evidence, report);
    try { item.proof = await fn(); item.status = item.proof?.status === 'unconfigured/unrun' ? 'unrun' : 'passed'; }
    catch (e) { item.status = 'failed'; item.code = e.code || 'ASSERTION_FAILED'; item.message = e.message; item.diagnostics = e.diagnostics; throw e; }
    finally { save(evidence, report); }
  }
  async function pair(device) {
    const state = await local('pairing.open', { seconds: 60 });
    const response = await fetch(`http://127.0.0.1:${status.listener.port}/pair`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(await device.pairingBody(state.code)), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.fingerprint, report.pins.fingerprint); device.id = body.device;
    await local('device.grant', { id: device.id, control: true }); return body;
  }
  async function legacy(device, rekey) {
    const client = await ws.connect(`ws://127.0.0.1:${status.listener.port}/socket?session=p2-claude`);
    resources.push({ close: () => client.destroy() });
    const challenge = await client.waitFor('@challenge'); assert.equal(challenge.fingerprint, report.pins.fingerprint);
    let auth = await device.answer(challenge, device.id);
    if (rekey) {
      const secure = require('../src/secure'), { readPublicKey } = require('../src/identity');
      const signed = `nikui-rekey:${challenge.nonce}:${auth.nonce}:${readPublicKey(rekey.publicKey).fingerprint}:` + secure.binding(challenge.epk, auth.epk);
      auth = { ...auth, signature: await device.sign(signed), rekey: { publicKey: rekey.publicKey, signature: await rekey.sign(signed), protection: 'software', biometric: false } };
    }
    client.send(auth); client.seal(device.box);
    const welcome = await client.waitFor('@welcome');
    const suffix = ':' + require('../src/secure').binding(challenge.epk, auth.epk);
    assert(require('../src/identity').verifyWith(challenge.serverKey, `nikui-host:${auth.nonce}:${challenge.nonce}${suffix}`, welcome.signature));
    client.send({ type: 'ready' }); await client.waitFor('init');
    return { client, welcome };
  }
  function phone(device, name) {
    const origin = `http://127.0.0.1:${status.listener.port}`;
    const b = browser({ device, fakeTimers: true, storage: diskStorage(path.join(run, name)), assetsRoot,
      config: { session: 'p2-claude', origin, socket: origin.replace('http:', 'ws:') + '/socket?session=p2-claude', hostFingerprint: report.pins.fingerprint } });
    resources.push(b); return b;
  }
  const first = await controlRequest(paths, { op: 'status' }); status = first;
  try {
    const seeded = await call('seed'); assert(seeded.ok);
    report.pins = { fingerprint: seeded.fingerprint, applicationServerKey: seeded.applicationServerKey };
    report.engine = { id: first.engine.id, boot: first.engine.boot, generation: first.generation, pid: first.pid };
    credential = await controlRequest(paths, { op: 'enroll', kind: 'local', protocol: 2 });
    if (!native) resources.push(await observe(paths, credential, first.generation));
    if (editor) { const client = await editor({ run, paths, status, cwd: seeded.cwd }); resources.push(client); report.clients.editor = client.evidence; }
    const d1 = await makeDevice('P2 new phone'), d2 = await makeDevice('P2 old phone');
    await pair(d1); await pair(d2);
    current = phone(d1, 'phone-current'); transport = current.socket(); transport.postMessage({ type: 'ready' });
    ({ client: old } = await legacy(d2));
    await until(() => current.messages.some((m) => m.type === 'init'), 'current phone init');
    await check('same-run-menu-and-two-phones', [...(editor ? ['A01'] : []), 'A02', 'A06', 'T68'], async () => {
      assert.equal(transport.application.proto, 2); assert.equal(transport.sealed(), true);
      assert.equal(old.messages.some((m) => m.type === 'welcome'), false);
      const menu = await local('menu.snapshot');
      assert.equal(menu.status.generation, first.generation); assert.equal(menu.status.pid, first.pid);
      assert(menu.fleet.instances.some((i) => i.id === seeded.instance));
      assert(menu.status.localManagement.menuObservers >= 1);
      assert.equal(current.messages.find((m) => m.type === 'init').sessionId, seeded.instance);
      assert.equal(old.messages.find((m) => m.type === 'init').sessionId, seeded.instance);
      if (editor) assert(menu.status.bridge.editors >= 2);
      return { engine: first.engine.id, generation: first.generation, pid: first.pid, phoneProtocols: [2, 1],
        separateDaemonProcess: first.pid !== process.pid,
        selectedSecretBackend: first.package?.portable ? 'portable-selected-store' : first.package?.keychainBackend || 'file-test-store',
        editors: menu.status.bridge.editors, menuObservers: menu.status.localManagement.menuObservers, physicalBuilds: 'manual pending' };
    });
    await check('live-legacy-owner-named-refusal', ['A05', 'T70'], async () => {
      const blocked = await call('legacy-owner'); assert.equal(blocked.ok, true);
      assert.equal(blocked.code, 'CUTOVER_BLOCKED');
      assert(blocked.blockers.some((b) => b.id === 'p2-legacy-window' && b.code === 'KEEPER_META_UNSUPPORTED'));
      assert.equal(blocked.owner.generation, 0); assert.equal(blocked.owner.mode, 'window');
      assert.equal((await controlRequest(paths, { op: 'status' })).pid, first.pid);
      return blocked;
    });
    if (!realTools) await check('real-tool-opt-in-refuses-by-default', ['A10', 'T65'], async () => {
      assert.equal((await call('real-tools')).code, 'REAL_TOOL_OPT_IN_REQUIRED'); return { realToolsStarted: 0 };
    });
    await check('network-administration-unavailable-without-adoption', ['A08', 'T70'], async () => {
      const result = await localResult('network.status'); assert.equal(result.ok, false); assert.equal(result.code, 'NETWORK_ADMIN_UNAVAILABLE');
      return { refusal: result.code, routeMutationCommands: 0, nativeRouteSnapshot: native ? 'in top-level report' : PENDING };
    });
    await check('lost-ack-reconnect-one-effect', ['A03', 'T68', 'T70'], async () => {
      let drop = true;
      const original = current.window.nikSecure.clientBox;
      // Replace the next channel factory, then reconnect before sending.
      current.window.nikSecure.clientBox = (...args) => original(...args).then((box) => {
        const open = box.open.bind(box);
        box.open = (frame) => Promise.resolve(open(frame)).then((text) => {
          const m = JSON.parse(text);
          if (drop && m.type === 'ack' && m.what === 'send') { drop = false; current.sockets.at(-1).drop(); return JSON.stringify({ type: 'acceptance:lost-ack' }); }
          return text;
        }); return box;
      });
      transport.reconnect(); await until(() => transport.application.proto === 2 && transport.sealed(), 'fresh sealed channel');
      const before = (await call('state')).effects.claude;
      const action = transport.postMessage({ type: 'send', text: 'P2 synthetic lost ack', sent: 'P2 synthetic lost ack' });
      await until(() => !drop && current.sockets.at(-1).readyState === 3, 'ack dropped');
      await until(async () => (await call('state')).effects.claude === before + 1, 'one committed provider effect');
      const pending = transport.application.records().find((r) => r.mid === action.mid); assert(pending);
      const oldFrames = current.sockets.at(-1).sent.filter((m) => m.type === '@box').map((m) => JSON.stringify(m));
      transport.reconnect();
      await until(() => transport.application.records().find((r) => r.mid === action.mid)?.state === 'accepted', 'receipt reconciliation');
      const recovered = transport.application.records().find((r) => r.mid === action.mid);
      assert.equal(recovered.ack.status, 'duplicate');
      assert.equal((await call('state')).effects.claude, before + 1);
      assert.equal(recovered.plaintext, pending.plaintext);
      const freshFrames = current.sockets.at(-1).sent.filter((m) => m.type === '@box');
      assert(freshFrames.length && freshFrames.every((m) => !oldFrames.includes(JSON.stringify(m))));
      report.lostAckMid = action.mid;
      return { mid: action.mid, effects: 1, receipt: recovered.ack.status, resealed: true, durableClientStore: path.join(run, 'phone-current') };
    });
    await check('disconnect-before-write-identical-mid-resend', ['A03', 'T68'], () => disconnectBeforeWrite({ current, transport, call }));
    await check('old-phone-v1-current-grants', ['A06', 'T68'], async () => {
      const before = (await call('state')).effects.claude;
      old.send({ type: 'send', text: 'P2 synthetic v1 input' });
      await until(async () => (await call('state')).effects.claude === before + 1, 'v1 provider effect');
      await call('finish');
      assert.equal(old.messages.some((m) => m.type === 'welcome'), false);
      await local('device.revoke', { id: d2.id });
      old.send({ type: 'send', text: 'must be refused after grant revocation' });
      assert.equal((await old.waitFor('@refused')).what, 'send');
      assert.equal((await call('state')).effects.claude, before + 1);
      await local('device.grant', { id: d2.id, control: true });
      return { protocol: 1, effects: 1, refusedAfterRevoke: true, replay: false };
    });
    await check('pins-rekey-sse-and-forget', ['A07', 'T69'], async () => {
      old.send({ type: '@listen' }); const issued = await old.waitFor('@listener');
      const sse = await stream(`http://127.0.0.1:${status.listener.port}`, issued.secret); resources.push(sse); assert.equal(sse.status, 200);
      await call('notify'); await until(() => sse.text.includes('P2 synthetic delivery'), 'SSE delivery');
      const replacement = await makeDevice('P2 rekey');
      const rekeyed = await legacy(d2, replacement); assert(rekeyed.welcome.rekeyed); replacement.id = d2.id;
      old.destroy(); old = rekeyed.client;
      const before = await call('state'); assert.equal(before.fingerprint, report.pins.fingerprint); assert.equal(before.applicationServerKey, report.pins.applicationServerKey);
      // New key works; the previous signing key can no longer authenticate.
      const denied = await ws.connect(`ws://127.0.0.1:${status.listener.port}/socket`); resources.push({ close: () => denied.destroy() });
      const challenge = await denied.waitFor('@challenge'); denied.send(await d2.answer(challenge, d2.id)); denied.seal(d2.box);
      await denied.waitFor('@denied');
      await local('device.forget', { id: replacement.id }); await old.waitClosed();
      await call('notify'); await until(() => sse.closed, 'forgotten SSE closes');
      const response = await fetch(`http://127.0.0.1:${status.listener.port}/notify/listen`, { headers: { authorization: 'Bearer ' + issued.secret }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 401); await response.text();
      report.delivery.sse = 'passed (protocol client)';
      return { hostPin: before.fingerprint, vapidPin: before.applicationServerKey, rekey: true, oldKeyRefused: true, forgottenSSE: 401,
        apns: report.delivery.apns, webPush: report.delivery.webPush };
    });
    await check('active-claude-and-codex-update-refusal', ['A12', 'T70'], async () => {
      const before = await call('state');
      const action = transport.postMessage({ type: 'send', text: 'P2 synthetic active work', sent: 'active' });
      await until(async () => (await call('state')).effects.claude === before.effects.claude + 1, 'active Claude');
      await until(async () => (await call('readiness')).code === 'CLAUDE_OWNED_BUSY', 'Claude update refusal');
      const cx = await call('codex-busy'); assert(cx.ok);
      const readiness = await until(async () => { const r = await call('readiness'); return r.code === 'CODEX_OWNED_BUSY' && r; }, 'Codex update refusal');
      const menu = await local('menu.snapshot'); assert(menu.updateBlockers.includes('OWNED_WORK_BUSY'));
      assert.equal((await controlRequest(paths, { op: 'status' })).pid, first.pid);
      await call('codex-idle'); await call('finish');
      return { mid: action.mid, claude: 'CLAUDE_OWNED_BUSY', simultaneous: readiness.code, menu: menu.updateBlockers, pidUnchanged: first.pid };
    });
    await check('pending-approval-restart-stale-control-refused', ['A04', 'T70'], async () => {
      const pending = await call('pending'); assert(pending.ok);
      const before = await call('state');
      // Keep the old displayed approval while replacing the engine generation.
      current.close();
      status = await restart();
      assert.notEqual(status.generation, first.generation); assert.notEqual(status.engine.boot, first.engine.boot); assert.equal(status.engine.id, first.engine.id);
      const fresh = await call('seed'); assert.equal(fresh.fingerprint, report.pins.fingerprint); assert.equal(fresh.applicationServerKey, report.pins.applicationServerKey);
      const newPending = await call('pending'); assert.notDeepEqual(newPending.run, pending.run);
      current = phone(d1, 'phone-current'); transport = current.socket(); transport.postMessage({ type: 'ready' });
      await until(() => current.messages.some((m) => m.type === 'init'), 'phone reload after boot/port change');
      const late = transport.postMessage({ type: 'permission', run: pending.run, requestId: pending.requestId, allow: true });
      await until(() => transport.application.records().find((r) => r.mid === late.mid)?.state === 'rejected', 'stale approval refusal');
      const stale = transport.application.records().find((r) => r.mid === late.mid);
      assert.equal(stale.ack.error.code, 'STALE_RUN');
      assert.equal((await call('state')).effects.approvals, before.effects.approvals);
      const oldCount = before.effects.claude;
      await delay(100); assert.equal((await call('state')).effects.claude, oldCount);
      const currentApproval = transport.postMessage({ type: 'permission', requestId: newPending.requestId, allow: false, run: newPending.run });
      await until(async () => (await call('state')).effects.approvals === before.effects.approvals + 1, 'fresh approval answered once');
      await call('finish');
      return { oldBoot: before.engine.boot, newBoot: status.engine.boot, staleCode: stale.ack.error.code, freshMid: currentApproval.mid, duplicateEffectsAfterRestart: 0 };
    });
    if (realTools) await check('real-tools-fresh-tiny-prompts', ['A10', 'T65'], () => realTools({ run, paths, status }));
    await closeClients();
    if (clientFailures.length) throw fail('CLIENT_CLEANUP_FAILED', clientFailures.join(', '));
    await check('closing-scenario-clients-leaves-engine-alive', ['A02', 'T68'], async () => {
      const alive = await controlRequest(paths, { op: 'status' });
      assert.equal(alive.pid, status.pid); assert.equal(alive.state, 'running');
      return { pid: alive.pid, generation: alive.generation, menuStillOpen: native };
    });
    await check('fresh-current-handback-with-post-cutover-work', ['A07', 'A12', 'T69', 'T70'], async () => {
      const before = await call('state'); assert.equal((await call('handoff')).ok, true);
      const result = await until(async () => { const h = await call('handoff-status'); return h.state === 'finished' && h.result; }, 'current selected handback', 120000);
      assert.equal(result.status, 'passed', result.code); assert.equal(result.cleanup, true);
      assert.equal((await call('state')).effects.claude, before.effects.claude);
      return { ...result, evidence: path.join(paths.root, 'acceptance-handoff.json') };
    });
    report.lastStatus = await controlRequest(paths, { op: 'status' });
    report.ok = true;
  } catch (e) {
    report.failure = { code: e.code || 'ASSERTION_FAILED', message: e.message, diagnostics: e.diagnostics }; throw e;
  } finally {
    await closeClients();
    report.cleanup = { clientsClosed: !clientFailures.length, failures: clientFailures };
    if (clientFailures.length) { report.ok = false; save(evidence, report); throw fail('CLIENT_CLEANUP_FAILED', clientFailures.join(', ')); }
    save(evidence, report);
  }
  return report;
}

async function portable(run) {
  const root = path.join(run, 'test-home', 'd'); privateDirectory(path.dirname(root));
  const home = path.dirname(root); privateDirectory(path.join(home, 'tmp'));
  let daemon;
  async function start() {
    const fd = fs.openSync(path.join(run, 'portable-engine.log'), 'a', 0o600);
    try {
      const child = fork(path.join(REPO, 'test/helpers/acceptance-daemon.js'), [root], {
        cwd: REPO, stdio: ['ignore', fd, fd, 'ipc'], execArgv: [],
        env: { HOME: home, USERPROFILE: home, ZDOTDIR: home, TMPDIR: path.join(home, 'tmp'),
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NIKUI_NATIVE_TESTS: '0' }
      });
      const runtime = daemon = { child };
      runtime.exited = new Promise((resolve) => child.once('close', (code, signal) => { runtime.exit = { code, signal }; resolve(runtime.exit); }));
      child.once('error', (error) => { runtime.error = error; });
      child.once('message', (message) => { runtime.ready = message; });
      const ready = await until(() => {
        if (runtime.error || runtime.exit) throw fail('PORTABLE_DAEMON_FAILED', 'Portable daemon failed; inspect portable-engine.log');
        return runtime.ready;
      }, 'separate portable daemon startup');
      if (!ready.ok) throw fail(ready.code, 'Portable daemon initialization failed');
      assert.notEqual(ready.status.pid, process.pid, 'Portable daemon must have an independent event loop');
      return ready.status;
    } finally { fs.closeSync(fd); }
  }
  async function stop() {
    if (!daemon) return;
    const runtime = daemon;
    if (runtime.child.connected) runtime.child.send({ op: 'stop' }, () => {});
    const terminate = setTimeout(() => runtime.child.kill('SIGTERM'), 5000);
    const kill = setTimeout(() => runtime.child.kill('SIGKILL'), 8000);
    try {
      const result = await runtime.exited;
      assert.equal(result.code, 0, 'Portable daemon drain failed: portable-engine.log');
      assert.equal(result.signal, null);
    } finally { clearTimeout(terminate); clearTimeout(kill); daemon = null; }
  }
  try {
    await start();
    return await scenarios({ run, paths: require('../src/daemonPaths').privateRoot(root), restart: async () => { await stop(); return start(); } });
  } finally { await stop(); }
}

async function regression(run, filter) {
  const home = path.join(run, 'regression-home'); privateDirectory(home); privateDirectory(path.join(home, 'tmp'));
  const log = path.join(run, filter + '.log'), fd = fs.openSync(log, 'w', 0o600);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(REPO, 'test/run.js'), filter], { cwd: REPO, stdio: ['ignore', fd, fd],
        env: { HOME: home, USERPROFILE: home, ZDOTDIR: home, TMPDIR: path.join(home, 'tmp'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          CODEX_HOME: path.join(home, '.codex-work'), NIKUI_NATIVE_TESTS: '0' } });
      const timer = setTimeout(() => { child.kill('SIGTERM'); }, 120000);
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(result.code, 0, filter + ' failed: ' + log);
    const count = fs.readFileSync(log, 'utf8').match(/(\d+\/\d+) checks passed/)?.[1]; assert(count);
    return { status: 'passed', count, evidence: log, native: false };
  } finally { fs.closeSync(fd); }
}
async function main(flags = options(process.argv.slice(2))) {
  if (flags.help) { process.stdout.write('Usage: scripts/acceptance-p2.sh [--native [--editor] [--real-tools]]\nDefault: portable test profile only. Native/GUI/SecItem/SMAppService: Claude only.\n'); return; }
  noSymlinks(BASE); fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(BASE);
  assert(parent.isDirectory() && parent.uid === process.getuid() && !(parent.mode & 0o022), 'Unsafe evidence parent');
  const run = fs.mkdtempSync(path.join(BASE, 'rehearsal-')), evidence = path.join(run, 'result.json');
  const report = { version: 1, run, ok: false, flags, native: flags.native ? 'running' : PENDING,
    items: Object.fromEntries(IDS.map((id) => [id, { automated: [], native: PENDING, manual: 'docs/engine/p2-manual-checklist.md#' + id.toLowerCase() }])), regressions: {} };
  save(evidence, report);
  try {
    if (flags.native) {
      assert.equal(process.platform, 'darwin');
      const { routeSnapshot, findRouteTool, corruptSelectedStore } = require('./acceptance-p2-native');
      let routeTool = findRouteTool();
      // Capture foreign state before build/registration/startup as well as
      // before Stop/update/handback. A late-only observation cannot pass.
      const beforeRoutes = routeSnapshot(routeTool);
      const native = await require('./test-mac-engine').main({ menubar: true, acceptanceP2: true, acceptanceRealTools: flags.realTools, quiet: true, exercise: async (context) => {
        report.nativeEvidence = path.join(context.run, 'result.json'); save(evidence, report);
        routeTool ||= context.first.tools.tailscale.path;
        const tested = await scenarios({ ...context, native: true,
          assetsRoot: path.join(context.app, 'Contents/Resources/engine/media'),
          restart: async () => { context.controller('intentional-stop'); return context.controller('start').control; },
          editor: flags.editor ? require('./acceptance-p2-editor').launchEditors : null,
          realTools: flags.realTools ? require('./acceptance-p2-tools').runRealTools : null });
        tested.corruptSelectedStore = await corruptSelectedStore(context);
        tested.lastStatus = await controlRequest(context.paths, { op: 'status' });
        return tested;
      } });
      report.nativeEvidence ||= path.join(native.run, 'result.json');
      const afterRoutes = routeSnapshot(routeTool);
      report.routes = { before: beforeRoutes, after: afterRoutes, mutationCommands: 0,
        status: beforeRoutes?.status === 'observed' && afterRoutes.status === 'observed' ? 'passed (read-only observation)' : 'unconfigured/unrun' };
      if (report.routes.status.startsWith('passed')) assert.equal(afterRoutes.sha256, beforeRoutes.sha256, 'Unrelated tailnet configuration changed during rehearsal');
      if (!native.ok) {
        const error = fail(native.failure?.code || 'NATIVE_ACCEPTANCE_FAILED',
          (native.failure?.message || 'Signed native acceptance failed') + '; inspect ' + report.nativeEvidence);
        error.diagnostics = native.failure?.diagnostics; throw error;
      }
      report.native = 'passed (automated subset; attended checklist remains)'; report.scenarios = native.acceptanceP2;
      const covered = { A09: 'corrupt selected item; locked/denied manual', A10: 'minimal launchd environment',
        T63: 'signed relocated final dev package', T64: 'enabled/crash/Stop/Start/unregister; approval denied manual',
        T65: 'minimal environment/resolution; TCC manual', T66: 'native CRUD/rebuild/corruption; lock/denial manual', T67: 'retained signed helpers/no-model; permission/click manual' };
      if (flags.editor) covered.A01 = 'two actual independent development VS Code windows';
      for (const [id, subset] of Object.entries(covered)) report.items[id].native = { status: 'passed subset', subset, evidence: report.nativeEvidence };
      if (report.routes.status.startsWith('passed')) report.items.A08.native = { ...report.routes, evidence };
    } else report.scenarios = await portable(run);
    for (const item of report.scenarios.checks) for (const id of item.ids) {
      report.items[id].automated.push({ name: item.name, status: item.status, evidence: item.evidence });
      if (flags.native && report.items[id].native === PENDING) report.items[id].native = {
        status: 'passed scripted subset', subset: item.name, evidence: item.evidence, independent: 'manual pending' };
    }
    const additional = { 'engine-cutover': ['A01', 'A12', 'T70'], 'engine-owner': ['A01', 'A05', 'T70'], 'engine-import': ['A07', 'A09', 'A12', 'T69', 'T70'],
      'engine-handoff': ['A04', 'A05', 'A12', 'T70'], 'engine-policy-owner': ['A11', 'T72'], 'engine-doctor': ['A10', 'T65'] };
    for (const [filter, ids] of Object.entries(additional)) {
      const result = await regression(run, filter); report.regressions[filter] = result;
      for (const id of ids) report.items[id].automated.push({ name: filter + ' (synthetic adapters)', ...result });
      save(evidence, report);
    }
    report.ok = true;
  } catch (e) {
    report.failure = { code: e.code || 'ASSERTION_FAILED', message: e.message, diagnostics: e.diagnostics };
    if (flags.native) report.native = 'failed (native gate incomplete)';
    process.exitCode = 1;
  }
  finally {
    save(evidence, report); save(path.join(BASE, 'acceptance-latest.json'), { evidence, ok: report.ok, native: report.native });
  }
  process.stdout.write(JSON.stringify({ ok: report.ok, evidence, native: report.native, failure: report.failure }) + '\n');
  return report;
}
if (require.main === module) {
  try { main().catch((e) => { process.stderr.write((e.code || 'ACCEPTANCE_FAILED') + ': ' + e.message + '\n'); process.exitCode = 1; }); }
  catch (e) { process.stderr.write(e.code + ': ' + e.message + '\n'); process.exitCode = 1; }
}
module.exports = { main, options, scenarios, portable, regression, until, disconnectBeforeWrite, IDS, PENDING };
