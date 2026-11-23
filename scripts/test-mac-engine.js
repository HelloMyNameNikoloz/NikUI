#!/usr/bin/env node
'use strict';

const assert = require('assert/strict'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const { build, LABEL, BASE } = require('./build-mac-engine');
const { privateDirectory, privateRoot } = require('../src/daemonPaths');
const { controlRequest } = require('../src/daemonControl');
const { createSecItemAdapter } = require('../src/keychainStore');
const REPO = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { command, failureEvidence, childResult, cleanupDevelopmentJob } = require('./native-command');
function jobExists() {
  const result = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  if (result.status === 0) return true;
  if (result.status === 113 && result.stderr.includes(`Could not find service "${LABEL}"`)) return false;
  throw Object.assign(new Error('Development-job absence could not be proved'), { code: 'SERVICE_OWNER_UNPROVEN' });
}
async function waitFor(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { try { const value = await fn(); if (value) return value; } catch (_) {} await delay(200); } while (Date.now() < deadline);
  throw Object.assign(new Error('Private test condition timed out'), { code: 'NATIVE_TEST_TIMEOUT' });
}
async function regression(file, args, log, env = {}, timeoutMs = 10 * 60 * 1000) {
  const fd = fs.openSync(log, 'w', 0o600);
  try {
    const child = spawn(file, args, { cwd: REPO, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
    const result = await childResult(child, timeoutMs, 'NATIVE_REGRESSION_TIMEOUT');
    assert.equal(result.code, 0, path.basename(log) + ' failed');
  } finally { fs.closeSync(fd); }
  return fs.readFileSync(log, 'utf8');
}
async function main({ regressions = false, menubar = false, acceptanceP2 = false, acceptanceRealTools = false, macAppE2E = false, exercise, quiet = false } = {}) {
  assert(!jobExists(), 'An existing development job must be removed by its owner before this test; it was not touched');
  privateDirectory(BASE);
  const run = fs.mkdtempSync(path.join(BASE, 'acceptance-')), home = path.join(run, 'test-home');
  const original = path.join(run, 'Original.app');
  const report = { version: 1, label: LABEL, run, ok: false, checks: {}, cleanup: {} };
  const evidence = path.join(run, 'result.json');
  report.evidence = evidence;
  let built, app, executable, paths, attempted = false, cleanedKeychain = false, menuAttempted = false;
  const controller = (action) => JSON.parse(command(executable, [action]));
  const write = () => fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  try {
    built = build({ output: original, testHome: home, acceptanceP2, acceptanceRealTools, ...require('../package.json').macApp });
    assert.equal(built.buildNumber, require('../package.json').macApp.buildNumber);
    const relocated = path.join(run, 'relocated'); privateDirectory(relocated);
    app = path.join(relocated, 'NikUI Dev.app');
    // Match a build → /Applications install: ditto a complete signed package
    // and keep the original same-id bundle present throughout registration.
    command('/usr/bin/ditto', [built.output, app]);
    executable = path.join(app, 'Contents/MacOS/NikUI'); paths = privateRoot(built.root, { create: false });
    const identity = controller('build-identity');
    assert.equal(identity.flavour, 'dev'); assert.equal(identity.appID, 'com.nikui.app.dev'); assert.equal(identity.label, LABEL);
    assert.equal(identity.home, built.testHome); assert.equal(identity.root, built.root);
    report.checks.compiledDevelopmentIdentity = true;
    report.bundle = { original: built.output, relocated: app, node: built.node, root: built.root, version: built.appVersion, buildNumber: built.buildNumber };
    report.bundle.manifest = path.join(run, 'build-manifest.json');
    fs.copyFileSync(path.join(app, 'Contents/Resources/engine/build-manifest.json'), report.bundle.manifest);
    fs.chmodSync(report.bundle.manifest, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(report.bundle.manifest)).buildNumber, built.buildNumber);
    assert.equal(command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', path.join(app, 'Contents/Info.plist')]).trim(), built.buildNumber);
    report.checks.currentBuildVersion = true;
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]); report.checks.relocatedSignature = true;
    const binaries = ['MacOS/NikUI', 'MacOS/nikd', 'Helpers/NikKeychain.app/Contents/MacOS/NikKeychain',
      'Helpers/NikKeychainRebuilt.app/Contents/MacOS/NikKeychain', 'Helpers/NikNotifier.app/Contents/MacOS/nikui-notify',
      'Helpers/NikVoice.app/Contents/MacOS/nikui-voice'];
    report.signatures = [];
    for (const binary of binaries) {
      const file = path.join(app, 'Contents', binary);
      const load = command('/usr/bin/otool', ['-l', file]); assert.match(load, /minos 14\.0/);
      const signature = spawnSync('/usr/bin/codesign', ['-dvv', file], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' }).stderr;
      assert.match(signature, /flags=.*runtime/); assert.match(signature, /Authority=Apple Development:/);
      report.signatures.push({ binary, minOS: '14.0', identifier: signature.match(/^Identifier=(.+)$/m)?.[1],
        team: signature.match(/^TeamIdentifier=(.+)$/m)?.[1], sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
    const node = path.join(app, 'Contents/Resources/engine/node');
    const entitlements = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', node], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    const keys = [...entitlements.stdout.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort();
    assert.deepEqual(keys, ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory']);
    assert(!command('/usr/bin/otool', ['-L', node]).includes('/opt/homebrew/'));
    report.checks.signaturesTargetAndNodeEntitlements = true;
    const jit = command(node, ['-e', 'let s=0;for(let i=0;i<5e7;i++)s+=i;new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));console.log(process.version,process.arch,s)']);
    assert.match(jit, /^v26\.7\.0 arm64 /); report.checks.hardenedJitAndWasm = true;
    const beforePreflight = fs.readdirSync(built.root).sort();
    report.idlePreflight = JSON.parse(command(path.join(app, 'Contents/MacOS/nikd'), ['--preflight']));
    assert.equal(report.idlePreflight.ok, true); assert.equal(report.idlePreflight.mode, 'idle-preflight');
    assert.equal(report.idlePreflight.label, LABEL); assert.equal(report.idlePreflight.executable, node);
    assert.deepEqual(fs.readdirSync(built.root).sort(), beforePreflight);
    assert(!jobExists()); report.checks.idlePackagePreflightBeforeRegistrationAndCommit = true;
    const voice = spawnSync(path.join(app, 'Contents/Helpers/NikVoice.app/Contents/MacOS/nikui-voice'), ['check'],
      { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', env: { HOME: built.testHome, NIKUI_VOICE_HOME: built.testHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    assert.equal(voice.status, 1); assert.equal(JSON.parse(voice.stdout).code, 'NO_MODEL');
    report.checks.signedVoiceRefusesMissingTestModel = true;
    assert(!jobExists(), 'A development job appeared during the build; it was not touched');
    attempted = true;
    try { report.registration = controller('register'); }
    finally { if (jobExists()) report.registrationJob = command('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]); }
    assert.equal(report.registration.registration, 'enabled');
    report.registrationJob = command('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
    assert.match(report.registrationJob, new RegExp('^\\s*parent bundle version = ' + built.buildNumber + '$', 'm'));
    assert.equal(controller('validate-registration').ok, true);
    const foreign = spawnSync(path.join(original, 'Contents/MacOS/NikUI'), ['validate-registration'],
      { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    assert.equal(foreign.status, 1); assert.equal(JSON.parse(foreign.stdout).code, 'SERVICE_BUNDLE_MISMATCH');
    report.checks.dittoCopyRegistersItselfAndRefusesOriginal = true;
    const first = await waitFor(async () => { const s = await controlRequest(paths, { op: 'status' }); return s.state === 'running' && s; });
    assert.equal(first.root, built.root); assert.equal(first.package?.label, LABEL);
    assert.equal(first.package?.appID, 'com.nikui.app.dev'); assert.equal(first.package?.flavour, 'dev');
    assert.equal(first.package?.home, built.testHome); assert.equal(first.package?.node, 'v26.7.0'); assert.equal(first.package?.arch, 'arm64');
    assert.equal(first.package?.keychainBackend, 'login-file-keychain'); assert.equal(first.package?.path, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(first.tools.node.path, node); assert(first.package.childPath.startsWith(path.dirname(node) + ':'));
    report.checks.realEngineStatusAndTestHome = true; report.first = { pid: first.pid, generation: first.generation, package: first.package, tools: first.tools };
    const managed = controller('status'); report.controllerStatus = managed;
    assert.equal(managed.control?.generation, first.generation, 'Controller status: ' + JSON.stringify(managed));
    report.checks.controllerStatusOverPrivateSocket = true;
    if (menubar) {
      // Native-only gate, run by Claude outside Codex's sandbox. The GUI must
      // inherit an explicit TEST HOME, even though its selected root is sealed
      // in the signed bundle. open uses LaunchServices, never an in-app browser.
      menuAttempted = true;
      command('/usr/bin/open', ['-n', '--env', `HOME=${built.testHome}`, '--env', `USERPROFILE=${built.testHome}`,
        '--env', `ZDOTDIR=${built.testHome}`, '--env', `CODEX_HOME=${path.join(built.root, 'home/.codex-work')}`, app]);
      const menu = await waitFor(async () => {
        const file = path.join(built.root, 'menu-state.json');
        if (!fs.existsSync(file)) return false;
        const state = require('../src/daemonPaths').readPrivateJson(file);
        const processes = controller('app-status').pids;
        const control = await controlRequest(paths, { op: 'status' });
        return state.connected && state.generation === first.generation && control.localManagement.menuObservers === 1 &&
          processes.includes(state.pid) && state;
      });
      assert.equal(menu.home, built.testHome); assert.equal(menu.root, built.root);
      assert.equal(menu.state, 'running'); assert(menu.pid !== first.pid);
      process.kill(menu.pid, 0); // exact GUI pid proved by NSRunningApplication + private evidence
      report.checks.menubarTestHomeAndAlive = true; report.menubar = { pid: menu.pid, generation: menu.generation, home: menu.home };
      // P2's clients share this exact generation with the actual menu client.
      if (exercise) report.acceptanceP2 = await exercise({ built, app, executable, paths, first, controller, run, report });
      const quit = controller('quit-app'); assert.deepEqual(quit.pids, [menu.pid]);
      await waitFor(() => controller('app-status').pids.length === 0);
      const survived = await waitFor(async () => {
        const control = await controlRequest(paths, { op: 'status' }); return control.localManagement.menuObservers === 0 && control;
      });
      assert.equal(survived.state, 'running');
      const expected = report.acceptanceP2?.lastStatus || first;
      assert.equal(survived.pid, expected.pid); assert.equal(survived.generation, expected.generation);
      report.checks.menubarQuitLeavesEngineRunning = true;
    }
    // Acceptance scenarios restart the engine; a restart binds a fresh port.
    const serving = await controlRequest(paths, { op: 'status' });
    for (const asset of ['/health', '/', '/media/home.js', '/media/transport.js', '/sw.js']) {
      const response = await fetch(`http://127.0.0.1:${serving.listener.port}${asset}`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200, asset); assert((await response.text()).length > 0);
    }
    report.checks.relocatedRealMedia = true;
    report.keychain = await controlRequest(paths, { op: 'package-keychain-selftest' }, { timeoutMs: 30000 });
    assert.equal(report.keychain.ok, true); assert.equal(report.keychain.cleanup, true);
    assert(Object.values(report.keychain.checks).every((value) => value === true)); report.checks.realKeychainAndRebuild = true;
    if (exercise && !menubar) report.acceptanceP2 = await exercise({ built, app, executable, paths, first, controller, run, report });
    report.stage = 'sigkill9Relaunch'; write();
    report.crash = controller('crash-relaunch'); const restarted = report.crash.control;
    assert.notEqual(restarted.pid, first.pid); assert.notEqual(restarted.generation, first.generation);
    assert.equal(restarted.engine.id, first.engine.id); assert.notEqual(restarted.engine.boot, first.engine.boot);
    report.checks.sigkill9Relaunch = true; write();
    if (regressions) {
      const testEnv = { HOME: built.testHome, USERPROFILE: built.testHome, ZDOTDIR: built.testHome, NIKUI_NATIVE_TESTS: '1',
        CODEX_HOME: path.join(built.testHome, '.codex-work'), NIKUI_SIGNED_TEST_ROOT: built.root };
      report.stage = 'directKeychainRegressions'; write();
      const direct = await regression(process.execPath, [path.join(REPO, 'test/run.js'), 'engine-secrets'],
        path.join(run, 'keychain-helper-direct.log'), { ...testEnv, NIKUI_SIGNED_TEST_ROOT: '' });
      report.directKeychain = direct.match(/(\d+\/\d+) checks passed/)?.[1]; assert(report.directKeychain);
      report.stage = 'npmRegressions'; write();
      const npm = await regression(process.execPath, [path.join(REPO, 'test/run.js')], path.join(run, 'npm-test.log'),
        // The complete multi-window crash matrix is larger than P2's suite.
        // Keep a finite allowance for it and retain its exact progress stage.
        { ...testEnv, NIKUI_TEST_PROGRESS: '1' }, 15 * 60 * 1000);
      report.npm = npm.match(/(\d+\/\d+) checks passed/)?.[1]; assert(report.npm);
      const cache = path.join(run, 'swift-module-cache'); privateDirectory(cache);
      report.stage = 'nikCoreRegressions'; write();
      const swift = await regression('/usr/bin/env', ['swift', 'test', '--disable-sandbox', '--package-path', path.join(REPO, 'app/iphone/NikCore'),
        '--scratch-path', path.join(run, 'nikcore-build'), '--cache-path', path.join(run, 'swift-cache'), '--config-path', path.join(run, 'swift-config'), '--security-path', path.join(run, 'swift-security')],
        path.join(run, 'swift-test.log'), { ...testEnv, CLANG_MODULE_CACHE_PATH: cache, SWIFTPM_MODULECACHE_OVERRIDE: cache, NIKCORE_LOOPBACK_TESTS: '1' });
      report.swift = swift.match(/Test run with (\d+ tests? in \d+ suites?) passed/)?.[1]; assert(report.swift);
      report.stage = 'macSwiftRegressions'; write();
      const macSwift = await regression('/usr/bin/env', ['swift', 'test', '--disable-sandbox', '--package-path', path.join(REPO, 'app/mac/NikMenuBar'),
        '--scratch-path', path.join(run, 'mac-build'), '--cache-path', path.join(run, 'mac-cache'), '--config-path', path.join(run, 'mac-config'),
        '--security-path', path.join(run, 'mac-security'), '-Xswiftc', '-DNIKUI_DEVELOPMENT'],
        path.join(run, 'mac-swift-test.log'), { ...testEnv, CLANG_MODULE_CACHE_PATH: cache, SWIFTPM_MODULECACHE_OVERRIDE: cache });
      report.macSwift = [...macSwift.matchAll(/Test run with (\d+ tests? in \d+ suites?) passed/g)].map((match) => match[1]);
      assert(report.macSwift.length >= 1);
    }
    report.stage = 'intentionalStop'; write();
    report.stop = controller('intentional-stop'); assert.equal(report.stop.intentional, true);
    await delay(13000);
    const stopped = controller('status'); assert.equal(stopped.registration, 'enabled'); assert.equal(stopped.control, null);
    const job = command('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
    assert.match(job, /last exit code = 0/); assert(!/^\s*pid = /m.test(job)); report.checks.sigtermStaysStopped = true;
    const started = controller('start'); assert.notEqual(started.control.generation, restarted.generation); report.checks.explicitStartResumes = true;
    const cleanup = await controlRequest(paths, { op: 'package-test-cleanup' }); assert.equal(cleanup.cleanup, true); cleanedKeychain = true;
    controller('intentional-stop');
    report.unregister = controller('unregister'); assert.equal(report.unregister.registration, 'notRegistered');
    await waitFor(() => !jobExists()); report.checks.unregisterJobGone = true;
    report.ok = true;
  } catch (error) {
    report.failure = { code: error.code || 'ASSERTION_FAILED', ...failureEvidence(error) };
  } finally {
    const failures = [];
    report.cleanup.appGone = !menuAttempted;
    if (menuAttempted && executable) {
      try {
        controller('quit-app'); await waitFor(() => controller('app-status').pids.length === 0, 10000);
        report.cleanup.appGone = true;
      } catch (error) { failures.push(error); }
    }
    if (macAppE2E && built && executable) {
      try {
        assert.equal(report.cleanup.appGone, true, 'Close the exact app before deleting its test identity');
        assert.equal(controller('delete-test-client-identity').localDeviceItemsAbsent, true);
        report.cleanup.localDeviceKeychain = true;
      } catch (error) { report.cleanup.localDeviceKeychain = false; failures.push(error); }
    }
    if (attempted && executable) {
      try { report.cleanup.developmentJob = await cleanupDevelopmentJob({ controller, attempted, exists: jobExists }); }
      catch (error) { failures.push(error); report.cleanup.developmentJob = failureEvidence(error); }
    }
    // Keep the selected bytes available if removal could not be proved. A
    // failed cleanup must not turn one startup refusal into KEYCHAIN_NOT_FOUND
    // on every subsequent KeepAlive attempt.
    report.cleanup.jobGone = !jobExists();
    const activeApp = app && fs.existsSync(app) ? app : original;
    if (report.cleanup.jobGone && built && !cleanedKeychain) {
      try {
        const adapter = createSecItemAdapter({ helper: path.join(activeApp, 'Contents/Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
          service: built.keychainService, home: built.testHome });
        adapter.delete('store.v1'); assert.equal(adapter.read('store.v1'), null); cleanedKeychain = true;
      } catch (error) { failures.push(error); }
    }
    if (report.cleanup.jobGone && built && acceptanceP2) {
      try {
        const adapter = createSecItemAdapter({ helper: path.join(activeApp, 'Contents/Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
          service: built.keychainService, home: built.testHome });
        report.cleanup.transferAccounts = require('../src/acceptanceTransfer').cleanupTransferAccounts(built.root, adapter);
      } catch (error) { failures.push(error); }
    }
    if (!built) cleanedKeychain = true; // builds never call SecItem or register
    report.cleanup.keychain = cleanedKeychain && (!acceptanceP2 || !built || report.cleanup.transferAccounts?.cleanup === true);
    if (report.cleanup.jobGone && report.cleanup.keychain && report.cleanup.appGone && !failures.length) {
      for (const file of [app, original].filter(Boolean)) fs.rmSync(file, { recursive: true, force: true });
      report.cleanup.bundleRemoved = !fs.existsSync(original) && (!app || !fs.existsSync(app));
    }
    report.cleanup.failures = failures.map((e) => e.code || 'CLEANUP_FAILED');
    if (failures.length || !report.cleanup.bundleRemoved) report.ok = false;
    write();
  }
  if (!quiet) process.stdout.write(JSON.stringify({ ok: report.ok, evidence, checks: report.checks, cleanup: report.cleanup, failure: report.failure, npm: report.npm, swift: report.swift, macSwift: report.macSwift }) + '\n');
  if (!report.ok) process.exitCode = 1;
  return report;
}
if (require.main === module) {
  void require('./native-command').runNative(() => {
    if (process.argv.slice(2).some((arg) => !['--regressions', '--menubar'].includes(arg))) throw new Error('Usage: test-mac-engine.sh [--regressions] [--menubar]');
    return main({ regressions: process.argv.includes('--regressions'), menubar: process.argv.includes('--menubar'), quiet: true });
  });
}
module.exports = { main };
