'use strict';
// native: pending Claude run. Signed DEV app + real VS Code source profile,
// using the actual review/Move/handback models. Providers/power are synthetic.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const { build, BASE } = require('./build-mac-app');
const { verify } = require('./verify-mac-app');
const { command, failureEvidence, bounded, editorProcesses } = require('./native-command');
const { privateDirectory, readPrivateJson } = require('../src/daemonPaths');
const { atomicJson } = require('../src/engineOwner');
const LABEL = 'com.nikui.engine.development';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTRY = String.raw`
'use strict';
const fs = require('fs'), path = require('path'), vscode = require('vscode');
const home = process.env.HOME, root = path.join(home, 'profile');
const slot = path.basename(vscode.workspace.workspaceFolders[0].uri.fsPath) === 'project' ? 1 : 2;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
exports.activate = async () => {
  let reloading = false;
  try {
    if (!home.startsWith('/private/tmp/nik-mac/build/p3/') || !vscode.env.appName.startsWith('Visual Studio Code')) throw Error('DISPOSABLE_EDITOR_REQUIRED');
    const extension = vscode.extensions.getExtension('nikoloz.nikui');
    if (!extension) throw Error('SOURCE_EXTENSION_MISSING');
    await extension.activate();
    const seeded = path.join(root, 'source-seeded-' + slot + '.json');
    if (!fs.existsSync(seeded)) {
      await vscode.commands.executeCommand('nikui.__cutoverSeed', slot === 1 ? 'p3-legacy-conversation' : 'p3-second-conversation');
      fs.writeFileSync(seeded, JSON.stringify({ version: 1, home, app: vscode.env.appName, vscode: vscode.version }), { mode: 0o600 });
    }
    const source = require(path.join(extension.extensionPath, 'src/extension'));
    const end = Date.now() + 10 * 60 * 1000;
    while (!fs.existsSync(path.join(root, 'source-close')) && Date.now() < end) {
      const temp = path.join(root, 'source-state-' + slot + '.tmp');
      fs.writeFileSync(temp, JSON.stringify({ ...source.cutoverRehearsalState(), pid: process.pid, slot }), { mode: 0o600 });
      fs.renameSync(temp, path.join(root, 'source-state-' + slot + '.json'));
      const reload = path.join(root, 'source-reload-' + slot);
      if (fs.existsSync(reload) && !fs.existsSync(reload + '.consumed')) {
        fs.writeFileSync(reload + '.consumed', String(process.pid), { mode: 0o600 });
        reloading = true;
        await Promise.race([vscode.commands.executeCommand('workbench.action.reloadWindow'), wait(5000)]);
        return; // The next extension host re-enters this fixture after reload.
      }
      await wait(150);
    }
  } catch (e) {
    // VS Code rejects this very command when it tears down the issuing host.
    // Only our explicitly requested reload may consume that cancellation.
    if (reloading && (e.message === 'Canceled' || e.name === 'Canceled')) return;
    fs.writeFileSync(path.join(root, 'source-failure.json'), JSON.stringify({ code: e.message, slot, pid: process.pid }), { mode: 0o600 });
  } finally {
    if (!reloading) await Promise.race([vscode.commands.executeCommand('workbench.action.closeWindow'), wait(5000)]);
  }
};
`;
function absent() {
  const result = spawnSync('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + LABEL], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  if (result.status !== 113 || !result.stderr.includes('Could not find service "' + LABEL + '"')) throw Error('EXISTING_OR_UNPROVEN_DEVELOPMENT_JOB');
}
async function chooseFixedPort(inspect = require('../src/cutoverPort').inspectPort, candidate = () => crypto.randomInt(49152, 65536)) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = candidate();
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === 4517) continue;
    if ((await inspect(port)).available) return port;
  }
  throw Error('DISPOSABLE_FIXED_PORT_UNAVAILABLE');
}
async function main({ fixedPort = false } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('NATIVE_MAC_REQUIRED');
  absent(); privateDirectory(BASE);
  const home = fs.mkdtempSync(path.join(BASE, 'hB-')), run = fs.mkdtempSync(path.join(BASE, 'cutover-'));
  const app = path.join(run, 'NikUI Dev.app'), root = path.join(home, 'profile'), editor = path.join(home, 'editor');
  const report = { version: 1, ok: false, native: true, run, home, app, fixedPort: 0, checks: {}, cleanup: [] };
  const nonce = crypto.randomBytes(16).toString('hex');
  let executable, config, opened = false;
  const editorExits = [], editorFDs = [], editorChildren = [];
  const env = { HOME: home, USERPROFILE: home, ZDOTDIR: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CODEX_HOME: path.join(home, '.codex-work') };
  async function wait(name, predicate, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (fs.existsSync(path.join(root, 'source-failure.json'))) throw Object.assign(Error('SOURCE_NATIVE_FAILURE'), { diagnostics: readPrivateJson(path.join(root, 'source-failure.json')) });
      if (fs.existsSync(path.join(root, 'mac-cutover-state.json'))) {
        const state = readPrivateJson(path.join(root, 'mac-cutover-state.json'));
        assert.equal(state.nonce, nonce);
        if (state.stage === 'failed') throw Object.assign(Error(state.code), { diagnostics: state });
      }
      if (await predicate()) return;
      await delay(200);
    }
    throw Object.assign(Error('CUTOVER_NATIVE_TIMEOUT'), { diagnostics: { waitingFor: name,
      app: fs.existsSync(path.join(root, 'mac-cutover-state.json')) ? readPrivateJson(path.join(root, 'mac-cutover-state.json')) : null,
      sources: [1, 2].map((slot) => fs.existsSync(path.join(root, 'source-state-' + slot + '.json')) ? readPrivateJson(path.join(root, 'source-state-' + slot + '.json')) : null) } });
  }
  try {
    if (fixedPort) report.fixedPort = await chooseFixedPort();
    assert(Buffer.byteLength(path.join(require('../src/legacySource').sourceDirectory(home), '0'.repeat(16) + '.sock')) < 104);
    build({ flavour: 'dev', output: app, testHome: home, acceptanceCutover: true, version: '0.3.0', buildNumber: '25' });
    config = JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/engine/mac-engine.json')));
    report.verified = verify({ app, flavour: 'dev' }); absent();
    executable = path.join(app, 'Contents/MacOS/NikUI');
    const project = path.join(home, 'project'), secondProject = path.join(home, 'project-2');
    for (const directory of [project, secondProject, editor, path.join(home, '.codex-work'), path.join(home, '.claude/projects'),
      path.join(editor, 'extensions'), path.join(editor, 'user-data/User')]) privateDirectory(directory);
    // A startup observer in this disposable profile runs in both windows.
    // The second CLI request forwards to the first instance, without another
    // extension-test runner competing for the shared user-data directory.
    const extension = path.join(editor, 'extensions/nikoloz.nikui-' + require('../package.json').version); privateDirectory(extension);
    const repo = path.resolve(__dirname, '..');
    for (const name of ['src', 'media', 'package.json']) fs.cpSync(path.join(repo, name), path.join(extension, name), { recursive: true });
    const observer = path.join(editor, 'extensions/nikui.p3-rehearsal-0.0.1'); privateDirectory(observer);
    atomicJson(path.join(observer, 'package.json'), { name: 'p3-rehearsal', publisher: 'nikui', version: '0.0.1',
      engines: { vscode: '^1.85.0' }, main: './entry.cjs', activationEvents: ['onStartupFinished'], extensionDependencies: ['nikoloz.nikui'] });
    fs.writeFileSync(path.join(observer, 'entry.cjs'), ENTRY, { mode: 0o600 });
    atomicJson(path.join(editor, 'user-data/User/settings.json'), {
      'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none',
      'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'telemetry.telemetryLevel': 'off',
      'nikui.keepInstancesAcrossReloads': false, 'nikui.remote.autoStart': fixedPort, 'nikui.remote.tailnet': false,
      'nikui.remote.port': report.fixedPort,
      'nikui.voice.enabled': false, 'nikui.watchCIAfterPush': false, 'nikui.codexPath': path.join(home, 'missing-codex'),
      'nikui.claudePath': path.join(home, 'missing-claude')
    });
    const code = process.env.NIKUI_P2_CODE || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    const cli = require('./acceptance-p2-editor').editorCommand({ code, directory: editor, cwd: project, development: false });
    const editorApp = path.resolve(path.dirname(cli.file), '../../../..');
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', editorApp]);
    const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', editorApp], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assert.match(signature.stderr, /^Identifier=com\.microsoft\.VSCode$/m);
    assert.match(signature.stderr, /Authority=Developer ID Application: Microsoft Corporation /);
    if (fixedPort) {
      report.fixedPortPreflight = await require('../src/cutoverPort').inspectPort(report.fixedPort);
      assert(report.fixedPortPreflight.available, 'PORT_IN_USE: disposable port acquired during build; existing holder left untouched');
    }
    for (const [i, cwd] of [project, secondProject].entries()) {
      const command = require('./acceptance-p2-editor').editorCommand({ code, directory: editor, cwd, development: false });
      const fd = fs.openSync(path.join(run, 'vscode-cli-' + (i + 1) + '.log'), 'w', 0o600); editorFDs.push(fd);
      const child = spawn(command.file, command.args, { cwd,
        env: { ...env, TMPDIR: path.join(home, 'tmp'), NIKUI_P3_LEGACY_REHEARSAL: '1' }, stdio: ['ignore', fd, fd] });
      editorChildren.push(child);
      const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
      exited.catch(() => {}); editorExits.push(exited);
      await wait('legacy seed ' + (i + 1), () => fs.existsSync(path.join(root, 'source-seeded-' + (i + 1) + '.json')));
      await wait('source registration ' + (i + 1), async () =>
        (await require('../src/legacySource').inventory(require('../src/legacySource').sourceDirectory(home))).some((s) => s.workspace === cwd));
    }
    report.sourceInventory = await require('../src/legacySource').inventory(require('../src/legacySource').sourceDirectory(home));
    assert.equal(report.sourceInventory.length, 2);
    absent(); report.checks.legacyStartsWithoutAService = true;
    if (fixedPort) {
      await wait('two legacy listeners including fixed port ' + report.fixedPort, () => {
        const states = [1, 2].map(slot => readPrivateJson(path.join(root, 'source-state-' + slot + '.json')));
        return states.every(s => s.listener?.listening) && states.some(s => s.listener.port === report.fixedPort);
      });
      report.legacyListeners = [1, 2].map(slot => readPrivateJson(path.join(root, 'source-state-' + slot + '.json')).listener);
      report.fixedPortLegacy = await require('../src/cutoverPort').inspectPort(report.fixedPort);
      assert.equal(report.fixedPortLegacy.code, 'PORT_IN_USE');
      assert(report.fixedPortLegacy.holders.length > 0 && report.fixedPortLegacy.holders.every(holder =>
        [1, 2].some(slot => {
          const state = readPrivateJson(path.join(root, 'source-state-' + slot + '.json'));
          return state.pid === holder.pid && state.listener?.listening && state.listener.port === report.fixedPort;
        })), 'The exact disposable legacy extension host must own the fixed port');
      report.checks.fixedPortHeldBySelectedLegacyWindow = true;
    }
    atomicJson(path.join(root, 'mac-cutover-request.json'), { version: 1, nonce, cwd: project });
    atomicJson(path.join(root, 'mac-cutover-reload-request.json'), { nonce });
    command('/usr/bin/open', ['-n', '--env', 'HOME=' + home, app]); opened = true;
    await wait('Move admission barrier', () => fs.existsSync(path.join(root, 'mac-cutover-barrier.json')));
    const oldPID = readPrivateJson(path.join(root, 'source-state-2.json')).pid;
    fs.writeFileSync(path.join(root, 'source-reload-2'), '', { mode: 0o600 });
    await wait('second window reloaded into recovery', () => {
      const state = readPrivateJson(path.join(root, 'source-state-2.json'));
      return state.pid !== oldPID && state.mode === 'recovery';
    });
    report.checks.secondWindowReloadedMidMove = true;
    atomicJson(path.join(root, 'mac-cutover-continue.json'), { nonce });
    await wait('aborted Move before retry', () => readPrivateJson(path.join(root, 'mac-cutover-state.json')).stage === 'aborted');
    await wait('every seed restored in its own legacy window after abort', () => [1, 2].every((slot) => {
      const state = readPrivateJson(path.join(root, 'source-state-' + slot + '.json'));
      const id = slot === 1 ? 'p3-legacy-conversation' : 'p3-second-conversation';
      return state.mode === 'legacy' && state.conversations?.some((session) => session.id === id && session.itemIDs.includes('p3-legacy-text'));
    }));
    report.afterAbort = [1, 2].map((slot) => readPrivateJson(path.join(root, 'source-state-' + slot + '.json')));
    report.checks.everySeedPresentAfterAbort = true;
    atomicJson(path.join(root, 'mac-cutover-abort-verified.json'), { nonce });
    await wait('app cutover and painted source transcript', () => fs.existsSync(path.join(root, 'mac-cutover-state.json')) && readPrivateJson(path.join(root, 'mac-cutover-state.json')).stage === 'cutover');
    report.cutover = readPrivateJson(path.join(root, 'mac-cutover-state.json'));
    assert.equal(report.cutover.sourceTranscriptRendered, true);
    assert.equal(report.cutover.everySourceTranscriptRendered, true);
    await wait('both editor service clients', () => [1, 2].every((slot) => {
      const state = readPrivateJson(path.join(root, 'source-state-' + slot + '.json'));
      return state.mode === 'service-client' && state.available;
    }));
    report.checks.sameSourceAppAndServiceClient = true;
    if (fixedPort) {
      const engine = await require('../src/daemonControl').controlRequest({ socket: path.join(root, 'c.sock') }, { op: 'status' });
      const sources = readPrivateJson(path.join(root, 'cutover-request.json')).sources;
      const review = report.cutover.moveReview;
      assert(review.ready && review.listener.takeover && review.listener.port === report.fixedPort);
      assert(review.listener.holders.length > 0 && review.listener.holders.every(holder => sources.some(source =>
        source.pid === holder.pid && source.review.listener.listening && source.review.listener.port === report.fixedPort)));
      report.checks.reviewAcceptedSelectedLegacyHolder = true;
      assert.equal(engine.listener.port, report.fixedPort);
      report.fixedPortService = await require('../src/cutoverPort').inspectPort(report.fixedPort);
      assert.equal(report.fixedPortService.code, 'PORT_IN_USE');
      assert(report.fixedPortService.holders.length > 0 && report.fixedPortService.holders.every(holder =>
        holder.pid === engine.pid && !sources.some(source => source.pid === holder.pid)));
      report.checks.legacyReleasedAndServiceTookExactPort = true;
      report.checks.serviceTookExactLegacyPort = true;
      report.beforeHandbackListeners = sources.map(source =>
        ({ workspace: source.workspace, port: source.review.listener.port }));
      const health = await fetch('http://127.0.0.1:' + report.fixedPort + '/health', { signal: AbortSignal.timeout(10000) });
      assert.equal(health.status, 200); report.checks.fixedPortServiceHealth = true;
    }
    atomicJson(path.join(root, 'mac-cutover-return.json'), { nonce });
    await wait('native handback/stop/unregister', () => readPrivateJson(path.join(root, 'mac-cutover-state.json')).stage === 'returned');
    report.handback = readPrivateJson(path.join(root, 'mac-cutover-state.json')); absent();
    await wait('current state restored in legacy editor', () => {
      const states = [1, 2].map((slot) => readPrivateJson(path.join(root, 'source-state-' + slot + '.json')));
      return states.every((s, index) => s.mode === 'legacy' && s.conversations?.some((session) =>
        session.id === (index === 0 ? 'p3-legacy-conversation' : 'p3-second-conversation') && session.itemIDs.includes('p3-legacy-text'))) &&
        states.some((s) => s.conversations?.some((s) => s.id === report.cutover.createdAfterCutover));
    });
    assert(!fs.readdirSync(require('../src/legacySource').sourceDirectory(home)).some((name) => name.endsWith('.mode')));
    report.checks.bothLegacyAndModeFileGone = true;
    report.checks.currentStateRestoredAndJobGone = true;
    if (fixedPort) {
      await wait('legacy listener ports restored after fixed-port handback', () => [1, 2].every(slot => {
        const state = readPrivateJson(path.join(root, 'source-state-' + slot + '.json'));
        const workspace = path.join(home, slot === 1 ? 'project' : 'project-2');
        return state.listener?.listening && state.listener.port === report.beforeHandbackListeners.find(source => source.workspace === workspace).port;
      }));
      report.fixedPortReturned = await require('../src/cutoverPort').inspectPort(report.fixedPort);
      assert.equal(report.fixedPortReturned.code, 'PORT_IN_USE');
      assert(report.fixedPortReturned.holders.length > 0 && report.fixedPortReturned.holders.every(holder =>
        [1, 2].some(slot => {
          const state = readPrivateJson(path.join(root, 'source-state-' + slot + '.json'));
          return state.pid === holder.pid && state.mode === 'legacy' && state.listener?.listening && state.listener.port === report.fixedPort;
        })), 'The returned legacy extension host must rebind the same fixed port');
      report.checks.bothActualLegacyPortsRestored = true;
      report.checks.legacyReboundSameFixedPortAndJobGone = true;
    }
    report.ok = true;
  } catch (e) {
    report.failure = failureEvidence(e);
    const diagnostics = path.join(root, 'cutover-diagnostics.json');
    if (fs.existsSync(diagnostics)) report.failure.cutoverDiagnostics = readPrivateJson(diagnostics);
    const journal = path.join(root, 'cutover-request.json');
    if (fs.existsSync(journal)) {
      const state = readPrivateJson(journal);
      report.failure.coordinator = { stage: state.stage, releaseAcknowledged: state.releaseAcknowledged === true };
    }
    const stderr = path.join(home, 'engine.stderr.log');
    if (fs.existsSync(stderr)) report.failure.engineCodes = fs.readFileSync(stderr, 'utf8').split('\n').flatMap((line) => {
      try { const { code, cause } = JSON.parse(line); return code ? [{ code, ...(cause ? { cause } : {}) }] : []; } catch (_) { return []; }
    }).slice(-16);
  }
  finally {
    const cleanup = async (name, action) => { try { await action(); report.cleanup.push({ name, ok: true }); } catch (e) { report.ok = false; report.cleanup.push({ name, ok: false, failure: failureEvidence(e) }); } };
    if (opened) await cleanup('exact app quit', () => command(executable, ['quit-app'], { env }));
    if (editorExits.length) await cleanup('exact editors close themselves', async () => {
      const processes = editorProcesses(path.join(editor, 'user-data'), editorChildren.map((child) => child.pid));
      report.editorProcesses = processes.map(({ pid, parent, proof }) => ({ pid, parent, proof }));
      fs.writeFileSync(path.join(root, 'source-close'), '', { mode: 0o600 });
      try {
        try { await bounded(Promise.all(editorExits), 5000, 'EDITOR_CLEANUP_PENDING'); } catch (_) { /* exact argv teardown below */ }
        report.editorQuit = await require('./native-command').quitDisposableEditor(path.join(editor, 'user-data'), { initial: processes });
        await bounded(Promise.all(editorExits), 3000, 'EDITOR_CLEANUP_PENDING');
        assert.equal(editorProcesses(path.join(editor, 'user-data')).length, 0, 'Exact disposable editor processes must be absent');
      } finally { for (const child of editorChildren) child.unref(); for (const fd of editorFDs) fs.closeSync(fd); }
    });
    if (executable) await cleanup('own development job', async () => {
      const status = JSON.parse(command(executable, ['status'], { env }));
      if (status.control) command(executable, ['intentional-stop'], { env });
      command(executable, ['unregister'], { env }); absent();
    });
    if (config) await cleanup('only minted test Keychain accounts', () => {
      const adapter = require('../src/keychainStore').createSecItemAdapter({ helper: path.join(app, 'Contents/Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'), home, service: config.keychainService });
      for (const file of [path.join(root, 'generation-import.json'), path.join(root, 'o/return/generation-import.json')]) {
        if (!fs.existsSync(file)) continue;
        for (const record of readPrivateJson(file).records) for (const account of [record.account, record.evidenceAccount]) {
          assert.match(account, /^(generation|evidence)\.[a-f0-9]{32}$/); adapter.delete(account); assert.equal(adapter.read(account), null);
        }
      }
      const request = path.join(root, 'cutover-request.json');
      if (fs.existsSync(request)) {
        const transition = readPrivateJson(request).returnTransition;
        if (transition) { assert.match(transition, /^[a-f0-9]{32}$/); adapter.delete('recovery.' + transition); assert.equal(adapter.read('recovery.' + transition), null); }
      }
      command(executable, ['delete-test-client-identity'], { env });
    });
    await cleanup('extension host diagnostics captured', () => {
      const logs = [];
      function collect(directory) {
        if (!fs.existsSync(directory)) return;
        for (const name of fs.readdirSync(directory)) {
          const file = path.join(directory, name), stat = fs.lstatSync(file);
          if (stat.isDirectory()) collect(file);
          else if (stat.isFile() && file.includes('/exthost/') && name.endsWith('.log')) logs.push(file);
        }
      }
      collect(path.join(editor, 'user-data/logs'));
      report.extensionHostLogs = logs;
      fs.writeFileSync(path.join(run, 'vscode.log'), logs.map((file) => '\n--- ' + path.relative(editor, file) + ' ---\n' +
        fs.readFileSync(file, 'utf8').slice(-2 * 1024 * 1024)).join(''), { mode: 0o600 });
      assert(logs.some((file) => file.endsWith('/exthost.log')), 'Extension host log must be retained even on failure');
    });
    atomicJson(path.join(run, 'result.json'), report);
    atomicJson('/private/tmp/nik-mac/p3/r25-native-cutover' + (fixedPort ? '-fixed-port' : '-rehearsal') + '.json', report);
  }
  report.evidence = path.join(run, 'result.json');
  if (!report.ok) process.exitCode = 1;
  return report;
}
module.exports = { main, ENTRY, chooseFixedPort };
if (require.main === module) void require('./native-command').runNative(main);
