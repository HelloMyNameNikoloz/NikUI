'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { createEngine } = require('../../../src/engine');
const { createMachineHost } = require('../../../src/machineHost');
const { createRemote, createRemoteResources } = require('../../../src/remoteRuntime');
const { writeHeader } = require('../../../src/voice');
const { context, settings, clock, deferred, tick } = require('./fakes');
const { makeDevice } = require('../../helpers/device');
const ws = require('../../helpers/ws');

const root = process.env.NIKUI_ENGINE_FIXTURE_ROOT;
const audio = () => writeHeader(Buffer.alloc(32044), 32000);
const reject = async (fn) => { try { await fn(); return ''; } catch (err) { return err.message; } };
function request(server, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.port, path: route, headers, agent: false }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (s) => { text += s; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
  });
}
async function connect(server, phone, session) {
  const client = await ws.connect(`ws://127.0.0.1:${server.port}/socket` + (session ? '?session=' + session.id : ''),
    phone ? {} : { headers: { cookie: 'nikui=' + server.gate.key } });
  const challenge = await client.waitFor('@challenge');
  if (phone) { client.send(await phone.answer(challenge, phone.id)); client.seal(phone.box); }
  else client.send({ type: '@auth', device: null, nonce: 'private-local-fixture-nonce' });
  await client.waitFor('@welcome');
  return client;
}
async function ask(client, message, type) {
  client.messages = []; client.send(message); return client.waitFor(type);
}

module.exports = async function () {
  const engines = [], servers = [], clients = [];
  const never = () => { throw new Error('An injected provider was unexpectedly used'); };
  function make(name) {
    const home = path.join(root, name); fs.mkdirSync(home);
    const bundle = path.join(home, 'bundle'); fs.mkdirSync(path.join(bundle, 'media'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'media', 'fixture.js'), name + ' asset');
    const timers = clock(), source = settings();
    const engine = createEngine({ context: context(), settings: source, timers, spawner: never,
      paths: { home, projects: path.join(home, 'projects') }, codex: { unavailableReason: 'Fixture disabled' },
      delivery: { store: context().globalState, secretPolicy: { mode: 'legacy-window' },
        pushRequest: never, appleRequest: never } });
    engines.push(engine);
    const host = createMachineHost({ manager: engine.manager, settings: source, env: { home } });
    const session = engine.manager.create({ id: 'same-session-id', cwd: home, autoStart: false });
    let starts = 0, sends = 0;
    session.start = () => { starts++; }; session.submit = () => { sends++; };
    return { home, bundle, timers, source, engine, host, session, effects: () => [starts, sends] };
  }
  function resources(fixture) {
    const { home, bundle, source, timers } = fixture;
    const shellCalls = [], voiceCalls = [], children = [];
    const binary = path.join(bundle, 'transcriber'); fs.writeFileSync(binary, 'synthetic binary');
    const tmp = path.join(home, 'audio-tmp'); fs.mkdirSync(tmp);
    const run = async (file, args, options) => {
      const call = { file, args, options }; voiceCalls.push(call);
      if (args[0] === 'check') return { ok: true, stdout: JSON.stringify({ ok: true, model: 'fixture-model' }) };
      if (args[0] !== 'transcribe') throw new Error('Unexpected compiler/model command');
      call.audio = fs.readFileSync(args[1]); call.mode = fs.statSync(args[1]).mode & 0o777;
      call.folderMode = fs.statSync(path.dirname(args[1])).mode & 0o777;
      return { ok: true, stdout: JSON.stringify({ ok: true, text: 'Review this draft before sending', seconds: 1, ms: 2 }) };
    };
    const env = { HOME: home, TMPDIR: tmp, PATH: '/fixture/tools' };
    const made = createRemoteResources({ home, timers,
      terminal: { shell: '/fixture/shell', env, spawn(file, args, options) {
        shellCalls.push({ file, args, options });
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.signals = []; child.kill = (signal) => { child.signals.push(signal); child.emit('close', null, signal); };
        children.push(child); return child;
      } },
      voice: { dir: path.join(home, 'storage'), tmp, package: path.join(bundle, 'voice'), models: path.join(home, 'models'),
        binary, run, env, platform: 'darwin', arch: 'arm64', enabled: () => source.get('voice.enabled', true) }
    });
    return { ...made, shellCalls, voiceCalls, children, tmp };
  }
  try {
    suite('P1-07/T03/T05: explicit resources, inert construction and relocated assets');
    check('an implicit asset root is refused', /absolute path/.test(await reject(() => createRemote({ resources: {}, ownership: {} }))));
    check('resource ownership cannot be guessed', /ownership/.test(await reject(() => createRemote({ root, resources: { voice: {} }, ownership: {} }))));
    check('an enabled shell without its injected runner is refused', /spawn/.test(await reject(() => createRemoteResources({ home: root, terminal: { shell: '/bin/sh', env: {} } }))));
    const a = make('alpha'), b = make('beta'), ra = resources(a), rb = resources(b);
    const ownership = { terminals: 'owned', voice: 'owned', appUpdate: 'owned' };
    let fleetWatcher = null;
    const sa = a.engine.createRemote({ root: a.bundle, host: a.host, resources: ra, ownership,
      watchFleet: (fn) => { fleetWatcher = fn; return () => { fleetWatcher = null; }; } });
    const sb = b.engine.createRemote({ root: b.bundle, host: b.host, resources: rb, ownership });
    servers.push(sa, sb);
    checkEqual('hub registries are owned while engine delivery and its stream are borrowed',
      [sa.ownership.hubs, sa.ownership.delivery, sa.ownership.notificationStream], ['owned', 'borrowed', 'borrowed']);
    checkEqual('construction and engine start do not bind, run a shell or warm voice',
      [sa.listening, sb.listening, ra.shellCalls.length, ra.voiceCalls.length, fs.readdirSync(ra.tmp)], [false, false, 0, 0, []]);
    await Promise.all([a.engine.start(), b.engine.start()]);
    checkEqual('engine startup retains explicit listener policy', [sa.listening, sb.listening], [false, false]);
    check('a second server cannot take one engine resources', /already owns/.test(await reject(() => a.engine.createRemote({}))));
    await Promise.all([sa.start(), sa.start(), sb.start()]);
    checkEqual('actual listeners use private ephemeral loopback ports', [sa.server.address().address, sb.server.address().address, sa.port !== sb.port, sa.exposed, sb.exposed],
      ['127.0.0.1', '127.0.0.1', true, false, false]);
    checkEqual('the real health handler runs', (await request(sa, '/health')).text, '{"ok":true}');
    checkEqual('each listener serves only its relocated bundle', [(await request(sa, '/media/fixture.js')).text, (await request(sb, '/media/fixture.js')).text], ['alpha asset', 'beta asset']);
    fs.symlinkSync(path.join(a.home, 'private.js'), path.join(a.bundle, 'media', 'escape.js'));
    fs.writeFileSync(path.join(a.home, 'private.js'), 'private');
    checkEqual('the current asset symlink guard still refuses outside media', (await request(sa, '/media/escape.js')).status, 403);
    checkEqual('a hostile Host cannot reach the handler', (await request(sa, '/health', { host: 'hostile.invalid' })).status, 403);
    checkEqual('listener startup performed no build or voice model work', [ra.voiceCalls.length, rb.voiceCalls.length], [0, 0]);

    suite('P1-07/T12 v1/T47: real authenticated terminal command/output blocks');
    const phone = await makeDevice('Synthetic phone');
    phone.id = sa.devices.add({ name: phone.name, publicKey: phone.publicKey }).id;
    const watcher = await connect(sa, phone); clients.push(watcher);
    check('watch-only device cannot open a shell', /watch/.test((await ask(watcher, { type: 'term:open' }, 'term:no')).reason));
    checkEqual('watch-only device cannot request voice', (await ask(watcher, { type: 'voice', id: 'refused', audio: audio().toString('base64') }, 'voice:no')).code, 'WATCH_ONLY');
    checkEqual('watch-only requests run no command or transcriber', [ra.shellCalls.length, ra.voiceCalls.length], [0, 0]);
    sa.devices.setControl(phone.id, true);
    const phoneClient = await connect(sa, phone); clients.push(phoneClient);
    const opened = await ask(phoneClient, { type: 'term:open', session: a.session.id, cwd: '/untrusted/device/path' }, 'term:opened');
    const id = opened.terminal.id;
    checkEqual('terminal cwd comes from the current session', opened.terminal.cwd, a.home);
    phoneClient.messages = [];
    phoneClient.send({ type: 'term:run', id, command: 'printf fixture' });
    await phoneClient.waitFor('term:began');
    checkEqual('the injected shell receives the same current command contract',
      [ra.shellCalls[0].file, ra.shellCalls[0].args, ra.shellCalls[0].options.cwd, ra.shellCalls[0].options.env.HOME],
      ['/fixture/shell', ['-lc', 'printf fixture'], a.home, a.home]);
    ra.children[0].stdout.emit('data', 'fixture output\n');
    await phoneClient.waitFor('term:out'); ra.children[0].emit('close', 0, null);
    checkEqual('command completion keeps its block, output and exit status',
      (({ output, exit, done }) => ({ output, exit, done }))((await phoneClient.waitFor('term:done')).run),
      { output: 'fixture output\n', exit: 0, done: true });
    checkEqual('reattaching reads command scrollback', (await ask(phoneClient, { type: 'term:attach', id }, 'term:scrollback')).runs[0].command, 'printf fixture');
    const homeTerminal = await ask(phoneClient, { type: 'term:open', cwd: '/untrusted' }, 'term:opened');
    checkEqual('a terminal without an instance uses the explicit home', homeTerminal.terminal.cwd, a.home);
    const localB = await connect(sb); clients.push(localB);
    checkEqual('another engine sees none of these terminals', (await ask(localB, { type: 'term:list' }, 'term:list')).terminals, []);

    suite('P1-07/T47: voice returns reviewable text on fleet and conversation sockets');
    const heard = await ask(phoneClient, { type: 'voice', id: 'draft-one', audio: audio().toString('base64') }, 'voice:text');
    checkEqual('the current reply is draft text with recording correlation', [heard.id, heard.text], ['draft-one', 'Review this draft before sending']);
    const call = ra.voiceCalls.find((c) => c.args[0] === 'transcribe');
    checkEqual('voice audio is private and removed after the runner returns',
      [call.audio.equals(audio()), call.mode, call.folderMode, fs.existsSync(call.args[1]), fs.readdirSync(ra.tmp)], [true, 0o600, 0o700, false, []]);
    checkEqual('voice runners receive the explicit HOME and temporary root', [call.options.env.HOME, call.options.env.TMPDIR], [a.home, ra.tmp]);
    const chat = await connect(sa, phone, a.session); clients.push(chat);
    checkEqual('the real conversation route returns the same draft contract',
      (await ask(chat, { type: 'voice', id: 'chat', audio: audio().toString('base64') }, 'voice:text')).id, 'chat');
    const otherChat = await connect(sb, null, b.session); clients.push(otherChat);
    check('same session IDs in two engines have different hub owners', sa.hubs.hubFor(a.session, a.host) !== sb.hubs.hubFor(b.session, b.host));
    checkEqual('voice never starts or submits to a provider', [a.effects(), b.effects()], [[0, 0], [0, 0]]);
    a.source.values['voice.enabled'] = false;
    checkEqual('voice live disable reports OFF', (await ask(phoneClient, { type: 'voice:state' }, 'voice:state')).code, 'OFF');
    const beforeDisabled = ra.voiceCalls.length;
    checkEqual('disabled recording is refused', (await ask(chat, { type: 'voice', id: 'disabled', audio: audio().toString('base64') }, 'voice:no')).code, 'OFF');
    checkEqual('disabled voice performs no runner work', ra.voiceCalls.length, beforeDisabled);

    suite('P1-07/T05/T47: voice build resources stay inside the selected root');
    const packageRoot = path.join(b.bundle, 'voice');
    fs.mkdirSync(path.join(packageRoot, 'Sources', 'nikui-voice'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'Package.swift'), '// fixture package');
    fs.writeFileSync(path.join(packageRoot, 'Sources', 'nikui-voice', 'main.swift'), '// fixture source');
    const buildCalls = [], buildRoot = path.join(b.home, 'voice-storage');
    const buildResources = createRemoteResources({ home: b.home, voice: {
      dir: buildRoot, tmp: rb.tmp, package: packageRoot, models: path.join(b.home, 'models'),
      platform: 'darwin', arch: 'arm64', enabled: () => true, env: { HOME: b.home, TMPDIR: rb.tmp },
      run: async (file, args, options) => {
        buildCalls.push({ file, args, options });
        if (args.includes('--show-bin-path')) {
          const bin = path.join(buildRoot, 'voice', 'build', 'bin'); fs.mkdirSync(bin, { recursive: true });
          fs.writeFileSync(path.join(bin, 'nikui-voice'), 'fixture output');
          return { ok: true, stdout: bin };
        }
        return { ok: true, stdout: '{"ok":true,"text":"","model":"fixture"}' };
      }
    } });
    checkEqual('an unbuilt transcriber state does not itself compile or discover a model',
      [(await buildResources.voice.state()).needsBuild, buildCalls.length, buildResources.voice.modelPresent()], [true, 0, false]);
    const build = buildResources.voice.ensure();
    check('parallel build requests share one job', build === buildResources.voice.ensure());
    checkEqual('the current compiler path works through the injected runner', await build, true);
    checkEqual('build writes use the explicit storage copy and scratch root',
      buildCalls[0].args.slice(-4), ['--package-path', path.join(buildRoot, 'voice', 'package'), '--scratch-path', path.join(buildRoot, 'voice', 'build')]);
    checkEqual('build and warming leave the bundle and audio root clean',
      [fs.existsSync(path.join(packageRoot, '.build')), fs.readdirSync(rb.tmp), buildResources.voice.isBuilt()], [false, [], true]);
    fs.unlinkSync(buildResources.voice.binary);
    checkEqual('a cold recording can await its own build and warmup without deadlock',
      (await buildResources.voice.transcribe(audio())).text, '');
    await buildResources.voice.dispose();
    const compilerStarted = deferred(), compilerFinished = deferred(), cancelledDir = path.join(b.home, 'cancelled-voice');
    const cancelled = createRemoteResources({ home: b.home, voice: {
      dir: cancelledDir, tmp: rb.tmp, package: packageRoot, models: path.join(b.home, 'models'),
      platform: 'darwin', arch: 'arm64', enabled: () => true, env: { HOME: b.home },
      run: async (_file, _args, options) => { compilerStarted.resolve(options.signal); await compilerFinished.promise; return { ok: true, stdout: '' }; }
    } });
    const cancelledBuild = cancelled.voice.ensure();
    const compilerSignal = await compilerStarted.promise;
    const cancelledClose = cancelled.voice.dispose(); compilerFinished.resolve(); await cancelledClose;
    checkEqual('disposal aborts an in-flight build without installing or retaining its lock',
      [compilerSignal.aborted, await cancelledBuild, fs.existsSync(cancelled.voice.binary), fs.existsSync(path.join(cancelledDir, 'voice', 'building'))], [true, false, false, false]);

    suite('P1-07/T04: borrowed APK subscriptions close independently');
    const apkTimers = clock(); apkTimers.setInterval = apkTimers.setTimeout; apkTimers.clearInterval = apkTimers.clearTimeout;
    const apkResources = createRemoteResources({ home: b.home, timers: apkTimers,
      appUpdate: { file: path.join(b.bundle, 'fixture.apk') } });
    let outsideUpdates = 0;
    const outsideUnwatch = apkResources.appUpdate.watch(() => { outsideUpdates++; });
    const apkServer = createRemote({ root: b.bundle, host: b.host, sessions: { list: () => [], get: () => null },
      resources: apkResources, ownership: { appUpdate: 'borrowed' } });
    servers.push(apkServer); await apkServer.start();
    const apkClient = await connect(apkServer); clients.push(apkClient);
    checkEqual('an absent fixture APK reports the current disabled offer',
      (await ask(apkClient, { type: 'app:update' }, 'app:update')).available, false);
    fs.writeFileSync(apkResources.appUpdate.file, 'synthetic APK'); apkTimers.fire();
    checkEqual('the current APK watcher tells connected viewers', (await apkClient.waitFor('app:update:changed')).type, 'app:update:changed');
    await apkServer.dispose();
    checkEqual('closing a server preserves a borrowed APK owner subscription',
      [apkResources.appUpdate.watchers.size, outsideUpdates], [1, 1]);
    outsideUnwatch();
    checkEqual('the last APK viewer releases its polling resource', apkResources.appUpdate.watching, null);

    suite('P1-07/T04/T07: viewer, listener and owned resource lifetimes are distinct');
    phoneClient.close(); chat.close(); watcher.close();
    await tick();
    checkEqual('closing viewers retains command blocks and both engines', [ra.terminals.list().length, sa.listening, sb.listening], [2, true, true]);
    await sa.stop();
    checkEqual('stopping the listener retains engine-owned blocks', ra.terminals.list().length, 2);
    await sa.start();
    const again = await connect(sa); clients.push(again);
    checkEqual('listener restart preserves current terminal history', (await ask(again, { type: 'term:attach', id }, 'term:scrollback')).runs[0].output, 'fixture output\n');
    const owned = ra.terminals.open({ cwd: a.home }); ra.terminals.run(owned.id, 'owned child');
    await a.engine.dispose(); await a.engine.dispose();
    checkEqual('engine disposal retires its listener, commands, voice and fleet watcher',
      [sa.listening, ra.terminals.list().length, (await ra.voice.state()).code, fleetWatcher, ra.terminals.listeners.size], [false, 0, 'OFF', null, 0]);
    checkEqual('only its owned fixture process is signalled once', ra.children[1].signals, ['SIGTERM']);
    check('a disposed listener refuses resurrection', /closed/.test(await reject(() => sa.start())));
    checkEqual('the other engine remains live after disposal', [sb.listening, (await request(sb, '/health')).status], [true, 200]);

    suite('P1-07/T04/T47: absent and borrowed resources have explicit behavior');
    const disabled = createRemote({ root: b.bundle, host: b.host, sessions: { list: () => [], get: () => null }, resources: {}, ownership: {} });
    servers.push(disabled); await disabled.start();
    const off = await connect(disabled); clients.push(off);
    check('absent terminal refuses rather than constructing a shell', /not offering/.test((await ask(off, { type: 'term:open' }, 'term:no')).reason));
    checkEqual('absent voice reports OFF', (await ask(off, { type: 'voice:state' }, 'voice:state')).code, 'OFF');
    const borrowed = createRemote({ root: b.bundle, host: b.host, sessions: { list: () => [], get: () => null },
      resources: rb, ownership: { terminals: 'borrowed', voice: 'borrowed' } });
    servers.push(borrowed);
    const listenerCount = rb.terminals.listeners.size;
    await borrowed.dispose(); await borrowed.dispose();
    checkEqual('borrowed disposal removes only this server subscription', [rb.terminals.disposed, rb.voice.disposed, rb.terminals.listeners.size], [false, false, listenerCount - 1]);

    suite('P1-07/T04: disposal cancels queued voice without retaining audio');
    const started = deferred(), finish = deferred();
    const pendingResources = createRemoteResources({ home: b.home, voice: {
      dir: null, tmp: rb.tmp, package: path.join(b.bundle, 'voice'), models: path.join(b.home, 'models'),
      binary: path.join(b.bundle, 'transcriber'), platform: 'darwin', arch: 'arm64', enabled: () => true, env: { HOME: b.home },
      run: async (_file, args, options) => {
        if (args[0] === 'transcribe') { started.resolve(options.signal); await finish.promise; }
        return { ok: true, stdout: '{"ok":true,"text":"late"}' };
      }
    } });
    const first = pendingResources.voice.transcribe(audio()).catch((e) => e.code);
    const queued = pendingResources.voice.transcribe(audio()).catch((e) => e.code);
    const signal = await started.promise;
    const closing = pendingResources.voice.dispose();
    checkEqual('owned voice signals cancellation to its runner', signal.aborted, true);
    finish.resolve(); await closing;
    checkEqual('in-flight and queued recordings are refused and cleaned', [await first, await queued, fs.readdirSync(rb.tmp)], ['OFF', 'OFF', []]);
    const checkStarted = deferred(), checkFinished = deferred();
    const probe = createRemoteResources({ home: b.home, voice: {
      dir: null, tmp: rb.tmp, package: path.join(b.bundle, 'voice'), models: path.join(b.home, 'models'),
      binary: path.join(b.bundle, 'transcriber'), platform: 'darwin', arch: 'arm64', enabled: () => true, env: { HOME: b.home },
      run: async (_file, _args, options) => { checkStarted.resolve(options.signal); await checkFinished.promise; return { ok: true, stdout: '{"ok":true}' }; }
    } });
    const probing = probe.voice.state(); const checkSignal = await checkStarted.promise;
    let probeClosed = false;
    const closeProbe = probe.voice.dispose().then(() => { probeClosed = true; }); await tick();
    checkEqual('voice disposal also cancels and awaits an active availability check', [checkSignal.aborted, probeClosed], [true, false]);
    checkFinished.resolve(); await closeProbe;
    checkEqual('a late availability check cannot make disposed voice available', [(await probing).code, probe.voice.running.size], ['OFF', 0]);
    const racing = createRemote({ root: b.bundle, host: b.host, sessions: { list: () => [], get: () => null }, resources: {}, ownership: {} });
    servers.push(racing);
    const binding = racing.start(); await racing.dispose(); await binding;
    checkEqual('disposal during bind cannot leave a listener behind', racing.listening, false);
  } finally {
    for (const client of clients) client.close();
    for (const server of servers.reverse()) await server.dispose();
    for (const engine of engines.reverse()) await engine.dispose();
  }
};
