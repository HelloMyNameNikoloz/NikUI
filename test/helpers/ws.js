'use strict';

// A WebSocket client, so the suite can knock on the server the way a browser
// does. Deliberately separate from src/wire.js: the server never masks a frame,
// and a client must mask every one, so the test half is the half that proves
// the server's reader handles masking rather than trusting its own encoder.

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const wire = require('../../src/wire.js');

function maskedFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Connects, or rejects with the status the server refused it with.
 * @returns {Promise<Client>}
 */
function connect(url, options) {
  const opts = options || {};
  const at = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: at.hostname,
      port: at.port,
      path: at.pathname + at.search,
      headers: Object.assign({
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13'
      }, opts.headers || {})
    });

    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== wire.accept(key)) {
        socket.destroy();
        return reject(new Error('the server got the handshake wrong'));
      }
      resolve(new Client(socket, head));
    });
    req.on('response', (res) => {
      res.resume();
      const err = new Error('refused with ' + res.statusCode);
      err.status = res.statusCode;
      reject(err);
    });
    req.on('error', reject);
    req.end();
  });
}

class Client extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.messages = [];
    this.closed = null;
    this.framer = new wire.Framer({
      onMessage: (text) => {
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (_) { /* leave it as text */ }
        this.messages.push(parsed);
        this.emit('message', parsed);
      },
      onPing: (payload) => this.raw(wire.OP.PONG, payload),
      onClose: (code, reason) => { this.closed = { code, reason }; this.emit('closed', this.closed); }
    });
    // The server's frames are unmasked; the shared reader insists on a mask, so
    // this side reads them itself.
    this.socket.on('data', (chunk) => this.read(chunk));
    this.socket.on('close', () => { if (!this.closed) { this.closed = { code: 1006, reason: 'dropped' }; } this.emit('gone'); });
    if (head && head.length) this.read(head);
  }

  read(chunk) {
    this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      let length = this.buffer[1] & 0x7f;
      let at = 2;
      if (length === 126) { length = this.buffer.readUInt16BE(2); at = 4; }
      else if (length === 127) { length = Number(this.buffer.readBigUInt64BE(2)); at = 10; }
      if (this.buffer.length < at + length) return;
      const payload = this.buffer.slice(at, at + length);
      this.buffer = this.buffer.slice(at + length);
      if (opcode === wire.OP.TEXT) {
        const text = payload.toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (_) { /* leave it */ }
        this.messages.push(parsed);
        this.emit('message', parsed);
      } else if (opcode === wire.OP.PING) {
        this.raw(wire.OP.PONG, payload);
      } else if (opcode === wire.OP.CLOSE) {
        this.closed = {
          code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
          reason: payload.length > 2 ? payload.slice(2).toString('utf8') : ''
        };
        this.emit('closed', this.closed);
      }
    }
  }

  raw(opcode, payload) {
    if (this.socket.writable) this.socket.write(maskedFrame(opcode, payload || Buffer.alloc(0)));
  }

  send(message) {
    this.raw(wire.OP.TEXT, typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** Every frame exactly as given — for the tests that break the rules on purpose. */
  writeRaw(buffer) {
    if (this.socket.writable) this.socket.write(buffer);
  }

  close(code) {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code || 1000, 0);
    this.raw(wire.OP.CLOSE, body);
    this.socket.end();
  }

  destroy() {
    this.socket.destroy();
  }

  /** The first message of a type, waiting up to `ms` for it to arrive. */
  waitFor(type, ms) {
    const already = this.messages.find((m) => m && m.type === type);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('message', onMessage);
        reject(new Error('no ' + type + ' within ' + (ms || 2000) + 'ms'));
      }, ms || 2000);
      const onMessage = (m) => {
        if (!m || m.type !== type) return;
        clearTimeout(timer);
        this.removeListener('message', onMessage);
        resolve(m);
      };
      this.on('message', onMessage);
    });
  }

  /** The next message of a type, ignoring anything that has already arrived. */
  next(type, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('message', onMessage);
        reject(new Error('no further ' + type + ' within ' + (ms || 2000) + 'ms'));
      }, ms || 2000);
      const onMessage = (m) => {
        if (!m || m.type !== type) return;
        clearTimeout(timer);
        this.removeListener('message', onMessage);
        resolve(m);
      };
      this.on('message', onMessage);
    });
  }

  /** The next message that satisfies a predicate — for protocols keyed on an id. */
  waitWhere(matches, ms) {
    const already = this.messages.find(matches);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('message', onMessage);
        reject(new Error('nothing matched within ' + (ms || 5000) + 'ms'));
      }, ms || 5000);
      const onMessage = (m) => {
        if (!matches(m)) return;
        clearTimeout(timer);
        this.removeListener('message', onMessage);
        resolve(m);
      };
      this.on('message', onMessage);
    });
  }

  waitClosed(ms) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('it never closed')), ms || 2000);
      this.once('closed', (c) => { clearTimeout(timer); resolve(c); });
      this.once('gone', () => { clearTimeout(timer); resolve(this.closed); });
    });
  }
}

module.exports = { connect, maskedFrame, Client };
