#!/usr/bin/env node
'use strict';

// The chime an instance plays when it is done, synthesised rather than sampled.
//
//   node tools/sound.js
//
// Three glassy notes rising through a major chord — G, B, D — close together
// and soft, the way a phone says "sent" rather than the way an alarm says
// anything. Kept as code so it can be retuned and argued with; run it after
// changing anything here and commit what comes out.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'sounds', 'done.wav');
const RATE = 44100;
const LENGTH = 2.2; // seconds, most of it the tail dying away

// When each note starts, its pitch, and how loud it is. The last is the one
// that lands, so it is the loudest and rings longest.
const NOTES = [
  { at: 0.00, hz: 783.99, gain: 0.70, ring: 0.45 },  // G5
  { at: 0.09, hz: 987.77, gain: 0.75, ring: 0.50 },  // B5
  { at: 0.18, hz: 1174.66, gain: 1.00, ring: 0.85 }  // D6
];

// A bell is its partials: the note, an octave that fades faster, and a faint
// slightly-sharp shimmer that gives it glass rather than a sine's flatness.
const PARTIALS = [
  { ratio: 1.0, gain: 1.00, decay: 1.0 },
  { ratio: 2.0, gain: 0.22, decay: 0.55 },
  { ratio: 3.01, gain: 0.06, decay: 0.35 },
  { ratio: 4.23, gain: 0.02, decay: 0.2 }
];

const ATTACK = 0.006; // soft enough not to click, fast enough to be a strike

function synth() {
  const n = Math.round(RATE * LENGTH);
  const dry = new Float64Array(n);
  for (const note of NOTES) {
    const start = Math.round(note.at * RATE);
    for (let i = start; i < n; i++) {
      const t = (i - start) / RATE;
      const rise = t < ATTACK ? 0.5 - 0.5 * Math.cos(Math.PI * t / ATTACK) : 1;
      let v = 0;
      for (const p of PARTIALS) {
        v += p.gain * Math.exp(-t / (note.ring * p.decay)) * Math.sin(2 * Math.PI * note.hz * p.ratio * t);
      }
      dry[i] += note.gain * rise * v;
    }
  }
  return reverb(dry);
}

/** A small room: four combs in parallel, two all-passes after. Schroeder's. */
function reverb(dry) {
  const n = dry.length;
  const wet = new Float64Array(n);
  for (const [ms, feedback] of [[29.7, 0.78], [37.1, 0.76], [41.1, 0.74], [43.7, 0.72]]) {
    const d = Math.round(ms * RATE / 1000);
    const line = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      line[i] = dry[i] + (i >= d ? feedback * line[i - d] : 0);
      wet[i] += line[i] / 4;
    }
  }
  let out = wet;
  for (const ms of [5.0, 1.7]) {
    const d = Math.round(ms * RATE / 1000);
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const back = i >= d ? next[i - d] : 0;
      const ahead = i >= d ? out[i - d] : 0;
      next[i] = -0.7 * out[i] + ahead + 0.7 * back;
    }
    out = next;
  }
  const mixed = new Float64Array(n);
  for (let i = 0; i < n; i++) mixed[i] = 0.82 * dry[i] + 0.18 * out[i];
  return mixed;
}

/** Quiet on purpose: a peak of -9 dB, and the last quarter second faded to nothing. */
function finish(samples) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const scale = Math.pow(10, -9 / 20) / (peak || 1);
  const fade = Math.round(0.25 * RATE);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const left = samples.length - i;
    const tail = left < fade ? 0.5 - 0.5 * Math.cos(Math.PI * left / fade) : 1;
    const v = Math.max(-1, Math.min(1, samples[i] * scale * tail));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return pcm;
}

function wav(pcm) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);        // PCM
  head.writeUInt16LE(1, 22);        // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, wav(finish(synth())));
console.log('wrote ' + path.relative(process.cwd(), OUT));
