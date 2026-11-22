'use strict';

const path = require('path');
const { readConfig } = require('./config');
const { validateRequest, result, matches, resultSchema } = require('./localManagementProtocol');
const { inside, noSymlinks, fail } = require('./daemonPaths');
const { hash } = require('./engineOwner');
const RECEIPTS = 'engine.localManagement.v1';
const PROJECTS = 'engine.savedProjects.v1';
const QUERIES = new Set(['selection.cycle', 'history.list', 'device.list', 'pairing.status', 'localClient.list',
  'network.status', 'settings.get', 'project.list', 'client.state.get', 'menu.snapshot', 'tools.refresh', 'engine.settings.get']);
const insist = (v, code) => { if (!v) throw fail(code, code); };
const unavailable = (code) => { throw fail(code, code); };

/** Only the private enrolled-client bridge calls this dispatcher. The caller
 * supplies trusted authorization, generation/admission and persistence APIs.
 * Nothing registers these operations with RemoteServer or the phone catalog.
 */
function createLocalManagement({ engine, generation, admitting, authorize, store, currentState, history, settings,
  root, provenance, announcedProjects = () => [], adapters = {} }) {
  let lane = Promise.resolve();
  const observed = () => typeof generation === 'function' ? generation() : generation;
  function savedProjects() {
    const saved = store.get(PROJECTS, []);
    insist(Array.isArray(saved) && saved.every((p) => p?.approved === true && typeof p.root === 'string' && path.isAbsolute(p.root) &&
      inside(root, p.root) && p.provenance?.profile === provenance.profile), 'LOCAL_STORAGE_UNAVAILABLE');
    return saved;
  }
  const known = (cwd) => typeof cwd === 'string' && [...announcedProjects(), ...savedProjects().map((p) => p.root)].includes(cwd);
  const sessionFor = (id) => engine.manager.get(id) || engine.codex.get(id);
  const flush = async () => { engine.flush(); await currentState?.flush(); };
  function check(context, request) {
    insist(context?.authenticated === true && typeof context.principal === 'string' && context?.seat?.local === true &&
      context.seat.control === true && authorize(context) === true, 'LOCAL_AUTHORITY_REQUIRED');
    insist(request.generation === observed(), 'STALE_GENERATION');
    insist(admitting(), 'DRAINING');
  }
  function session(id) { const s = sessionFor(id); insist(s && !s.disposed, 'NOT_FOUND'); return s; }
  function claude(id) { const s = session(id); insist(s.provider !== 'codex', 'CLAUDE_PROCESS_REQUIRED'); return s; }
  function configure(s) {
    const cfg = readConfig(engine.manager.settingsSource(s.cwd));
    for (const key of ['claudePath', 'model', 'permissionMode', 'effort', 'outputStyle', 'extraArgs']) s[key] = cfg[key];
  }
  function safeResource(s) {
    insist(!currentState?.snapshot().outbox.some((q) => q.target === 'session:' + s.id && ['dispatching', 'unknown'].includes(q.state)), 'UNSAFE_OPERATION_PENDING');
  }
  async function invoke(context, request, revalidate) {
    const a = request.args, manager = engine.manager, folders = engine.folders;
    switch (request.op) {
      case 'menu.snapshot': case 'tools.refresh': case 'engine.settings.get': case 'engine.settings.update':
        insist(adapters.menu, 'MENU_UNAVAILABLE'); return adapters.menu(request.op, a, revalidate);
      case 'session.rename': {
        const s = session(a.id);
        if (s.provider === 'codex' && a.name.trim()) {
          try {
            await s.workspace.client.start(); revalidate(); insist(sessionFor(s.id) === s, 'STALE_RESOURCE');
            await s.workspace.client.request('thread/name/set', { threadId: s.threadId, name: a.name });
          } catch (e) { if (e.code) throw e; throw fail('LOCAL_OUTCOME_UNKNOWN', 'Provider rename was not confirmed'); }
          revalidate(); insist(sessionFor(s.id) === s, 'STALE_RESOURCE');
          s.customTitle = a.name.trim(); s.emit('meta'); s.workspace._changed();
        } else if (s.provider === 'codex') { s.customTitle = null; s.emit('meta'); s.workspace._changed(); }
        else await s.rename(a.name);
        return { id: s.id, name: s.customTitle || s.label };
      }
      case 'session.stop': { const s = claude(a.id); safeResource(s); s.stop(); return { id: s.id, retained: true }; }
      case 'session.restart': {
        const s = claude(a.id); safeResource(s); configure(s); s.restart({ keepContext: a.mode === 'context' });
        return { id: s.id, mode: a.mode };
      }
      case 'session.restartAll': {
        const targets = manager.list.filter((s) => s.everStarted); targets.forEach(safeResource);
        for (const s of targets) { configure(s); s.restart({ keepContext: true }); }
        return { ids: targets.map((s) => s.id) };
      }
      case 'quota.resume': return { resumed: manager.resumeFromLimit({ manual: true }) || 0 };
      case 'session.remove': {
        const s = claude(a.id); safeResource(s); manager.remove(s.id); return { id: s.id, transcriptRetained: true };
      }
      case 'session.clearStopped': {
        const stopped = manager.stopped(); stopped.forEach(safeResource); return { removed: manager.removeStopped(), transcriptRetained: true };
      }
      case 'selection.cycle': {
        const current = a.currentId && sessionFor(a.currentId);
        const list = current?.provider === 'codex' ? engine.codex.list : manager.list, index = list.findIndex((s) => s.id === a.currentId);
        const next = list.length ? list[index < 0 ? 0 : (index + (a.direction === 'next' ? 1 : -1) + list.length) % list.length] : null;
        // Selection is returned only to this client; manager.activeId is not a
        // global navigation cursor for every enrolled client.
        return { selected: next?.id || null };
      }
      case 'folder.create': return { folder: folders.create(a.name) };
      case 'folder.rename': insist(folders.rename(a.id, a.name), 'NOT_FOUND'); return { id: a.id };
      case 'folder.delete': insist(folders.remove(a.id), 'NOT_FOUND'); return { id: a.id, instancesRetained: true };
      case 'folder.order': {
        const existing = folders.list();
        insist(existing.length === a.ids.length && a.ids.every((id) => folders.get(id)), 'FOLDER_ORDER_INVALID');
        folders.folders = a.ids.map((id) => folders.get(id)); await folders.save(); return { ids: a.ids };
      }
      case 'folder.place': {
        const s = session(a.id); insist(a.folder === null || folders.get(a.folder), 'NOT_FOUND');
        folders.place(s, a.folder); return { id: s.id, folder: a.folder };
      }
      case 'history.list': insist(history, 'HISTORY_UNAVAILABLE'); return history.list(a);
      case 'history.resume': insist(history, 'HISTORY_UNAVAILABLE'); return history.resume(a, revalidate);
      case 'history.delete': insist(history, 'HISTORY_UNAVAILABLE'); return history.delete(a, revalidate);
      case 'device.list': return { devices: engine.delivery.devices.list().map(({ id, name, control, pairedAt, lastSeenAt, fingerprint }) =>
        ({ id, name, control, pairedAt, lastSeenAt, fingerprint })) };
      case 'device.rename': { const renamed = engine.delivery.devices.rename(a.id, a.name); insist(renamed, 'NOT_FOUND'); return { id: a.id, name: renamed.name }; }
      case 'device.grant': insist(engine.delivery.devices.setControl(a.id, a.control), 'NOT_FOUND');
        engine.remote?.broadcastFleet(); return { id: a.id, control: a.control };
      case 'device.revoke':
      case 'device.forget': {
        insist(adapters.revokeDevice, 'DEVICE_ADMIN_UNAVAILABLE'); return adapters.revokeDevice(a.id, request.op === 'device.forget', revalidate);
      }
      case 'pairing.status': case 'pairing.open': case 'pairing.close':
        insist(adapters.pairing, 'PAIRING_UNAVAILABLE'); return adapters.pairing(request.op.split('.')[1], a, revalidate);
      case 'localClient.list': case 'localClient.revoke': case 'localClient.forget':
        insist(adapters.localClients, 'LOCAL_CLIENT_ADMIN_UNAVAILABLE'); return adapters.localClients(request.op.split('.')[1], a, context, revalidate);
      case 'network.status': case 'network.start': case 'network.stop': case 'network.open':
        insist(adapters.network, 'NETWORK_ADMIN_UNAVAILABLE'); return adapters.network(request.op.split('.')[1], a, revalidate);
      case 'settings.get': insist(settings, 'SETTINGS_UNAVAILABLE'); return settings(context).get(a.scope, a.root);
      case 'settings.update': insist(settings, 'SETTINGS_UNAVAILABLE'); return settings(context).update(a, revalidate);
      case 'project.list': return { saved: savedProjects(), announced: announcedProjects().slice(), provenance };
      case 'project.save': {
        insist(path.isAbsolute(a.root) && inside(root, path.resolve(a.root)) && path.resolve(a.root) === a.root, 'CWD_OUTSIDE_ROOT');
        noSymlinks(a.root); insist(a.provenance.profile === provenance.profile, 'CONFIG_PROVENANCE');
        const saved = savedProjects().filter((p) => p.root !== a.root);
        saved.push({ root: a.root, approved: true, provenance: a.provenance }); await store.update(PROJECTS, saved, revalidate);
        engine.remote?.broadcastFleet(); return { root: a.root, approved: true };
      }
      case 'project.remove': {
        await store.update(PROJECTS, savedProjects().filter((p) => p.root !== a.root), revalidate);
        engine.remote?.broadcastFleet(); return { root: a.root };
      }
      case 'client.state.get': return store.get('engine.clientState.' + context.principal, { selected: null, panels: [] });
      case 'client.state.save': {
        insist(a.panels.every((id) => sessionFor(id)) && (a.selected === null || sessionFor(a.selected)), 'NOT_FOUND');
        await store.update('engine.clientState.' + context.principal, a, revalidate); return a;
      }
      case 'editor.request': insist(adapters.editor, 'EDITOR_METHOD_UNAVAILABLE'); return adapters.editor(a, context, revalidate);
      default: return unavailable('LOCAL_COMMAND_UNSUPPORTED');
    }
  }
  async function execute(context, request) {
    const current = observed();
    const answer = (value) => result(request, observed(), value);
    if (!validateRequest(request)) return answer({ code: 'BAD_LOCAL_REQUEST' });
    try { check(context, request); } catch (e) { return answer({ code: e.code }); }
    if (QUERIES.has(request.op)) {
      try { return answer({ ok: true, outcome: 'applied', data: await invoke(context, request, () => check(context, request)) }); }
      catch (e) {
        // Keep the wire response bounded, but retain the original failure in
        // the owner-only engine stderr so packaged composition errors can be
        // diagnosed. Never log the request (which can contain private data).
        console.error('[local query ' + request.op + ']', e);
        return answer({ code: /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code || '') ? e.code : 'LOCAL_QUERY_UNAVAILABLE', outcome: 'unavailable' });
      }
    }
    // Reserve before effects. A crash or lost reply to a pending local action
    // returns unknown on retry, never a repeated restart/remove/pairing action.
    const key = JSON.stringify([context.principal, request.id]), digest = hash(request);
    let saved, receipt;
    try {
      saved = store.get(RECEIPTS, []);
      insist(Array.isArray(saved) && saved.length <= 512 && new Set(saved.map((r) => r?.key)).size === saved.length &&
        saved.every((r) => typeof r?.key === 'string' && /^[a-f0-9]{64}$/.test(r.hash) &&
          (r.result === null || matches(r.result, resultSchema))), 'LOCAL_STORAGE_UNAVAILABLE');
      receipt = saved.find((r) => r.key === key);
    } catch (_) { return answer({ code: 'LOCAL_STORAGE_UNAVAILABLE' }); }
    if (receipt) return receipt.hash !== digest ? answer({ code: 'LOCAL_ID_CONFLICT' }) : receipt.result || answer({ code: 'LOCAL_OUTCOME_UNKNOWN', outcome: 'unknown' });
    if (saved.length >= 512) return answer({ code: 'LOCAL_RECEIPTS_FULL' });
    saved.push({ key, hash: digest, generation: current, result: null });
    try { await store.update(RECEIPTS, saved); }
    catch (_) { return answer({ code: 'LOCAL_STORAGE_UNAVAILABLE' }); }
    let response, effectStarted = false;
    try {
      check(context, request); effectStarted = true;
      const data = await invoke(context, request, () => check(context, request));
      await flush(); response = answer({ ok: true, outcome: 'applied', data: data ?? {} });
    } catch (e) {
      const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code || '') ? e.code : 'LOCAL_OUTCOME_UNKNOWN';
      response = answer({ code, outcome: code.endsWith('_UNAVAILABLE') ? 'unavailable' : code === 'LOCAL_OUTCOME_UNKNOWN' && effectStarted ? 'unknown' : 'refused' });
    }
    try {
      saved = store.get(RECEIPTS, []); receipt = saved.find((r) => r.key === key);
      insist(receipt?.hash === digest, 'LOCAL_STORAGE_UNAVAILABLE'); receipt.result = response; await store.update(RECEIPTS, saved);
      return response;
    } catch (_) { return answer({ code: 'LOCAL_OUTCOME_UNKNOWN', outcome: 'unknown' }); }
  }
  return { get generation() { return observed(); }, knownProject: known, projects: () => [...new Set([...announcedProjects(), ...savedProjects().map((p) => p.root)])],
    dispatch(context, request) {
      // Freeze bytes and authority at ingress; queue wait never retargets.
      let captured, trusted;
      try { captured = structuredClone(request); trusted = structuredClone(context); }
      catch (_) { return Promise.resolve(result(null, observed(), { code: 'BAD_LOCAL_REQUEST' })); }
      const pending = lane.then(() => execute(trusted, captured)); lane = pending.catch(() => {}); return pending;
    }, flush: () => lane };
}

module.exports = { createLocalManagement, RECEIPTS, PROJECTS };
