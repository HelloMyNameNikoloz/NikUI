'use strict';

/**
 * This window's side of the keeper (src/keeper.js): starting it when there is
 * none, starting `claude` through it, and picking instances back up after a
 * reload.
 *
 * A process started through the keeper looks to Session like any child
 * process — stdin, stdout, stderr, exit — so the conversation code does not
 * know the difference. What it adds is checkpoints: after every prompt or
 * answer written to it, after every turn, and every megabyte or so of output
 * in between, the Session's state goes to the keeper, which then only has to
 * hold the lines since.
 *
 * When there is no keeper and one cannot be started, a process is simply this
 * window's child, as it always was: a reload ends it, nothing else changes.
 */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const PROTO = 1;
// Output between checkpoints. Small enough that a reload reads back little,
// large enough that a long turn is not snapshotting all the time.
const CHECKPOINT_BYTES = 1024 * 1024;
const CONNECT_MS = 4000;
// Answers that mean the keeper was not heard, rather than that it said no.
const UNHEARD = new Set(['keeper gone', 'no keeper', 'no answer']);

function sessionMeta(session) {
  return session ? { conversation: session.claudeSessionId || null, instance: session.id, cwd: session.cwd } : undefined;
}

function defaultDir() {
  // Somewhere else entirely when asked: the test runner, and an engine run
  // against a private root, must never find the keeper the real windows use.
  if (process.env.NIKUI_KEEPER_DIR) return process.env.NIKUI_KEEPER_DIR;
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'NikUI', 'keeper')
    : path.join(os.homedir(), '.nikui', 'keeper');
}

/** Somewhere only this user can read, and not a link to somewhere else. */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('keeper folder is not a folder: ' + dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('keeper folder belongs to someone else: ' + dir);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** A process the keeper holds, shaped like the ChildProcess Session expects. */
class KeptProc extends EventEmitter {
  constructor(link, runId, session) {
    super();
    this.kept = true;
    this.link = link;
    this.runId = runId;
    this.session = session;
    this.pid = null;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.seq = 0;
    this.sinceCheckpoint = 0;
    this.checkpointQueued = false;
    this.released = false;
    this.local = null;
    // Said before the keeper took it on: sent, in order, once it has.
    this.outbox = [];
    this.state = 'pending';
    const noop = () => {};
    this.stdout = Object.assign(new EventEmitter(), { setEncoding: noop });
    this.stderr = Object.assign(new EventEmitter(), { setEncoding: noop });
    const self = this;
    this.stdin = {
      get writable() { return self.exitCode === null && self.signalCode === null && !self.released; },
      write(line) {
        if (self.local) return self.local.stdin.write(line);
        if (self.session?._engineControls && self.state !== 'kept') throw Object.assign(new Error('Keeper write is not ready'), { delivery: 'not_written' });
        const socket = self.link.socket;
        const sent = self.send({ t: 'write', runId: self.runId, d: String(line).replace(/\n$/, '') });
        if (self.session?._engineControls && (!sent || socket && (socket !== self.link.socket || socket.destroyed))) throw new Error('Keeper write could not be confirmed');
        // What was just said is part of the state now (the prompt, the
        // answer); a reload a moment later must not lose it.
        self.checkpointSoon();
        return true;
      },
      // Only ever said when stopping it: the keeper sees it through, politely
      // then not, even if this window is gone before it has.
      end() {
        if (self.local) return self.local.stdin.end();
        self.send({ t: 'stop', runId: self.runId });
      }
    };
  }

  kill(signal) {
    this.killed = true;
    if (this.local) return this.local.kill(signal);
    this.send({ t: 'kill', runId: this.runId, signal: signal || 'SIGTERM' });
    return true;
  }

  send(msg) {
    if (this.state === 'pending') { this.outbox.push(msg); return true; }
    if (this.state === 'kept') return this.link.send(msg);
    return false;
  }

  /** The keeper has it: everything said meanwhile goes after the spawn. */
  kept_() {
    this.state = 'kept';
    for (const msg of this.outbox.splice(0)) this.link.send(msg);
  }

  /** One message from the keeper about this run. */
  receive(msg) {
    if (msg.t === 'spawned') { this.pid = msg.pid; return; }
    if (msg.t === 'line') {
      if (msg.seq <= this.seq) return; // already read back from the checkpoint
      this.seq = msg.seq;
      if (msg.k === 'e') { this.stderr.emit('data', msg.d + '\n'); return; }
      const conversation = this.session && this.session.claudeSessionId;
      this.stdout.emit('data', msg.d + '\n');
      // Init is where a fresh CLI first tells us its conversation ID. Publish
      // it immediately, including when a turn never reaches a result.
      if (msg.d.startsWith('{"type":"system"') || this.session && this.session.claudeSessionId !== conversation) this.checkpointSoon();
      this.sinceCheckpoint += msg.d.length;
      // After a turn the state is small and settled: the best moment.
      if (this.sinceCheckpoint > CHECKPOINT_BYTES || msg.d.startsWith('{"type":"result"')) this.checkpointSoon();
      return;
    }
    if (msg.t === 'exit') this.finish(msg.exit || {});
  }

  finish(exit) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = exit.code === undefined ? null : exit.code;
    this.signalCode = exit.signal || null;
    if (exit.error) {
      const err = new Error(exit.error);
      err.code = exit.errno || null;
      this.emit('error', err);
    }
    // Ended for good: the keeper can forget it once this window has heard.
    if (this.exitCode === null && this.signalCode === null) this.exitCode = -1;
    this.emit('exit', exit.code === undefined ? null : exit.code, exit.signal || null);
    this.link.forget(this);
  }

  checkpointSoon() {
    if (this.checkpointQueued || this.local) return;
    this.checkpointQueued = true;
    // After whatever is being handled right now has finished changing state.
    queueMicrotask(() => {
      this.checkpointQueued = false;
      this.checkpoint();
    });
  }

  checkpoint(snapshot) {
    if (this.local || this.released) return;
    const snap = snapshot || (this.session && !this.session.disposed ? this.session.snapshot() : null);
    if (!snap) return;
    this.sinceCheckpoint = 0;
    // Only the newest one matters while it waits to be sent.
    if (this.state === 'pending') this.outbox = this.outbox.filter((m) => m.t !== 'checkpoint');
    this.send({ t: 'checkpoint', runId: this.runId, seq: this.seq, snapshot: snap, meta: sessionMeta(this.session) });
  }

  /** The window is going: hand over the newest state and let go. */
  release(snapshot) {
    if (this.local || this.released) return;
    this.checkpoint(snapshot);
    this.released = true;
    this.send({ t: 'release', runId: this.runId });
    this.link.procs.delete(this.runId);
  }

  /** No keeper after all: a child of this window, as before. */
  goLocal(cmd, args, opts) {
    this.state = 'local';
    const said = this.outbox.splice(0);
    // Let go of, or closed, while waiting: nobody is left to start it for.
    if (this.released || (this.session && this.session.disposed)) {
      this.exitCode = -1;
      return;
    }
    let child;
    try { child = spawn(cmd, args, opts); }
    catch (err) { setImmediate(() => { this.emit('error', err); this.finish({ code: null, signal: null }); }); return; }
    this.local = child;
    this.kept = false;
    this.pid = child.pid;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => this.stdout.emit('data', c));
    child.stderr.on('data', (c) => this.stderr.emit('data', c));
    child.on('error', (err) => this.emit('error', err));
    child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.signalCode = signal;
      this.emit('exit', code, signal);
    });
    for (const m of said) {
      if (m.t === 'write') child.stdin.write(m.d + '\n');
      else if (m.t === 'end') child.stdin.end();
      else if (m.t === 'kill') child.kill(m.signal);
    }
  }
}

class KeeperLink {
  constructor(opts = {}) {
    this.dir = opts.dir || defaultDir();
    this.log = opts.log || (() => {});
    this.nodePath = opts.nodePath || process.execPath;
    this.source = opts.source || path.join(__dirname, 'keeper.js');
    this.env = opts.env || process.env;
    this.existingOnly = opts.existingOnly === true;
    this.socketPath = path.join(this.dir, 'k' + PROTO + '.sock');
    this.socket = null;
    this.metaVersion = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.procs = new Map();     // runId -> KeptProc
    this.held = new Map();      // runId -> messages that came before their KeptProc
    this.ready = null;          // Promise<boolean>
    this.closed = false;
  }

  /** Connected to a keeper, starting one if there is none. */
  connect() {
    if (!this.ready) {
      this.ready = this._connect().catch((err) => {
        this.log('keeper: not available, instances end with the window (' + ((err && err.message) || err) + ')');
        return false;
      });
    }
    return this.ready;
  }

  async _connect() {
    privateDir(this.dir);
    let socket = await this._dial().catch(() => null);
    if (!socket && this.existingOnly) throw Object.assign(new Error('Selected keeper is unavailable'), { code: 'KEEPER_UNAVAILABLE' });
    if (!socket) {
      this._launch();
      const until = Date.now() + CONNECT_MS;
      while (!socket && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 60));
        socket = await this._dial().catch(() => null);
      }
    }
    if (!socket) throw new Error('the keeper did not start');
    if (this.closed && !this._recovering) { socket.destroy(); throw new Error('the window is closing'); }
    this._adopt(socket);
    const hello = await this.request({ t: 'hello', proto: PROTO }, CONNECT_MS);
    if (hello.proto !== PROTO) {
      if (this.socket === socket) this.socket = null;
      socket.destroy();
      throw new Error(hello.message || ('keeper speaks protocol ' + hello.proto));
    }
    this.keeperPid = hello.pid;
    this.metaVersion = hello.metaVersion || null;
    this.log('keeper: connected (pid ' + hello.pid + ')');
    return true;
  }

  _dial() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
      socket.once('error', reject);
    });
  }

  /**
   * Started from a copy named after its contents, so the keeper running is
   * never changed under it by an edit to the repo.
   */
  _launch() {
    const code = fs.readFileSync(this.source);
    const sha = crypto.createHash('sha256').update(code).digest('hex').slice(0, 12);
    const copy = path.join(this.dir, 'keeper-' + sha + '.js');
    if (!fs.existsSync(copy)) {
      const tmp = copy + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, code, { mode: 0o600 });
      fs.renameSync(tmp, copy);
    }
    const child = spawn(this.nodePath, [copy, this.socketPath], {
      detached: true,
      stdio: 'ignore',
      cwd: this.dir,
      env: Object.assign({}, this.env, { ELECTRON_RUN_AS_NODE: '1' })
    });
    child.on('error', () => { /* the connect that follows says so */ });
    child.unref();
  }

  _adopt(socket) {
    this.socket = socket;
    this.metaVersion = null; // capability belongs to this connection's hello
    // Half a line from a connection that is gone is no part of this one.
    this.buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._data(chunk));
    const gone = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.metaVersion = null;
      for (const [, p] of this.pending) p.resolve({ ok: false, message: 'keeper gone' });
      this.pending.clear();
      this.ready = null;
      if (this.closed) return;
      this.log('keeper: connection lost; picking its instances back up');
      this._recover();
    };
    socket.on('close', gone);
    socket.on('error', gone);
  }

  _data(chunk) {
    this.buf += chunk;
    let at;
    while ((at = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, at);
      this.buf = this.buf.slice(at + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.t === 'reply') {
      const p = this.pending.get(msg.re);
      if (!p) return;
      this.pending.delete(msg.re);
      // Lines for a run being picked up can follow its reply in the same
      // read, before the promise has been seen: hold them for it.
      if (msg.runId && !this.procs.has(msg.runId)) this.held.set(msg.runId, this.held.get(msg.runId) || []);
      p.resolve(msg);
      return;
    }
    if (!msg.runId) return;
    const proc = this.procs.get(msg.runId);
    if (proc) { proc.receive(msg); return; }
    const held = this.held.get(msg.runId);
    if (held) held.push(msg);
  }

  send(msg) {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(JSON.stringify(msg) + '\n');
    return true;
  }

  request(msg, ms) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      let timer = null;
      if (ms) {
        timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, message: 'no answer' }); }, ms);
        if (timer.unref) timer.unref();
      }
      this.pending.set(id, { resolve: (r) => { if (timer) clearTimeout(timer); resolve(r); } });
      if (!this.send(Object.assign({ id }, msg))) {
        this.pending.delete(id);
        resolve({ ok: false, message: 'no keeper' });
      }
    });
  }

  /** What Session calls instead of child_process.spawn. */
  spawner() {
    return (cmd, args, opts, session) => {
      const runId = crypto.randomUUID();
      const proc = new KeptProc(this, runId, session);
      this.procs.set(runId, proc);
      const go = (ok) => {
        if (!ok || !this.socket) { this.procs.delete(runId); proc.goLocal(cmd, args, opts); return; }
        // Closed before the keeper was there: nothing to start.
        if (session && session.disposed && !proc.released) { this.procs.delete(runId); proc.state = 'local'; proc.exitCode = -1; return; }
        // The state it starts from goes with it, so even a reload before the
        // first prompt picks it up rather than starting a second one.
        const snapshot = session && typeof session.snapshot === 'function' ? session.snapshot() : null;
        this.request({
          t: 'spawn', runId, key: session ? session.id : runId,
          cmd, args, cwd: opts.cwd, env: opts.env, snapshot, meta: sessionMeta(session)
        }).then((r) => { if (r.pid) proc.pid = r.pid; });
        // The spawn is on the socket already; what was said meanwhile follows it.
        proc.kept_();
      };
      this.connect().then(go);
      return proc;
    };
  }

  /**
   * Pick an instance back up after a reload, if the keeper still holds it.
   * Resolves to true when the session is live again, false when there was
   * nothing to pick up (or it could not be read back, in which case the
   * process is stopped and the conversation resumes from its transcript).
   */
  async attach(session) {
    let r = { ok: false, message: 'no keeper' };
    // Just after a reload the last window may not have finished letting go;
    // and a keeper not heard from is asked again, not taken for a no — the
    // process it holds would otherwise get a second beside it.
    for (let i = 0; i < 12; i++) {
      if (i) await new Promise((res) => setTimeout(res, 250));
      if (session.disposed) return false;
      if (!(await this.connect())) { if (i >= 3) return false; continue; }
      r = await this.request({ t: 'attach', key: session.id }, CONNECT_MS);
      if (r.ok || (r.message !== 'owned' && !UNHEARD.has(r.message))) break;
    }
    if (!r.ok && UNHEARD.has(r.message)) return 'elsewhere';
    if (!r.ok) {
      if (r.message === 'owned') return 'elsewhere';
      if (r.message === 'unreplayable' && r.runId) {
        this.held.delete(r.runId);
        this.log('keeper: ' + session.id + ' had too much to read back; resuming it from its transcript instead');
        // Gone before its conversation is resumed by another: never two at once.
        const gone = await this.request({ t: 'forget', runId: r.runId, wait: true }, 10000);
        // Not confirmed: ended from here rather than resumed beside it.
        if (!gone.ok && !(await this._end(r.pid))) return 'elsewhere';
      }
      return false;
    }
    return this._attached(session, r);
  }

  _attached(session, r) {
    const held = this.held.get(r.runId) || [];
    this.held.delete(r.runId);
    // Taken away while the answer was on its way: the window going lets it
    // be, closing the instance on purpose stops it.
    if (session.disposed) {
      this.send({ t: session._leaving || this.closed ? 'release' : 'forget', runId: r.runId });
      return false;
    }
    if (!session.hydrate(r.checkpoint)) {
      this.send({ t: 'forget', runId: r.runId });
      return false;
    }
    const proc = new KeptProc(this, r.runId, session);
    proc.state = 'kept';
    proc.pid = r.pid;
    proc.seq = r.seq;
    this.procs.set(r.runId, proc);
    session.proc = proc;
    session._wire(proc);
    session.catchUp(r.tail);
    // Anything said between the reply and now.
    for (const msg of held) proc.receive(msg);
    // Ended while the window was away: over now, and the keeper can let go.
    if (r.exit) proc.finish(r.exit);
    else proc.checkpoint();
    return true;
  }

  /**
   * The connection dropped but the keeper may well still be there, and its
   * processes with it: reconnect and carry on from the last line read, rather
   * than calling them dead and starting a second `claude` on the next prompt.
   */
  _recover() {
    const procs = [...this.procs.values()].filter((p) => p.state === 'kept');
    // What is said meanwhile waits in each one's outbox — including, if the
    // window reloads first, the handover, which still has to reach the keeper.
    for (const p of procs) { p.state = 'pending'; this.procs.delete(p.runId); }
    const waiting = (this._waiting || []).concat(procs);
    this._waiting = waiting;
    if (this._recovering) return this._recovering;
    const run = async () => {
      for (let attempt = 0; this._waiting.length && attempt < 6; attempt++) {
        if (attempt) await new Promise((res) => setTimeout(res, 500 * attempt));
        if (!(await this.connect())) continue;
        for (const p of this._waiting.splice(0)) {
          if (p.exitCode !== null || p.signalCode !== null) continue;
          const r = await this.request({ t: 'reclaim', runId: p.runId, after: p.seq }, CONNECT_MS);
          const held = this.held.get(p.runId) || [];
          this.held.delete(p.runId);
          // Not heard: tried again on the next round, not given up on.
          if (!r.ok && UNHEARD.has(r.message)) { this._waiting.push(p); continue; }
          if (!r.ok) { this._lose(p, r.message); continue; }
          if (!p.released) this.procs.set(p.runId, p);
          for (const line of r.lines || []) p.receive(Object.assign({ t: 'line' }, line));
          for (const msg of held) p.receive(msg);
          p.kept_();
          if (r.exit && !p.released) p.finish(r.exit);
        }
      }
      // The keeper is not answering: what it held is ended from here, so
      // nothing resumes the conversation beside it.
      for (const p of this._waiting.splice(0)) this._lose(p, 'unheard');
    };
    this._recovering = run().finally(() => { this._recovering = null; });
    return this._recovering;
  }

  /** A run that cannot be carried on from here. */
  async _lose(p, why) {
    // Too much to read back: stopped before anything resumes its conversation.
    let ended = why === 'none';
    if (why === 'unreplayable') ended = (await this.request({ t: 'forget', runId: p.runId, wait: true }, 10000)).ok;
    if (!ended && why !== 'owned') ended = await this._end(p.pid);
    // In another window, or not known to have ended: this one must not start a second.
    if (!ended && p.session) { p.session.elsewhere = true; p.session._checkedAt = Date.now(); }
    p.state = 'local';
    p.finish({ code: null, signal: 'SIGHUP' });
  }

  forget(proc) {
    this.procs.delete(proc.runId);
    if (!proc.local) this.send({ t: 'forget', runId: proc.runId });
  }

  /** The window is going away. Resolves once the keeper has everything. */
  /** Ends a kept process directly, the keeper not answering; true once it is gone. */
  async _end(pid) {
    if (!(pid > 0)) return false;
    const alive = () => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
    try { process.kill(pid, 'SIGTERM'); } catch (_) { return !alive(); }
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    if (alive()) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } await new Promise((r) => setTimeout(r, 200)); }
    return !alive();
  }

  close() {
    this.closed = true;
    const until = Date.now() + 3300;
    const recovering = this._recovering
      ? Promise.race([this._recovering, new Promise((r) => setTimeout(r, 3000))])
      : Promise.resolve();
    return recovering.then(() => {
      const socket = this.socket;
      if (!socket || socket.destroyed) return;
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(100, until - Date.now()));
        socket.end(() => { clearTimeout(timer); resolve(); });
      });
    });
  }
}

module.exports = { KeeperLink, KeptProc, defaultDir, CHECKPOINT_BYTES, sessionMeta };
