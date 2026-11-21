'use strict';

// Exercise actual transport + WebCrypto seals with controlled socket events.
// Jitter yields event-loop turns around unrelated queries, disconnect and seal
// completion; it is part of the stimulus, never an assertion retry or delay.
const { browser } = require('./browser-client');
const { CORE } = require('../../src/protocolV2');
const turn = () => new Promise(setImmediate);
async function reached(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await turn(); }
  throw new Error('Transport stress did not reach its controlled boundary');
}

async function disconnectStress(trials = 240) {
  let unsafeWrites = 0, heldWrites = 0, falseCountAlarms = 0;
  for (let trial = 0; trial < trials; trial++) {
    const b = browser({ fakeTimers: true, config: { hostFingerprint: 'stress-host', session: 'instance' } });
    const audit = new Map(), sockets = [];
    let channelNumber = 0, channelReady = 0, hold = false, release, heldFrame, held = false;
    b.window.nikDevice = { available: () => true, load: async () => ({ id: 'device', fingerprint: 'stress-host' }),
      verifyLaptop: async () => true, authMessage: async () => ({ type: '@auth' }) };
    b.window.nikSecure.ephemeral = async () => ({ spki: 'fixture-public' });
    b.window.nikSecure.binding = async () => 'binding';
    b.window.nikSecure.clientBox = async () => {
      const channel = ++channelNumber;
      const keys = await b.window.nikSecure.derive(new Uint8Array(32).fill(channel), 'server-' + trial, 'client');
      const box = new b.window.nikSecure.Box(keys.toServer, keys.toClient);
      const seal = box.seal.bind(box);
      box.seal = (text) => {
        const m = JSON.parse(text);
        const encrypt = async () => {
          const frame = await seal(text);
          audit.set(JSON.stringify(frame), { channel, type: m.type });
          return frame;
        };
        if (hold && m.type === 'send') {
          hold = false; held = true;
          return new Promise((resolve) => { release = async () => { heldFrame = await encrypt(); resolve(heldFrame); }; });
        }
        return encrypt();
      };
      channelReady = channel; return box;
    };
    b.context.WebSocket = class {
      constructor() { this.readyState = 0; this.sent = []; this.number = sockets.length + 1; sockets.push(this); }
      send(text) {
        const frame = JSON.parse(text); this.sent.push(frame);
        const meta = audit.get(text);
        if (meta && (meta.channel !== this.number || this.readyState !== 1)) unsafeWrites++;
        if (frame.type === '@auth') void reached(() => channelReady === this.number).then(() => {
          this.onmessage({ data: JSON.stringify({ type: '@welcome', signature: 'fixture', proto: { min: 2, max: 2 } }) });
        });
        if (meta?.type === 'hello') this.onmessage({ data: JSON.stringify({ type: 'welcome', proto: 2, caps: CORE,
          engine: { id: 'e'.repeat(32) }, seat: { id: 'device', control: true },
          receipts: { scope: 'a'.repeat(32), retentionMs: 86400000, now: Date.now() } }) });
      }
      close() { this.readyState = 3; this.onclose?.(); }
    };
    const link = b.socket();
    const open = () => { const s = sockets.at(-1); s.readyState = 1; s.onopen();
      s.onmessage({ data: JSON.stringify({ type: '@challenge', fingerprint: 'stress-host', nonce: 'server', epk: 'fixture' }) }); };
    try {
      open(); await reached(() => link.application.ready);
      const old = sockets[0], earlyCount = old.sent.length;
      link.postMessage({ type: 'devices' }); // legitimate unrelated old-channel work
      for (let n = 0; n < trial % 4; n++) await turn();
      hold = true;
      link.postMessage({ type: 'send', text: 'stress ' + trial, attachments: [] });
      await reached(() => held);
      for (let n = 0; n < trial % 3; n++) await turn();
      const atDisconnect = old.sent.length;
      falseCountAlarms += atDisconnect !== earlyCount ? 1 : 0;
      // Include a frame queued behind the held seal.
      link.postMessage({ type: 'devices' });
      link.reconnect();
      if (trial % 2) { open(); await reached(() => link.application.ready); }
      await release();
      for (let n = 0; n <= trial % 5; n++) await turn();
      if (!(trial % 2)) { open(); await reached(() => link.application.ready); }
      unsafeWrites += old.sent.length !== atDisconnect ? 1 : 0;
      heldWrites += sockets.some((s) => s.sent.some((f) => JSON.stringify(f) === JSON.stringify(heldFrame))) ? 1 : 0;
    } finally { b.close(); }
  }
  return { trials, unsafeWrites, heldWrites, falseCountAlarms };
}
module.exports = { disconnectStress };
