'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), net = require('net');
const { startDaemon } = require('../../../src/daemonRuntime');
const { controlRequest } = require('../../../src/daemonControl');
const { matches, resultSchema, requestSchema } = require('../../../src/localManagementProtocol');
const { SETTINGS, IMPORT_BLOCKER, HEARTBEAT_MS, validateSettings } = require('../../../src/menuManagement');
const { until } = require('../../helpers/browser-client');
const base = fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT);
module.exports = async () => {
  suite('P2 R4: private enrolled menu commands and subscription');
  const root = path.join(base, 'menu'); fs.mkdirSync(root, { mode: 0o700 });
  let lookups = 0;
  const adapters = { tools: { knownDirs: [], lookup: async () => { lookups++; return { tools: {}, available: true }; } } };
  let daemon = await startDaemon({ root, adapters }), observer;
  const req = (op, args = {}, generation = daemon.generation) => ({ type: 'local:request', version: 1,
    id: crypto.randomBytes(16).toString('hex'), generation, op, args });
  const call = async (op, args = {}, credential = enrollment, request) => {
    const r = request || req(op, args);
    const reply = await controlRequest(daemon.paths, { op: 'local', id: credential?.id, key: credential?.key, request: r });
    check(op + ' reply matches the published schema', matches(reply, resultSchema)); return reply;
  };
  const enrollment = await controlRequest(daemon.paths, { op: 'enroll', kind: 'local', protocol: 2 });
  try {
    checkEqual('local menu is protocol 2 and has no editor methods', [enrollment.kind, enrollment.protocol, enrollment.editorMethods], ['local', 2, []]);
    check('durable enrollment carries local-management generation', enrollment.localManagement.generation === daemon.generation);
    checkEqual('wrong stored credentials are not replaced with a fresh enrollment',
      (await controlRequest(daemon.paths, { op: 'enroll', kind: 'local', protocol: 2, id: enrollment.id, key: 'wrong' })).code, 'ENROLLMENT_INVALID');
    for (const op of ['menu.snapshot', 'tools.refresh', 'engine.settings.get']) {
      checkEqual(op + ' cannot be reached with a phone or an unenrolled local caller', (await call(op, {}, null)).code, 'LOCAL_AUTHORITY_REQUIRED');
    }
    checkEqual('stale generation cannot query a new boot', (await call('menu.snapshot', {}, enrollment, req('menu.snapshot', {}, 'old'))).code, 'STALE_GENERATION');
    const before = await call('menu.snapshot');
    checkEqual('snapshot reports real generation/version and fixed import blocker',
      [before.data.status.generation, before.data.status.engine.version, before.data.importBlocker], [daemon.generation, require('../../../package.json').version, IMPORT_BLOCKER]);
    checkEqual('listener is loopback and status does not rerun shell lookup', [before.data.status.listener.host, lookups], ['127.0.0.1', 1]);
    check('fleet reuses the engine fleet wire models', Array.isArray(before.data.fleet.instances) && Array.isArray(before.data.fleet.codex));
    check('snapshot does not expose enrollment credentials or private keys', !JSON.stringify(before).includes(enrollment.key) && !JSON.stringify(before).includes('privateKey'));
    checkEqual('unopened settings have defaults and no pending restart', [(await call('engine.settings.get')).data.requiresRestart, before.data.settings.port, before.data.settings.bind], [false, 0, '127.0.0.1']);
    await call('tools.refresh');
    checkEqual('Refresh tools explicitly performs one new resolver lookup', lookups, 2);
    checkEqual('heartbeat is a quiet 25 seconds', HEARTBEAT_MS, 25000);
    const frames = []; let buffer = '';
    observer = net.createConnection({ path: daemon.paths.socket });
    observer.setEncoding('utf8'); observer.on('error', () => {});
    observer.on('data', (data) => { buffer += data; let at; while ((at = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); } });
    await new Promise((resolve) => observer.once('connect', resolve));
    observer.write(JSON.stringify({ op: 'menu-observe', id: enrollment.id, key: enrollment.key, generation: daemon.generation }) + '\n');
    await until(() => frames.length > 0, 'initial menu snapshot');
    checkEqual('subscription immediately sends a versioned snapshot', [frames[0].type, frames[0].version], ['menu:snapshot', 1]);
    checkEqual('control status proves a menu observer is connected', daemon.status().localManagement.menuObservers, 1);
    const instance = daemon.engine.manager.create({ cwd: daemon.paths.home, autoStart: false, title: 'Private instance title' });
    await until(() => frames.some((f) => f.data?.fleet.instances.some((r) => r.id === instance.id)), 'fleet event pushed');
    check('fleet changes push status without waiting for the heartbeat', frames.length >= 2);
    const shell = await new Promise((resolve, reject) => {
      require('http').get({ host: '127.0.0.1', port: daemon.engine.remote.port, path: '/s/' + instance.id }, (response) => {
        let text = ''; response.setEncoding('utf8'); response.on('data', (c) => { text += c; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      }).on('error', reject);
    });
    checkEqual('Open in browser can serve the actual generation-prefixed instance ID', shell.status, 200);
    check('browser shell retains that exact instance target', shell.text.includes(instance.id));
    const settings = before.data.settings;
    const executable = path.join(daemon.paths.home, 'fixture-claude'); fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const changed = { ...settings, tools: { ...settings.tools, claude: executable }, codexHome: path.join(daemon.paths.home, 'menu-account'), port: 0 };
    const savedRequest = req('engine.settings.update', changed);
    check('atomic settings request has an operation-specific schema', matches(savedRequest, requestSchema));
    const saved = await call('engine.settings.update', {}, enrollment, savedRequest);
    checkEqual('settings commit advances the revision and stages a restart', [saved.ok, saved.data.settings.revision, saved.data.requiresRestart], [true, 1, true]);
    checkEqual('retrying the same local intent returns its committed result without a second write', await call('engine.settings.update', {}, enrollment, savedRequest), saved);
    checkEqual('concurrent stale settings cannot overwrite the new revision', (await call('engine.settings.update', changed)).code, 'STALE_SETTINGS');
    checkEqual('running account stays unchanged until explicit restart', daemon.status().account.home, settings.codexHome);
    for (const [change, expected] of [
      [{ port: 65536 }, 'BAD_LOCAL_REQUEST'], [{ port: -1 }, 'BAD_LOCAL_REQUEST'], [{ bind: '0.0.0.0' }, 'BIND_LOOPBACK_REQUIRED'],
      [{ codexHome: '/Users/live/.codex' }, 'CODEX_HOME_OUTSIDE_TEST_PROFILE'],
      [{ codexHome: path.join(daemon.paths.home, '../escape') }, 'CODEX_HOME_OUTSIDE_TEST_PROFILE'],
      [{ tools: { ...settings.tools, claude: 'claude' } }, 'TOOL_PATH_INVALID'],
      [{ tools: { ...settings.tools, codex: '/missing/tool' } }, 'TOOL_PATH_INVALID'],
      [{ extraSecret: 'must-not-echo' }, 'BAD_LOCAL_REQUEST']
    ]) {
      const reply = await call('engine.settings.update', { ...changed, revision: 1, ...change });
      checkEqual('invalid setting is refused: ' + expected, reply.code, expected);
      check('refusal never echoes values or secret-bearing errors', !JSON.stringify(reply).includes('must-not-echo'));
    }
    const alias = path.join(daemon.paths.home, 'account-symlink'); fs.symlinkSync(daemon.paths.state, alias);
    checkEqual('symlinked account home is refused', (await call('engine.settings.update', { ...changed, revision: 1, codexHome: alias })).code, 'UNSAFE_PATH');
    fs.unlinkSync(alias);
    let pinnedCode;
    try { validateSettings({ ...changed, tools: { ...changed.tools, node: executable } }, { home: daemon.paths.home, pinnedNode: '/bundle/node' }); }
    catch (e) { pinnedCode = e.code; }
    checkEqual('bundled Node cannot be replaced by an override', pinnedCode, 'BUNDLED_NODE_PINNED');
    checkEqual('all refusals preserved the last complete settings snapshot', daemon.graph.authority.snapshot().values[SETTINGS], saved.data.settings);
    observer.destroy(); observer = null;
    await until(() => daemon.status().localManagement.menuObservers === 0, 'menu disconnect');
    checkEqual('quitting only the menu leaves engine and listener alive', [(await controlRequest(daemon.paths, { op: 'status' })).state, daemon.engine.remote.listening], ['running', true]);
    await daemon.stop(); daemon = await startDaemon({ root, adapters });
    checkEqual('explicit restart uses staged private Codex account home', daemon.status().account.home, changed.codexHome);
    checkEqual('explicit restart uses staged executable override', daemon.status().tools.claude.path, executable);
    checkEqual('durable enrollment is reused across engine boots', (await controlRequest(daemon.paths, { op: 'enroll', kind: 'local', protocol: 2, id: enrollment.id, key: enrollment.key })).id, enrollment.id);
    checkEqual('settings no longer require restart after boot', (await call('engine.settings.get')).data.requiresRestart, false);
  } finally { observer?.destroy(); await daemon.stop(); }
};
