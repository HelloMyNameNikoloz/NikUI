'use strict';

// P1 local development only. Both enrollment and the streaming bridge use the
// owner-only control socket inside the explicit private root. No discovery,
// production HOME, external daemon or editor fallback exists here.
const net = require('net');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { CORE } = require('./protocolV2');
const { privateRoot, privateFile, inside, noSymlinks, fail } = require('./daemonPaths');
const { controlRequest } = require('./daemonControl');

const METHODS = Object.freeze(['openFile', 'openUrl', 'runInTerminal', 'switchTo']);
const CLIENTS = 'nikd.developmentClients.v1';
const MAX_FRAME = 16 * 1024 * 1024;

function lineChannel(socket, receive, initial = '') {
  let buffer = initial, ended = false;
  socket.setEncoding('utf8');
  const consume = (chunk = '') => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      if (Buffer.byteLength(buffer.slice(0, at)) > MAX_FRAME) return socket.destroy();
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let message;
      try { message = JSON.parse(line); } catch (_) { return socket.destroy(); }
      // Ingress remains synchronous: the receipt router must capture origin,
      // run and resource identities before its first asynchronous disk wait.
      try { Promise.resolve(receive(message)).catch(() => socket.destroy()); } catch (_) { socket.destroy(); }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) socket.destroy();
  };
  socket.on('data', consume);
  socket.on('error', () => {});
  socket.once('close', () => { ended = true; });
  if (initial) queueMicrotask(() => consume());
  return {
    send(message) {
      if (ended || !socket.writable || socket.writableLength > MAX_FRAME * 2) throw fail('BRIDGE_DISCONNECTED');
      const text = JSON.stringify(message);
      if (Buffer.byteLength(text) > MAX_FRAME) throw fail('BRIDGE_FRAME_TOO_LARGE');
      socket.write(text + '\n');
    }
  };
}

function createDevelopmentBridge({ paths, secrets, remote, currentState, engineInfo, fingerprint, running, management = () => null, timeoutMs = 15000 }) {
  const providers = new Map(), connections = new Set(), pending = new Map();
  let active = true;
  function localContext(request) {
    const record = secrets.get(CLIENTS, []).find((r) => !r.revoked && r.id === request.id && r.key === request.key);
    if (!active || !running() || !record) return null;
    return { authenticated: true, principal: 'local-client:' + record.id,
      seat: { id: record.id, local: true, control: true, editor: record.kind === 'editor' } };
  }
  function enroll(request) {
    const records = secrets.get(CLIENTS, []);
    let record;
    if (request.id) {
      record = records.find((r) => !r.revoked && r.id === request.id && r.kind === request.kind && r.key === request.key);
      if (!record) return { ok: false, code: 'ENROLLMENT_INVALID' };
    } else {
      if (records.length >= 32) return { ok: false, code: 'ENROLLMENT_FULL' };
      record = { id: crypto.randomBytes(16).toString('hex'), key: crypto.randomBytes(32).toString('base64url'), kind: request.kind };
      records.push(record); secrets.update(CLIENTS, records);
    }
    return { ok: true, mode: 'isolated-p1', id: record.id, key: record.key, kind: record.kind,
      protocol: 2, engineId: engineInfo.id, hostFingerprint: fingerprint,
      editorMethods: record.kind === 'editor' ? METHODS.slice() : [],
      ...(management() ? { localManagement: { version: 1, generation: management().generation } } : {}) };
  }
  function disconnectProvider(connection) {
    const provider = providers.get(connection.enrollment.id);
    if (provider?.connection === connection) { provider.connected = false; providers.delete(provider.id); remote.broadcastFleet(); }
    for (const [id, request] of pending) if (request.connection === connection) {
      clearTimeout(request.timer); pending.delete(id);
      request.resolve({ status: 'unavailable', code: 'EDITOR_UNAVAILABLE', reason: 'EDITOR_DISCONNECTED', outcome: 'unknown' });
    }
  }
  function register(connection, message) {
    if (connection.enrollment.kind !== 'editor' || connection.provider !== true) throw fail('EDITOR_UNAVAILABLE');
    if (!Array.isArray(message.methods) || message.methods.length > METHODS.length || message.methods.some((m) => !METHODS.includes(m)) ||
        !Array.isArray(message.workspaces) || message.workspaces.length > 64 || typeof message.focused !== 'boolean') throw fail('BAD_MESSAGE');
    const workspaces = message.workspaces.map((value) => {
      if (typeof value !== 'string' || value.length > 4096) throw fail('BAD_MESSAGE');
      const uri = new URL(value);
      if (uri.protocol === 'file:') {
        const cwd = fileURLToPath(uri);
        if (!inside(paths.home, cwd)) throw fail('CWD_OUTSIDE_ROOT');
        noSymlinks(cwd);
      }
      return uri.href;
    });
    const previous = providers.get(connection.enrollment.id);
    if (previous && previous.connection !== connection) throw fail('EDITOR_ALREADY_CONNECTED');
    // Keep object identity for in-flight selections when focus/workspaces change.
    const provider = previous || { id: connection.enrollment.id, connection, connected: true,
      request(method, request, requester) {
        if (!active || !running() || !provider.connected || !connections.has(connection)) return Promise.resolve({
          status: 'unavailable', code: 'EDITOR_UNAVAILABLE', reason: 'EDITOR_DISCONNECTED' });
        const id = crypto.randomBytes(16).toString('hex');
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id); resolve({ status: 'unavailable', code: 'EDITOR_UNAVAILABLE', reason: 'EDITOR_TIMEOUT', outcome: 'unknown' });
          }, timeoutMs);
          pending.set(id, { connection, resolve, timer });
          try { connection.post({ type: 'editor:request', id, method, request,
            origin: { editor: provider.id, client: requester?.client || null, proto: 2 } }); }
          catch (_) { clearTimeout(timer); pending.delete(id); resolve({ status: 'unavailable', code: 'EDITOR_UNAVAILABLE', outcome: 'unknown' }); }
        });
      } };
    Object.assign(provider, { methods: [...new Set(message.methods)], workspaces, focused: message.focused });
    providers.set(provider.id, provider); remote.broadcastFleet();
    connection.post({ type: 'editor:registered', id: provider.id, methods: provider.methods });
  }
  function connect(request, socket, initial) {
    const enrollment = secrets.get(CLIENTS, []).find((r) => !r.revoked && r.id === request.id && r.key === request.key);
    if (!active || !running() || !enrollment) { socket.end(JSON.stringify({ type: '@denied', reason: 'ENROLLMENT_INVALID' }) + '\n'); return; }
    if (request.target !== null && request.target !== undefined && typeof request.target !== 'string') { socket.destroy(); return; }
    const connection = { id: 'development-' + crypto.randomUUID(), enrollment, provider: request.provider === true,
      wants: request.target || null, device: { id: enrollment.id, name: 'Isolated development window', kind: 'local', control: true },
      open: true, bind(binding) { this.binding = binding; },
      post: (m) => {
        if (!connection.open || socket.destroyed || !socket.writable) return false;
        try { channel.send(m); return true; } catch (_) { connection.close(); return false; }
      },
      close() { connection.open = false; socket.destroy(); }, binding: null };
    connections.add(connection); remote.clients.add(connection);
    let protocol;
    const channel = lineChannel(socket, (message) => {
      if (!connection.open) return;
      if (!active || !running()) return connection.post({ type: 'protocol:error', code: 'DRAINING' });
      if (message?.type === 'local:request' && management()) {
        if (protocol?.proto !== 2) return connection.post({ type: 'protocol:error', code: 'NO_COMMON_PROTOCOL' });
        return management().dispatch(context, message).then((answer) => connection.post(answer));
      }
      if (message?.type === 'editor:register') return register(connection, message);
      if (message?.type === 'editor:result') {
        const p = pending.get(message.id);
        if (p?.connection !== connection) return;
        pending.delete(message.id); clearTimeout(p.timer);
        const result = message.result;
        p.resolve(result === true || result === false ? result : result && ['dispatched', 'unavailable'].includes(result.status)
          ? { status: result.status, code: 'EDITOR_UNAVAILABLE', outcome: result.outcome === 'unknown' ? 'unknown' : undefined } : undefined);
        return;
      }
      // The legacy lane belongs to old network clients. A newly enrolled
      // development window must use receipts and its authenticated origin.
      if (protocol?.proto === null && (message?.type !== 'hello' || message.proto?.max < 2 ||
          !CORE.every((cap) => message.caps?.includes(cap)))) {
        connection.post({ type: 'protocol:error', code: 'NO_COMMON_PROTOCOL', supported: { min: 2, max: 2 }, message: 'The isolated development bridge requires protocol 2.' });
        connection.open = false; socket.end(); return;
      }
      return protocol?.receive(message);
    }, initial);
    socket.setTimeout(0);
    socket.once('close', () => {
      connection.open = false; disconnectProvider(connection); protocol?.dispose();
      connection.binding?.detach(); connections.delete(connection); remote.clients.delete(connection);
    });
    if (!remote.seat(connection)) return;
    const context = { authenticated: true, principal: 'local-client:' + enrollment.id,
      role: connection.wants ? 'conversation' : 'fleet', target: connection.wants ? 'session:' + connection.wants : 'fleet',
      seat: { id: enrollment.id, control: true, local: true, editor: enrollment.kind === 'editor' } };
    protocol = currentState.createSocket({ client: connection, server: remote, hub: connection.hub,
      context, testOnlyV2: true, caps: remote.applicationProtocol.caps, engine: engineInfo,
      post: connection.post.bind(connection), close: () => connection.close() });
    connection.post({ type: '@welcome', ...protocol.advertisement, device: connection.device });
  }
  return { enroll, connect, localContext,
    localRequest(request) {
      return management().dispatch(localContext(request), request.request);
    },
    revoke(id) { for (const c of connections) if (c.enrollment.id === id) c.close(); },
    providers: () => [...providers.values()],
    projects: () => [...new Set([...providers.values()].flatMap((p) => p.workspaces.filter((uri) => uri.startsWith('file:')).map(fileURLToPath)))],
    status: () => ({ connected: connections.size, editors: providers.size, pendingEditorRequests: pending.size }),
    dispose() { active = false; for (const c of connections) c.close(); for (const p of providers.values()) p.connected = false; providers.clear(); }
  };
}

async function openDevelopmentClient({ root, secrets, target = null, provider = false, onMessage = () => {}, onClose = () => {} }) {
  const paths = privateRoot(root, { create: false });
  if (!secrets || typeof secrets.get !== 'function' || typeof secrets.store !== 'function') throw fail('SECRET_STORAGE_REQUIRED');
  const status = await controlRequest(paths, { op: 'status' });
  if (!status.ok || status.mode !== 'isolated-p1' || status.root !== paths.root) throw fail('ISOLATED_DAEMON_REQUIRED');
  const secretName = 'nikui.isolatedDevelopment.' + crypto.createHash('sha256').update(paths.root).digest('hex');
  let stored;
  try { const value = await secrets.get(secretName); stored = value ? JSON.parse(value) : null; }
  catch (_) { throw fail('ENROLLMENT_INVALID'); }
  const enrollment = await controlRequest(paths, { op: 'enroll', kind: 'editor', ...(stored ? { id: stored.id, key: stored.key } : {}) });
  if (!enrollment.ok || enrollment.mode !== 'isolated-p1' || stored &&
    (stored.engineId !== enrollment.engineId || stored.hostFingerprint !== enrollment.hostFingerprint)) throw fail('ENROLLMENT_INVALID');
  // A failed SecretStorage write never opens a connection with a memory key.
  await secrets.store(secretName, JSON.stringify(enrollment));
  privateFile(paths.socket, { socket: true });
  const socket = net.createConnection({ path: paths.socket });
  const channel = lineChannel(socket, onMessage);
  socket.once('close', onClose);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  channel.send({ op: 'connect', id: enrollment.id, key: enrollment.key, target, provider });
  return { enrollment, send: channel.send, close: () => socket.destroy(), socket };
}

module.exports = { METHODS, CORE, createDevelopmentBridge, openDevelopmentClient };
