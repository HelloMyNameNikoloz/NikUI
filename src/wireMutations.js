'use strict';

const path = require('path');
const crypto = require('crypto');
const { createNegotiation, requireThat, immutable, object, ERROR_CODES, validateEnvelope } = require('./protocolV2');
const { wireError } = require('./receiptDispatcher');
const { DOMAIN, allocate } = require('./engineState');
const { mayMutate, LOCAL } = require('./mutationGrants');
const { SETUP_URL } = require('./slackRoom');

const REVOCATIONS = 'engine.deviceRevocations.v1';
const SEEN = 'engine.slackSeen.v1';
const BUSINESS = ['NOT_FOUND', 'STALE_RESOURCE', 'UNSUPPORTED', 'LOCAL_REQUIRED', 'FORBIDDEN', 'BAD_MESSAGE', 'CANCELLED', 'EDITOR_UNAVAILABLE', 'UI_UNAVAILABLE', 'PROVIDER_REJECTED'];
const CONVERSATION = new Set(['ready', 'visible', 'send', 'interrupt', 'stopTask', 'unqueue', 'promoteQueued', 'editQueued', 'clearQueue',
  'permission', 'setSetting', 'saveCommand', 'removeCommand', 'restoreCommand', 'allSettings', 'slack', 'openPr', 'openFile', 'runInTerminal',
  'switch', 'pr:pane', 'pr:reply', 'pr:resolve', 'pr:comment', 'pr:rerun', 'pr:link', 'pr:unlink', 'pr:open']);
const FLEET = new Set(['forget', 'awake:set', 'lid:set', 'instance:new', 'instance:resume', 'instance:place',
  'term:open', 'term:run', 'term:stop', 'term:close', 'slack:open', 'slack:reply', 'slack:mute', 'slack:vips', 'slack:enable',
  'slack:connect', 'slack:disconnect', 'slack:signIn', 'slack:settings', 'slack:setup', 'slack:link', 'slack:openTicket']);
const HUB_QUERIES = new Set(['status', 'statusOpen', 'settings', 'settingsOpen', 'commands', 'commandsOpen',
  'pr:watch', 'pr:refresh', 'pr:diff', 'pr:mentions', 'pr:askThread', 'pr:askCheck', 'pr:askConflicts', 'voice', 'voice:state']);
const FLEET_QUERIES = new Set(['ready', 'history', 'status', 'devices', 'awake', 'codex:watch', 'term:list', 'term:attach', 'term:detach',
  'slack:ready', 'slack:refresh', 'slack:older', 'slack:file', 'voice', 'voice:state']);
const typed = (data, replies = [], code = 'ok') => ({ code, data, replies });
const applied = (data, replies, code) => ({ outcome: 'applied', result: typed(data, replies, code) });
const rejected = (code) => ({ outcome: 'rejected', error: wireError(ERROR_CODES.has(code) ? code : 'PROVIDER_REJECTED') });
const unknown = () => ({ outcome: 'unknown', error: wireError('OUTCOME_UNKNOWN') });
const str = (v, max = 1024) => typeof v === 'string' && v.length > 0 && v.length <= max;
const enrollment = (d) => d ? crypto.createHash('sha256').update(JSON.stringify([d.id, d.publicKey || null, d.pairedAt || null])).digest('hex') : null;
const domain = (state) => state.values[DOMAIN];
function reconcileDeviceRevocations(authority, devices, audience, only = null) {
  for (const r of authority.snapshot().values[REVOCATIONS] || []) {
    if (only && r.device !== only) continue;
    const d = devices?.get(r.device);
    if (d && enrollment(d) === r.enrollment) { devices.forget(r.device); audience?.forget(r.device); }
  }
}
function validateMutationState(state) {
  const revocations = state.values[REVOCATIONS], seen = state.values[SEEN];
  requireThat(revocations === undefined || Array.isArray(revocations) && revocations.every((r) => object(r) && str(r.device) &&
    typeof r.enrollment === 'string' && /^[a-f0-9]{64}$/.test(r.enrollment)), 'STORAGE_UNAVAILABLE');
  requireThat(seen === undefined || object(seen) && Object.values(seen).every((s) => object(s) &&
    typeof s.ts === 'string' && /^\d+(?:\.\d+)?$/.test(s.ts) && Number.isFinite(Number(s.ts)) &&
    Number.isSafeInteger(s.at) && s.at >= 0), 'STORAGE_UNAVAILABLE');
}

/** Opted-in wire routing for both fleet sockets and direct conversation clients.
 * Network construction still forces v1 in RemoteClient. No handler infers a
 * mutation result from post(), and unknown mutations never reach legacy code.
 */
function createMutationSocket({ currentState, server = null, hub = null, client, context, post: output,
  close = () => {}, legacy, ...options }) {
  requireThat(currentState && client && context, 'BAD_MESSAGE');
  context = immutable(context);
  const authority = currentState.dispatcher.authority;
  const originalPost = client.post, send = output || originalPost.bind(client);
  const originalHubPost = hub?.clients.get(client.id)?.client.post;
  let protocol;
  function post(message) {
    const publicError = message?.type === 'ack' && message.result === null ||
      ['protocol:error', 'receipt:error', 'operation:error'].includes(message?.type);
    if (protocol?.proto === 2 && !publicError) {
      try {
        currentState.dispatcher.checkView(context);
        if (message?.type?.startsWith('term:')) grant(context, message);
      }
      catch (_) { return false; }
    }
    if (protocol?.proto === 2 && message?.type?.startsWith('term:') && message.terminal && typeof message.terminal === 'object') {
      const running = message.type === 'term:began' ? message.run : server?.terminals?.get(message.terminal.id)?.running;
      message = { ...message, terminal: { ...message.terminal,
        activeRun: running?.id || null, busy: !!running, command: running?.command || null } };
    }
    return send(message);
  }
  const host = hub?.host || server?.host || {};
  const session = hub?.session || null;
  const entry = () => hub?.clients.get(client.id);
  const getSession = (id) => server ? server.sessions.get(id) : host.manager?.get(id) ||
    host.fleet?.().find((s) => s.id === id) || (session?.id === id ? session : null);
  const room = () => server?.slack?.() || null;
  const device = () => context.principal.startsWith('device:') ? server?.devices?.get(context.principal.slice(7)) : null;
  if (server && context.principal.startsWith('device:')) currentState.bindPrincipal(context.principal, server, () => {
    const d = device(); return d && !currentState.isDeviceRevoked(d.id, enrollment(d)) ? d : null;
  });
  const revoked = () => (authority.snapshot().values[REVOCATIONS] || []).some((r) => r.device === device()?.id && r.enrollment === enrollment(device()));
  function checkLive(trusted = context) {
    currentState.dispatcher.checkView(trusted);
    if (server && trusted.principal.startsWith('device:')) requireThat(device(), 'FORBIDDEN');
  }
  function grant(trusted, message) {
    checkLive(trusted);
    const d = device();
    const live = d ? { ...trusted, seat: { ...trusted.seat, control: d.control === true,
      local: trusted.seat.local === true && d.local === true && d.control === true } } : trusted;
    requireThat(!LOCAL.has(message.type) || live.seat.local, 'LOCAL_REQUIRED');
    requireThat(mayMutate(live, message), 'FORBIDDEN');
  }
  const requester = (trusted) => Object.freeze({ client: client.id, device: trusted.seat.local ? null : trusted.principal.slice(7),
    local: trusted.seat.local, editor: trusted.seat.editor ? trusted.seat.id : null, proto: 2 });
  function captureSession() {
    requireThat(session && getSession(session.id) === session && !session.disposed, 'NOT_FOUND');
    return { session, cwd: session.cwd, proc: session.provider === 'codex' ? session.workspace.client.proc : session.proc,
      attaching: session._attaching || null, prUrl: session.prUrl || null, prPinned: !!session.prPinned, run: session._engineControls?.run() || null };
  }
  function validSession(c, { pr = false, run = false } = {}) {
    if (c?.error) throw c.error;
    requireThat(c?.session && getSession(c.session.id) === c.session && !c.session.disposed && c.session.cwd === c.cwd, 'STALE_RESOURCE');
    if (pr) requireThat((c.session.prUrl || null) === c.prUrl && !!c.session.prPinned === c.prPinned, 'STALE_RESOURCE');
    if (run) requireThat((c.session.provider === 'codex' ? c.session.workspace.client.proc : c.session.proc) === c.proc, 'STALE_RESOURCE');
  }
  // These closures are memory-only. Retained payloads contain explicit data,
  // never session/provider objects or credentials.
  function external(roles, cap, capture, prepare, execute, validate) {
    return { roles, ...(cap ? { cap } : {}), businessErrors: BUSINESS, ...(validate ? { validate } : {}), capture,
      prepare(args) {
        grant(args.context, args.message);
        if (args.captured?.error) throw args.captured.error;
        return prepare(args);
      },
      async execute(args) {
        try { grant(args.context, args.message); if (args.captured?.error) throw args.captured.error; }
        catch (error) { return rejected(error.code); }
        return execute(args);
      } };
  }
  function preflight(fn) { try { fn(); return null; } catch (error) { return rejected(error.code); } }
  const handlers = {};
  if (hub) {
    handlers.ready = external(['conversation'], null, captureSession,
      ({ state, message, captured: c, context: trusted }) => {
        validSession(c, { run: true });
        const hidden = message.hidden === true;
        if (!hidden && !trusted.seat.local) {
          const saved = domain(state).instances.find((s) => s.id === session.id); requireThat(saved, 'NOT_FOUND'); saved.unread = false;
        }
        return { instance: session.id, start: !session.isRunning && !c.attaching && host.autoStart !== false &&
          (device() ? device().control === true : trusted.seat.control), run: c.run };
      },
      async ({ captured: c, payload, context: trusted, message }) => {
        if (c.attaching) { try { await c.attaching; } catch (_) { return rejected('STALE_RESOURCE'); } }
        const stale = preflight(() => { grant(trusted, message); validSession(c, { run: true }); }); if (stale) return stale;
        if (payload.start && (device() ? device().control === true : trusted.seat.control === true)) {
          if (session.isRunning || session._attaching) return rejected('STALE_RESOURCE');
          await session.start();
          if (preflight(() => validSession(c)) || !session.isRunning) return unknown();
        }
        await currentState.flush();
        return applied({ instance: session.id, run: session._engineControls?.run() || null });
      }, (m) => requireThat(m.hidden === undefined || typeof m.hidden === 'boolean'));
    handlers.visible = { roles: ['conversation'], businessErrors: BUSINESS, capture: captureSession,
      validate: (m) => requireThat(typeof m.on === 'boolean'),
      apply({ state, message, context: trusted, captured: c }) {
        grant(trusted, message); validSession(c);
        const saved = domain(state).instances.find((s) => s.id === session.id); requireThat(saved, 'NOT_FOUND');
        if (message.on && !trusted.seat.local) saved.unread = false;
        return typed({ on: message.on });
      } };
    for (const type of ['pr:reply', 'pr:resolve', 'pr:comment', 'pr:rerun']) handlers[type] = external(['conversation'], 'pr-v1',
      ({ message }) => {
        const c = captureSession();
        // Even the runner cwd and failed-check set belong to this original PR.
        if (typeof host.prFeed?.freezeMutation === 'function') {
          try { c.plan = host.prFeed.freezeMutation(type.slice(3), c.prUrl, message); }
          catch (error) { c.error = error; }
        }
        c.feed = host.prFeed; return c;
      },
      ({ message, captured: c }) => {
        validSession(c, { pr: true });
        requireThat(str(message.prUrl) && message.prUrl === c.prUrl, 'STALE_RESOURCE');
        requireThat(c.plan && typeof c.feed?.executeMutation === 'function', 'UNSUPPORTED');
        return { plan: c.plan };
      },
      async ({ payload, captured: c, context: trusted, message }) => {
        const guard = () => { grant(trusted, message); validSession(c, { pr: true }); requireThat(host.prFeed === c.feed, 'STALE_RESOURCE'); };
        const stale = preflight(guard); if (stale) return stale;
        return c.feed.executeMutation(payload.plan, guard);
      }, (m) => {
        requireThat(str(m.prUrl));
        if (['pr:reply', 'pr:resolve'].includes(type)) requireThat(str(m.threadId));
        if (['pr:reply', 'pr:comment'].includes(type)) requireThat(str(m.body, 12000));
        if (type === 'pr:resolve') requireThat(m.resolved === undefined || typeof m.resolved === 'boolean');
      });
    for (const type of ['pr:link', 'pr:unlink']) handlers[type] = external(['conversation'], 'pr-v1',
      () => ({ ...captureSession(), choosePr: host.choosePr }),
      ({ message, captured: c }) => {
        validSession(c, { pr: true }); requireThat(message.prUrl === c.prUrl, 'STALE_RESOURCE');
        if (type === 'pr:link') requireThat(typeof c.choosePr === 'function', 'UI_UNAVAILABLE');
        return { instance: session.id, prUrl: c.prUrl };
      },
      async ({ captured: c, message, context: trusted }) => {
        const guard = () => { grant(trusted, message); validSession(c, { pr: true });
          if (type === 'pr:link') requireThat(host.choosePr === c.choosePr, 'STALE_RESOURCE'); };
        const stale = preflight(guard); if (stale) return stale;
        const url = type === 'pr:link' ? await c.choosePr({ instance: session.id, cwd: c.cwd, prUrl: c.prUrl }, requester(trusted)) : null;
        if (type === 'pr:link' && url === null) return rejected('CANCELLED');
        const changed = preflight(() => { guard(); requireThat(url === null || /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url), 'BAD_MESSAGE'); });
        if (changed) return changed;
        let pane;
        await authority.commit((state) => {
          guard(); const saved = domain(state).instances.find((s) => s.id === session.id); requireThat(saved && (saved.prUrl || null) === c.prUrl, 'STALE_RESOURCE');
          saved.prUrl = url; saved.prPinned = !!url; pane = saved.prPane || null;
        });
        return applied({ prUrl: url, pane });
      });
  }
  for (const type of ['instance:new', 'instance:resume']) handlers[type] = external(['fleet'], null,
    ({ message }) => ({ create: message.provider === 'codex' ? server?.codex : server?.createInstance,
      resume: server?.resumeInstance, cwd: message.cwd, folderId: message.folderId || null, history: null }),
    ({ state, message, captured: c }) => {
      requireThat(server, 'UNSUPPORTED');
      const folders = domain(state).folders;
      requireThat(!c.folderId || folders.folders.some((f) => f.id === c.folderId), 'NOT_FOUND');
      if (type === 'instance:new') {
        const fleet = server.fleetMessage(), allowed = new Set((fleet.projects || []).map((p) => p.path));
        if (message.provider === 'codex') for (const s of fleet.codex || []) allowed.add(s.cwd);
        requireThat(c.create && allowed.has(c.cwd), c.create ? 'BAD_MESSAGE' : 'UNSUPPORTED');
      } else requireThat(c.history && c.resume, 'NOT_FOUND');
      return { cwd: c.cwd || c.history?.cwd, folderId: c.folderId, provider: message.provider || 'claude', history: c.history };
    },
    async ({ captured: c, payload, message, context: trusted }) => {
      const stale = preflight(() => {
        grant(trusted, message);
        requireThat(type === 'instance:new' ? c.create === (message.provider === 'codex' ? server.codex : server.createInstance) : c.resume === server.resumeInstance, 'STALE_RESOURCE');
        requireThat(!payload.folderId || domain(authority.snapshot()).folders.folders.some((f) => f.id === payload.folderId), 'STALE_RESOURCE');
      }); if (stale) return stale;
      const made = type === 'instance:resume' ? await c.resume(payload.history) : payload.provider === 'codex'
        ? await c.create.create({ cwd: payload.cwd }) : await c.create({ cwd: payload.cwd, folderId: payload.folderId });
      requireThat(str(made?.id), 'OUTCOME_UNKNOWN');
      await currentState.flush();
      requireThat(domain(authority.snapshot()).instances.some((s) => s.id === made.id), 'OUTCOME_UNKNOWN');
      if (payload.folderId) await authority.commit((state) => {
        const data = domain(state), instance = data.instances.find((s) => s.id === made.id);
        requireThat(instance && data.folders.folders.some((f) => f.id === payload.folderId), 'STALE_RESOURCE');
        data.folders.assign[made.id] = payload.folderId;
        if (instance.claudeSessionId) data.folders.byConversation[instance.claudeSessionId] = payload.folderId;
      });
      return applied({ instance: made.id }, [{ type: 'instance:created', id: message.id ?? null, instance: made.id }]);
    }, (m) => requireThat(type === 'instance:new' ? str(m.cwd, 4096) && (m.provider === undefined || ['claude', 'codex'].includes(m.provider)) : str(m.sessionId)));
  handlers['instance:resume'].beforeApply = async ({ message, captured: c, context: trusted }) => {
    grant(trusted, message); requireThat(typeof server?.history === 'function' && c.resume, 'UNSUPPORTED');
    const entries = await server.history({ limit: 200 });
    grant(trusted, message);
    const found = entries?.find((e) => e.sessionId === message.sessionId); requireThat(found, 'NOT_FOUND');
    c.history = immutable(found);
  };
  handlers.forget = { roles: ['fleet'], businessErrors: BUSINESS,
    validate: (m) => requireThat(str(m.id)),
    capture: ({ message }) => ({ device: server?.devices?.get(message.id), enrollment: enrollment(server?.devices?.get(message.id)) }),
    apply({ state, message, context: trusted, captured: c }) {
      grant(trusted, message); requireThat(c.device, 'NOT_FOUND');
      requireThat(enrollment(server.devices.get(message.id)) === c.enrollment, 'STALE_RESOURCE');
      const saved = state.values[REVOCATIONS] || (state.values[REVOCATIONS] = []);
      if (!saved.some((r) => r.device === message.id && r.enrollment === c.enrollment)) saved.push({ device: message.id, enrollment: c.enrollment });
      return typed({ device: message.id });
    } };
  for (const type of ['@apple', '@listen']) handlers[type] = external(['fleet', 'conversation'], null,
    () => ({ device: device(), enrollment: enrollment(device()) }),
    ({ message, captured: c }) => {
      requireThat(server?.devices && c.device, 'FORBIDDEN');
      requireThat(enrollment(device()) === c.enrollment, 'STALE_RESOURCE');
      return type === '@apple' ? { device: c.device.id, token: message.token } : { device: c.device.id };
    },
    ({ message, payload, captured: c }) => {
      const stale = preflight(() => requireThat(enrollment(device()) === c.enrollment, 'STALE_RESOURCE')); if (stale) return stale;
      const paired = { ...c.device, kind: 'device' };
      if (type === '@apple') return server.rememberApple(paired, payload.token) ? applied({ registered: true }) : rejected('BAD_MESSAGE');
      let reply;
      const ok = server.issueListener({ device: paired, post: (m) => { reply = m; } });
      return ok && reply?.type === '@listener' && str(reply.secret) ? applied({}, [reply]) : unknown();
    }, (m) => {
      if (type === '@listen') return;
      requireThat(typeof m.token === 'string');
      const token = m.token.replace(/[^0-9a-f]/gi, '');
      requireThat(token.length >= 32 && token.length <= 200); // DeviceStore's existing token contract
    });

  for (const type of ['awake:set', 'lid:set']) handlers[type] = external(['fleet'], null,
    () => ({ power: server?.keepAwake }),
    ({ message, captured: c }) => {
      requireThat(c.power && typeof c.power[type === 'awake:set' ? 'set' : 'setLid'] === 'function', 'UNSUPPORTED');
      const on = message.type === 'setSetting' ? message.value : message.on, state = c.power.state?.() || {};
      requireThat(state.supported !== false && !(type === 'lid:set' && state.lid?.supported === false), 'UNSUPPORTED');
      requireThat(!(type === 'lid:set' && on && state.lid?.approved === false), 'LOCAL_REQUIRED');
      return { on };
    },
    async ({ payload, captured: c }) => {
      const stale = preflight(() => requireThat(server.keepAwake === c.power, 'STALE_RESOURCE')); if (stale) return stale;
      try { await c.power[type === 'awake:set' ? 'set' : 'setLid'](payload.on); }
      catch (error) {
        if (error.code === 'NEEDS_APPROVAL') return rejected('LOCAL_REQUIRED');
        if (error.code === 'NOT_LOADED') return rejected('UNSUPPORTED');
        throw error;
      }
      await authority.commit((state) => { domain(state).settings.user[type === 'awake:set' ? 'keepAwake' : 'lidClosed'] = payload.on; });
      return applied({ id: type === 'awake:set' ? 'awake' : 'lid', value: payload.on });
    }, (m) => requireThat(typeof m.on === 'boolean'));

  function captureTerminal(message) {
    const terminals = server?.terminals, terminal = terminals?.get(message.id);
    const s = message.session ? getSession(message.session) : null;
    return { terminals, terminal, running: terminal?.running || null, cwd: terminal?.cwd || s?.cwd || terminals?.home,
      session: s, name: s ? s.customTitle || s.label : 'Home' };
  }
  function validTerminal(c, message) {
    requireThat(c.terminals && server.terminals === c.terminals, 'UNSUPPORTED');
    if (message.type === 'term:open') {
      requireThat(!message.session || c.session && !c.session.disposed && getSession(message.session) === c.session && c.session.cwd === c.cwd, 'STALE_RESOURCE');
    } else {
      requireThat(c.terminal && c.terminals.get(message.id) === c.terminal, 'NOT_FOUND');
      requireThat(c.terminal.cwd === c.cwd && c.terminal.running === c.running, 'STALE_RESOURCE');
      if (['term:stop', 'term:close'].includes(message.type)) requireThat(message.terminalRun === (c.running?.id || null), 'STALE_RESOURCE');
      if (message.type === 'term:run') requireThat(!c.running, 'STALE_RESOURCE');
    }
  }
  for (const type of ['term:open', 'term:run', 'term:stop', 'term:close']) handlers[type] = external(['fleet'], 'terminal-v1',
    ({ message }) => captureTerminal(message),
    ({ state, message, captured: c }) => {
      validTerminal(c, message);
      return { terminal: type === 'term:open' ? allocate(state, 'terminal') : message.id,
        terminalRun: type === 'term:run' ? allocate(state, 'terminal-run') : c.running?.id || null, cwd: c.cwd, name: c.name };
    },
    ({ payload, captured: c, message }) => {
      const stale = preflight(() => validTerminal(c, message)); if (stale) return stale;
      if (type === 'term:open') {
        const terminal = { ...c.terminals.open({ id: payload.terminal, cwd: payload.cwd, name: payload.name }), activeRun: null };
        return applied({ terminal }, [{ type: 'term:opened', terminal }]);
      }
      if (type === 'term:run') {
        (client.terminals || (client.terminals = new Set())).add(payload.terminal);
        const response = c.terminals.run(payload.terminal, message.command, { runId: payload.terminalRun, authoritative: true });
        if (!response?.ok) return response?.delivery === 'unknown' ? unknown() : rejected('PROVIDER_REJECTED');
        requireThat(response.run?.id === payload.terminalRun, 'OUTCOME_UNKNOWN');
      } else {
        const response = type === 'term:stop' ? c.terminals.stop(payload.terminal, { authoritative: true })
          : c.terminals.close(payload.terminal, { authoritative: true });
        if (response?.delivery !== 'submitted') return response?.delivery === 'unknown' ? unknown() : rejected('PROVIDER_REJECTED');
      }
      return applied({ terminal: payload.terminal, terminalRun: payload.terminalRun }, type === 'term:close' ? [{ type: 'term:closed', id: payload.terminal }] : []);
    }, (m) => {
      if (type !== 'term:open') requireThat(str(m.id));
      if (type === 'term:run') requireThat(str(m.command, 8000) && m.command.trim());
      if (type === 'term:stop') requireThat(str(m.terminalRun));
      if (type === 'term:close') requireThat(m.terminalRun === null || str(m.terminalRun));
    });

  function captureSlack() { const r = room(); return { room: r, service: r?.deps.service() }; }
  function validSlack(c, needsService = true) {
    requireThat(c.room && c.room === room(), 'UNSUPPORTED');
    requireThat(c.service === c.room.deps.service(), 'STALE_RESOURCE');
    if (needsService) requireThat(c.service, 'UNSUPPORTED');
  }
  handlers['slack:open'] = { roles: ['fleet'], cap: 'slack-v1', businessErrors: BUSINESS, capture: captureSlack,
    validate: (m) => requireThat(str(m.conversation, 40) && (m.thread === undefined || m.thread === null || str(m.thread, 40))),
    apply({ state, message, context: trusted, captured: c, entry: receipt }) {
      grant(trusted, message); if (c?.error) throw c.error; validSlack(c);
      const seen = state.values[SEEN] || (state.values[SEEN] = {});
      const service = c.service, conv = service.conversations?.get(message.conversation);
      const ts = service.escalator?.pending().filter((p) => p.item.conversationId === message.conversation)
        .reduce((top, p) => Number(p.item.ts) > Number(top) ? p.item.ts : top, conv?.last?.ts || '0') || conv?.last?.ts;
      const watermark = ts && Number(ts) > 0 ? ts : String(receipt.at / 1000);
      requireThat(typeof watermark === 'string' && /^\d+(?:\.\d+)?$/.test(watermark), 'PROVIDER_REJECTED');
      seen[message.conversation] = { ts: watermark, at: receipt.at };
      return typed({ conversation: message.conversation, thread: message.thread || null });
    } };
  handlers['slack:reply'] = external(['fleet'], 'slack-v1', captureSlack,
    ({ message, captured: c }) => { validSlack(c); return { conversation: message.conversation, thread: message.thread || null, text: message.text }; },
    async ({ payload, captured: c, message }) => {
      const stale = preflight(() => validSlack(c)); if (stale) return stale;
      const response = await c.service.reply(payload.conversation, payload.text, payload.thread || undefined);
      if (!str(response?.ts, 100)) return unknown();
      return applied({ conversation: payload.conversation, thread: payload.thread, ts: response.ts },
        [{ type: 'slack:sent', id: message.id ?? null, ok: true, ts: response.ts }]);
    }, (m) => requireThat(str(m.conversation, 40) && str(m.text, 12000) && m.text.trim() &&
      (m.thread === undefined || m.thread === null || str(m.thread, 40))));
  for (const type of ['slack:mute', 'slack:vips', 'slack:enable']) handlers[type] = {
    roles: ['fleet'], cap: 'slack-v1', businessErrors: BUSINESS, capture: captureSlack,
    apply({ state, message, context: trusted, captured: c }) {
      grant(trusted, message); if (c?.error) throw c.error; validSlack(c, false);
      const values = domain(state).settings.user;
      if (type === 'slack:mute') {
        requireThat(str(message.conversation, 40) && typeof message.muted === 'boolean');
        requireThat(message.muted || !c.service?.isSlackMuted?.(message.conversation), 'PROVIDER_REJECTED');
        const list = values['slack.muted'] || [];
        values['slack.muted'] = message.muted ? [...new Set([...list, message.conversation])] : list.filter((id) => id !== message.conversation);
        return typed({ conversation: message.conversation, value: message.muted });
      }
      if (type === 'slack:enable') { values['slack.enabled'] = true; return typed({ conversation: null, value: true }); }
      requireThat(Array.isArray(message.vips) && message.vips.every((s) => typeof s === 'string'));
      const clean = [];
      for (const raw of message.vips) { const s = raw.trim(); if (str(s, 100) && !clean.some((v) => v.toLowerCase() === s.toLowerCase()) && clean.length < 50) clean.push(s); }
      values['slack.vips'] = clean; return typed({ conversation: null, value: clean });
    }
  };
  for (const type of ['slack:connect', 'slack:disconnect', 'slack:signIn']) handlers[type] = external(['fleet'], 'slack-v1', captureSlack,
    ({ captured: c }) => {
      validSlack(c, false);
      requireThat(typeof c.room.deps[type === 'slack:connect' ? 'connect' : type === 'slack:disconnect' ? 'disconnect' : 'connectWith'] === 'function', 'UI_UNAVAILABLE');
      // Credential-bearing envelopes are hashed but NEVER retained as payload.
      return { action: type };
    },
    async ({ captured: c, message, context: trusted }) => {
      const stale = preflight(() => { validSlack(c, false); grant(trusted, message); }); if (stale) return stale;
      const act = c.room.deps[type === 'slack:connect' ? 'connect' : type === 'slack:disconnect' ? 'disconnect' : 'connectWith'];
      const response = type === 'slack:signIn' ? await act({ token: message.token, cookie: message.cookie }) : await act(requester(trusted));
      if (!object(response) || typeof response.ok !== 'boolean') return unknown();
      if (!response.ok) return rejected(response.cancelled ? 'CANCELLED' : 'PROVIDER_REJECTED');
      const who = response.who ? Object.fromEntries(['user_id', 'team_id', 'user', 'team', 'url'].filter((k) => typeof response.who[k] === 'string').map((k) => [k, response.who[k]])) : null;
      return applied({ connected: type !== 'slack:disconnect', who });
    }, (m) => requireThat(type !== 'slack:signIn' || str(m.token, 4096) && str(m.cookie, 16384)));

  // OS/editor actions resolve a provider once, before any receipt or UI wait.
  const uiTypes = ['openFile', 'runInTerminal', 'switch', 'allSettings', 'slack', 'openPr', 'pr:open',
    'slack:settings', 'slack:setup', 'slack:link', 'slack:openTicket'];
  for (const type of uiTypes) handlers[type] = external(type.startsWith('slack:') ? ['fleet'] : ['conversation'],
    type.startsWith('slack:') ? 'slack-v1' : type.startsWith('pr:') || type === 'openPr' ? 'pr-v1' : null,
    ({ message, context: trusted }) => {
      const c = hub ? captureSession() : captureSlack();
      const method = type === 'openFile' ? 'openFile' : type === 'runInTerminal' ? 'runInTerminal' : type === 'switch' ? 'switchTo'
        : type === 'allSettings' ? 'openAllSettings' : type === 'slack' ? 'openSlack' : type === 'slack:settings' ? 'openSlackSettings'
        : type === 'slack:openTicket' ? 'openTicket' : 'openUrl';
      const destination = type === 'openPr' ? c.prUrl : type === 'slack:setup' ? SETUP_URL : type === 'openFile'
        ? path.resolve(c.cwd, String(message.path || '')) : type === 'switch' ? message.id : message.url || null;
      c.destination = destination; c.method = method; c.request = type === 'openFile' ? { path: destination, line: message.line ?? null, cwd: c.cwd }
        : type === 'runInTerminal' ? { command: message.command, cwd: c.cwd, label: session.label }
        : type === 'switch' ? { id: message.id, cwd: c.cwd, from: { id: session.id, cwd: c.cwd } } : { url: destination };
      if (type === 'switch') c.target = getSession(message.id);
      if (!(type === 'switch' && !trusted.seat.editor)) c.route = host.prepareEditor?.(method, c.request, requester(trusted));
      return c;
    },
    ({ message, context: trusted, captured: c }) => {
      if (hub) validSession(c, { pr: type === 'openPr' }); else validSlack(c, type === 'slack:link');
      if (type === 'openFile') requireThat(str(message.path, 4096));
      if (type === 'runInTerminal') requireThat(str(message.command, 8000));
      if (type === 'switch') requireThat(c.target, 'NOT_FOUND');
      if (type === 'pr:open') requireThat(/^https:\/\/github\.com\//.test(c.destination), 'BAD_MESSAGE');
      if (type === 'openPr') requireThat(str(c.prUrl), 'NOT_FOUND');
      if (type === 'slack:openTicket') requireThat(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/\d+(?:[/?#].*)?$/.test(c.destination), 'BAD_MESSAGE');
      if (type === 'slack:link') requireThat(str(message.conversation, 40) &&
        (message.ts === undefined || message.ts === null || str(message.ts, 40)));
      if (!(type === 'switch' && !trusted.seat.editor)) requireThat(c.route && c.route.available !== false, 'EDITOR_UNAVAILABLE');
      return { destination: c.destination, provider: c.route?.provider || null, request: c.request };
    },
    async ({ captured: c, context: trusted, message }) => {
      const guard = () => { grant(trusted, message); if (hub) validSession(c, { pr: type === 'openPr' }); else validSlack(c, type === 'slack:link');
        if (type === 'switch') requireThat(getSession(message.id) === c.target && !c.target.disposed, 'STALE_RESOURCE'); };
      const stale = preflight(guard); if (stale) return stale;
      if (type === 'switch' && !trusted.seat.editor) return applied({ provider: null, destination: message.id }, [{ type: '@navigate', session: message.id }]);
      const route = c.route, destination = c.destination;
      if (!route) return rejected('EDITOR_UNAVAILABLE');
      let response;
      try { response = await route.execute(guard); }
      catch (error) { return error.delivery === 'not_written' ? rejected(error.code) : unknown(); }
      if (response?.outcome === 'unknown') return unknown();
      if (response?.status === 'unavailable') return rejected(response.code === 'UI_UNAVAILABLE' ? 'UI_UNAVAILABLE' : 'EDITOR_UNAVAILABLE');
      if (!(response === true || response?.status === 'dispatched' || response?.ok === true)) return unknown();
      return applied({ provider: route.provider, destination }, type === 'slack:openTicket'
        ? [{ type: 'slack:openTicket', url: destination, ok: true }] : []);
    });
  // The editor was selected at ingress. Discovery binds its URL without
  // selecting again; historical receipts bypass the read entirely.
  handlers['slack:link'].beforeApply = async ({ message, context: trusted, captured: c }) => {
    grant(trusted, message); validSlack(c);
    requireThat(str(message.conversation, 40) && (message.ts === undefined || message.ts === null || str(message.ts, 40)));
    const destination = await c.service.permalink(message.conversation, message.ts || undefined);
    grant(trusted, message); validSlack(c); requireThat(str(destination, 4096), 'PROVIDER_REJECTED');
    c.destination = destination;
    c.request.url = destination;
  };
  for (const handler of Object.values(handlers)) if (handler.apply) {
    const apply = handler.apply;
    handler.apply = (args) => { const answer = apply(args); validateMutationState(args.state); return answer; };
  }
  async function snapshots(message, answer) {
    if (hub && message.type === 'ready' && answer?.admitted) {
      const e = entry();
      if (e && hub.session === session && getSession(session.id) === session) {
        if (typeof message.hidden === 'boolean') e.hidden = message.hidden;
        await hub.hello(e, { snapshotOnly: true }); hub.emitHost('chrome');
      }
    }
    if (answer?.outcome !== 'applied') return;
    if (answer.status !== 'duplicate') {
      if (hub && message.type === 'send') {
        hub.lastSender = client.id;
        const d = device();
        if (d) (host.audience || server?.audience)?.steered(session.id, d.id);
      }
      if (hub && message.type === 'permission') {
        const data = answer.result.data;
        const item = session.items.filter((i) => i.kind === 'permission' && i.requestId === data.requestId &&
          i.run?.id === data.run.id && i.run?.turn === data.run.turn).at(-1);
        if (item) { item.resolved = data.allow ? 'allow' : 'deny'; hub.broadcast({ type: 'items', items: [item] }); }
      }
      if (hub && message.type === 'setSetting') hub.broadcastSettings();
      if (hub && ['saveCommand', 'removeCommand', 'restoreCommand'].includes(message.type)) hub.broadcastCommands();
      if (hub && ['setSetting', 'saveCommand', 'removeCommand', 'restoreCommand', 'pr:pane', 'pr:link', 'pr:unlink'].includes(message.type)) {
        hub.broadcast(hub.metaMessage()); hub.syncPr();
      }
      if (hub && ['pr:pane', 'pr:link', 'pr:unlink'].includes(message.type)) session.emit('meta');
      if (server && ['instance:new', 'instance:resume', 'instance:place'].includes(message.type)) {
        server.refreshTree?.(); server.broadcastFleet();
      }
    }
    if (hub && message.type === 'visible') {
      const e = entry(); if (!e || hub.session !== session || getSession(session.id) !== session) return;
      e.hidden = !message.on; hub.syncPr();
      hub.emitHost('chrome');
    }
    if (message.type === 'slack:open') {
      const r = room(); if (!r) return;
      const saved = authority.snapshot().values[SEEN]?.[message.conversation], service = r.deps.service();
      // Restore the original observed watermark; a duplicate never marks a
      // newer arriving Slack message seen.
      if (saved && service?._nikuiSeen) service._nikuiSeen.set(message.conversation, saved.ts);
      if (answer.status !== 'duplicate') { service?.escalator?.resolve(message.conversation); service?._markResolved?.(message.conversation); }
      const d = device();
      r.join(client.id, { local: context.seat.local, control: d ? d.control === true : context.seat.control,
        device: d, looking: () => true }, post);
      const e = r.clients.get(client.id); e.open = message.conversation; e.thread = message.thread || null;
      await r.sendThread(e);
    }
    if (message.type === 'term:open' || message.type === 'term:run')
      (client.terminals || (client.terminals = new Set())).add(message.type === 'term:open' ? answer.result.data.terminal.id : message.id);
    if (message.type === 'term:close') client.terminals?.delete(message.id);
    if (message.type === 'forget') {
      // The authority and ack are already committed/enqueued. Reconciliation
      // may synchronously close this socket from Devices.changed().
      currentState.activateDeviceRevocation(message.id);
      reconcileDeviceRevocations(authority, server.devices, server.audience, message.id);
    }
  }
  async function query(message, trusted) {
    checkLive(trusted);
    if (message.type === 'app:update') return post(server?.appUpdateFor(client, message));
    if (hub) {
      if (message.type.startsWith('voice')) return server?.voiceMessage(client, message);
      return hub.receive(client.id, message);
    }
    if (message.type === 'ready') return post(server.fleetMessage());
    if (message.type === 'history') return post(await server.historyMessage(message));
    if (message.type === 'status') return post(server.statusMessage());
    if (message.type === 'devices') return post(server.devicesMessage(client));
    if (message.type === 'awake') return server.tellAwake(client);
    if (message.type.startsWith('term:')) {
      grant(trusted, message);
      if (message.type === 'term:list') return post({ type: 'term:list', terminals: server.terminals?.list().map((d) => ({ ...d, activeRun: server.terminals.get(d.id).running?.id || null })) || [] });
      return server.terminalFor(client, message);
    }
    if (message.type.startsWith('slack:')) return server.slackFor(client, message);
    if (message.type.startsWith('voice')) return server.voiceMessage(client, message);
    if (message.type === 'codex:watch' && server.codex) { server.codex.watch(); await server.codex.refresh(); server.broadcastFleet(); }
  }
  protocol = createNegotiation({ ...options, authenticated: context.authenticated, context, post, close,
    now: () => Math.max((options.now || Date.now)(), authority.receiptInfo().clockHighWater),
    receipts: () => currentState.dispatcher.receiptInfo(),
    legacy: legacy || ((message) => hub ? hub.receive(client.id, message) : client.binding?.receive(message)),
    receive: async (input, trusted, caps) => {
      let message;
      try {
        message = immutable(input); requireThat(object(message) && typeof message.type === 'string' && message.type.length > 0);
        checkLive(trusted); requireThat(!revoked(), 'FORBIDDEN');
      }
      catch (error) { return post(currentState.dispatcher.refuse(trusted, input, error.code || 'BAD_MESSAGE')); }
      if (message.type === 'receipt:get') return post(await currentState.dispatcher.lookup(trusted, message));
      if (message.type === 'operation:get') return post(await currentState.operation(trusted, message));
      const pairedQuery = !trusted.seat.local && ['slack:link', 'slack:setup'].includes(message.type);
      if (pairedQuery || (trusted.role === 'fleet' ? FLEET_QUERIES : HUB_QUERIES).has(message.type) || message.type === 'app:update') {
        try { return await query(message, trusted); } catch (error) { return post({ type: 'protocol:error', code: error.code || 'BAD_MESSAGE', message: 'Query unavailable' }); }
      }
      const enabled = ['@apple', '@listen'].includes(message.type) || (trusted.role === 'fleet' ? FLEET : CONVERSATION).has(message.type);
      let implementation = enabled && handlers[message.type];
      if (hub && message.type === 'setSetting' && ['awake', 'lid'].includes(message.id) && server?.keepAwake) {
        implementation = { ...handlers[message.id + ':set'], roles: ['conversation'], validate: (m) => requireThat(typeof m.value === 'boolean') };
      }
      const denied = !enabled ? 'UNSUPPORTED' : LOCAL.has(message.type) && !trusted.seat.local ? 'LOCAL_REQUIRED' : null;
      if (denied) {
        try { validateEnvelope(message); }
        catch (error) { return post(currentState.dispatcher.refuse(trusted, message, error.code)); }
      }
      const answer = denied ? currentState.dispatcher.refuse(trusted, message, denied)
        : await currentState.dispatch({ ...trusted, caps, origin: requester(trusted) }, message, implementation || null);
      post(answer);
      await snapshots(message, answer);
    } });
  const receive = protocol.receive, dispose = protocol.dispose;
  protocol.receive = async (message) => {
    await receive(message);
    if (protocol.proto === 2) { client.post = post; const e = entry(); if (e) e.client.post = post; }
  };
  protocol.dispose = () => {
    if (client.post === post) client.post = originalPost;
    const e = entry(); if (e?.client.post === post) e.client.post = originalHubPost;
    dispose();
  };
  return protocol;
}

module.exports = { createMutationSocket, reconcileDeviceRevocations, validateMutationState, REVOCATIONS, SEEN };
