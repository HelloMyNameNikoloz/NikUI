'use strict';
// native: pending Claude run. Signed DEV app + real VS Code source profile,
// using the actual review/Move/handback models. Providers/power are synthetic.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const { build, BASE } = require('./build-mac-app');
const { verify } = require('./verify-mac-app');
const { command, failureEvidence, bounded, editorProcesses, developmentJobExists, cleanupDevelopmentJob } = require('./native-command');
const { privateDirectory, readPrivateJson } = require('../src/daemonPaths');
const { atomicJson } = require('../src/engineOwner');
const LABEL = 'com.nikui.engine.development';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function legacyFixtureSpawner(link, env) {
  const spawn = link.spawner();
  return (cmd, args, options, session) => spawn(cmd, args, { ...options, env: { ...options.env, ...env } }, session);
}
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
      await vscode.commands.executeCommand('nikui.__cutoverSeed', slot === 1 ? 'p3-legacy-conversation' : 'p3-second-conversation',
        slot === 1 && fs.existsSync(path.join(root, 'legacy-continuity.json')));
      if (slot === 1 && fs.existsSync(path.join(root, 'legacy-continuity.json'))) {
        const source = require(path.join(extension.extensionPath, 'src/extension'));
        const deadline = Date.now() + 20000;
        while (!source.cutoverRehearsalState().listener?.listening && Date.now() < deadline) await wait(50);
        // The fixture explicitly records the preconfigured fake route. A
        // default-on setting must never create a root in the background.
        await vscode.commands.executeCommand('nikui.recordPhoneRoute');
      }
      fs.writeFileSync(seeded, JSON.stringify({ version: 1, home, app: vscode.env.appName, vscode: vscode.version }), { mode: 0o600 });
    }
    const source = require(path.join(extension.extensionPath, 'src/extension'));
    const bridge = { build: require(path.join(extension.extensionPath, 'src/legacySource')).SOURCE_BUILD,
      extension: fs.realpathSync(extension.extensionPath),
      hashes: Object.fromEntries(['legacySource.js', 'legacyExtensionSource.js', 'sourceWindowInventory.js'].map(name =>
        [name, require('crypto').createHash('sha256').update(fs.readFileSync(path.join(extension.extensionPath, 'src', name))).digest('hex')])) };
    const end = Date.now() + 10 * 60 * 1000;
    while (!fs.existsSync(path.join(root, 'source-close')) && Date.now() < end) {
      const temp = path.join(root, 'source-state-' + slot + '.tmp');
      fs.writeFileSync(temp, JSON.stringify({ ...source.cutoverRehearsalState(), bridge, pid: process.pid, slot }), { mode: 0o600 });
      fs.renameSync(temp, path.join(root, 'source-state-' + slot + '.json'));
      const reload = path.join(root, 'source-reload-' + slot);
      if (slot === 1 && fs.existsSync(path.join(root, 'source-restart-run')) && !fs.existsSync(path.join(root, 'source-restart-run.done'))) {
        await vscode.commands.executeCommand('nikui.__cutoverRestartRun');
        fs.writeFileSync(path.join(root, 'source-restart-run.done'), '', { mode: 0o600 });
      }
      if (slot === 1 && fs.existsSync(path.join(root, 'source-finish-run')) && !fs.existsSync(path.join(root, 'source-finish-run.done'))) {
        await vscode.commands.executeCommand('nikui.__cutoverFinishRun');
        fs.writeFileSync(path.join(root, 'source-finish-run.done'), '', { mode: 0o600 });
      }
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
    fs.writeFileSync(path.join(root, 'source-failure.json'), JSON.stringify({ code: e.code || e.message, message: e.message,
      stack: e.stack, operation: e.operation || 'source fixture', path: e.path || root, slot, pid: process.pid }), { mode: 0o600 });
  } finally {
    if (!reloading) await Promise.race([vscode.commands.executeCommand('workbench.action.closeWindow'), wait(5000)]);
  }
};
`;
function absent() {
  if (developmentJobExists()) throw Error('EXISTING_OR_UNPROVEN_DEVELOPMENT_JOB');
}
async function chooseFixedPort(inspect = require('../src/cutoverPort').inspectPort, candidate = () => crypto.randomInt(49152, 65536)) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = candidate();
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === 4517) continue;
    if ((await inspect(port)).available) return port;
  }
  throw Error('DISPOSABLE_FIXED_PORT_UNAVAILABLE');
}
async function main({ fixedPort = false, legacyContinuity = false, neverExiting = false, rescueContinuity = false } = {}) {
  if (legacyContinuity) fixedPort = true;
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('NATIVE_MAC_REQUIRED');
  absent(); privateDirectory(BASE);
  const home = fs.mkdtempSync(path.join(BASE, 'hB-')), run = fs.mkdtempSync(path.join(BASE, 'cutover-'));
  const app = path.join(run, 'NikUI Dev.app'), root = path.join(home, 'profile'), editor = path.join(home, 'editor');
  const report = { version: 1, ok: false, native: true, run, home, app, fixedPort: 0, legacyContinuity, neverExiting, rescueContinuity, checks: {}, cleanup: [] };
  const nonce = crypto.randomBytes(16).toString('hex');
  let executable, config, opened = false;
  let operation = 'prepare cutover fixture';
  const editorExits = [], editorFDs = [], editorChildren = [];
  let legacyLink, legacySession, legacyFacts;
  const env = { HOME: home, USERPROFILE: home, ZDOTDIR: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CODEX_HOME: path.join(home, '.codex-work') };
  async function wait(name, predicate, timeout = 90000) {
    operation = name;
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
    throw Object.assign(Error('CUTOVER_NATIVE_TIMEOUT'), { code: 'CUTOVER_NATIVE_TIMEOUT', operation: name, path: root, diagnostics: { waitingFor: name,
      app: fs.existsSync(path.join(root, 'mac-cutover-state.json')) ? readPrivateJson(path.join(root, 'mac-cutover-state.json')) : null,
      sources: [1, 2].map((slot) => fs.existsSync(path.join(root, 'source-state-' + slot + '.json')) ? readPrivateJson(path.join(root, 'source-state-' + slot + '.json')) : null) } });
  }
  try {
    if (fixedPort) report.fixedPort = await chooseFixedPort();
    assert(Buffer.byteLength(path.join(require('../src/legacySource').sourceDirectory(home), '0'.repeat(16) + '.sock')) < 104);
    build({ flavour: 'dev', output: app, testHome: home, acceptanceCutover: true, ...require('../package.json').macApp });
    config = JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/engine/mac-engine.json')));
    report.verified = verify({ app, flavour: 'dev' }); absent();
    assert.equal(report.verified.build, require('../package.json').macApp.buildNumber);
    report.checks.currentBuildVersion = true;
    executable = path.join(app, 'Contents/MacOS/NikUI');
    const project = path.join(home, 'project'), secondProject = path.join(home, 'project-2');
    for (const directory of [project, secondProject, editor, path.join(home, '.codex-work'), path.join(home, '.claude/projects'),
      path.join(editor, 'extensions'), path.join(editor, 'user-data/User')]) privateDirectory(directory);
    if (legacyContinuity) {
      const fixture = path.join(__dirname, '../test/fixtures/keepers'), bin = path.join(home, 'fixture-bin'); privateDirectory(bin);
      const cli = (name, source) => fs.writeFileSync(path.join(home, name), fs.readFileSync(path.join(fixture, source), 'utf8')
        .replace('#!/usr/bin/env node', '#!' + process.execPath), { mode: 0o700 });
      cli('fixture-bin/tailscale', 'fake-tailscale.js'); cli('fixture-claude', neverExiting ? 'never-exiting-claude.js' : 'streaming-claude.js');
      env.PATH = bin + ':' + env.PATH;
      env.NIKUI_R27_TAILSCALE_CONFIG = path.join(home, 'routes.json'); env.NIKUI_R27_TAILSCALE_LOG = path.join(home, 'route-calls.jsonl');
      env.FAKE_LOG = path.join(home, 'legacy-inputs.jsonl'); env.FAKE_SESSION_ID = 'r27-native-conversation';
      const config = require('../test/production-round27.test').multiRoutes(report.fixedPort);
      fs.writeFileSync(env.NIKUI_R27_TAILSCALE_CONFIG, JSON.stringify(config), { mode: 0o600 });
      const dir = path.join(home, 'Library/Application Support/NikUI/keeper');
      report.custodyDirectories = [dir];
      legacyLink = new (require('../src/keeperLink').KeeperLink)({ dir, source: path.join(fixture, 'keeper-d7129af02c46.js'), env });
      legacySession = new (require('../src/session').Session)({ id: 'p3-legacy-conversation', cwd: project,
        claudePath: path.join(home, 'fixture-claude'), spawner: legacyFixtureSpawner(legacyLink, env), maxItems: 0 });
      legacySession.items.push({ kind: 'text', id: 'p3-legacy-text', text: 'Transcript seeded in the real legacy VS Code context.' });
      legacySession.send('Keep this single turn streaming through Move and Restore.');
      await wait('disposable legacy keeper stream', () => legacySession.proc?.pid && legacySession.items.some((i) => /w3 /.test(i.text || '')));
      assert(fs.existsSync(env.FAKE_LOG), 'The original child must receive the fixture log environment before Move');
      report.originalKeeper = { pid: legacyLink.keeperPid, childPID: legacySession.proc.pid, runID: legacySession.proc.runId };
      legacyFacts = await require('../src/keeperContinuity').processSnapshot([legacyLink.keeperPid, legacySession.proc.pid]);
      assert.equal(legacyFacts.size, 2);
      legacySession.detach(); await legacyLink.close();
      atomicJson(path.join(root, 'legacy-continuity.json'), report.originalKeeper);
    }
    // A startup observer in this disposable profile runs in both windows.
    // The second CLI request forwards to the first instance, without another
    // extension-test runner competing for the shared user-data directory.
    const extension = path.join(editor, 'extensions/nikoloz.nikui-' + require('../package.json').version); privateDirectory(extension);
    const repo = path.resolve(__dirname, '..');
    for (const name of ['src', 'media', 'package.json']) fs.cpSync(path.join(repo, name), path.join(extension, name), { recursive: true });
    const bridgeHashes = Object.fromEntries(['legacySource.js', 'legacyExtensionSource.js', 'sourceWindowInventory.js'].map(name =>
      [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'src', name))).digest('hex')]));
    const verifyBridges = async (stage) => {
      let inventory;
      await wait('both current source bridges and complete editor inventory: ' + stage, async () => {
        inventory = await require('../src/legacySource').inventory(require('../src/legacySource').sourceDirectory(home));
        report.sourceBridgeEvidence ||= {};
        report.sourceBridgeEvidence[stage] = inventory;
        if (inventory.length !== 2) return false;
        return [1, 2].every(slot => {
          const file = path.join(root, 'source-state-' + slot + '.json');
          if (!fs.existsSync(file)) return false;
          const state = readPrivateJson(file), descriptor = inventory.find(s => s.pid === state.pid);
          assert.equal(state.bridge?.extension, fs.realpathSync(extension));
          assert.equal(state.bridge?.build, require('../src/legacySource').SOURCE_BUILD);
          assert.deepEqual(state.bridge?.hashes, bridgeHashes);
          return descriptor?.build === state.bridge.build && descriptor.review.hostInventory?.complete === true &&
            descriptor.review.hostInventory.windows === 2 && descriptor.review.hostInventory.pids.length === 2 &&
            inventory.every(s => descriptor.review.hostInventory.pids.includes(s.pid));
        });
      });
      report.checks['bothCurrentSourceBridges-' + stage] = true;
    };
    const observer = path.join(editor, 'extensions/nikui.p3-rehearsal-0.0.1'); privateDirectory(observer);
    atomicJson(path.join(observer, 'package.json'), { name: 'p3-rehearsal', publisher: 'nikui', version: '0.0.1',
      engines: { vscode: '^1.85.0' }, main: './entry.cjs', activationEvents: ['onStartupFinished'], extensionDependencies: ['nikoloz.nikui'] });
    fs.writeFileSync(path.join(observer, 'entry.cjs'), ENTRY, { mode: 0o600 });
    atomicJson(path.join(editor, 'user-data/User/settings.json'), {
      'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none',
      'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'telemetry.telemetryLevel': 'off',
      'nikui.keepInstancesAcrossReloads': legacyContinuity, 'nikui.remote.autoStart': fixedPort, 'nikui.remote.tailnet': legacyContinuity,
      'nikui.remote.port': report.fixedPort,
      'nikui.voice.enabled': false, 'nikui.watchCIAfterPush': false, 'nikui.codexPath': path.join(home, 'missing-codex'),
      'nikui.claudePath': path.join(home, legacyContinuity ? 'fixture-claude' : 'missing-claude')
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
    async function openEditor(i, cwd, suffix = '') {
      const command = require('./acceptance-p2-editor').editorCommand({ code, directory: editor, cwd, development: false });
      const fd = fs.openSync(path.join(run, 'vscode-cli-' + (i + 1) + suffix + '.log'), 'w', 0o600); editorFDs.push(fd);
      const child = spawn(command.file, command.args, { cwd,
        env: { ...env, TMPDIR: path.join(home, 'tmp'), NIKUI_P3_LEGACY_REHEARSAL: '1' }, stdio: ['ignore', fd, fd] });
      editorChildren.push(child);
      const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
      exited.catch(() => {}); editorExits.push(exited);
      await wait('legacy seed ' + (i + 1), () => fs.existsSync(path.join(root, 'source-seeded-' + (i + 1) + '.json')));
      await wait('source registration ' + (i + 1), async () =>
        (await require('../src/legacySource').inventory(require('../src/legacySource').sourceDirectory(home))).some((s) => s.workspace === cwd));
    }
    for (const [i, cwd] of [project, secondProject].entries()) await openEditor(i, cwd);
    await verifyBridges('initial');
    report.sourceInventory = await require('../src/legacySource').inventory(require('../src/legacySource').sourceDirectory(home));
    assert.equal(report.sourceInventory.length, 2);
    if (legacyContinuity) {
      await wait('original kept child in the disposable source', () => readPrivateJson(path.join(root, 'source-state-1.json')).conversations?.some((s) =>
        s.id === 'p3-legacy-conversation' && s.childPID === report.originalKeeper.childPID && s.runID === report.originalKeeper.runID && /w3 /.test(s.streamText)));
      await wait('recorded fake tailnet root owned by selected source', async () => (await require('../src/legacySource').inventory(require('../src/legacySource').sourceDirectory(home)))
        .some((s) => s.review.routes?.some((r) => r.localPort === report.fixedPort)));
      report.originalRoutes = fs.readFileSync(env.NIKUI_R27_TAILSCALE_CONFIG, 'utf8');
      assert.equal(JSON.parse(report.originalRoutes).Web['fixture.tail123.ts.net:443'].Handlers['/'].Proxy, 'http://127.0.0.1:' + report.fixedPort);
      report.checks.realLegacyBuildAndFakeTailnetArePresent = true;
    }
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
    absent(); opened = true; // A lost launch reply must still trigger owned-job cleanup.
    command('/usr/bin/open', ['-n', '--env', 'HOME=' + home, app]);
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
    if (fixedPort) {
      assert.deepEqual(report.afterAbort.map((s) => s.listener.port), report.legacyListeners.map((s) => s.port),
        'Reload before freeze must restore each actual listener; a fallback window cannot take the phone route’s fixed port');
      report.checks.reloadBeforeFreezePreservesEveryListener = true;
    }
    if (legacyContinuity) {
      assert(report.afterAbort[0].conversations.some((s) => s.runID === report.originalKeeper.runID && s.childPID === report.originalKeeper.childPID));
      assert.equal(fs.readFileSync(env.NIKUI_R27_TAILSCALE_CONFIG, 'utf8'), report.originalRoutes);
      report.checks.reloadAndAbortKeepTheOriginalRunAndRoute = true;
    }
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
      if (legacyContinuity) {
        assert(engine.keeper.runs.some((s) => s.runID === report.originalKeeper.runID && s.childPID === report.originalKeeper.childPID &&
          s.directory === path.join(home, 'Library/Application Support/NikUI/keeper')));
        assert.equal(report.cutover.keptStreamRendered, true);
        assert.equal(fs.readFileSync(env.NIKUI_R27_TAILSCALE_CONFIG, 'utf8'), report.originalRoutes);
        report.checks.moveKeepsTheOriginalKeeperChildAndStream = true;
      }
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
      if (legacyContinuity) {
        const phone = await fetch('http://127.0.0.1:' + report.fixedPort + '/health', {
          headers: { Host: 'fixture.tail123.ts.net' }, signal: AbortSignal.timeout(10000) });
        assert.equal(phone.status, 200); report.checks.engineAcceptsTheSameTailnetHost = true;
      }
    }
    if (rescueContinuity) {
      command(executable, ['intentional-stop'], { env });
      const rescueSocket = path.join(home, 'Library/Application Support/NikUI/keeper/r1.sock');
      const rescue = () => require('../src/daemonControl').controlRequest({ socket: rescueSocket }, { op: 'check' });
      await wait('independent rescue after engine stop', async () => (await rescue()).held.includes(report.originalKeeper.runID));
      const guardianPID = (await rescue()).pid;
      const scanEditors = (userData) => editorProcesses(userData).filter((p) => p.pid !== guardianPID);
      const processes = scanEditors(path.join(editor, 'user-data'));
      fs.writeFileSync(path.join(root, 'source-close'), '', { mode: 0o600 });
      try { await bounded(Promise.all(editorExits), 5000, 'EDITOR_CLEANUP_PENDING'); } catch (_) { /* exact teardown follows */ }
      report.rescueEditorQuit = await require('./native-command').quitDisposableEditor(path.join(editor, 'user-data'), { initial: processes, scan: scanEditors });
      assert.equal(editorProcesses(path.join(editor, 'user-data')).length, 0);
      const held = await rescue(); assert(held.held.includes(report.originalKeeper.runID));
      assert(!processes.some((p) => p.pid === held.pid), 'Rescue must outlive every disposable editor host');
      report.checks.rescuedRunSurvivesVSCodeQuit = true;
      command(executable, ['start'], { env });
      await wait('restarted engine automatically attaches the rescued run', async () => {
        try {
          const status = await require('../src/daemonControl').controlRequest({ socket: path.join(root, 'c.sock') }, { op: 'status' });
          return status.state === 'running' && status.keeper.runs.some((r) => r.runID === report.originalKeeper.runID && r.childPID === report.originalKeeper.childPID);
        } catch (_) { return false; }
      });
      report.checks.engineAutomaticallyReattachesRescue = true;
      fs.unlinkSync(path.join(root, 'source-close'));
      for (const slot of [1, 2]) fs.unlinkSync(path.join(root, 'source-state-' + slot + '.json'));
      for (const [i, cwd] of [project, secondProject].entries()) await openEditor(i, cwd, '-rescue');
      await wait('both reopened service clients', () => [1, 2].every((slot) => {
        const file = path.join(root, 'source-state-' + slot + '.json');
        return fs.existsSync(file) && readPrivateJson(file).mode === 'service-client' && readPrivateJson(file).available;
      }));
      await verifyBridges('rescue-relaunch');
      // Exercise the previously failing second Stop, with the sealed
      // custodian and both newly opened service-client windows still present.
      report.rescueRestartStop = JSON.parse(command(executable, ['intentional-stop'], { env }));
      await delay(1200);
      report.rescueRestartStoppedJob = command('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + LABEL]);
      assert(!/^\s*pid = \d+$/m.test(report.rescueRestartStoppedJob), 'Intentional Stop must not KeepAlive-restart');
      assert.match(report.rescueRestartStoppedJob, /^\s*last exit code = 0$/m);
      assert((await rescue()).held.includes(report.originalKeeper.runID));
      process.kill(report.originalKeeper.childPID, 0);
      command(executable, ['start'], { env });
      await wait('reopened clients reconnect after the second intentional stop', () => [1, 2].every(slot =>
        readPrivateJson(path.join(root, 'source-state-' + slot + '.json')).available === true));
      await verifyBridges('second-rescue-restart');
      report.checks.secondIntentionalStopLeavesCustodyAndNoKeepAliveRestart = true;
    }
    atomicJson(path.join(root, 'mac-cutover-return.json'), { nonce });
    await wait('native handback/stop/unregister', () => readPrivateJson(path.join(root, 'mac-cutover-state.json')).stage === 'returned');
    report.handback = readPrivateJson(path.join(root, 'mac-cutover-state.json')); absent();
    assert.equal(report.handback.clientDisconnectedAfterHandback, true);
    report.checks.handbackDisconnectsTheAppClient = true;
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
    if (legacyContinuity) {
      const before = report.afterAbort[0].conversations.find((s) => s.id === 'p3-legacy-conversation').streamText;
      await wait('returned run still streaming in original keeper', () => readPrivateJson(path.join(root, 'source-state-1.json')).conversations?.some((s) =>
        s.runID === report.originalKeeper.runID && s.childPID === report.originalKeeper.childPID && s.streamText.length > before.length));
      const current = readPrivateJson(path.join(root, 'source-state-1.json')).conversations.find((s) => s.id === 'p3-legacy-conversation');
      const words = current.streamText.match(/\bw\d+ /g) || [];
      assert(words.length > 3 && words.every((word, i) => word === 'w' + (i + 1) + ' '));
      const inputs = fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(inputs.filter((s) => s.event === 'start').length, 1); assert.equal(inputs.filter((s) => s.type === 'user').length, 1);
      assert.equal(fs.readFileSync(env.NIKUI_R27_TAILSCALE_CONFIG, 'utf8'), report.originalRoutes);
      report.checks.handbackKeepsOriginalRunRouteAndEveryWord = true;
      report.checks.noDuplicateProcessOrTurn = true;
      const phone = await fetch('http://127.0.0.1:' + report.fixedPort + '/health', {
        headers: { Host: 'fixture.tail123.ts.net' }, signal: AbortSignal.timeout(10000) });
      assert.equal(phone.status, 200); report.checks.returnedSourceAcceptsTheSameTailnetHost = true;
      if (neverExiting) {
        report.startsBeforeRestart = fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse).filter(s => s.event === 'start').length;
        fs.writeFileSync(path.join(root, 'source-restart-run'), '', { mode: 0o600 });
        await wait('user restart of never-exiting borrowed Claude', () => readPrivateJson(path.join(root, 'source-state-1.json')).conversations?.some((s) =>
          s.id === 'p3-legacy-conversation' && s.childPID && s.childPID !== report.originalKeeper.childPID && s.runID !== report.originalKeeper.runID));
        await wait('returned window leaves borrowed mode', () => readPrivateJson(path.join(root, 'source-state-1.json')).borrowedKeeper === false);
        report.checks.neverExitingClaudeCanRestart = true; report.checks.windowLeavesBorrowedMode = true;
        const replacement = readPrivateJson(path.join(root, 'source-state-1.json')).conversations.find(s => s.id === 'p3-legacy-conversation');
        report.replacement = { pid: replacement.childPID, runID: replacement.runID,
          facts: [...(await require('../src/keeperContinuity').processSnapshot([replacement.childPID])).values()] };
        assert.equal(report.replacement.facts.length, 1);
      }
      fs.writeFileSync(path.join(root, 'source-finish-run'), '', { mode: 0o600 });
      await wait('borrowed legacy keeper naturally drains', () => {
        try { process.kill(report.originalKeeper.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
      });
      report.checks.legacyKeeperRetiresOnItsOwn = true;
      if (neverExiting) {
        await wait('Stop ends the replacement interactive child', async () => {
          const session = readPrivateJson(path.join(root, 'source-state-1.json')).conversations?.find(s => s.id === 'p3-legacy-conversation');
          const current = await require('../src/keeperContinuity').processSnapshot([report.replacement.pid]);
          return !session?.childPID && !session?.stoppingPID && !require('../src/keeperContinuity').sameProcess(report.replacement.facts[0], current.get(report.replacement.pid));
        });
        await delay(2000);
        assert(!readPrivateJson(path.join(root, 'source-state-1.json')).conversations.find(s => s.id === 'p3-legacy-conversation').childPID);
        report.startsAfterStop = fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse).filter(s => s.event === 'start').length;
        assert.equal(report.startsAfterStop, report.startsBeforeRestart + 1, 'Only one replacement may start, and Stop must not wake another');
        report.checks.replacementStopsThroughKeeper = true;
        report.checks.replacementHasConfirmedExitAndNoRespawn = true;
      }
    }
    report.ok = true;
  } catch (e) {
    e.operation ||= operation; e.path ||= root;
    report.failure = failureEvidence(e);
    const capture = (operation, action) => {
      try { action(); } catch (error) {
        error.operation ||= operation; error.path ||= root;
        (report.failure.secondaryFailures ||= []).push(failureEvidence(error));
      }
    };
    const diagnostics = path.join(root, 'cutover-diagnostics.json');
    capture('read cutover diagnostics', () => { if (fs.existsSync(diagnostics)) report.failure.cutoverDiagnostics = readPrivateJson(diagnostics); });
    const journal = path.join(root, 'cutover-request.json');
    capture('read cutover journal', () => { if (fs.existsSync(journal)) {
      const state = readPrivateJson(journal);
      report.failure.coordinator = { stage: state.stage, releaseAcknowledged: state.releaseAcknowledged === true };
    } });
    const stderr = path.join(home, 'engine.stderr.log');
    const startup = path.join(root, 'engine-startup-progress.json');
    capture('read engine startup', () => { if (fs.existsSync(startup)) report.failure.engineStartup = readPrivateJson(startup); });
    capture('read engine stderr', () => { if (fs.existsSync(stderr)) report.failure.engineCodes = fs.readFileSync(stderr, 'utf8').split('\n').flatMap((line) => {
      try { const { code, cause } = JSON.parse(line); return code ? [{ code, ...(cause ? { cause } : {}) }] : []; } catch (_) { return []; }
    }).slice(-16); });
  }
  finally {
    const cleanup = async (name, action) => { try { await action(); report.cleanup.push({ name, ok: true }); } catch (e) {
      e.operation ||= name; e.path ||= root;
      report.ok = false; report.cleanup.push({ name, ok: false, failure: failureEvidence(e) });
    } };
    // Capture before any parent exits so reparented fixture children remain
    // covered by their own PID/birth/argv proofs throughout cleanup.
    const minted = require('./native-command').ownedProcesses([home, run]);
    if (opened) await cleanup('exact app quit', async () => {
      const cli = (op, ...args) => JSON.parse(command(executable, [op, ...args], { env }));
      const launched = [...(await require('../src/keeperContinuity').processSnapshot(cli('app-status').pids)).values()];
      report.appQuit = await require('./test-mac-app').quitOpenedApp({ cli, executable, launched });
    });
    // Drain the driver while its original keeper/custodian still answer.
    // Destroying those fixtures first forced Stop into keeper crash recovery.
    if (executable) await cleanup('own development job', async () => {
      report.developmentJobCleanup = await cleanupDevelopmentJob({ attempted: opened,
        controller: action => JSON.parse(command(executable, [action], { env })) });
    });
    if (legacyContinuity) await cleanup('only disposable legacy keeper and child', async () => {
      await legacyLink?.close();
      if (legacyFacts) {
        const current = await require('../src/keeperContinuity').processSnapshot([...legacyFacts.keys()]);
        for (const [pid, proof] of legacyFacts) if (require('../src/keeperContinuity').sameProcess(proof, current.get(pid))) process.kill(pid, 'SIGTERM');
      }
    });
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
    if (config) await cleanup('only minted test Keychain accounts', () => {
      assert(!developmentJobExists(), 'Keep selected keys until the gate proves its engine job absent');
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
    await cleanup('zero disposable processes', async () => {
      report.custodyJobs = await require('./native-command').cleanupCustodyJobs(report.custodyDirectories || [], [home, run]);
      report.processQuit = await require('./native-command').quitOwnedProcesses([home, run], { initial: minted });
      assert.equal(require('./native-command').ownedProcesses([home, run]).length, 0);
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
    atomicJson('/private/tmp/nik-mac/p3/r' + require('../package.json').macApp.buildNumber + '-native-cutover' + (rescueContinuity ? '-rescue' : neverExiting ? '-never-exiting' : legacyContinuity ? '-continuity' : fixedPort ? '-fixed-port' : '-rehearsal') + '.json', report);
  }
  report.evidence = path.join(run, 'result.json');
  if (!report.ok) process.exitCode = 1;
  return report;
}
module.exports = { main, ENTRY, chooseFixedPort, legacyFixtureSpawner };
if (require.main === module) void require('./native-command').runNative(main);
