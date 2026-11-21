'use strict';

/*
 * The Codex workspace: the conversations the ChatGPT app's Codex keeps on this
 * Mac, shown and driven from NikUI.
 *
 * Codex owns them. They live in ~/.codex, the ChatGPT app lists them, and the
 * `codex app-server` protocol is the supported way in — so NikUI keeps nothing
 * of its own about them: it asks for the list, and opening one resumes it.
 * Each thread is wrapped in a CodexSession that looks enough like a Claude
 * Session for the panel, the hub and the phone to treat it as one, which is
 * why the conversation view, the queue and the phone all work unchanged.
 *
 * Kept apart from the Claude instances on purpose: a separate list, a
 * separate manager, ids that start `cx-`. Nothing here touches what the
 * Claude side remembers across a reload.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { CodexIpc } = require('./codexIpc');
const { CodexCache } = require('./codexCache');
const { connectWs, daemonSockets, daemonProcess } = require('./codexSocket');
const { isAppHome } = require('./codexHome');

/**
 * Codex's own background app-server, if it is running. Through it NikUI can
 * write to conversations it holds — Codex in the terminal, and the daemon's
 * own — which a copy of our own could only read.
 */
async function openDaemon() {
  for (const file of daemonSockets()) {
    try { return daemonProcess(await connectWs(file)); } catch (_) { /* a stale socket: try the next */ }
  }
  return null;
}

const PREFIX = 'cx-';
const CODEX_COMMANDS = ['plan', 'goal', 'review', 'fork', 'undo', 'model', 'effort', 'steer'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const REQUEST_TIMEOUT_MS = 120000;
const RESULT_MAX = 20000;
const deliveryError = (message, delivery = 'unknown') => Object.assign(new Error(message), { delivery });
const unclosableTransports = new WeakSet();
function closeTransport(proc, ownership, log = () => {}) {
  if (!proc) return;
  try {
    if (ownership === 'borrowed') {
      if (typeof proc.close === 'function') proc.close();
      else if (typeof proc.disconnect === 'function') proc.disconnect();
      else if (!unclosableTransports.has(proc)) {
        unclosableTransports.add(proc);
        log('codex: BORROWED_TRANSPORT_UNCLOSABLE (' + (proc.constructor?.name || 'handle') + '): no close/disconnect; connection may remain open');
      }
      // An untyped injected handle might be the external child's actual
      // stdin. EOF can terminate it; never use that as borrowed cleanup.
    } else proc.kill();
  } catch (_) { /* already closed */ }
}
// The newest turns are what anybody opens a conversation to see; older ones
// stay in Codex.
const TURNS_SHOWN = 40;
// Once a conversation is on screen, how many of its newest turns are read again.
const TURNS_RECENT = 5;
// How often a turn the ChatGPT app runs for us is read back.
const FOLLOW_MS = 1500;

// Where the CLI is on a Mac, newest-install first. The ChatGPT app carries its
// own copy, so Codex works here even with nothing installed separately.
const CANDIDATES = [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  path.join(os.homedir(), '.local', 'bin', 'codex'),
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/Codex.app/Contents/Resources/codex'
];

function findCodex(configured) {
  if (configured) return configured;
  for (const candidate of CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) { /* keep looking */ }
  }
  return 'codex';
}

/** The Codex folder when none is chosen. */
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// ---- the protocol ------------------------------------------------------------

/** One `codex app-server` for the window, spoken to in JSON-RPC over stdio. */
class CodexClient extends EventEmitter {
  constructor({ codexPath, spawnFn, daemonFn, log, home, args, env, appAccount, unavailableReason } = {}) {
    super();
    this.unavailableReason = unavailableReason || null;
    this.codexPath = this.unavailableReason ? null : findCodex(codexPath);
    this.spawnFn = spawnFn || spawn;
    // The account's folder, and what the app-server is given on top for it.
    this.home = home || null;
    this.args = args || [];
    this.env = env;
    this._disposed = false;
    // Given a spawnFn (tests), only that; otherwise the daemon first — but
    // the daemon is the ChatGPT app's, so only on the app's own account.
    const canBorrow = appAccount === undefined ? !this.home || isAppHome(this.home) : appAccount;
    this.daemonFn = daemonFn !== undefined ? daemonFn : (spawnFn || !canBorrow ? null : openDaemon);
    this.viaDaemon = false;
    this.ownership = 'owned';
    this.log = log || (() => {});
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this._parts = [];
  }

  get alive() {
    return !!this.proc;
  }

  start() {
    if (this._disposed) return Promise.reject(new Error('Codex client is closed'));
    if (this.unavailableReason) return Promise.reject(new Error(this.unavailableReason));
    if (this.ready) return this.ready;
    const opening = this.daemonFn ? Promise.resolve().then(this.daemonFn).catch(() => null) : Promise.resolve(null);
    this.ready = opening.then((daemon) => this._begin(daemon));
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  _begin(daemon) {
    if (this._disposed) {
      closeTransport(daemon, 'borrowed', this.log);
      throw new Error('Codex client is closed');
    }
    let proc = daemon;
    if (!proc) {
      try {
        const baseEnv = this.env === undefined ? process.env : this.env;
        const env = this.home ? Object.assign({}, baseEnv, { CODEX_HOME: this.home }) : baseEnv;
        proc = this.spawnFn(this.codexPath, ['app-server'].concat(this.args), { stdio: ['pipe', 'pipe', 'pipe'], env });
      } catch (err) {
        return Promise.reject(err);
      }
    }
    this.viaDaemon = !!daemon;
    this.ownership = daemon ? 'borrowed' : 'owned';
    this.log(daemon ? 'codex: using the Codex daemon' : 'codex: started an app-server of our own');
    this.proc = proc;
    proc.stdout.setEncoding && proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { if (this.proc === proc) this._read(chunk); });
    proc.stderr.on('data', (chunk) => { if (this.proc === proc) this.log('codex: ' + String(chunk).trim().slice(0, 400)); });
    const gone = (err) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = null;
      this._parts = [];
      const why = err && err.message ? err.message : 'Codex stopped';
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(deliveryError(why)); }
      this.pending.clear();
      this.emit('exit', why);
    };
    proc.on('error', (err) => gone(err.code === 'ENOENT'
      ? new Error(`Could not run "${this.codexPath}". Install Codex (or the ChatGPT app), or point nikui.codexPath at it.`)
      : err));
    proc.on('exit', () => gone(null));
    const ready = this.request('initialize', {
      clientInfo: { name: 'nikui', title: 'NikUI', version: '1' },
      capabilities: { experimentalApi: true }
    }).then((info) => {
      this.notify('initialized');
      return info;
    });
    // A failed start must not be remembered as the start.
    ready.catch(() => { if (this.proc === proc) closeTransport(proc, this.ownership, this.log); });
    return ready;
  }

  // A reply can be a hundred megabytes (a history full of generated images).
  // Only the newest chunk is searched for the line's end, and the pieces are
  // joined once: searching the whole buffer on every chunk took half a minute.
  _read(chunk) {
    let text = String(chunk);
    let at;
    while ((at = text.indexOf('\n')) >= 0) {
      this._parts.push(text.slice(0, at));
      text = text.slice(at + 1);
      const line = this._parts.join('').trim();
      this._parts = [];
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      this._dispatch(msg);
    }
    if (text) this._parts.push(text);
  }

  _dispatch(msg) {
    if (msg.id != null && !msg.method) {
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      clearTimeout(waiting.timer);
      if (msg.error) waiting.reject(deliveryError(msg.error.message || 'Codex refused',
        msg.error.data?.accepted === false ? 'not_written' : 'unknown'));
      else waiting.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) {
      // Codex asking us something — an approval, mostly. Nobody to ask means no.
      if (!this.emit('request', msg)) this.respondError(msg.id, 'Not handled by NikUI');
      return;
    }
    if (msg.method) this.emit('notification', msg.method, msg.params || {});
  }

  _write(obj) {
    return this._writeOutcome(obj) === 'submitted';
  }

  _writeOutcome(obj) {
    const proc = this.proc;
    if (!proc || proc.stdin.writable === false) return 'not_written';
    try { proc.stdin.write(JSON.stringify(obj) + '\n'); return this.proc === proc ? 'submitted' : 'unknown'; }
    catch (error) { return error.delivery === 'not_written' ? 'not_written' : 'unknown'; }
  }

  request(method, params) {
    if (!this.proc) return Promise.reject(deliveryError('Codex is not running', 'not_written'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(deliveryError(`Codex did not answer ${method}`));
      }, REQUEST_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const delivery = this._writeOutcome({ jsonrpc: '2.0', id, method, params: params || {} });
      if (delivery !== 'submitted') {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(deliveryError('Codex write could not be confirmed', delivery));
      }
    });
  }

  notify(method, params) {
    this._write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  respond(id, result) {
    return this._write({ jsonrpc: '2.0', id, result });
  }

  respondOutcome(id, result) { return this._writeOutcome({ jsonrpc: '2.0', id, result }); }

  respondError(id, message) {
    return this._write({ jsonrpc: '2.0', id, error: { code: -32601, message } });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(deliveryError('closed')); }
    this.pending.clear();
    closeTransport(proc, this.ownership, this.log);
  }
}

// ---- items ----------------------------------------------------------------

function textOf(content) {
  return (content || []).filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n').trim();
}

function clip(text) {
  const s = String(text == null ? '' : text);
  return s.length > RESULT_MAX ? { result: s.slice(0, RESULT_MAX), resultClipped: true, resultLength: s.length }
    : { result: s, resultClipped: false, resultLength: s.length };
}

// Codex runs everything as `/bin/zsh -lc "…"`; the command is the part inside.
function bareCommand(command) {
  const s = String(command || '');
  const m = /^\S*\/(?:ba|z)?sh -lc (["'])([\s\S]*)\1$/.exec(s);
  return m ? m[2].replace(/\\(["\\$`])/g, '$1') : s;
}

function toolStatus(status) {
  if (status === 'inProgress') return 'running';
  if (status === 'declined') return 'stopped';
  return 'done';
}

function mcpText(result) {
  if (!result) return '';
  const parts = (result.content || []).map((c) => {
    if (c && c.type === 'text') return c.text;
    if (c && c.type === 'image') return '[screenshot]';
    return JSON.stringify(c);
  });
  return parts.join('\n');
}

// ---- pictures ----------------------------------------------------------------
// Codex works with pictures as paths on this Mac: screenshots it took, images
// it made, files it was shown. A panel on a phone cannot open a path, so each
// is read (and made small, if it is big) and sent along as data. That takes a
// moment, so an item is drawn first and its pictures follow: what is still to
// be fetched rides on the item under `_pic`, `_pics` or `_inline`, and never
// reaches the panel.

const dataUrl = (img) => `data:${img.mediaType};base64,${img.data}`;
const MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const isLocal = (src) => !/^(https?:|data:)/i.test(src);

/** Images inside an MCP tool's answer — the screenshots computer use takes. */
function mcpImages(result) {
  return ((result && result.content) || [])
    .filter((c) => c && c.type === 'image' && c.data)
    .map((c) => ({ mediaType: c.mimeType || 'image/png', data: c.data, name: 'screenshot' }));
}

/** Every panel item a Codex thread item becomes: usually one, sometimes a picture too. */
function itemsFrom(item, at) {
  if (!item || !item.type) return [];
  if (item.type === 'imageView') {
    const name = path.basename(String(item.path || 'image'));
    return [{ id: 'iv:' + item.id, kind: 'text', text: '*Looking at ' + name + '…*', at,
      _pic: { src: item.path, caption: null, missing: 'Looked at `' + item.path + '`' } }];
  }
  if (item.type === 'imageGeneration') {
    const caption = item.revisedPrompt ? '*' + item.revisedPrompt + '*' : null;
    const src = item.savedPath || (item.result ? 'data:image/png;base64,' + item.result : null);
    if (src && item.status !== 'inProgress' && item.status !== 'generating') {
      return [{ id: 'ig:' + item.id, kind: 'text', text: (caption ? caption + '\n\n' : '') + '*Loading image…*', at,
        _pic: { src, caption, missing: (caption ? caption + '\n\n' : '') + '*The image is no longer on this Mac.*' } }];
    }
    if (item.failure) return [{ id: 'ig:' + item.id, kind: 'notice', text: 'Image generation failed: ' + (item.failure.message || 'unknown'), level: 'error', at }];
    return item.status === 'inProgress' || item.status === 'generating'
      ? [{ id: 'ig:' + item.id, kind: 'tool', name: 'ImageGeneration', input: {}, status: 'running', result: '' }] : [];
  }
  const one = itemFrom(item, at);
  if (!one) return [];
  if (item.type === 'mcpToolCall' && item.result) {
    const shots = mcpImages(item.result);
    if (shots.length) {
      return [one, { id: 'shot:' + item.id, kind: 'text', at, text: '*Screenshot…*',
        _pics: shots.map(dataUrl), _asText: 'screenshot' }];
    }
  }
  return [one];
}

/** Whether an item still has pictures to fetch. */
const hasPictures = (item) => !!(item && (item._pic || item._pics || item._inline));

/** The item as the panel gets it, before its pictures are in. */
function bare(item) {
  if (!hasPictures(item)) return item;
  const copy = Object.assign({}, item);
  delete copy._pic; delete copy._pics; delete copy._inline; delete copy._asText;
  return copy;
}

/** What an item becomes once its pictures are fetched, as fields to change; null if nothing. */
async function picturesFor(item, cache) {
  if (item._pic) {
    const img = await cache.picture(item._pic.src);
    if (!img) return { text: item._pic.missing };
    return { text: (item._pic.caption ? item._pic.caption + '\n\n' : '') + `![${img.name || 'image'}](${dataUrl(img)})` };
  }
  if (item._pics) {
    const imgs = (await Promise.all(item._pics.map((src) => cache.picture(src)))).filter(Boolean);
    if (item._asText) {
      return { text: imgs.length ? imgs.map((img, i) => `![${item._asText} ${i + 1}](${dataUrl(img)})`).join('\n\n') : '*Screenshot not available.*' };
    }
    if (!imgs.length) return null;
    return { images: imgs, text: /^\[\d+ images?\]$/.test(item.text) ? '' : item.text };
  }
  if (item._inline) {
    const found = [];
    item.text.replace(MD_IMAGE, (whole, alt, src) => { if (isLocal(src)) found.push(src); return whole; });
    const imgs = new Map();
    await Promise.all(found.map(async (src) => imgs.set(src, await cache.picture(src))));
    return {
      text: item.text.replace(MD_IMAGE, (whole, alt, src) => {
        const img = imgs.get(src);
        return img ? `![${alt}](${dataUrl(img)})` : whole;
      })
    };
  }
  return null;
}

/** A prompt as Codex takes it: its text, then any pictures. */
function inputOf(text, files) {
  const input = [];
  if (text) input.push({ type: 'text', text, text_elements: [] });
  for (const f of files || []) {
    if (f && f.data) input.push({ type: 'image', url: `data:${f.mediaType || 'image/png'};base64,${f.data}` });
  }
  return input;
}

/** The folders a permission request reaches, in a line. */
function fileReach(fsp) {
  const list = [].concat(fsp.write || fsp.writableRoots || [], fsp.read || fsp.readableRoots || []);
  return list.length ? list.map(String).join(', ') : 'files outside the workspace';
}

/** A Codex thread item as the panel draws it, or null for what it does not show. */
function itemFrom(item, at) {
  if (!item || !item.type) return null;
  switch (item.type) {
    case 'userMessage': {
      const text = textOf(item.content);
      const sources = (item.content || [])
        .filter((c) => c && (c.type === 'image' || c.type === 'localImage'))
        .map((c) => (c.type === 'image' ? c.url : c.path))
        .filter(Boolean);
      if (!text && !sources.length) return null;
      const shown = {
        id: 'u:' + (item.clientId || item.id), kind: 'user',
        text: text || `[${sources.length} image${sources.length === 1 ? '' : 's'}]`, images: [], at
      };
      if (sources.length) shown._pics = sources;
      return shown;
    }
    case 'agentMessage':
      return Object.assign({ id: item.id, kind: 'text', text: item.text || '', at },
        [...String(item.text || '').matchAll(MD_IMAGE)].some((m) => isLocal(m[2])) ? { _inline: true } : {});
    case 'plan':
      return { id: item.id, kind: 'text', text: item.text || '', at };
    case 'reasoning': {
      const text = (item.summary && item.summary.length ? item.summary : (item.content || [])).join('\n\n').trim();
      return { id: item.id, kind: 'thinking', text };
    }
    case 'commandExecution':
      return Object.assign({
        id: 'tool:' + item.id, kind: 'tool', name: 'Bash',
        input: { command: bareCommand(item.command), cwd: item.cwd },
        status: toolStatus(item.status),
        isError: item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0)
      }, clip(item.aggregatedOutput || ''));
    case 'fileChange': {
      const changes = item.changes || [];
      return Object.assign({
        id: 'tool:' + item.id, kind: 'tool', name: changes.length === 1 && changes[0].kind && changes[0].kind.type === 'add' ? 'Write' : 'Edit',
        input: { file_path: changes.map((c) => c.path).join(', ') },
        status: toolStatus(item.status),
        isError: item.status === 'failed' || item.status === 'declined'
      }, clip(changes.map((c) => c.diff || '').join('\n')));
    }
    case 'mcpToolCall':
      return Object.assign({
        id: 'tool:' + item.id, kind: 'tool', name: `mcp__${item.server}__${item.tool}`,
        input: item.arguments && typeof item.arguments === 'object' ? item.arguments : { arguments: item.arguments },
        status: toolStatus(item.status === 'inProgress' ? 'inProgress' : 'completed'),
        isError: !!item.error
      }, clip(item.error ? (item.error.message || JSON.stringify(item.error)) : mcpText(item.result)));
    case 'dynamicToolCall':
      return Object.assign({
        id: 'tool:' + item.id, kind: 'tool', name: item.tool || 'tool',
        input: item.arguments && typeof item.arguments === 'object' ? item.arguments : {},
        status: toolStatus(item.status), isError: item.success === false
      }, clip((item.contentItems || []).map((c) => c.text || '').join('\n')));
    case 'webSearch':
      return {
        id: 'tool:' + item.id, kind: 'tool', name: 'WebSearch',
        input: { query: item.query || (item.action && item.action.query) || '' }, status: 'done', result: ''
      };
    case 'imageView':
      return { id: 'tool:' + item.id, kind: 'tool', name: 'Read', input: { file_path: item.path }, status: 'done', result: '' };
    case 'contextCompaction':
      return { id: 'c:' + item.id, kind: 'compact', trigger: 'auto' };
    default:
      return null;
  }
}

// ---- one conversation -------------------------------------------------------

const STATUS = { IDLE: 'idle', WORKING: 'working', WAITING: 'waiting', DONE: 'done', ERROR: 'error', STOPPED: 'stopped' };

function shortName(text) {
  const line = String(text || '').replace(/^#+\s*/gm, '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > 48 ? line.slice(0, 47).trimEnd() + '…' : line;
}

/**
 * A Codex thread, shaped like a Session: the same items, events and calls the
 * hub and the panel already use. Things Codex has no counterpart for (cost,
 * quota pauses, background agents) sit at their empty values.
 */
class CodexSession extends EventEmitter {
  constructor(thread, workspace) {
    super();
    this.provider = 'codex';
    this.workspace = workspace;
    this.threadId = thread.id;
    this.id = PREFIX + thread.id;
    this.cwd = thread.cwd || workspace.defaultCwd || os.homedir();
    this.customTitle = null;
    this.autoLabel = null;
    this.items = [];
    this._index = new Map();
    // What each item was last drawn from, so reading a turn again redraws
    // (and resends) only what changed.
    this._drawnFrom = new Map();
    this._drawnTurns = new Set();
    // The turns as Codex gave them, oldest first: what the cache keeps.
    this._kept = [];
    this.queue = [];
    this.drainAt = null;
    this.droppedItems = 0;
    this.maxItems = 0;
    this.meta = { model: thread.model || null, slashCommands: CODEX_COMMANDS.slice(), mode: 'default', goal: null, usingMac: null };
    this.model = thread.model || '';
    this.effort = thread.reasoningEffort || '';
    this.permissionMode = null;
    this.outputStyle = '';
    this.totalCost = 0;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.turns = 0;
    this.errors = 0;
    this.interrupts = 0;
    this.compactions = 0;
    this.turnLog = [];
    this.contextTokens = 0;
    this.contextWindow = 0;
    this.startedAt = (thread.createdAt || 0) * 1000 || Date.now();
    this.finishedAt = 0;
    this.activeAt = 0;
    this.runStartedAt = 0;
    this.runDurationMs = 0;
    this.unread = false;
    this.ticket = null;
    this.prUrl = null;
    this.prPane = null;
    this.prPinned = false;
    this.claudeSessionId = null;
    this.replayed = false;
    this.everStarted = false;
    this.backgroundAgents = 0;
    this.backgroundShells = 0;
    this.backgroundTasks = [];
    this.shellList = [];
    this.ci = null;
    this.lastError = null;
    this.pausedUntil = 0;
    this.limits = null;
    this.proc = null;
    this.loaded = false;
    this.readOnly = false;
    this.writerAuthority = 'unknown';
    this.turnId = null;
    this.status = STATUS.IDLE;
    this._seq = 0;
    this._starting = null;
    this._commanding = 0;
    this._historyVersion = 0;
    this._goalVersion = 0;
    this._macCalls = new Map();
    this._stoppedMacCalls = new Set();
    this._chosenSettings = {};
    this.update(thread);
  }

  /** What the list says about it now: name, preview, when it last moved. */
  update(thread) {
    const name = thread.name || null;
    const changed = name !== this.customTitle || (thread.preview && shortName(thread.preview) !== this.autoLabel);
    this.customTitle = name;
    if (thread.preview) this.autoLabel = shortName(thread.preview);
    if (thread.cwd) this.cwd = thread.cwd;
    const moved = (thread.recencyAt || thread.updatedAt || 0) * 1000;
    const advanced = moved > this.activeAt;
    if (advanced) this.activeAt = moved;
    // Read-only here because the ChatGPT app has it: follow along, and try
    // again for the lock if something is waiting to be sent.
    if (this.readOnly && this.loaded && !this._following) {
      this._following = (async () => {
        if (advanced) await this._loadTurns(false);
        if (this.queue.length && await this._takeWriter()) this._drain();
      })().catch(() => {}).finally(() => { this._following = null; });
    }
    if (!this.loaded) {
      const type = thread.status && thread.status.type;
      const next = type === 'active' ? STATUS.WORKING : type === 'systemError' ? STATUS.ERROR : STATUS.IDLE;
      if (next !== this.status) { this.status = next; this.emit('status', next); }
    }
    if (changed) this.emit('meta');
  }

  get label() {
    return this.customTitle || this.autoLabel || path.basename(this.cwd || '') || 'Codex';
  }

  get isRunning() { return this.loaded && this.workspace.client.alive; }
  get inTurn() { return !!this.turnId; }
  get isWorking() { return this.status === STATUS.WORKING || this.status === STATUS.WAITING; }
  get isBusy() { return this.isWorking; }
  get isPaused() { return false; }
  get isAsleep() { return !this.loaded; }
  get hasHistory() { return true; }
  get queueDelayMs() { return 0; }

  // ---- items ----

  /**
   * Draw an item from Codex: as it is now, then again once its pictures are
   * in. The same item drawn twice is left alone, pictures and all.
   */
  _place(item) {
    const from = JSON.stringify(item);
    if (this._drawnFrom.get(item.id) === from && this._index.has(item.id)) return this._index.get(item.id);
    this._drawnFrom.set(item.id, from);
    const shown = this._upsert(bare(item));
    if (hasPictures(item)) {
      picturesFor(item, this.workspace.cache).then((fields) => {
        // Only if nothing newer was drawn for it meanwhile.
        if (fields && this._drawnFrom.get(item.id) === from) this._upsert(Object.assign({ id: item.id }, fields));
      }, () => {});
    }
    return shown;
  }

  _upsert(item) {
    const existing = this._index.get(item.id);
    if (existing) Object.assign(existing, item);
    else { this._index.set(item.id, item); this.items.push(item); }
    this.emit('items', [existing || item]);
    return existing || item;
  }

  _notice(text, level) {
    this._upsert({ id: 'n' + (this._seq++), kind: 'notice', text, level: level || 'info', at: Date.now() });
  }

  /** Settings returned on resume, or changed by another Codex client. */
  _settings(settings) {
    const mode = settings.collaborationMode;
    // A response from the old turn must not replace a choice for the next.
    const chosen = (key, value) => {
      return Object.prototype.hasOwnProperty.call(this._chosenSettings, key) ? this._chosenSettings[key] : value;
    };
    const model = chosen('model', settings.model || (mode && mode.settings && mode.settings.model));
    let changed = false;
    if (model && model !== this.meta.model) { this.model = model; this.meta.model = model; changed = true; }
    const effort = chosen('effort', settings.effort !== undefined ? settings.effort : settings.reasoningEffort !== undefined
      ? settings.reasoningEffort : mode && mode.settings ? mode.settings.reasoning_effort : undefined);
    if (effort !== undefined && (effort || '') !== this.effort) { this.effort = effort || ''; changed = true; }
    const nextMode = chosen('mode', mode && mode.mode);
    if ((nextMode === 'plan' || nextMode === 'default') && nextMode !== this.meta.mode) {
      this.meta.mode = nextMode;
      changed = true;
    }
    if (changed) this.emit('meta');
  }

  _goal(goal) {
    const next = goal ? { objective: goal.objective, status: goal.status } : null;
    this._goalVersion += 1;
    if (JSON.stringify(next) === JSON.stringify(this.meta.goal)) return;
    this.meta.goal = next;
    this.emit('meta');
  }

  /** Older servers and ephemeral threads may not support goals. */
  async _readGoal() {
    const version = this._goalVersion;
    const res = await this.workspace.client.request('thread/goal/get', { threadId: this.threadId });
    if (version === this._goalVersion && res && res.goal !== undefined) this._goal(res.goal);
    return this.meta.goal;
  }

  /** Keep overlapping computer calls visible until all of them finish. */
  _usingMac(item, running) {
    if (!item || item.type !== 'mcpToolCall' || item.server !== 'cua_repl') return;
    if (running) {
      if (this._stoppedMacCalls.has(item.id)) return;
      const had = this._macCalls.get(item.id);
      this._macCalls.set(item.id, { since: had ? had.since : Date.now(), title: (item.arguments && item.arguments.title) || null });
    } else {
      this._stoppedMacCalls.add(item.id);
      this._macCalls.delete(item.id);
    }
    const next = [...this._macCalls.values()].pop() || null;
    if (JSON.stringify(next) === JSON.stringify(this.meta.usingMac)) return;
    this.meta.usingMac = next;
    this.emit('meta');
  }

  _clearMac() {
    for (const id of this._macCalls.keys()) this._stoppedMacCalls.add(id);
    this._macCalls.clear();
    if (!this.meta.usingMac) return;
    this.meta.usingMac = null;
    this.emit('meta');
  }

  _turnSettings() {
    const model = this.meta.model || this.model;
    const settings = { model: model || null, effort: this.effort || null };
    if (model) settings.collaborationMode = {
      mode: this.meta.mode,
      settings: { model, reasoning_effort: this.effort || null, developer_instructions: null }
    };
    return settings;
  }

  /** Forget only the choices the server just accepted, preserving any newer ones. */
  _appliedSettings(settings) {
    const values = { model: settings.model, effort: settings.effort || '', mode: settings.collaborationMode && settings.collaborationMode.mode };
    for (const key of Object.keys(values)) {
      if (this._chosenSettings[key] === values[key]) delete this._chosenSettings[key];
    }
  }

  /** A thread held by the app may not have reported its model on resume. */
  async _resolveModel() {
    if (this.meta.model || (this.meta.mode !== 'plan' && this._chosenSettings.mode === undefined && !this.effort)) return;
    const models = await this.workspace.models();
    const model = models.find((m) => m.isDefault) || models[0];
    if (!model) throw new Error('Codex did not report a model. Use /model <id> before sending.');
    this._settings({ model: model.model || model.id, effort: this.effort || model.defaultReasoningEffort });
  }

  _setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    if (status === STATUS.DONE || status === STATUS.ERROR || status === STATUS.STOPPED) this.finishedAt = Date.now();
    this.emit('status', status);
  }

  // ---- lifecycle ----

  /** Resume the thread in our app-server and draw its recent turns. */
  start() {
    if (this.loaded || this._starting) return this._starting || Promise.resolve();
    const client = this.workspace.client;
    this._starting = (async () => {
      // What was kept from last time is drawn at once; Codex is then asked
      // only for what is newer.
      const kept = this.workspace.cache.read(this.threadId);
      if (kept && !this._kept.length) {
        this._kept = kept.turns;
        this._keptAt = kept.savedAt;
        this._more = kept.more;
        if (kept.more) this._notice('Older turns are in Codex; these are the latest ' + kept.turns.length + '.', 'info');
        for (const turn of kept.turns) this._drawTurn(turn);
        this._setStatus(kept.turns.length ? STATUS.DONE : STATUS.IDLE);
      }
      await client.start();
      // The history first: reading needs no lock, so a conversation the
      // ChatGPT app is holding still shows everything it said.
      await this._loadTurns(true);
      this.loaded = true;
      this.everStarted = true;
      await this._takeWriter();
      await this._readGoal().catch(() => {});
      this.emit('meta');
      this.workspace._changed();
      this._drain();
    })().catch((err) => {
      this.lastError = err.message;
      if (!this._failedOnce) this._notice('Could not open this Codex conversation: ' + err.message, 'error');
      this._failedOnce = true;
      this._setStatus(STATUS.ERROR);
    }).finally(() => { this._starting = null; });
    return this._starting;
  }

  /**
   * Draw the latest turns. Again later is harmless: items keep their ids.
   * Once some are on screen only the newest few are read, unless more came
   * since than those few cover.
   */
  async _loadTurns(first) {
    const version = this._historyVersion;
    const reader = await this.workspace.reader();
    const read = (limit) => reader.request('thread/turns/list', {
      threadId: this.threadId, limit, sortDirection: 'desc', itemsView: 'full'
    });
    const known = this._drawnTurns;
    let page = await read(known.size ? TURNS_RECENT : TURNS_SHOWN);
    const newest = (page && page.data) || [];
    if (known.size && page && page.nextCursor && !newest.some((t) => known.has(t.id))) page = await read(TURNS_SHOWN);
    const full = !known.size || page.data !== newest;
    const turns = ((page && page.data) || []).slice().reverse();
    if (version !== this._historyVersion) return;
    this.emit('provider-evidence', turns);
    if (first && full && page && page.nextCursor && !this._more) {
      this._more = true;
      this._notice('Older turns are in Codex; these are the latest ' + turns.length + '.', 'info');
    }
    for (const turn of turns) this._drawTurn(turn);
    this._keep(turns, full, page && !!page.nextCursor);
    const last = turns[turns.length - 1];
    if (last && last.status === 'inProgress') {
      this.turnId = last.id;
      this._setStatus(STATUS.WORKING);
    } else if (first || (this.readOnly && !this._awaitingApp)) {
      if (this.readOnly) this.turnId = null;
      if (!this.inTurn) this._clearMac();
      this._setStatus(this._drawnTurns.size ? STATUS.DONE : STATUS.IDLE);
    }
  }

  /** Remember the turns just read, for the cache. A full read starts its week again. */
  _keep(turns, full, more) {
    const byId = new Map(this._kept.map((t) => [t.id, t]));
    for (const turn of turns) {
      if (byId.has(turn.id)) Object.assign(byId.get(turn.id), turn);
      else { byId.set(turn.id, turn); this._kept.push(turn); }
    }
    if (full) { this._keptAt = Date.now(); this._more = more || this._more; }
    if (this._kept.length > TURNS_SHOWN) { this._kept = this._kept.slice(-TURNS_SHOWN); this._more = true; }
    this.workspace.cache.write(this.threadId, { turns: this._kept, more: this._more, savedAt: this._keptAt || Date.now() });
  }

  /**
   * Become the thread's writer, which sending needs. Codex lets one process
   * write a thread at a time, and the ChatGPT app keeps every conversation it
   * has open: then this one is read-only here until the app lets go.
   */
  async _takeWriter() {
    if (this._durableQueueOwner?.blocked(this)) return false;
    try {
      const resumed = await this.workspace.client.request('thread/resume', { threadId: this.threadId, excludeTurns: true });
      if (resumed) this._settings(resumed);
      if (resumed && resumed.thread) this.update(resumed.thread);
      this.writerAuthority = 'engine';
      if (this.readOnly) {
        this.readOnly = false;
        this._notice('The ChatGPT app let go of this conversation; it can be continued here now.', 'info');
        this.workspace._changed();
      }
      return true;
    } catch (err) {
      if (!/active writer/i.test(err.message)) { this.writerAuthority = 'unknown'; throw err; }
      this.writerAuthority = 'external';
      if (!this.readOnly) {
        this.readOnly = true;
        this._notice('Open in the ChatGPT app, so read-only here: Codex lets one app write to a conversation at a time. ' +
          'What you send here is passed to the app to send; if the app cannot take it, it waits in the queue until the app lets go.', 'info');
        this.workspace._changed();
      }
      return false;
    }
  }

  _drawTurn(turn) {
    const at = (turn.startedAt || 0) * 1000 || undefined;
    for (const item of turn.items || []) {
      this._usingMac(item, turn.status === 'inProgress' && item.status === 'inProgress');
      for (const shown of itemsFrom(item, at)) this._place(shown);
    }
    if (turn.status !== 'inProgress') this._place(this._resultOf(turn));
    if (!this._drawnTurns.has(turn.id)) { this._drawnTurns.add(turn.id); this.turns += 1; }
  }

  _resultOf(turn) {
    const failed = turn.status === 'failed';
    return {
      id: 'r:' + turn.id, kind: 'result',
      isError: failed, interrupted: turn.status === 'interrupted',
      text: failed && turn.error ? turn.error.message : '',
      durationMs: turn.durationMs || 0,
      at: (turn.completedAt || 0) * 1000 || Date.now()
    };
  }

  stop() { /* the thread belongs to Codex; there is no process of ours to end */ }
  restart() { this._notice('Codex conversations carry on where they are; there is nothing to restart.', 'info'); }

  dispose() {
    this.disposed = true;
    if (this._writerTimer) clearTimeout(this._writerTimer);
    if (this._appTimer) clearTimeout(this._appTimer);
    this._historyVersion += 1;
    this._clearMac();
    this.removeAllListeners();
  }

  rename(title) {
    const name = String(title || '').trim();
    this.customTitle = name || null;
    this.emit('meta');
    this.workspace._changed();
    if (name) this.workspace.client.start().then(() =>
      this.workspace.client.request('thread/name/set', { threadId: this.threadId, name })).catch(() => {});
  }

  setUnread(value) {
    const next = !!value;
    if (next === this.unread) return;
    this.unread = next;
    this.emit('unread');
    this.workspace._changed();
  }

  // ---- talking ----

  submit(text, attachments, opts) {
    if (this._durableQueueOwner) return this._durableQueueOwner.submit(this, text, attachments, opts);
    const has = String(text || '').trim() || String((opts && opts.sent) || '').trim() || (attachments && attachments.length);
    if (!has) return null;
    const command = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
    if (command) {
      const name = command[1];
      const args = (command[2] || '').trim();
      this._commanding += 1;
      this._commands = (this._commands || Promise.resolve()).then(() => {
        if (!CODEX_COMMANDS.includes(name)) throw new Error('Unknown Codex command: /' + name);
        return this._command(name, args, attachments, opts);
      }).catch((err) => this._notice('/' + name + ': ' + err.message, 'error')).finally(() => {
        this._commanding -= 1;
        this._drain();
      });
      return 'sent';
    }
    if (this._question && String(text || '').trim()) {
      this._answer(text);
      return 'sent';
    }
    // Not open yet, or held by the ChatGPT app: it waits in the queue, which
    // sends it the moment it can, rather than being drawn and then lost.
    if (this.inTurn || this.queue.length || this._sending || this._commanding || this.readOnly || !this.loaded) {
      if (!this.loaded) this.start();
      this.enqueue(text, attachments, opts);
      return 'queued';
    }
    this.send(text, attachments, opts);
    return 'sent';
  }

  /** Commands stay local; only their protocol requests reach Codex. */
  async _command(name, args, attachments, opts) {
    if (!this.loaded) await this.start();
    if (!this.loaded) throw new Error(this.lastError || 'the conversation did not open');
    const client = this.workspace.client;
    const threadId = this.threadId;
    switch (name) {
      case 'plan': {
        if (args && args !== 'on' && args !== 'off') throw new Error('Use /plan on or /plan off.');
        const mode = args ? (args === 'on' ? 'plan' : 'default') : this.meta.mode === 'plan' ? 'default' : 'plan';
        this._chosenSettings.mode = mode;
        if (mode !== this.meta.mode) { this.meta.mode = mode; this.emit('meta'); }
        this._notice('Plan mode ' + (mode === 'plan' ? 'on.' : 'off.'));
        break;
      }
      case 'goal': {
        if (!args) {
          const goal = await this._readGoal();
          this._notice(goal ? 'Goal (' + goal.status + '): ' + goal.objective : 'No goal set.');
        } else if (args === 'clear') {
          const version = this._goalVersion;
          await client.request('thread/goal/clear', { threadId, origin: 'user' });
          if (version === this._goalVersion) this._goal(null);
          const goal = this.meta.goal;
          this._notice(goal ? 'Goal (' + goal.status + '): ' + goal.objective : 'Goal cleared.');
        } else {
          const status = args === 'pause' ? 'paused' : args === 'resume' ? 'active' : args === 'done' ? 'complete' : null;
          if (status && !this.meta.goal) throw new Error('No goal set.');
          const params = status ? { threadId, status, origin: 'user' } : { threadId, objective: args, status: 'active', origin: 'user' };
          const version = this._goalVersion;
          const res = await client.request('thread/goal/set', params);
          if (!res || !res.goal) throw new Error('Codex did not return the goal.');
          if (version === this._goalVersion) this._goal(res.goal);
          const goal = this.meta.goal;
          this._notice(goal ? 'Goal (' + goal.status + '): ' + goal.objective : 'Goal cleared.');
        }
        break;
      }
      case 'review': {
        if (this.inTurn || this._sending) throw new Error('Wait for the running turn before starting a review.');
        if (this.readOnly) throw new Error('The ChatGPT app holds this conversation.');
        const parts = args.split(/\s+/);
        let target = { type: 'uncommittedChanges' };
        if (parts[0] === 'commit') {
          if (parts.length !== 2 || !parts[1]) throw new Error('Use /review commit <sha>.');
          target = { type: 'commit', sha: parts[1] };
        } else if (args) {
          if (parts.length !== 1) throw new Error('Use /review <branch> or /review commit <sha>.');
          target = { type: 'baseBranch', branch: args };
        }
        const before = this.status;
        this._sending = true;
        this.runStartedAt = Date.now();
        this._setStatus(STATUS.WORKING);
        try {
          await this._resolveModel();
          const settings = this._turnSettings();
          await client.request('thread/settings/update', Object.assign({ threadId }, settings));
          this._appliedSettings(settings);
          const res = await client.request('review/start', { threadId, target, delivery: 'inline' });
          if (res.turn && res.turn.status === 'inProgress' && !this._drawnTurns.has(res.turn.id)) this.turnId = res.turn.id;
          this._notice('Review started in this conversation.');
        } catch (err) {
          if (!this.inTurn) { this.runStartedAt = 0; this._setStatus(before); }
          throw err;
        } finally { this._sending = false; this.workspace._changed(); }
        break;
      }
      case 'fork': {
        if (args) throw new Error('Use /fork.');
        const session = await this.workspace.fork(this);
        this._notice('Conversation forked.');
        this.emit('open', session.id, (opts && opts.from) || null);
        break;
      }
      case 'undo': {
        if (args) throw new Error('Use /undo.');
        if (this.inTurn || this._sending) throw new Error('Wait for the running turn before undoing it.');
        if (this.readOnly) throw new Error('The ChatGPT app holds this conversation.');
        const page = await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
        const last = page.data && page.data[0];
        if (!last) { this._notice('No turn to undo. Files on disk are NOT reverted.'); break; }
        if (last.status === 'inProgress') throw new Error('Wait for the running turn before undoing it.');
        const res = await client.request('thread/revert', { threadId, beforeTurnId: last.id });
        if (res.thread) this.update(res.thread);
        this._historyVersion += 1;
        this.items = [];
        this._index.clear();
        this._drawnFrom.clear();
        this._drawnTurns.clear();
        this._kept = [];
        this._more = false;
        this._keptAt = Date.now();
        this.turns = 0;
        this.turnId = null;
        this._clearMac();
        this.workspace.cache.write(threadId, { turns: [], more: false, savedAt: this._keptAt });
        this.emit('reset');
        try { await this._loadTurns(true); }
        finally { this._notice('Last turn removed. Files on disk are NOT reverted.'); }
        break;
      }
      case 'model':
      case 'effort': {
        const models = await this.workspace.models();
        if (name === 'model' && !args) {
          this._notice('Models (* current):\n' + models.map((m) =>
            (m.id === this.meta.model || m.model === this.meta.model ? '* ' : '  ') + m.id).join('\n'));
          break;
        }
        const parts = args.split(/\s+/);
        if (!args || parts.length > (name === 'model' ? 2 : 1)) throw new Error(name === 'model' ? 'Use /model <id> [effort].' : 'Use /effort <low|medium|high|xhigh|max|ultra>.');
        const id = name === 'model' ? parts[0] : this.meta.model;
        const model = models.find((m) => m.id === id || m.model === id);
        if (!model) throw new Error('Unknown model: ' + (id || '(none)') + '. Use /model to list models.');
        const supported = (model.supportedReasoningEfforts || []).map((e) => e.reasoningEffort || e);
        const asked = name === 'effort' ? args : parts[1];
        if (asked && (!EFFORTS.includes(asked) || !supported.includes(asked))) {
          throw new Error('Unsupported effort for ' + model.id + ': ' + asked + '. Supported: ' + supported.join(', ') + '.');
        }
        const effort = asked || (supported.includes(this.effort) ? this.effort : model.defaultReasoningEffort) || '';
        if (name === 'model') this._chosenSettings.model = model.model || model.id;
        this._chosenSettings.effort = effort;
        this._settings({ model: name === 'model' ? model.model || model.id : this.meta.model, effort });
        this._notice('Model: ' + this.meta.model + (this.effort ? '; effort: ' + this.effort : '') + '.');
        break;
      }
      case 'steer': {
        if (!args) throw new Error('Use /steer <text>.');
        const sent = opts && opts.sent ? String(opts.sent).trim().replace(/^\/steer\s+/, '') : args;
        const options = Object.assign({}, opts, { sent });
        if (this.inTurn) await this.steer(args, attachments, options);
        else { this.enqueue(args, attachments, options); this._notice('Prompt queued to send.'); }
        break;
      }
      default:
        break;
    }
  }

  /** Add input to the turn already running, keeping its id as a precondition. */
  async steer(text, attachments, opts) {
    if (this._durableQueueOwner) return this._durableQueueOwner.submit(this, '/steer ' + text, attachments,
      { ...opts, run: this._engineControls.run() });
    const expectedTurnId = this.turnId;
    if (!expectedTurnId) throw new Error('There is no running turn to steer.');
    const shown = String(text || '').trim();
    const outgoing = String((opts && opts.sent) || shown).trim();
    const files = Array.isArray(attachments) ? attachments : [];
    const clientId = 'nik' + Date.now().toString(36) + (this._seq++);
    await this.workspace.client.request('turn/steer', {
      threadId: this.threadId, expectedTurnId, clientUserMessageId: clientId, input: inputOf(outgoing, files)
    });
    this._upsert({ id: 'u:' + clientId, kind: 'user', text: shown || outgoing,
      snippets: (opts && opts.snippets) || [], images: files, at: Date.now() });
    this.activeAt = Date.now();
    this._notice('Sent into the running turn.');
    this.workspace._changed();
  }

  enqueue(text, attachments, opts) {
    if (this._durableQueueOwner) return this._durableQueueOwner.submit(this, text, attachments, opts);
    this.queue.push({
      id: 'q' + (this._seq++), text: String(text || ''),
      sent: (opts && opts.sent) || null, snippets: (opts && opts.snippets) || [],
      attachments: Array.isArray(attachments) ? attachments : []
    });
    this.emit('queue');
    this._drain();
  }

  async send(text, attachments, opts) {
    if (this._durableQueueOwner) return this._durableQueueOwner.submit(this, text, attachments, opts);
    const shown = String(text || '').trim();
    const outgoing = String((opts && opts.sent) || shown).trim();
    const files = Array.isArray(attachments) ? attachments : [];
    if (!outgoing && !files.length) return;
    this._sending = true;
    const clientId = 'nik' + Date.now().toString(36) + (this._seq++);
    this._upsert({
      id: 'u:' + clientId, kind: 'user', text: shown || outgoing,
      snippets: (opts && opts.snippets) || [], images: files, at: Date.now()
    });
    this.activeAt = Date.now();
    this._setStatus(STATUS.WORKING);
    this.runStartedAt = Date.now();
    let accepted = false;
    try {
      if (!this.loaded) await this.start();
      if (!this.loaded) throw new Error(this.lastError || 'the conversation did not open');
      await this._resolveModel();
      const settings = this._turnSettings();
      const started = await this.workspace.client.request('turn/start', Object.assign({
        threadId: this.threadId, clientUserMessageId: clientId, input: inputOf(outgoing, files)
      }, settings));
      accepted = true;
      this._appliedSettings(settings);
      if (started && started.turn && !this.turnId && started.turn.status === 'inProgress' && !this._drawnTurns.has(started.turn.id)) this.turnId = started.turn.id;
    } catch (err) {
      this.errors += 1;
      this.lastError = err.message;
      this._notice('Codex did not take that: ' + err.message, 'error');
      this.runStartedAt = 0;
      this._setStatus(STATUS.ERROR);
    } finally {
      this._sending = false;
      this.workspace._changed();
      if (accepted) this._drain();
    }
  }

  interrupt() {
    if (this._durableQueueOwner) return this._durableQueueOwner.control(this, 'interrupt');
    this._historyVersion += 1;
    this._clearMac();
    if (!this.turnId) return;
    this.interrupts += 1;
    if (this.readOnly) {
      const ipc = this.workspace.ipc;
      (ipc ? ipc.ownerOf(this.threadId) : Promise.resolve(null))
        .then((owner) => {
          if (!owner) throw new Error('the ChatGPT app has it and did not answer');
          return ipc.interrupt(owner, this.threadId, this.turnId);
        })
        .catch((err) => this._notice('Could not stop it: ' + err.message, 'error'));
      return;
    }
    this.workspace.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
      .catch((err) => this._notice('Could not stop it: ' + err.message, 'error'));
  }

  stopTask(taskId) {
    if (this._durableQueueOwner) return this._durableQueueOwner.control(this, 'stopTask', { taskId });
  }

  unqueue(id) {
    if (this._durableQueueOwner) return this._durableQueueOwner.unqueue(this, id);
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.id !== id);
    if (this.queue.length !== before) this.emit('queue');
  }

  promote(id) {
    if (this._durableQueueOwner) return this._durableQueueOwner.promote(this, id);
    const at = this.queue.findIndex((q) => q.id === id);
    if (at >= 0 && this.inTurn) {
      const next = this.queue[at];
      if (next._steering) return;
      next._steering = true;
      this.steer(next.text, next.attachments, { sent: next.sent, snippets: next.snippets }).then(() => {
        this.unqueue(id);
      }).catch((err) => this._notice('Could not send now: ' + err.message, 'error')).finally(() => {
        delete next._steering;
        this._drain();
      });
      return;
    }
    if (at <= 0) return;
    this.queue.unshift(this.queue.splice(at, 1)[0]);
    this.emit('queue');
  }

  reclaim(id) {
    if (this._durableQueueOwner) return this._durableQueueOwner.reclaim(this, id);
    const at = this.queue.findIndex((q) => q.id === id);
    if (at < 0) return null;
    const [item] = this.queue.splice(at, 1);
    this.emit('queue');
    return item;
  }

  clearQueue() {
    if (this._durableQueueOwner) return this._durableQueueOwner.clearQueue(this);
    if (!this.queue.length) return;
    this.queue = [];
    this.emit('queue');
  }

  _drain() {
    if (this._durableQueueOwner) { this._durableQueueOwner.schedule(this); return; }
    if (!this.queue.length || this.queue[0]._steering || this.inTurn || this._sending || this._commanding || !this.loaded) return;
    if (this.readOnly) { this._sendViaApp(); return; }
    const next = this.queue.shift();
    this.emit('queue');
    this.send(next.text, next.attachments, { sent: next.sent, snippets: next.snippets });
  }

  /** While a prompt waits on the ChatGPT app, ask for the lock every so often. */
  _retryWriter() {
    if (this._writerTimer) return;
    this._writerTimer = setTimeout(async () => {
      this._writerTimer = null;
      if (!this.queue.length || !this.readOnly) return;
      try { if (await this._takeWriter()) { this._drain(); return; } } catch (_) { /* try again */ }
      this._sendViaApp();
    }, 20000);
    if (this._writerTimer.unref) this._writerTimer.unref();
  }

  /**
   * The ChatGPT app has this conversation open, so only it can write to it:
   * hand it the next prompt to send, as the OpenAI editor extension does. If
   * the app does not answer for it, the prompt stays queued for the lock.
   */
  async _sendViaApp() {
    if (this._viaApp) return;
    this._viaApp = true;
    try {
      const ipc = this.workspace.ipc;
      const owner = ipc && ipc.available ? await ipc.ownerOf(this.threadId) : null;
      if (!owner || !this.readOnly || !this.queue.length || this.inTurn || this._sending) {
        if (this.readOnly && this.queue.length) this._retryWriter();
        return;
      }
      const next = this.queue.shift();
      this.emit('queue');
      const outgoing = String(next.sent || next.text || '').trim();
      const clientId = 'nik' + Date.now().toString(36) + (this._seq++);
      this._sending = true;
      try {
        await this._resolveModel();
        const settings = this._turnSettings();
        await ipc.request('thread-follower-start-turn', {
          conversationId: this.threadId,
          turnStart: { request: Object.assign({ threadId: this.threadId, input: inputOf(outgoing, next.attachments), clientUserMessageId: clientId }, settings) }
        }, { target: owner, timeoutMs: 30000 });
        this._appliedSettings(settings);
      } catch (err) {
        this.queue.unshift(next);
        this.emit('queue');
        this._notice('The ChatGPT app did not send that (' + err.message + '); it waits in the queue.', 'error');
        this._retryWriter();
        return;
      } finally {
        this._sending = false;
      }
      this._upsert({
        id: 'u:' + clientId, kind: 'user', text: String(next.text || '').trim() || outgoing,
        snippets: next.snippets || [], images: next.attachments || [], at: Date.now()
      });
      this.activeAt = Date.now();
      this.runStartedAt = Date.now();
      this._setStatus(STATUS.WORKING);
      this.workspace._changed();
      this._followApp();
    } finally {
      this._viaApp = false;
    }
  }

  /** Watch a turn the app is running for us, until it ends; then send what waits. */
  _followApp() {
    if (this._appTimer) return;
    const began = Date.now();
    let seen = false;
    this._awaitingApp = true;
    const step = async () => {
      this._appTimer = null;
      try { await this._loadTurns(false); } catch (_) { /* next time */ }
      if (this.inTurn) { seen = true; this._awaitingApp = false; }
      const over = seen ? !this.inTurn : Date.now() - began > 20000;
      if (over || !this.readOnly) {
        this._awaitingApp = false;
        if (!this.inTurn && this.status === STATUS.WORKING) this._setStatus(STATUS.DONE);
        this.workspace._changed();
        this._drain();
        return;
      }
      this._appTimer = setTimeout(step, FOLLOW_MS);
      if (this._appTimer.unref) this._appTimer.unref();
    };
    this._appTimer = setTimeout(step, FOLLOW_MS);
    if (this._appTimer.unref) this._appTimer.unref();
  }

  // ---- approvals ----

  handleRequest(msg) {
    if (this._engineControls) this._engineControls.run();
    const p = msg.params || {};
    const requestId = String(msg.id);
    const reused = this._pendingRpc?.has(requestId);
    if (this._engineControls && (reused || this._question && String(this._question.id) === requestId)) {
      this._engineControls.resolved(requestId);
      if (this._question && String(this._question.id) === requestId) this._question = null;
    }
    let name, input;
    if (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'execCommandApproval') {
      name = 'Bash';
      input = { command: bareCommand(Array.isArray(p.command) ? p.command.join(' ') : p.command || ''), reason: p.reason || undefined };
    } else if (msg.method === 'item/fileChange/requestApproval' || msg.method === 'applyPatchApproval') {
      name = 'Edit';
      input = { file_path: p.grantRoot || Object.keys(p.fileChanges || {}).join(', ') || 'files', reason: p.reason || undefined };
    } else if (msg.method === 'item/permissions/requestApproval') {
      // More reach than the sandbox gives: the network, or files outside it.
      const asked = p.permissions || {};
      name = 'Permissions';
      input = { reason: p.reason || undefined, network: asked.network ? 'network access' : undefined,
        files: asked.fileSystem ? fileReach(asked.fileSystem) : undefined };
      this._pendingRpc = this._pendingRpc || new Map();
      this._pendingRpc.set(requestId, { id: msg.id, grant: asked });
    } else if (msg.method === 'mcpServer/elicitation/request') {
      name = 'mcp__' + (p.serverName || 'tool');
      input = { message: p.message || '' };
      this._pendingRpc = this._pendingRpc || new Map();
      this._pendingRpc.set(requestId, { id: msg.id, elicit: true });
    } else if (msg.method === 'item/tool/requestUserInput') {
      return this._ask(msg);
    } else {
      return false;
    }
    this._pendingRpc = this._pendingRpc || new Map();
    if (!this._pendingRpc.has(requestId)) this._pendingRpc.set(requestId, { id: msg.id, legacy: !msg.method.startsWith('item/') });
    if (msg._providerTransport === 'ipc') Object.assign(this._pendingRpc.get(requestId),
      { transport: 'ipc', connection: msg._providerConnection });
    this._upsert({ id: 'p:' + requestId, kind: 'permission', name, input, requestId, resolved: null });
    if (this._engineControls) {
      const run = this._engineControls.approval(requestId, this._pendingRpc.get(requestId), p.turnId);
      this._upsert({ id: 'p:' + requestId, run });
    }
    this._setStatus(STATUS.WAITING);
    return true;
  }

  /** Codex has questions for the user: shown as its message; the next prompt is the answer. */
  _ask(msg) {
    const p = msg.params || {};
    const questions = p.questions || [];
    const lines = questions.map((q, n) => {
      const head = (questions.length > 1 ? `**${n + 1}. ` : '**') + (q.header ? q.header + ':** ' : '**') + (q.question || '');
      const opts = (q.options || []).map((o) => `- ${o.label}${o.description ? ' — ' + o.description : ''}`);
      return [head].concat(opts).join('\n');
    });
    this._question = { id: msg.id, questions, ...(msg._providerTransport === 'ipc' ? { transport: 'ipc', connection: msg._providerConnection } : {}) };
    const answerTo = this._engineControls && this._engineControls.question(msg.id, this._question, p.turnId);
    this._upsert({ id: 'q:' + msg.id, kind: 'text', text: lines.join('\n\n') + '\n\n*Reply below to answer.*', at: Date.now(),
      ...(answerTo ? { answerTo } : {}) });
    this._setStatus(STATUS.WAITING);
    return true;
  }

  /** The user's reply to Codex's questions; one line per question when there are several. */
  _answer(text, opts) {
    const asked = this._question;
    this._question = null;
    const parts = asked.questions.length > 1 ? String(text).split(/\n+/) : [String(text)];
    const answers = {};
    asked.questions.forEach((q, n) => {
      const said = (parts[n] != null ? parts[n] : parts[parts.length - 1] || '').trim();
      const picked = (q.options || []).find((o) => o.label.toLowerCase() === said.toLowerCase() || said === String(n + 1));
      answers[q.id] = { answers: [picked ? picked.label : said] };
    });
    this._upsert({ id: 'u:a' + asked.id, kind: 'user', text: String(text), images: [], at: Date.now() });
    const written = asked.transport === 'ipc' ? this.workspace.ipc.respond(asked.id, { answers }, asked.connection)
      : opts?.authoritative ? this.workspace.client.respondOutcome(asked.id, { answers }) : this.workspace.client.respond(asked.id, { answers });
    if (this.inTurn) this._setStatus(STATUS.WORKING);
    return written;
  }

  /**
   * The models for the palette, as they stand: none until Codex has listed
   * them, then the list — asked for once, and the panel told when it arrives.
   */
  modelChoices() {
    const w = this.workspace;
    if (!w._modelList) {
      if (!w._modelAsked) {
        w._modelAsked = true;
        w.models().then((list) => { w._modelList = list; this.emit('meta'); }, () => { w._modelAsked = false; });
      }
      return [];
    }
    return w._modelList.filter((m) => !m.hidden).map((m) => ({
      id: m.id,
      name: m.displayName || '',
      detail: (m.isDefault ? 'default · ' : '') + ((m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort || e).join(' ') || '')
    }));
  }

  respondToPermission(requestId, allow, opts) {
    if (this._durableQueueOwner && !opts?.authoritative) return this._durableQueueOwner.control(this, 'permission', { requestId, allow });
    const pending = this._pendingRpc && this._pendingRpc.get(String(requestId));
    if (!pending) return opts?.authoritative ? 'not_written' : false;
    this._pendingRpc.delete(String(requestId));
    let answer;
    if (pending.grant) {
      const granted = {};
      if (allow && pending.grant.network) granted.network = pending.grant.network;
      if (allow && pending.grant.fileSystem) granted.fileSystem = pending.grant.fileSystem;
      answer = { permissions: granted, scope: 'turn' };
    } else if (pending.elicit) {
      answer = allow ? { action: 'accept', content: {}, _meta: null } : { action: 'decline', content: null, _meta: null };
    } else {
      answer = { decision: pending.legacy ? (allow ? 'approved' : 'denied') : (allow ? 'accept' : 'decline') };
    }
    const ok = pending.transport === 'ipc' ? this.workspace.ipc.respond(pending.id, answer, pending.connection)
      : opts?.authoritative ? this.workspace.client.respondOutcome(pending.id, answer) : this.workspace.client.respond(pending.id, answer);
    if (ok && this.inTurn) this._setStatus(STATUS.WORKING);
    return ok;
  }

  // ---- what Codex says ----

  handle(method, p) {
    if (this._engineControls) this._engineControls.run();
    if (method === 'turn/completed' && p.turn) this.emit('provider-evidence', [p.turn]);
    if (['item/started', 'item/completed'].includes(method) && p.item?.type === 'userMessage' && p.turnId) {
      this.emit('provider-evidence', [{ id: p.turnId, status: 'inProgress', items: [p.item] }]);
    }
    const at = Date.now();
    if (method === 'turn/started' || method === 'turn/completed' || method === 'item/started' || method === 'item/completed') this._historyVersion += 1;
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn && p.turn.id;
        if (!this.runStartedAt) this.runStartedAt = at;
        this._setStatus(STATUS.WORKING);
        break;
      case 'item/started':
      case 'item/completed': {
        this._usingMac(p.item, method === 'item/started' && p.item && p.item.status === 'inProgress');
        for (const shown of itemsFrom(p.item, at)) {
          if (shown.kind === 'text' && p.item.type === 'agentMessage') shown.streaming = method === 'item/started';
          // Our own prompt is already on screen under the id we gave it.
          if (shown.kind === 'user' && this._index.has(shown.id)) continue;
          if (method === 'item/completed' && shown.kind === 'thinking' && !shown.text) {
            const had = this._index.get(shown.id);
            if (had && had.text) continue;
          }
          this._place(shown);
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const item = this._index.get(p.itemId) || { id: p.itemId, kind: 'text', text: '', at };
        this._upsert({ id: p.itemId, kind: 'text', text: (item.text || '') + (p.delta || ''), streaming: true, at: item.at });
        break;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const item = this._index.get(p.itemId);
        this._upsert({ id: p.itemId, kind: 'thinking', text: ((item && item.text) || '') + (p.delta || '') });
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const item = this._index.get('tool:' + p.itemId);
        if (item) this._upsert(Object.assign({ id: item.id }, clip((item.result || '') + (p.delta || ''))));
        break;
      }
      case 'turn/completed': {
        const turn = p.turn || {};
        if (this._engineControls && this.turnId === turn.id) this._engineControls.endTurn();
        this.turnId = null;
        this._clearMac();
        if (!turn.id || !this._drawnTurns.has(turn.id)) this.turns += 1;
        if (turn.id) this._drawnTurns.add(turn.id);
        if (this.runStartedAt) this.runDurationMs = at - this.runStartedAt;
        this.runStartedAt = 0;
        // Anything still marked running belongs to a turn that is over.
        for (const item of this.items) {
          if (item.kind === 'tool' && item.status === 'running') this._upsert({ id: item.id, status: 'stopped' });
          if (item.kind === 'text' && item.streaming) this._upsert({ id: item.id, streaming: false });
        }
        this._upsert(this._resultOf(Object.assign({ durationMs: this.runDurationMs }, turn)));
        if (turn.status === 'failed') { this.errors += 1; this.lastError = turn.error && turn.error.message; }
        this.activeAt = at;
        this._setStatus(turn.status === 'failed' ? STATUS.ERROR : turn.status === 'interrupted' ? STATUS.STOPPED : STATUS.DONE);
        this.workspace._changed();
        // Read the turn back as Codex keeps it, so the cache has it for next time.
        this._loadTurns(false).catch(() => {});
        this._drain();
        break;
      }
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage || {};
        const total = u.total || {};
        this.usage = {
          input: Math.max(0, (total.inputTokens || 0) - (total.cachedInputTokens || 0)),
          output: total.outputTokens || 0,
          cacheRead: total.cachedInputTokens || 0,
          cacheCreate: total.cacheWriteInputTokens || 0
        };
        if (u.last) this.contextTokens = u.last.totalTokens || this.contextTokens;
        if (u.modelContextWindow) this.contextWindow = u.modelContextWindow;
        break;
      }
      case 'thread/name/updated':
        this.customTitle = p.threadName || null;
        this.emit('meta');
        this.workspace._changed();
        break;
      case 'thread/settings/updated':
        this._settings(p.threadSettings || {});
        break;
      case 'thread/goal/updated':
        this._goal(p.goal);
        break;
      case 'thread/goal/cleared':
        this._goal(null);
        break;
      case 'thread/compacted':
        this.compactions += 1;
        break;
      case 'error':
        if (p.error && p.error.message) this._notice((p.willRetry ? 'Retrying: ' : '') + p.error.message, p.willRetry ? 'info' : 'error');
        break;
      case 'serverRequest/resolved': {
        // Answered somewhere else (the ChatGPT app): the prompt here is moot.
        const key = String(p.requestId);
        if (this._engineControls) this._engineControls.resolved(key);
        if (this._question && String(this._question.id) === key) this._question = null;
        if (this._pendingRpc && this._pendingRpc.has(key)) {
          this._pendingRpc.delete(key);
          this._upsert({ id: 'p:' + key, resolved: 'allow' });
        }
        break;
      }
      default:
        break;
    }
  }

  stats() {
    const u = this.usage;
    return {
      input: u.input, output: u.output, cacheRead: u.cacheRead, cacheCreate: u.cacheCreate,
      total: u.input + u.output + u.cacheRead + u.cacheCreate,
      cost: 0,
      turns: this.turns,
      elapsedMs: this.runStartedAt ? Date.now() - this.runStartedAt : this.runDurationMs,
      running: !!this.runStartedAt,
      background: 0, shells: 0, shellList: [],
      contextTokens: this.contextTokens, contextWindow: this.contextWindow,
      ci: null
    };
  }

  // The hub asks Claude instances for these; a Codex one has nothing to add.
  replayTranscript() { return Promise.resolve(false); }
  noteMissingTranscript() {}
}

// ---- the workspace ------------------------------------------------------------

/** Every Codex conversation on this Mac, and the one app-server they share. */
class CodexWorkspace extends EventEmitter {
  constructor({ codexPath, log, client, ipc, cache, cacheDir, home, args,
    spawnFn, daemonFn, env, appAccount, createReader, defaultCwd, unavailableReason } = {}) {
    super();
    this.log = log || (() => {});
    this.home = home || null;
    this.defaultCwd = defaultCwd;
    this.unavailableReason = unavailableReason || null;
    this.client = client || new CodexClient({ codexPath, log: this.log, home, args, spawnFn, daemonFn, env, appAccount, unavailableReason });
    // The ChatGPT app runs turns only for its own account.
    const canBorrow = appAccount === undefined ? !home || isAppHome(home) : appAccount;
    this.ipc = ipc !== undefined ? ipc : (canBorrow ? new CodexIpc({ log: this.log }) : null);
    this.cache = cache || new CodexCache({ dir: cacheDir });
    this.cache.sweep();
    this.sessions = new Map();
    this.loadedOnce = false;
    this.error = this.unavailableReason;
    this._refreshing = null;
    this._poll = null;
    this._changeTimer = null;
    this._models = null;
    this._disposed = false;
    this._createReader = createReader || ((opts) => new CodexClient(opts));

    const notification = (method, params) => {
      const session = params && params.threadId ? this.sessions.get(PREFIX + params.threadId) : null;
      if (session) { session.handle(method, params); return; }
      if (method === 'thread/started' && params.thread) this._adopt(params.thread);
    };
    const request = (msg) => {
      const threadId = msg.params && (msg.params.threadId || msg.params.conversationId);
      const session = threadId ? this.sessions.get(PREFIX + threadId) : null;
      if (!session || !session.handleRequest(msg)) this.client.respondError(msg.id, 'NikUI cannot answer this request');
    };
    const exit = (why) => {
      this._models = null;
      for (const s of this.sessions.values()) {
        if (s._engineControls) s._engineControls.rotate(null);
        s.writerAuthority = 'unknown';
        s._historyVersion += 1;
        s._clearMac();
        if (!s.loaded) continue;
        s.loaded = false;
        s.readOnly = false;
        if (s.inTurn) {
          s.turnId = null;
          s._notice('Codex stopped (' + why + '). Send again to pick the conversation back up.', 'error');
          s._setStatus(STATUS.STOPPED);
        }
      }
      this._changed();
    };
    this._clientListeners = { notification, request, exit };
    for (const [event, listener] of Object.entries(this._clientListeners)) this.client.on(event, listener);
  }

  /**
   * Who to read history from. The daemon sends a big history slowly (a
   * hundred megabytes of generated images took twelve seconds), and reading
   * needs no lock, so then a copy of our own does the reading.
   */
  async reader() {
    await this.client.start();
    if (this._disposed) throw new Error('Codex workspace is closed');
    if (!this.client.viaDaemon) return this.client;
    if (!this._reader) this._reader = this._createReader({
      codexPath: this.client.codexPath, daemonFn: null, log: this.log,
      home: this.client.home, args: this.client.args, spawnFn: this.client.spawnFn, env: this.client.env
    });
    try {
      await this._reader.start();
      return this._reader;
    } catch (_) {
      if (this._disposed) throw new Error('Codex workspace is closed');
      return this.client;
    }
  }

  resourceOwnership() {
    return { connection: { ownership: this.client.ownership, connected: this.client.alive },
      reader: this._reader ? { ownership: 'owned', connected: this._reader.alive } : null,
      ipc: this.ipc ? { ownership: 'borrowed', connected: !!this.ipc.sock } : null };
  }

  /** Whether Codex is installed here at all. */
  get available() {
    if (this.unavailableReason) return false;
    const bin = this.client.codexPath;
    if (bin !== 'codex' && fs.existsSync(bin)) return true;
    return fs.existsSync(this.home || codexHome());
  }

  get list() {
    return [...this.sessions.values()].sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0));
  }

  get(id) {
    return this.sessions.get(String(id || '')) || null;
  }

  static isCodexId(id) {
    return typeof id === 'string' && id.startsWith(PREFIX);
  }

  _adopt(thread) {
    if (this._disposed) return null;
    if (!thread || !thread.id || thread.ephemeral || thread.parentThreadId) return null;
    const id = PREFIX + thread.id;
    let session = this.sessions.get(id);
    if (session) { session.update(thread); return session; }
    session = new CodexSession(thread, this);
    if (this.prepareSession) this.prepareSession(session);
    for (const event of ['status', 'queue', 'unread', 'meta']) session.on(event, () => this._changed());
    this.sessions.set(id, session);
    this.emit('session-added', session);
    this._changed();
    return session;
  }

  /** Ask Codex for the list again. Conversations started elsewhere turn up here. */
  refresh() {
    if (this._disposed) return Promise.resolve();
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      await this.client.start();
      const seen = new Set();
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        if (this._disposed) return;
        const res = await this.client.request('thread/list', { limit: 100, cursor, sortKey: 'updated_at' });
        if (this._disposed) return;
        for (const thread of (res && res.data) || []) {
          const s = this._adopt(thread);
          if (s) seen.add(s.id);
        }
        cursor = res && res.nextCursor;
        if (!cursor) break;
      }
      // Archived or deleted in the ChatGPT app: gone here too, unless open.
      for (const [id, s] of this.sessions) {
        if (!seen.has(id) && !s.loaded) { this.sessions.delete(id); this.emit('removed', s); }
      }
      this.loadedOnce = true;
      this.error = null;
      this._changed();
    })().catch((err) => {
      this.error = err.message;
      this.log('codex list failed: ' + err.message);
      this._changed();
    }).finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  /** Keep the list current while anybody might be looking at it. */
  watch(everyMs) {
    if (this._disposed || this._poll) return;
    this.refresh();
    this._poll = setInterval(() => this.refresh(), everyMs || 60000);
    if (this._poll.unref) this._poll.unref();
  }

  /** A new Codex conversation in a folder. */
  async create({ cwd }) {
    await this.client.start();
    if (this._disposed) throw new Error('Codex workspace is closed');
    const res = await this.client.request('thread/start', { cwd });
    const session = this._adopt(Object.assign({}, res.thread, { preview: res.thread.preview || '' }));
    if (!session) throw new Error('Codex did not start a conversation');
    session._settings(res);
    session.loaded = true;
    session.writerAuthority = 'engine';
    session.everStarted = true;
    session.activeAt = Date.now();
    this._changed();
    return session;
  }

  /** The model catalog is shared by all conversations in this workspace. */
  models() {
    if (this._disposed) return Promise.reject(new Error('Codex workspace is closed'));
    if (this._models) return this._models;
    this._models = (async () => {
      await this.client.start();
      const models = [];
      let cursor = null;
      do {
        const page = await this.client.request('model/list', { cursor });
        models.push(...((page && page.data) || []));
        cursor = page && page.nextCursor;
      } while (cursor);
      return models;
    })().catch((err) => { this._models = null; throw err; });
    return this._models;
  }

  /** A fork is already loaded in our server; only its history needs reading. */
  async fork(source) {
    const res = await this.client.request('thread/fork', { threadId: source.threadId, excludeTurns: true });
    const session = this._adopt(res.thread);
    if (!session) throw new Error('Codex did not fork the conversation');
    session._settings(Object.assign({ collaborationMode: { mode: source.meta.mode } }, res));
    session.loaded = true;
    session.writerAuthority = 'engine';
    session.everStarted = true;
    session.activeAt = Date.now();
    await session._loadTurns(true);
    await session._readGoal().catch(() => {});
    session.emit('meta');
    this._changed();
    return session;
  }

  _changed() {
    if (this._disposed || this._changeTimer) return;
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      this.emit('changed');
    }, 50);
    if (this._changeTimer.unref) this._changeTimer.unref();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const [event, listener] of Object.entries(this._clientListeners)) this.client.removeListener(event, listener);
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    if (this._changeTimer) clearTimeout(this._changeTimer);
    this._changeTimer = null;
    const close = (resource) => {
      if (!resource || !resource.dispose) return;
      try { resource.dispose(); } catch (err) { this.log('codex: could not dispose: ' + (err && err.message)); }
    };
    close(this.ipc);
    close(this._reader);
    for (const session of this.sessions.values()) close(session);
    close(this.client);
    close(this.cache);
  }
}

module.exports = { CodexClient, CodexSession, CodexWorkspace, itemFrom, itemsFrom, picturesFor, bareCommand, findCodex, openDaemon, PREFIX, CODEX_COMMANDS };
