'use strict';

const crypto = require('crypto');

/**
 * RFC 6455, the server half of it, in one file with no dependencies.
 *
 * The repo has zero runtime dependencies and that is worth keeping for
 * something this small: a handshake, a frame reader and a frame writer. What is
 * deliberately not here is anything the client does not need — extensions,
 * compression, masked server frames — because every one of those is a code path
 * that would never be exercised and never be right.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL: 1002,
  UNSUPPORTED: 1003,
  BAD_DATA: 1007,
  POLICY: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011
};

// A pasted screenshot arrives as base64 inside a `send`, so the ceiling has to
// clear a photo comfortably while still being a ceiling.
const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;

/** The one value the handshake turns on. */
function accept(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

/** A server frame, never masked, with the payload length written the short way. */
function encode(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN, no reserved bits: no extension is negotiated
  return Buffer.concat([header, body]);
}

const encodeText = (text) => encode(OP.TEXT, Buffer.from(String(text), 'utf8'));
const encodePing = (payload) => encode(OP.PING, payload || Buffer.alloc(0));
const encodePong = (payload) => encode(OP.PONG, payload || Buffer.alloc(0));

function encodeClose(code, reason) {
  const text = Buffer.from(String(reason || ''), 'utf8').slice(0, 123);
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code || CLOSE.NORMAL, 0);
  text.copy(body, 2);
  return encode(OP.CLOSE, body);
}

/** Bytes as they arrive, without copying the whole backlog on every chunk. */
class Bytes {
  constructor() {
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    if (!chunk || !chunk.length) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  /** The first n bytes, left where they are. Only ever used for a 14-byte header. */
  peek(n) {
    if (this.size < n) return null;
    const out = Buffer.alloc(n);
    let at = 0;
    for (const chunk of this.chunks) {
      const take = Math.min(n - at, chunk.length);
      chunk.copy(out, at, 0, take);
      at += take;
      if (at === n) break;
    }
    return out;
  }

  /** The first n bytes, removed. */
  take(n) {
    if (this.size < n) return null;
    const parts = [];
    let need = n;
    while (need > 0) {
      const chunk = this.chunks[0];
      if (chunk.length <= need) {
        parts.push(chunk);
        need -= chunk.length;
        this.chunks.shift();
      } else {
        parts.push(chunk.slice(0, need));
        this.chunks[0] = chunk.slice(need);
        need = 0;
      }
    }
    this.size -= n;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
  }
}

/**
 * Frames in, messages out.
 *
 * Every rule the client could break closes the socket with the code the spec
 * asks for rather than throwing: a browser that gets this wrong is a browser
 * bug, but a script that gets it wrong on purpose must not take the host down.
 */
class Framer {
  constructor(opts) {
    const o = opts || {};
    this.max = o.maxMessageBytes || MAX_MESSAGE_BYTES;
    this.onMessage = o.onMessage || (() => {});
    this.onPing = o.onPing || (() => {});
    this.onPong = o.onPong || (() => {});
    this.onClose = o.onClose || (() => {});
    this.onFail = o.onFail || (() => {});
    this.bytes = new Bytes();
    this.parts = [];      // fragments of the message being assembled
    this.partsSize = 0;
    this.kind = null;     // opcode of the message being assembled
    this.done = false;
  }

  fail(code, why) {
    if (this.done) return;
    this.done = true;
    this.onFail(code, why);
  }

  push(chunk) {
    if (this.done) return;
    this.bytes.push(chunk);
    while (!this.done && this.readFrame()) { /* keep going while whole frames remain */ }
  }

  /** One frame if a whole one is buffered; false when more bytes are needed. */
  readFrame() {
    const head = this.bytes.peek(2);
    if (!head) return false;

    const fin = (head[0] & 0x80) === 0x80;
    const reserved = head[0] & 0x70;
    const opcode = head[0] & 0x0f;
    const masked = (head[1] & 0x80) === 0x80;
    let length = head[1] & 0x7f;
    let headerLen = 2;

    if (reserved) { this.fail(CLOSE.PROTOCOL, 'reserved bits set'); return false; }
    // Every frame from a client is masked. An unmasked one is either a broken
    // client or something pretending to be one.
    if (!masked) { this.fail(CLOSE.PROTOCOL, 'unmasked frame'); return false; }

    if (length === 126) {
      const ext = this.bytes.peek(4);
      if (!ext) return false;
      length = ext.readUInt16BE(2);
      headerLen = 4;
    } else if (length === 127) {
      const ext = this.bytes.peek(10);
      if (!ext) return false;
      const big = ext.readBigUInt64BE(2);
      if (big > BigInt(this.max)) { this.fail(CLOSE.TOO_BIG, 'frame too large'); return false; }
      length = Number(big);
      headerLen = 10;
    }

    const control = opcode >= 0x8;
    if (control && (!fin || length > 125)) {
      this.fail(CLOSE.PROTOCOL, 'fragmented or oversized control frame');
      return false;
    }
    if (length > this.max || this.partsSize + length > this.max) {
      this.fail(CLOSE.TOO_BIG, 'message too large');
      return false;
    }

    const total = headerLen + 4 + length;
    if (this.bytes.size < total) return false;

    this.bytes.take(headerLen);
    const mask = this.bytes.take(4);
    const payload = length ? this.bytes.take(length) : Buffer.alloc(0);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    return this.handle(opcode, fin, payload);
  }

  handle(opcode, fin, payload) {
    switch (opcode) {
      case OP.PING:
        this.onPing(payload);
        return true;
      case OP.PONG:
        this.onPong(payload);
        return true;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.NORMAL;
        this.done = true;
        this.onClose(code, payload.length > 2 ? payload.slice(2).toString('utf8') : '');
        return false;
      }
      case OP.BINARY:
        // The protocol is JSON text. Binary would be a client speaking to
        // something else, so say so rather than guessing at it.
        this.fail(CLOSE.UNSUPPORTED, 'binary frames are not part of this protocol');
        return false;
      case OP.TEXT:
        if (this.kind !== null) { this.fail(CLOSE.PROTOCOL, 'a message was already in progress'); return false; }
        this.kind = OP.TEXT;
        return this.collect(fin, payload);
      case OP.CONT:
        if (this.kind === null) { this.fail(CLOSE.PROTOCOL, 'continuation without a message'); return false; }
        return this.collect(fin, payload);
      default:
        this.fail(CLOSE.PROTOCOL, 'unknown opcode ' + opcode);
        return false;
    }
  }

  collect(fin, payload) {
    this.parts.push(payload);
    this.partsSize += payload.length;
    if (!fin) return true;

    const body = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.partsSize);
    this.parts = [];
    this.partsSize = 0;
    this.kind = null;

    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch (_) {
      this.fail(CLOSE.BAD_DATA, 'not valid UTF-8');
      return false;
    }
    this.onMessage(text);
    return true;
  }
}

module.exports = {
  GUID, OP, CLOSE, MAX_MESSAGE_BYTES,
  accept, encode, encodeText, encodePing, encodePong, encodeClose,
  Bytes, Framer
};
