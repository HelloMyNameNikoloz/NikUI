'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { createMachineHost } = require('../src/machineHost');

function settings(values = {}, declared = {}) {
  return {
    get: (key, fallback) => key in values ? values[key] : fallback,
    inspect: (key) => declared[key] || {},
    update: async (key, value) => { values[key] = value; }
  };
}

module.exports = async function () {
  suite('a machine host loads and exercises lazy paths without VS Code');
  const script = `
    const Module = require('module'); const original = Module._load;
    let attempts = 0;
    Module._load = function (name) {
      if (name === 'vscode') { attempts++; throw new Error('vscode poisoned'); }
      return original.apply(this, arguments);
    };
    (async () => {
      const { createMachineHost } = require(${JSON.stringify(path.resolve(__dirname, '../src/machineHost.js'))});
      const { SessionManager, readConfig } = require(${JSON.stringify(path.resolve(__dirname, '../src/manager.js'))});
      const values = {};
      const source = { get: (k, d) => k in values ? values[k] : d,
        inspect: (k) => ({ defaultValue: {}, globalValue: values[k] }),
        update: async (k, v) => { values[k] = v; } };
      const manager = new SessionManager({ globalState: { get: (k, d) => d } }, { settings: () => source });
      const fallback = new SessionManager({ globalState: { get: (k, d) => d } });
      const host = createMachineHost({ manager, settings: source });
      host.config(); host.knownCommands(); host.fleet(); host.lifetime();
      host.env({ cwd: '/fixture', claudeSessionId: 'fixture' });
      host.settings(); host.commands(); await host.setSetting('thinking', false);
      await host.saveCommand({ name: 'fixture', prompt: 'only a fixture' });
      await host.removeCommand('fixture');
      const actions = [host.openFile({ path: 'a.js', cwd: '/fixture' }), host.openUrl('https://example.invalid'),
        host.runInTerminal({ command: 'never run' }), host.switchTo('fixture'), host.openAllSettings()];
      const paused = await host.confirmPausedSend({ isPaused: true });
      process.stdout.write(JSON.stringify({ attempts, explicit: readConfig(source).showThinking,
        injected: manager.config.claudePath, fallback: fallback.config.claudePath, paused,
        unavailable: actions.every((r) => r.status === 'unavailable'),
        chrome: Object.keys(require.cache).some((p) => /[\\/]editorHost\\.js$|[\\/]host\\.js$/.test(p)) }));
    })().catch((err) => { console.error(err); process.exit(1); });`;
  let loaded;
  try { loaded = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 })); }
  catch (err) { loaded = { error: String(err.stderr || err.message) }; }
  checkEqual('no eager, lazy, caught or fallback resolution reaches the editor', loaded,
    { attempts: 0, explicit: false, injected: 'claude', fallback: 'claude', paused: false, unavailable: true, chrome: false });

  suite('the machine host preserves its surface and captures its own services');
  const valuesA = { claudePath: '/fixture/a', model: 'claude-one', groupByProject: 'always' };
  const valuesB = { claudePath: '/fixture/b' };
  const notes = [], resumes = [];
  const manager = { list: [{ id: 'claude-1' }], knownCommands: () => ['remembered'],
    limits: { spent: true }, pause: { until: 10 }, resumeFromLimit: (opts) => resumes.push(opts) };
  const cx = { id: 'cx-1', loaded: true }, busy = { id: 'cx-2', isBusy: true };
  const codexSession = { id: 'cx-new', submit: (...args) => notes.push(['submit', ...args]) };
  const workspace = { list: [cx, busy, { id: 'cx-unloaded' }],
    create: async (opts) => { notes.push(['create', opts]); return codexSession; } };
  const devices = { list: () => [{ name: 'phone', control: true, lastSeenAt: 1, pairedAt: 2, push: 'token', apns: true }],
    recent: (n) => [n], record: (entry) => notes.push(['audit', entry]) };
  const limits = { current: () => ['limits'] };
  const feed = {}, pickPr = () => {}, setPr = () => {};
  const a = createMachineHost({ manager, settings: settings(valuesA), ledger: { totals: () => ({ cost: 2 }) },
    devices, codex: () => workspace, prFeed: feed, pickPr, setPr,
    env: { home: '/fixture/home', vscode: 'fixture-editor', extension: '1.2.3', codexLimits: limits,
      reach: { sealed: false, appOnly: true }, node: 'fixture-node', electron: 'fixture-electron',
      platform: 'fixture-platform', arch: 'fixture-arch', cpus: 3, memoryGb: 4 } });
  const b = createMachineHost({ settings: settings(valuesB) });
  checkEqual('the existing host surface is unchanged', Object.keys(a).sort(), [
    'manager', 'config', 'home', 'knownCommands', 'fleet', 'lifetime', 'prFeed', 'pickPr', 'setPr', 'env', 'codexLimits',
    'openFile', 'openUrl', 'runInTerminal', 'confirmPausedSend', 'handOffToCodex', 'switchTo', 'audit', 'settings',
    'setSetting', 'openAllSettings', 'commands', 'saveCommand', 'removeCommand', 'restoreCommand', 'prepareEditor'
  ].sort());
  check('the host retains its manager', a.manager === manager);
  checkEqual('known commands come from that manager', a.knownCommands(), ['remembered']);
  checkEqual('the fleet includes only loaded or busy Codex conversations', a.fleet().map((s) => s.id), ['claude-1', 'cx-1', 'cx-2']);
  checkEqual('lifetime comes from the injected ledger', a.lifetime(), { cost: 2 });
  check('the PR feed and callbacks keep their identities', a.prFeed === feed && a.pickPr === pickPr && a.setPr === setPr);
  check('limits use an injected reader rather than a machine singleton', a.codexLimits === limits && b.codexLimits === null);
  valuesA.claudePath = '/fixture/a-changed';
  checkEqual('interleaved settings stay fresh and independent', [a.config().claudePath, b.config().claudePath], ['/fixture/a-changed', '/fixture/b']);
  checkEqual('a host without optional services returns empty values', [b.knownCommands(), b.fleet(), b.lifetime(), b.prFeed, b.pickPr, b.setPr],
    [[], [], null, null, null, null]);
  check('no Codex or devices leaves those methods absent', b.handOffToCodex === undefined && b.audit === undefined);
  const info = a.env({ cwd: '/fixture/work', claudeSessionId: 'conversation' });
  checkEqual('reporting preserves device/trail/reach shaping', [info.devices, info.trail, info.reach], [[{
    name: 'phone', control: true, lastSeenAt: 1, pairedAt: 2, protection: 'software', biometric: false,
    reach: { push: true, apple: true }
  }], [20], { sealed: false, appOnly: true }]);
  checkEqual('reporting uses the injected runtime and account facts', [info.limits, info.pause, info.codexLimits,
    info.vscode, info.node, info.electron, info.platform, info.arch, info.cpus, info.memoryGb, info.extension, info.home, info.groupByProject],
    [manager.limits, manager.pause, ['limits'], 'fixture-editor', 'fixture-node', 'fixture-electron', 'fixture-platform',
      'fixture-arch', 3, 4, '1.2.3', '/fixture/home', 'always']);
  const bare = b.env({ cwd: '/fixture/work', limits: 'session-limits' });
  checkEqual('headless environment has explicit editor and security defaults',
    [bare.vscode, bare.reach, bare.devices, bare.trail, bare.limits, bare.pause, bare.codexLimits, bare.extension],
    [null, { sealed: true, appOnly: false }, [], [], 'session-limits', null, null, null]);
  a.audit({ action: 'fixture' });
  checkEqual('audit writes only through the injected device store', notes.pop(), ['audit', { action: 'fixture' }]);
  checkEqual('Codex handoff returns the new conversation ID', await a.handOffToCodex({ cwd: '/fixture/work', text: 'task' }), 'cx-new');
  checkEqual('Codex handoff keeps the folder, prompt and default attachments', notes.splice(0),
    [['create', { cwd: '/fixture/work' }], ['submit', 'task', []]]);
  const attachments = [{ path: '/fixture/file' }];
  await a.handOffToCodex({ cwd: '/fixture/other', text: 'task two', attachments });
  check('Codex handoff preserves attachment identity', notes[1][2] === attachments);
  let unavailable;
  try { await createMachineHost({ settings: settings(), codex: () => null }).handOffToCodex({}); }
  catch (err) { unavailable = err.message; }
  checkEqual('an unavailable Codex workspace keeps its existing error', unavailable, 'Codex is not available in this window');

  suite('machine editor delegation keeps each operation and requester intact');
  const calls = [];
  const editor = { id: 'origin', focused: false, workspaces: [] };
  for (const method of ['openFile', 'openUrl', 'runInTerminal', 'switchTo', 'openAllSettings']) {
    editor[method] = (...args) => { calls.push([method, ...args]); return method; };
  }
  const direct = createMachineHost({ settings: settings(), editor });
  const requester = Object.freeze({ client: 'panel-1', editor: 'origin', local: true, device: null });
  const file = { uri: 'vscode-remote://host/work/a.js', cwd: 'vscode-remote://host/work', path: 'a.js', line: 23 };
  const terminal = { command: 'never execute this', cwd: '/fixture', label: 'fixture' };
  const from = { id: 'from', cwd: '/fixture' };
  checkEqual('openFile returns its provider result', direct.openFile(file, requester), 'openFile');
  direct.openUrl('https://example.invalid', requester);
  direct.runInTerminal(terminal, requester);
  direct.switchTo('target', from, requester);
  direct.openAllSettings(requester);
  checkEqual('all editor methods receive their original arguments and requester', calls,
    [['openFile', file, requester], ['openUrl', 'https://example.invalid', requester], ['runInTerminal', terminal, requester],
      ['switchTo', 'target', from, requester], ['openAllSettings', requester]]);
  check('file URI/cwd/line and requester are passed by identity', calls[0][1] === file && calls[0][2] === requester);
  direct.runInTerminal(terminal, { local: false, editor: null });
  checkEqual('a direct window provider remains selected even when unfocused', calls.pop()[0], 'runInTerminal');
  checkEqual('an explicit foreign window cannot silently use a direct provider',
    direct.openFile(file, { editor: 'gone' }).reason, 'EDITOR_DISCONNECTED');
  let connected = [editor];
  const routed = createMachineHost({ settings: settings(), editor: { providers: () => connected } });
  routed.openFile(file, requester);
  connected = [];
  const count = calls.length;
  checkEqual('a registry is read afresh and a selected disconnect refuses', routed.openFile(file, requester).reason, 'EDITOR_DISCONNECTED');
  checkEqual('disconnect produces no editor effect', calls.length, count);
  const systemCalls = [];
  const system = createMachineHost({ settings: settings(), env: { openUrl: (...args) => systemCalls.push(args) } });
  system.openUrl('https://example.invalid', { local: false });
  checkEqual('URL fallback uses only the supplied default external opener', systemCalls, [['https://example.invalid', { local: false }]]);
  checkEqual('no provider cannot type into a system terminal', system.runInTerminal(terminal).status, 'unavailable');
  checkEqual('a missing system opener is explicit', b.openUrl('https://example.invalid').reason, 'SYSTEM_OPENER_UNAVAILABLE');
  const bridged = createMachineHost({ settings: settings(), editor: { providers: () => [{
    id: 'bridge', focused: true, methods: ['switchTo'], request: (...args) => args
  }] } });
  checkEqual('a bridge gets the method, full request and requester', bridged.switchTo('target', from, { local: true }),
    ['switchTo', { id: 'target', from, cwd: '/fixture' }, { local: true }]);

  suite('registry requests have bounded results without changing their selected editor');
  const pending = [];
  let dispatches = 0;
  const registry = { timeoutMs: 10, providers: () => [{ id: 'slow', focused: true, methods: ['openFile'],
    request: (...args) => { dispatches++; return new Promise((resolve) => pending.push([resolve, args])); } }, editor] };
  const delayed = createMachineHost({ settings: settings(), editor: registry });
  const timedOut = await delayed.openFile(file, { editor: 'slow' });
  checkEqual('a timed-out selected action reports an unknown outcome',
    [timedOut.status, timedOut.code, timedOut.reason, timedOut.editor, timedOut.outcome],
    ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_TIMEOUT', 'slow', 'unknown']);
  pending[0][0]('late reply');
  checkEqual('a late reply cannot dispatch or reroute the action again', dispatches, 1);
  check('the timeout names the selected editor and preserves uncertainty', /slow/.test(timedOut.message) && /may have completed/.test(timedOut.message));
  const firstWho = Object.freeze({ editor: 'slow', client: 'first' });
  const firstAction = delayed.openFile(file, firstWho);
  const secondWho = Object.freeze({ editor: 'slow', client: 'second' });
  const secondAction = delayed.openFile(terminal, secondWho);
  pending[2][0]('second result'); pending[1][0]('first result');
  checkEqual('reversed completion preserves each bridge result', await Promise.all([firstAction, secondAction]), ['first result', 'second result']);
  check('delayed requests retain their original payload and requester',
    pending[1][1][1] === file && pending[1][1][2] === firstWho && pending[2][1][2] === secondWho);
  const error = new Error('provider failed');
  const failed = createMachineHost({ settings: settings(), editor: { providers: () => [{
    id: 'failed', focused: true, openFile: () => Promise.reject(error)
  }] } });
  let rejection;
  try { await failed.openFile(file); } catch (err) { rejection = err; }
  check('a provider failure is preserved and its deadline cleared', rejection === error);

  suite('quota confirmation and curated settings use injected adapters');
  const prompts = [], toggles = [];
  let answer = 'Queue it';
  const awake = { state: () => ({ supported: true, held: true }),
    set: (on) => toggles.push(['awake', on]), switchLid: (on) => toggles.push(['local-lid', on]),
    setLid: (on) => toggles.push(['lid', on]) };
  const prefValues = { notifyDevices: { failed: true } };
  const preferences = createMachineHost({ manager, settings: settings(prefValues), awake,
    ui: { confirm: (prompt, who) => { prompts.push([prompt, who]); return answer; } } });
  const session = { isPaused: true, resume: () => resumes.push('session') };
  checkEqual('queueing keeps the pause', await preferences.confirmPausedSend(session, requester), false);
  checkEqual('the modal has the original wording and choices', prompts[0], [{
    message: 'The usage data says the limit is spent until later.',
    detail: 'Send now if your usage has been reset: every instance resumes and its queue drains. Otherwise it waits in the queue.',
    choices: ['Send now', 'Queue it']
  }, requester]);
  answer = 'Send now';
  checkEqual('sending now resumes the account and the still-paused session', await preferences.confirmPausedSend(session, requester), true);
  checkEqual('manual resume keeps its original scope', resumes, [{ manual: true }, 'session']);
  checkEqual('a phone cannot raise a machine-policy modal', await preferences.confirmPausedSend(session, { local: false }), false);
  checkEqual('the phone produced no additional prompt', prompts.length, 2);
  checkEqual('no UI safely leaves the quota queued', await a.confirmPausedSend(session, requester), false);
  checkEqual('an unpaused session needs no confirmation', await preferences.confirmPausedSend({ isPaused: false }, requester), false);
  await preferences.setSetting('awake', true, requester);
  await preferences.setSetting('lid', true, requester);
  await preferences.setSetting('lid', false, { local: false });
  checkEqual('power settings keep local setup separate from remote toggles', toggles,
    [['awake', true], ['local-lid', true], ['lid', false]]);
  await preferences.setSetting('thinking', false);
  await preferences.setSetting('notify.needsYou', true);
  checkEqual('ordinary writes use the source and merge notification preferences', prefValues,
    { notifyDevices: { failed: true, needsYou: true }, showThinking: false });
  checkEqual('settings report the awake service state', preferences.settings().rows.find((r) => r.id === 'awake').note, 'Awake now · on');
  let denied;
  try { await preferences.setSetting('claudePath', '/not-allowed'); } catch (err) { denied = err.message; }
  check('the curated write allowlist still rejects executable settings', /not a setting/.test(denied));

  suite('command edits preserve inspection precedence and minimal scoped writes');
  const held = {
    promptSnippets: { defaultValue: { stock: 'shipped' }, globalValue: { global: 'global' },
      workspaceValue: { workspace: 'workspace' }, workspaceFolderValue: { folder: 'folder' } },
    promptSnippetDescriptions: { defaultValue: { stock: 'shipped description' }, workspaceFolderValue: {} }
  };
  const writes = [];
  const commands = createMachineHost({ settings: settings({}, held), writeSetting: async (key, value) => {
    writes.push([key, value]); held[key.replace(/^nikui\./, '')].workspaceFolderValue = value;
  } });
  checkEqual('commands edit the folder value rather than unrelated workspace/global snippets',
    commands.commands().filter((c) => c.kind === 'snippet').map((c) => c.name), ['stock', 'folder']);
  await commands.saveCommand({ was: 'folder', name: 'folder', prompt: 'changed', description: 'a description' });
  checkEqual('saving writes just the two changed keys through the adapter', writes,
    [['nikui.promptSnippets', { folder: 'changed' }], ['nikui.promptSnippetDescriptions', { folder: 'a description' }]]);
  writes.length = 0;
  await commands.saveCommand({ was: 'folder', name: 'folder', prompt: 'changed', description: 'a description' });
  checkEqual('saving an unchanged command writes nothing', writes, []);
  await commands.removeCommand('folder');
  checkEqual('removing a custom command deletes both overrides', writes,
    [['nikui.promptSnippets', {}], ['nikui.promptSnippetDescriptions', {}]]);
  writes.length = 0;
  await commands.removeCommand('stock');
  checkEqual('removing a shipped command disables it', writes, [['nikui.promptSnippets', { stock: '' }]]);
  writes.length = 0;
  await commands.restoreCommand('stock');
  checkEqual('restoring removes only its override', writes, [['nikui.promptSnippets', {}]]);
  delete held.promptSnippets.workspaceFolderValue;
  check('workspace values are next in precedence', commands.commands().some((c) => c.name === 'workspace'));
  delete held.promptSnippets.workspaceValue;
  check('global values follow workspace values', commands.commands().some((c) => c.name === 'global'));
};
