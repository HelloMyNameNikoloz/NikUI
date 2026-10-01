'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { EventEmitter } = require('events');
const path = require('path');
const { nextTicket } = require('./ticket');
const { shortLabel } = require('./label');
const { transcriptPath } = require('./history');
const { pushedFrom } = require('./ci');

const STATUS = {
  IDLE: 'idle',
  WORKING: 'working',
  WAITING: 'waiting',
  DONE: 'done',
  ERROR: 'error',
  STOPPED: 'stopped'
};

// Give any background work a beat to settle before the next queued prompt.
const QUEUE_DELAY_MS = 5000;

// Background tasks that are work the conversation is waiting on. A shell
// command in the background is as often a dev server that never ends, and a
// monitor watches until it is told to stop, so neither keeps an instance working.
const AGENT_TASKS = new Set(['local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow']);
// A command left running that is never meant to end: a server, a watcher, a
// tail. It does not keep an instance working; a check or a build does.
const NEVER_ENDS = /\b(dev|serve|server|start|preview|watch|storybook|nodemon|tail\s+-f|logs?\s+-f)\b/i;

// When the last agent finishes, the CLI starts a turn of its own a moment
// later to hand over what it found. Resting as done in between would flash
// green and let the machine sleep, so that turn gets this long to begin.
const AGENT_SETTLE_MS = 3000;

// A `cat` of a large file, a failing test suite, a 40 MB log: one tool result
// can be bigger than everything else in the conversation put together. The
// model saw all of it either way, and the whole thing is in the transcript on
// disk — what we keep is only what the panel is going to show.
const TOOL_RESULT_MAX = 20000;

// The live conversation is bounded too, so a long-running instance cannot grow
// its memory, its postMessage payload or its DOM without limit. Overridable
// per user; 0 means keep everything.
const DEFAULT_MAX_ITEMS = 400;

/** Cut a string to a budget, reporting what was there before. */
function clip(text, max) {
  const full = String(text == null ? '' : text);
  if (!max || full.length <= max) return { text: full, length: full.length, clipped: false };
  return { text: full.slice(0, max), length: full.length, clipped: true };
}

let counter = 0;
const nextId = () => `nik-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * One Claude Code instance: a long-lived `claude` process speaking stream-json
 * on stdin/stdout, normalised into a flat list of render items.
 */
class Session extends EventEmitter {
  constructor(opts) {
    super();
    this.id = opts.id || nextId();
    this.cwd = opts.cwd;
    this.claudePath = opts.claudePath || 'claude';
    this.model = opts.model || '';
    this.permissionMode = opts.permissionMode || 'bypassPermissions';
    this.extraArgs = opts.extraArgs || [];
    this.effort = opts.effort || '';
    this.outputStyle = opts.outputStyle || '';
    this.autoTitle = opts.autoTitle !== false;

    this.customTitle = opts.customTitle || null;
    this.autoLabel = opts.autoLabel || null;
    this.ticket = opts.ticket || null;
    this.claudeSessionId = opts.claudeSessionId || null;

    // A restored instance comes back wearing the state its conversation ended
    // in. A turn that was still running when the window closed did not finish,
    // and its process is gone, so that one comes back stopped rather than
    // pretending it is still working.
    this.status = restoredStatus(opts.status);
    this.items = [];
    // Restored instances carry their running total; the baseline anchors the
    // per-process cumulative the CLI reports.
    this.totalCost = opts.totalCost || 0;
    this._costBaseline = this.totalCost;
    this.lastError = null;
    this.meta = { model: null, tools: [], slashCommands: [] };
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.turns = opts.turns || 0;
    this.turnStartedAt = null;
    this.lastDurationMs = 0;
    this.finishedAt = opts.finishedAt || 0;
    // What /status reports on: one record per finished turn, plus the running
    // tallies that cannot be recovered from the items list.
    this.startedAt = opts.startedAt || Date.now();
    this.processStartedAt = null;
    // Restored from the last window when there is one: the totals above came
    // back, and these are what explain them.
    this.turnLog = Array.isArray(opts.turnLog) ? opts.turnLog.slice() : [];
    this.interrupts = opts.interrupts || 0;
    this.errors = opts.errors || 0;
    this.compactions = opts.compactions || 0;
    this.lastCompactedAt = opts.lastCompactedAt || 0;
    // Account-wide, so an instance starts with whatever the window already knows.
    this.limits = opts.limits || null;
    // Held back until the account's quota resets. Not a status the CLI knows
    // about — the process is alive and idle, we are simply not talking to it.
    this.pausedUntil = 0;
    this.pauseReason = null;
    // Whether the pause caught it in the middle of something, which is what
    // decides who gets nudged when the quota comes back.
    this.interruptedByPause = false;
    // Whether its last turn was cut off by the account's limit. Not the same
    // question as the one above: an instance can fail on the limit a moment
    // before anything pauses — its own failure is what nobody recognised — and
    // this one is remembered across a reload, because a flag that lives only
    // in memory is exactly how instances were left red after a reset.
    this.cutByLimit = !!opts.cutByLimit;
    // Finished a turn nobody has looked at since: the blue dot.
    this.unread = !!opts.unread;
    this._limitThisTurn = false;
    this._turnTools = [];
    // What the CLI says is running behind the conversation, and whether the
    // instance is working only because of that rather than in a turn.
    this.backgroundTasks = [];
    this._agents = new Map();
    this._shells = new Map();
    this._inBackground = false;
    this._stoppingAgents = false;
    this._settleTimer = null;
    this.agentSettleMs = AGENT_SETTLE_MS;

    this.proc = null;
    // A restored instance has no process yet but is not "stopped" — it has
    // simply never been opened in this window. Anything that cleans up dead
    // instances has to tell those two apart.
    this.everStarted = false;
    this._stdoutBuf = '';
    this._itemIndex = new Map();
    this._streamMsgId = null;
    this._streamedMsgIds = new Set();
    this._blockToItem = new Map();
    this._interrupted = false;
    this._dirty = new Set();
    this._flushTimer = null;
    this._controlSeq = 0;
    this._seq = 0;
    this.replayed = false;
    this.disposed = false;
    // A queue can come back from a reload: the prompts in it are typed work,
    // and the pause they may be waiting on outlives the window too.
    this.queue = Array.isArray(opts.queue)
      ? opts.queue.map((q) => ({
        id: q.id || ('q' + (this._seq++)),
        text: String(q.text || ''),
        sent: q.sent || null,
        snippets: Array.isArray(q.snippets) ? q.snippets : [],
        // Images are not saved — see SessionManager.persist — so a restored
        // prompt says it lost them rather than pretending it never had any.
        attachments: [],
        lostImages: Number(q.images) || 0
      }))
      : [];
    this._drainTimer = null;
    this.contextTokens = 0;
    this.contextWindow = 0;
    this.maxItems = opts.maxItems === undefined ? DEFAULT_MAX_ITEMS : opts.maxItems;
    // How many items have scrolled out of the window we keep. The panel says so
    // rather than pretending the conversation started there.
    this.droppedItems = 0;
  }

  get label() {
    // With automatic naming off, only a name somebody gave it, or its folder.
    const auto = this.autoTitle ? (this.ticket || this.autoLabel) : null;
    return this.customTitle || auto || path.basename(this.cwd || '') || 'claude';
  }

  get isRunning() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  /**
   * Something is running that closing it or letting the machine sleep would
   * kill: a turn, or agents in the background, which can outlast a turn that
   * failed.
   */
  get isBusy() {
    return this.status === STATUS.WORKING || this.status === STATUS.WAITING || this.backgroundWork > 0;
  }

  /**
   * A turn is in flight. Agents in the background are not one: the CLI answers
   * a prompt sent meanwhile straight away, so only a turn holds the queue.
   */
  get inTurn() {
    return (this.status === STATUS.WORKING && !this._inBackground) || this.status === STATUS.WAITING;
  }

  /** Agents this instance started that are still running in the background. */
  get backgroundAgents() {
    return this.backgroundTasks.filter((t) => AGENT_TASKS.has(t.type)).length;
  }

  /**
   * Commands it left running that will end — `pnpm run check &`, a test
   * suite — and that it said it is waiting for. The CLI starts a turn by
   * itself when one finishes, so until then the work is not done. Not a dev
   * server, and not one an agent left behind: neither is anybody waiting on.
   */
  get backgroundShells() {
    return this.backgroundTasks.filter((t) => t.type === 'local_bash' &&
      !(this._shells.get(t.id) || {}).owned && !NEVER_ENDS.test(t.description || '')).length;
  }

  /** Everything behind the conversation that it is not finished without. */
  get backgroundWork() {
    return this.backgroundAgents + this.backgroundShells;
  }

  get isPaused() {
    return !!this.pausedUntil;
  }

  /** Restored from a previous window and not opened since: asleep, not dead. */
  get isAsleep() {
    return !this.everStarted && !this.isRunning;
  }

  /** Whether closing this would throw away anything the user would miss. */
  get hasHistory() {
    return !!this.claudeSessionId || this.totalCost > 0 || this.items.length > 0;
  }

  // ---- lifecycle ----------------------------------------------------------

  start() {
    if (this.isRunning || this.disposed) return;

    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', this.permissionMode
    ];
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    // Inline settings override the user's file for this instance only.
    if (this.outputStyle) args.push('--settings', JSON.stringify({ outputStyle: this.outputStyle }));
    if (this.claudeSessionId) args.push('--resume', this.claudeSessionId);
    args.push(...this.extraArgs);

    let proc;
    try {
      proc = spawn(this.claudePath, args, {
        cwd: this.cwd,
        env: { ...process.env, NIKUI: '1' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      this._fail(spawnMessage(this.claudePath, err), err.code || null);
      return;
    }
    this.proc = proc;
    this.everStarted = true;

    proc.on('error', (err) => this._fail(spawnMessage(this.claudePath, err), err.code || null));
    proc.stdout.setEncoding('utf8');
    // Only while this is still the process. A restart replaces it 300ms later
    // while the old one has up to five seconds to flush: its last `result`
    // would otherwise be counted against the new one — doubling the cost and
    // inventing a turn — and its half-line would corrupt the new init.
    proc.stdout.on('data', (chunk) => { if (this.proc === proc) this._onStdout(chunk); });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this._notice(text, 'stderr');
    });
    proc.on('exit', (code, signal) => {
      // A restart may already have replaced this process; if so, its exit is
      // history and must not touch the live one.
      if (this.proc !== proc && this.proc !== null) return;
      this.proc = null;
      this._streamMsgId = null;
      this._clearBackground();
      if (this.status !== STATUS.STOPPED) {
        this._setStatus(code === 0 || code === null ? STATUS.STOPPED : STATUS.ERROR);
        if (code) this._notice(`Instance exited with code ${code}${signal ? ` (${signal})` : ''}.`, 'exit');
      }
      this.emit('meta');
    });

    // total_cost_usd is cumulative per PROCESS and restarts at zero on resume,
    // so anchor it to what this conversation has already cost.
    this._costBaseline = this.totalCost;
    this.processStartedAt = Date.now();

    this._clearBackground();
    // A process starting is not news about the conversation: one that had
    // finished is still finished, and stays the green it was before a reload.
    if (this.status !== STATUS.DONE) this._setStatus(STATUS.IDLE);
    this.emit('meta');
  }

  stop() {
    this._clearBackground();
    this._setStatus(STATUS.STOPPED);
    // Nothing half-read carries over into the next process's first line.
    this._stdoutBuf = '';
    // As pause() and dispose() do: a drain timer outliving the process it was
    // waiting for is a timer that re-arms itself once a second forever.
    this._clearDrain();
    this._abandonRunningTools();
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try { proc.stdin.end(); } catch (_) { /* already closed */ }
    // Give it a moment to flush, then make sure it is gone. A CLI that ignores
    // SIGTERM would otherwise sit there holding memory.
    setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) { /* gone */ } }, 1500);
    setTimeout(() => {
      try { if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL'); } catch (_) { /* gone */ }
    }, 5000);
    this.emit('meta');
  }

  restart({ keepContext = true } = {}) {
    const resumeId = keepContext ? this.claudeSessionId : null;
    this.stop();
    setTimeout(() => {
      this.claudeSessionId = resumeId;
      if (!keepContext) this.resetConversation();
      this.start();
    }, 300);
  }

  /**
   * Everything a fresh start must forget. Kept in one place because a field
   * left behind here shows up later as a wrong total in the status sheet.
   */
  resetConversation() {
    this.items = [];
    this._itemIndex.clear();
    this._streamedMsgIds.clear();
    this._blockToItem.clear();
    this._streamMsgId = null;
    this.totalCost = 0;
    this._costBaseline = 0;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.pendingUsage = null;
    this.turns = 0;
    this.lastDurationMs = 0;
    this.turnStartedAt = null;
    this.finishedAt = 0;
    this.contextTokens = 0;
    this.lastError = null;
    this.replayed = false;
    this.droppedItems = 0;
    this.turnLog = [];
    this.interrupts = 0;
    this.errors = 0;
    this.compactions = 0;
    this.lastCompactedAt = 0;
    this._turnTools = [];
    this.startedAt = Date.now();
    this.emit('reset');
  }

  dispose() {
    // Marked before stopping: a panel that outlives its instance must not be
    // able to respawn an untracked process.
    this.disposed = true;
    this._clearDrain();
    this.stop();
    this.removeAllListeners();
    if (this._flushTimer) clearTimeout(this._flushTimer);
  }

  // ---- input --------------------------------------------------------------

  /**
   * `opts.sent` is what the model should receive when that differs from what
   * was typed — a prompt snippet appends a standing instruction, and repeating
   * it in the panel on every turn would bury the conversation in boilerplate.
   */
  send(text, attachments, opts) {
    const prompt = String(text || '').trim();
    const files = Array.isArray(attachments) ? attachments : [];
    const outgoing = String((opts && opts.sent) || prompt).trim();
    const snippets = (opts && opts.snippets) || [];
    if (!outgoing && !files.length) return;
    // Nothing goes out while the quota is spent; it waits in the queue instead
    // of being lost or bounced back as an error.
    if (this.isPaused && !(opts && opts.resumed)) { this.enqueue(text, attachments, opts); return; }
    if (!this.isRunning) this.start();
    if (!this.isRunning) return;

    let renamedFrom = null;
    if (this.autoTitle && !this.customTitle) {
      const t = nextTicket(this.ticket, prompt);
      if (t !== this.ticket) {
        renamedFrom = this.ticket;
        this.ticket = t;
        this.emit('meta');
      }
    }

    this._upsert({
      id: `u${this._seq++}`,
      kind: 'user',
      text: prompt,
      snippets: snippets.slice(),
      images: files.map((f) => ({ name: f.name, mediaType: f.mediaType, data: f.data })),
      at: Date.now()
    });
    // A tab that renames itself is startling if it happens behind your back.
    // The first name is expected; a change of name is worth a line.
    if (renamedFrom) {
      this._notice(
        `Renamed ${renamedFrom} → ${this.ticket}: this instance is now following ${this.ticket}. ` +
        'Rename it yourself to pin a name.',
        'info'
      );
    }

    this._interrupted = false;
    this._limitThisTurn = false;
    this._turnTools = [];
    this.turnStartedAt = Date.now();
    this._setStatus(STATUS.WORKING);

    // Images first, then the prompt — the order the CLI expects.
    const content = files.map((f) => ({
      type: 'image',
      source: { type: 'base64', media_type: f.mediaType, data: f.data }
    }));
    // Permission /watch gave, carried on the next thing the model reads.
    let said = outgoing || 'See the attached image.';
    if (this.pendingNote) { said += '\n\n' + this.pendingNote; this.pendingNote = null; }
    content.push({ type: 'text', text: said });

    this._write({ type: 'user', message: { role: 'user', content } });
  }

  /**
   * Queue a prompt instead of dropping it while a turn is in flight. Anything
   * submitted while busy stacks up and drains in order once the instance is
   * genuinely finished.
   */
  submit(text, attachments, opts) {
    const hasContent = String(text || '').trim() || (attachments && attachments.length);
    if (!hasContent) return null;
    if (this.inTurn || this.queue.length) {
      this.enqueue(text, attachments, opts);
      return 'queued';
    }
    this.send(text, attachments, opts);
    return 'sent';
  }

  enqueue(text, attachments, opts) {
    this.queue.push({
      id: 'q' + (this._seq++),
      text: String(text || ''),
      // A queued prompt keeps whatever it was going to send, so waiting in the
      // queue cannot quietly strip the instruction off it.
      sent: (opts && opts.sent) || null,
      snippets: (opts && opts.snippets) || [],
      attachments: Array.isArray(attachments) ? attachments : []
    });
    this.emit('queue');
    // Only start the clock if nothing is running: the delay is measured from the
    // end of the turn, not from when the prompt was typed.
    if (this.isReadyForQueue()) this._scheduleDrain();
  }

  /** Move a queued prompt to the front, and send it now if nothing is running. */
  promote(id) {
    const at = this.queue.findIndex((q) => q.id === id);
    if (at <= 0) {
      if (at === 0 && this.isReadyForQueue()) { this._clearDrain(); this._scheduleDrain(0); }
      return at === 0;
    }
    const [item] = this.queue.splice(at, 1);
    this.queue.unshift(item);
    this.emit('queue');
    if (this.isReadyForQueue()) { this._clearDrain(); this._scheduleDrain(0); }
    return true;
  }

  /** Take a prompt back out of the queue, text and all, to be edited. */
  reclaim(id) {
    const at = this.queue.findIndex((q) => q.id === id);
    if (at < 0) return null;
    const [item] = this.queue.splice(at, 1);
    this.emit('queue');
    return item;
  }

  unqueue(id) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.id !== id);
    if (this.queue.length !== before) this.emit('queue');
  }

  clearQueue() {
    if (!this.queue.length) return;
    this.queue = [];
    this._clearDrain();
    this.emit('queue');
  }

  /**
   * Ready means the turn is over and nothing is still running in the
   * background — a tool left in flight would otherwise collide with the
   * next prompt.
   */
  isReadyForQueue() {
    if (this.isPaused) return false;
    if (!this.isRunning || this.inTurn) return false;
    // Only a tool that is genuinely still running counts. It used to be "any
    // tool not marked done", which included tools abandoned by a process that
    // died mid-turn and tools replayed from a transcript that ends in one —
    // neither of which will ever finish, so the queue never drained again and
    // every prompt put in it was silently kept forever.
    return !this.items.some((i) => i.kind === 'tool' && i.status === 'running');
  }

  get queueDelayMs() {
    return QUEUE_DELAY_MS;
  }

  _scheduleDrain(delay) {
    if (this._drainTimer || !this.queue.length) return;
    this.drainAt = Date.now() + (delay === undefined ? QUEUE_DELAY_MS : delay);
    this.emit('queue');
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      this.drainAt = null;
      if (!this.queue.length) return;
      if (!this.isReadyForQueue()) { this._scheduleDrain(1000); return; }
      const next = this.queue.shift();
      this.emit('queue');
      this.send(next.text, next.attachments, { sent: next.sent, snippets: next.snippets });
    }, delay === undefined ? QUEUE_DELAY_MS : delay);
  }

  _clearDrain() {
    if (this._drainTimer) clearTimeout(this._drainTimer);
    this._drainTimer = null;
    this.drainAt = null;
  }

  /** Live counters for the header: elapsed time and tokens. */
  stats() {
    const u = this.usage;
    return {
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheCreate: u.cacheCreate,
      total: u.input + u.output + u.cacheRead + u.cacheCreate,
      cost: this.totalCost,
      turns: this.turns,
      elapsedMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : this.lastDurationMs,
      running: !!this.turnStartedAt,
      background: this.backgroundAgents,
      shells: this.backgroundShells,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      ci: this.ci || null
    };
  }

  /** What the CI watch on this instance's PR last saw; null when there is none. */
  setCi(state) {
    this.ci = state || null;
    this.emit('ci', this.ci);
  }

  interrupt() {
    if (!this.isRunning || !this.isBusy) return;
    // Between turns only agents in the background are running. An interrupt
    // stops those as well, but no result follows to say so.
    if (this.inTurn) this._interrupted = true;
    else this._stoppingAgents = true;
    this._write({
      type: 'control_request',
      request_id: `nikui-${this._controlSeq++}`,
      request: { subtype: 'interrupt' }
    });
  }

  respondToPermission(requestId, allow, message) {
    if (!this.isRunning) {
      // The CLI that asked is gone. Saying "working" here left the instance
      // spinning forever with nothing behind it.
      this._notice(
        'This instance is not running any more, so that answer could not be delivered. ' +
        'Send a message to start it again.',
        'info'
      );
      return false;
    }
    this._write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow
          ? { behavior: 'allow', updatedInput: undefined }
          : { behavior: 'deny', message: message || 'Denied from NikUI' }
      }
    });
    this._setStatus(STATUS.WORKING);
    return true;
  }

  /**
   * Stop talking to the CLI until the account's quota comes back. Anything
   * queued stays queued, anything sent meanwhile joins the queue, and a turn
   * that was in flight is remembered so it can be picked up again.
   */
  pause({ until, reason }) {
    // Only a turn is cut off. Agents in the background may be on a model the
    // limit does not cover, and they are left to finish or fail on their own.
    const wasBusy = this.inTurn;
    this.pausedUntil = until || 0;
    this.pauseReason = reason || 'limit';
    if (wasBusy) this.interruptedByPause = true;
    this._clearDrain();
    if (wasBusy) this._setStatus(STATUS.STOPPED);
    this._notice(pauseMessage(this.pauseReason, this.pausedUntil), 'info');
    this.emit('meta');
    this.emit('queue');
  }

  /**
   * Back to work. An instance that was cut off mid-turn is nudged to carry on;
   * one that was only holding a queue simply starts draining it again. The
   * queue itself is never touched either way.
   */
  resume({ nudge } = {}) {
    // Owed a nudge either way it was cut off: caught mid-turn by the pause, or
    // failed on the limit itself — before the pause, or in a window since
    // reloaded. Either is work somebody asked for that did not finish.
    const owed = this.interruptedByPause || this.cutByLimit;
    if (!this.pausedUntil && !owed) return false;
    this.pausedUntil = 0;
    this.pauseReason = null;
    this.interruptedByPause = false;
    this.cutByLimit = false;
    this._notice(owed ? 'The quota reset. Picking up where this left off.' : 'The quota reset.', 'info');
    this.emit('meta');

    // Sent, not submitted: submitting would put the nudge at the back of the
    // queue, which is both the wrong order — the interrupted work came first —
    // and a change to a queue that is supposed to come through untouched. The
    // queue drains after this turn, exactly as it would have done.
    if (owed && nudge) this.send(nudge, [], { resumed: true });
    else if (this.queue.length) this._scheduleDrain(0);
    else this.emit('queue');
    return true;
  }

  /**
   * The account's limit, seen in this instance's own stream. Said to the
   * window once per turn — it pauses everything — with the reset time if the
   * words carry one, which the CLI's do: "resets 9:30am (Asia/Riyadh)".
   */
  _limitHit(text, quota) {
    if (this._limitThisTurn) return;
    this._limitThisTurn = true;
    const q = quota || {};
    this.emit('exhausted', {
      status: 'rejected', type: q.rateLimitType || q.rate_limit_type || null, used: 1,
      // The CLI's own number when it sends one, the words when it does not.
      resetsAt: seconds(q.resetsAt !== undefined ? q.resetsAt : q.resets_at) || resetFromText(text, Date.now()),
      windows: { fiveHour: null, week: null, weekOverage: null },
      at: Date.now(), fromMessage: true
    });
  }

  rename(title) {
    this.customTitle = title ? String(title).trim() || null : null;
    this.emit('meta');
  }

  _write(obj) {
    if (!this.proc || !this.proc.stdin.writable) return;
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
    catch (err) { this._notice(`Write failed: ${err.message}`, 'error'); }
  }

  /**
   * Rebuild the conversation from the on-disk transcript. Entries there carry
   * the same message shapes as the live stream, so they go through the same
   * handlers. Only the tail is replayed: transcripts reach hundreds of MB.
   */
  async replayTranscript(maxEntries) {
    if (this.replayed || !this.claudeSessionId) return false;
    const file = transcriptPath(this.cwd, this.claudeSessionId);
    if (!file || !fs.existsSync(file)) return false;
    this.replayed = true;

    const keep = maxEntries || 250;
    const window = [];
    await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let entry;
        try { entry = JSON.parse(line); } catch (_) { return; }
        if (entry.isSidechain) return; // subagent chatter, not this conversation
        if (entry.type !== 'user' && entry.type !== 'assistant') return;
        if (!entry.message) return;
        window.push(entry);
        if (window.length > keep) window.shift();
      });
      rl.on('close', resolve);
      rl.on('error', resolve);
    });

    for (const entry of window) {
      if (entry.type === 'assistant') { this._handleAssistant(entry); continue; }
      const content = entry.message.content;
      const isToolResult = Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
      if (isToolResult) { this._handleUser(entry); continue; }
      let text = typeof content === 'string' ? content
        : Array.isArray(content) ? (content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')) : '';
      text = String(text || '').trim();
      if (!text || text.startsWith('<')) continue;
      this._upsert({ id: 'h' + (this._seq++), kind: 'user', text, images: [], at: Date.parse(entry.timestamp) || Date.now() });
      if (this.autoTitle && !this.customTitle) {
        const t = nextTicket(this.ticket, text);
        if (t !== this.ticket) this.ticket = t;
      }
      if (this.autoTitle && !this.autoLabel) this.autoLabel = shortLabel(text);
    }

    // Nothing replayed from a file is in flight, whatever the file ended on.
    this._abandonRunningTools();
    if (window.length) { this._notice('Restored from the saved transcript.', 'info'); this.emit('meta'); }
    return window.length > 0;
  }

  /**
   * What is left of the plan's own limits: the five-hour session window and the
   * weekly one. The CLI reports these whenever they move, straight off the
   * `anthropic-ratelimit-unified-*` headers, and they belong to the account
   * rather than to this instance — so this normalises them and hands them up
   * for every instance to share.
   */
  _handleRateLimit(event) {
    const info = event.rate_limit_info || event.rateLimitInfo;
    if (!info) return;

    const windows = info.unifiedWindows || info.unified_windows || {};
    const limits = {
      status: info.status || 'allowed',
      type: info.rateLimitType || info.rate_limit_type || null,
      used: num(info.utilization),
      resetsAt: seconds(info.resetsAt !== undefined ? info.resetsAt : info.resets_at),
      overage: info.isUsingOverage === true || info.overageInUse === true,
      windows: {
        fiveHour: window5(windows.five_hour || windows.fiveHour),
        week: window5(windows.seven_day || windows.sevenDay),
        weekOverage: window5(windows.seven_day_overage_included || windows.sevenDayOverageIncluded)
      },
      at: Date.now()
    };

    const was = this.limits && this.limits.status;
    this.limits = limits;
    if (limits.status === 'rejected') this.emit('exhausted', limits);
    // Being told you are nearly out, after the fact, is no use.
    if (limits.status !== was && limits.status !== 'allowed') {
      this._notice(describeLimit(limits), limits.status === 'rejected' ? 'error' : 'info');
    }
    this.emit('limits', limits);
    this.emit('meta');
  }

  /**
   * The line where the conversation the model can see stops being the
   * conversation on screen. Field names are read generously: this is the CLI's
   * event, and a marker that renders for an unexpected shape is better than one
   * that silently does not.
   */
  _handleCompaction(event) {
    const meta = event.compact_metadata || event.compactMetadata || event;
    const trigger = meta.trigger || meta.reason || 'auto';
    const before = Number(meta.pre_tokens || meta.preTokens || meta.tokens_before || 0) || 0;

    this.compactions += 1;
    this.lastCompactedAt = Date.now();
    this._upsert({
      id: `c${this._seq++}`,
      kind: 'compact',
      trigger: String(trigger).toLowerCase() === 'manual' ? 'manual' : 'automatic',
      before,
      at: Date.now()
    });
    // The window the meter is measuring starts again here.
    this.contextTokens = 0;
    this.emit('meta');
  }

  /**
   * An empty panel and a conversation that failed to load look identical, and
   * the second one is alarming — the cost and the token count are right there
   * in the header. Say which it is.
   */
  noteMissingTranscript() {
    if (!this.claudeSessionId) return false;
    const file = transcriptPath(this.cwd, this.claudeSessionId);
    this._notice(
      'This conversation could not be read back from disk, so nothing is shown above. ' +
      `Its session is ${this.claudeSessionId}; NikUI looked for ${file}. ` +
      'Sending a message still resumes it if the CLI can find it.',
      'info'
    );
    return true;
  }

  // ---- output parsing -----------------------------------------------------

  _onStdout(chunk) {
    this._stdoutBuf += chunk;
    const lines = this._stdoutBuf.split('\n');
    this._stdoutBuf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try { event = JSON.parse(trimmed); }
      catch (_) { continue; } // partial or non-JSON chatter
      try { this._handle(event); }
      catch (err) { this._notice(`Parse error: ${err.message}`, 'error'); }
    }
  }

  _handle(event) {
    switch (event.type) {
      case 'system': return this._handleSystem(event);
      case 'stream_event': return this._handleStream(event);
      case 'assistant': return this._handleAssistant(event);
      case 'user': return this._handleUser(event);
      case 'result': return this._handleResult(event);
      case 'control_request': return this._handleControlRequest(event);
      case 'control_response': return;
      case 'rate_limit_event': return this._handleRateLimit(event);
      default: return;
    }
  }

  _handleSystem(event) {
    if (event.subtype === 'background_tasks_changed') return this._handleBackgroundTasks(event.tasks);
    if (event.subtype === 'task_started') return this._rememberAgent(event);
    if (event.subtype === 'task_notification') return this._handleTaskNotification(event);
    // Compaction is the CLI's own business — it decides when the context is
    // full and summarises it. All we get is a boundary event, and all we have
    // to do is not pretend it did not happen: our transcript keeps every
    // message, while the model from here on has only a summary of them.
    if (event.subtype !== 'init') {
      if (/compact/i.test(event.subtype || '') || event.compact_metadata) this._handleCompaction(event);
      return;
    }
    this.claudeSessionId = event.session_id || this.claudeSessionId;
    this.meta = {
      model: event.model || null,
      tools: event.tools || [],
      slashCommands: event.slash_commands || []
    };
    // Not `event.cwd`. The CLI reports wherever it is working now, which after
    // it enters a git worktree is `.claude/worktrees/agent-…`, and taking that
    // as the instance's folder renamed it and filed it under a project of that
    // name. An instance stays in the folder it was started in.
    // Every turn opens with an init. One nobody here sent is the CLI starting
    // a turn by itself: to hand over what a background agent found, or
    // because a wakeup came due.
    if (!this.inTurn) this._beginOwnTurn();
    this.emit('meta');
  }

  _beginOwnTurn() {
    this._interrupted = false;
    this._limitThisTurn = false;
    this._turnTools = [];
    this.turnStartedAt = Date.now();
    this._setStatus(STATUS.WORKING);
  }

  /**
   * The CLI's whole list of what is running behind the conversation, sent
   * each time it changes, and empty once nothing is.
   */
  _handleBackgroundTasks(tasks) {
    this.backgroundTasks = (Array.isArray(tasks) ? tasks : [])
      .filter((t) => t && t.task_id)
      .map((t) => ({ id: t.task_id, type: t.task_type || null, description: t.description || '' }));
    // An agent can be sent to the background after it started in the foreground.
    for (const t of this.backgroundTasks) {
      const agent = this._agents.get(t.id);
      if (agent) agent.background = true;
    }
    this.emit('background');
    // Inside a turn, the turn's end decides where the instance rests.
    if (this.inTurn) return;
    if (this.backgroundWork) {
      if (this.status === STATUS.DONE) this._setStatus(STATUS.WORKING, true);
      return;
    }
    if (!this._inBackground) return;
    // Stopped on purpose, so nothing follows. Otherwise the CLI is about to
    // start a turn to hand over what the agents found.
    if (this._stoppingAgents) { this._setStatus(STATUS.DONE); return; }
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      if (this._inBackground && !this.backgroundWork) this._setStatus(STATUS.DONE);
    }, this.agentSettleMs);
    if (this._settleTimer.unref) this._settleTimer.unref();
  }

  /** Enough about an agent to say which one it was when it reports back. */
  _rememberAgent(event) {
    if (event.task_id && event.task_type === 'local_bash') {
      if (this._shells.size > 64) this._shells.clear();
      this._shells.set(event.task_id, { owned: !!event.owned_by_subagent });
      return;
    }
    if (!event.task_id || !AGENT_TASKS.has(event.task_type)) return;
    if (this._agents.size > 64) this._agents.clear();
    this._agents.set(event.task_id, {
      name: event.subagent_type || null,
      description: event.description || '',
      background: !!event.is_backgrounded
    });
  }

  /**
   * A background agent has settled. The turn the CLI starts next says what it
   * found; this line says why a turn started with nobody asking.
   */
  _handleTaskNotification(event) {
    const agent = this._agents.get(event.task_id);
    this._agents.delete(event.task_id);
    // One in the foreground reported back inside its own tool call already.
    if (!agent || !agent.background) return;
    const outcome = { completed: 'finished', failed: 'failed', stopped: 'was stopped', killed: 'was stopped' };
    this._notice(
      `${agent.name ? `The ${agent.name} agent` : 'A background agent'} ${outcome[event.status] || 'finished'}` +
      `${agent.description ? `: ${agent.description}` : ''}.`,
      'info'
    );
  }

  /** A process that is gone took whatever it ran in the background with it. */
  _clearBackground() {
    this.backgroundTasks = [];
    this._agents.clear();
    this._shells.clear();
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this._settleTimer = null;
  }

  /**
   * Where an instance rests once a turn is over. Agents that turn started may
   * still be running, and until they have reported back it is not done.
   */
  _settle() {
    if (this.backgroundWork) this._setStatus(STATUS.WORKING, true);
    else this._setStatus(STATUS.DONE);
  }

  // Partial deltas paint the message as it is generated. The CLI then re-emits
  // each block as its own single-block `assistant` event, so block indices there
  // are always 0 and cannot be used as keys. Tools key off the tool_use id, and
  // text already painted by deltas is skipped rather than appended twice.
  _handleStream(event) {
    const ev = event.event;
    if (!ev) return;
    if (ev.type === 'message_start') {
      this._streamMsgId = ev.message && ev.message.id;
      // Reconciliation only ever needs the message in flight, so keep these
      // bounded instead of letting them grow with the conversation.
      if (this._blockToItem.size > 256) this._blockToItem.clear();
      if (this._streamedMsgIds.size > 256) this._streamedMsgIds.clear();
      return;
    }
    const msgId = this._streamMsgId;
    if (!msgId) return;

    if (ev.type === 'content_block_start') {
      const block = ev.content_block || {};
      this._streamedMsgIds.add(msgId);
      if (block.type === 'text') {
        this._upsert({ id: `${msgId}:${ev.index}`, kind: 'text', text: '', streaming: true });
      } else if (block.type === 'thinking') {
        this._upsert({ id: `${msgId}:${ev.index}`, kind: 'thinking', text: '', streaming: true });
      } else if (block.type === 'tool_use' && block.id) {
        this._blockToItem.set(`${msgId}:${ev.index}`, toolItemId(block.id));
        this._upsert({ id: toolItemId(block.id), kind: 'tool', name: block.name, input: {}, rawInput: '', status: 'running', isError: false });
      }
      return;
    }

    const id = this._blockToItem.get(`${msgId}:${ev.index}`) || `${msgId}:${ev.index}`;

    if (ev.type === 'content_block_delta') {
      const item = this._itemIndex.get(id);
      if (!item) return;
      const d = ev.delta || {};
      if (d.type === 'text_delta') item.text = (item.text || '') + d.text;
      else if (d.type === 'thinking_delta') item.text = (item.text || '') + d.thinking;
      else if (d.type === 'input_json_delta') item.rawInput = (item.rawInput || '') + d.partial_json;
      else return;
      this._touch(item);
      return;
    }

    if (ev.type === 'content_block_stop') {
      const item = this._itemIndex.get(id);
      if (!item) return;
      item.streaming = false;
      if (item.kind === 'tool' && item.rawInput) {
        try {
          item.input = JSON.parse(item.rawInput);
          delete item.rawInput;
        } catch (_) { /* keep what streamed, it may still be arriving */ }
      }
      this._touch(item);
    }
  }

  _handleAssistant(event) {
    const msg = event.message;
    if (!msg || !Array.isArray(msg.content)) return;
    // The CLI marks the message that says the limit is spent: `error:
    // "rate_limit"`. That is the signal to trust — the words change between
    // versions, and the old wording is exactly what stopped being recognised.
    if (event.error === 'rate_limit' || msg.error === 'rate_limit') {
      this._limitHit(msg.content.map((c) => (c && c.type === 'text' ? c.text : '')).join(' '),
        event.quotaLimits || event.quota_limits || null);
    }
    // Every model call reports the prompt it was given; the newest one is the
    // live context size. Summing them would multiply it by the number of calls.
    if (msg.usage) {
      const u = readUsage(msg.usage);
      this.contextTokens = u.input + u.cacheRead + u.cacheCreate;
    }
    const msgId = msg.id || this._streamMsgId;
    const alreadyStreamed = msgId && this._streamedMsgIds.has(msgId);

    msg.content.forEach((block, index) => {
      if (block.type === 'tool_use') {
        // Keyed by tool_use id, so this fills in the authoritative input on the
        // very item the deltas created.
        if (!block.id) return;
        const existing = this._itemIndex.get(toolItemId(block.id));
        this._upsert({
          id: toolItemId(block.id),
          kind: 'tool',
          name: block.name,
          input: block.input || (existing && existing.input) || {},
          status: existing && existing.status === 'done' ? 'done' : 'running',
          result: existing ? existing.result : undefined,
          isError: existing ? !!existing.isError : false,
          agent: event.parent_tool_use_id || null
        });
        return;
      }

      if (alreadyStreamed) return; // deltas already rendered this block

      if (block.type === 'text' && block.text) {
        if (learnCommandArgs(block.text)) this.emit('meta');
        this._upsert({ id: `${event.uuid || msgId}:${index}`, kind: 'text', text: block.text, streaming: false, agent: event.parent_tool_use_id || null });
      } else if (block.type === 'thinking' && block.thinking) {
        this._upsert({ id: `${event.uuid || msgId}:t${index}`, kind: 'thinking', text: block.thinking, streaming: false });
      }
    });
  }

  /**
   * One row per finished turn — what every chart in /status is drawn from.
   * Capped so a long-lived instance cannot grow it without bound.
   */
  _logTurn(usage, costUsd, event, interrupted) {
    if (interrupted) this.interrupts += 1;
    const models = event.modelUsage ? Object.keys(event.modelUsage) : [];
    this.turnLog.push({
      n: this.turns,
      at: Date.now(),
      durationMs: this.lastDurationMs || 0,
      costUsd,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheCreate: usage.cacheCreate,
      contextTokens: this.contextTokens,
      tools: this._turnTools.slice(),
      model: models.length ? models[0] : (this.meta.model || null),
      interrupted: !!interrupted,
      isError: !!event.is_error && !interrupted
    });
    if (this.turnLog.length > 500) this.turnLog.splice(0, this.turnLog.length - 500);
    this._turnTools = [];
  }

  _handleUser(event) {
    const msg = event.message;
    if (!msg || !Array.isArray(msg.content)) return;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const item = this._itemIndex.get(toolItemId(block.tool_use_id));
      if (!item) continue;
      const result = clip(flattenContent(block.content), TOOL_RESULT_MAX);
      item.status = 'done';
      item.isError = !!block.is_error;
      item.result = result.text;
      item.resultLength = result.length;
      item.resultClipped = result.clipped;
      // The parsed input is authoritative; the raw JSON it streamed in as is a
      // second copy of the same bytes.
      delete item.rawInput;
      this._touch(item);
      // A push is where watching CI starts, whoever asked for it.
      if (item.name === 'Bash' && !item.isError && item.input) {
        const where = pushedFrom(item.input.command, this.cwd);
        if (where) this.emit('pushed', where);
      }
    }
  }

  _handleResult(event) {
    // total_cost_usd is cumulative for the session, so the turn's own cost is
    // the delta and the session total is simply the latest value.
    let turnCost = 0;
    if (typeof event.total_cost_usd === 'number') {
      const conversationCost = this._costBaseline + event.total_cost_usd;
      turnCost = Math.max(0, conversationCost - this.totalCost);
      this.totalCost = conversationCost;
    }
    // result.usage is per turn, unlike the assistant events, so this one sums.
    const turnUsage = event.usage ? readUsage(event.usage) : { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.usage.input += turnUsage.input;
    this.usage.output += turnUsage.output;
    this.usage.cacheRead += turnUsage.cacheRead;
    this.usage.cacheCreate += turnUsage.cacheCreate;
    this.turns += 1;
    // usage.iterations carries the final model call; its prompt is the context.
    // The top-level usage is the sum over every call in the turn, so a turn with
    // three tool calls would report roughly four times the real context.
    const iterations = event.usage && event.usage.iterations;
    if (Array.isArray(iterations) && iterations.length) {
      const last = readUsage(iterations[iterations.length - 1]);
      this.contextTokens = last.input + last.cacheRead + last.cacheCreate;
    }
    if (event.modelUsage) {
      for (const m of Object.values(event.modelUsage)) {
        if (m && m.contextWindow) { this.contextWindow = m.contextWindow; break; }
      }
    }
    this.lastDurationMs = event.duration_ms || (this.turnStartedAt ? Date.now() - this.turnStartedAt : 0);
    this.turnStartedAt = null;
    // When the turn ended, so "done" can stop shouting after a while.
    this.finishedAt = Date.now();
    const interrupted = this._interrupted;
    this._interrupted = false;
    this._upsert({
      id: `r${this._seq++}`,
      kind: 'result',
      isError: !!event.is_error && !interrupted,
      interrupted,
      subtype: event.subtype || null,
      text: interrupted ? 'Interrupted' : (event.is_error ? String(event.result || event.subtype || 'Error') : ''),
      durationMs: event.duration_ms || 0,
      numTurns: event.num_turns || 0,
      costUsd: turnCost
    });
    this._logTurn(turnUsage, turnCost, event, interrupted);
    // Belt and braces: if neither the rate limit event nor the marked message
    // arrived, the turn itself says so in words.
    const limited = !!event.is_error && !interrupted &&
      (this._limitThisTurn || looksRateLimited(event.result));
    if (limited) this._limitHit(event.result);
    this._limitThisTurn = false;
    if (limited) {
      this.cutByLimit = true;
    } else if (!event.is_error || interrupted) {
      // Finished, or stopped by somebody on purpose: nothing is owed.
      this.cutByLimit = false;
      this.interruptedByPause = false;
    }
    if (event.is_error && !interrupted) {
      this.errors += 1;
      this.lastError = String(event.result || event.subtype || 'error');
      this._setStatus(STATUS.ERROR);
    } else {
      this.lastError = null;
      this._settle();
    }
    this._abandonRunningTools();
    if (this.queue.length) { this._clearDrain(); this._scheduleDrain(); }
  }

  /**
   * The turn is over, so nothing is running — whatever the tool items say.
   *
   * A tool whose result never arrived is not still working: the CLI has
   * finished. Leaving it marked `running` spins a spinner forever, keeps the
   * item out of the trim window, and holds the queue shut.
   */
  _abandonRunningTools() {
    for (const item of this.items) {
      if (item.kind === 'tool' && item.status === 'running') {
        item.status = 'stopped';
        this._touch(item);
      }
    }
  }

  // Fires when the CLI asks to use a tool under a prompting permission mode.
  _handleControlRequest(event) {
    const req = event.request || {};
    if (req.subtype !== 'can_use_tool') return;
    this._upsert({
      id: `p${this._seq++}`,
      kind: 'permission',
      requestId: event.request_id,
      name: req.tool_name || 'tool',
      input: req.input || {},
      resolved: null
    });
    this._setStatus(STATUS.WAITING);
  }

  // ---- item plumbing ------------------------------------------------------

  _upsert(item) {
    const existing = this._itemIndex.get(item.id);
    if (existing) {
      Object.assign(existing, item);
      this._touch(existing);
    } else {
      this._itemIndex.set(item.id, item);
      this.items.push(item);
      if (item.kind === 'tool') this._turnTools.push(item.name || 'tool');
      this._trim();
      this._touch(item);
    }
  }

  /**
   * Drop the oldest items once the conversation outgrows its window. Anything
   * still in flight stays — a running tool has a result coming that would have
   * nothing to attach to, and an unanswered permission would strand the CLI.
   */
  _trim() {
    if (!this.maxItems || this.items.length <= this.maxItems) return;
    while (this.items.length > this.maxItems) {
      const head = this.items[0];
      // Live, not merely unfinished: a tool abandoned by a turn that ended is
      // never going to change again, and one of those at the head used to hold
      // the whole window open — the cap stopped applying at all.
      const busy = (head.kind === 'tool' && head.status === 'running') ||
        (head.kind === 'permission' && !head.resolved);
      if (busy) break; // and nothing behind it can go either
      this.items.shift();
      this._itemIndex.delete(head.id);
      this.droppedItems += 1;
    }
  }

  _touch(item) {
    this._dirty.add(item.id);
    if (this._flushTimer) return;
    // Coalesce delta storms into one repaint per frame-ish.
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      const ids = [...this._dirty];
      this._dirty.clear();
      const changed = ids.map((id) => this._itemIndex.get(id)).filter(Boolean);
      if (changed.length) this.emit('items', changed);
    }, 50);
  }

  _notice(text, level) {
    this._upsert({ id: `n${this._seq++}`, kind: 'notice', text, level: level || 'info' });
  }

  /**
   * Something went wrong that the instance cannot recover from on its own. It
   * is announced as well as written into the transcript, because the panel it
   * would be written into may not be open — and if the CLI never started, it
   * never will be.
   */
  _fail(message, code) {
    this.lastError = message;
    this._notice(message, 'error');
    this._setStatus(STATUS.ERROR);
    this.emit('failed', message, code || null);
  }

  /** `background`: working only because agents are, with no turn in flight. */
  _setStatus(status, background) {
    // A status set for any other reason ends that, and supersedes a stop.
    this._inBackground = status === STATUS.WORKING && !!background;
    if (!this._inBackground) this._stoppingAgents = false;
    if (this.status === status) return;
    const was = this.status;
    this.status = status;
    // Before the event, so whoever is looking can take it straight back off.
    if (status === STATUS.DONE && (was === STATUS.WORKING || was === STATUS.WAITING)) this.unread = true;
    else if (status === STATUS.WORKING || status === STATUS.WAITING) this.unread = false;
    this.emit('status', status);
  }

  /** Seen, or not: the blue dot comes off when somebody looks. */
  setUnread(value) {
    if (this.unread === !!value) return;
    this.unread = !!value;
    this.emit('unread', this.unread);
  }

  toJSON() {
    return {
      id: this.id,
      cwd: this.cwd,
      customTitle: this.customTitle,
      autoLabel: this.autoLabel,
      ticket: this.ticket,
      totalCost: this.totalCost,
      usage: this.usage,
      claudeSessionId: this.claudeSessionId
    };
  }
}

const toolItemId = (toolUseId) => `tool:${toolUseId}`;

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** The CLI reports reset times in seconds; everything here is in milliseconds. */
function seconds(value) {
  const n = num(typeof value === 'string' ? Number(value) : value);
  if (n === null) return null;
  return n > 1e11 ? n : Math.round(n * 1000);
}

function window5(w) {
  if (!w) return null;
  const used = num(w.utilization);
  const resetsAt = seconds(w.resetsAt !== undefined ? w.resetsAt : w.resets_at);
  if (used === null && resetsAt === null) return null;
  return { used: used === null ? 0 : used, resetsAt };
}

const LIMIT_WORD = { five_hour: 'five-hour', seven_day: 'weekly', overage: 'overage' };

/**
 * The CLI's own wording, for when the structured signals do not arrive.
 *
 * It has said "Claude AI usage limit reached" and it now says "You've hit your
 * session limit · resets 9:30am (Asia/Riyadh)" — the second of which the first
 * version of this did not match, and instances that failed that way were left
 * red when the reset came. Both are here, and "weekly" or "Opus" in place of
 * "session" too.
 */
const RATE_LIMITED = /usage limit reached|rate limit|quota (?:exceeded|reached)|hit your (?:[\w-]+ )?limit|\blimit reached\b/i;
const looksRateLimited = (text) => RATE_LIMITED.test(String(text || ''));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** How far a time zone is from UTC at a given moment, in milliseconds. */
function zoneOffset(at, zone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(new Date(at))) parts[p.type] = p.value;
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * When the words say the limit resets: "resets 9:30am (Asia/Riyadh)",
 * "resets 3am", "resets Sep 30, 10am (Europe/Berlin)".
 *
 * A wall-clock time in a named zone, turned into a moment — the next such
 * moment if no date is given, because a limit always resets in the future.
 * Anything it cannot read confidently is null, and the window falls back to
 * looking again in a while, which is slower and never wrong.
 */
function resetFromText(text, now) {
  const m = /resets\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i
    .exec(String(text || ''));
  if (!m) return null;
  const from = typeof now === 'number' ? now : Date.now();
  let zone = m[6] ? m[6].trim() : null;
  try { if (zone) new Intl.DateTimeFormat('en-US', { timeZone: zone }); }
  catch (_) { zone = null; }
  zone = zone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') hour += 12;
  const minute = m[4] ? Number(m[4]) : 0;
  if (hour > 23 || minute > 59) return null;

  // Today's date where the reset is, so "9:30am" means 9:30 there.
  const today = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(from))) today[p.type] = p.value;
  let year = +today.year;
  let month = +today.month - 1;
  let day = +today.day;
  const named = m[1] ? MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) : -1;
  if (m[1] && named < 0) return null;
  if (named >= 0) { month = named; day = Number(m[2]); }

  const at = (y, mo, d) => {
    const guess = Date.UTC(y, mo, d, hour, minute);
    const first = guess - zoneOffset(guess, zone);
    // Once more at the answer, for the day the clocks change.
    return guess - zoneOffset(first, zone);
  };
  let when = at(year, month, day);
  if (named >= 0) {
    if (when <= from) when = at(year + 1, month, day);
  } else {
    for (let i = 0; i < 2 && when <= from; i++) {
      const next = new Date(Date.UTC(year, month, day + 1));
      year = next.getUTCFullYear(); month = next.getUTCMonth(); day = next.getUTCDate();
      when = at(year, month, day);
    }
  }
  return when > from ? when : null;
}

function pauseMessage(reason, until) {
  const when = until ? ' It should be back ' + new Date(until).toLocaleString() + '.' : '';
  if (reason === 'limit') {
    return 'Paused: the account\u2019s usage limit is spent, so nothing is being sent.' + when +
      ' Anything you send meanwhile waits in the queue.';
  }
  return 'Paused.' + when;
}

/** What to say in the conversation when the account's limits start to bite. */
function describeLimit(limits) {
  const which = LIMIT_WORD[limits.type] || (limits.type || '').replace(/_/g, ' ') || 'usage';
  const when = limits.resetsAt ? ', resets ' + new Date(limits.resetsAt).toLocaleString() : '';
  if (limits.status === 'rejected') {
    return `Your ${which} limit is used up${when}. Claude will not answer again until it resets.`;
  }
  const pct = limits.used === null ? '' : ` (${Math.round(limits.used * 100)}% used)`;
  return `Approaching your ${which} limit${pct}${when}.`;
}

// A limit is owed its nudge for a day after it resets. A conversation left on
// the limit for longer than that is one somebody chose not to pick up again,
// and spending the quota on it unasked would be the wrong kind of helpful.
const OWED_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a conversation's transcript ends on the account's limit — the CLI
 * writes that message down, marked `error: "rate_limit"`, with the reset time
 * beside it — and so is owed a nudge when the quota comes back.
 *
 * This is what lets an instance recover whatever the window remembered about
 * it: the ones left red by the bug this was written for had nothing saved, and
 * their transcripts still ended on "You've hit your session limit".
 *
 * Only the end of the file is read; transcripts run to hundreds of megabytes.
 *
 * @returns {{at: number, resetsAt: number|null}|null}
 */
function endedOnLimit(file, now) {
  if (!file) return null;
  let tail = '';
  try {
    const size = fs.statSync(file).size;
    const want = Math.min(size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      tail = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }

  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!entry || entry.isSidechain) continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    // The last word in the conversation, whoever said it.
    if (entry.type !== 'assistant') return null;
    const content = (entry.message && entry.message.content) || [];
    const text = Array.isArray(content)
      ? content.map((c) => (c && c.type === 'text' ? c.text : '')).join(' ')
      : String(content || '');
    const marked = entry.error === 'rate_limit' || (entry.isApiErrorMessage && looksRateLimited(text));
    if (!marked) return null;
    const at = Date.parse(entry.timestamp) || 0;
    const q = entry.quotaLimits || {};
    const resetsAt = seconds(q.resetsAt) || resetFromText(text, at || Date.now());
    const from = typeof now === 'number' ? now : Date.now();
    if ((resetsAt || at) + OWED_FOR_MS < from) return null;
    return { at, resetsAt: resetsAt || null };
  }
  return null;
}

/** The state an instance may come back in, after a reload or a restart. */
function restoredStatus(status) {
  if (!status || status === STATUS.WORKING || status === STATUS.WAITING) {
    return status ? STATUS.STOPPED : STATUS.IDLE;
  }
  return status;
}

/** Say what to do about it, not just what happened. */
function spawnMessage(claudePath, err) {
  if (err && err.code === 'ENOENT') {
    return `Could not run "${claudePath}". Install the Claude Code CLI, or point nikui.claudePath at it.`;
  }
  if (err && err.code === 'EACCES') {
    return `"${claudePath}" is not executable. Check its permissions, or point nikui.claudePath elsewhere.`;
  }
  return `Could not start ${claudePath}: ${err && err.message ? err.message : 'unknown error'}`;
}

function readUsage(u) {
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0
  };
}

// Commands that take a fixed set of values, so the composer can offer them
// rather than expecting somebody to know them. Seeded with the ones we know,
// extended at runtime from the CLI's own replies, and — for the models — from
// the catalog the window reads out of the CLI itself.
//
// An entry is { value, label, detail }: the label and detail are what a row
// says, and only the value is ever typed into the prompt.
const COMMAND_ARGS = new Map();

// Everything on the Usage line, because the values are written after it in two
// different shapes and both are worth reading.
const USAGE_RE = /Usage:\s*\/([\w:.-]+)([^\n]*)/g;

// A value as the CLI prints one: a word, possibly with a [1m] on the end. The
// point of the shape is what it excludes — "or a full model ID" is prose.
const VALUE = /^[\w@[\].:/-]+$/;

/**
 * The values out of one Usage line, written either way the CLI writes them.
 *
 * `/effort <low|medium|high>` names them in the placeholder. `/model <name>`
 * cannot, because the set is open, so it lists them after: "Available: sonnet,
 * opus, …, or a full model ID". Both are read, because in both cases they are
 * what somebody is choosing between.
 */
function readValues(line) {
  const angled = /<([^>]+)>/.exec(line);
  const listed = /\bAvailable:\s*(.+)$/i.exec(line);
  const parts = [];
  if (angled && angled[1].includes('|')) parts.push.apply(parts, angled[1].split('|'));
  if (listed) parts.push.apply(parts, listed[1].split(','));
  return parts
    .map((v) => v.trim().replace(/[.,;]+$/, ''))
    .filter((v) => v && VALUE.test(v));
}

const described = (v) => ({ value: v.value, label: v.label || '', detail: v.detail || '' });

/**
 * Add values to a command's list, keeping what is already there.
 *
 * `atFront` is for the described ones: the model catalog is more useful than the
 * aliases the CLI's own reply names, so it goes above them however the two
 * happen to arrive. A described value replaces a bare one of the same name.
 */
function merge(name, values, atFront) {
  const have = COMMAND_ARGS.get(name) || [];
  const seen = new Map();
  for (const entry of (atFront ? values.concat(have) : have.concat(values))) {
    const old = seen.get(entry.value);
    if (!old) seen.set(entry.value, described(entry));
    else if (entry.label || entry.detail) {
      seen.set(entry.value, {
        value: old.value,
        label: entry.label || old.label,
        detail: entry.detail || old.detail
      });
    }
  }
  const next = [...seen.values()];
  const same = have.length === next.length &&
    have.every((v, i) => v.value === next[i].value && v.label === next[i].label);
  COMMAND_ARGS.set(name, next);
  return !same;
}

/** Read out of a reply the CLI just gave. */
function learnCommandArgs(text) {
  if (!text || text.indexOf('Usage:') < 0) return false;
  let found = false;
  let m;
  USAGE_RE.lastIndex = 0;
  while ((m = USAGE_RE.exec(text)) !== null) {
    const values = readValues(m[2]);
    if (values.length > 1 && merge(m[1], values.map((v) => ({ value: v })), false)) found = true;
  }
  return found;
}

/**
 * Values NikUI knows that the CLI never prints.
 *
 * The models are the case this exists for. The CLI's own reply lists the
 * aliases and then says "or a full model ID" — true, and not a list — while the
 * identifiers themselves are in the binary. The window reads them there and
 * hands them here, so the composer offers what this CLI actually knows.
 *
 * @returns {boolean} whether anything changed, so a page can be told
 */
function offerCommandArgs(name, values) {
  if (!name || !Array.isArray(values) || !values.length) return false;
  return merge(name, values.map(described), true);
}

// Known before any reply arrives, so "/effort " offers its values on a fresh
// instance rather than only after somebody has already run it once.
merge('effort', ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto']
  .map((v) => ({ value: v })), false);

function commandArgs() {
  const out = {};
  for (const [k, v] of COMMAND_ARGS) out[k] = v.map(described);
  return out;
}

function flattenContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

module.exports = {
  Session, STATUS, commandArgs, learnCommandArgs, offerCommandArgs, clip, restoredStatus,
  describeLimit, looksRateLimited, resetFromText, endedOnLimit, seconds, TOOL_RESULT_MAX, DEFAULT_MAX_ITEMS
};
