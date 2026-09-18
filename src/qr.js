'use strict';

/**
 * A QR code, byte mode, error correction level M, versions 1 to 10.
 *
 * Dependency-free like the rest, and — because a protocol constant written from
 * memory has already bitten this repo once — verified by decoding the output
 * with Apple's own detector rather than by agreeing with itself:
 * `node test/qr.check.js` renders every version and reads it back through
 * CoreImage. The golden vectors in test/qr.test.js were produced that way.
 *
 * Level M over L on purpose: this is read off a laptop screen by a phone, at an
 * angle, in whatever light the room has.
 */

// Total codewords, error-correction codewords per block, and the block layout
// for level M. Two groups where the second holds one more data codeword each.
const VERSIONS = [
  //           total  ec/block  g1 blocks  g1 data  g2 blocks  g2 data
  /* 1  */ { total: 26, ec: 10, g1: 1, d1: 16, g2: 0, d2: 0 },
  /* 2  */ { total: 44, ec: 16, g1: 1, d1: 28, g2: 0, d2: 0 },
  /* 3  */ { total: 70, ec: 26, g1: 1, d1: 44, g2: 0, d2: 0 },
  /* 4  */ { total: 100, ec: 18, g1: 2, d1: 32, g2: 0, d2: 0 },
  /* 5  */ { total: 134, ec: 24, g1: 2, d1: 43, g2: 0, d2: 0 },
  /* 6  */ { total: 172, ec: 16, g1: 4, d1: 27, g2: 0, d2: 0 },
  /* 7  */ { total: 196, ec: 18, g1: 4, d1: 31, g2: 0, d2: 0 },
  /* 8  */ { total: 242, ec: 22, g1: 2, d1: 38, g2: 2, d2: 39 },
  /* 9  */ { total: 292, ec: 22, g1: 3, d1: 36, g2: 2, d2: 37 },
  /* 10 */ { total: 346, ec: 26, g1: 4, d1: 43, g2: 1, d2: 44 }
];

// Where the alignment patterns sit, by version. Version 1 has none.
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
];

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0
];

// ---- GF(256), the field the error correction lives in -----------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for n error-correction codewords. */
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      // Descending coefficients: multiplying by x moves a term up one slot,
      // multiplying by the root's value keeps it where it is one place along.
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon remainder: the block's error-correction codewords. */
function remainder(data, ecCount) {
  const gen = generator(ecCount);
  const out = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.shift();
    out.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) out[i] ^= mul(gen[i + 1], factor);
    }
  }
  return out;
}

// ---- bits -------------------------------------------------------------------

class Bits {
  constructor() { this.bits = []; }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length() { return this.bits.length; }
  toCodewords() {
    const bytes = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] || 0);
      bytes.push(byte);
    }
    return bytes;
  }
}

/** BCH(15,5) for the format, BCH(18,6) for the version. */
function bch(value, generatorBits, length) {
  let out = value << (length - 1);
  const top = 1 << (length + generatorBits - 2);
  for (let bit = top; bit >= (1 << (length - 1)); bit >>= 1) {
    if (out & bit) {
      let shift = 0;
      for (let probe = bit; probe > 1; probe >>= 1) shift++;
      out ^= GENERATORS[length] << (shift - (length === 15 ? 10 : 11));
    }
  }
  return out;
}
const GENERATORS = { 15: 0x537, 18: 0x1f25 };

function formatBits(mask) {
  // Level M is 00, then the three mask bits, through BCH, masked with 0x5412
  // so that an all-zero format is not a valid one.
  const value = (0b00 << 3) | mask;
  let out = value << 10;
  for (let i = 4; i >= 0; i--) {
    if (out & (1 << (i + 10))) out ^= GENERATORS[15] << i;
  }
  return ((value << 10) | out) ^ 0x5412;
}

function versionBits(version) {
  let out = version << 12;
  for (let i = 5; i >= 0; i--) {
    if (out & (1 << (i + 12))) out ^= GENERATORS[18] << i;
  }
  return (version << 12) | out;
}

// ---- the code itself --------------------------------------------------------

/** How many data codewords a version holds at level M. */
function capacity(version) {
  const v = VERSIONS[version - 1];
  return v.g1 * v.d1 + v.g2 * v.d2;
}

function pickVersion(byteLength) {
  for (let version = 1; version <= VERSIONS.length; version++) {
    // 4 bits of mode, 8 or 16 of length, then the bytes themselves.
    const header = 4 + (version < 10 ? 8 : 16);
    if (Math.ceil((header + byteLength * 8) / 8) <= capacity(version)) return version;
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{size: number, version: number, at: (row: number, col: number) => boolean, rows: boolean[][]}}
 */
function encode(text, options) {
  const forced = options && typeof options.mask === 'number' ? options.mask : null;
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(bytes.length);
  if (!version) throw new Error('too long for a version 10 QR code: ' + bytes.length + ' bytes');

  const spec = VERSIONS[version - 1];
  const dataCount = capacity(version);

  const bits = new Bits();
  bits.push(0b0100, 4);                              // byte mode
  bits.push(bytes.length, version < 10 ? 8 : 16);    // how many
  for (const byte of bytes) bits.push(byte, 8);
  const room = dataCount * 8;
  bits.push(0, Math.min(4, room - bits.length));     // terminator
  while (bits.length % 8) bits.push(0, 1);
  const codewords = bits.toCodewords();
  for (let pad = 0; codewords.length < dataCount; pad++) codewords.push(pad % 2 ? 0x11 : 0xec);

  // Split into blocks, shortest first, and give each its own check codewords.
  const blocks = [];
  let at = 0;
  for (let i = 0; i < spec.g1; i++) { blocks.push(codewords.slice(at, at + spec.d1)); at += spec.d1; }
  for (let i = 0; i < spec.g2; i++) { blocks.push(codewords.slice(at, at + spec.d2)); at += spec.d2; }
  const checks = blocks.map((block) => remainder(block, spec.ec));

  // Interleave: one codeword from each block in turn, data then checks.
  const stream = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) stream.push(block[i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const check of checks) stream.push(check[i]);
  }

  const size = version * 4 + 17;
  const modules = [];
  const reserved = [];
  for (let i = 0; i < size; i++) {
    modules.push(new Array(size).fill(false));
    reserved.push(new Array(size).fill(false));
  }

  const put = (row, col, dark) => { modules[row][col] = dark; reserved[row][col] = true; };

  // Finders, with their separators.
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const r = row + i;
        const c = col + j;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const edge = i === 0 || i === 6 || j === 0 || j === 6;
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        put(r, c, (i >= 0 && i <= 6 && j >= 0 && j <= 6) && (edge || core));
      }
    }
  }

  // Timing.
  for (let i = 8; i < size - 8; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }

  // Alignment, everywhere the finders are not.
  const centres = ALIGNMENT[version - 1];
  for (const row of centres) {
    for (const col of centres) {
      if ((row < 8 && col < 8) || (row < 8 && col > size - 9) || (row > size - 9 && col < 8)) continue;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          put(row + i, col + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
        }
      }
    }
  }

  // The lone dark module, and the space the format information will take.
  put(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[size - 11 + j][i] = true;
        reserved[i][size - 11 + j] = true;
      }
    }
  }

  // The data, up the right-hand side and back down, two columns at a time.
  let bit = 0;
  const total = stream.length * 8;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--; // the vertical timing column is not a data column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        let dark = false;
        if (bit < total) {
          dark = ((stream[bit >> 3] >> (7 - (bit & 7))) & 1) === 1;
          bit++;
        }
        modules[row][col] = dark;
      }
    }
    upward = !upward;
  }

  // Try every mask, keep the one the spec likes best.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forced !== null && mask !== forced) continue;
    const candidate = modules.map((row) => row.slice());
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        if (!reserved[i][j] && MASKS[mask](i, j)) candidate[i][j] = !candidate[i][j];
      }
    }
    writeFormat(candidate, size, formatBits(mask));
    if (version >= 7) writeVersion(candidate, size, versionBits(version));
    const score = penalty(candidate, size);
    if (!best || score < best.score) best = { score, rows: candidate };
  }

  return {
    version,
    size,
    rows: best.rows,
    at: (row, col) => !!(best.rows[row] && best.rows[row][col])
  };
}

function writeFormat(rows, size, bits) {
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    // Around the top-left finder, and split across the other two.
    if (i < 6) rows[i][8] = dark;
    else if (i === 6) rows[7][8] = dark;
    else if (i === 7) rows[8][8] = dark;
    else if (i === 8) rows[8][7] = dark;
    else rows[8][14 - i] = dark;

    if (i < 8) rows[8][size - 1 - i] = dark;
    else rows[size - 15 + i][8] = dark;
  }
}

function writeVersion(rows, size, bits) {
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    rows[size - 11 + col][row] = dark;
    rows[row][size - 11 + col] = dark;
  }
}

/** The four penalties from the spec; the mask with the lowest total wins. */
function penalty(rows, size) {
  let score = 0;

  const run = (get) => {
    for (let a = 0; a < size; a++) {
      let length = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          length++;
          if (length === 5) score += 3;
          else if (length > 5) score += 1;
        } else length = 1;
      }
    }
  };
  run((a, b) => rows[a][b]);
  run((a, b) => rows[b][a]);

  for (let i = 0; i < size - 1; i++) {
    for (let j = 0; j < size - 1; j++) {
      const v = rows[i][j];
      if (v === rows[i][j + 1] && v === rows[i + 1][j] && v === rows[i + 1][j + 1]) score += 3;
    }
  }

  const finder = [true, false, true, true, true, false, true, false, false, false, false];
  const reverse = finder.slice().reverse();
  const matches = (get, a, b, pattern) => {
    for (let k = 0; k < pattern.length; k++) if (get(a, b + k) !== pattern[k]) return false;
    return true;
  };
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 11 <= size; b++) {
      if (matches((x, y) => rows[x][y], a, b, finder) || matches((x, y) => rows[x][y], a, b, reverse)) score += 40;
      if (matches((x, y) => rows[y][x], a, b, finder) || matches((x, y) => rows[y][x], a, b, reverse)) score += 40;
    }
  }

  let dark = 0;
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) if (rows[i][j]) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** The code as an SVG path, ready to drop into a page. */
function toSvg(code, options) {
  const o = options || {};
  const quiet = o.quiet == null ? 4 : o.quiet;
  const span = code.size + quiet * 2;
  let path = '';
  for (let row = 0; row < code.size; row++) {
    for (let col = 0; col < code.size; col++) {
      if (code.at(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return { span, path };
}

/** The code as plain text, for a terminal or a test. */
function toText(code) {
  return code.rows.map((row) => row.map((dark) => (dark ? '██' : '  ')).join('')).join('\n');
}

module.exports = { encode, toSvg, toText, capacity, pickVersion, VERSIONS };
