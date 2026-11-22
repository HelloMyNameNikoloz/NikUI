'use strict';

// Invoked only by acceptance-p2 --native --editor. Each real VS Code window
// has an independent empty profile. Its extension test entry closes its own
// window; neither quit-all nor process-name signalling is permitted.
const fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { privateDirectory, inside, fail } = require('../src/daemonPaths');
const { controlRequest } = require('../src/daemonControl');
const { bounded, editorProcesses, signalExact } = require('./native-command');
const REPO = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ENTRY = String.raw`
'use strict';
const fs = require('fs'), path = require('path'), vscode = require('vscode');
const root = process.env.NIKUI_P2_EDITOR_CONTROL;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
exports.run = async () => {
  try {
    if (!vscode.env.appName.startsWith('Visual Studio Code') || !root || !process.env.HOME.startsWith(root + '/')) throw new Error('ISOLATED_VSCODE_REQUIRED');
    const extension = vscode.extensions.getExtension('nikoloz.nikui');
    if (!extension) throw new Error('DEVELOPMENT_EXTENSION_MISSING');
    const runtime = await extension.activate();
    const deadline = Date.now() + 60000;
    while (!runtime.available && Date.now() < deadline) await wait(100);
    if (runtime.mode !== 'isolated-development-client' || !runtime.available) throw new Error('DEVELOPMENT_EXTENSION_UNAVAILABLE');
    runtime.show('p2-claude');
    fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ version: 1, vscode: vscode.version, appName: vscode.env.appName,
      mode: runtime.mode, extension: extension.id, extensionPath: extension.extensionPath, home: process.env.HOME,
      engineRoot: process.env.NIKUI_ISOLATED_DEV_ROOT, workspace: vscode.workspace.workspaceFolders.map((f) => f.uri.fsPath) }), { mode: 0o600 });
    // A failed controller is bounded too. This test window closes itself after
    // fifteen minutes, even if its parent disappears before writing close.
    const end = Date.now() + 15 * 60 * 1000;
    while (!fs.existsSync(path.join(root, 'close')) && Date.now() < end) await wait(200);
  } catch (error) {
    fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ code: 'EDITOR_TEST_FAILED', reason: error.message }), { mode: 0o600 });
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  }
};
`;
function editorCommand({ code, directory, cwd, development = true }) {
  const executable = fs.realpathSync(code);
  if (!executable.endsWith('/Visual Studio Code.app/Contents/Resources/app/bin/code')) {
    throw fail('REAL_VSCODE_REQUIRED', 'NIKUI_P2_CODE must name the actual Visual Studio Code CLI');
  }
  return { file: executable, args: ['--user-data-dir', path.join(directory, 'user-data'), '--extensions-dir', path.join(directory, 'extensions'),
    '--new-window', '--wait', '--skip-welcome', '--skip-release-notes', '--disable-telemetry',
    // VS Code's extension-test switch avoids its shared OS credential store.
    // This run proves enrollment/control, not editor credential persistence.
    '--use-inmemory-secretstorage', '--password-store=basic', ...(development ? ['--extensionDevelopmentPath', REPO,
    '--extensionTestsPath', path.join(directory, 'entry.cjs')] : []), cwd] };
}
async function launchEditors({ run, paths, status, cwd }) {
  const code = process.env.NIKUI_P2_CODE || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const editors = [];
  async function close() {
    for (const e of editors) fs.writeFileSync(path.join(e.directory, 'close'), '', { mode: 0o600 });
    const results = await Promise.allSettled(editors.map(async (e) => {
      const processes = editorProcesses(path.join(e.directory, 'user-data'), [e.child.pid]);
      try {
        try { await bounded(e.exited, 10000, 'EDITOR_CLEANUP_PENDING'); }
        catch (_) {
          signalExact(processes, 'SIGTERM');
          try { await bounded(e.exited, 3000, 'EDITOR_CLEANUP_PENDING'); }
          catch (_) { signalExact(processes, 'SIGKILL'); await bounded(e.exited, 3000, 'EDITOR_CLEANUP_PENDING'); }
        }
        signalExact(processes, 'SIGTERM'); await delay(250); signalExact(processes, 'SIGKILL');
        if (editorProcesses(path.join(e.directory, 'user-data')).length) throw fail('EDITOR_CLEANUP_PENDING', 'Exact disposable editor cleanup failed');
      } finally { e.child.unref(); fs.closeSync(e.fd); }
    }));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  try {
    const executable = fs.realpathSync(code), app = path.resolve(path.dirname(executable), '../../../..');
    const verified = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8', timeout: 15000 });
    const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8', timeout: 15000 });
    if (verified.status !== 0 || signature.status !== 0 || !/^Identifier=com\.microsoft\.VSCode$/m.test(signature.stderr) ||
      !/Authority=Developer ID Application: Microsoft Corporation /.test(signature.stderr)) {
      throw fail('REAL_VSCODE_SIGNATURE_REQUIRED', 'Use the signed Microsoft Visual Studio Code application');
    }
    for (let i = 0; i < 2; i++) {
      const directory = path.join(run, 'editor-' + (i + 1)); privateDirectory(directory);
      const home = path.join(directory, 'home'); privateDirectory(home); privateDirectory(path.join(home, 'tmp'));
      privateDirectory(path.join(directory, 'extensions')); privateDirectory(path.join(directory, 'user-data'));
      privateDirectory(path.join(directory, 'user-data', 'User'));
      fs.writeFileSync(path.join(directory, 'user-data', 'User', 'settings.json'), JSON.stringify({
        'window.restoreWindows': 'none', 'security.workspace.trust.enabled': false, 'update.mode': 'none',
        'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none', 'files.hotExit': 'off' }), { mode: 0o600 });
      fs.writeFileSync(path.join(directory, 'entry.cjs'), ENTRY, { mode: 0o600 });
      const command = editorCommand({ code, directory, cwd });
      if (!inside(run, directory) || !inside(paths.home, cwd)) throw fail('EDITOR_PROFILE_UNSAFE', 'Test paths required');
      const fd = fs.openSync(path.join(directory, 'vscode.log'), 'w', 0o600);
      const child = spawn(command.file, command.args, { cwd, env: { HOME: home, USERPROFILE: home, ZDOTDIR: home, TMPDIR: path.join(home, 'tmp'),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CODEX_HOME: path.join(home, '.codex-work'),
        NIKUI_ISOLATED_DEV_WINDOW: '1', NIKUI_ISOLATED_DEV_ROOT: paths.root, NIKUI_P2_EDITOR_CONTROL: directory }, stdio: ['ignore', fd, fd] });
      const e = { directory, fd, command, child };
      e.exited = new Promise((resolve, reject) => { e.rejectClose = reject; child.once('exit', (code, signal) => { e.exit = { code, signal }; resolve(); }); child.once('error', reject); });
      // Attach immediately; a CLI failure must not become an unhandled rejection.
      e.exited.catch(() => {}); editors.push(e);
    }
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      for (const e of editors) if (e.exit || fs.existsSync(path.join(e.directory, 'failure.json'))) {
        throw fail('EDITOR_START_FAILED', 'Inspect ' + e.directory + '/vscode.log and failure.json');
      }
      if (editors.every((e) => fs.existsSync(path.join(e.directory, 'ready.json'))) && (await controlRequest(paths, { op: 'status' })).bridge.editors >= 2) break;
      await delay(200);
    }
    const after = await controlRequest(paths, { op: 'status' });
    if (after.bridge.editors < 2 || after.pid !== status.pid || after.generation !== status.generation ||
      !editors.every((e) => fs.existsSync(path.join(e.directory, 'ready.json')))) throw fail('EDITOR_START_TIMEOUT', 'Two test development windows did not enroll');
    return { evidence: editors.map((e) => ({ ...JSON.parse(fs.readFileSync(path.join(e.directory, 'ready.json'), 'utf8')),
      argv: e.command.args, evidence: path.join(e.directory, 'ready.json'), secretStorage: 'in-memory test option; no persistence claim' })), close };
  } catch (error) { await close(); throw error; }
}
module.exports = { launchEditors, editorCommand, ENTRY };
