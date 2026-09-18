#!/usr/bin/env node
'use strict';

// The home-screen icons, drawn rather than dragged in from somewhere.
//
//   node tools/icons.js
//
// Kept in the repo so the icons can be regenerated and argued with, rather
// than being binaries nobody can edit. Run it after changing anything here and
// commit what comes out.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'media', 'icons');

// NikUI's own palette: the near-black of the editor, and the status colours
// that mean idle, working and done everywhere else in the product.
const FIELD = [23, 23, 26];
const BARS = [
  { colour: [48, 209, 88], width: 0.62 },   // green   · done
  { colour: [255, 159, 10], width: 0.86 },  // orange  · working
  { colour: [142, 142, 147], width: 0.44 }  // grey    · idle
];

/** Anti-aliasing by drawing big and averaging down. */
const SUPER = 4;

/**
 * @param {number} size
 * @param {{padding: number, rounded: boolean, opaque: boolean, mono?: boolean}} how
 *   `mono` is the status-bar form: Android throws away every colour in a
 *   notification icon and keeps only the alpha, so the three bars are drawn
 *   white on nothing. Drawn here rather than hand-traced, so it stays the same
 *   mark as everything else when the mark changes.
 */
function draw(size, { padding, rounded, opaque, mono }) {
  const big = size * SUPER;
  const pixels = new Uint8Array(big * big * 4);

  const inset = big * padding;
  const span = big - inset * 2;
  const radius = rounded ? span * 0.22 : 0;

  // The field, unless there is not one: a status icon is the mark alone.
  if (!mono) {
    for (let y = 0; y < big; y++) {
      for (let x = 0; x < big; x++) {
        const inside = opaque || insideRoundedRect(x, y, inset, inset, span, span, radius);
        const at = (y * big + x) * 4;
        pixels[at] = FIELD[0];
        pixels[at + 1] = FIELD[1];
        pixels[at + 2] = FIELD[2];
        pixels[at + 3] = inside ? 255 : 0;
      }
    }
  }

  // Three bars: a fleet, with states.
  const barHeight = span * 0.115;
  const gap = span * 0.085;
  const block = BARS.length * barHeight + (BARS.length - 1) * gap;
  const left = inset + span * 0.19;
  let top = inset + (span - block) / 2;

  for (const bar of BARS) {
    const width = span * 0.62 * bar.width + span * 0.14;
    for (let y = Math.floor(top); y < Math.ceil(top + barHeight); y++) {
      for (let x = Math.floor(left); x < Math.ceil(left + width); x++) {
        if (!insideRoundedRect(x, y, left, top, width, barHeight, barHeight / 2)) continue;
        const at = (y * big + x) * 4;
        pixels[at] = mono ? 255 : bar.colour[0];
        pixels[at + 1] = mono ? 255 : bar.colour[1];
        pixels[at + 2] = mono ? 255 : bar.colour[2];
        pixels[at + 3] = 255;
      }
    }
    top += barHeight + gap;
  }

  return downsample(pixels, big, size);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  if (x < left || y < top || x >= left + width || y >= top + height) return false;
  if (!radius) return true;
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius - 1));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius - 1));
  return dx * dx + dy * dy <= radius * radius;
}

function downsample(pixels, big, size) {
  const out = Buffer.alloc(size * size * 4);
  const cells = SUPER * SUPER;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          const at = ((y * SUPER + sy) * big + (x * SUPER + sx)) * 4;
          const alpha = pixels[at + 3] / 255;
          r += pixels[at] * alpha;
          g += pixels[at + 1] * alpha;
          b += pixels[at + 2] * alpha;
          a += pixels[at + 3];
        }
      }
      const alpha = a / cells;
      const scale = alpha > 0 ? 255 / alpha : 0;
      const at = (y * size + x) * 4;
      out[at] = Math.round(Math.min(255, (r / cells) * scale));
      out[at + 1] = Math.round(Math.min(255, (g / cells) * scale));
      out[at + 2] = Math.round(Math.min(255, (b / cells) * scale));
      out[at + 3] = Math.round(alpha);
    }
  }
  return out;
}

function png(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function chunk(type, body) {
  const out = Buffer.alloc(8 + body.length + 4);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) >>> 0, 8 + body.length);
  return out;
}

const icons = [
  // The ordinary icon, with its own rounded corners.
  { file: 'nikui-192.png', size: 192, padding: 0, rounded: true, opaque: false },
  { file: 'nikui-512.png', size: 512, padding: 0, rounded: true, opaque: false },
  // Maskable: the platform crops it to whatever shape it likes, so everything
  // that matters sits inside the middle 80%.
  { file: 'nikui-maskable-512.png', size: 512, padding: 0.1, rounded: false, opaque: true },
  // iOS does not round what it is given unless it is opaque and square.
  { file: 'apple-touch-icon-180.png', size: 180, padding: 0, rounded: false, opaque: true },
  // The status bar: white on nothing, with room around it, because Android
  // draws this small and crops nothing.
  { file: 'nikui-status-96.png', size: 96, padding: 0.12, rounded: false, opaque: false, mono: true }
];

fs.mkdirSync(OUT, { recursive: true });
for (const icon of icons) {
  const pixels = draw(icon.size, icon);
  const file = path.join(OUT, icon.file);
  fs.writeFileSync(file, png(pixels, icon.size));
  console.log('wrote ' + path.relative(path.join(__dirname, '..'), file) + '  ' + icon.size + '×' + icon.size);
}
