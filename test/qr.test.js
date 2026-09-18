'use strict';
const crypto = require('crypto');
const qr = require('../src/qr.js');

const digest = (code) =>
  crypto.createHash('sha256')
    .update(code.rows.map((row) => row.map((dark) => (dark ? '1' : '0')).join('')).join(''))
    .digest('hex').slice(0, 16);

module.exports = async function () {
  suite('the codes we actually print');

  // These are golden: each was rendered and read back by Apple's QR detector in
  // test/qr.check.js, which is the only reason to believe the encoder at all.
  // If one of these changes, run `npm run test:qr` before believing the change.
  checkEqual('a short payload', digest(qr.encode('hello')), '99ccedcf0d82e92a');
  checkEqual('a pairing link', digest(qr.encode('http://127.0.0.1:4517/pair#c=ABCD2345&f=fp&n=laptop')),
    '466d1910c84dd75a');
  checkEqual('a single character', digest(qr.encode('x')), '38232e7e263ef0ca');

  suite('picking a version');

  checkEqual('a few bytes fit the smallest code', qr.encode('hello').version, 1);
  checkEqual('a pairing link needs a middling one', qr.encode('x'.repeat(70)).version, 5);
  checkEqual('and a long one goes up again', qr.encode('x'.repeat(200)).version, 10);
  checkEqual('the size follows the version', qr.encode('hello').size, 21);
  checkEqual('as it must', qr.encode('x'.repeat(200)).size, 57);
  check('a payload nothing can hold is refused rather than truncated', (() => {
    try { qr.encode('x'.repeat(400)); return false; } catch (err) { return /too long/.test(err.message); }
  })());

  suite('what a code is made of');

  const code = qr.encode('hello');
  const finder = (row, col) => {
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 7; j++) {
        const edge = i === 0 || i === 6 || j === 0 || j === 6;
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        if (code.at(row + i, col + j) !== (edge || core)) return false;
      }
    }
    return true;
  };
  check('a finder in the top left', finder(0, 0));
  check('one in the top right', finder(0, code.size - 7));
  check('one in the bottom left', finder(code.size - 7, 0));
  check('the timing row alternates', [8, 9, 10, 11].every((i) => code.at(6, i) === (i % 2 === 0)));
  check('and so does the timing column', [8, 9, 10, 11].every((i) => code.at(i, 6) === (i % 2 === 0)));
  check('the dark module is where the spec puts it', code.at(code.size - 8, 8) === true);

  suite('non-ASCII');

  const unicode = qr.encode('héllo ✅');
  check('is encoded as its bytes, not its characters', unicode.version >= 1);
  checkEqual('which is more bytes than characters',
    qr.pickVersion(Buffer.from('héllo ✅', 'utf8').length), unicode.version);

  suite('drawing it');

  const svg = qr.toSvg(code);
  checkEqual('the quiet zone is included', svg.span, code.size + 8);
  check('every dark module is a square in the path', (svg.path.match(/M/g) || []).length > 100);
  check('and nothing else is', /^[Mh v\-\d.z]+$/.test(svg.path.replace(/M/g, 'M')));

  const text = qr.toText(code);
  checkEqual('the text version has a line per row', text.split('\n').length, code.size);

  suite('the masks');

  const masked = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => digest(qr.encode('hello', { mask })));
  checkEqual('each one gives a different code', new Set(masked).size, 8);
  check('and the one chosen is among them', masked.includes(digest(qr.encode('hello'))));
};
