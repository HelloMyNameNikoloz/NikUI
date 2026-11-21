'use strict';

// Codex's daemon speaks WebSocket on a unix socket. A small server here plays
// it: the handshake, a reply too big for one frame, and our own big message
// arriving in pieces.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { connectWs, daemonProcess } = require('../src/codexSocket.js');
const { CodexClient } = require('../src/codex.js');

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));

/** Server frames: unmasked, split into `pieces` fragments. */
function serverFrames(text, pieces) {
  const body = Buffer.from(text, 'utf8');
  const size = Math.ceil(body.length / pieces);
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const part = body.subarray(i * size, (i + 1) * size);
    const op = i === 0 ? 0x1 : 0x0;
    const fin = i === pieces - 1 ? 0x80 : 0;
    let head;
    if (part.length < 126) head = Buffer.from([fin | op, part.length]);
    else if (part.length < 65536) { head = Buffer.alloc(4); head[0] = fin | op; head[1] = 126; head.writeUInt16BE(part.length, 2); }
    else { head = Buffer.alloc(10); head[0] = fin | op; head[1] = 127; head.writeBigUInt64BE(BigInt(part.length), 2); }
    out.push(head, part);
  }
  return Buffer.concat(out);
}

/** Read masked client frames back into whole messages. */
function clientReader(onMessage) {
  let buf = Buffer.alloc(0);
  let parts = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const body = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      buf = buf.subarray(at + 4 + len);
      if (op === 0x8) continue;
      parts.push(body);
      if (fin) { onMessage(Buffer.concat(parts).toString('utf8'), parts.length); parts = []; }
    }
  };
}

module.exports = async function () {
  suite('the Codex daemon, over its WebSocket');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikws-'));
  const file = path.join(dir, 'd.sock');
  const heard = [];
  const big = 'x'.repeat(300 * 1024);
  const server = net.createServer((conn) => {
    let upgraded = false;
    let head = '';
    const read = clientReader((text, pieces) => {
      heard.push({ text, pieces });
      const msg = JSON.parse(text);
      if (msg.id == null) return;
      const result = msg.method === 'initialize' ? { userAgent: 'daemon' } : { echo: msg.params.text ? msg.params.text.length : 0, big };
      conn.write(serverFrames(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), msg.method === 'initialize' ? 1 : 3));
    });
    conn.on('data', (chunk) => {
      if (upgraded) { read(chunk); return; }
      head += chunk;
      if (head.indexOf('\r\n\r\n') < 0) return;
      const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(head)[1].trim();
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      conn.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      upgraded = true;
    });
  });
  await new Promise((r) => server.listen(file, r));

  const client = new CodexClient({ codexPath: '/fake/codex', daemonFn: async () => daemonProcess(await connectWs(file)), spawnFn: () => { throw new Error('should not spawn'); } });
  const info = await client.start();
  check('it connects and introduces itself through the daemon', info.userAgent === 'daemon' && client.viaDaemon);
  const reply = await client.request('echo', { text: 'y'.repeat(2.5 * 1024 * 1024) });
  checkEqual('a reply in several frames arrives whole', reply.big.length, big.length);
  checkEqual('a big message of ours goes in pieces and arrives whole', reply.echo, 2.5 * 1024 * 1024);
  check('in more than one frame', heard.some((h) => h.pieces > 1));

  let refused = null;
  try { await connectWs(path.join(dir, 'none.sock')); } catch (err) { refused = err; }
  check('nothing listening is an error, not a hang', !!refused);

  const fallback = new CodexClient({ codexPath: '/fake/codex', daemonFn: async () => null,
    spawnFn: () => { throw new Error('spawned'); } });
  let spawned = null;
  try { await fallback.start(); } catch (err) { spawned = err.message; }
  checkEqual('without a daemon, Codex is started as before', spawned, 'spawned');

  client.dispose();
  await tick(20);
  server.close();
};
