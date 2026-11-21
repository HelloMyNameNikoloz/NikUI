'use strict';
const path = require('path');
const { install, fakeContext } = require('./vscode-stub');
const stub = install(), checks = [];
const equal = (name, actual, expected) => checks.push([name, actual, expected]);
let engineStarts = 0, keeperStarts = 0, external = 0;
const refuse = () => { external++; throw new Error('No live effects in a development-window fixture'); };
for (const method of ['spawn', 'exec', 'execFile', 'spawnSync', 'execFileSync']) require('child_process')[method] = refuse;
require('net').connect = refuse; require('net').createConnection = refuse; process.kill = refuse;
const engine = require('../../src/extensionEngine');
engine.createWindowEngine = () => { engineStarts++; throw new Error('parallel manager'); };
require('../../src/keeperLink').KeeperLink = class { constructor() { keeperStarts++; throw new Error('parallel keeper'); } };
const development = require('../../src/developmentExtension');
const { activateDevelopment, developmentOptions } = development;
const extension = require('../../src/extension');

(async () => {
  equal('window mode remains the default with no opt-in', developmentOptions(fakeContext(), {}), null);
  let refused;
  try { developmentOptions(fakeContext({ extensionMode: 1 }), { NIKUI_ISOLATED_DEV_WINDOW: '1', NIKUI_ISOLATED_DEV_ROOT: '/private/fixture' }); }
  catch (error) { refused = error.code; }
  equal('production extension host cannot opt itself in', refused, 'ISOLATED_WINDOW_REQUIRED');
  const env = { NIKUI_ISOLATED_DEV_WINDOW: '1', NIKUI_ISOLATED_DEV_ROOT: '/private/fixture' };
  equal('extension-test host (--extensionTestsPath) is an explicit isolated host', developmentOptions(fakeContext({ extensionMode: 3 }), env).root, '/private/fixture');
  equal('development host is an explicit isolated host', developmentOptions(fakeContext({ extensionMode: 2 }), env).root, '/private/fixture');
  for (const extensionMode of [2, 3]) for (const invalid of [
    { NIKUI_ISOLATED_DEV_WINDOW: '1' }, { NIKUI_ISOLATED_DEV_ROOT: '/private/fixture' },
    { ...env, NIKUI_ISOLATED_DEV_ROOT: 'relative/fixture' }
  ]) {
    let code;
    try { developmentOptions(fakeContext({ extensionMode }), invalid); } catch (error) { code = error.code; }
    equal('development/test mode ' + extensionMode + ' still requires both opt-ins and an absolute root ' + JSON.stringify(invalid), code, 'ISOLATED_WINDOW_REQUIRED');
  }
  const links = [], messages = [];
  let offline = false, managementEnabled = false;
  async function connect(options) {
    if (offline) throw Object.assign(new Error('not running'), { code: 'DAEMON_UNAVAILABLE' });
    const link = { options, closed: 0,
      enrollment: { id: 'a'.repeat(32), hostFingerprint: 'private-fingerprint', key: 'secret-not-in-webview',
        ...(managementEnabled ? { localManagement: { version: 1, generation: 'test-generation' } } : {}) },
      send(message) {
        messages.push(message);
        if (message.type === 'hello') queueMicrotask(() => options.onMessage({ type: 'welcome', proto: 2,
          seat: { local: true, editor: true, control: true }, caps: development.CORE || [], receipts: {} }));
        if (message.type === 'ready') queueMicrotask(() => options.onMessage({ type: 'fleet', instances: [{ id: 'fixture', label: 'Fixture', status: 'idle' }], codex: [] }));
        if (message.type === 'local:request') {
          const data = message.op === 'client.state.get' ? { selected: 'fixture', panels: ['fixture'] }
            : message.op === 'client.state.save' ? message.args
              : message.op === 'session.rename' ? { id: message.args.id, name: message.args.name }
                : message.op === 'session.stop' ? { id: message.args.id, retained: true } : {};
          const result = require('../../src/localManagementProtocol').result(message, 'test-generation', { ok: true, outcome: 'applied', data });
          queueMicrotask(() => options.onMessage(result));
        }
      }, close() { this.closed++; options.onClose?.(); } };
    links.push(link); setImmediate(() => options.onMessage({ type: '@welcome', proto: { min: 1, max: 2 } })); return link;
  }
  development.activateDevelopment = (context, options) => activateDevelopment(context, options, { connect });
  process.env.NIKUI_ISOLATED_DEV_WINDOW = '1'; process.env.NIKUI_ISOLATED_DEV_ROOT = '/private/fixture';
  const context = fakeContext({ extensionMode: 3, extensionUri: { fsPath: path.resolve(__dirname, '../..') } });
  const client = await extension.activate(context);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  equal('explicit dev activation builds no window manager or keeper', [engineStarts, keeperStarts], [0, 0]);
  equal('enrolled provider announces real supported methods and URI roots',
    [messages.find((m) => m.type === 'editor:register')?.methods, messages.find((m) => m.type === 'editor:register')?.workspaces],
    [['openFile', 'openUrl', 'runInTerminal', 'switchTo'], stub.workspace.workspaceFolders.map((f) => String(f.uri))]);
  equal('the extension-test host activates and returns an available client', client.available, true);
  await stub.__registered.commands['nikui.restart']({ id: 'fixture' });
  equal('unsupported local management names its P2 blocker', stub.__registered.warnings.at(-1).includes('P2_LOCAL_MANAGEMENT_REQUIRED'), true);
  const panel = client.show('fixture');
  equal('dev conversation uses the full shared page and explicit opt-in', panel.webview.html.includes('panel.js') && panel.webview.html.includes('NIKUI_DEV_BRIDGE'), true);
  equal('editor enrollment key never enters page JavaScript', panel.webview.html.includes('secret-not-in-webview'), false);
  const before = links.length;
  await panel.__onMessage({ type: 'bridge:listen' }); await new Promise((r) => setImmediate(r));
  equal('webview attaches a conversation viewer rather than another engine', [links.length - before, links.at(-1).options.target, engineStarts], [1, 'fixture', 0]);
  links[0].options.onClose();
  equal('daemon disconnect becomes visible without window fallback', [client.available, engineStarts, keeperStarts, panel.webview.posted.at(-1).type], [false, 0, 0, 'bridge:offline']);
  await extension.deactivate();
  equal('extension disposal closes only its bridge clients', links.every((l) => l.closed === 1), true);
  managementEnabled = true;
  const managed = await activateDevelopment(fakeContext({ extensionMode: 2, extensionUri: { fsPath: path.resolve(__dirname, '../..') } }), { root: '/private/fixture' }, { connect });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  equal('managed client restores selected panels without a window engine', [!!managed.show('fixture'), engineStarts, keeperStarts], [true, 0, 0]);
  const input = stub.window.showInputBox; stub.window.showInputBox = async () => 'Renamed locally';
  const renamed = await stub.__registered.commands['nikui.rename']({ id: 'fixture' });
  stub.window.showInputBox = input;
  equal('development rename uses the typed local command bridge', [renamed.ok, messages.findLast((m) => m.type === 'local:request' && m.op === 'session.rename')?.args], [true, { id: 'fixture', name: 'Renamed locally' }]);
  const stopped = await stub.__registered.commands['nikui.sleep']({ id: 'fixture' });
  equal('development process stop is a local management request', [stopped.ok, stopped.data.retained], [true, true]);
  equal('all new local commands carry current generation and version', messages.filter((m) => m.type === 'local:request').every((m) => m.generation === 'test-generation' && m.version === 1), true);
  equal('editor client never puts the local credential into a management request', messages.filter((m) => m.type === 'local:request').some((m) => JSON.stringify(m).includes('secret-not-in-webview')), false);
  managed.dispose(); managementEnabled = false;
  offline = true;
  const missing = await activateDevelopment(fakeContext({ extensionMode: 2 }), { root: '/private/fixture' }, { connect });
  equal('startup with daemon unavailable stays an unavailable client', [missing.available, engineStarts, keeperStarts], [false, 0, 0]); missing.dispose();
  const invalid = fakeContext({ extensionMode: 1 }); await extension.activate(invalid);
  equal('invalid opt-in never falls through to default engine', [engineStarts, keeperStarts], [0, 0]);
  equal('every declared local command has a visible dev-mode handler', require('../../package.json').contributes.commands.every((c) => typeof stub.__registered.commands[c.command] === 'function'), true);
  equal('no real provider, daemon, hardware or network effect was attempted', external, 0);
  delete process.env.NIKUI_ISOLATED_DEV_WINDOW; delete process.env.NIKUI_ISOLATED_DEV_ROOT;
  process.stdout.write(JSON.stringify(checks));
})().catch((error) => { console.error(error); process.exit(1); });
