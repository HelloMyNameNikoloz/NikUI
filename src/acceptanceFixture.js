'use strict';

// Sealed, opt-in rehearsal adapters. Providers in the engine are synthetic;
// no keeper/route/power/external daemon is reachable. A separate sealed flag
// permits the bounded sandboxed CLI probe, with no engine attach/resume path.
const fs = require('fs'), path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { privateRoot, privateDirectory, readPrivateJson, fail } = require('./daemonPaths');
const { atomicJson } = require('./engineOwner');
const { plannedTransitionReadiness } = require('./engineHandoff');

function createAcceptanceFixture({ root, testOnly = false, allowRealTools = false, secretAdapter } = {}) {
  if (testOnly !== true) throw fail('PRODUCTION_CUTOVER_DISABLED', 'Explicit test fixture required');
  const paths = privateRoot(root), file = path.join(paths.root, 'acceptance-effects.json');
  const effects = fs.existsSync(file) ? readPrivateJson(file) : { version: 1, claude: 0, codex: 0, approvals: 0 };
  if (effects.version !== 1 || !['claude', 'codex', 'approvals'].every((k) => Number.isSafeInteger(effects[k]) && effects[k] >= 0)) {
    throw fail('STORAGE_UNAVAILABLE', 'Acceptance trace corrupt');
  }
  let daemon, realTools, handoff, realToolsAbort, macCore = false;
  function count(key) { effects[key]++; atomicJson(file, effects); }
  function processFixture(kind) {
    const proc = new EventEmitter();
    Object.assign(proc, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
    const say = (m) => proc.stdout.write(JSON.stringify(m) + '\n');
    const exit = () => { if (proc.exitCode === null) { proc.exitCode = 0; proc.emit('exit', 0); } };
    proc.kill = () => { proc.killed = true; exit(); };
    proc.close = exit; proc.stdin.on('finish', exit);
    let buffer = '';
    proc.stdin.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        if (kind === 'claude') {
          if (m.type === 'user') count('claude');
          if (m.type === 'control_response') count('approvals');
          if (macCore && m.type === 'control_request' && m.request?.subtype === 'interrupt') {
            effects.interrupts = (effects.interrupts || 0) + 1; atomicJson(file, effects);
            session()._interrupted = true;
            queueMicrotask(() => say({ type: 'result', subtype: 'success', total_cost_usd: 0 }));
          }
          if (m.type === 'control_request') queueMicrotask(() => say({ type: 'control_response', response: {
            subtype: 'success', request_id: m.request_id, response: {} } }));
        } else if (m.method && m.id != null) {
          if (m.method === 'turn/start') count('codex');
          const result = m.method === 'thread/start' ? { thread: { id: 'p2-codex' } }
            : m.method === 'turn/start' ? { turn: { id: 'p2-codex-turn' } } : {};
          queueMicrotask(() => say({ jsonrpc: '2.0', id: m.id, result }));
        }
      }
    });
    return proc;
  }
  const session = () => daemon.engine.manager.get('p2-claude');
  async function control(request) {
    if (request.op !== 'acceptance-p2') return { ok: false, code: 'CONTROL_UNSUPPORTED' };
    if (!daemon || Object.keys(request).sort().join(',') !== 'action,op' || typeof request.action !== 'string') {
      return { ok: false, code: 'ACCEPTANCE_REQUEST_INVALID' };
    }
    const { engine, graph } = daemon;
    switch (request.action) {
      case 'mac-core-stream-start': {
        macCore = true;
        const s = session();
        if (!s?.inTurn) return { ok: false, code: 'MAC_CORE_TURN_REQUIRED' };
        s._handleStream({ event: { type: 'message_start', message: { id: 'p3-native-reply' } } });
        s._handleStream({ event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
        s._handleStream({ event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Streamed reply from the P3 fixture.' } } });
        await graph.currentState.flush(); return { ok: true };
      }
      case 'mac-core-stream-end': {
        if (!macCore) return { ok: false, code: 'MAC_CORE_TURN_REQUIRED' };
        session()._handleStream({ event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' Complete.' } } });
        session()._handleStream({ event: { type: 'content_block_stop', index: 0 } });
        await graph.currentState.flush(); return { ok: true };
      }
      case 'legacy-owner': {
        const { createSyntheticOwner } = require('./engineOwner');
        const legacy = createSyntheticOwner({ root: path.join(paths.home, 'p2-legacy'), profile: 'p2-legacy-test', install: 'p2-fixture', testOnly: true });
        await legacy.initialize();
        await legacy.admit({ id: 'p2-legacy-window', build: 'legacy-without-meta' });
        try {
          await legacy.begin({ generation: 0, to: 'service', target: 'refused-target',
            inventory: { complete: true, scope: legacy.scope, ids: ['p2-legacy-window'], otherScopes: [] } });
          return { ok: false, code: 'LEGACY_OWNER_UNEXPECTEDLY_ADMITTED' };
        } catch (e) {
          return { ok: true, code: e.code, blockers: e.blockers, owner: legacy.status(),
            fixture: 'connected synthetic legacy owner; no real keeper selected' };
        }
      }
      case 'handoff': {
        if (handoff) return { ok: false, code: 'HANDOFF_ALREADY_ATTEMPTED' };
        handoff = { state: 'running' };
        setImmediate(async () => {
          let sourceStore;
          try {
            sourceStore = secretAdapter ? require('./keychainStore').createKeychainStore({ adapter: secretAdapter })
              : require('./daemonStore').createTestStore(paths.secrets, { testOnly: true });
            const result = await require('./acceptanceTransfer').rehearseTransfer({ daemon, sourceStore, secretAdapter });
            handoff = { state: 'finished', result };
          } catch (e) { handoff = { state: 'finished', result: { status: 'failed', code: e.code || 'HANDOFF_FAILED' } }; }
          finally {
            sourceStore?.dispose();
            try { atomicJson(path.join(paths.root, 'acceptance-handoff.json'), handoff); }
            catch (_) { handoff = { state: 'finished', result: { status: 'failed', code: 'HANDOFF_EVIDENCE_UNAVAILABLE' } }; }
          }
        });
        return { ok: true, state: 'running' };
      }
      case 'handoff-status': return { ok: true, ...(handoff || { state: 'unrun' }) };
      case 'real-tools':
        if (!allowRealTools || process.platform !== 'darwin') return { ok: false, code: 'REAL_TOOL_OPT_IN_REQUIRED' };
        if (realTools) return { ok: false, code: 'REAL_TOOLS_ALREADY_ATTEMPTED' };
        realToolsAbort = new AbortController();
        realTools = { state: 'running' };
        void require('./acceptanceTools').runTools({ root: paths.root, tools: daemon.status().tools,
          liveHome: require('os').userInfo().homedir, signal: realToolsAbort.signal }).catch((e) => ({ version: 1, status: 'failed', code: e.code || 'REAL_TOOLS_FAILED' })).then((result) => {
          realTools = { state: 'finished', result };
          try { atomicJson(path.join(paths.home, 'p2-real-tools/result.json'), result); }
          catch (_) { realTools = { state: 'finished', result: { status: 'failed', code: 'TOOL_EVIDENCE_UNAVAILABLE' } }; }
        });
        return { ok: true, state: 'running' };
      case 'real-tools-cancel':
        realToolsAbort?.abort(); return { ok: true, state: realTools?.state || 'unrun' };
      case 'real-tools-status':
        return { ok: true, ...(realTools || { state: 'unrun' }) };
      case 'seed': {
        const cwd = path.join(paths.home, 'p2-project'); privateDirectory(cwd);
        let s = session();
        if (!s) s = engine.manager.create({ id: 'p2-claude', cwd, autoStart: false, title: 'P2 synthetic Claude', autoTitle: false });
        if (!s.proc) {
          s.start();
          s._handleSystem({ type: 'system', subtype: 'init', session_id: 'p2-synthetic-conversation' });
          s._handleResult({ type: 'result', subtype: 'success', total_cost_usd: 0 });
        }
        await graph.currentState.flush();
        return { ok: true, instance: s.id, cwd, generation: daemon.generation,
          fingerprint: engine.delivery.identity.fingerprint, applicationServerKey: engine.delivery.vapid.applicationServerKey };
      }
      case 'finish':
        session()._handleResult({ type: 'result', subtype: 'success', total_cost_usd: 0 });
        await graph.currentState.flush(); await graph.currentState.drain('session:p2-claude');
        return { ok: true };
      case 'pending': {
        session()._handleControlRequest({ type: 'control_request', request_id: 'p2-approval',
          request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'synthetic approval; never executed' } } });
        await graph.currentState.flush();
        return { ok: true, requestId: 'p2-approval', run: session().items.filter((i) => i.kind === 'permission').at(-1).run };
      }
      case 'codex-busy': {
        await engine.codex.client.start();
        let cx = engine.codex.list.find((s) => s.threadId === 'p2-codex');
        if (!cx) cx = engine.codex._adopt({ id: 'p2-codex', cwd: path.join(paths.home, 'p2-project'), model: 'fixture-model' });
        cx.loaded = true; cx.writerAuthority = 'engine'; cx.turnId = 'p2-synthetic-turn'; cx.status = 'working';
        await graph.currentState.flush();
        return { ok: true, instance: cx.id, ownership: engine.codex.client.ownership };
      }
      case 'codex-idle':
        for (const cx of engine.codex.list) { cx.turnId = null; cx.status = 'idle'; }
        await graph.currentState.flush(); return { ok: true };
      case 'readiness':
        return { ok: true, ...plannedTransitionReadiness({ currentState: graph.currentState, engine, resources: graph.resources }) };
      case 'notify':
        return { ok: true, delivered: engine.remote.notifyDevices({ kind: 'ci', title: 'P2 synthetic delivery', body: '', tag: 'p2-acceptance' }) };
      case 'state': {
        await graph.currentState.flush();
        const saved = graph.authority.snapshot();
        return { ok: true, effects: { ...effects }, engine: daemon.status().engine, generation: daemon.generation,
          receipts: saved.entries.map((e) => ({ mid: e.mid, what: e.what, outcome: e.outcome, code: e.error?.code })),
          outbox: saved.outbox.map((q) => ({ mid: q.mid, state: q.state, correlation: q.correlation, target: q.target, queueId: q.queueId })),
          fingerprint: engine.delivery.identity.fingerprint, applicationServerKey: engine.delivery.vapid.applicationServerKey };
      }
      default: return { ok: false, code: 'ACCEPTANCE_REQUEST_INVALID' };
    }
  }
  return { adapters: { claudeSpawn: () => processFixture('claude'), codexSpawn: () => processFixture('codex'), control },
    cancel() { realToolsAbort?.abort(); },
    attach(value) { if (value.paths.root !== paths.root || daemon) throw fail('ACCEPTANCE_ROOT_MISMATCH', 'Wrong test runtime'); daemon = value; } };
}
module.exports = { createAcceptanceFixture };
