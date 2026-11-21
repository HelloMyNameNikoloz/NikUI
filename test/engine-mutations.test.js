'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { fixture, message, mid, stamp, deferred, tick } = require('./helpers/engine-provider');
const { state } = require('./fixtures/engine/fakes');
const { DeviceStore } = require('../src/devices');
const { RemoteServer } = require('../src/remote');
const { SessionHub } = require('../src/hub');
const { createMachineHost } = require('../src/machineHost');
const { createDaemonConfig } = require('../src/daemonConfig');
const { PrFeed } = require('../src/prView');
const { Terminals } = require('../src/terminal');
const { SlackRoom } = require('../src/slackRoom');
const { SlackService } = require('../src/slack/service');
const { CORE, validateResult } = require('../src/protocolV2');
const { DOMAIN } = require('../src/engineState');
const { SEEN, REVOCATIONS } = require('../src/wireMutations');
const { CodexClient } = require('../src/codex');
const { rpcFixture } = require('./helpers/engine-provider');
const { loadCorpus, validateSchema } = require('./helpers/protocol-v2-fixtures');
const PR = 'https://github.com/fixture/repo/pull/7';
const OTHER = 'https://github.com/fixture/repo/pull/8';
const CAPS = [...CORE, 'pr-v1', 'slack-v1', 'terminal-v1'];

async function setup() {
  const f = await fixture(); let store = f.store;
  const s = f.engine.manager.create({ id: 'fixture-source', cwd: f.f.dir, autoStart: false, prUrl: PR, prPinned: true, unread: true });
  await f.runtime.flush();
  const devices = new DeviceStore(state({ 'nikui.devices': ['phone-1', 'phone-2'].map((id) => ({ id, name: id, control: true, pairedAt: 1, publicKey: id })) }), { now: () => stamp });
  const calls = { gh: [], shell: [], slack: [], ui: [], create: 0, resume: 0, connects: 0, disconnects: 0, signIns: 0, power: [] };
  let ghAnswer = async () => ({ ok: true, stdout: '{}' }), slackAnswer = async (method) => method === 'chat.postMessage'
    ? { ts: '1700.22' } : method === 'conversations.history' ? { messages: [{ ts: '1700.23' }] } : {};
  const feed = new PrFeed({ run: async (...args) => { calls.gh.push(args); return ghAnswer(...args); },
    now: () => stamp, setTimeout: f.timers.setTimeout, clearTimeout: f.timers.clearTimeout });
  const e = feed.entry(PR); e.cwd = f.f.dir; e.last = { state: { checks: [{ runId: 'run-original', status: 'fail' }] } };
  const children = [];
  const terminals = new Terminals({ home: f.f.dir, env: {}, shell: '/fixture/shell', now: () => stamp,
    setTimeout: f.timers.setTimeout, clearTimeout: f.timers.clearTimeout,
    spawn: (...args) => {
      calls.shell.push(args); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kills = []; child.kill = (signal) => { child.kills.push(signal); return true; }; children.push(child); return child;
    } });
  const service = new SlackService({ api: { call: async (...args) => { calls.slack.push(args); return slackAnswer(...args); } },
    now: () => stamp, setTimeout: f.timers.setTimeout, clearTimeout: f.timers.clearTimeout });
  service.conversations.set('C1', { id: 'C1', last: { ts: '1.2' }, messages: [] });
  service.thread = async (id, thread) => ({ conversation: { id }, messages: [{ text: 'snapshot', thread }], hasMore: false });
  service.permalink = async () => 'https://slack.com/fixture';
  let currentService = service;
  const room = new SlackRoom({ service: () => currentService, settings: () => ({}),
    connect: async () => { calls.connects++; return { ok: true, who: { user_id: 'U1', token: 'never-save' } }; },
    disconnect: async () => { calls.disconnects++; return { ok: true }; },
    connectWith: async () => { calls.signIns++; return { ok: true, who: { user_id: 'U1', team_id: 'T1', token: 'never-save' } }; } });
  const providers = [{ id: 'editor-a', workspaces: ['file://' + f.f.dir], focused: true,
    request: async (...args) => { calls.ui.push(['a', ...args]); return { status: 'dispatched' }; } },
  { id: 'editor-b', workspaces: [], focused: false,
    request: async (...args) => { calls.ui.push(['b', ...args]); return { status: 'dispatched' }; } }];
  const source = () => createDaemonConfig({ ...store.snapshot().values[DOMAIN].settings, root: f.f.dir });
  const host = createMachineHost({ manager: f.engine.manager, settings: source, prFeed: feed,
    codex: () => f.engine.codex, editor: { providers: () => providers, timeoutMs: 30 },
    env: { home: f.f.dir, openUrl: async (...args) => { calls.ui.push(['system', ...args]); return true; } } });
  host.choosePr = async () => OTHER;
  const server = new RemoteServer({ root: path.resolve(__dirname, '..'), host, devices, terminals,
    sessions: { get: (id) => f.engine.manager.get(id) || f.engine.codex.get(id), list: () => f.engine.manager.list },
    projects: () => [{ path: f.f.dir, name: 'Fixture' }], codex: f.engine.codex, slack: () => room,
    createInstance: ({ cwd, folderId }) => { calls.create++; return f.engine.manager.create({ cwd, autoStart: false }); },
    history: async () => [{ sessionId: 'history-1', cwd: f.f.dir, title: 'Original history' }],
    resumeInstance: (entry) => { calls.resume++; return f.engine.manager.create({ cwd: entry.cwd, resume: entry.sessionId, autoStart: false }); },
    keepAwake: { state: () => ({ on: false }), set: async (on) => { calls.power.push(['awake', on]); }, setLid: async (on) => { calls.power.push(['lid', on]); } }, log() {} });
  const unlistenTerminals = terminals.subscribe((event) => server.terminalSaid(event));
  const hub = new SessionHub(s, host), sockets = [];
  let seq = 1000;
  async function socket({ role = 'conversation', local = false, control = true, editor = false, caps = CAPS, proto = 2 } = {}) {
    const id = 'client-' + (++seq), principal = local ? 'local:fixture' : 'device:phone-1';
    if (!local) devices.get('phone-1').control = control;
    const frames = [], events = [];
    const client = { id, device: local ? { kind: 'local', id: 'local', control: true } : { ...devices.get('phone-1'), kind: 'device' },
      open: true, post: (m) => { frames.push(structuredClone(m)); if (m.type === 'ack') events.push('ack'); },
      close() { if (!this.open) return; this.open = false; events.push('close'); },
      tellDevice() { if (role === 'conversation') hub.setDevice(id, this.device); } };
    server.clients.add(client);
    if (role === 'conversation') hub.attach({ ...client, editor: editor ? 'editor-a' : null }); else server.fleetClients.add(client);
    const context = { authenticated: true, principal, role, target: role === 'conversation' ? 'session:' + s.id : 'fleet',
      seat: { id: editor ? 'editor-a' : local ? 'local' : 'phone-1', control, local, editor } };
    const socket = f.runtime.createSocket({ client, hub: role === 'conversation' ? hub : null, server, context,
      authenticated: true, sealed: true, testOnlyV2: proto === 2, caps, now: () => stamp,
      engine: { id: store.snapshot().engineId, boot: 'a'.repeat(32), version: 'fixture', mode: 'service' },
      close: () => client.close() });
    await socket.receive({ type: 'hello', proto: { min: 1, max: proto }, caps, client: { id: mid(seq), kind: 'test', version: 'fixture' } });
    const item = { socket, client, context, frames, events, make: (fields) => message(store, ++seq, fields),
      async send(fields) { const m = fields.mid ? fields : this.make(fields); await socket.receive(m); return frames.filter((r) => r.type === 'ack' && r.mid === m.mid).at(-1); },
      async twice(fields, outcome = 'applied') {
        const m = this.make(fields), answers = [];
        await socket.receive(m); answers.push(frames.filter((r) => r.type === 'ack' && r.mid === m.mid).at(-1));
        await socket.receive(m); answers.push(frames.filter((r) => r.type === 'ack' && r.mid === m.mid).at(-1));
        checkEqual(fields.type + ': one ' + outcome + ' original and duplicate',
          [answers[0]?.outcome, answers[1]?.status, answers[0]?.outcome === outcome ? null : answers[0]?.error?.code], [outcome, 'duplicate', null]);
        checkEqual(fields.type + ': duplicate retains exact result', answers[1]?.result, answers[0]?.result);
        if (answers[0]?.result) validateResult(answers[0].result, store.limits.maxResultBytes, fields.type);
        return { m, first: answers[0], second: answers[1] };
      } };
    sockets.push(item); return item;
  }
  return { ...f, get runtime() { return f.runtime; }, get store() { return store; }, s, server, hub, host, feed, devices, terminals, children, service, room, providers, calls, socket,
    async reopen() { const reopened = await f.reopen(); store = reopened.store; return reopened; },
    ghAnswer: (answer) => { ghAnswer = answer; }, slackAnswer: (answer) => { slackAnswer = answer; },
    changeService: (next) => { currentService = next; },
    async close() { for (const s of sockets) s.socket.dispose(); unlistenTerminals(); hub.dispose(); service.stop(); feed.dispose(); terminals.dispose(); await server.dispose(); await f.close(); } };
}

module.exports = async function () {
  suite('P1-24 T19: negotiated server time includes the persisted authority high-water');
  const clockFixture = await setup();
  try {
    clockFixture.advance(1000); await clockFixture.store.commit(() => {}); clockFixture.advance(-1000);
    const socket = await clockFixture.socket();
    checkEqual('welcome uses the same effective clock as mutation admission after rollback', socket.frames[0].receipts.now, stamp + 1000);
  } finally { await clockFixture.close(); }

  suite('R16 note 1: borrowed handles without a close method get one named diagnostic');
  const rpc = rpcFixture({ initialize: { __error: { message: 'synthetic refusal' } } });
  const handle = rpc.spawn(); delete handle.close; const logs = [];
  const client = new CodexClient({ codexPath: '/fixture/codex', daemonFn: async () => handle,
    spawnFn: () => { throw new Error('no replacement'); }, log: (s) => logs.push(s) });
  try { await client.start(); } catch (_) { /* expected */ }
  client.dispose(); client.dispose();
  checkEqual('one named unclosable borrowed connection diagnostic', logs.filter((s) => s.includes('BORROWED_TRANSPORT_UNCLOSABLE')).length, 1);
  checkEqual('untyped borrowed cleanup never kills or ends stdin', [handle.kills, handle.stdin.writableEnded], [0, false]);
  handle.exit();

  suite('P1-17: opted-in fleet/hub core results and connection-local ready');
  let f = await setup();
  try {
    const conversation = await f.socket(), fleet = await f.socket({ role: 'fleet' });
    for (const bad of [null, [], { type: 1 }]) {
      await fleet.socket.receive(bad);
      checkEqual('malformed v2 frames get one typed refusal', fleet.frames.at(-1).error?.code, 'BAD_MESSAGE');
    }
    checkEqual('only explicit construction selects v2', conversation.frames[0].proto, 2);
    const ready = await conversation.twice({ type: 'ready' });
    checkEqual('duplicate ready produces fresh init without another start', [conversation.frames.filter((m) => m.type === 'init').length, f.claude.processes.length], [2, 1]);
    f.s.unread = true; f.s.emit('meta'); await f.runtime.flush();
    await conversation.send(ready.m);
    checkEqual('historical ready cannot clear a later unread flag', f.store.snapshot().values[DOMAIN].instances[0].unread, true);
    await conversation.twice({ type: 'visible', on: true });
    checkEqual('visible commits unread clear', f.store.snapshot().values[DOMAIN].instances[0].unread, false);
    const made = await fleet.twice({ type: 'instance:new', cwd: f.f.dir, id: 'new-correlation' });
    checkEqual('one durable instance creation and original correlation', [f.calls.create, made.first.result?.replies[0].id], [1, 'new-correlation']);
    const resume = await fleet.twice({ type: 'instance:resume', sessionId: 'history-1', id: 'resume-correlation' });
    checkEqual('history resume is not rerun', f.calls.resume, 1);
    check('creation and resume metadata live in authority', [made.first.result?.data.instance, resume.first.result?.data.instance].every((id) => f.store.snapshot().values[DOMAIN].instances.some((s) => s.id === id)));
    await f.store.commit((state) => { state.values[DOMAIN].folders.folders.push({ id: 'creation-folder', name: 'Fixture' }); });
    const placedCreation = await fleet.twice({ type: 'instance:new', cwd: f.f.dir, folderId: 'creation-folder' });
    checkEqual('creation commits its requested folder even when the adapter only creates the process',
      f.store.snapshot().values[DOMAIN].folders.assign[placedCreation.first.result.data.instance], 'creation-folder');
    await fleet.twice({ type: 'instance:place', instance: f.s.id, folderId: null, id: 'placed' });
    await conversation.twice({ type: 'setSetting', id: 'thinking', value: false });
    await conversation.twice({ type: 'saveCommand', name: 'fixture', prompt: 'standing instruction', description: 'test' });
    await conversation.twice({ type: 'removeCommand', name: 'fixture' });
    const shipped = Object.keys(require('../package.json').contributes.configuration.properties['nikui.promptSnippets'].default)[0];
    await conversation.twice({ type: 'restoreCommand', name: shipped });
    checkEqual('curated setting is in authority', f.store.snapshot().values[DOMAIN].settings.user.showThinking, false);
    const send = await conversation.twice({ type: 'send', text: 'retained input', snippets: ['fixture'], attachments: [] });
    await conversation.twice({ type: 'promoteQueued', id: send.first.result?.data.queueId, mode: 'reorder' });
    await conversation.twice({ type: 'editQueued', id: send.first.result?.data.queueId });
    const second = await conversation.send({ type: 'send', text: 'remove me' });
    await conversation.twice({ type: 'unqueue', id: second.result?.data.queueId });
    await conversation.twice({ type: 'clearQueue' });
    await fleet.twice({ type: 'awake:set', on: true }); await fleet.twice({ type: 'lid:set', on: false });
    checkEqual('power adapters run once per intent', f.calls.power, [['awake', true], ['lid', false]]);
    const watch = await f.socket({ control: false }), watchFleet = await f.socket({ role: 'fleet', control: false });
    await watch.twice({ type: 'visible', on: true }); await watch.twice({ type: 'pr:pane', prUrl: PR, open: true });
    for (const fields of [{ type: 'send', text: 'must not send' }, { type: 'clearQueue' }, { type: 'setSetting', id: 'thinking', value: true },
      { type: 'saveCommand', name: 'x', prompt: 'x' }, { type: 'pr:reply', prUrl: PR, threadId: 't', body: 'x' }, { type: 'runInTerminal', command: 'x' }]) {
      checkEqual('watch grant refuses ' + fields.type, (await watch.send(fields))?.error?.code, 'FORBIDDEN');
    }
    for (const fields of [{ type: 'instance:new', cwd: f.f.dir }, { type: 'forget', id: 'phone-2' }, { type: 'term:open' }])
      checkEqual('fleet watch grant refuses ' + fields.type, (await watchFleet.send(fields))?.error?.code, 'FORBIDDEN');
    const apple = await watchFleet.twice({ type: '@apple', token: 'ab'.repeat(32) });
    checkEqual('Apple result does not echo the token', apple.first.result?.data, { registered: true });
    await watchFleet.twice({ type: '@apple', token: '<' + 'cd '.repeat(16) + '>' });
    checkEqual('v2 registration preserves existing token normalization and lengths', f.devices.get('phone-1').apns.token, 'cd'.repeat(16));
    const listen = await watchFleet.twice({ type: '@listen' });
    checkEqual('listener duplicate returns original bearer', listen.first.result?.replies, listen.second.result?.replies);
    const local = await f.socket({ role: 'fleet', local: true });
    checkEqual('local key cannot invoke paired-device forget', (await local.send({ type: 'forget', id: 'phone-2' }))?.error?.code, 'FORBIDDEN');
    const forget = await watchFleet.send({ type: 'forget', id: 'phone-1' });
    checkEqual('self forget is committed and ack enqueued before reconcile closes socket', [forget?.outcome, watchFleet.events.slice(-2)], ['applied', ['ack', 'close']]);
    checkEqual('revocation remains authoritative', f.store.snapshot().values[REVOCATIONS].length, 1);
    checkEqual('revoked principal cannot retrieve listener bearer', (await watchFleet.send(listen.m))?.error?.code, 'FORBIDDEN');
  } finally { await f.close(); }

  suite('P1-17: watch ready never starts; bare v1 still has its legacy wire');
  f = await setup();
  try {
    const watch = await f.socket({ control: false }); await watch.twice({ type: 'ready' });
    checkEqual('watch ready starts no provider', f.claude.processes.length, 0);
    const old = await f.socket({ proto: 1 });
    await old.socket.receive({ type: 'ready' });
    checkEqual('v1 ready has init and no ack or v2 fields', [old.frames.some((m) => m.type === 'init'), old.frames.some((m) => m.type === 'ack')], [true, false]);
  } finally { await f.close(); }

  f = await setup();
  try {
    const c = await f.socket(); let starts = 0;
    f.s.start = async () => { starts++; throw new Error('fixture startup reply lost'); };
    await c.twice({ type: 'ready' }, 'unknown');
    checkEqual('unknown duplicate ready still snapshots without another startup', [starts, c.frames.filter((m) => m.type === 'init').length], [1, 2]);
  } finally { await f.close(); }

  suite('P1-18: frozen PR write plans, typed original results, and uncertainty');
  f = await setup();
  try {
    const c = await f.socket();
    for (const fields of [{ type: 'pr:reply', prUrl: PR, threadId: 'thread-original', body: 'original reply' },
      { type: 'pr:resolve', prUrl: PR, threadId: 'thread-original', resolved: false },
      { type: 'pr:comment', prUrl: PR, body: 'original comment' }, { type: 'pr:rerun', prUrl: PR }]) {
      if (fields.type === 'pr:rerun') f.feed.entry(PR).last = { state: { checks: [{ runId: 'run-original', status: 'fail' }] } };
      await c.twice(fields);
    }
    const writes = () => f.calls.gh.filter(([, args]) => args.includes('graphql') && args.some((s) => s.startsWith('query=mutation')) || args.includes('comment') || args.includes('rerun'));
    checkEqual('each PR family writes once', writes().length, 4);
    const old = c.make({ type: 'pr:comment', prUrl: PR, body: 'before relink' });
    const first = await c.send(old); f.s.prUrl = OTHER; f.s.emit('meta'); await f.runtime.flush();
    checkEqual('historical duplicate after relink returns original result', (await c.send(old))?.result, first?.result);
    const n = writes().length;
    checkEqual('fresh old PR target is stale after relink', (await c.send({ type: 'pr:reply', prUrl: PR, threadId: 't', body: 'old' }))?.error?.code, 'STALE_RESOURCE');
    checkEqual('stale PR never writes gh', writes().length, n);
    f.s.prUrl = PR; f.s.emit('meta'); await f.runtime.flush();
    f.ghAnswer(async () => { throw new Error('accept then lose reply'); });
    const lost = await c.twice({ type: 'pr:comment', prUrl: PR, body: 'uncertain' }, 'unknown');
    checkEqual('ambiguous gh write is unknown on both deliveries', [lost.first?.outcome, lost.second?.outcome], ['unknown', 'unknown']);
    f.ghAnswer(async () => ({ ok: false, stderr: 'network dropped' }));
    checkEqual('nonzero gh without nonacceptance proof is unknown', (await c.send({ type: 'pr:comment', prUrl: PR, body: 'ambiguous exit' }))?.outcome, 'unknown');
    const local = await f.socket({ local: true, editor: true });
    await local.twice({ type: 'pr:link', prUrl: PR });
    await local.twice({ type: 'pr:unlink', prUrl: OTHER });
    f.s.prUrl = PR; f.s.prPinned = true; f.s.emit('meta'); await f.runtime.flush();
    const gate = deferred(); f.host.choosePr = () => gate.promise;
    const pending = local.send({ type: 'pr:link', prUrl: PR });
    await tick(); f.s.prUrl = OTHER; f.s.emit('meta'); await f.runtime.flush(); gate.resolve('https://github.com/fixture/repo/pull/9');
    checkEqual('async chooser cannot overwrite a relink', (await pending)?.error?.code, 'STALE_RESOURCE');
    checkEqual('new PR remains linked', f.s.prUrl, OTHER);
  } finally { await f.close(); }

  suite('P1-18: terminal IDs, exact run preconditions and duplicate effects');
  f = await setup();
  try {
    const fleet = await f.socket({ role: 'fleet' });
    const opened = await fleet.twice({ type: 'term:open', session: f.s.id });
    const id = opened.first?.result?.data.terminal.id;
    const ran = await fleet.twice({ type: 'term:run', id, command: 'fixture command' });
    const run = ran.first?.result?.data.terminalRun;
    checkEqual('one frozen command and stable run before shell spawn', [f.calls.shell.length, f.terminals.get(id).running?.id], [1, run]);
    checkEqual('v2 began events expose the same active run',
      [fleet.frames.find((m) => m.type === 'term:began')?.terminal.activeRun, fleet.frames.find((m) => m.type === 'term:began')?.terminal.busy], [run, true]);
    await fleet.socket.receive({ type: 'term:list' });
    checkEqual('v2 list exposes observed activeRun', fleet.frames.at(-1).terminals[0].activeRun, run);
    await fleet.twice({ type: 'term:stop', id, terminalRun: run });
    checkEqual('duplicate stop sends one signal', f.children[0].kills, ['SIGTERM']);
    f.children[0].emit('close', 0);
    const newRun = await fleet.send({ type: 'term:run', id, command: 'new command' });
    check('next run gets a distinct durable ID', newRun?.result?.data.terminalRun !== run);
    checkEqual('old stop cannot target a new command', (await fleet.send({ type: 'term:stop', id, terminalRun: run }))?.error?.code, 'STALE_RESOURCE');
    checkEqual('observed idle close cannot close a newly running command', (await fleet.send({ type: 'term:close', id, terminalRun: null }))?.error?.code, 'STALE_RESOURCE');
    checkEqual('replacement child receives no old signals', f.children[1].kills.length, 0);
    await fleet.twice({ type: 'term:close', id, terminalRun: newRun.result.data.terminalRun });
    const cdOpen = await fleet.send({ type: 'term:open' }), cdId = cdOpen.result.data.terminal.id;
    await fleet.twice({ type: 'term:run', id: cdId, command: 'cd ' + f.f.dir });
    await fleet.twice({ type: 'term:close', id: cdId, terminalRun: null });
    const noCap = await f.socket({ role: 'fleet', caps: CORE });
    checkEqual('capability is required in addition to grant', (await noCap.send({ type: 'term:open' }))?.error?.code, 'UNSUPPORTED');
  } finally { await f.close(); }

  suite('P1-18: Slack posted ts, seen watermark, credential exclusion and local/paired branches');
  f = await setup();
  try {
    const fleet = await f.socket({ role: 'fleet' }), local = await f.socket({ role: 'fleet', local: true });
    const reply = await fleet.twice({ type: 'slack:reply', conversation: 'C1', text: 'reply once', id: 'slack-correlation' });
    checkEqual('SlackService returns posted ts and original legacy correlation', [reply.first?.result?.data.ts, reply.first?.result?.replies[0].id], ['1700.22', 'slack-correlation']);
    checkEqual('one post and one mark', f.calls.slack.filter(([name]) => ['chat.postMessage', 'conversations.mark'].includes(name)).map(([name]) => name), ['chat.postMessage', 'conversations.mark']);
    const opened = await fleet.twice({ type: 'slack:open', conversation: 'C1' });
    checkEqual('seen watermark co-commits in authority', f.store.snapshot().values[SEEN].C1.ts, '1.2');
    f.service.conversations.get('C1').last.ts = '1.3'; await fleet.send(opened.m);
    checkEqual('duplicate open cannot mark a newly arrived message seen', f.service._nikuiSeen.get('C1'), '1.2');
    for (const fields of [{ type: 'slack:mute', conversation: 'C1', muted: true }, { type: 'slack:vips', vips: ['A', 'a', 'B'] }, { type: 'slack:enable' }]) await fleet.twice(fields);
    for (const fields of [{ type: 'slack:connect' }, { type: 'slack:disconnect' }, { type: 'slack:signIn', token: 'synthetic-private-token', cookie: 'synthetic-private-cookie' }]) await local.twice(fields);
    checkEqual('credential adapters execute once per intent', [f.calls.connects, f.calls.disconnects, f.calls.signIns], [1, 1, 1]);
    const retained = fs.readFileSync(f.f.file, 'utf8') + JSON.stringify(local.frames);
    check('no credential in JSONL, receipt, original replies or local frames', !/synthetic-private-token|synthetic-private-cookie|never-save/.test(retained));
    for (const type of ['slack:connect', 'slack:disconnect', 'slack:signIn', 'slack:settings', 'slack:openTicket'])
      checkEqual('paired local-only branch refuses ' + type, (await fleet.send({ type, token: 'x', cookie: 'y', url: PR }))?.error?.code, 'LOCAL_REQUIRED');
    await fleet.socket.receive({ type: 'slack:setup' });
    checkEqual('paired setup is a query without mid', fleet.frames.at(-1).type, 'slack:link');
    await fleet.socket.receive({ type: 'slack:link', conversation: 'C1', ts: '1.2' });
    checkEqual('paired link is a query and does not open a laptop browser', [fleet.frames.at(-1).url, f.calls.ui.length], ['https://slack.com/fixture', 0]);
    await local.twice({ type: 'slack:setup' }); await local.twice({ type: 'slack:link', conversation: 'C1', ts: '1.2' });
    await local.twice({ type: 'slack:settings' }); await local.twice({ type: 'slack:openTicket', url: PR });
    const watch = await f.socket({ role: 'fleet', control: false });
    await watch.twice({ type: 'slack:open', conversation: 'C1' });
    checkEqual('watch Slack reply refuses at authority', (await watch.send({ type: 'slack:reply', conversation: 'C1', text: 'no' }))?.error?.code, 'FORBIDDEN');
    f.devices.get('phone-1').control = true;
    f.slackAnswer(async (name) => { if (name === 'chat.postMessage') throw new Error('lost posted response'); return {}; });
    const lost = await fleet.twice({ type: 'slack:reply', conversation: 'C1', text: 'uncertain' }, 'unknown');
    checkEqual('Slack lost post response stays unknown', [lost.first?.outcome, lost.second?.outcome], ['unknown', 'unknown']);
  } finally { await f.close(); }

  suite('P1-18: frozen editor provider, UI results, system browser and no fallback');
  f = await setup();
  try {
    const local = await f.socket({ local: true, editor: true }), paired = await f.socket();
    for (const fields of [{ type: 'openFile', path: 'a.js', line: 2 }, { type: 'runInTerminal', command: 'insert without enter' },
      { type: 'allSettings' }, { type: 'slack' }, { type: 'openPr' }, { type: 'pr:open', url: PR }]) await local.twice(fields);
    const switcher = await paired.twice({ type: 'switch', id: f.s.id });
    checkEqual('paired switch stores navigation only', switcher.first?.result?.replies, [{ type: '@navigate', session: f.s.id }]);
    const c = local.make({ type: 'openFile', path: 'frozen.js' });
    const gate = deferred(); const commit = f.store.commit;
    let blocked = false;
    f.store.commit = (...args) => {
      if (!blocked) { blocked = true; return gate.promise.then(() => commit(...args)); }
      return commit(...args);
    };
    const pending = local.send(c);
    await tick(); f.providers[0].connected = false; f.providers[1].focused = true; gate.resolve();
    checkEqual('disconnected captured editor cannot retarget to focused replacement', (await pending)?.error?.code, 'EDITOR_UNAVAILABLE');
    checkEqual('replacement editor received no fallback', f.calls.ui.filter(([who]) => who === 'b').length, 0);
    f.store.commit = commit; f.providers[0].connected = true;
    f.providers[0].request = async (...args) => { f.calls.ui.push(['lost', ...args]); return { outcome: 'unknown' }; };
    const lost = await local.twice({ type: 'runInTerminal', command: 'insert once, lose response' }, 'unknown');
    checkEqual('lost bridge reply stays unknown', [lost.first?.outcome, lost.second?.outcome], ['unknown', 'unknown']);
    f.providers.splice(0);
    const browser = await f.socket({ local: true }); await browser.twice({ type: 'openPr' });
    checkEqual('without an editor, URL uses the injected system default browser once', f.calls.ui.filter(([who]) => who === 'system').length, 1);
    checkEqual('unsupported mutation never falls through to a legacy automation action', (await browser.send({ type: 'not-a-mutation' }))?.error?.code, 'UNSUPPORTED');
  } finally { await f.close(); }

  suite('P1-17: provider controls and handoff keep one authority result through the wire');
  f = await setup();
  try {
    const c = await f.socket();
    f.s.start(); f.s._handleSystem({ type: 'system', subtype: 'init', session_id: 'fixture-conversation' });
    f.s._handleControlRequest({ type: 'control_request', request_id: 'approval-wire',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'fixture only' } } });
    const approval = f.s.items.filter((i) => i.kind === 'permission').at(-1);
    await c.twice({ type: 'permission', requestId: 'approval-wire', allow: true, run: approval.run });
    checkEqual('v2 approval updates only its original pending item', approval.resolved, 'allow');
    checkEqual('v2 duplicate permission writes once', f.claude.calls.filter((c) => c.type === 'control_response').length, 1);
    f.s._handleBackgroundTasks([{ task_id: 'wire-shell', task_type: 'local_bash', description: 'finite fixture' }]);
    await c.twice({ type: 'stopTask', taskId: 'wire-shell', run: f.s.shellList[0].run });
    await c.twice({ type: 'interrupt', run: f.s._engineControls.run() });
    f.s._handleResult({ type: 'result', is_error: false });
    await c.send({ type: 'ready' });
    f.rpc.answers['thread/start'] = { thread: { id: 'handoff-thread', cwd: f.f.dir } };
    const handed = await c.twice({ type: 'send', text: '/codex frozen task', snippets: ['context'], attachments: [] });
    const saved = f.store.snapshot().outbox.find((q) => q.mid === handed.m.mid);
    checkEqual('handoff retains original origin and full intent before provider creation',
      [saved.payload.mode, saved.payload.requester.client, saved.payload.message.text], ['handoff', c.client.id, '/codex frozen task']);
    f.runtime.start(); await f.runtime.drain(c.context.target);
    checkEqual('handoff creates one destination through the injected provider', f.rpc.calls.filter((m) => m.method === 'thread/start').length, 1);
    check('handoff destination and completion are durable', f.store.snapshot().outbox.some((q) => q.mid === handed.m.mid && q.destination === 'cx-handoff-thread' && q.state === 'completed'));
    checkEqual('handoff navigates its original requester', c.frames.filter((m) => m.type === '@navigate').at(-1)?.session, 'cx-handoff-thread');
    await f.reopen(); const next = await f.socket();
    checkEqual('handoff historical receipt survives reopen', (await next.send(handed.m))?.result, handed.first.result);
    checkEqual('handoff duplicate cannot recreate its destination', f.rpc.calls.filter((m) => m.method === 'thread/start').length, 1);
  } finally { await f.close(); }

  suite('P1-18: ingress preconditions survive metadata waits and changing grants');
  f = await setup();
  try {
    const c = await f.socket(), fleet = await f.socket({ role: 'fleet' });
    const originalCommit = f.store.commit;
    async function holdMetadata(action, change) {
      const gate = deferred(); let intercepted = false;
      f.store.commit = (...args) => {
        if (!intercepted) { intercepted = true; return gate.promise.then(() => originalCommit(...args)); }
        return originalCommit(...args);
      };
      f.s.rename('pending metadata'); await tick();
      const pending = action(); await tick(); change(); gate.resolve();
      try { return await pending; } finally { f.store.commit = originalCommit; }
    }
    const writes = () => f.calls.gh.filter(([, args]) => args.includes('comment') || args.includes('rerun') || args.some((arg) => arg.startsWith('query=mutation'))).length;
    const before = writes();
    const stale = await holdMetadata(() => c.send({ type: 'pr:comment', prUrl: PR, body: 'captured before metadata' }), () => {
      f.s.prUrl = OTHER; f.s.emit('meta');
    });
    checkEqual('relink during metadata wait rejects before gh write', [stale?.error?.code, writes()], ['STALE_RESOURCE', before]);
    const denied = await holdMetadata(() => c.send({ type: 'send', text: 'revoked while waiting' }), () => { f.devices.get('phone-1').control = false; });
    checkEqual('core mutation rereads the current grant after metadata wait', denied?.error?.code, 'FORBIDDEN');
    checkEqual('revoked send has no outbox item', f.store.snapshot().outbox.filter((q) => q.payload.message?.text === 'revoked while waiting').length, 0);
    f.devices.get('phone-1').control = true;
    const accepted = await c.send({ type: 'send', text: 'accepted before revocation' });
    f.devices.get('phone-1').control = false; f.runtime.start(); await f.runtime.drain(c.context.target);
    checkEqual('queued delivery consults live authority after socket creation', (await f.runtime.operation(c.context, { scope: accepted.scope, mid: accepted.mid })).state, 'queued');
    f.devices.get('phone-1').control = true;
    const opened = await fleet.send({ type: 'term:open' }), id = opened.result.data.terminal.id;
    const run = await fleet.send({ type: 'term:run', id, command: 'first fixture run' });
    const terminalRace = await holdMetadata(() => fleet.send({ type: 'term:stop', id, terminalRun: run.result.data.terminalRun }), () => {
      f.children.at(-1).emit('close', 0); f.terminals.run(id, 'replacement fixture run');
    });
    checkEqual('terminal stop captures the run before metadata waits', terminalRace?.error?.code, 'STALE_RESOURCE');
    checkEqual('replacement run receives no old stop', f.children.at(-1).kills.length, 0);
  } finally { await f.close(); }

  suite('P1-18: original external results and unknowns survive disk reopen without redispatch');
  f = await setup();
  try {
    const c = await f.socket(), fleet = await f.socket({ role: 'fleet' });
    const comment = await c.send({ type: 'pr:comment', prUrl: PR, body: 'durable original' });
    const commentMessage = f.store.snapshot().outbox.find((q) => q.mid === comment.mid).payload.plan;
    checkEqual('gh plan retains its original cwd and body', [commentMessage.cwd, commentMessage.calls[0].at(-1)], [f.f.dir, 'durable original']);
    const posted = await fleet.twice({ type: 'slack:reply', conversation: 'C1', text: 'persist posted ts', id: 'persist-id' });
    const listener = await fleet.twice({ type: '@listen' });
    const term = await fleet.twice({ type: 'term:open' });
    f.ghAnswer(async () => { throw new Error('synthetic lost write reply'); });
    const uncertain = await c.twice({ type: 'pr:comment', prUrl: PR, body: 'retain unknown' }, 'unknown');
    const writes = () => f.calls.gh.filter(([, args]) => args.includes('comment') || args.includes('rerun') || args.some((arg) => arg.startsWith('query=mutation'))).length;
    const ghCount = writes(), postCount = f.calls.slack.length;
    await f.reopen(); f.s.prUrl = OTHER; f.s.emit('meta'); await f.runtime.flush();
    const next = await f.socket(), nextFleet = await f.socket({ role: 'fleet' });
    for (const old of [posted, listener, term]) checkEqual(old.m.type + ': exact historical result after reopen', (await nextFleet.send(old.m))?.result, old.first.result);
    checkEqual('unknown remains unknown after reopen and relink', (await next.send(uncertain.m))?.outcome, 'unknown');
    checkEqual('reopening receipts performs no provider write', [writes(), f.calls.slack.length], [ghCount, postCount]);
    checkEqual('duplicate terminal open did not allocate another terminal', f.terminals.list().length, 1);
  } finally { await f.close(); }

  suite('P1-17: committed self-forget survives a lost ack and never revokes a later enrollment');
  f = await setup();
  try {
    const fleet = await f.socket({ role: 'fleet', control: false });
    const saved = f.devices.get('phone-1'), m = fleet.make({ type: 'forget', id: 'phone-1' });
    const oldPost = fleet.client.post;
    // Drop the transport before ack enqueue. The receipt remains committed;
    // restart reconciliation is the only permitted continuation of revocation.
    const socket = f.runtime.createSocket({ client: fleet.client, server: f.server, context: fleet.context,
      testOnlyV2: true, sealed: true, caps: CAPS, now: () => stamp,
      engine: { id: f.store.snapshot().engineId, boot: mid(55), version: 'fixture', mode: 'service' },
      post: (frame) => { if (frame.type === 'ack') throw new Error('fixture transport lost ack'); oldPost(frame); } });
    await socket.receive({ type: 'hello', proto: { min: 2, max: 2 }, caps: CAPS, client: { id: mid(55), kind: 'test', version: 'fixture' } });
    try { await socket.receive(m); } catch (_) { /* synthetic lost transport */ }
    checkEqual('lost enqueue retains committed forget receipt', f.store.snapshot().entries.find((r) => r.mid === m.mid)?.outcome, 'applied');
    check('revocation has not closed the socket ahead of the lost ack enqueue', !!f.devices.get('phone-1'));
    await f.reopen();
    require('../src/wireMutations').reconcileDeviceRevocations(f.store, f.devices);
    checkEqual('recovery completes the committed revocation', f.devices.get('phone-1'), null);
    f.devices.save([{ ...saved, pairedAt: 2 }]);
    require('../src/wireMutations').reconcileDeviceRevocations(f.store, f.devices);
    checkEqual('old revocation cannot remove a new enrollment of the key', f.devices.get('phone-1')?.pairedAt, 2);
    socket.dispose();
  } finally { await f.close(); }


  suite('P1-17/18 runtime conformance: new mutation-family traces and current-seat vectors');
  const corpus = loadCorpus();
  const enabled = new Set(['@apple', '@listen', 'forget', 'awake:set', 'lid:set', 'instance:new', 'instance:resume', 'ready', 'visible',
    'saveCommand', 'removeCommand', 'restoreCommand', 'allSettings', 'slack', 'openPr', 'openFile', 'runInTerminal', 'switch',
    'pr:open', 'pr:reply', 'pr:resolve', 'pr:comment', 'pr:rerun', 'pr:link', 'pr:unlink', 'term:open', 'term:run', 'term:stop', 'term:close',
    'slack:open', 'slack:reply', 'slack:mute', 'slack:vips', 'slack:enable', 'slack:connect', 'slack:disconnect', 'slack:signIn',
    'slack:settings', 'slack:setup', 'slack:link', 'slack:openTicket']);
  const vectors = [...corpus.vectors.values()].filter((v) => v.id.startsWith('mutation-') && enabled.has(v.input[0].message.type) || v.id.startsWith('seat-'));
  checkEqual('41 new mutation traces and all 14 grant traces execute production wire routing', vectors.length, 55);
  for (const v of vectors) {
    f = await setup();
    try {
      const c = await f.socket({ role: v.context.role, ...v.context.seat });
      const input = v.input.map((step) => ({ ...step.message, ...(step.message.mid ? { scope: f.store.snapshot().scope } : {}) }));
      // Resolve the corpus's symbolic resources into this private engine. No
      // request is sent to the synthetic absolute path or provider IDs.
      for (const m of input) {
        if (m.cwd) m.cwd = f.f.dir;
        if (m.prUrl) m.prUrl = PR;
        if (m.session === 'instance-7') m.session = f.s.id;
        if (m.type === 'instance:resume') f.server.history = async () => [{ sessionId: m.sessionId, cwd: f.f.dir, title: 'fixture' }];
        if (m.type === 'restoreCommand') m.name = 'lean'; // the shipped fixture word
      }
      const m = input[0];
      if (m.type === 'switch') { f.engine.manager.create({ id: m.id, cwd: f.f.dir, autoStart: false }); await f.runtime.flush(); }
      if (m.type === 'removeCommand') await f.runtime.dispatch(c.context, message(f.store, 9100, { type: 'saveCommand', name: m.name, prompt: 'fixture words' }));
      if (m.type === 'pr:pane' && m.prUrl === null) { f.s.prUrl = null; f.s.emit('meta'); await f.runtime.flush(); }
      if (m.type === 'ready' && v.initial.providerRunning) { f.s.start(); f.s._handleSystem({ type: 'system', subtype: 'init', session_id: 'corpus-conversation' }); await f.runtime.flush(); }
      if (m.type === 'pr:rerun') f.feed.entry(PR).last = { state: { checks: [{ runId: 'run-fixture', status: 'fail' }] } };
      if (v.initial.terminal) {
        const t = v.initial.terminal;
        f.terminals.open({ id: t.id, cwd: f.f.dir, name: 'Fixture' });
        if (t.activeRun) f.terminals.run(t.id, 'observed fixture command', { runId: t.activeRun });
      }
      const effects = () => ({ create: f.calls.create, resume: f.calls.resume, power: f.calls.power.length, ui: f.calls.ui.length,
        gh: f.calls.gh.filter(([, args]) => args.includes('comment') || args.includes('rerun') || args.some((s) => s.startsWith('query=mutation'))).length,
        slack: f.calls.slack.filter(([name]) => ['chat.postMessage', 'conversations.mark'].includes(name)).length,
        shell: f.calls.shell.length, signals: f.children.reduce((n, child) => n + child.kills.length, 0), providers: f.claude.processes.length,
        terminals: f.terminals.list().map((t) => [t.id, t.cwd]), devices: f.devices.list(), settings: f.store.snapshot().values[DOMAIN].settings });
      let first, once;
      for (const [n, step] of input.entries()) {
        await c.socket.receive(step);
        const expected = (step.mid ? v.expected.replies.filter((r) => r.type === 'ack') : v.expected.replies)[n];
        const answer = step.mid ? c.frames.filter((m) => m.type === 'ack' && m.mid === step.mid).at(-1) : c.frames.at(-1);
        checkEqual(v.id + ': actual disposition ' + n, [answer?.type, answer?.outcome || null, answer?.error?.code || null],
          [expected.type, expected.outcome || null, expected.error?.code || null]);
        if (answer?.type === 'ack') {
          check(v.id + ': actual ack wire schema ' + n, validateSchema(answer, corpus.schema.$defs.ack, corpus.schema));
          if (answer.outcome === 'applied') {
            validateResult(answer.result, f.store.limits.maxResultBytes, step.type);
            checkEqual(v.id + ': original result is authoritative ' + n, f.store.snapshot().entries.find((r) => r.mid === step.mid)?.result, answer.result);
          }
        }
        if (n === 0) { first = answer; once = structuredClone(effects()); }
        else {
          checkEqual(v.id + ': duplicate result', answer?.result, first?.result);
          checkEqual(v.id + ': duplicate has no second effect', effects(), once);
        }
      }
    } finally { await f.close(); }
  }


  suite('P1-17: Codex local slash commands use typed durable plans instead of prompt text');
  f = await setup();
  try {
    const s = await f.codex(), frames = [], rpc = f.rpc;
    const commandHub = new SessionHub(s, f.host), client = { id: 'command-origin', device: { kind: 'device', id: 'phone-1', control: true }, post: (m) => frames.push(m) };
    commandHub.attach(client);
    const context = { authenticated: true, principal: 'device:phone-1', role: 'conversation', target: 'session:' + s.id,
      seat: { id: 'phone-1', control: true, local: false, editor: false } };
    const socket = f.runtime.createSocket({ client, server: f.server, hub: commandHub, context, testOnlyV2: true, sealed: true, caps: CAPS,
      now: () => stamp, engine: { id: f.store.snapshot().engineId, boot: mid(80), version: 'fixture', mode: 'service' } });
    await socket.receive({ type: 'hello', proto: { min: 2, max: 2 }, caps: CAPS, client: { id: mid(80), kind: 'test', version: 'fixture' } });
    let seq = 8000;
    const send = async (fields) => {
      const m = fields.mid ? fields : message(f.store, ++seq, fields);
      await socket.receive(m); return { m, ack: frames.filter((r) => r.type === 'ack' && r.mid === m.mid).at(-1) };
    };
    rpc.answers['model/list'] = { data: [{ id: 'fixture-model', model: 'fixture-model', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' },
      { id: 'model-2', model: 'provider-model-2', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }] };
    rpc.answers['thread/turns/list'] = (params) => ({ data: params.limit === 1 ? [{ id: 'observed-last-turn', status: 'completed' }] : [] });
    rpc.answers['thread/goal/get'] = { goal: null };
    rpc.answers['thread/goal/set'] = (params) => ({ goal: { objective: params.objective || 'goal objective', status: params.status } });
    rpc.answers['thread/goal/clear'] = {};
    rpc.answers['review/start'] = { turn: { id: 'review-turn', status: 'completed' } };
    rpc.answers['thread/revert'] = { thread: { id: s.threadId, cwd: f.f.dir } };
    rpc.answers['thread/fork'] = { thread: { id: 'forked-thread', cwd: f.f.dir } };
    await send({ type: 'ready' });
    const requests = [];
    for (const text of ['/plan on', '/model model-2 high', '/effort low', '/model', '/goal objective', '/goal pause', '/goal', '/goal clear', '/review main', '/undo', '/fork']) {
      const action = await send({ type: 'send', text }); requests.push(action);
      checkEqual(text + ': accepted once as an outbox intent', [action.ack?.result?.code || null, action.ack?.error?.code || null], ['accepted', null]);
      f.runtime.start(); await f.runtime.drain(context.target); await f.runtime.flush();
      const op = await f.runtime.operation(context, { scope: action.m.scope, mid: action.m.mid });
      checkEqual(text + ': specific command completes', op.state, 'completed');
      const before = rpc.calls.length, items = s.items.length;
      checkEqual(text + ': duplicate returns original acceptance', (await send(action.m)).ack?.result, action.ack.result);
      checkEqual(text + ': duplicate invokes no command or RPC', [rpc.calls.length, s.items.length], [before, items]);
    }
    checkEqual('slash commands were never submitted as normal turns', rpc.calls.filter((m) => m.method === 'turn/start').length, 0);
    checkEqual('undo uses the original read-derived target', rpc.calls.find((m) => m.method === 'thread/revert')?.params.beforeTurnId, 'observed-last-turn');
    checkEqual('fork navigates the original client', frames.filter((m) => m.type === '@navigate').at(-1)?.session, 'cx-forked-thread');
    checkEqual('chosen Codex settings are persisted', f.store.snapshot().values[DOMAIN].instances.find((m) => m.id === s.id).codexSettings,
      { mode: 'plan', model: 'provider-model-2', effort: 'low' });
    for (const text of ['/not-supported', '/plan invalid', '/undo unexpected', '/review commit', '/model no-such-model']) {
      check(text + ': explicit rejection', ['BAD_MESSAGE', 'UNSUPPORTED'].includes((await send({ type: 'send', text })).ack?.error?.code));
    }
    await f.reopen();
    checkEqual('Codex choices survive authority recovery', [s.meta.model, s.effort, s.meta.mode], ['provider-model-2', 'low', 'plan']);
    const original = requests.at(-1), before = rpc.calls.length;
    const replay = await f.runtime.dispatch(context, original.m);
    checkEqual('fork receipt survives restart without another provider call', [replay.status, replay.result, rpc.calls.length], ['duplicate', original.ack.result, before]);
    socket.dispose(); commandHub.dispose();
  } finally { await f.close(); }

  suite('P1-17: Codex command lost replies remain unknown and cannot become raw prompt retries');
  f = await setup();
  try {
    const s = await f.codex(), context = { authenticated: true, principal: 'device:phone-1', role: 'conversation', target: 'session:' + s.id,
      seat: { id: 'phone-1', control: true, local: false, editor: false } };
    f.rpc.answers['thread/goal/set'] = require('./helpers/engine-provider').DROP;
    const m = message(f.store, 9900, { type: 'send', text: '/goal uncertain objective' });
    const accepted = await f.runtime.dispatch(context, m);
    f.runtime.start(); await f.runtime.drain(context.target);
    checkEqual('lost slash-command write has its own unknown operation', (await f.runtime.operation(context, { scope: m.scope, mid: m.mid })).state, 'unknown');
    await f.reopen();
    const duplicate = await f.runtime.dispatch(context, m);
    checkEqual('original acceptance survives command uncertainty and restart', duplicate.result, accepted.result);
    checkEqual('unknown command is never retried as a goal or ordinary prompt',
      [f.rpc.calls.filter((r) => r.method === 'thread/goal/set').length, f.rpc.calls.filter((r) => r.method === 'turn/start').length], [1, 0]);
  } finally { await f.close(); }


  suite('P1-18: uncertain terminal writes keep one result and the exact observed run');
  f = await setup();
  try {
    const fleet = await f.socket({ role: 'fleet' }), opened = await fleet.send({ type: 'term:open' });
    const id = opened.result.data.terminal.id, ran = await fleet.send({ type: 'term:run', id, command: 'fixture command' });
    const child = f.children.at(-1); child.kill = (signal) => { child.kills.push(signal); throw new Error('synthetic lost signal confirmation'); };
    await fleet.twice({ type: 'term:stop', id, terminalRun: ran.result.data.terminalRun }, 'unknown');
    checkEqual('lost terminal signal is not sent twice', child.kills, ['SIGTERM']);
    await fleet.twice({ type: 'term:close', id, terminalRun: ran.result.data.terminalRun }, 'unknown');
    check('uncertain close retains its original terminal for observation', !!f.terminals.get(id));
    const other = await fleet.send({ type: 'term:open' }), secondId = other.result.data.terminal.id;
    let attempts = 0;
    f.terminals.spawn = () => { attempts++; throw new Error('synthetic launch confirmation lost'); };
    await fleet.twice({ type: 'term:run', id: secondId, command: 'uncertain fixture launch' }, 'unknown');
    checkEqual('ambiguous shell launch never spawns again on duplicate', attempts, 1);
  } finally { await f.close(); }

  suite('P1-17: grant revocation during follower owner lookup prevents the later write');
  f = await setup();
  try {
    await f.socket(); // bind current device authentication/grants to this authority
    const s = await f.codex(), entered = deferred(), release = deferred();
    s.readOnly = true; s.turnId = 'follower-turn'; let writes = 0;
    f.engine.codex.ipc = { ownerOf: async () => { entered.resolve(); return release.promise; }, interrupt: async () => { writes++; }, dispose() {} };
    const context = { authenticated: true, principal: 'device:phone-1', role: 'conversation', target: 'session:' + s.id,
      seat: { id: 'phone-1', control: true, local: false, editor: false } };
    const pending = f.runtime.dispatch(context, message(f.store, 9950, { type: 'interrupt', run: s._engineControls.run() }));
    await entered.promise; f.devices.get('phone-1').control = false; release.resolve('fixture-owner');
    const answer = await pending;
    checkEqual('revoked control is rejected after async owner discovery', [answer.outcome, answer.error?.code, writes], ['rejected', 'FORBIDDEN', 0]);
  } finally { await f.close(); }

  suite('P1-18: Slack permalink lookup cannot change the captured editor');
  f = await setup();
  try {
    const local = await f.socket({ role: 'fleet', local: true }), entered = deferred(), release = deferred();
    f.service.permalink = async () => { entered.resolve(); return release.promise; };
    const pending = local.send({ type: 'slack:link', conversation: 'C1', ts: '1.2' });
    await entered.promise; f.providers[0].focused = false; f.providers[1].focused = true;
    release.resolve('https://slack.com/original');
    const answer = await pending;
    checkEqual('async permalink keeps the originally selected editor', answer?.result?.data, { provider: 'editor-a', destination: 'https://slack.com/original' });
    checkEqual('no newly focused editor receives the old action', f.calls.ui.map(([id]) => id), ['a']);
  } finally { await f.close(); }

  suite('P1-18: late PR discovery cannot replace a manual relink');
  f = await setup();
  try {
    const release = deferred(), links = new (require('../src/prlink').PrLinks)({ run: () => release.promise });
    const s = new EventEmitter(); Object.assign(s, { cwd: f.f.dir, ticket: '7', prUrl: null, prPinned: false, _engineControls: {} });
    const pending = links.link(s); links.pin(s, OTHER);
    release.resolve({ ok: true, stdout: JSON.stringify({ url: PR }) }); await pending;
    checkEqual('read response from the original link cannot retarget the selected PR', s.prUrl, OTHER);
    links.dispose();
  } finally { await f.close(); }


  suite('P1-18: failed-check rerun targets are frozen before authority waits');
  f = await setup();
  try {
    const c = await f.socket(), release = deferred(), commit = f.store.commit;
    f.feed.entry(PR).last = { state: { checks: [{ runId: 'original-check-run', status: 'fail' }] } };
    let blocked = false;
    f.store.commit = (...args) => {
      if (!blocked) { blocked = true; return release.promise.then(() => commit(...args)); }
      return commit(...args);
    };
    const pending = c.send({ type: 'pr:rerun', prUrl: PR });
    await tick(); f.feed.entry(PR).last = { state: { checks: [{ runId: 'replacement-check-run', status: 'fail' }] } };
    release.resolve();
    checkEqual('rerun of captured failed check succeeds', (await pending)?.outcome, 'applied');
    checkEqual('new failed-check snapshot cannot retarget the old rerun', f.calls.gh.filter(([, args]) => args.includes('rerun')).map(([, args]) => args[2]), ['original-check-run']);
    f.store.commit = commit;
  } finally { await f.close(); }

  suite('P1-17: hidden power setting effects and prior local approval');
  f = await setup();
  try {
    const c = await f.socket();
    await c.twice({ type: 'setSetting', id: 'awake', value: true });
    checkEqual('curated power setting invokes its adapter once and persists the preference',
      [f.calls.power, f.store.snapshot().values[DOMAIN].settings.user.keepAwake], [[['awake', true]], true]);
    f.server.keepAwake.state = () => ({ supported: true, lid: { supported: true, approved: false } });
    const refused = await c.send({ type: 'setSetting', id: 'lid', value: true });
    checkEqual('phone setting cannot trigger first-time lid setup', [refused?.error?.code, f.calls.power.length], ['LOCAL_REQUIRED', 1]);
  } finally { await f.close(); }

  suite('P1-18: corrupt retained mutation state refuses recovery before providers');
  f = await setup();
  try {
    await f.store.commit((state) => { state.values[SEEN] = { C1: { ts: 'not-a-timestamp', at: stamp } }; });
    let code = null;
    try { await f.reopen(); } catch (error) { code = error.code; }
    checkEqual('invalid seen state is a named storage refusal', [code, f.rpc.calls.length, f.claude.processes.length], ['STORAGE_UNAVAILABLE', 0, 0]);
  } finally { await f.close(); }


  suite('P1-17/18: delayed handoff origin survives another sender or disconnect');
  f = await setup();
  try {
    const original = await f.socket(), newer = await f.socket();
    await original.send({ type: 'ready' });
    let created = 0;
    f.rpc.answers['thread/start'] = () => ({ thread: { id: 'origin-destination-' + (++created), cwd: f.f.dir } });
    await original.send({ type: 'send', text: '/codex original task' });
    await newer.send({ type: 'send', text: 'a later prompt changes lastSender' });
    f.runtime.start(); await f.runtime.drain(original.context.target);
    checkEqual('delayed handoff navigates its original client after lastSender changes', original.frames.filter((m) => m.type === '@navigate').at(-1)?.session, 'cx-origin-destination-1');
    checkEqual('later sender does not receive the original navigation', newer.frames.filter((m) => m.type === '@navigate').length, 0);
    await original.send({ type: 'send', text: '/codex task before disconnect' });
    f.hub.detach(original.client.id);
    f.host.switchTo = () => { f.calls.ui.push(['must-not-fallback']); };
    await f.runtime.drain(original.context.target);
    checkEqual('disconnected phone origin never falls back to a laptop editor', f.calls.ui.length, 0);
    checkEqual('handoff command can progress independently of the source queue', created, 2);
  } finally { await f.close(); }


  suite('P1-17: ready revalidates control after receipt waits');
  f = await setup();
  try {
    const c = await f.socket(), entered = deferred(), release = deferred(), commit = f.store.commit;
    let n = 0;
    f.store.commit = (...args) => {
      if (++n === 2) { entered.resolve(); return release.promise.then(() => commit(...args)); }
      return commit(...args);
    };
    const pending = c.send({ type: 'ready' });
    await entered.promise; f.devices.get('phone-1').control = false; release.resolve();
    const answer = await pending; f.store.commit = commit;
    checkEqual('ready remains readable after control revocation without starting a provider', [answer?.outcome, f.claude.processes.length], ['applied', 0]);
    checkEqual('watch-ready still receives its current init', c.frames.filter((m) => m.type === 'init').length, 1);
  } finally { await f.close(); }

  suite('P1-17: cold Codex command discovery cannot start a provider outside ready');
  f = await setup();
  try {
    const s = f.engine.codex._adopt({ id: 'cold-fixture', cwd: f.f.dir }); await f.runtime.flush();
    const frames = [], client = { id: 'cold-client', device: { id: 'phone-1', kind: 'device', control: true }, post: (m) => frames.push(m) };
    const hub = new SessionHub(s, f.host); hub.attach(client);
    const context = { authenticated: true, principal: 'device:phone-1', role: 'conversation', target: 'session:' + s.id,
      seat: { id: 'phone-1', control: true, local: false, editor: false } };
    const early = await f.runtime.dispatch(context, message(f.store, 11990, { type: 'send', text: '/model' }));
    checkEqual('read-only command discovery on a cold session refuses without launching', [early.error?.code, f.rpc.processes.length], ['STALE_RESOURCE', 0]);
    f.rpc.answers['thread/resume'] = { thread: { id: s.threadId, cwd: f.f.dir }, model: 'fixture-model' };
    f.rpc.answers['thread/turns/list'] = { data: [] }; f.rpc.answers['thread/goal/get'] = { goal: null };
    f.rpc.answers['model/list'] = { data: [] };
    const socket = f.runtime.createSocket({ client, hub, server: f.server, context, testOnlyV2: true, sealed: true, caps: CAPS,
      now: () => stamp, engine: { id: f.store.snapshot().engineId, boot: mid(11991), version: 'fixture', mode: 'service' } });
    await socket.receive({ type: 'hello', proto: { min: 2, max: 2 }, caps: CAPS, client: { id: mid(11991), kind: 'test', version: 'fixture' } });
    const ready = message(f.store, 11992, { type: 'ready' });
    await socket.receive(ready); const answer = frames.find((m) => m.type === 'ack' && m.mid === ready.mid);
    checkEqual('ready waits for async Codex startup before reporting its execution', [answer?.outcome, answer?.result?.data.run, s.loaded], ['applied', s._engineControls.run(), true]);
    await socket.receive(ready);
    checkEqual('duplicate cold Codex ready reuses one start and sends a second init', [f.rpc.processes.length, frames.filter((m) => m.type === 'init').length], [1, 2]);
    socket.dispose(); hub.dispose();
  } finally { await f.close(); }

  suite('P1-17: revocation authority fences broadcasts even if device projection fails');
  f = await setup();
  try {
    const c = await f.socket(), fleet = await f.socket({ role: 'fleet' }); await c.send({ type: 'ready' });
    f.devices.forget = () => { throw new Error('fixture device mirror unavailable'); };
    const m = fleet.make({ type: 'forget', id: 'phone-1' });
    try { await fleet.socket.receive(m); } catch (_) { /* ack already committed/enqueued */ }
    checkEqual('device mirror failure cannot undo the original committed ack', fleet.frames.filter((r) => r.type === 'ack' && r.mid === m.mid).at(-1)?.outcome, 'applied');
    const before = c.frames.length;
    f.hub.broadcast({ type: 'items', items: [{ text: 'must not disclose' }] });
    checkEqual('durable revocation prevents subsequent protected broadcasts', c.frames.length, before);
  } finally { await f.close(); }

};
