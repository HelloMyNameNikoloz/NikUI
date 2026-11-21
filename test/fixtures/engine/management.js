'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { startDaemon } = require('../../../src/daemonRuntime');
const { openDevelopmentClient } = require('../../../src/developmentBridge');
const { requestSchema, resultSchema, commands, matches, validateRequest } = require('../../../src/localManagementProtocol');
const { DOMAIN } = require('../../../src/engineState');
const { PROJECTS } = require('../../../src/localManagement');
const { slugFor } = require('../../../src/history');
const { createLocalHistory } = require('../../../src/localHistory');
const { mayMutate } = require('../../../src/mutationGrants');
const { Secrets, provider, tick } = require('./fakes');
const { makeDevice } = require('../../helpers/device');
const { until } = require('../../helpers/browser-client');
const { errorCode } = require('../../helpers/engine-disk');
const mkdir = (p) => fs.mkdirSync(p, { recursive: true, mode: 0o700 });
const base = fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT);

module.exports = async () => {
  suite('P2 T55: versioned local schemas refuse remote seats and malformed input');
  checkEqual('request schema is versioned JSON Schema with every command variant', [requestSchema.$schema, requestSchema.oneOf.length], ['https://json-schema.org/draft/2020-12/schema', Object.keys(commands).length]);
  checkEqual('published request schema matches the runtime contract', require('../../../docs/engine/schemas/local-request-v1.json'), requestSchema);
  checkEqual('published result schema matches the runtime contract', require('../../../docs/engine/schemas/local-result-v1.json'), resultSchema);
  checkEqual('successful results require operation-specific data', matches({ type: 'local:result', version: 1, id: '1'.repeat(32),
    generation: 'test', op: 'session.stop', ok: true, outcome: 'applied', code: null, data: {} }, resultSchema), false);
  const claude = provider(), codex = provider({ 'thread/list': { data: [{ id: 'local', name: 'Local Codex', cwd: path.join(base, 'm', 'home') }] }, 'model/list': { data: [] } });
  const root = path.join(base, 'm'); mkdir(root);
  const networkCalls = [];
  const daemon = await startDaemon({ root, adapters: { claudeSpawn: claude.spawnFn, codexSpawn: codex.spawnFn,
    tools: { knownDirs: [], lookup: async () => ({ path: '/fixture', tools: {} }) },
    management: { network(action, args, revalidate) { revalidate(); networkCalls.push([action, args]); return { action, synthetic: true }; } } } });
  const connections = [], frames = [], held = []; let link;
  function receive(m) {
    frames.push(m); if (!link) { held.push(m); return; }
    if (m.type === '@welcome') link.send({ type: 'hello', proto: { min: 2, max: 2 }, caps: daemon.engine.remote.applicationProtocol.caps,
      client: { id: crypto.randomBytes(16).toString('hex'), kind: 'extension', version: 'p2-fixture' } });
    if (m.type === 'welcome') link.send({ type: 'editor:register', methods: ['openFile'], focused: true, workspaces: [pathToFileURL(daemon.paths.home).href] });
  }
  const request = (op, args = {}) => ({ type: 'local:request', version: 1, id: crypto.randomBytes(16).toString('hex'), generation: daemon.generation, op, args });
  async function send(op, args = {}, original) {
    const m = original || request(op, args), before = frames.length; link.send(m);
    await until(() => frames.slice(before).some((r) => r.type === 'local:result' && r.id === m.id), 'local management result ' + m.op);
    const response = frames.slice(before).find((r) => r.type === 'local:result' && r.id === m.id);
    check(m.op + ' has a typed local result', matches(response, resultSchema)); return response;
  }
  try {
    link = await openDevelopmentClient({ root, secrets: new Secrets(), provider: true, onMessage: receive }); connections.push(link);
    for (const m of held.splice(0)) receive(m);
    await until(() => frames.some((m) => m.type === 'editor:registered'), 'management editor registration');
    checkEqual('only private enrollment advertises local schema and generation', link.enrollment.localManagement, { version: 1, generation: daemon.generation });
    const engine = daemon.engine, management = daemon.graph.management;
    const trusted = { authenticated: true, principal: 'local-client:' + link.enrollment.id,
      seat: { local: true, control: true, editor: true } };
    for (const seat of [{ principal: 'device:watch', seat: { local: false, control: false } },
      { principal: 'device:control', seat: { local: false, control: true } },
      { principal: 'device:spoof', seat: { local: true, control: true } },
      { principal: 'local-client:missing', seat: { local: true, control: true } }]) {
      const answer = await management.dispatch({ authenticated: true, ...seat }, request('folder.create', { name: 'Unauthorized' }));
      checkEqual(seat.principal + ' cannot add local administration', answer.code, 'LOCAL_AUTHORITY_REQUIRED');
    }
    checkEqual('unauthorized local requests have no folder effect', engine.folders.list(), []);
    for (const alter of [(m) => { m.version = 2; }, (m) => { m.args.extra = true; }, (m) => { m.args.name = ''; },
      (m) => { m.seat = { local: true }; }, (m) => { m.id = 'wrong'; }]) {
      const m = request('folder.create', { name: 'valid' }); alter(m);
      checkEqual('malformed/unknown local schema refuses before effects', [validateRequest(m), (await management.dispatch(trusted, m)).code], [false, 'BAD_LOCAL_REQUEST']);
    }
    checkEqual('a stale generation refuses before effects', (await management.dispatch(trusted, { ...request('folder.create', { name: 'stale' }), generation: 'old' })).code, 'STALE_GENERATION');
    const first = engine.manager.create({ cwd: daemon.paths.home, resume: 'first', autoStart: false });
    const second = engine.manager.create({ cwd: daemon.paths.home, resume: 'second', autoStart: false });
    await daemon.graph.currentState.flush();
    checkEqual('Claude rename uses the actual instance and history name store', (await send('session.rename', { id: first.id, name: 'Renamed Claude' })).ok, true);
    checkEqual('Claude rename preserves the conversation identity', [first.customTitle, first.claudeSessionId], ['Renamed Claude', 'first']);
    await send('session.rename', { id: first.id, name: '' });
    checkEqual('clearing a hand-given title preserves automatic naming semantics', first.customTitle, null);
    const selected = await send('selection.cycle', { direction: 'next', currentId: first.id });
    checkEqual('next selection is returned to this client', selected.data.selected, second.id);
    checkEqual('previous selection uses this client cursor', (await send('selection.cycle', { direction: 'previous', currentId: second.id })).data.selected, first.id);
    checkEqual('cycling does not mutate the engine global active selection', engine.manager.activeId, null);
    await send('client.state.save', { selected: first.id, panels: [first.id, second.id] });
    checkEqual('service clients restore panels/selection without a second engine', (await send('client.state.get')).data, { selected: first.id, panels: [first.id, second.id] });
    const f1 = (await send('folder.create', { name: 'One' })).data.folder, f2 = (await send('folder.create', { name: 'Two' })).data.folder;
    await send('folder.rename', { id: f1.id, name: 'Renamed folder' }); await send('folder.place', { id: first.id, folder: f1.id });
    await send('folder.order', { ids: [f2.id, f1.id] });
    checkEqual('deliberate order is persisted in actual authority', daemon.graph.currentState.snapshot().values[DOMAIN].folders.folders.map((f) => f.id), [f2.id, f1.id]);
    checkEqual('folder order rejects omissions and duplicate IDs', [(await send('folder.order', { ids: [f1.id] })).code,
      (await send('folder.order', { ids: [f1.id, f1.id] })).code], ['FOLDER_ORDER_INVALID', 'BAD_LOCAL_REQUEST']);
    checkEqual('placement records conversation identity', engine.folders.byConversation.first, f1.id);
    await send('folder.delete', { id: f1.id });
    checkEqual('folder deletion moves contents out while retaining instances', [!!engine.manager.get(first.id), engine.folders.folderOf(first), engine.folders.byConversation.first], [true, null, undefined]);

    suite('P2 T46/T55: local saved-project approval and complete settings provenance');
    const project = path.join(daemon.paths.home, 'approved'); mkdir(project);
    const projects = (await send('project.list')).data, source = { ...projects.provenance, workspace: project, rawScope: 'workspaceFolder' };
    checkEqual('unknown projects are absent from the phone creation set', management.knownProject(project), false);
    await send('project.save', { root: project, provenance: source });
    check('a locally approved saved project joins connected announcements', management.projects().includes(project) && engine.remote.fleetMessage().projects.some((p) => p.path === project));
    checkEqual('new directories cannot escape the private selected scope', (await send('project.save', { root: path.dirname(root), provenance: source })).code, 'CWD_OUTSIDE_ROOT');
    checkEqual('another profile cannot enter project provenance', (await send('project.save', { root: project, provenance: { ...source, profile: 'other' } })).code, 'CONFIG_PROVENANCE');
    const user = (await send('settings.get', { scope: 'user', root: null })).data;
    check('full settings include manifest defaults, effective value and disposition', user.settings.some((s) => s.key === 'codexAccount' && s.disposition === 'machine-policy-local-only' && s.default !== undefined));
    await send('settings.update', { scope: 'user', root: null, key: 'model', value: 'user-model', provenance: source });
    await send('settings.update', { scope: 'project', root: project, key: 'model', value: 'project-model', provenance: source });
    const scoped = (await send('settings.get', { scope: 'project', root: project })).data.settings.find((s) => s.key === 'model');
    checkEqual('project settings retain explicit scope and imported provenance', [scoped.value, scoped.effective, scoped.provenance], ['project-model', 'project-model', source]);
    checkEqual('the effective settings source is explicit', scoped.effectiveSource, { scope: 'project', root: project, provenance: source });
    const restarted = engine.manager.create({ cwd: project, autoStart: false });
    const restart = request('session.restart', { id: restarted.id, mode: 'context' }); await send(null, null, restart);
    await new Promise((resolve) => setTimeout(resolve, 340));
    checkEqual('restart refreshes current project settings before provider launch', restarted.model, 'project-model');
    const spawnCount = claude.spawned.length; await send(null, null, restart); await new Promise((r) => setTimeout(r, 330));
    checkEqual('repeated local request returns its result without restarting twice', claude.spawned.length, spawnCount);
    checkEqual('same local ID with changed bytes refuses', (await send(null, null, { ...restart, args: { ...restart.args, mode: 'fresh' } })).code, 'LOCAL_ID_CONFLICT');
    checkEqual('machine settings cannot enter a project override', (await send('settings.update', { scope: 'project', root: project, key: 'codexAccount', value: 'personal', provenance: source })).code, 'CONFIG_SCOPE');
    checkEqual('lid setup needs an attended correlated confirmation', (await send('settings.update', { scope: 'user', root: null, key: 'lidClosed', value: true, provenance: source })).code, 'ATTENDED_CONFIRMATION_REQUIRED');
    await send('settings.update', { scope: 'editor', root: null, key: 'groupByProject', value: 'always', provenance: source });
    checkEqual('editor-only settings are held for this client', (await send('settings.get', { scope: 'editor', root: null })).data.settings.find((s) => s.key === 'groupByProject').value, 'always');
    checkEqual('editor-only values never enter engine user settings', daemon.graph.currentState.snapshot().values[DOMAIN].settings.user.groupByProject, undefined);

    suite('P2 T55: process control retains transcripts and stopped/asleep distinction');
    restarted.claudeSessionId = 'restarted-context'; await send('session.restart', { id: restarted.id, mode: 'fresh' }); await new Promise((r) => setTimeout(r, 340));
    checkEqual('fresh restart clears the continued conversation', restarted.claudeSessionId, null);
    await send('session.stop', { id: restarted.id });
    checkEqual('process stop retains its instance', [!!engine.manager.get(restarted.id), restarted.proc], [true, null]);
    const cleared = await send('session.clearStopped');
    checkEqual('clear stopped removes exited runs and retains asleep instances', [cleared.data.removed, !!engine.manager.get(first.id), !!engine.manager.get(second.id)], [1, true, true]);
    checkEqual('manual quota resume returns the actual awakened count', (await send('quota.resume')).data.resumed, 0);
    const transcriptDir = path.join(daemon.paths.home, '.claude', 'projects', slugFor(project)); mkdir(transcriptDir);
    const writeTranscript = (id, title) => {
      const file = path.join(transcriptDir, id + '.jsonl'); fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: project,
        message: { content: title + ' '.repeat(250) } }) + '\n', { mode: 0o600 }); return file;
    };
    const retained = writeTranscript('retained', 'retained transcript');
    const removable = engine.manager.create({ cwd: project, resume: 'retained', autoStart: false }); await daemon.graph.currentState.flush();
    await send('session.remove', { id: removable.id });
    checkEqual('remove retains the transcript on disk', [!!engine.manager.get(removable.id), fs.existsSync(retained)], [false, true]);
    writeTranscript('resume', 'resume selected history'); writeTranscript('delete', 'delete selected history');
    const page = await send('history.list', { cwd: project, filter: 'selected history', offset: 0, limit: 1 });
    checkEqual('history scope/filter/paging returns one matching page and more', [page.data.entries.length, page.data.hasMore], [1, true]);
    const resumed = await send('history.resume', { cwd: project, conversation: 'resume' });
    const resumedSession = engine.manager.get(resumed.data.id); resumedSession.claudeSessionId = 'resume';
    checkEqual('history resume launches only the selected conversation', [resumed.ok, resumedSession.claudeSessionId], [true, 'resume']);
    checkEqual('delete of an active transcript refuses', (await send('history.delete', { cwd: project, conversation: 'resume' })).code, 'HISTORY_ACTIVE');
    const deleted = await send('history.delete', { cwd: project, conversation: 'delete' });
    checkEqual('guarded inactive deletion removes only the selected transcript', [deleted.ok, fs.existsSync(path.join(transcriptDir, 'delete.jsonl')), fs.existsSync(retained)], [true, false, true]);
    checkEqual('out-of-root history identity refuses', (await send('history.delete', { cwd: project, conversation: '../../outside' })).code, 'HISTORY_OUTSIDE_ROOT');
    const outside = path.join(root, 'outside.jsonl'); fs.writeFileSync(outside, 'must remain', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(transcriptDir, 'linked.jsonl'));
    checkEqual('a transcript symlink cannot delete another file', [(await send('history.delete', { cwd: project, conversation: 'linked' })).code, fs.readFileSync(outside, 'utf8')], ['UNSAFE_PATH', 'must remain']);
    const guarded = createLocalHistory({ root: path.dirname(transcriptDir), history: engine.history, approvedProject: () => true,
      owners: async () => ({ complete: false, owners: [] }) });
    checkEqual('incomplete owner enumeration refuses deletion', await errorCode(() => guarded.delete({ cwd: project, conversation: 'retained' }, () => {})), 'HISTORY_OWNER_UNPROVEN');
    let released = 0;
    const changedOwner = createLocalHistory({ root: path.dirname(transcriptDir), history: engine.history, approvedProject: () => true,
      owners: async () => ({ complete: true, guarded: true, owners: [],
        revalidate: () => ({ complete: true, owners: [{ connected: true, metaVersion: 1, runs: [{ conversation: 'retained' }] }] }),
        release() { released++; } }) });
    checkEqual('a newly active owner at the deletion boundary preserves the transcript', [await errorCode(() => changedOwner.delete({ cwd: project, conversation: 'retained' }, () => {})), fs.existsSync(retained), released],
      ['HISTORY_ACTIVE', true, 1]);

    suite('P2 T55: device/pairing/network bridges keep pins and current phone grants');
    await engine.codex.refresh();
    const cx = engine.codex.list[0];
    check('the actual Codex workspace has its selected private thread', !!cx);
    checkEqual('Codex rename confirms the provider RPC', (await send('session.rename', { id: cx.id, name: 'Renamed Codex' })).ok, true);
    const pin = engine.delivery.identity.fingerprint, vapid = engine.delivery.vapid.applicationServerKey;
    const phone = await makeDevice('watch'); const d = engine.delivery.devices.add({ name: 'Watch phone', publicKey: phone.publicKey });
    await send('device.rename', { id: d.id, name: 'My phone' }); await send('device.grant', { id: d.id, control: true });
    checkEqual('local device grants affect only the selected phone', [engine.delivery.devices.get(d.id).name, engine.delivery.devices.get(d.id).control], ['My phone', true]);
    await send('device.revoke', { id: d.id });
    checkEqual('local revoke returns the phone to its existing watch grant', engine.delivery.devices.get(d.id).control, false);
    const pair = await send('pairing.open', { seconds: 60 });
    check('pairing supplies the current pin, one-time code and QR payload locally', pair.data.open && pair.data.fingerprint === pin && pair.data.qr.text.includes('#c='));
    await send('pairing.close'); checkEqual('pairing close actually invalidates the code', engine.delivery.pairing.state().open, false);
    await send('device.forget', { id: d.id });
    checkEqual('local forget removes that device without regenerating pins', [engine.delivery.devices.get(d.id), engine.delivery.identity.fingerprint, engine.delivery.vapid.applicationServerKey], [null, pin, vapid]);
    await send('network.start', { kind: 'tailnet' }); await send('network.stop', { kind: 'tailnet' });
    checkEqual('network administration reaches only the synthetic adapter', networkCalls, [['start', { kind: 'tailnet' }], ['stop', { kind: 'tailnet' }]]);
    checkEqual('unsupported attended/editor chrome reports a named refusal', (await send('editor.request', { method: 'lidConfirm', target: null })).code, 'EDITOR_METHOD_UNAVAILABLE');
    checkEqual('phone self/other forget exceptions keep current grants', [mayMutate({ principal: 'device:self', seat: { local: false, control: false } }, { type: 'forget', id: 'self' }),
      mayMutate({ principal: 'device:self', seat: { local: false, control: false } }, { type: 'forget', id: 'other' }),
      mayMutate({ principal: 'device:self', seat: { local: false, control: true } }, { type: 'forget', id: 'other' }),
      mayMutate({ principal: 'device:self', seat: { local: false, control: true } }, { type: 'allSettings' })], [true, false, true, false]);
    const extra = daemon.graph.bridge.enroll({ kind: 'editor' });
    await send('localClient.revoke', { id: extra.id });
    checkEqual('revoked local credentials cannot re-enroll', daemon.graph.bridge.enroll({ kind: 'editor', id: extra.id, key: extra.key }).code, 'ENROLLMENT_INVALID');
    await send('localClient.forget', { id: extra.id });
    check('local client listing contains no credential bytes', !(JSON.stringify((await send('localClient.list')).data).includes(extra.key)));
    await send('project.remove', { root: project }); checkEqual('removing saved approval drops an unannounced project', management.knownProject(project), false);
    checkEqual('management does not enable production activation', daemon.status().mode, 'isolated-p1');
  } finally { for (const c of connections) c.close(); await daemon.stop(); }
};
