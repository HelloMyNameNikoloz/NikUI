#!/usr/bin/env node
'use strict';

const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { noSymlinks, privateDirectory, inside } = require('../src/daemonPaths');
const { buildKeychainHelper, signingKeychainArgs } = require('./build-keychain-helper');
const REPO = path.resolve(__dirname, '..'), BASE = '/private/tmp/nik-mac/build';
const NODE_VERSION = 'v26.7.0', NODE_ARCHIVE = `node-${NODE_VERSION}-darwin-arm64.tar.gz`;
const NODE_SHA256 = '7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4';
const LABEL = 'com.nikui.engine.dev', TARGET = 'arm64-apple-macos14.0';
const run = (file, args) => execFileSync(file, args, { stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const plist = (body) => '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n' + body + '\n</dict></plist>\n';
const entry = (key, value) => `<key>${key}</key><string>${xml(value)}</string>`;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function compile(source, output, cache) {
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  run('/usr/bin/xcrun', ['swiftc', '-O', '-target', TARGET, '-module-cache-path', cache, source, '-o', output]);
}
function compileMenu(output, testHome, cache) {
  const args = ['swift', 'build', '--disable-sandbox', '--package-path', path.join(REPO, 'app/mac/NikMenuBar'),
    '--scratch-path', path.join(BASE, 'menubar-build'), '--cache-path', path.join(BASE, 'menubar-cache'),
    '--config-path', path.join(BASE, 'menubar-config'), '--security-path', path.join(BASE, 'menubar-security'),
    '-c', 'release', '--product', 'NikEngine', '--triple', 'arm64-apple-macosx14.0',
    '-Xswiftc', '-target', '-Xswiftc', TARGET];
  const env = ['HOME=' + testHome, 'CLANG_MODULE_CACHE_PATH=' + cache, 'SWIFTPM_MODULECACHE_OVERRIDE=' + cache,
    'MACOSX_DEPLOYMENT_TARGET=14.0', '/usr/bin/xcrun'];
  run('/usr/bin/env', [...env, ...args]);
  const products = run('/usr/bin/env', [...env, ...args, '--show-bin-path']).toString().trim();
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(products, 'NikEngine'), output);
}
function sign(file, identity, entitlements) {
  run('/usr/bin/codesign', ['--force', '--sign', identity, ...signingKeychainArgs(), '--timestamp=none', '--options', 'runtime',
    ...(entitlements ? ['--entitlements', entitlements] : []), file]);
}
function build({ output = path.join(BASE, 'NikEngine Dev.app'), testHome = path.join(BASE, 'test-home'), identity = 'Apple Development', acceptanceP2 = false, acceptanceRealTools = false } = {}) {
  if (typeof acceptanceP2 !== 'boolean' || typeof acceptanceRealTools !== 'boolean' || (acceptanceRealTools && !acceptanceP2)) throw new Error('Invalid acceptance build selection');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('arm64 macOS required');
  noSymlinks(output); noSymlinks(testHome);
  output = path.resolve(output).replace(/^\/tmp\//, '/private/tmp/');
  testHome = path.resolve(testHome).replace(/^\/tmp\//, '/private/tmp/');
  if (!inside(BASE, output) || output === BASE || !output.endsWith('.app') ||
    !inside(BASE, testHome) || testHome === BASE || inside(output, testHome) || inside(testHome, output) ||
    inside(REPO, output) || !identity) throw new Error('Explicit separate outputs under /tmp/nik-mac/build required');
  if (fs.existsSync(output)) throw new Error('Bundle exists: unregister and remove that test bundle before rebuilding');
  privateDirectory(BASE); privateDirectory(path.dirname(output)); privateDirectory(testHome);
  privateDirectory(path.join(testHome, 'tmp'));
  const root = path.join(testHome, 'profile'); privateDirectory(root);
  const contents = path.join(output, 'Contents'), engine = path.join(contents, 'Resources/engine');
  const cache = path.join(BASE, 'swift-module-cache'); privateDirectory(cache);
  const download = path.join(BASE, 'node-cache'); privateDirectory(download);
  const spike = '/tmp/nik-mac/spikes/node-dl';
  const archive = path.join(download, NODE_ARCHIVE), sums = path.join(download, 'SHASUMS256.txt');
  for (const [file, name] of [[archive, NODE_ARCHIVE], [sums, 'SHASUMS256.txt']]) {
    if (!fs.existsSync(file)) {
      if (fs.existsSync(path.join(spike, name))) fs.copyFileSync(path.join(spike, name), file);
      else run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--connect-timeout', '15', '--max-time', '180', '--output', file, `https://nodejs.org/dist/${NODE_VERSION}/${name}`]);
    }
  }
  const checksum = fs.readFileSync(sums, 'utf8').split(/\r?\n/).find((line) => line.trim().endsWith('  ' + NODE_ARCHIVE))?.split(/\s+/)[0];
  if (checksum !== NODE_SHA256 || hash(archive) !== NODE_SHA256) throw new Error('Official Node SHASUMS256 or pinned checksum mismatch');
  fs.mkdirSync(engine, { recursive: true, mode: 0o700 });
  // Extract on every build into a new directory: never trust a modified cache binary.
  const unpack = fs.mkdtempSync(path.join(download, 'verified-'));
  try {
    run('/usr/bin/tar', ['-xzf', archive, '-C', unpack]);
    fs.copyFileSync(path.join(unpack, `node-${NODE_VERSION}-darwin-arm64/bin/node`), path.join(engine, 'node'));
    fs.copyFileSync(path.join(unpack, `node-${NODE_VERSION}-darwin-arm64/LICENSE`), path.join(engine, 'NODE-LICENSE'));
  } finally { fs.rmSync(unpack, { recursive: true, force: true }); }
  for (const name of ['src', 'media']) fs.cpSync(path.join(REPO, name), path.join(engine, name), { recursive: true, dereference: false });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(engine, 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(engine, 'package.json')));
  if (Object.keys(pkg.dependencies || {}).length) throw new Error('Runtime dependencies require an explicit packaging disposition');
  privateDirectory(path.join(contents, 'Helpers'));
  const keychain = buildKeychainHelper({ output: path.join(contents, 'Helpers/NikKeychain.app'), identity, moduleCache: cache });
  buildKeychainHelper({ output: path.join(contents, 'Helpers/NikKeychainRebuilt.app'), identity, moduleCache: cache, version: '2' });
  const config = { version: 1, label: LABEL, testOnly: true, testHome, root, acceptanceP2, acceptanceRealTools,
    keychainService: keychain.servicePrefix + crypto.randomBytes(16).toString('hex') };
  fs.writeFileSync(path.join(engine, 'mac-engine.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const executable = path.join(contents, 'MacOS/NikEngine');
  compileMenu(executable, testHome, cache);
  compile(path.join(REPO, 'helpers/mac-engine/launcher.swift'), path.join(contents, 'MacOS/nikd'), cache);
  const info = plist([entry('CFBundleIdentifier', LABEL), entry('CFBundleExecutable', 'NikEngine'),
    entry('CFBundleName', 'NikEngine Dev'), entry('CFBundlePackageType', 'APPL'), entry('CFBundleVersion', '1'),
    entry('CFBundleShortVersionString', pkg.version), entry('LSMinimumSystemVersion', '14.0'),
    '<key>LSUIElement</key><true/>', entry('NikEngineTestHome', testHome), entry('NikEngineTestRoot', root)].join('\n'));
  fs.writeFileSync(path.join(contents, 'Info.plist'), info);
  const agents = path.join(contents, 'Library/LaunchAgents'); fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agents, LABEL + '.plist'), plist([
    entry('Label', LABEL), entry('BundleProgram', 'Contents/MacOS/nikd'), '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>', entry('ProcessType', 'Interactive'),
    `<key>AssociatedBundleIdentifiers</key><array><string>${LABEL}</string></array>`,
    entry('WorkingDirectory', testHome), entry('StandardOutPath', path.join(testHome, 'engine.stdout.log')),
    entry('StandardErrorPath', path.join(testHome, 'engine.stderr.log')),
    `<key>EnvironmentVariables</key><dict>${entry('HOME', testHome)}${entry('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')}</dict>`
  ].join('\n')));
  // Retain the actual notifier under a development-only identity. No permission
  // prompt, LaunchServices registration or notification is issued by the build.
  const notifier = path.join(contents, 'Helpers/NikNotifier.app/Contents');
  compile(path.join(REPO, 'notifier/main.swift'), path.join(notifier, 'MacOS/nikui-notify'), cache);
  fs.writeFileSync(path.join(notifier, 'Info.plist'), plist([entry('CFBundleIdentifier', LABEL + '.notifier'),
    entry('CFBundleExecutable', 'nikui-notify'), entry('CFBundleName', 'NikEngine Dev Notifications'),
    entry('CFBundlePackageType', 'APPL'), entry('CFBundleVersion', '1'), entry('LSMinimumSystemVersion', '14.0'),
    '<key>LSUIElement</key><true/>', entry('NSPrincipalClass', 'NSApplication')].join('\n')));
  // Build the pinned real voice helper; models and user caches are never copied.
  const voiceBuild = path.join(BASE, 'voice-build');
  const voiceArgs = ['swift', 'build', '--disable-sandbox', '--package-path', path.join(REPO, 'voice'),
    '--scratch-path', voiceBuild, '--cache-path', path.join(BASE, 'voice-cache'),
    '--config-path', path.join(BASE, 'voice-config'), '--security-path', path.join(BASE, 'voice-security'),
    '--force-resolved-versions', '-c', 'release', '--triple', 'arm64-apple-macosx14.0',
    '-Xswiftc', '-target', '-Xswiftc', TARGET];
  const voiceEnv = ['HOME=' + testHome, 'CLANG_MODULE_CACHE_PATH=' + cache, 'SWIFTPM_MODULECACHE_OVERRIDE=' + cache,
    'MACOSX_DEPLOYMENT_TARGET=14.0', '/usr/bin/xcrun'];
  run('/usr/bin/env', [...voiceEnv, ...voiceArgs]);
  const products = run('/usr/bin/env', [...voiceEnv, ...voiceArgs, '--show-bin-path']).toString().trim();
  const voice = path.join(contents, 'Helpers/NikVoice.app/Contents');
  fs.mkdirSync(path.join(voice, 'MacOS'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(voice, 'Resources'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(products, 'nikui-voice'), path.join(voice, 'MacOS/nikui-voice'));
  fs.cpSync(path.join(products, 'FluidAudio_FluidAudio.bundle'), path.join(voice, 'Resources/FluidAudio_FluidAudio.bundle'), { recursive: true });
  fs.copyFileSync(path.join(voiceBuild, 'checkouts/FluidAudio/LICENSE'), path.join(voice, 'Resources/FluidAudio-LICENSE'));
  fs.writeFileSync(path.join(voice, 'Info.plist'), plist([entry('CFBundleIdentifier', LABEL + '.voice'),
    entry('CFBundleExecutable', 'nikui-voice'), entry('CFBundleName', 'NikEngine Dev Voice'),
    entry('CFBundlePackageType', 'APPL'), entry('CFBundleVersion', '1'), entry('LSMinimumSystemVersion', '14.0'),
    '<key>LSBackgroundOnly</key><true/>'].join('\n')));
  fs.cpSync(path.join(REPO, 'voice'), path.join(engine, 'voice'), { recursive: true, filter: (source) => !source.split(path.sep).includes('.build') });
  sign(path.join(engine, 'node'), identity, path.join(REPO, 'helpers/mac-engine/node.entitlements'));
  sign(path.join(contents, 'MacOS/nikd'), identity);
  sign(path.dirname(notifier), identity);
  sign(path.dirname(voice), identity);
  const manifest = { version: 1, label: LABEL, target: TARGET, minimumOS: '14.0',
    node: { version: NODE_VERSION, arch: 'darwin-arm64', archive: NODE_ARCHIVE, sha256: NODE_SHA256,
      source: `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}`, archiveVerified: true, originalMinimumOS: '13.5' },
    keychain: { backend: keychain.backend, servicePrefix: keychain.servicePrefix },
    helpers: { notifier: 'signed; disabled in isolated runtime', voice: 'signed FluidAudio 0.17.5; resources retained; no models; disabled in isolated runtime' }, files: {} };
  function inventory(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Bundle input contains a symlink');
      // The outer signature binds both this manifest and the main executable;
      // hashing that executable here would create a circular resource seal.
      if (file === executable || file.startsWith(path.join(contents, '_CodeSignature') + path.sep)) continue;
      if (stat.isDirectory()) inventory(file);
      else manifest.files[path.relative(contents, file)] = hash(file);
    }
  }
  inventory(contents);
  fs.writeFileSync(path.join(engine, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  sign(output, identity);
  // Fresh inode after swiftc/ad-hoc signing avoids stale kernel signature caches.
  for (const file of [executable, path.join(contents, 'MacOS/nikd'), path.join(engine, 'node'), path.join(notifier, 'MacOS/nikui-notify'), path.join(voice, 'MacOS/nikui-voice')]) {
    fs.copyFileSync(file, file + '.fresh'); fs.chmodSync(file + '.fresh', 0o700); fs.renameSync(file + '.fresh', file);
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', output]);
  const signature = spawnSync('/usr/bin/codesign', ['-dvv', output], { encoding: 'utf8' }).stderr;
  if (!/^TeamIdentifier=[A-Z0-9]{10}$/m.test(signature) || !/flags=.*runtime/.test(signature)) throw new Error('Development identity and hardened runtime required');
  return { output, executable, ...config, node: manifest.node, keychainHelper: keychain.executable };
}
if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--output': 'output', '--test-home': 'testHome', '--identity': 'identity' }[args[i]];
    if (!key || !args[i + 1]) throw new Error('Usage: build-mac-engine.sh [--output /tmp/nik-mac/build/name.app] [--test-home /tmp/nik-mac/build/test-home] [--identity identity]');
    options[key] = args[i + 1];
  }
  try { process.stdout.write(JSON.stringify(build(options)) + '\n'); }
  catch (error) { process.stderr.write(String(error.stderr || error.message) + '\n'); process.exitCode = 1; }
}
module.exports = { build, NODE_VERSION, NODE_SHA256, TARGET, LABEL };
