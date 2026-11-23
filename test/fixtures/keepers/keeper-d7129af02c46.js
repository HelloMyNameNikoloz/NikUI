'use strict';

/**
 * The keeper: holds Claude's processes so that reloading the VS Code window
 * does not end them.
 *
 * A `claude` started by the extension host is its child, joined to it by
 * pipes, and dies with it — so Developer: Reload Window used to cut off every
 * turn in flight. This small process is started on its own (detached, no
 * terminal, no window) and starts the `claude` processes instead. The
 * extension talks to it over a Unix socket; when the window reloads, the
 * socket closes, the processes carry on, and the new window picks them up.
 *
 * It is deliberately dumb. It does not understand the conversation; it keeps
 * two things per run:
 *
 *   - the newest checkpoint the extension gave it: the extension's own state
 *     for that instance, opaque here, as of output line `seq`;
 *   - every line of output since that checkpoint, numbered.
 *
 * A window picking an instance back up takes the checkpoint and feeds the
 * lines after it through the same code that read them live, so it ends up
 * exactly where the old window would have been. The extension checkpoints
 * often (after every prompt, answer and turn, and every megabyte or so), so
 * what is held here is about one turn's worth.
 *
 * Nothing here polls. It wakes for socket and pipe traffic and for two kinds
 * of deadline: a run nobody has reclaimed within the grace period after its
 * window went away (the window was closed, not reloaded — so it is stopped
 * rather than left burning tokens), and the keeper itself, which leaves once
 * it has no runs and no windows.
 *
 * One file, no dependencies: it runs from a copy named after its own
 * contents, so editing the repo never changes code under a live keeper.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROTO = 1;
const GRACE_MS = Number(process.env.NIKUI_KEEPER_GRACE_MS) || 3 * 60 * 1000;
const IDLE_MS = Number(process.env.NIKUI_KEEPER_IDLE_MS) || 60 * 1000;
// What one run may hold between checkpoints before it gives up on being
// picked up again; the extension checkpoints long before this.
const MAX_TAIL_BYTES = 64 * 1024 * 1024;
// What one window may have waiting to be read before it is cut off: a stuck
// window must never be able to stall a `claude` writing to its pipe.
const MAX_CLIENT_BACKLOG = 32 * 1024 * 1024;

const socketPath = process.argv[2];
if (!socketPath) { process.exit(2); }

const runs = new Map();     // runId -> Run
let born = 0;
const clients = new Set();
let idleTimer = null;

function log() { /* stdio is ignored; nothing to say to anybody */ }

class Run {
  constructor(msg, owner) {
    this.id = msg.runId;
    this.key = msg.key;
    this.born = ++born;
    this.owner = owner;          // the window's client, or null once it went away
    this.checkpoint = msg.snapshot === undefined ? null : msg.snapshot;
    this.seq = 0;                // last output line numbered
    this.checkpointSeq = 0;
    this.tail = [];              // [{seq, k, d, at}] after the checkpoint
    this.tailBytes = 0;
    this.overflow = false;
    this.exit = null;            // {code, signal} once it has ended
    this.answered = new Set();   // permission requests already answered
    this.graceTimer = null;
    this.killTimers = [];
    this.child = null;
    this.buf = { o: '', e: '' };
    this.waiters = [];           // [client, msg]: told once it has ended
  }

  start(msg) {
    let child;
    try {
      child = spawn(msg.cmd, msg.args || [], {
        cwd: msg.cwd,
        env: msg.env || process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so stopping it stops whatever it started.
        detached: true
      });
    } catch (err) {
      this.failed(err);
      return;
    }
    this.child = child;
    child.on('error', (err) => this.failed(err));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.output('o', chunk));
    child.stderr.on('data', (chunk) => this.output('e', chunk));
    child.stdin.on('error', () => { /* it closed its end; the exit says why */ });
    // 'close', not 'exit': every line it wrote has been read by then.
    child.on('close', (code, signal) => {
      for (const k of ['o', 'e']) if (this.buf[k]) { this.record(k, this.buf[k]); this.buf[k] = ''; }
      this.ended(code, signal);
    });
    if (child.pid) this.send({ t: 'spawned', runId: this.id, pid: child.pid });
  }

  failed(err) {
    if (this.exit) return;
    this.exit = { code: null, signal: null, error: (err && err.message) || String(err), errno: (err && err.code) || null };
    this.send({ t: 'exit', runId: this.id, seq: this.seq, exit: this.exit });
    this.settle();
  }

  output(k, chunk) {
    const text = this.buf[k] + chunk;
    const lines = text.split('\n');
    this.buf[k] = lines.pop();
    for (const line of lines) if (line.trim()) this.record(k, line);
  }

  record(k, d) {
    const entry = { seq: ++this.seq, k, d, at: Date.now() };
    if (!this.overflow) {
      this.tail.push(entry);
      this.tailBytes += d.length + 40;
      if (this.tailBytes > MAX_TAIL_BYTES) {
        // Too much since the last checkpoint to rebuild from: a window that
        // comes back starts this conversation afresh instead.
        this.overflow = true;
        this.tail = [];
        this.tailBytes = 0;
      }
    }
    this.send({ t: 'line', runId: this.id, seq: entry.seq, k, d, at: entry.at });
  }

  ended(code, signal) {
    if (this.exit) return;
    for (const t of this.killTimers) clearTimeout(t);
    this.killTimers = [];
    this.exit = { code, signal };
    this.send({ t: 'exit', runId: this.id, seq: this.seq, exit: this.exit });
    for (const [client, msg] of this.waiters.splice(0)) client.reply(msg, { ok: true });
    if (this.stopping) { forget(this); return; }
    this.settle();
  }

  /** Over and nobody to tell: kept for the grace period, then forgotten. */
  settle() {
    if (!this.owner) this.startGrace();
  }

  write(line) {
    if (!this.child || this.exit || !this.child.stdin.writable) return;
    // An answer to a permission prompt goes in once. A window that comes back
    // and shows the prompt again must not be able to answer it twice.
    if (line.startsWith('{"type":"control_response"')) {
      const id = /"request_id":"([^"]+)"/.exec(line);
      if (id) {
        if (this.answered.has(id[1])) return;
        this.answered.add(id[1]);
        if (this.answered.size > 512) this.answered.clear();
      }
    }
    this.child.stdin.write(line.endsWith('\n') ? line : line + '\n');
  }

  end() {
    try { if (this.child) this.child.stdin.end(); } catch (_) { /* closed */ }
  }

  kill(signal) {
    if (!this.child || this.exit) return;
    const pid = this.child.pid;
    try { process.kill(-pid, signal || 'SIGTERM'); }
    catch (_) { try { this.child.kill(signal || 'SIGTERM'); } catch (_) { /* gone */ } }
  }

  /** Stop it the way a closed window would want: politely, then not. */
  stop() {
    if (this.exit || !this.child) return;
    this.end();
    this.killTimers.push(setTimeout(() => this.kill('SIGTERM'), 2000));
    this.killTimers.push(setTimeout(() => this.kill('SIGKILL'), 7000));
  }

  takeCheckpoint(seq, snapshot) {
    if (seq > this.seq) return;
    this.checkpoint = snapshot;
    this.checkpointSeq = seq;
    // A checkpoint is a fresh base, even after an overflow.
    this.overflow = false;
    let i = 0;
    while (i < this.tail.length && this.tail[i].seq <= seq) { this.tailBytes -= this.tail[i].d.length + 40; i++; }
    this.tail = this.tail.slice(i);
    if (!this.tail.length) this.tailBytes = 0;
  }

  send(msg) {
    if (this.owner) this.owner.send(msg);
  }

  orphan() {
    this.owner = null;
    this.startGrace();
  }

  startGrace() {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.owner) return;
      if (this.exit) { forget(this); return; }
      // Forgotten once it is gone.
      this.stopping = true;
      this.stop();
    }, GRACE_MS);
  }

  adopt(owner) {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this.owner = owner;
  }

  describe() {
    return { runId: this.id, key: this.key, pid: this.child ? this.child.pid : null, owned: !!this.owner, exit: this.exit };
  }
}

function forget(run) {
  if (run.graceTimer) clearTimeout(run.graceTimer);
  runs.delete(run.id);
  idleCheck();
}

function idleCheck() {
  if (runs.size || clients.size) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    return;
  }
  if (idleTimer) return;
  idleTimer = setTimeout(() => {
    if (runs.size || clients.size) { idleTimer = null; return; }
    server.close();
    try { fs.unlinkSync(socketPath); } catch (_) { /* gone */ }
    unlock();
    process.exit(0);
  }, IDLE_MS);
}

class Client {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.data(chunk));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }

  data(chunk) {
    this.buf += chunk;
    let at;
    while ((at = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, at);
      this.buf = this.buf.slice(at + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      try { this.handle(msg); } catch (err) { this.send({ t: 'error', re: msg.id, message: err.message }); }
    }
  }

  send(msg) {
    if (this.closed) return;
    if (this.socket.writableLength > MAX_CLIENT_BACKLOG) { this.socket.destroy(); return; }
    this.socket.write(JSON.stringify(msg) + '\n');
  }

  reply(msg, body) {
    this.send(Object.assign({ t: 'reply', re: msg.id }, body));
  }

  handle(msg) {
    const run = msg.runId ? runs.get(msg.runId) : null;
    switch (msg.t) {
      case 'hello':
        return this.reply(msg, { proto: PROTO, pid: process.pid });
      case 'spawn': {
        if (runs.has(msg.runId)) return this.reply(msg, { ok: false, message: 'run exists' });
        const fresh = new Run(msg, this);
        runs.set(fresh.id, fresh);
        idleCheck();
        fresh.start(msg);
        return this.reply(msg, { ok: true, pid: fresh.child ? fresh.child.pid : null });
      }
      case 'write': if (run && run.owner === this) run.write(msg.d); return;
      case 'end': if (run && run.owner === this) run.end(); return;
      // Stopped on purpose: seen through here, so a window reloading halfway
      // cannot leave it running, nor pick it up again.
      case 'stop': if (run && run.owner === this) { run.stopping = true; run.stop(); } return;
      case 'kill': if (run && run.owner === this) run.kill(msg.signal); return;
      case 'checkpoint': if (run && run.owner === this) run.takeCheckpoint(msg.seq, msg.snapshot); return;
      case 'forget': {
        const mine = run && run.owner === this;
        if (mine) {
          run.owner = null;
          // Its lines are nobody's now; it is stopped and then dropped.
          if (run.exit) forget(run);
          else { run.stopping = true; run.stop(); }
        }
        // Asked to say when it is gone: its conversation is about to be
        // resumed by another process, and the two must never overlap.
        if (msg.wait) {
          if (mine && !run.exit) run.waiters.push([this, msg]);
          else this.reply(msg, { ok: true });
        }
        return;
      }
      case 'reclaim': {
        // The same window again, after its connection dropped: carry on from
        // the last line it read.
        if (!run || run.stopping) return this.reply(msg, { ok: false, message: 'none' });
        if (run.owner && run.owner !== this && !run.owner.closed) return this.reply(msg, { ok: false, message: 'owned' });
        const after = Number(msg.after) || 0;
        if (run.overflow || run.checkpointSeq > after) {
          run.adopt(this);
          return this.reply(msg, { ok: false, message: 'unreplayable', runId: run.id });
        }
        run.adopt(this);
        return this.reply(msg, { ok: true, runId: run.id, lines: run.tail.filter((l) => l.seq > after), exit: run.exit, seq: run.seq });
      }
      case 'list':
        return this.reply(msg, { runs: [...runs.values()].map((r) => r.describe()) });
      case 'attach': {
        // Just after a restart the old process may still be on its way out:
        // the live one, and the newest, is the instance.
        const found = [...runs.values()]
          .filter((r) => r.key === msg.key && !r.stopping)
          .sort((a, b) => (!!a.exit - !!b.exit) || (b.born - a.born))[0];
        if (!found) return this.reply(msg, { ok: false, message: 'none' });
        if (found.owner && found.owner !== this && !found.owner.closed) return this.reply(msg, { ok: false, message: 'owned' });
        if (found.overflow || found.checkpoint === null) {
          // Nothing to rebuild from; the window will start it afresh.
          found.adopt(this);
          return this.reply(msg, { ok: false, message: 'unreplayable', runId: found.id });
        }
        found.adopt(this);
        return this.reply(msg, {
          ok: true,
          runId: found.id,
          pid: found.child ? found.child.pid : null,
          checkpoint: found.checkpoint,
          checkpointSeq: found.checkpointSeq,
          tail: found.tail,
          exit: found.exit,
          seq: found.seq
        });
      }
      case 'release':
        // Let go of a run without stopping it, as a reloading window does.
        if (run && run.owner === this) run.orphan();
        return;
      default:
        return this.reply(msg, { ok: false, message: 'unknown ' + msg.t });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clients.delete(this);
    for (const run of runs.values()) if (run.owner === this) run.orphan();
    idleCheck();
  }
}

const server = net.createServer((socket) => {
  const client = new Client(socket);
  clients.add(client);
  idleCheck();
});

// One keeper at a time, by a lock file holding its pid: two windows starting
// one at once must not both decide the socket is stale and take turns
// unlinking each other's.
const lockPath = path.join(path.dirname(socketPath), 'keeper.pid');
// A keeper listens within moments of taking the lock; one that holds it this
// long without answering on the socket is gone (or its pid is someone else's).
const LOCK_STALE_MS = 10000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const readPid = (file) => { try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch (_) { return -1; } };

function lock() {
  const mine = lockPath + '.' + process.pid;
  fs.writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    for (let i = 0; i < 3; i++) {
      // Linked, not created then written: nobody ever reads it half done.
      try { fs.linkSync(mine, lockPath); return true; } catch (err) { if (err.code !== 'EEXIST') return false; }
      const held = readPid(lockPath);
      if (held < 0) continue; // just let go of
      let age = 0;
      let ino = 0;
      try { const st = fs.statSync(lockPath); age = Date.now() - st.mtimeMs; ino = st.ino; } catch (_) { continue; }
      if (held && alive(held) && age < LOCK_STALE_MS) return false;
      // Its keeper is gone. Moved aside, so that of two taking over only one
      // does — and put back if what was moved turns out to be a live one's.
      const aside = lockPath + '.stale.' + process.pid;
      // Still the very file judged stale, not a fresh one put there since.
      try { if (fs.statSync(lockPath).ino !== ino) continue; } catch (_) { continue; }
      try { fs.renameSync(lockPath, aside); } catch (_) { continue; }
      const moved = readPid(aside);
      if (moved !== held && moved > 0 && alive(moved)) {
        try { fs.linkSync(aside, lockPath); } catch (_) { /* someone else has it now */ }
        try { fs.unlinkSync(aside); } catch (_) { /* gone */ }
        return false;
      }
      try { fs.unlinkSync(aside); } catch (_) { /* gone */ }
    }
    return false;
  } finally {
    try { fs.unlinkSync(mine); } catch (_) { /* gone */ }
  }
}

function unlock() {
  if (readPid(lockPath) === process.pid) { try { fs.unlinkSync(lockPath); } catch (_) { /* gone */ } }
}

function listen() {
  // Somebody is there already: nothing to do.
  const probe = net.connect(socketPath);
  probe.once('connect', () => { probe.destroy(); process.exit(0); });
  probe.once('error', () => {
    if (!lock()) process.exit(0);
    // Taken over in the same instant by another starting keeper — which
    // the lock file then names instead — means that one is the keeper.
    setTimeout(() => {
      if (readPid(lockPath) !== process.pid) process.exit(0);
      // The keeper now, and the only one: whatever socket is there is stale.
      try { fs.unlinkSync(socketPath); } catch (_) { /* none */ }
      server.once('error', () => { unlock(); process.exit(1); });
      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch (_) { /* best effort */ }
        idleCheck();
      });
    }, 150);
  });
}

process.on('SIGPIPE', () => {});
process.on('uncaughtException', (err) => log(err));
try { fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 }); } catch (_) { /* exists */ }
listen();
