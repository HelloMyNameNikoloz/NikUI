'use strict';

const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createEngine } = require('../../src/engine');
const { createEngineState } = require('../../src/engineState');
const { CodexIpc, frame } = require('../../src/codexIpc');
const { context, settings, clock, tick } = require('../fixtures/engine/fakes');
const { disk, stamp, mid, deferred } = require('./engine-disk');

const DROP = Symbol('accept and drop');
function rpcFixture(answers = {}) {
  const processes = [], calls = [];
  function spawn() {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.exitCode = null; proc.killed = false; proc.kills = 0; proc.closes = 0; proc.calls = [];
    proc.exit = () => { if (proc.exitCode !== null) return; proc.exitCode = 0; proc.emit('exit', 0); };
    proc.kill = () => { proc.kills++; proc.killed = true; proc.exit(); };
    proc.close = () => { proc.closes++; proc.exit(); };
    proc.stdin.on('finish', proc.exit);
    proc.say = (method, params) => proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    proc.ask = (id, method, params) => proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    let buffer = '';
    proc.stdin.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        calls.push(msg); proc.calls.push(msg);
        if (msg.id == null || !msg.method) continue;
        const answer = answers[msg.method];
        Promise.resolve(typeof answer === 'function' ? answer(msg.params, proc, msg) : answer || {}).then((result) => {
          if (result === DROP) { proc.exit(); return; }
          const reply = result?.__error ? { error: result.__error } : { result };
          proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n');
        });
      }
    });
    processes.push(proc); return proc;
  }
  return { spawn, processes, calls, answers };
}

async function ipcFixture(dir, action = () => ({})) {
  const file = path.join(dir, 'fixture-ipc.sock'), calls = [], sockets = new Set();
  const router = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const n = buffer.readUInt32LE(0), msg = JSON.parse(buffer.subarray(4, 4 + n)); buffer = buffer.subarray(4 + n);
        calls.push(msg);
        if (msg.type !== 'request') continue;
        const result = msg.method === 'initialize' ? { clientId: 'fixture-follower' } : msg.method === 'thread-owner-discovery' ? {} : action(msg, socket);
        Promise.resolve(result).then((reply) => {
          if (reply === DROP) { socket.destroy(); return; }
          socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: reply, handledByClientId: 'fixture-external-writer' }));
        });
      }
    });
  });
  await new Promise((resolve, reject) => { router.once('error', reject); router.listen(file, resolve); });
  const ipc = new CodexIpc({ sockPath: file });
  return { ipc, calls,
    ask(requestId, method, params) { for (const socket of sockets) socket.write(frame({ type: 'request', requestId, method, params, version: 1 })); },
    async close() { ipc.dispose(); for (const socket of sockets) socket.destroy(); await new Promise((r) => router.close(r)); } };
}

const ctx = (session, principal = 'device:fixture') => ({ authenticated: true, principal, role: 'conversation',
  target: 'session:' + session.id, seat: { id: principal, control: true, local: false, editor: false } });
const message = (store, n, fields) => ({ mid: mid(n), scope: store.receiptInfo().scope, issuedAt: stamp, ...fields });

async function fixture({ borrowed = false, writer = 'engine', answers = {}, ipcAction, hook } = {}) {
  let at = stamp;
  const f = disk(), store = await f.open({ hook, now: () => at }), timers = clock();
  const rpc = rpcFixture(answers), claude = rpcFixture();
  const router = ipcAction ? await ipcFixture(f.dir, ipcAction) : null;
  const cache = { read: () => null, write() {}, sweep() {}, dispose() {}, picture: async () => null };
  const engine = createEngine({ context: context(), settings: settings({ claudePath: '/fixture/claude', autoTitle: false }),
    paths: { home: f.dir, projects: path.join(f.dir, 'projects') }, spawner: claude.spawn, timers, now: () => at,
    codex: { home: path.join(f.dir, '.codex'), codexPath: '/fixture/codex', spawnFn: rpc.spawn, env: { HOME: f.dir }, cache,
      ...(borrowed ? { daemonFn: async () => rpc.spawn() } : {}), ipc: router?.ipc || null } });
  let runtime = await createEngineState({ authority: store, engine, root: f.dir, timers, now: () => at });
  return { f, store, engine, rpc, claude, router, timers, get runtime() { return runtime; },
    advance(ms) { at += ms; },
    async reopen() {
      await runtime.dispose(); await store.close();
      const reopened = await f.open({ now: () => at });
      runtime = await createEngineState({ authority: reopened, engine, root: f.dir, timers, now: () => at });
      runtime.restoreEngine(); return { store: reopened, runtime };
    },
    async codex() {
      await engine.codex.client.start();
      const session = engine.codex._adopt({ id: 'fixture-thread', cwd: f.dir, model: 'fixture-model' });
      session.loaded = true; session.writerAuthority = writer; session.readOnly = writer === 'external';
      await runtime.flush(); return session;
    },
    async session() {
      const session = engine.manager.create({ id: 'fixture-claude', cwd: f.dir, autoStart: false });
      session.start();
      session._handleSystem({ type: 'system', subtype: 'init', session_id: 'fixture-conversation' });
      await runtime.flush(); return session;
    },
    async close() {
      await runtime.dispose(); engine.dispose(); if (router) await router.close(); await f.dispose();
    }
  };
}

module.exports = { fixture, ctx, message, rpcFixture, ipcFixture, DROP, deferred, tick, stamp, mid };
