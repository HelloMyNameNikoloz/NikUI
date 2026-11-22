#!/usr/bin/env node
'use strict';

// native: pending Claude run, outside the managed Codex sandbox.
// Exercises first launch of BUILT copies only. It never installs/registers a
// production engine or clicks cutover, and quits only the exact apps it opens.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { verify } = require('./verify-mac-app');
const { BASE } = require('./build-mac-app');
const { encodeFrame, decodeFrame } = require('../src/keychainStore');
const { noSymlinks } = require('../src/daemonPaths');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function run(file, args, env = {}) {
  return require('./native-command').command(file, args, { timeout: 10000,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env } });
}
function absent(label) {
  const result = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  if (result.status === 113 && result.stderr.includes(`Could not find service "${label}"`)) return;
  throw new Error('EXISTING_OR_UNPROVEN_JOB: ' + label);
}
async function main() {
  if (process.argv.slice(2).join(' ') === '--native --cutover-rehearsal') return require('./test-mac-cutover').main();
  if (process.argv.slice(2).join(' ') === '--native --cutover-rehearsal-fixed-port') return require('./test-mac-cutover').main({ fixedPort: true });
  if (process.argv.slice(2).join(' ') === '--native --e2e') return require('./test-mac-app-e2e').main();
  if (process.argv.slice(2).join(' ') !== '--native') throw new Error('Usage: test-mac-app.sh --native [--e2e | --cutover-rehearsal | --cutover-rehearsal-fixed-port] (Claude only)');
  const testHome = path.join(BASE, 'dev-home'), report = { ok: false, checks: [], cleanup: [] };
  const entries = ['prod', 'dev'].map((flavour) => {
    const app = path.join(BASE, flavour === 'prod' ? 'NikUI.app' : 'NikUI Dev.app');
    const inspection = verify({ app, flavour });
    return { ...inspection, executable: path.join(app, 'Contents/MacOS/NikUI') };
  });
  const opened = [];
  try {
    for (const entry of entries) {
      absent(entry.label);
      const cli = (command) => JSON.parse(run(entry.executable, [command], { HOME: testHome, NIKUI_FLAVOUR: 'dev', CODEX_HOME: testHome + '/.codex' }));
      assert.deepEqual(cli('app-status').pids, [], 'Existing exact app is left alone');
      const identity = cli('build-identity');
      assert.equal(identity.flavour, entry.flavour); assert.equal(identity.label, entry.label); assert.equal(identity.appID, entry.appID);
      const rootExisted = fs.existsSync(identity.root);
      if (entry.flavour === 'prod') {
        assert.equal(identity.home, require('os').userInfo().homedir);
        assert.equal(identity.root, path.join(identity.home, 'Library/Application Support/NikUI/engine'));
        // A pre-existing production profile is outside this rehearsal's scope.
        assert.equal(rootExisted, false, 'Existing production profile is left alone');
        const result = spawnSync(entry.executable, ['register'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
        assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, 'USER_CUTOVER_REQUIRED');
        absent(entry.label);
      }
      const contents = path.join(entry.app, 'Contents');
      const helper = path.join(contents, 'Helpers/NikKeychain.app/Contents/MacOS/NikKeychain');
      const rejectedService = entry.flavour === 'prod' ? 'com.nikui.engine.test.' + 'a'.repeat(32) : 'com.nikui.engine.production.selected-store-v1';
      const refused = spawnSync(helper, [], { input: encodeFrame({ version: 1, id: 'b'.repeat(32), op: 'read', service: rejectedService, account: 'probe' }), timeout: 10000, killSignal: 'SIGKILL' });
      assert.equal(refused.status, 1); assert.equal(decodeFrame(refused.stdout).error.code, 'KEYCHAIN_NAMESPACE');
      opened.push({ entry, cli });
      run('/usr/bin/open', ['-n', '--env', 'HOME=' + testHome, entry.app]);
      const deadline = Date.now() + 15000;
      while (!cli('app-status').pids.length && Date.now() < deadline) await pause(200);
      assert.equal(cli('app-status').pids.length, 1);
      await pause(1500); // allow first scene/model tasks to run before inspection
      absent(entry.label);
      assert.equal(fs.existsSync(identity.root), rootExisted, 'First launch must not initialize an engine profile');
      report.checks.push({ flavour: entry.flavour, compiledIdentity: true, foreignKeychainNamespaceRefused: true,
        firstWindowProcessAlive: true, noAgentRegistered: true, noEngineProfileCreated: true,
        ...(entry.flavour === 'prod' ? { productionCLIRegistrationRefused: true } : {}) });
    }
    report.ok = true;
  } catch (error) {
    report.failure = require('./native-command').failureEvidence(error);
  } finally {
    for (const { entry, cli } of opened.reverse()) {
      try {
        cli('quit-app');
        const deadline = Date.now() + 10000;
        while (cli('app-status').pids.length && Date.now() < deadline) await pause(200);
        assert.equal(cli('app-status').pids.length, 0); absent(entry.label);
        report.cleanup.push({ flavour: entry.flavour, exactAppQuit: true, jobAbsent: true });
      } catch (error) { report.ok = false; report.cleanup.push({ flavour: entry.flavour, failure: error.message }); }
    }
    const evidence = '/private/tmp/nik-mac/p3/r19-native-app.json';
    noSymlinks(evidence); fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    report.evidence = evidence;
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}
if (require.main === module) void require('./native-command').runNative(main);
