'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

function state(initial = {}) {
  const values = structuredClone(initial);
  return { get: (key, fallback) => key in values ? values[key] : fallback,
    update: async (key, value) => { values[key] = structuredClone(value); }, values };
}
function context(initial = {}) { return { globalState: state(initial), workspaceState: state() }; }
function settings(initial = {}) {
  const values = structuredClone(initial), listeners = new Set();
  const changed = (key) => {
    const full = 'nikui.' + key;
    for (const fn of listeners) fn({ affectsConfiguration: (name) => full === name || full.startsWith(name + '.') });
  };
  return { values, listeners, get: (key, fallback) => key in values ? values[key] : fallback,
    update: async (key, value) => { values[key] = value; changed(key); },
    inspect: (key) => ({ globalValue: values[key] }), changed,
    onDidChangeConfiguration(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } };
}
// Methods deliberately depend on `this`: passing a bag of unbound functions
// would fail the exact SecretStorage method/event contract.
class Secrets {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); this.listeners = new Set(); this.disposals = 0; }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); this.changed(key); }
  async delete(key) { this.values.delete(key); this.changed(key); }
  changed(key) { for (const fn of this.listeners) fn({ key }); }
  onDidChange(fn) { this.listeners.add(fn); return { dispose: () => { this.disposals++; this.listeners.delete(fn); } }; }
}
function clock() {
  let seq = 0;
  const tasks = new Map();
  return { tasks, now: () => 100000,
    setTimeout(fn, ms) { const id = ++seq; tasks.set(id, { fn, ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    fire() { const pending = [...tasks.values()]; tasks.clear(); for (const { fn } of pending) fn(); } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function processFixture(answers = {}) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.kills = 0; proc.closes = 0; proc.calls = [];
  proc.kill = () => { proc.kills++; proc.emit('exit', 0); };
  proc.close = () => { proc.closes++; proc.emit('exit', 0); };
  let buffer = '';
  proc.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      proc.calls.push(msg);
      if (msg.id == null || !msg.method) continue;
      const answer = answers[msg.method];
      Promise.resolve(typeof answer === 'function' ? answer(msg.params) : answer || {}).then((result) => {
        proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      });
    }
  });
  return proc;
}
function provider(answers = {}) {
  const spawned = [];
  return { spawned, spawnFn: (cmd, args, opts) => {
    const proc = processFixture(answers);
    spawned.push({ cmd, args, opts, proc }); return proc;
  } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { context, state, settings, Secrets, clock, deferred, processFixture, provider, tick };
