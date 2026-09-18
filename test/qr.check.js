#!/usr/bin/env node
'use strict';

// The QR encoder, read back by a decoder nobody here wrote.
//
//   npm run test:qr
//
// src/qr.js is written from the specification, and a specification written from
// memory is exactly how the WebSocket handshake constant came out wrong. So
// every version it can produce is rendered to a PNG and decoded with Apple's
// CoreImage detector. Needs Swift (Xcode command line tools); skips without it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const qr = require('../src/qr.js');
const { qrToPng } = require('./helpers/png.js');
const { skipped } = require('./helpers/skip.js');

function haveSwift() {
  try {
    execFileSync('swift', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (_) { return false; }
}

if (!haveSwift()) {
  skipped('No swift found — the QR check did not run. It needs the Xcode command line tools.');
}

const decoder = path.join(__dirname, 'helpers', 'qr-decode.swift');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-qr-'));
const checks = [];

function readsBack(name, text, options) {
  const code = qr.encode(text, options);
  const file = path.join(dir, name.replace(/\W+/g, '-') + '.png');
  fs.writeFileSync(file, qrToPng(code, { scale: 6 }));
  let decoded = '';
  try {
    decoded = execFileSync('swift', [decoder, file], { encoding: 'utf8' }).trim();
  } catch (err) {
    decoded = '<decoder failed: ' + (err && err.message) + '>';
  }
  checks.push([`${name} (version ${code.version}, ${code.size}×${code.size})`, decoded === text]);
  if (decoded !== text) console.log('   wanted ' + JSON.stringify(text) + '\n   got    ' + JSON.stringify(decoded));
}

// One payload per version, so the block layout, the interleaving, the alignment
// patterns and the version information are all exercised.
const filler = 'abcdefghijklmnopqrstuvwxyz0123456789-_.:/#?&=';
const lengths = [10, 25, 40, 60, 80, 100, 120, 150, 175, 210];
lengths.forEach((length, index) => {
  let text = '';
  while (text.length < length) text += filler;
  readsBack('a payload of ' + length + ' bytes', text.slice(0, length));
  if (index === 0) return;
});

// The real thing, and the awkward cases.
readsBack('a pairing link', 'http://127.0.0.1:4517/pair#c=aVeryLongOneTimeCode123&f=fingerprintOfTheServerKey1&n=MacBook');
readsBack('a name with punctuation', "http://127.0.0.1:4517/pair#c=abc&f=def&n=Nikoloz's%20MacBook%20Pro");
readsBack('text that is not ASCII', 'héllo — ✅ ünïcødé');
readsBack('a single character', 'x');

// Every mask must produce a readable code, not just the one the scoring picks.
for (let mask = 0; mask < 8; mask++) {
  readsBack('mask ' + mask, 'http://127.0.0.1:4517/pair#c=code&f=fp&n=laptop', { mask });
}

let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) failed++;
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' QR checks passed');
process.exit(failed ? 1 : 0);
