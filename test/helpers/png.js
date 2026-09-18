'use strict';

// A one-bit-per-module QR, written out as a PNG so a real decoder can read it.
// Only used by test/qr.check.js; nothing ships with it.

const zlib = require('zlib');

function chunk(type, body) {
  const out = Buffer.alloc(8 + body.length + 4);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) >>> 0, 8 + body.length);
  return out;
}

/** @param {{size:number, at:(r:number,c:number)=>boolean}} code */
function qrToPng(code, options) {
  const o = options || {};
  const scale = o.scale || 8;
  const quiet = o.quiet == null ? 4 : o.quiet;
  const span = (code.size + quiet * 2) * scale;

  const raw = Buffer.alloc((span + 1) * span, 0xff);
  for (let y = 0; y < span; y++) {
    raw[y * (span + 1)] = 0; // filter: none
    const row = Math.floor(y / scale) - quiet;
    for (let x = 0; x < span; x++) {
      const col = Math.floor(x / scale) - quiet;
      const dark = row >= 0 && col >= 0 && row < code.size && col < code.size && code.at(row, col);
      raw[y * (span + 1) + 1 + x] = dark ? 0x00 : 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(span, 0);
  ihdr.writeUInt32BE(span, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { qrToPng };
