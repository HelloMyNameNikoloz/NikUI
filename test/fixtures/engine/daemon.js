'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { startDaemon } = require('../../../src/daemonRuntime');
const { createTestStore } = require('../../../src/daemonStore');
const { controlRequest } = require('../../../src/daemonControl');
const { createPolicyAuthority, createFakePolicyAdapters } = require('../../../src/policyOwner');
const { createEngine } = require('../../../src/engine');
const { provider, context, settings, clock, tick } = require('./fakes');
const { USER_TOKEN, APP_TOKEN } = require('../../../src/slackRuntime');
const { writeHeader } = require('../../../src/voice');
const ws = require('../../helpers/ws');
const root = fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT);
const privateDir = (file) => fs.mkdirSync(file, { recursive: true, mode: 0o700 });

function request(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, headers, agent: false }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

module.exports = async function () {
  const daemonRoot = path.join(root, 'd'); privateDir(daemonRoot);
  privateDir(path.join(daemonRoot, 'state', 'voice'));
  fs.writeFileSync(path.join(daemonRoot, 'state', 'voice', 'fixture-voice'), 'synthetic transcriber fixture', { mode: 0o600 });
  const fakeSecrets = createTestStore(path.join(daemonRoot, 'secrets.test.json'), { testOnly: true });
  await fakeSecrets.store(USER_TOKEN, 'xoxp-PRIVATE-DAEMON-CREDENTIAL');
  await fakeSecrets.store(APP_TOKEN, 'xapp-PRIVATE-DAEMON-CREDENTIAL');
  fs.writeFileSync(path.join(daemonRoot, 'config.json'), JSON.stringify({ version: 1,
    user: { 'slack.enabled': true, 'slack.mentions': false, keepAwake: true }, projects: [] }), { mode: 0o600 });
  const cx = provider({ 'thread/list': { data: [{ id: 'one', name: 'private thread', cwd: path.join(daemonRoot, 'home') }] },
    'model/list': { data: [] } }), claude = provider(), terminal = provider();
  const sockets = [], calls = [], voiceCalls = [];
  let lookups = 0;
  const daemon = await startDaemon({ root: daemonRoot, adapters: {
    tools: { knownDirs: [], lookup: async () => { lookups++; return { path: '/fixture/tools:/usr/bin:/bin', tools: {} }; } },
    claudeSpawn: claude.spawnFn, codexSpawn: cx.spawnFn, terminalSpawn: terminal.spawnFn,
    voiceRun: async (file, args, opts) => { voiceCalls.push({ file, args, opts });
      return { ok: true, stdout: JSON.stringify({ ok: true, model: 'fixture', text: 'Review these words', seconds: 1 }) }; },
    slackApi: () => ({ call: async (method) => {
      calls.push(method);
      if (method === 'auth.test') return { user_id: 'U1', user: 'fixture', team_id: 'T1' };
      return { ok: true, channels: [], groups: [], ims: [], mpims: [], messages: [], prefs: {} };
    } }),
    slackSocket: () => { const socket = { starts: 0, stops: 0, start() { this.starts++; }, stop() { this.stops++; } }; sockets.push(socket); return socket; }
  } });
  try {
    suite('T03/T04/T05: actual private daemon composes every extracted factory without VS Code');
    checkEqual('only loopback and the private Unix socket are bound', [daemon.engine.remote.server.address().address,
      fs.statSync(daemon.paths.root).mode & 0o777, fs.statSync(daemon.paths.socket).mode & 0o777], ['127.0.0.1', 0o700, 0o600]);
    checkEqual('the graph owns engine, delivery, Slack, fake power, PR/CI and all remote resources', daemon.status().services,
      ['engine', 'delivery', 'slack', 'power/notifications:fake', 'pr/ci', 'remote', 'terminal:fake', 'voice:fake', 'appUpdate:fixture']);
    check('actual Slack service and injected socket started', !!daemon.engine.slack.service && sockets[0].starts === 1 && calls.includes('auth.test'));
    const home = daemon.paths.home;
    const session = daemon.engine.manager.create({ cwd: home, autoStart: false });
    check('new instance identity is scoped to this daemon generation', session.id.startsWith(daemon.generation + ':'));
    session.start();
    await daemon.engine.codex.refresh();
    check('the actual Claude and Codex factories use only the injected fake spawners', claude.spawned.length === 1 && cx.spawned.length === 1);
    const outsideImage = path.join(root, 'source-image.png'), insideImage = path.join(home, 'fixture-image.png');
    fs.writeFileSync(outsideImage, 'private source image', { mode: 0o600 });
    fs.writeFileSync(insideImage, 'private fixture image', { mode: 0o600 });
    checkEqual('Codex provider image references cannot read a source path outside the daemon root', await daemon.engine.codex.cache.picture(outsideImage), null);
    checkEqual('private images still pass through the actual cache', (await daemon.engine.codex.cache.picture(insideImage)).data, Buffer.from('private fixture image').toString('base64'));
    checkEqual('fake cache shrinking has no native machine fallback', await daemon.engine.codex.cache.shrink(), false);
    checkEqual('both provider environments use private HOME, account, keeper and cached PATH', [claude.spawned[0], cx.spawned[0]].map(({ opts }) =>
      [opts.env.HOME, opts.env.CODEX_HOME, opts.env.NIKUI_KEEPER_DIR, opts.env.PATH.startsWith('/fixture/tools:')]),
      [[home, path.join(home, '.codex-work'), path.join(daemonRoot, 'keeper'), true], [home, path.join(home, '.codex-work'), path.join(daemonRoot, 'keeper'), true]]);
    checkEqual('the resolved missing Claude target remains inside the private root', claude.spawned[0].cmd, path.join(home, 'missing-claude'));
    checkEqual('headless lazy editor and attended UI paths refuse safely', [daemon.graph.host.openFile({ path: 'a', cwd: home }).status,
      daemon.graph.host.openUrl('https://example.invalid').reason, await daemon.graph.host.confirmPausedSend({ isPaused: true })],
      ['unavailable', 'SYSTEM_OPENER_UNAVAILABLE', false]);
    const t = daemon.graph.resources.terminals.open({ cwd: home });
    daemon.graph.resources.terminals.run(t.id, 'fixture command');
    terminal.spawned[0].proc.stdout.write('private output'); terminal.spawned[0].proc.emit('close', 0);
    check('actual terminal resource runs against the fake process only', terminal.spawned[0].opts.env.HOME === home);
    checkEqual('the actual voice factory uses a private fake transcriber', (await daemon.graph.resources.voice.state()).available, true);
    const spoken = await daemon.graph.resources.voice.transcribe(writeHeader(Buffer.alloc(32044), 32000));
    checkEqual('fake transcription yields reviewable text without sending it', [spoken.text, claude.spawned[0].proc.calls.length], ['Review these words', 0]);
    check('voice runner paths and environment stay private', voiceCalls.every(({ file, opts }) => file.startsWith(daemonRoot + path.sep) && opts.env.HOME === home));
    checkEqual('update resource only considers the fixture APK', daemon.graph.resources.appUpdate.file, path.join(daemonRoot, 'state', 'fixture.apk'));
    checkEqual('fake power aggregation includes listener policy without native effects', daemon.graph.fakePolicy.owners.get(daemon.generation), { awake: true, lid: false });
    const health = await request(daemon.engine.remote.port, '/health');
    checkEqual('the actual extracted v1 HTTP server is healthy', [health.status, JSON.parse(health.body).ok], [200, true]);
    checkEqual('HTTP cannot enroll a local/editor seat', (await request(daemon.engine.remote.port, '/enroll?kind=editor&caps=all')).status, 404);
    const enrollment = await controlRequest(daemon.paths, { op: 'enroll', kind: 'local', caps: ['all'], from: 'remote' });
    checkEqual('legacy owner-only enrollment grants no editor capabilities', [enrollment.ok, enrollment.kind, enrollment.protocol, enrollment.editorMethods], [true, 'local', 1, []]);
    const client = await ws.connect(`ws://127.0.0.1:${daemon.engine.remote.port}/socket`, { headers: { authorization: 'Bearer ' + enrollment.key } });
    await client.waitFor('@challenge'); client.send({ type: '@auth', device: null, nonce: 'fixture-local' });
    const welcome = await client.waitFor('@welcome');
    checkEqual('the private enrollment key works with the existing LocalKey authority', [welcome.device.kind, welcome.device.control], ['local', true]);
    client.close(); await tick();
    check('viewer disconnect leaves engine, services and policy ownership alive', daemon.status().state === 'running' && daemon.engine.policy.state().owned && sockets[0].stops === 0);
    const status = await controlRequest(daemon.paths, { op: 'status', secret: 'DO_NOT_REFLECT_CONTROL_PAYLOAD' });
    const doctor = await controlRequest(daemon.paths, { op: 'doctor' });
    const text = JSON.stringify([status, doctor]);
    check('status/doctor redact credentials, enrollment keys and raw control payloads', !text.includes('PRIVATE-DAEMON-CREDENTIAL') && !text.includes(enrollment.key)
      && !text.includes('DO_NOT_REFLECT_CONTROL_PAYLOAD') && status.secrets === '[redacted]');
    checkEqual('status and doctor reuse one tool lookup', lookups, 1);
    check('missing-tool diagnostics are explicit and actionable', doctor.blockers.some((b) => b.code === 'TOOL_MISSING' && b.tool === 'claude' && /Install/.test(b.hint)));
  } finally { await daemon.stop(); await daemon.stop(); }
  suite('T04/T58: daemon drains its owned graph once');
  checkEqual('the actual Slack socket is stopped exactly once', sockets[0].stops, 1);
  checkEqual('owned provider closes without touching borrowed/live processes', [cx.spawned[0].proc.kills, claude.spawned[0].proc.stdin.writableEnded], [1, true]);
  checkEqual('root lock and control socket are removed on orderly stop', [fs.existsSync(daemon.paths.lock), fs.existsSync(daemon.paths.socket)], [false, false]);
  checkEqual('all fake power/watchdog ownership is released', daemon.graph.fakePolicy.owners.size, 0);

  suite('T56 P1: engine generations share an explicit authority, never a global');
  const authority = createPolicyAuthority(), fake = createFakePolicyAdapters(), engines = [];
  for (const name of ['old', 'new']) {
    const home = path.join(root, name); privateDir(home);
    const engine = createEngine({ context: context(), settings: settings(), paths: { home, projects: home },
      spawner: () => { throw new Error('unexpected spawn'); }, codex: { unavailableReason: 'fixture' }, timers: clock() });
    engine.createPolicy({ authority, generation: name, ...fake, codexBusy: () => 0 }); engines.push(engine);
  }
  try {
    await engines[0].start();
    let code;
    try { await engines[1].start(); } catch (err) { code = err.code; }
    checkEqual('the second engine cannot also acquire the power/banner generation', code, 'POLICY_OWNED');
    await engines[0].dispose();
    await engines[1].policy.start();
    checkEqual('new generation acquires after old engine disposal', authority.generation, 'new');
  } finally { for (const engine of engines) await engine.dispose(); }
};
