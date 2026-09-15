'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const { nextTicket } = require('./ticket');

const STATUS = {
  IDLE: 'idle',
  WORKING: 'working',
  WAITING: 'waiting',
  DONE: 'done',
  ERROR: 'error',
  STOPPED: 'stopped'
};

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
    this.ticket = opts.ticket || null;
    this.claudeSessionId = opts.claudeSessionId || null;

    this.status = STATUS.IDLE;
    this.items = [];
    this.totalCost = 0;
    this.lastError = null;
    this.meta = { model: null, tools: [], slashCommands: [] };
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.turns = 0;
    this.turnStartedAt = null;
    this.lastDurationMs = 0;

    this.proc = null;
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
  }

  get label() {
    return this.customTitle || this.ticket || path.basename(this.cwd || '') || 'claude';
  }

  get isRunning() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  get isBusy() {
    return this.status === STATUS.WORKING || this.status === STATUS.WAITING;
  }

  // ---- lifecycle ----------------------------------------------------------

  start() {
    if (this.isRunning) return;

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
      this._fail(`Could not start ${this.claudePath}: ${err.message}`);
      return;
    }
    this.proc = proc;

    proc.on('error', (err) => this._fail(`${this.claudePath}: ${err.message}`));
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

    this._setStatus(STATUS.IDLE);
    this.emit('meta');
  }

  stop() {
    this._setStatus(STATUS.STOPPED);
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try { proc.stdin.end(); } catch (_) { /* already closed */ }
    // Give it a moment to flush, then make sure it is gone.
    setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) { /* gone */ } }, 1500);
    this.emit('meta');
  }

  restart({ keepContext = true } = {}) {
    const resumeId = keepContext ? this.claudeSessionId : null;
    this.stop();
    setTimeout(() => {
      this.claudeSessionId = resumeId;
      if (!keepContext) {
        this.items = [];
        this._itemIndex.clear();
        this.totalCost = 0;
        this.emit('reset');
      }
      this.start();
    }, 300);
  }

  dispose() {
    this.stop();
    this.removeAllListeners();
    if (this._flushTimer) clearTimeout(this._flushTimer);
  }

  // ---- input --------------------------------------------------------------

  send(text, attachments) {
    const prompt = String(text || '').trim();
    const files = Array.isArray(attachments) ? attachments : [];
    if (!prompt && !files.length) return;
    if (!this.isRunning) this.start();
    if (!this.isRunning) return;

    if (this.autoTitle && !this.customTitle) {
      const t = nextTicket(this.ticket, prompt);
      if (t !== this.ticket) { this.ticket = t; this.emit('meta'); }
    }

    this._upsert({
      id: `u${this._seq++}`,
      kind: 'user',
      text: prompt,
      images: files.map((f) => ({ name: f.name, mediaType: f.mediaType, data: f.data })),
      at: Date.now()
    });
    this._interrupted = false;
    this.turnStartedAt = Date.now();
    this._setStatus(STATUS.WORKING);

    // Images first, then the prompt — the order the CLI expects.
    const content = files.map((f) => ({
      type: 'image',
      source: { type: 'base64', media_type: f.mediaType, data: f.data }
    }));
    content.push({ type: 'text', text: prompt || 'See the attached image.' });

    this._write({ type: 'user', message: { role: 'user', content } });
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
      running: !!this.turnStartedAt
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

  rename(title) {
    this.customTitle = title ? String(title).trim() || null : null;
    this.emit('meta');
  }

  _write(obj) {
    if (!this.proc || !this.proc.stdin.writable) return;
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
    catch (err) { this._notice(`Write failed: ${err.message}`, 'error'); }
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
      case 'rate_limit_event': return;
      default: return;
    }
  }

  _handleSystem(event) {
    if (event.subtype !== 'init') return;
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
        try { item.input = JSON.parse(item.rawInput); } catch (_) { /* keep what streamed */ }
      }
      this._touch(item);
    }
  }

  _handleAssistant(event) {
    const msg = event.message;
    if (!msg || !Array.isArray(msg.content)) return;
    if (msg.usage) this._addUsage(msg.usage, msg.id);
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
        this._upsert({ id: `${event.uuid || msgId}:${index}`, kind: 'text', text: block.text, streaming: false, agent: event.parent_tool_use_id || null });
      } else if (block.type === 'thinking' && block.thinking) {
        this._upsert({ id: `${event.uuid || msgId}:t${index}`, kind: 'thinking', text: block.thinking, streaming: false });
      }
    });
  }

  _handleUser(event) {
    const msg = event.message;
    if (!msg || !Array.isArray(msg.content)) return;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const item = this._itemIndex.get(toolItemId(block.tool_use_id));
      if (!item) continue;
      item.status = 'done';
      item.isError = !!block.is_error;
      item.result = flattenContent(block.content);
      this._touch(item);
    }
  }

  _handleResult(event) {
    if (typeof event.total_cost_usd === 'number') this.totalCost += event.total_cost_usd;
    this.turns += 1;
    this.lastDurationMs = event.duration_ms || (this.turnStartedAt ? Date.now() - this.turnStartedAt : 0);
    this.turnStartedAt = null;
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
      costUsd: event.total_cost_usd || 0
    });
    if (event.is_error && !interrupted) {
      this.lastError = String(event.result || event.subtype || 'error');
      this._setStatus(STATUS.ERROR);
    } else {
      this.lastError = null;
      this._setStatus(STATUS.DONE);
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
      this._touch(item);
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

  // Assistant events repeat cumulative usage for the same message id, so only
  // the first sighting of each id counts.
  _addUsage(usage, msgId) {
    if (msgId) {
      if (!this._usageSeen) this._usageSeen = new Set();
      if (this._usageSeen.has(msgId)) return;
      this._usageSeen.add(msgId);
    }
    this.usage.input += usage.input_tokens || 0;
    this.usage.output += usage.output_tokens || 0;
    this.usage.cacheRead += usage.cache_read_input_tokens || 0;
    this.usage.cacheCreate += usage.cache_creation_input_tokens || 0;
  }

  _notice(text, level) {
    this._upsert({ id: `n${this._seq++}`, kind: 'notice', text, level: level || 'info' });
  }

  _fail(message) {
    this.lastError = message;
    this._notice(message, 'error');
    this._setStatus(STATUS.ERROR);
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
      ticket: this.ticket,
      claudeSessionId: this.claudeSessionId
    };
  }
}

const toolItemId = (toolUseId) => `tool:${toolUseId}`;

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

module.exports = { Session, STATUS };
