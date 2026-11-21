'use strict';

// The ChatGPT app's own channel between its windows and editors: a unix socket
// under ~/.codex/ipc. A conversation open in the app can only be written by
// the app, so NikUI joins that channel as a follower and asks the app to send
// for it — the way the OpenAI VS Code extension does.
//
// Frames are a little-endian uint32 length, then that many bytes of JSON. The
// app routes each request to the client that can handle it; we only ever ask,
// and say no to anything asked of us.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// Each method has a version the owner must agree with exactly.
const VERSIONS = {
  'initialize': 0,
  'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-interrupt-turn': 4
};

const MAX_FRAME = 256 * 1024 * 1024;

function socketPath() {
  const home = path.join(os.homedir(), '.codex', 'ipc', 'ipc.sock');
  if (fs.existsSync(home)) return home;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), 'codex-ipc', `ipc-${uid}.sock`);
}

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

class CodexIpc extends EventEmitter {
  constructor({ sockPath, connectFn, log } = {}) {
    super();
    this.sockPath = sockPath || null;
    this.connectFn = connectFn || ((p) => net.createConnection(p));
    this.log = log || (() => {});
    this.sock = null;
    this.clientId = null;
    this._ready = null;
    this._pending = new Map();
    this._buf = Buffer.alloc(0);
    this._owners = new Map(); // threadId -> {owner, at}
    this._disposed = false;
  }

  get available() {
    return fs.existsSync(this.sockPath || socketPath());
  }

  /** Connected and introduced; later calls share the one connection. */
  connect() {
    if (this._disposed) return Promise.reject(Object.assign(new Error('Codex IPC is closed'), { delivery: 'not_written' }));
    if (this._ready) return this._ready;
    this._ready = new Promise((resolve, reject) => {
      const sock = this.connectFn(this.sockPath || socketPath());
      this.sock = sock;
      sock.on('data', (chunk) => { if (this.sock === sock) this._read(chunk); });
      sock.on('error', (err) => { this.log('codex ipc: ' + err.message); if (this.sock === sock) this._closed(err); reject(err); });
      sock.on('close', () => { if (this.sock === sock) this._closed(new Error('the ChatGPT app closed the connection')); });
      sock.on('connect', () => {
        this._send({ type: 'request', requestId: crypto.randomUUID(), sourceClientId: 'initializing-client',
          version: 0, method: 'initialize', params: { clientType: 'nikui' } }, 5000)
          .then((res) => { this.clientId = res.clientId; resolve(this); }, reject);
      });
    });
    this._ready.catch(() => {});
    return this._ready;
  }

  _closed(err) {
    const connection = this.sock;
    this.sock = null;
    this.clientId = null;
    this._ready = null;
    this._buf = Buffer.alloc(0);
    this._owners.clear();
    for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error(err.message), { delivery: 'unknown' })); }
    this._pending.clear();
    if (connection) this.emit('exit', connection);
  }

  _read(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 4) {
      const n = this._buf.readUInt32LE(0);
      if (n === 0 || n > MAX_FRAME) { if (this.sock) this.sock.destroy(); return; }
      if (this._buf.length < 4 + n) return;
      const body = this._buf.subarray(4, 4 + n).toString('utf8');
      this._buf = this._buf.subarray(4 + n);
      let msg;
      try { msg = JSON.parse(body); } catch (_) { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.type === 'response') {
      const p = this._pending.get(msg.requestId);
      if (!p) return;
      this._pending.delete(msg.requestId);
      clearTimeout(p.timer);
      if (msg.resultType === 'success') p.resolve(Object.assign({}, msg.result, { _from: msg.handledByClientId }));
      else p.reject(Object.assign(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)),
        { delivery: msg.error?.accepted === false ? 'not_written' : 'unknown' }));
    } else if (msg.type === 'client-discovery-request') {
      // Asked whether we can handle someone else's request: we never can.
      this._write({ type: 'client-discovery-response', requestId: msg.requestId, response: { canHandle: false } });
    } else if (msg.type === 'request') {
      if (!this.emit('request', msg)) this.respondError(msg.requestId);
    } else if (msg.type === 'broadcast') {
      if (msg.method === 'client-status-changed' && msg.params && msg.params.status === 'disconnected') {
        for (const [id, o] of this._owners) if (o.owner === msg.params.clientId) this._owners.delete(id);
      }
      this.emit('broadcast', msg);
    }
  }

  _write(obj) {
    if (!this.sock || this.sock.writable === false) throw Object.assign(new Error('Codex IPC is disconnected'), { delivery: 'not_written' });
    this.sock.write(frame(obj));
  }

  _send(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(msg.requestId);
        reject(Object.assign(new Error('the ChatGPT app did not answer'), { delivery: 'unknown' }));
      }, timeoutMs || 15000);
      if (timer.unref) timer.unref();
      this._pending.set(msg.requestId, { resolve, reject, timer });
      try { this._write(msg); }
      catch (error) { clearTimeout(timer); this._pending.delete(msg.requestId); reject(error); }
    });
  }

  async request(method, params, { target, timeoutMs, version, beforeWrite } = {}) {
    try { await this.connect(); }
    catch (error) { throw Object.assign(error, { delivery: 'not_written' }); }
    const msg = { type: 'request', requestId: crypto.randomUUID(), sourceClientId: this.clientId,
      version: version != null ? version : VERSIONS[method] || 0, method, params };
    if (target) msg.targetClientId = target;
    if (beforeWrite) beforeWrite();
    return this._send(msg, timeoutMs);
  }

  /** The app client that has this conversation open, or null if none does. */
  async ownerOf(threadId) {
    const known = this._owners.get(threadId);
    if (known && Date.now() - known.at < 60000) return known.owner;
    try {
      const res = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, { timeoutMs: 12000 });
      const owner = res._from || null;
      if (owner) this._owners.set(threadId, { owner, at: Date.now() });
      return owner;
    } catch (_) {
      this._owners.delete(threadId);
      return null;
    }
  }

  /** Ask the app to send a prompt into a conversation it has open. */
  startTurn(owner, threadId, input, clientUserMessageId) {
    return this.request('thread-follower-start-turn', {
      conversationId: threadId,
      turnStart: { request: { threadId, input, clientUserMessageId } }
    }, { target: owner, timeoutMs: 30000 });
  }

  interrupt(owner, threadId, turnId, options = {}) {
    const params = { conversationId: threadId, mode: 'user-stop' };
    if (turnId) params.expectedTurnId = turnId;
    return this.request('thread-follower-interrupt-turn', params, { ...options, target: owner, version: turnId ? 4 : 3 });
  }

  respond(requestId, result, connection = this.sock) {
    if (!connection || connection !== this.sock) return 'not_written';
    try {
      this._write({ type: 'response', requestId, resultType: 'success', result });
      return connection === this.sock && !connection.destroyed ? 'submitted' : 'unknown';
    } catch (error) { return error.delivery === 'not_written' ? 'not_written' : 'unknown'; }
  }

  respondError(requestId) {
    this._write({ type: 'response', requestId, resultType: 'error', error: 'no-handler-for-request' });
  }

  dispose() {
    this._disposed = true;
    if (this.sock) this.sock.destroy();
    this._closed(new Error('closed'));
  }
}

module.exports = { CodexIpc, frame, socketPath };
