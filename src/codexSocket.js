'use strict';

// Codex's background app-server (`codex app-server --listen unix://
// --managed-daemon`) takes clients on a unix socket, speaking WebSocket. A
// conversation it has open can only be written through it, so NikUI talks to
// it there: the same JSON-RPC as over stdio, one message per text frame.
//
// A small WebSocket client of our own, since NikUI has no dependencies: text
// frames, fragments, ping and close. Enough for this socket, not for the web.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

/** The daemon's sockets, newest first. Not every one answers; see `connect`. */
function daemonSockets() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dirs = [path.join('/private/tmp', 'codex-daemon-' + uid), path.join(os.tmpdir(), 'codex-daemon-' + uid)];
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!/^[0-9a-f]{16,}$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isSocket() && !found.some((f) => f.file === file)) found.push({ file, at: stat.mtimeMs });
      } catch (_) { /* gone */ }
    }
  }
  return found.sort((a, b) => b.at - a.at).map((f) => f.file);
}

const SEND_PIECE = 1024 * 1024;

/** The whole size of the frame at the start of `buf`, or null if its header is not all there. */
function frameSize(buf) {
  if (buf.length < 2) return null;
  const masked = buf[1] & 0x80 ? 4 : 0;
  const len = buf[1] & 0x7f;
  if (len === 126) return buf.length < 4 ? null : 4 + masked + buf.readUInt16BE(2);
  if (len === 127) return buf.length < 10 ? null : 10 + masked + Number(buf.readBigUInt64BE(2));
  return 2 + masked + len;
}

class WsSocket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.open = true;
    // Bytes waiting to make a whole frame, kept as they came: joining them on
    // every chunk would copy a hundred-megabyte reply thousands of times.
    this._chunks = [];
    this._have = 0;
    this._need = 2;
    this._parts = [];
    sock.on('data', (chunk) => this._read(chunk));
    sock.on('close', () => this._gone());
    sock.on('error', (err) => this._gone(err));
  }

  _gone(err) {
    if (!this.open) return;
    this.open = false;
    this.emit('close', err);
  }

  _read(chunk) {
    this._chunks.push(chunk);
    this._have += chunk.length;
    if (this._have < this._need) return;
    let buf = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks);
    this._chunks = [];
    this._have = 0;
    for (;;) {
      const need = frameSize(buf);
      if (need === null || buf.length < need) {
        // Not a whole frame yet: wait until there are enough bytes for one.
        this._need = need === null ? Math.max(buf.length + 1, 2) : need;
        if (buf.length) { this._chunks.push(buf); this._have = buf.length; }
        return;
      }
      this._frameIn(buf.subarray(0, need));
      if (!this.open) return;
      buf = buf.subarray(need);
    }
  }

  _frameIn(frame) {
    const b0 = frame[0];
    const b1 = frame[1];
    let len = b1 & 0x7f;
    let at = 2;
    if (len === 126) { len = frame.readUInt16BE(2); at = 4; }
    else if (len === 127) { len = Number(frame.readBigUInt64BE(2)); at = 10; }
    const masked = b1 & 0x80;
    let body;
    if (masked) {
      const mask = frame.subarray(at, at + 4);
      body = Buffer.from(frame.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    } else {
      body = frame.subarray(at, at + len);
    }
    const op = b0 & 0x0f;
    if (op === 0x8) { this.close(); return; }
    if (op === 0x9) { this._frame(0xa, body); return; }
    if (op === 0xa) return;
    this._parts.push(body);
    if (b0 & 0x80) {
      const text = (this._parts.length === 1 ? this._parts[0] : Buffer.concat(this._parts)).toString('utf8');
      this._parts = [];
      this.emit('message', text);
    }
  }

  _frame(op, payload, fin) {
    if (!this.open) return false;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const mask = crypto.randomBytes(4);
    let head;
    if (body.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | body.length; }
    else if (body.length < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(body.length, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
    head[0] = (fin === false ? 0 : 0x80) | op;
    const out = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i++) out[i] = body[i] ^ mask[i & 3];
    return this.sock.write(Buffer.concat([head, mask, out]));
  }

  /** A text message, in pieces if it is big (the daemon takes 16 MB in one). */
  send(text) {
    const body = Buffer.from(String(text), 'utf8');
    if (body.length <= SEND_PIECE) return this._frame(0x1, body);
    let ok = true;
    for (let at = 0; at < body.length; at += SEND_PIECE) {
      const last = at + SEND_PIECE >= body.length;
      ok = this._frame(at === 0 ? 0x1 : 0x0, body.subarray(at, at + SEND_PIECE), last) && ok;
    }
    return ok;
  }

  close() {
    if (this.open) { try { this._frame(0x8, Buffer.alloc(0)); } catch (_) { /* closing anyway */ } }
    this.sock.destroy();
    this._gone();
  }
}

/** A WebSocket over a unix socket, or an error if nothing there speaks it. */
function connectWs(file, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(file);
    const key = crypto.randomBytes(16).toString('base64');
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('no answer on ' + file)); }, timeoutMs || 3000);
    const fail = (err) => { clearTimeout(timer); sock.destroy(); reject(err); };
    sock.on('error', fail);
    sock.on('close', () => fail(new Error('closed by ' + file)));
    sock.on('connect', () => {
      sock.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.removeListener('data', onData);
      sock.removeAllListeners('error');
      sock.removeAllListeners('close');
      clearTimeout(timer);
      const status = head.subarray(0, end).toString('latin1');
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (!/^HTTP\/1\.1 101/.test(status) || status.toLowerCase().indexOf(accept.toLowerCase()) < 0) {
        sock.destroy();
        reject(new Error('not a WebSocket at ' + file));
        return;
      }
      const ws = new WsSocket(sock);
      const rest = head.subarray(end + 4);
      if (rest.length) ws._read(rest);
      resolve(ws);
    };
    sock.on('data', onData);
  });
}

/**
 * A stand-in for a spawned `codex app-server`, carried over the daemon's
 * socket: stdin and stdout of newline-separated JSON, as CodexClient expects.
 */
function daemonProcess(ws) {
  const { PassThrough } = require('stream');
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = null;
  proc.viaDaemon = true;
  let buf = '';
  proc.stdin.on('data', (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (line.trim()) ws.send(line);
    }
  });
  ws.on('message', (text) => proc.stdout.write(text + '\n'));
  ws.on('close', () => proc.emit('exit', null, null));
  proc.kill = () => ws.close();
  return proc;
}

module.exports = { connectWs, daemonSockets, daemonProcess, WsSocket };
