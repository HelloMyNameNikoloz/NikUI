'use strict';
const crypto = require('crypto');
const wire = require('../src/wire.js');
const { maskedFrame } = require('./helpers/ws.js');

function reader(opts) {
  const seen = { messages: [], pings: [], pongs: [], closed: null, failed: null };
  const framer = new wire.Framer(Object.assign({
    onMessage: (text) => seen.messages.push(text),
    onPing: (p) => seen.pings.push(p),
    onPong: (p) => seen.pongs.push(p),
    onClose: (code, reason) => { seen.closed = { code, reason }; },
    onFail: (code, why) => { seen.failed = { code, why }; }
  }, opts || {}));
  return { framer, seen };
}

/** A client frame, built by hand so the reader is tested against the spec. */
function frame(opcode, payload, opts) {
  const o = opts || {};
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
  const mask = o.masked === false ? null : crypto.randomBytes(4);
  const len = body.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (o.fin === false ? 0 : 0x80) | (o.rsv ? 0x40 : 0) | opcode;
  if (!mask) return Buffer.concat([header, body]);
  header[1] |= 0x80;
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

module.exports = async function () {
  suite('the handshake');

  // Checking this constant against a constant written here would only check
  // that the same hand typed both — which is exactly how it was wrong the first
  // time. What proves it is a client nobody here wrote accepting the answer:
  // test/remote.test.js connects with Node's own WebSocket, and
  // test/remote.check.js with a browser's. This only pins the shape.
  checkEqual('the accept value is the key and the magic string, hashed',
    wire.accept('dGhlIHNhbXBsZSBub25jZQ=='),
    crypto.createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==' + wire.GUID).digest('base64'));
  check('and the magic string is a GUID of the right shape',
    /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(wire.GUID));

  suite('reading what a client sends');

  const one = reader();
  one.framer.push(frame(wire.OP.TEXT, '{"type":"ready"}'));
  checkEqual('a whole frame is a whole message', one.seen.messages, ['{"type":"ready"}']);

  const split = reader();
  const whole = frame(wire.OP.TEXT, 'hello there');
  for (const byte of whole) split.framer.push(Buffer.from([byte]));
  checkEqual('a frame arriving one byte at a time is still one message',
    split.seen.messages, ['hello there']);

  const two = reader();
  two.framer.push(Buffer.concat([frame(wire.OP.TEXT, 'one'), frame(wire.OP.TEXT, 'two')]));
  checkEqual('two frames in one chunk are two messages', two.seen.messages, ['one', 'two']);

  const long = reader();
  const big = 'x'.repeat(70000);
  long.framer.push(frame(wire.OP.TEXT, big));
  checkEqual('a payload past 64k reads its 64-bit length', long.seen.messages[0].length, 70000);

  const medium = reader();
  medium.framer.push(frame(wire.OP.TEXT, 'y'.repeat(300)));
  checkEqual('and one past 125 reads its 16-bit length', medium.seen.messages[0].length, 300);

  const parts = reader();
  parts.framer.push(frame(wire.OP.TEXT, 'half a ', { fin: false }));
  parts.framer.push(frame(wire.OP.CONT, 'message', { fin: true }));
  checkEqual('a fragmented message is joined back together', parts.seen.messages, ['half a message']);

  const between = reader();
  between.framer.push(frame(wire.OP.TEXT, 'a', { fin: false }));
  between.framer.push(frame(wire.OP.PING, 'still there?'));
  between.framer.push(frame(wire.OP.CONT, 'b', { fin: true }));
  checkEqual('a ping in the middle of one is answered, not swallowed',
    [between.seen.pings.length, between.seen.messages], [1, ['ab']]);

  const utf = reader();
  utf.framer.push(frame(wire.OP.TEXT, Buffer.from('héllo ✅', 'utf8')));
  checkEqual('text comes back as text', utf.seen.messages, ['héllo ✅']);

  suite('and what it must not');

  const bare = reader();
  bare.framer.push(frame(wire.OP.TEXT, 'unmasked', { masked: false }));
  checkEqual('an unmasked frame is a protocol error', bare.seen.failed.code, wire.CLOSE.PROTOCOL);

  const reserved = reader();
  reserved.framer.push(frame(wire.OP.TEXT, 'x', { rsv: true }));
  checkEqual('so is a reserved bit nobody negotiated', reserved.seen.failed.code, wire.CLOSE.PROTOCOL);

  const binary = reader();
  binary.framer.push(frame(wire.OP.BINARY, Buffer.from([1, 2, 3])));
  checkEqual('binary is refused rather than guessed at', binary.seen.failed.code, wire.CLOSE.UNSUPPORTED);

  const fragmentedPing = reader();
  fragmentedPing.framer.push(frame(wire.OP.PING, 'x', { fin: false }));
  checkEqual('a fragmented control frame is refused', fragmentedPing.seen.failed.code, wire.CLOSE.PROTOCOL);

  const fatPing = reader();
  fatPing.framer.push(frame(wire.OP.PING, 'x'.repeat(200)));
  checkEqual('and an oversized one', fatPing.seen.failed.code, wire.CLOSE.PROTOCOL);

  const stray = reader();
  stray.framer.push(frame(wire.OP.CONT, 'nothing started this'));
  checkEqual('a continuation with nothing to continue is refused', stray.seen.failed.code, wire.CLOSE.PROTOCOL);

  const interleaved = reader();
  interleaved.framer.push(frame(wire.OP.TEXT, 'one', { fin: false }));
  interleaved.framer.push(frame(wire.OP.TEXT, 'two'));
  checkEqual('so is a second message on top of an unfinished one',
    interleaved.seen.failed.code, wire.CLOSE.PROTOCOL);

  const huge = reader({ maxMessageBytes: 64 });
  huge.framer.push(frame(wire.OP.TEXT, 'z'.repeat(200)));
  checkEqual('a message past the ceiling is refused, not buffered', huge.seen.failed.code, wire.CLOSE.TOO_BIG);

  const creeping = reader({ maxMessageBytes: 64 });
  creeping.framer.push(frame(wire.OP.TEXT, 'z'.repeat(40), { fin: false }));
  creeping.framer.push(frame(wire.OP.CONT, 'z'.repeat(40), { fin: true }));
  checkEqual('and so is one that only gets there in fragments',
    creeping.seen.failed.code, wire.CLOSE.TOO_BIG);

  const nonsense = reader();
  nonsense.framer.push(frame(wire.OP.TEXT, Buffer.from([0xc3, 0x28])));
  checkEqual('bytes that are not UTF-8 are refused', nonsense.seen.failed.code, wire.CLOSE.BAD_DATA);

  const unknown = reader();
  unknown.framer.push(frame(0x3, 'from the future'));
  checkEqual('an opcode nobody has heard of is refused', unknown.seen.failed.code, wire.CLOSE.PROTOCOL);

  const bye = reader();
  bye.framer.push(frame(wire.OP.CLOSE, Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(1000, 0); return b; })(),
    Buffer.from('done', 'utf8')
  ])));
  checkEqual('a close frame carries its code and its reason', bye.seen.closed, { code: 1000, reason: 'done' });

  const after = reader();
  after.framer.push(frame(wire.OP.TEXT, 'x', { masked: false }));
  after.framer.push(frame(wire.OP.TEXT, 'and another'));
  checkEqual('nothing is read after a protocol error', after.seen.messages, []);

  suite('writing what the server says');

  const short = wire.encodeText('hi');
  checkEqual('a short frame is FIN plus text, unmasked', [short[0], short[1]], [0x81, 2]);
  const mid = wire.encodeText('y'.repeat(300));
  checkEqual('a longer one says 126 and a 16-bit length', [mid[1], mid.readUInt16BE(2)], [126, 300]);
  const vast = wire.encodeText('y'.repeat(70000));
  checkEqual('a vast one says 127 and a 64-bit length',
    [vast[1], Number(vast.readBigUInt64BE(2))], [127, 70000]);
  const shut = wire.encodeClose(wire.CLOSE.POLICY, 'because');
  checkEqual('a close frame carries the code first',
    [shut[0], shut.readUInt16BE(2), shut.slice(4).toString()], [0x88, 1008, 'because']);
  check('a close reason too long to fit is cut, not dropped',
    wire.encodeClose(1000, 'z'.repeat(400)).length < 130);

  suite('the two halves agree');

  // The client helper masks the way a browser does; the server's reader is the
  // one under test. This is the only pairing that matters in production.
  const round = reader();
  round.framer.push(maskedFrame(wire.OP.TEXT, JSON.stringify({ type: 'send', text: 'ünïcødé' })));
  checkEqual('what a masking client writes is what the server reads',
    JSON.parse(round.seen.messages[0]).text, 'ünïcødé');
};
