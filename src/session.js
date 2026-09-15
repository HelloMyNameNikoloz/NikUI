'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { EventEmitter } = require('events');
const path = require('path');
const { nextTicket } = require('./ticket');
const { shortLabel } = require('./label');
const { transcriptPath } = require('./history');

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
    this._turnTools = [];

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
    this.queue = [];
    this._drainTimer = null;
    this.contextTokens = 0;
    this.contextWindow = 0;
    this.maxItems = opts.maxItems === undefined ? DEFAULT_MAX_ITEMS : opts.maxItems;
    // How many items have scrolled out of the window we keep. The panel says so
    // rather than pretending the conversation started there.
    this.droppedItems = 0;
  }

  get label() {
    return this.customTitle || this.ticket || this.autoLabel || path.basename(this.cwd || '') || 'claude';
  }

  get isRunning() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  get isBusy() {
    return this.status === STATUS.WORKING || this.status === STATUS.WAITING;
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
    proc.stdout.on('data', (chunk) => this._onStdout(chunk));
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

    this._setStatus(STATUS.IDLE);
    this.emit('meta');
  }

  stop() {
    this._setStatus(STATUS.STOPPED);
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
    this._turnTools = [];
    this.turnStartedAt = Date.now();
    this._setStatus(STATUS.WORKING);

    // Images first, then the prompt — the order the CLI expects.
    const content = files.map((f) => ({
      type: 'image',
      source: { type: 'base64', media_type: f.mediaType, data: f.data }
    }));
    content.push({ type: 'text', text: outgoing || 'See the attached image.' });

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
    if (this.isBusy || this.queue.length) {
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
    if (!this.isRunning || this.isBusy) return false;
    return !this.items.some((i) => i.kind === 'tool' && i.status !== 'done');
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
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow
    };
  }

  interrupt() {
    if (!this.isRunning || !this.isBusy) return;
    this._interrupted = true;
    this._write({
      type: 'control_request',
      request_id: `nikui-${this._controlSeq++}`,
      request: { subtype: 'interrupt' }
    });
  }

  respondToPermission(requestId, allow, message) {
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
  }

  /**
   * Stop talking to the CLI until the account's quota comes back. Anything
   * queued stays queued, anything sent meanwhile joins the queue, and a turn
   * that was in flight is remembered so it can be picked up again.
   */
  pause({ until, reason }) {
    const wasBusy = this.isBusy;
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
    if (!this.pausedUntil) return false;
    const interrupted = this.interruptedByPause;
    this.pausedUntil = 0;
    this.pauseReason = null;
    this.interruptedByPause = false;
    this._notice('The quota reset. Picking up where this left off.', 'info');
    this.emit('meta');

    // Sent, not submitted: submitting would put the nudge at the back of the
    // queue, which is both the wrong order — the interrupted work came first —
    // and a change to a queue that is supposed to come through untouched. The
    // queue drains after this turn, exactly as it would have done.
    if (interrupted && nudge) this.send(nudge, [], { resumed: true });
    else if (this.queue.length) this._scheduleDrain(0);
    else this.emit('queue');
    return true;
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
      if (!this.autoLabel) this.autoLabel = shortLabel(text);
    }

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
    if (event.cwd) this.cwd = event.cwd;
    this.emit('meta');
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
    // Belt and braces: if the rate limit event never arrives, the turn itself
    // says so in words.
    if (event.is_error && !interrupted && looksRateLimited(event.result)) {
      this.emit('exhausted', {
        status: 'rejected', type: null, used: 1, resetsAt: null,
        windows: { fiveHour: null, week: null, weekOverage: null },
        at: Date.now(), fromMessage: true
      });
    }
    if (event.is_error && !interrupted) {
      this.errors += 1;
      this.lastError = String(event.result || event.subtype || 'error');
      this._setStatus(STATUS.ERROR);
    } else {
      this.lastError = null;
      this._setStatus(STATUS.DONE);
    }
    if (this.queue.length) { this._clearDrain(); this._scheduleDrain(); }
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
      const busy = (head.kind === 'tool' && head.status !== 'done') ||
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

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
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

/** The CLI's own wording, for when the structured event does not arrive. */
const RATE_LIMITED = /usage limit reached|rate limit|quota (?:exceeded|reached)/i;
const looksRateLimited = (text) => RATE_LIMITED.test(String(text || ''));

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

// Commands that take a fixed set of values. Seeded with the ones we know, then
// extended at runtime by reading "Usage: /cmd <a|b|c>" out of the CLI's own reply.
const COMMAND_ARGS = new Map([
  ['effort', ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto']]
]);

const USAGE_RE = /Usage:\s*\/([\w:.-]+)\s*<([^>]+)>/g;

function learnCommandArgs(text) {
  if (!text || text.indexOf('Usage:') < 0) return false;
  let found = false;
  let m;
  USAGE_RE.lastIndex = 0;
  while ((m = USAGE_RE.exec(text)) !== null) {
    const values = m[2].split('|').map((v) => v.trim()).filter((v) => v && !/\s/.test(v));
    if (values.length > 1) { COMMAND_ARGS.set(m[1], values); found = true; }
  }
  return found;
}

function commandArgs() {
  const out = {};
  for (const [k, v] of COMMAND_ARGS) out[k] = v;
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
  Session, STATUS, commandArgs, learnCommandArgs, clip, restoredStatus,
  describeLimit, looksRateLimited, seconds, TOOL_RESULT_MAX, DEFAULT_MAX_ITEMS
};
