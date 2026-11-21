/* The one thing that differs between a webview and a browser tab.

   media/panel.js asks for a transport instead of asking VS Code for an API. In
   the panel it gets exactly what it always got. In a browser it gets the same
   three methods over a WebSocket, so every other file in media/ has no idea
   which host it is running in — which is the only way the phone client and the
   panel can stay the same client. */
(function () {
  'use strict';

  // Long enough to ride out a lift or a tunnel, short enough that picking the
  // phone back up feels instant.
  const BACKOFF = [400, 800, 1600, 3200, 6400, 12000];
  const CORE_CAPS = ['mid-ack-v1', 'receipts-v1', 'run-precondition-v1', 'operation-state-v1'];
  const OPTIONAL_CAPS = ['pr-v1', 'slack-v1', 'terminal-v1', 'voice-v1', 'editor-route-v1'];
  const HEX_ID = /^[a-f0-9]{32}$/;
  const QUERIES = new Set(['history', 'status', 'statusOpen', 'settings', 'settingsOpen', 'commands', 'commandsOpen',
    'pr:watch', 'pr:refresh', 'pr:diff', 'pr:mentions', 'pr:askThread', 'pr:askCheck', 'pr:askConflicts',
    'voice', 'voice:state', 'devices', 'awake', 'codex:watch', 'term:list', 'term:attach', 'term:detach',
    'slack:ready', 'slack:refresh', 'slack:older', 'slack:file', 'app:update', 'receipt:get', 'operation:get']);
  const LOCAL_ACTIONS = new Set(['allSettings', 'slack', 'openPr', 'pr:open', 'pr:link', 'slack:connect',
    'slack:disconnect', 'slack:signIn', 'slack:settings', 'slack:openTicket', 'slack:setup', 'slack:link']);
  const SEMANTIC_REPLIES = { 'instance:new': ['instance:created'], 'instance:resume': ['instance:created'], 'instance:place': ['instance:placed'],
    editQueued: ['editPrompt'], saveCommand: ['commands'], removeCommand: ['commands'], restoreCommand: ['commands'],
    'pr:reply': ['pr:done'], 'pr:resolve': ['pr:done'], 'pr:comment': ['pr:done'], 'pr:rerun': ['pr:done'],
    'term:open': ['term:opened'], 'term:close': ['term:closed'], '@listen': ['@listener'], 'slack:reply': ['slack:sent'],
    'slack:link': ['slack:link'], 'slack:openTicket': ['slack:openTicket'], switch: ['@navigate'] };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const bytes = (value) => new TextEncoder().encode(value).length;
  const recordKey = (r) => JSON.stringify([r.hostFingerprint, r.engineId, r.scope, r.principal, r.mid]);
  function acceptsComposition(record, composition) {
    return record.ack?.outcome === 'applied' && record.ack.result?.code === 'accepted' && !!record.composition &&
      JSON.stringify(record.composition) === JSON.stringify(composition);
  }
  function actionId() {
    const data = new Uint8Array(16);
    window.crypto.getRandomValues(data);
    return Array.from(data, (n) => n.toString(16).padStart(2, '0')).join('');
  }

  /** The application lane, shared by sockets and explicitly opted-in webviews.
   * Disk holds plaintext JSON, never a sealed frame. A write is not acceptance.
   * Storage is synchronous and verified, so the caller can preserve its composer
   * on quota/private-mode failure before any socket write is possible.
   */
  function negotiatedClient({ config = {}, send, emit, storage, now = Date.now, randomId = actionId,
    maxCount = 128, maxBytes = 32 * 1024 * 1024 } = {}) {
    const target = config.session ? 'session:' + config.session : 'fleet';
    let proto = null, connected = false, binding = null, welcome = null, pin = config.hostFingerprint || null;
    let clockOffset = 0, ready = null, run = null, snapshot = false, storageIssue = false, poll = null;
    let saved = { version: 1, records: [] };
    const outstanding = new Set(), subscriptions = new Map(), permissions = new Map(), tasks = new Map(), terminals = new Map();
    function read() {
      const raw = storage.read();
      const data = raw ? JSON.parse(raw) : { version: 1, records: [] };
      if (data.version !== 1 || !Array.isArray(data.records) || data.records.some((r) => !r || !HEX_ID.test(r.mid) ||
          typeof r.plaintext !== 'string' || JSON.parse(r.plaintext).mid !== r.mid || !r.payload ||
          JSON.stringify(r.payload) !== r.plaintext || r.payload.scope !== r.scope || r.payload.issuedAt !== r.issuedAt ||
          typeof r.target !== 'string' || typeof r.principal !== 'string' || !HEX_ID.test(r.engineId) || !HEX_ID.test(r.scope))) throw new Error('OUTBOX_INVALID');
      return data;
    }
    try { saved = read(); } catch (_) { storageIssue = true; }
    function persist(removed = new Set()) {
      if (storageIssue) throw new Error('STORAGE_UNAVAILABLE');
      // Another tab can commit between this tab's ingress and its async reply.
      // Merge records by their complete binding before replacing the document.
      const disk = read();
      for (const r of disk.records) if (!removed.has(recordKey(r)) && !saved.records.some((s) => recordKey(r) === recordKey(s))) saved.records.push(r);
      const text = JSON.stringify(saved);
      if (saved.records.length > maxCount || bytes(text) > maxBytes) throw new Error('OUTBOX_FULL');
      storage.write(text);
      if (storage.read() !== text) throw new Error('STORAGE_UNAVAILABLE');
    }
    function notice(code, record) {
      emit({ type: 'intent:error', code, mid: record?.mid || null,
        message: code === 'OUTBOX_FULL' ? 'Pending actions are full. Your draft and images are still here.'
          : code === 'STORAGE_UNAVAILABLE' ? 'Could not save this action. Your draft and images are still here.'
            : code === 'OUTCOME_UNKNOWN' ? 'The earlier action may have completed. Review it before sending again.'
              : code === 'UNAVAILABLE' ? 'This feature is unavailable on this connection.'
                : code === 'NOT_CONNECTED' ? 'Waiting for the laptop. Your draft and images are still here.'
                  : code === 'MESSAGE_TOO_LARGE' ? 'This action is too large. Your draft and images are still here.'
                    : code === 'STALE_RUN' ? 'This control has expired. Wait for a current snapshot.' : code });
    }
    function changed(record) { emit({ type: 'intent', record: copy(record) }); }
    function polling() {
      if (poll || !connected || proto !== 2) return;
      poll = setTimeout(() => {
        poll = null;
        for (const r of saved.records) if (['pending', 'accepted'].includes(r.state) && !['completed', 'rejected'].includes(r.operation?.state)) lookup(r);
        polling();
      }, 2000);
      poll?.unref?.();
    }
    const matches = (r) => binding && ['hostFingerprint', 'engineId', 'scope', 'principal'].every((k) => r[k] === binding[k]);
    const current = (r) => matches(r) && (r.target === target || target === 'fleet');
    const serverTime = () => Math.max(0, Math.floor(now() + clockOffset));
    const fresh = (r) => welcome && serverTime() - r.issuedAt < welcome.receipts.retentionMs && r.issuedAt <= serverTime() + 30000;
    function write(record) {
      if (!connected || proto !== 2 || !matches(record) || record.target !== target || outstanding.has(record.mid)) return false;
      outstanding.add(record.mid);
      try { send(JSON.parse(record.plaintext)); return true; }
      catch (_) { return false; } // it may have been written; only receipt lookup can decide
    }
    function lookup(record) {
      if (!connected || proto !== 2 || !current(record)) return;
      send({ type: record.state === 'accepted' ? 'operation:get' : 'receipt:get', scope: record.scope, mid: record.mid });
    }
    function isQuery(message) {
      return QUERIES.has(message.type) || message.type === 'ready' && target === 'fleet' ||
        !welcome?.seat.local && ['slack:link', 'slack:setup'].includes(message.type);
    }
    function capability(message) {
      if (message.type.startsWith('pr:') || message.type === 'openPr') return 'pr-v1';
      if (message.type.startsWith('slack:') || message.type === 'slack') return 'slack-v1';
      if (message.type.startsWith('term:')) return 'terminal-v1';
      if (message.type.startsWith('voice')) return 'voice-v1';
      if (['openFile', 'runInTerminal', 'allSettings'].includes(message.type)) return 'editor-route-v1';
      return null;
    }
    function allowed(message) {
      if (proto !== 2) return proto === 1;
      const cap = capability(message), seat = welcome.seat;
      const pairedQuery = !seat.local && ['slack:link', 'slack:setup'].includes(message.type);
      if (cap && !welcome.caps.includes(cap) || LOCAL_ACTIONS.has(message.type) && !seat.local && !pairedQuery) return false;
      if (message.type.startsWith('term:') && !seat.control) return false;
      if (isQuery(message) || ['ready', 'visible', 'pr:pane', 'slack:open'].includes(message.type)) return true;
      if (['@apple', '@listen'].includes(message.type)) return !seat.local;
      if (message.type === 'forget' && message.id === seat.id && !seat.local) return true;
      return seat.control === true;
    }
    function preconditions(message) {
      const m = copy(message);
      if (m.type === 'permission') m.run = m.run || permissions.get(m.requestId);
      else if (m.type === 'stopTask') m.run = m.run || tasks.get(m.taskId);
      else if (m.type === 'interrupt' || m.type === 'promoteQueued' && m.mode === 'steer' ||
        m.type === 'send' && /^\/steer(?:\s|$)/i.test(m.text || '')) m.run = m.run || run;
      if (['permission', 'stopTask', 'interrupt'].includes(m.type) || m.type === 'promoteQueued' && m.mode === 'steer' ||
          m.type === 'send' && /^\/steer(?:\s|$)/i.test(m.text || '')) {
        if (!snapshot || !m.run || !HEX_ID.test(m.run.id) || !m.run.turn) throw new Error('STALE_RUN');
      }
      if (['term:run', 'term:stop', 'term:close'].includes(m.type) && !Object.hasOwn(m, 'terminalRun')) {
        if (!terminals.has(m.id)) throw new Error('STALE_RESOURCE');
        m.terminalRun = terminals.get(m.id);
      }
      return m;
    }
    function post(message, composition, prepared = null) {
      if (!message || typeof message.type !== 'string') return false;
      if (message.type === 'ready') ready = copy(message);
      if (QUERIES.has(message.type) && /Open$|:watch$|:attach$|:ready$/.test(message.type)) subscriptions.set(message.type + ':' + (message.id || ''), copy(message));
      if (!connected || proto === null) {
        if (message.type !== 'ready' && !isQuery(message)) notice('NOT_CONNECTED');
        return false;
      }
      if (proto === 1) { send(message); return true; }
      if (!allowed(message)) { notice('UNAVAILABLE'); return false; }
      if (isQuery(message)) { send(message); return true; }
      if (storage.exclusive && !prepared) {
        // Web Locks serializes the complete read/modify/verify/write across
        // browser tabs. Saving is asynchronous; the composer stays in place.
        let frozen;
        try { frozen = { payload: { ...preconditions(message), mid: randomId(), scope: binding.scope, issuedAt: serverTime() },
          binding: copy(binding), composition: composition ? copy(composition) : null }; }
        catch (error) { notice(error.message || 'STORAGE_UNAVAILABLE'); return false; }
        storage.exclusive(() => post(frozen.payload, frozen.composition, frozen)).catch(() => notice('STORAGE_UNAVAILABLE'));
        return { pending: 'saving', mid: frozen.payload.mid };
      }
      if (prepared && !['hostFingerprint', 'engineId', 'scope', 'principal'].every((k) => prepared.binding[k] === binding[k])) {
        notice('SCOPE_CHANGED'); return false;
      }
      let record;
      try {
        // Merge other tabs' completed writes before allocating another intent.
        saved = read();
        const removed = new Set(saved.records.filter((r) => r.state === 'completed' && r.consumed && r.payload.type !== 'send').map(recordKey));
        saved.records = saved.records.filter((r) => !removed.has(recordKey(r)));
        const payload = prepared?.payload || { ...preconditions(message), mid: randomId(), scope: binding.scope, issuedAt: serverTime() };
        if (bytes(JSON.stringify(payload)) > (welcome.receipts.maxMessageBytes || 16 * 1024 * 1024)) throw new Error('MESSAGE_TOO_LARGE');
        if (!HEX_ID.test(payload.mid) || saved.records.some((r) => r.mid === payload.mid && matches(r))) throw new Error('MID_CONFLICT');
        record = { ...binding, target, mid: payload.mid, issuedAt: payload.issuedAt, payload,
          plaintext: JSON.stringify(payload), state: 'pending', consumed: false };
        if (composition) record.composition = copy(composition);
        saved.records.push(record);
        persist(removed);
      } catch (err) {
        if (record) saved.records = saved.records.filter((r) => r !== record);
        notice(['OUTBOX_FULL', 'MESSAGE_TOO_LARGE', 'STALE_RUN', 'STALE_RESOURCE', 'MID_CONFLICT'].includes(err.message) ? err.message : 'STORAGE_UNAVAILABLE');
        return false;
      }
      changed(record); write(record); polling();
      return { pending: true, mid: record.mid };
    }
    function resume() {
      let quarantined = false;
      if (ready) {
        const old = saved.records.find((r) => matches(r) && r.target === target && r.payload.type === 'ready');
        if (proto === 2 && old) write(old); else post(ready);
      }
      for (const message of subscriptions.values()) send(message);
      for (const record of saved.records) {
        if ((!matches(record) || !fresh(record)) && !['rejected', 'completed'].includes(record.state)) {
          record.quarantined = true; changed(record);
          quarantined = true;
        } else if (current(record)) { changed(record); if (record.payload.type !== 'ready') lookup(record); }
      }
      if (quarantined) {
        const keys = new Set(saved.records.filter((r) => r.quarantined).map(recordKey));
        const commit = () => { saved = read(); for (const r of saved.records) if (keys.has(recordKey(r))) r.quarantined = true; persist(); };
        if (storage.exclusive) storage.exclusive(commit).catch(() => notice('STORAGE_UNAVAILABLE'));
        else try { commit(); } catch (_) { notice('STORAGE_UNAVAILABLE'); }
      }
    }
    function receive(message, locked = false) {
      if (!message || typeof message.type !== 'string') return false;
      if (message.type === '@welcome') {
        connected = true; snapshot = false; run = null; permissions.clear(); tasks.clear(); terminals.clear();
        try { saved = read(); } catch (_) { storageIssue = true; notice('STORAGE_UNAVAILABLE'); }
        if (message.proto) {
          proto = null;
          send({ type: 'hello', proto: { min: 1, max: 2 }, caps: CORE_CAPS.concat(OPTIONAL_CAPS),
            client: { id: randomId(), kind: config.clientKind || 'browser', version: config.version || 'p1' } });
          emit({ type: 'protocol', proto: null, ready: false });
        } else {
          proto = 1; binding = null; welcome = null;
          for (const record of saved.records) { record.quarantined = true; changed(record); }
          resume();
        }
        return true;
      }
      if (message.type === 'welcome') {
        if (proto !== null || !connected || ![1, 2].includes(message.proto) || message.proto === 2 &&
            (!CORE_CAPS.every((c) => message.caps?.includes(c)) || !HEX_ID.test(message.engine?.id) ||
              !HEX_ID.test(message.receipts?.scope) || !Number.isSafeInteger(message.receipts.now) ||
              !(message.receipts.retentionMs > 0) || !message.seat || !pin)) {
          connected = false; notice('BAD_WELCOME'); return true;
        }
        proto = message.proto; welcome = copy(message);
        if (proto === 2) {
          clockOffset = message.receipts.now - now();
          binding = { hostFingerprint: pin, engineId: message.engine.id, scope: message.receipts.scope,
            principal: message.seat.local ? message.seat.id === 'local' ? 'local:browser' : 'local-client:' + message.seat.id : 'device:' + message.seat.id };
        }
        emit({ type: 'protocol', proto, ready: true, caps: message.caps, seat: message.seat }); resume(); polling();
        return true;
      }
      if (message.type === '@device' && welcome) welcome.seat.control = !!message.device?.control;
      if (message.type === 'protocol:error') {
        if (proto !== 2 || ['BAD_HELLO', 'NO_COMMON_PROTOCOL', 'REQUIRED_CAPABILITY', 'NEGOTIATION_TIMEOUT'].includes(message.code)) {
          connected = false; proto = null;
        }
        notice(message.code || 'BAD_MESSAGE'); return true;
      }
      if (message.type === '@denied') { connected = false; proto = null; notice('FORBIDDEN'); }
      if (proto !== 2) return false;
      if (['init', 'status', 'meta'].includes(message.type) && Object.hasOwn(message, 'run')) run = copy(message.run);
      if (message.type === 'init') { snapshot = true; permissions.clear(); tasks.clear(); }
      for (const item of message.items || []) if (item.kind === 'permission' && item.run && !item.resolved) permissions.set(item.requestId, copy(item.run));
      for (const task of message.meta?.backgroundTasks || []) if (task.run) tasks.set(task.id, copy(task.run));
      for (const task of message.stats?.shellList || []) if (task.run) tasks.set(task.id, copy(task.run));
      if (message.type === 'term:list') for (const t of message.terminals || []) terminals.set(t.id, t.activeRun ?? null);
      if (message.terminal && typeof message.terminal === 'object') terminals.set(message.terminal.id, message.terminal.activeRun ?? null);
      if (message.type === 'term:began') terminals.set(message.terminal.id, message.run?.id || message.run);
      if (message.type === 'term:done' && message.terminal) terminals.set(message.terminal.id, null);
      if (message.type === 'term:exit') terminals.set(message.id, null);
      if (!['ack', 'receipt:missing', 'receipt:error', 'operation', 'operation:missing', 'operation:error'].includes(message.type)) return false;
      if (storage.exclusive && !locked) {
        storage.exclusive(() => receive(message, true)).catch(() => notice('STORAGE_UNAVAILABLE'));
        return true;
      }
      try {
        const disk = read();
        for (const r of disk.records) {
          const local = saved.records.find((s) => recordKey(s) === recordKey(r));
          if (local) Object.assign(local, r); else saved.records.push(r);
        }
      } catch (_) { notice('STORAGE_UNAVAILABLE'); return true; }
      const record = saved.records.find((r) => r.mid === message.mid && current(r) &&
        (message.scope === r.scope || message.type === 'receipt:missing' && message.reason === 'scope_changed'));
      if (!record) return true;
      try {
        if (message.type === 'ack') {
          if (message.target !== record.target || message.what !== record.payload.type ||
              !['applied', 'rejected', 'pending', 'unknown'].includes(message.outcome) || typeof message.admitted !== 'boolean' ||
              !Number.isSafeInteger(message.at) || !(message.expiresAt === null || Number.isSafeInteger(message.expiresAt)) ||
              !['applied', 'rejected', 'pending', 'unknown', 'duplicate'].includes(message.status) ||
              message.status !== 'duplicate' && message.status !== message.outcome ||
              message.outcome === 'applied' && (!message.admitted || !message.result || !['ok', 'noop', 'accepted'].includes(message.result.code) ||
                !message.result.data || !Array.isArray(message.result.replies) || message.error !== null) ||
              ['rejected', 'unknown'].includes(message.outcome) && (!message.error || typeof message.error.code !== 'string') ||
              message.outcome === 'pending' && (message.result !== null || message.error !== null)) return true;
          if (message.outcome === 'applied' && record.payload.type === 'send' &&
              (message.result.code !== 'accepted' || message.result.data.operation !== record.mid ||
               typeof message.result.data.instance !== 'string' || typeof message.result.data.queueId !== 'string')) return true;
          if (message.outcome === 'applied' && !message.result.replies.every((r) => r &&
              (SEMANTIC_REPLIES[record.payload.type] || []).includes(r.type))) return true;
          if (record.ack && ['applied', 'rejected'].includes(record.ack.outcome) &&
              message.outcome !== record.ack.outcome) return true;
          const once = !record.consumed && message.outcome === 'applied';
          record.ack = copy(message);
          record.state = message.outcome === 'applied' ? message.result.code === 'accepted' ? 'accepted' : 'completed' : message.outcome;
          if (once) record.consumed = true;
          if (message.outcome === 'unknown') record.quarantined = true;
          if (message.outcome === 'applied') record.quarantined = false;
          persist(); changed(record);
          if (once) for (const reply of message.result.replies) emit({ ...reply, intentMid: record.mid });
          if (record.state === 'accepted') lookup(record);
        } else if (message.type === 'receipt:missing') {
          // One resend per connection. Controls require a new user decision,
          // even after a fresh snapshot: a previous click cannot target it.
          const control = record.payload.run || record.payload.answerTo || record.payload.terminalRun !== undefined;
          if (message.reason === 'not_found' && fresh(record) && record.state === 'pending' && !record.ack && !record.quarantined && !control) write(record);
          else { record.unresolved = message.reason; if (!fresh(record) || ['expired', 'scope_changed'].includes(message.reason)) record.quarantined = true; changed(record); }
        } else if (message.type === 'operation') {
          if (message.target !== record.target || !Number.isSafeInteger(message.revision) ||
              !['queued', 'dispatching', 'accepted', 'completed', 'rejected', 'unknown'].includes(message.state) ||
              record.operation && record.operation.revision >= message.revision) return true;
          record.operation = copy(message); persist(); changed(record);
        } else { record.unresolved = message.code || message.reason; changed(record); }
      } catch (_) { notice('STORAGE_UNAVAILABLE', record); }
      return true;
    }
    return { post, receive, allowed, acceptsComposition,
      pin(value) { pin = config.hostFingerprint || value; },
      disconnect() { connected = false; proto = null; binding = null; snapshot = false; outstanding.clear(); if (poll) clearTimeout(poll); poll = null; },
      records: () => copy(saved.records),
      get proto() { return proto; }, get ready() { return connected && proto !== null; },
      reconcile() { for (const record of saved.records) lookup(record); },
      dismiss(mid, locked = false) {
        if (storage.exclusive && !locked) return storage.exclusive(() => this.dismiss(mid, true)).catch(() => false);
        try { saved = read(); } catch (_) { return false; }
        const before = saved;
        saved = { ...saved, records: saved.records.filter((r) => r.mid !== mid ||
          !['completed', 'rejected'].includes(r.state) && !['completed', 'rejected'].includes(r.operation?.state)) };
        try {
          // An explicit dismissal is the only removal operation.
          const text = JSON.stringify(saved); storage.write(text);
          if (storage.read() !== text) throw new Error('STORAGE_UNAVAILABLE');
          return true;
        } catch (_) { saved = before; return false; }
      }
    };
  }

  /**
   * Where a conversation lives, for whoever is hosting this client: a path on
   * the laptop when it served the page, a page in the bundle when an app did.
   */
  function conversationUrl(id) {
    const remote = window.NIKUI_REMOTE || {};
    return (remote.conversation || '/s/') + encodeURIComponent(id);
  }

  /** What VS Code keeps for a hidden webview, kept in localStorage instead. */
  function browserState(key) {
    return {
      getState: function () {
        try { return JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (_) { return null; }
      },
      setState: function (value) {
        try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
        return value;
      }
    };
  }

  /**
   * A socket that behaves like the VS Code API: post a message, get messages
   * back as `message` events on window, keep a little state across reloads.
   */
  function socketTransport(config) {
    const state = browserState('nikui:' + (config.session || 'unknown'));
    const pill = document.getElementById('link');
    let socket = null;
    let tries = 0;
    let retry = null;
    let wantsReady = false;   // the client has said `ready` at least once
    let closing = false;
    let seated = false;       // the handshake is done and this socket may talk
    let stopped = null;       // a refusal worth showing instead of retrying
    let expecting = null;     // the nonces this device is waiting to see signed
    let said = 0;             // how many times the pill has been written to
    let holdUntil = 0;        // a message that has to be read before it is replaced
    let paired = false;       // this device has an identity, so it must verify
    let opening = null;       // the sealed channel for this socket, once agreed
    let box = null;           // the same thing, once it has been built
    let outgoing = null;      // sealing is asynchronous; order is not optional
    let incoming = null;      // and neither is the order things are opened in
    let pendingWelcome = null, deferredDevice = null;
    const outboxKey = 'nikui:outbox:v1:' + (config.hostFingerprint || new URL(config.origin || window.location.href).origin);
    const application = negotiatedClient({ config, send, emit: applicationEvent, storage: {
      read: () => window.localStorage.getItem(outboxKey),
      write: (text) => window.localStorage.setItem(outboxKey, text),
      exclusive: (fn) => Promise.resolve().then(() => window.navigator?.locks?.request
        ? window.navigator.locks.request(outboxKey, fn) : Promise.reject(new Error('STORAGE_UNAVAILABLE')))
    } });

    function applicationEvent(message) {
      if (message.type === 'intent:error') show('warn', message.message, 8000);
      if (message.type === 'intent' && (message.record.state === 'unknown' || message.record.operation?.state === 'unknown'))
        show('warn', 'The earlier action may have completed. Review before sending again.', 8000);
      tell(message);
      if (message.type === 'protocol' && message.ready && pendingWelcome) {
        show('on', 'Live');
        if (deferredDevice) application.receive({ type: '@device', device: deferredDevice });
        // Old shared shell surfaces also receive their welcome only after the
        // application lane is ready. Their initial queries/@listen cannot race
        // hello, nor can they expose live controls during negotiation.
        tell({ ...pendingWelcome, negotiated: message.proto, caps: message.caps,
          device: deferredDevice || pendingWelcome.device });
        pendingWelcome = null; deferredDevice = null;
      }
    }

    function url() {
      // An app carries the client in a bundle, so there is no page address to
      // infer the laptop from: it is told one, absolutely, and that address
      // keeps its own scheme. A served page still works out where it came from.
      if (/^wss?:\/\//i.test(config.socket || '')) return config.socket;
      const at = new URL(config.socket || '/socket', window.location.href);
      at.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return at.toString();
    }

    /** Somewhere on the laptop, from wherever this client happens to be. */
    function at(route) {
      return config.origin ? config.origin.replace(/\/$/, '') + route : route;
    }

    /**
     * The state of the connection, in a word.
     *
     * `hold` keeps a message up for a moment against the background chatter of
     * reconnecting. "Your prompt was not sent" is the one line here that is
     * about something the reader did, and a retry notice a tenth of a second
     * later would take it away before it had been read.
     */
    function show(kind, text, hold) {
      if (holdUntil > Date.now() && kind !== 'on' && !hold) return;
      holdUntil = hold ? Date.now() + hold : 0;
      said++;
      if (!pill) return;
      pill.className = 'link ' + kind;
      pill.textContent = text;
      pill.hidden = false;
    }

    /** Try again now, rather than when the backoff says so. */
    function retryNow() {
      if (live()) return;
      tries = 0;
      stopped = null;
      connect();
    }

    /**
     * Start the connection over, including one that is working.
     *
     * Only one thing needs this: the handshake is where a device presents a
     * replacement key, so moving a key into the chip means doing the handshake
     * again. Doing it while somebody is looking at the button they pressed is
     * the whole point — the alternative is a face check arriving at a random
     * moment hours later.
     */
    function reconnect() {
      tries = 0;
      stopped = null;
      const open = socket;
      socket = null;
      seated = false;
      expecting = null;
      opening = null;
      box = null;
      pendingWelcome = null; deferredDevice = null;
      application.disconnect();
      if (open) { try { open.close(1000, 'reconnecting'); } catch (_) { /* already gone */ } }
      connect();
    }

    // The state of the connection is also the button for doing something about
    // it: on a phone, the thing you want when it says offline is to try again.
    if (pill) pill.addEventListener('click', retryNow);

    // Two moments when waiting out a backoff is obviously wrong: the phone has
    // just been picked up, and the network has just come back. A page that sits
    // there saying "reconnecting" for eight more seconds while somebody stares
    // at it is a page that looks broken.
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) retryNow();
      });
    }
    if (window.addEventListener) window.addEventListener('online', retryNow);

    /**
     * Anything this transport makes up for its own page.
     *
     * Always on a later turn of the loop, never inside the call that caused it.
     * A real message from the host arrives asynchronously, and a synthetic one
     * that does not is a reentrant call: `postMessage` refusing a prompt used to
     * hand the text back *during* the client's send, which then cleared the
     * composer on the line after — so the refusal erased exactly what it was
     * trying to save.
     */
    function tell(message) {
      setTimeout(function () {
        window.dispatchEvent(new MessageEvent('message', { data: message }));
      }, 0);
    }

    /**
     * In. Sealed frames are opened before anything looks at them, one at a
     * time and in order — the counter inside each one is only meaningful in
     * sequence, and a reordered stream would look like a replay.
     */
    function deliver(data) {
      let message = null;
      try { message = JSON.parse(data); } catch (_) { return; }
      if (message && message.type === '@box') {
        if (!opening) return; // nothing was agreed; there is nothing to open it with
        const on = socket;
        incoming = (incoming || Promise.resolve())
          .then(function () { return opening; })
          .then(function (sealed) {
            if (!sealed || on !== socket) return null;
            return sealed.open(message);
          })
          .then(function (inside) {
            if (inside === null || inside === undefined) {
              if (on !== socket) return;
              // A frame that will not open is not a glitch to skip past: either
              // the key is wrong or somebody is editing the stream.
              stopped = 'could not open what the laptop sent';
              show('off', 'Could not read the laptop’s reply');
              try { on.close(1008, 'unsealed'); } catch (_) { /* gone */ }
              return;
            }
            handle(inside);
          })
          .catch(function () { /* the socket will say so */ });
        return;
      }
      handle(data, message);
    }

    /** One message, already out of its envelope if it was in one. */
    function handle(data, parsed) {
      let message = parsed;
      if (message === undefined) {
        try { message = JSON.parse(data); } catch (_) { return; }
      }
      if (message && typeof message.type === 'string' && message.type.charAt(0) === '@') {
        if (handshake(message)) return;
      }
      if (message?.type === '@device' && !application.ready) { deferredDevice = message.device; return; }
      if (application.receive(message)) return;
      window.dispatchEvent(new MessageEvent('message', { data: message }));
    }

    /**
     * Before this socket carries anything, it has to say who is holding it.
     *
     * On the laptop the key in the cookie has already settled that and the
     * welcome arrives unprompted. Anywhere else the server sends a nonce, this
     * device signs it with the key it cannot export, and the server signs back
     * with the key whose fingerprint was pinned at pairing — so neither end is
     * taking the other's word for it.
     *
     * @returns {boolean} whether the message was the transport's own business
     */
    function handshake(message) {
      if (message.type === '@challenge') {
        answer(message);
        return true;
      }
      if (message.type === '@welcome') {
        // A welcome that nobody was asked for is somebody skipping the question.
        // The only client allowed to accept one is a browser with no identity to
        // prove — which cannot be lied to about a laptop it never pinned.
        if (!expecting) {
          if (!paired) return seat(message);
          stopped = 'unproven laptop';
          show('off', 'This is not the laptop this device paired with');
          return true;
        }
        const awaited = expecting;
        const on = socket;
        expecting = null;
        window.nikDevice.load().then(function (record) {
          return window.nikDevice.verifyLaptop(
            record, message.serverKey || awaited.serverKey,
            'nikui-host:' + awaited.mine + ':' + awaited.theirs + (awaited.suffix || ''),
            message.signature
          );
        }).then(function (ok) {
          if (on !== socket) return;
          if (ok) {
            settleUpgrade(message);
            return seat(message);
          }
          stopped = 'unproven laptop';
          show('off', 'This is not the laptop this device paired with');
          tell({ type: '@denied', reason: 'This is not the laptop this device paired with.' });
          if (socket) try { socket.close(1008, 'unproven'); } catch (_) { /* gone */ }
        }).catch(function () {
          stopped = 'unproven laptop';
          show('off', 'Could not check the laptop');
        });
        return true;
      }
      if (message.type === '@navigate') {
        // Another instance, on this device only. The laptop's tabs are the
        // laptop's business.
        if (message.session) window.location.assign(conversationUrl(message.session));
        return true;
      }
      if (message.type === '@denied') {
        seated = false;
        stopped = message.reason || 'refused';
        show('off', reasonText(stopped));
        return false;
      }
      return false;
    }

    /** Let the page talk: everything above this line is about who is listening. */
    function seat(message) {
      seated = true;
      tries = 0;
      stopped = null;
      if (message.proto) { pendingWelcome = message; show('warn', 'Negotiating…'); }
      else show('on', 'Live');
      application.receive(message);
      if (!message.proto) window.dispatchEvent(new MessageEvent('message', { data: message }));
      return true;
    }

    function answer(challenge) {
      const on = socket;
      application.pin(challenge.fingerprint || config.hostFingerprint || url());
      if (!window.nikDevice || !window.nikDevice.available()) {
        // No Web Crypto here at all, so no identity is possible: the only way
        // in is the key this page arrived with, and the server decides.
        paired = false;
        send({ type: '@auth', device: null, nonce: randomNonce() });
        return;
      }
      window.nikDevice.load().then(function (record) {
        if (on !== socket) return;
        if (!record || !record.id) {
          // Nothing to prove: say so, and let the server decide whether the key
          // this page arrived with is enough.
          // A nonce even so, so the laptop signs this welcome like any other.
          paired = false;
          send({ type: '@auth', device: null, nonce: randomNonce() });
          return;
        }
        paired = true;
        // Pinning, from this side: the laptop that answers has to be the one
        // this device paired with, not merely something at the same address.
        if (record.fingerprint && challenge.fingerprint && record.fingerprint !== challenge.fingerprint) {
          stopped = 'wrong laptop';
          show('off', 'This is not the laptop this device paired with');
          tell({ type: '@denied', reason: 'This is not the laptop this device paired with.' });
          return;
        }
        const mine = randomNonce();
        // A throwaway key for this one connection, when the laptop offered one.
        // Both keys go into what this device signs, so an impostor cannot swap
        // either for its own, and cannot strip the offer to force a connection
        // it could read.
        return agreeKey(challenge).then(function (seal) {
          if (on !== socket) return;
          const suffix = seal ? ':' + seal.binding : '';
          // Remembered so the welcome can be checked against what was asked, not
          // against whatever the answer happens to contain.
          expecting = {
            mine: mine, theirs: challenge.nonce, serverKey: challenge.serverKey, suffix: suffix
          };
          // Which may also be a request to start using a better key — see
          // media/device.js. The transport does not need to know which; it sends
          // what the identity says to send.
          return window.nikDevice.authMessage(record, challenge.nonce, mine, suffix)
            .then(function (message) {
              if (on !== socket) return;
              if (seal) message.epk = seal.mine.spki;
              // Started before the answer goes out, so a laptop that replies
              // the instant it reads it is never replying to a client with
              // nothing to open the reply with. `send` still sends the answer
              // itself in the clear: it is what agrees the key.
              if (seal) {
                opening = window.nikSecure.clientBox(seal.mine, challenge.epk, challenge.nonce, mine);
                opening.then(function (sealed) { if (on === socket) box = sealed; });
              }
              send(message);
            });
        });
      }).catch(function () {
        stopped = 'could not sign';
        show('off', 'This device could not sign in');
      });
    }

    /**
     * A key that was waiting to replace the current one, now that the laptop
     * has answered.
     *
     * The old key stops being this device's identity at exactly one moment: the
     * laptop saying it has taken the new one, in a welcome this device has
     * already proved came from the laptop it paired with. A welcome without
     * that means the request did not land — an older laptop, a refusal — and
     * the replacement is thrown away rather than tried forever.
     */
    function settleUpgrade(message) {
      const identity = window.nikDevice;
      if (!identity || !identity.load) return;
      identity.load().then(function (record) {
        if (!record || !record.staged) return null;
        return message.rekeyed ? identity.commitUpgrade() : identity.discardUpgrade();
      }).then(function (settled) {
        if (settled === null || settled === undefined) return;
        window.dispatchEvent(new CustomEvent('nikui-key-moved', {
          detail: { taken: !!message.rekeyed, protection: message.rekeyed && message.rekeyed.protection }
        }));
      }).catch(function () { /* the next connection asks again */ });
    }

    /**
     * The throwaway key half of the handshake, when both ends can do it.
     *
     * A client with no identity to prove does not seal: there would be nothing
     * binding the agreement to anybody, which is encryption that proves nothing
     * and hides the fact. That client is the laptop's own browser, on loopback,
     * holding the key — the one case where there is no network to hide from.
     */
    function agreeKey(challenge) {
      if (!challenge.epk || !window.nikSecure || !window.nikSecure.available()) {
        return Promise.resolve(null);
      }
      return window.nikSecure.ephemeral().then(function (mine) {
        return window.nikSecure.binding(challenge.epk, mine.spki).then(function (binding) {
          return { mine: mine, binding: binding };
        });
      }).catch(function () { return null; });
    }

    function randomNonce() {
      const bytes = new Uint8Array(24);
      (window.crypto || {}).getRandomValues(bytes);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function reasonText(reason) {
      if (/not paired/i.test(reason)) return 'This device is not paired';
      if (/removed/i.test(reason)) return 'This device was removed';
      if (/laptop|unproven/i.test(reason)) return 'This is not the laptop this device paired with';
      return 'Refused';
    }

    function connect() {
      if (closing || (socket && (socket.readyState === 0 || socket.readyState === 1))) return;
      if (retry) { clearTimeout(retry); retry = null; }
      show(tries ? 'warn' : 'on', tries ? 'Reconnecting…' : 'Connecting…');

      let next;
      try { next = new WebSocket(url()); } catch (_) { return schedule(); }
      socket = next;

      next.onopen = function () {
        tries = 0;
        seated = false;
        expecting = null;
        // Every connection agrees its own key, so nothing survives a reconnect.
        opening = null;
        box = null;
        outgoing = null;
        incoming = null;
        pendingWelcome = null; deferredDevice = null;
        // Not live yet: the socket is open, but nothing may be said on it until
        // the server has decided who is holding it. `ready` waits for @welcome.
        show('warn', 'Signing in…');
      };
      next.onmessage = function (event) { if (next === socket) deliver(event.data); };
      next.onerror = function () { /* onclose always follows */ };
      next.onclose = function () {
        if (next !== socket) return;
        socket = null;
        seated = false;
        application.disconnect();
        if (closing) return;
        // A refusal is not a network problem. Retrying every second would only
        // fill a log; the state stays on screen until something changes.
        if (stopped) { show('off', reasonText(stopped)); return; }
        schedule();
      };
    }

    /**
     * Why it is not connected, told apart rather than guessed at.
     *
     * "The tunnel is down" and "the laptop is awake but would not have me" look
     * identical from a dead socket, and on a phone that difference is the whole
     * question. The page itself came from the same origin, so asking it one
     * cheap question settles it.
     */
    function diagnose() {
      if (typeof fetch !== 'function') return;
      // Whatever the pill says when the answer comes back, it is more recent
      // than this question — and "your prompt was not sent" is the one message
      // that must not be quietly replaced by a weather report.
      const asked = said;
      const stale = () => live() || said !== asked;
      fetch(at('/health'), { cache: 'no-store' }).then(function (response) {
        if (!stale()) show('warn', response.ok ? 'The laptop is there — reconnecting' : 'Reconnecting…');
      }).catch(function () {
        if (!stale()) show('off', 'Cannot reach the laptop');
      });
    }

    function schedule() {
      show('off', tries ? 'Offline — retrying' : 'Offline');
      diagnose();
      const wait = BACKOFF[Math.min(tries, BACKOFF.length - 1)];
      tries++;
      if (retry) clearTimeout(retry);
      // A little jitter so a laptop waking up does not reconnect every tab at
      // exactly the same millisecond.
      retry = setTimeout(connect, wait + Math.floor(Math.random() * 250));
    }

    /**
     * Out. Handshake frames go in the clear — there is nothing agreed to seal
     * them with yet, and nothing in them worth hiding. Everything after is
     * sealed, in the order it was said: sealing is asynchronous, and a queue
     * that let two messages race would deliver them with counters that no
     * longer match the order the other end reads them in.
     */
    function send(message) {
      if (!box) return socket.send(JSON.stringify(message));
      const on = socket;
      const channel = box;
      outgoing = (outgoing || Promise.resolve())
        .then(function () { if (on !== socket) return null; return channel.seal(JSON.stringify(message)); })
        .then(function (frame) {
          if (frame && on === socket && on.readyState === 1) on.send(JSON.stringify(frame));
        })
        .catch(function () { /* a dead socket is not a message to retry */ });
    }

    function live() {
      return !!socket && socket.readyState === 1 && seated;
    }

    /**
     * A prompt that vanishes is worse than a prompt that was refused, so an
     * offline `send` comes straight back to the composer as an `editPrompt` —
     * the same message the host uses to hand back a queued prompt. The client
     * needs no branch for it, and the words are still there when the signal is.
     */
    function refuse(message) {
      if (message && message.type === 'send') {
        const images = (message.attachments || []).length;
        show('off', images ? 'Offline — not sent, images dropped' : 'Offline — not sent', 8000);
        // After the client has finished sending, not during it.
        tell({ type: 'editPrompt', text: message.text || '' });
      } else {
        show('off', 'Offline');
      }
    }

    // A phone closes sockets when the screen locks and a laptop closes them when
    // it sleeps; both come back through one of these.
    window.addEventListener('online', function () { tries = 0; stopped = null; connect(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !live()) { tries = 0; connect(); }
    });
    window.addEventListener('pagehide', function () {
      closing = true;
      application.disconnect();
      if (socket) { try { socket.close(1001, 'leaving'); } catch (_) { /* gone */ } }
    });

    connect();

    return {
      postMessage: function (message, composition) {
        if (message && message.type === 'ready') {
          // Asked for once, sent on every socket that gets a seat. Saying it
          // into a socket that is still signing in would only be dropped.
          wantsReady = true;
          return application.post({ ...message, hidden: !!document.hidden });
        }
        // Being on screen or not is only news to a laptop that is listening.
        if (!live() && message && message.type === 'visible') return;
        if (!live()) {
          if (application.records().length) return application.post(message);
          refuse(message); return false;
        }
        try { return application.post(message, composition); } catch (_) { refuse(message); return false; }
      },
      getState: state.getState,
      setState: state.setState,
      // Shown as a state, offered as an action: anything on the page that wants
      // a retry button can call this rather than reloading.
      retry: retryNow,
      reconnect: reconnect,
      application: application,
      // For the tests, and for anyone wondering in a console why nothing moves.
      __socket: function () { return socket; },
      /** Whether this connection is sealed, for anything that wants to say so. */
      sealed: function () { return !!box; },
      __state: function () { return live() && application.ready ? 'online' : (stopped ? 'refused' : (tries ? 'reconnecting' : 'offline')); }
    };
  }

  /**
   * The seam. In the panel this is `acquireVsCodeApi()` and nothing else
   * happens; in a browser it is a socket wearing the same three methods.
   */
  window.nikTransport = function () {
    if (typeof acquireVsCodeApi === 'function') {
      const api = acquireVsCodeApi();
      if (!window.NIKUI_DEV_BRIDGE) return api;
      const config = window.NIKUI_DEV_BRIDGE;
      const key = '__nikuiIntents';
      const app = negotiatedClient({ config, send: (m) => api.postMessage(m),
        emit: (m) => setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: m })), 0),
        storage: {
          read: () => (api.getState() || {})[key] || null,
          write: (text) => api.setState({ ...(api.getState() || {}), [key]: text })
        } });
      window.addEventListener('message', function (event) {
        if (event.data?.type === 'bridge:offline') app.disconnect();
        if (app.receive(event.data)) event.stopImmediatePropagation?.();
      });
      api.postMessage({ type: 'bridge:listen' });
      return { postMessage: (m, composition) => m?.type === 'bridge:open' ? api.postMessage(m) : app.post(m, composition), application: app,
        getState: api.getState,
        setState: (value) => api.setState({ ...value, [key]: (api.getState() || {})[key] }) };
    }
    const made = socketTransport(window.NIKUI_REMOTE || {});
    // The live one, for anything outside the client that has to say something
    // on this socket rather than open a second one. There is exactly one such
    // thing: the app telling the laptop where Apple can reach this phone.
    window.nikLink = made;
    return made;
  };

  // Exported so the offline suite can drive it with a fake socket.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { socketTransport, negotiatedClient, acceptsComposition, conversationUrl, BACKOFF, CORE_CAPS, OPTIONAL_CAPS };
  }
})();
