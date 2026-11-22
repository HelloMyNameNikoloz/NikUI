#!/usr/bin/env node
'use strict';

// Read-only package inspection. No app/helper launch, registration or SecItem.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), vm = require('vm');
const assert = require('assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const { identityForBuild } = require('../src/macFlavour');
const { noSymlinks } = require('../src/daemonPaths');
const { TEAM, NODE_SHA256 } = require('./build-mac-app');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
const readPlist = (file) => JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]));
function verify({ app, flavour }) {
  const expected = identityForBuild(flavour);
  noSymlinks(app); app = fs.realpathSync(app);
  const contents = path.join(app, 'Contents'), engine = path.join(contents, 'Resources/engine');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const info = readPlist(path.join(contents, 'Info.plist'));
  assert.equal(info.CFBundleIdentifier, expected.appID); assert.equal(info.NikEngineLabel, expected.label);
  assert.equal(info.NikBuildFlavour, flavour); assert.equal(info.CFBundleExecutable, 'NikUI');
  assert.equal(info.LSMinimumSystemVersion, '14.0'); assert.equal(info.LSUIElement, undefined);
  const agent = readPlist(path.join(contents, 'Library/LaunchAgents', expected.label + '.plist'));
  assert.equal(agent.Label, expected.label); assert.deepEqual(agent.AssociatedBundleIdentifiers, [expected.appID]);
  assert.equal(agent.BundleProgram, 'Contents/MacOS/nikd'); assert.equal(agent.RunAtLoad, true);
  assert.deepEqual(agent.KeepAlive, { SuccessfulExit: false });
  const config = JSON.parse(fs.readFileSync(path.join(engine, 'mac-engine.json')));
  assert.equal(config.flavour, flavour); assert.equal(config.appID, expected.appID); assert.equal(config.label, expected.label);
  if (flavour === 'prod') {
    for (const value of [info, config, agent]) {
      assert(!JSON.stringify(value).includes('/private/tmp/'));
      assert(!JSON.stringify(value).includes('/tmp/nik-mac'));
    }
    assert(!Object.hasOwn(config, 'root')); assert(!Object.hasOwn(config, 'testHome'));
    assert(!config.testOnly && !config.acceptanceP2 && !config.acceptanceRealTools && !config.acceptanceCutover);
    assert(!fs.existsSync(path.join(contents, 'Helpers/NikKeychainRebuilt.app')));
  } else {
    assert.equal(info.NikEngineTestHome, config.testHome); assert.equal(info.NikEngineTestRoot, config.root);
    assert.equal(config.testOnly, true);
  }
  const compiled = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(engine, 'src/macBuildIdentity.js'), 'utf8'), { module: compiled }, { timeout: 1000 });
  assert.deepEqual(JSON.parse(JSON.stringify(compiled.exports)), { flavour, appID: expected.appID, label: expected.label });
  const helper = readPlist(path.join(contents, 'Helpers/NikKeychain.app/Contents/Info.plist'));
  assert.equal(helper.NikBuildFlavour, flavour);
  assert.equal(helper.NikKeychainServicePrefix, flavour === 'prod' ? 'com.nikui.engine.production.' : 'com.nikui.engine.test.');
  const manifest = JSON.parse(fs.readFileSync(path.join(engine, 'build-manifest.json')));
  assert.equal(manifest.flavour, flavour); assert.equal(manifest.node.sha256, NODE_SHA256);
  assert.equal(manifest.appVersion, info.CFBundleShortVersionString); assert.equal(manifest.buildNumber, info.CFBundleVersion);
  let hashes = 0;
  for (const [relative, expectedHash] of Object.entries(manifest.files)) {
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(contents, relative))).digest('hex'), expectedHash, relative);
    hashes++;
  }
  const binaries = ['MacOS/NikUI', 'MacOS/nikd', 'Resources/engine/node',
    'Helpers/NikKeychain.app/Contents/MacOS/NikKeychain',
    ...(flavour === 'dev' ? ['Helpers/NikKeychainRebuilt.app/Contents/MacOS/NikKeychain'] : []),
    'Helpers/NikNotifier.app/Contents/MacOS/nikui-notify', 'Helpers/NikVoice.app/Contents/MacOS/nikui-voice'];
  const signatures = [];
  for (const binary of binaries) {
    const file = path.join(contents, binary);
    assert.equal(run('/usr/bin/lipo', ['-archs', file]).trim(), 'arm64');
    const load = run('/usr/bin/otool', ['-l', file]);
    assert.match(load, binary === 'Resources/engine/node' ? /minos 13\.5/ : /minos 14\.0/);
    const signature = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', file], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' }).stderr;
    assert.match(signature, /flags=.*runtime/); assert.match(signature, /Authority=Apple Development:/);
    assert(signature.includes('TeamIdentifier=' + TEAM));
    const entitlements = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', file], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    const keys = [...entitlements.stdout.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort();
    assert.deepEqual(keys, binary === 'Resources/engine/node'
      ? ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'] : []);
    signatures.push({ binary, team: TEAM, codeDirectoryHash: signature.match(/^CDHash=(.+)$/m)?.[1] });
  }
  return { ok: true, app, flavour, appID: expected.appID, label: expected.label,
    version: info.CFBundleShortVersionString, build: info.CFBundleVersion, resourceHashes: hashes, signatures };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: verify-mac-app.js prod|dev /tmp/nik-mac/build/p3/NikUI.app');
    process.stdout.write(JSON.stringify(verify({ flavour: process.argv[2], app: process.argv[3] })) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { verify };
