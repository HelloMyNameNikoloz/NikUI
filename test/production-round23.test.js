'use strict';
const fs = require('fs'), path = require('path'), net = require('net'), { fork } = require('child_process');
const { productionFixture } = require('./helpers/production-cutover');
const { inventory, sourceRequest, createLegacyActivation } = require('../src/legacySource');
const { createOwner, atomicJson } = require('../src/engineOwner');
const recovery = require('../src/cutoverRecovery'), legacy = require('../src/legacyExtensionSource');
const { inspectPort, portHolders } = require('../src/cutoverPort');
const { bounded } = require('../scripts/native-command');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const error = async (fn) => { try { await fn(); } catch (e) { return e; } };
const listen = async (server, port = 0) => { await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); return server.address().port; };
const close = async (server) => { if (server.listening) await new Promise(resolve => server.close(resolve)); };

module.exports = async () => {
  suite('R23 lazy source endpoint survives a missed filesystem wake');
  const watch = fs.watch, rename = fs.renameSync, watchers = new Map();
  let woke, firstEvent, lateSource;
  try {
    // Some portable hosts deny FSEvents completely (the source correctly
    // opens an idle socket then). Model a live watcher with one lost event
    // explicitly, so this check exercises the native wake path everywhere.
    fs.watch = (directory, _options, callback) => {
      watchers.set(directory, callback);
      return { on() { return this; }, close() { watchers.delete(directory); } };
    };
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (path.basename(to) === 'review.request' && watchers.has(path.dirname(to))) {
        firstEvent ??= Date.now();
        if (Date.now() - firstEvent >= 150) { woke = true; watchers.get(path.dirname(to))('rename', 'review.request'); }
      }
    };
    lateSource = await productionFixture();
    const started = Date.now(), sources = await inventory(lateSource.directory);
    check('review reissues its wake and receives the selected live source without a permanent source poll',
      woke && sources.length === 1 && Date.now() - started >= 150 && Date.now() - started < 3000);
  } finally { fs.watch = watch; fs.renameSync = rename; await lateSource?.cleanup(); }

  suite('R23 retained native handback: independently cached editor mementos');
  const f = await productionFixture(2);
  try {
    for (const s of f.slots) s.engine.manager.get('session-' + s.i).items.push({ id: 'seed-' + s.i, kind: 'text', text: 'Keep every seed' });
    let staleValues;
    const c = f.coordinator({ async request(source, request) {
      if (request.op === 'source.return.apply' && source.workspace === f.slots[1].project) staleValues = structuredClone(f.global.values);
      if (request.op === 'source.return.resume' && source.workspace === f.slots[1].project) {
        // This host reloads before VS Code has broadcast another host's
        // receipt deletion. Use its independent, stale memento snapshot.
        f.slots[1].original.globalState = { values: staleValues, get: key => staleValues[key], keys: () => Object.keys(staleValues),
          update: async (key, value) => { staleValues[key] = structuredClone(value); } };
      }
      return sourceRequest(source, request);
    } });
    await c.move(await c.review()); await f.start(); await c.finish();
    f.runtime.engine.manager.create({ id: 'app-created-r23', cwd: f.slots[0].project, autoStart: false });
    await f.runtime.currentState.flush(); await c.restore(); await f.stop();
    const b = f.slots[1], key = recovery.pendingKey(b.project), staleReceipt = staleValues[key];
    check('the handback consumed window 2’s payload while another host could still cache its receipt',
      !!staleReceipt && !fs.existsSync(recovery.payloadFile(b.original, b.project)) && fs.existsSync(recovery.deliveredFile(b.original, b.project)));
    let imports = 0;
    check('a stale exact receipt is acknowledged without reading its deleted payload or replaying an import',
      !recovery.pending(b.original, b.project) && !await recovery.deliver({ directory: f.directory, profile: f.profile,
        install: '/fixture/compatible-extension', workspace: b.project, context: b.original, apply: () => { imports++; } }) && imports === 0);
    check('the reloaded second host constructs a usable legacy writer with its current seed transcript',
      b.source.legacy && b.engine.manager.get('session-1').items.some(i => i.id === 'seed-1'));
    check('the first window retains its seed and app-created work, and selected generation accounts are retired',
      f.slots[0].engine.manager.get('session-0').items.some(i => i.id === 'seed-0') &&
      !!f.slots[0].engine.manager.get('app-created-r23') && f.adapter.values.size === 0);
    const next = { profile: f.profile, install: staleReceipt.install, ownerRoot: staleReceipt.ownerRoot,
      generation: staleReceipt.generation + 2, transition: 'e'.repeat(32) };
    const workspaces = { [b.project]: { workspace: b.project, instances: [], sessions: [], projects: [] } };
    await recovery.stage(b.original, next, workspaces);
    const nextReceipt = staleValues[key];
    staleValues[key] = staleReceipt;
    check('an older acknowledged receipt cannot hide a later undelivered payload', recovery.pending(b.original, b.project));
    checkEqual('Forget refuses an old cached receipt before clearing a newer payload', (await error(() =>
      recovery.forget(b.original, b.project, staleReceipt)))?.code, 'RESTORE_SUPERSEDED');
    checkEqual('a stale acknowledgement cannot let staging replace a newer undelivered return',
      (await error(() => recovery.stage(b.original, { ...next, generation: next.generation + 2 }, workspaces)))?.code, 'PENDING_FOLDER_RETURNS');
    staleValues[key] = nextReceipt;
    await recovery.stage(b.original, next, workspaces);
    staleValues[key] = staleReceipt;
    check('a retry with its current receipt preserves the same pending handback',
      JSON.parse(fs.readFileSync(recovery.payloadFile(b.original, b.project))).transition === next.transition);
    await recovery.delivered(b.original, b.project, next);
    staleValues[key] = staleReceipt;
    check('after the later payload is applied, both generations of stale receipts remain acknowledged', !recovery.pending(b.original, b.project));
    staleValues[key] = { ...staleReceipt, transition: 'f'.repeat(32) };
    check('a changed or newer receipt is never suppressed by an older delivery acknowledgement', recovery.pending(b.original, b.project));
    staleValues[key] = undefined;
  } finally { await f.cleanup(); }

  suite('R23 Move retains both the original failure and incomplete recovery');
  const failed = await productionFixture();
  try {
    let refusing = false;
    const c = failed.coordinator({ returnWaitMs: 20,
      sources: (options) => refusing && options?.tolerateUnresponsive ? [] : inventory(failed.directory, options),
      request: (source, request) => {
        if (request.op === 'source.freeze') { refusing = true; return { ok: false, code: 'SOURCE_MANIFEST_INCOMPLETE' }; }
        return sourceRequest(source, request);
      } });
    const result = await error(async () => c.move(await c.review()));
    checkEqual('a slow reload reports the Move error and the Restore error independently',
      [result?.code, result?.diagnostics?.recovery?.code], ['SOURCE_MANIFEST_INCOMPLETE', 'SOURCE_RETURN_TARGET_REQUIRED']);
    const evidence = JSON.parse(fs.readFileSync(path.join(failed.selection.root, 'cutover-diagnostics.json')));
    checkEqual('both codes survive the durable coordinator diagnostics', [evidence.code, evidence.diagnostics.recovery.code],
      ['SOURCE_MANIFEST_INCOMPLETE', 'SOURCE_RETURN_TARGET_REQUIRED']);
    await failed.coordinator().restore();
  } finally { await failed.cleanup(); }

  suite('R23 unauthorized recovery watches only editor-owned authorization');
  const waiting = await productionFixture(); let source;
  try {
    const slot = waiting.slots[0], ownerRoot = path.join(waiting.selection.root, 'o');
    const owner = createOwner({ root: ownerRoot, profile: waiting.profile, install: '/fixture/compatible-extension' }); await owner.initialize();
    const marker = { profile: waiting.profile, install: '/fixture/compatible-extension', ownerRoot, engineRoot: waiting.selection.root,
      fingerprint: require('../src/identity').loadIdentity(waiting.global).fingerprint };
    atomicJson(path.join(waiting.directory, waiting.profile + '.mode'), marker);
    source = createLegacyActivation(slot.original, { home: waiting.home, install: marker.install, workspace: slot.project });
    let reloaded = 0;
    await source.listen({ review: () => ({ ready: false, blockers: [] }), restoreLegacy: () => { reloaded++; } });
    await delay(550);
    check('an untrusted marker and an open owner do not authorize a writer or a reload', source.recovering && reloaded === 0);
    recovery.grant(slot.original, { ...marker, generation: 1 });
    await bounded((async () => { while (!reloaded) await delay(25); })(), 2500);
    check('a later editor-owned grant lets the waiting endpoint observe release and reload itself', reloaded === 1 &&
      fs.existsSync(recovery.completedFile(slot.original)));
  } finally { await source?.dispose(); await waiting.cleanup(); }

  suite('R23 pre-click port ownership and a fixed-port service takeover');
  const p = await productionFixture(), held = net.createServer();
  try {
    const port = await listen(held); p.user['remote.port'] = port;
    const inspect = value => inspectPort(value, () => [{ pid: process.pid, command: 'Selected fixture host' }]);
    const blocked = p.coordinator({ inspectPort: inspect }), review = await blocked.review();
    check('a held port with no selected source listener blocks review before any Move effects', review.blockers.includes('PORT_IN_USE') &&
      review.listener.holders[0].pid === process.pid && !fs.existsSync(p.selection.root));
    checkEqual('a direct Move also refuses the pre-click blocker', (await error(() => blocked.move(review)))?.code, 'PORT_IN_USE');
    const c = p.coordinator({ inspectPort: inspect,
      sources: async (options) => (await inventory(p.directory, options)).map(s => ({ ...s,
        review: { ...s.review, listener: { configuredPort: port, port, listening: held.listening } } })),
      async request(source, request) { if (request.op === 'source.freeze') await close(held); return sourceRequest(source, request); }
    });
    const allowed = await c.review();
    check('an authenticated selected window holding the fixed port is allowed and named', allowed.ready && allowed.listener.takeover && allowed.listener.port === port);
    await c.move(allowed); await p.start(); await c.finish();
    check('the service takes that exact port only after the selected legacy listener releases it', p.runtime.status().listener.port === port && !held.listening);
    await c.restore(); await p.stop();
    check('fixed-port takeover still hands current ownership back to a usable legacy writer', p.slots[0].source.legacy && !!p.slots[0].engine.manager.get('session-0'));
    const parsed = portHolders(port, () => ({ status: 0, stdout: 'p123\ncCode Helper\np456\ncOther\n' }));
    checkEqual('the holder diagnostic preserves PID and command without command arguments', parsed,
      [{ pid: 123, command: 'Code Helper' }, { pid: 456, command: 'Other' }]);
  } finally { await close(held); await p.cleanup(); }

  suite('R23 offline export retains the root lock through window publication');
  const offline = await productionFixture(); let child, done;
  try {
    const c = offline.coordinator(); await c.move(await c.review());
    const script = path.join(offline.home, 'restarting-engine.cjs');
    fs.writeFileSync(script, `
const lock = require(${JSON.stringify(require.resolve('../src/daemonLock'))});
const original = lock.acquireRootLock;
lock.acquireRootLock = async (...args) => {
  process.send({ waiting: true });
  await new Promise(resolve => process.once('message', resolve));
  return original(...args);
};
const { startProductionRuntime } = require(${JSON.stringify(require.resolve('../src/productionRuntime'))});
startProductionRuntime({ selection: JSON.parse(process.argv[2]), secretAdapter: {} }).then(() => process.exit(2),
  error => { process.send({ code: error.code }, () => process.exit(0)); });
`, { mode: 0o600 });
    child = fork(script, [JSON.stringify(offline.selection)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await bounded(new Promise(resolve => child.once('message', resolve)), 5000);
    let restarted;
    const returning = offline.coordinator({ async request(source, request) {
      if (request.op === 'source.return.prepare' && !restarted) {
        const reply = bounded(new Promise(resolve => child.once('message', resolve)), 5000); child.send('continue'); restarted = await reply;
      }
      return sourceRequest(source, request);
    } });
    await returning.restore(); await bounded(done, 5000);
    checkEqual('a restart that passed its initial owner check cannot enter the offline export/publication gap', restarted?.code, 'OWNER_UNAVAILABLE');
    check('offline handback releases its root lock after publishing usable legacy ownership',
      offline.slots[0].source.legacy && !fs.existsSync(path.join(offline.selection.root, 'owner.lock')));
  } finally { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await done; } await offline.cleanup(); }

  suite('R23 a restarting root owner wins safely before offline handback');
  const contender = await productionFixture(); let lease;
  try {
    const c = contender.coordinator(); await c.move(await c.review());
    const paths = require('../src/daemonPaths').privateRoot(contender.selection.root, { create: false });
    lease = await require('../src/daemonLock').acquireRootLock(paths);
    const baseline = JSON.stringify(contender.slots[0].original.workspaceState.values);
    checkEqual('a live restarting root owner refuses the offline reader', (await error(() => c.restore()))?.code, 'OWNER_UNAVAILABLE');
    check('the refused offline return preserves the source memento and the closed service generation',
      JSON.stringify(contender.slots[0].original.workspaceState.values) === baseline &&
      createOwner({ root: c.saved().ownerRoot, profile: contender.profile, install: '/fixture/compatible-extension' }).status().mode === 'service');
    lease.release(); lease = null; await c.restore();
    check('retry after the exact root owner releases its lock restores normally', contender.slots[0].source.legacy);
  } finally { lease?.release(); await contender.cleanup(); }

  suite('R23 legacy listener restoration preserves a second window’s actual fallback port');
  const listeners = await productionFixture(), first = net.createServer(), second = net.createServer();
  const { RemoteServer } = require('../src/remote'), { LocalKey } = require('../src/auth');
  let server;
  try {
    const configuredPort = await listen(first), fallback = await listen(second); await close(second);
    const source = listeners.slots[0].source;
    atomicJson(source.listenerFile, { version: 1, configuredPort, port: fallback, listening: true });
    const notices = [];
    const makeServer = () => new RemoteServer({ root: path.resolve(__dirname, '..'), localKey: new LocalKey(),
      sessions: { list: () => [] }, host: { who: () => null, onFleet: () => () => {} } });
    server = makeServer(); await legacy.startReturnedListener(server, source, configuredPort, message => notices.push(message));
    check('the second window reuses its exported fallback instead of asking for the configured first-window port',
      server.port === fallback && notices.length === 0 && !fs.existsSync(source.listenerFile));
    await server.dispose(); server = null;
    atomicJson(source.listenerFile, { version: 1, configuredPort, port: configuredPort, listening: true });
    server = makeServer(); await legacy.startReturnedListener(server, source, configuredPort, message => notices.push(message));
    check('an occupied handback port visibly names the actual new port and the previous one',
      server.port !== configuredPort && notices.length === 1 && notices[0].includes(String(configuredPort)) && notices[0].includes(String(server.port)));
    const { safeCode, recordFailure } = require('../src/engineStartup');
    require('../src/daemonPaths').privateRoot(listeners.selection.root);
    recordFailure({ selection: listeners.selection }, { code: 'EADDRINUSE', message: 'private provider credentials' });
    const failure = fs.readFileSync(path.join(listeners.selection.root, 'engine-startup-failure.json'), 'utf8');
    check('production startup diagnostics preserve the real code and omit raw error messages', safeCode({ code: 'EADDRINUSE' }) === 'EADDRINUSE' &&
      JSON.parse(failure).code === 'EADDRINUSE' && !failure.includes('credentials') && safeCode({ code: 'raw secret' }) === 'SIGNED_ENGINE_UNAVAILABLE');
  } finally { await server?.dispose(); await close(first); await close(second); await listeners.cleanup(); }
};
