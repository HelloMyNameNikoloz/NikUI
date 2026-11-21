'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const ws = require('./ws');
const { verifyWith } = require('../../src/identity');
const locks = new Map();

function browser({ storage = new Map(), device, config = {}, fakeTimers = false, filter = () => true,
  assetsRoot = path.join(__dirname, '../../media') } = {}) {
  const events = new Map(), messages = [], frames = [], sockets = [], tasks = new Set();
  const add = (name, fn) => { const list = events.get(name) || []; list.push(fn); events.set(name, list); };
  const dispatch = (event) => { if (event.type === 'message') messages.push(event.data); for (const fn of events.get(event.type) || []) fn(event); };
  const pill = { addEventListener() {}, className: '', textContent: '' };
  const window = { crypto: crypto.webcrypto, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    location: { href: config.origin || 'http://127.0.0.1:1/', protocol: 'http:', assign: (url) => messages.push({ type: 'navigation', url }) },
    addEventListener: add, dispatchEvent: dispatch,
    navigator: { locks: { request: (name, fn) => {
      const pending = (locks.get(name) || Promise.resolve()).then(fn);
      locks.set(name, pending.catch(() => {})); return pending;
    } } },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } };
  if (device) window.nikDevice = { available: () => true, load: async () => ({ id: device.id, fingerprint: config.hostFingerprint }),
    authMessage: async (record, theirs, mine, suffix) => ({ type: '@auth', device: record.id, nonce: mine,
      signature: await device.sign('nikui-auth:' + theirs + ':' + mine + suffix) }),
    verifyLaptop: async (record, key, text, signature) => verifyWith(key, text, signature) };
  const document = { hidden: false, getElementById: (id) => id === 'link' ? pill : null, addEventListener: add };
  class Socket {
    constructor(url) {
      this.readyState = 0; this.received = []; this.sent = []; sockets.push(this);
      ws.connect(url).then((client) => {
        this.client = client;
        if (this.readyState === 3) { client.destroy(); return; }
        this.readyState = 1; this.onopen?.();
        const receive = (m) => { this.received.push(m); if (filter(m)) this.onmessage?.({ data: JSON.stringify(m) }); };
        client.on('message', receive);
        for (const m of client.messages) receive(m);
        client.socket.once('close', () => { this.readyState = 3; this.onclose?.(); });
      }, () => { this.readyState = 3; this.onclose?.(); });
    }
    send(text) { const m = JSON.parse(text); this.sent.push(m); frames.push(m); this.client.send(m); }
    close() { this.readyState = 3; this.client?.close(); }
    drop() { this.client?.destroy(); }
  }
  const context = vm.createContext({ window, document, URL, TextEncoder, TextDecoder, Uint8Array, Promise,
    MessageEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    WebSocket: Socket, module: { exports: {} },
    setTimeout: (fn, ms) => {
      if (fakeTimers) { const task = { fn, ms, unref() {} }; tasks.add(task); return task; }
      const timer = setTimeout(() => { tasks.delete(timer); fn(); }, ms); tasks.add(timer); return timer;
    }, clearTimeout: (timer) => { tasks.delete(timer); if (!fakeTimers) clearTimeout(timer); }
  });
  for (const file of ['secure.js', 'transport.js']) vm.runInContext(fs.readFileSync(path.join(assetsRoot, file), 'utf8'), context, { filename: file });
  const api = context.module.exports;
  return { ...api, context, window, document, messages, frames, sockets, tasks, storage,
    socket: () => api.socketTransport(config),
    close() { dispatch({ type: 'pagehide' }); for (const s of sockets) s.client?.destroy();
      for (const timer of tasks) if (!fakeTimers) clearTimeout(timer); tasks.clear(); } };
}
async function until(predicate, label = 'condition', timeout = 5000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Timed out: ' + label); await new Promise((r) => setTimeout(r, 5)); }
}
module.exports = { browser, until };
