'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { install } = require('./vscode-stub');
const stub = install();
const checks = [];
const equal = (name, actual, expected) => checks.push([name, actual, expected]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nik-editor-host-'));
const properties = require('../../package.json').contributes.configuration.properties;
const values = {}, scopes = {}, writes = [], calls = [], browserCalls = [], panels = [], dialogs = [];
let tab = false, browser = true, inside = false, binary = false, externalFails = false;
const limits = { current: () => ['fixture-limits'] };

stub.env.sessionId = 'fixture-editor';
stub.workspace.getConfiguration = () => ({
  get: (key, fallback) => key in values ? values[key] : properties['nikui.' + key]?.default ?? fallback,
  inspect: (key) => Object.assign({ defaultValue: properties['nikui.' + key]?.default }, scopes[key]),
  update: async (key, value, target) => { writes.push([key, value, target]); values[key] = value; }
});
stub.workspace.getWorkspaceFolder = () => inside;
stub.workspace.openTextDocument = async (uri) => {
  if (binary) throw new Error('not text');
  calls.push(['read', uri.fsPath]); return { path: uri.fsPath };
};
stub.window.showTextDocument = async (doc, options) => calls.push(['text', doc, options]);
stub.window.setStatusBarMessage = (...args) => calls.push(['status', ...args]);
stub.window.showWarningMessage = async (...args) => { dialogs.push(args); return stub.__answers.shift(); };
stub.env.openExternal = async (uri) => {
  calls.push(['external', String(uri)]);
  if (externalFails) throw new Error('system unavailable');
  return true;
};
stub.window.terminals = [];
stub.window.createTerminal = (options) => {
  calls.push(['terminal', options]);
  const terminal = { name: options.name, show: (...args) => calls.push(['show', ...args]),
    sendText: (...args) => calls.push(['type', ...args]) };
  stub.window.terminals.push(terminal);
  return terminal;
};
const browserOptions = [];
const original = Module._load;
Module._load = function (name, parent) {
  if (parent && parent.filename.endsWith('/src/editorHost.js')) {
    if (name === './browserTab') return { focusOpenTab: async (url) => { browserCalls.push(['focus', url]); return tab; } };
    if (name === './opener') return Object.assign({}, original.apply(this, arguments), {
      openInBrowser: async (file, options) => { browserCalls.push(['browser', file]); browserOptions.push(options); return browser; }
    });
    if (name === './panel') return { SessionPanel: { show: (...args) => {
      panels.push(args); return { focusInput: () => panels.push('focus') };
    } } };
  }
  if (parent && parent.filename.endsWith('/src/host.js') && name === './codexLimits') return { codexLimits: () => limits };
  return original.apply(this, arguments);
};

(async () => {
  try {
    const { createHost, installHost, theHost, forgetHost, describeEnv } = require('../../src/host');
    const { createEditorHost, editorSettings, readConfig } = require('../../src/editorHost');
    const target = { id: 'target' }, cx = { id: 'codex' };
    const manager = { list: [target], get: (id) => id === target.id ? target : null, knownCommands: () => [],
      resumeFromLimit: () => calls.push(['resume-account']) };
    const context = { extension: { packageJSON: { version: '9.9.9' } } };
    const codex = () => ({ list: [cx], get: (id) => id === cx.id ? cx : null });
    const host = createHost(context, manager, { codex });
    const provider = createEditorHost(context, manager, { codex });
    equal('the local provider identity matches panel requester identity', provider.id, stub.env.sessionId);
    equal('the provider reports workspace URIs without converting to paths', provider.workspaces, stub.workspace.workspaceFolders.map((f) => f.uri));
    stub.window.state.focused = false;
    equal('focus follows the actual editor state', provider.focused, false);

    for (const name of ['a.js', 'page.html', 'page.pdf', 'picture.png', 'document.docx', 'unknown.bin']) {
      fs.writeFileSync(path.join(root, name), 'fixture');
    }
    fs.mkdirSync(path.join(root, 'folder'));
    await host.openFile({ path: 'a.js', cwd: root, line: 9 });
    equal('text opens beside the conversation at the same line', calls.splice(0), [
      ['read', path.join(root, 'a.js')], ['text', { path: path.join(root, 'a.js') },
        { selection: { a: 8, b: 0, c: 8, d: 0 }, preview: true, viewColumn: -2 }]
    ]);
    await host.openFile({ path: 'a.js', cwd: root, line: -2 });
    equal('line selection is clamped at zero', calls.pop()[2].selection, { a: 0, b: 0, c: 0, d: 0 });
    calls.length = 0;
    await host.openFile({ path: 'missing', cwd: root });
    equal('missing files keep their status-bar diagnostic', calls.splice(0), [['status', 'NikUI: no such file missing', 4000]]);
    await host.openFile({ path: '  ' });
    equal('empty file requests do nothing', calls.length, 0);
    await host.openFile({ path: 'page.html', cwd: root });
    await host.openFile({ path: 'page.pdf', cwd: root });
    equal('pages and PDFs use the browser adapter', browserCalls.splice(0),
      [['browser', path.join(root, 'page.html')], ['browser', path.join(root, 'page.pdf')]]);
    equal('a successful browser file open needs no system fallback', calls.length, 0);
    browser = false;
    await host.openFile({ path: 'page.html', cwd: root });
    equal('a failed browser file open uses the system URI', calls.splice(0), [['external', 'file://' + path.join(root, 'page.html')]]);
    browserCalls.length = 0;
    await host.openFile({ path: 'document.docx', cwd: root });
    equal('documents keep their system association', calls.splice(0), [['external', 'file://' + path.join(root, 'document.docx')]]);
    await host.openFile({ path: 'folder', cwd: root });
    equal('outside folders are revealed in the OS', stub.__registered.executedWith.pop().slice(0, 1), ['revealFileInOS']);
    inside = true;
    await host.openFile({ path: 'folder', cwd: root });
    equal('workspace folders are revealed in the editor', stub.__registered.executedWith.pop().slice(0, 1), ['revealInExplorer']);
    await host.openFile({ path: 'picture.png', cwd: root });
    const picture = stub.__registered.executedWith.pop();
    equal('pictures use the editor viewer beside the conversation', [picture[0], picture[1].fsPath, picture[2]],
      ['vscode.open', path.join(root, 'picture.png'), { preview: true, viewColumn: -2 }]);
    binary = true;
    await host.openFile({ path: 'unknown.bin', cwd: root });
    equal('unknown binary files fall back to the system', calls.splice(0), [['external', 'file://' + path.join(root, 'unknown.bin')]]);
    externalFails = true;
    await host.openFile({ path: 'unknown.bin', cwd: root });
    equal('a failed binary fallback keeps its status-bar diagnostic', calls.pop(), ['status', 'NikUI: could not open unknown.bin', 3000]);
    calls.length = 0; externalFails = false;

    equal('blank commands do not create a terminal', await host.runInTerminal({ command: '  ' }), false);
    equal('a command is inserted successfully', await host.runInTerminal({ command: '  echo fixture  ', cwd: root, label: 'task' }), true);
    equal('terminal insertion preserves cwd/name/focus and never presses Enter', calls.splice(0), [
      ['terminal', { name: 'NikUI · task', cwd: root }], ['show', true], ['type', 'echo fixture', false]
    ]);
    await host.runInTerminal({ command: 'second', cwd: '/ignored', label: 'task' });
    equal('the matching terminal is reused', calls.splice(0), [['show', true], ['type', 'second', false]]);
    await host.runInTerminal({ command: 'unlabelled' });
    equal('unlabelled terminals keep the same name and default cwd', calls.shift(), ['terminal', { name: 'NikUI' }]);
    calls.length = 0;

    tab = true;
    await host.openUrl('https://example.invalid/existing');
    equal('an existing default-browser tab is focused first', browserCalls.splice(0), [['focus', 'https://example.invalid/existing']]);
    equal('an existing tab does not create another', calls.length, 0);
    tab = false;
    await host.openUrl('https://example.invalid/new');
    equal('URLs otherwise use the default external browser', calls.splice(0), [['external', 'https://example.invalid/new']]);
    tab = 'denied';
    stub.__answers.push('Open Automation settings');
    await host.openUrl('https://example.invalid/denied');
    equal('Automation denial opens the URL then the selected system settings', calls.splice(0), [
      ['external', 'https://example.invalid/denied'], ['external', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation']
    ]);
    equal('the Automation hint keeps its wording and action', dialogs[0], [
      'NikUI opened a new tab because macOS does not let VS Code look at your browser’s tabs. ' +
      'Turn on your browser under Visual Studio Code in Privacy & Security → Automation to go to the open tab instead.',
      'Open Automation settings'
    ]);
    await host.openUrl('https://example.invalid/denied-again');
    equal('the Automation hint appears only once per extension host', dialogs.length, 1);

    calls.length = 0; browserCalls.length = 0; browserOptions.length = 0;
    const oldDialogs = dialogs.length;
    await provider.openUrl('https://example.invalid/v2', { proto: 2 });
    equal('v2 URL dispatch uses only the default external browser', calls.splice(0), [['external', 'https://example.invalid/v2']]);
    equal('v2 URL dispatch never probes browser tabs or opens Automation settings', [browserCalls.length, dialogs.length], [0, oldDialogs]);
    equal('v2 browser failure is explicit', await provider.openFile({ path: 'page.html', cwd: root }, { proto: 2 }), false);
    equal('v2 browser file open never falls back to another application', calls.splice(0), []);
    equal('v2 file opening requires the selected default browser', browserOptions.at(-1).requireDefault, true);
    let failed = false;
    try { await provider.openFile({ path: 'unknown.bin', cwd: root }, { proto: 2 }); } catch (_) { failed = true; }
    equal('v2 ambiguous editor errors do not trigger a system fallback', [failed, calls.splice(0)], [true, []]);
    binary = false;
    const read = stub.workspace.openTextDocument;
    let changed = false;
    stub.workspace.openTextDocument = async (uri) => { const doc = await read(uri); changed = true; return doc; };
    failed = false;
    try { await provider.openFile({ path: 'a.js', cwd: root }, { proto: 2, revalidate: () => { if (changed) throw new Error('source replaced'); } }); }
    catch (_) { failed = true; }
    equal('v2 revalidates after the document read before showing or falling back', [failed, calls.splice(0)], [true, [['read', path.join(root, 'a.js')]]]);
    stub.workspace.openTextDocument = read;

    host.switchTo('target');
    host.switchTo('codex');
    host.switchTo('unknown');
    host.switchTo('target', target);
    equal('switching opens Claude and Codex targets and focuses their input', panels.map((entry) => entry === 'focus' ? entry : entry[0].id),
      ['target', 'focus', 'codex', 'focus']);
    equal('switching retains this window context and manager', panels[0].slice(1), [context, manager]);
    host.openAllSettings();
    equal('all settings keeps its existing command', stub.__registered.executed.pop(), 'nikui.settings');
    calls.length = 0;
    stub.__answers.push('Send now');
    const session = { cwd: root, isPaused: true, resume: () => calls.push(['resume-session']) };
    equal('the composed quota dialog still accepts Send now', await host.confirmPausedSend(session, { local: true, editor: 'fixture-editor' }), true);
    equal('quota confirmation resumes the account and session', calls.splice(0), [['resume-account'], ['resume-session']]);
    equal('the dialog retains its modal flag, detail and choices', dialogs.at(-1), [
      'The usage data says the limit is spent until later.',
      { modal: true, detail: 'Send now if your usage has been reset: every instance resumes and its queue drains. Otherwise it waits in the queue.' },
      'Send now', 'Queue it'
    ]);
    values['remote.requireEncryption'] = false; values['remote.appOnly'] = true;
    const info = describeEnv(context, manager, session);
    equal('environment reporting keeps live reach settings and editor/runtime metadata',
      [info.reach, info.vscode, info.extension, info.codexLimits], [{ sealed: false, appOnly: true }, stub.version, '9.9.9', ['fixture-limits']]);
    values.claudePath = '/fixture/claude';
    equal('the extension-only compatibility reader stays fresh', [readConfig().claudePath, editorSettings().get('claudePath')],
      ['/fixture/claude', '/fixture/claude']);
    scopes.showThinking = { workspaceValue: true };
    await host.setSetting('thinking', false);
    equal('the extension writer preserves workspace configuration scope', writes.pop(), ['showThinking', false, stub.ConfigurationTarget.Workspace]);
    scopes.promptSnippets = { workspaceFolderValue: { custom: 'old' } };
    await host.saveCommand({ was: 'custom', name: 'custom', prompt: 'new' });
    equal('command edits preserve workspace-folder scope', writes.pop(), ['promptSnippets', { custom: 'new' }, stub.ConfigurationTarget.WorkspaceFolder]);
    installHost(host);
    equal('the installed host is reused only by its own manager', theHost(context, manager) === host, true);
    equal('another manager receives its own composed host', theHost(context, {}).manager === manager, false);
    forgetHost();
    equal('forgetHost clears extension installation', theHost(context, manager) === host, false);
    process.stdout.write(JSON.stringify(checks));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
