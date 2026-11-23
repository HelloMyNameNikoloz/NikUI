#!/usr/bin/env node
'use strict';

const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { noSymlinks, privateDirectory, inside } = require('../src/daemonPaths');
const { buildKeychainHelper, signingKeychainArgs } = require('./build-keychain-helper');
const { identityForBuild, PRODUCTION_SERVICE } = require('../src/macFlavour');
const REPO = path.resolve(__dirname, '..'), BASE = '/private/tmp/nik-mac/build/p3';
const NODE_VERSION = 'v26.7.0', NODE_ARCHIVE = `node-${NODE_VERSION}-darwin-arm64.tar.gz`;
const NODE_SHA256 = '7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4';
const TARGET = 'arm64-apple-macos14.0', TEAM = 'KBA6653B4V';
const IDENTITY_SOURCE = path.join(REPO, 'app/mac/NikMenuBar/Sources/NikMacIdentity/BuildIdentity.swift');
const run = (file, args) => execFileSync(file, args, { stdio: 'pipe', timeout: 10 * 60 * 1000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const plist = (body) => '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n' + body + '\n</dict></plist>\n';
const entry = (key, value) => `<key>${key}</key><string>${xml(value)}</string>`;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceInputs() {
  const files = {};
  function walk(relative) {
    const file = path.join(REPO, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Build input contains a symlink: ' + relative);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!['.build', '.swiftpm', '.git', 'Tests'].includes(name)) walk(path.join(relative, name));
      }
    } else files[relative] = hash(file);
  }
  for (const relative of ['src', 'media', 'app/mac/NikMenuBar', 'app/iphone/NikCore', 'helpers/mac-engine',
    'helpers/keychain', 'notifier', 'voice', 'scripts/build-mac-app.js', 'scripts/build-keychain-helper.js', 'package.json',
    'app/iphone/NikUI/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png']) walk(relative);
  return files;
}
function compile(source, output, cache, flavour, sharedIdentity = false) {
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  run('/usr/bin/xcrun', ['swiftc', '-O', '-target', TARGET, '-module-cache-path', cache,
    '-D', flavour === 'prod' ? 'NIKUI_PRODUCTION' : 'NIKUI_DEVELOPMENT',
    ...(sharedIdentity ? [IDENTITY_SOURCE] : []), source, '-o', output]);
}
function compileMenu(output, buildHome, cache, flavour) {
  const args = ['swift', 'build', '--disable-sandbox', '--package-path', path.join(REPO, 'app/mac/NikMenuBar'),
    '--scratch-path', path.join(BASE, flavour + '-app-build'), '--cache-path', path.join(BASE, 'menubar-cache'),
    '--config-path', path.join(BASE, 'menubar-config'), '--security-path', path.join(BASE, 'menubar-security'),
    '-c', 'release', '--product', 'NikEngine', '--triple', 'arm64-apple-macosx14.0',
    '-Xswiftc', '-target', '-Xswiftc', TARGET, '-Xswiftc', '-D' + (flavour === 'prod' ? 'NIKUI_PRODUCTION' : 'NIKUI_DEVELOPMENT')];
  const env = ['HOME=' + buildHome, 'CLANG_MODULE_CACHE_PATH=' + cache, 'SWIFTPM_MODULECACHE_OVERRIDE=' + cache,
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
function buildIcon(resources) {
  const work = fs.mkdtempSync(path.join(BASE, 'icon-'));
  const source = path.join(REPO, 'app/iphone/NikUI/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
  try {
    const chunks = [];
    // PNG-backed ICNS entries; package the established NikUI artwork without
    // IconServices registration or an iconutil dependency on GUI services.
    for (const [size, type] of [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']]) {
      const file = path.join(work, size + '.png');
      run('/usr/bin/sips', ['-z', String(size), String(size), source, '--out', file]);
      const png = fs.readFileSync(file), header = Buffer.alloc(8);
      header.write(type, 'ascii'); header.writeUInt32BE(png.length + 8, 4); chunks.push(header, png);
    }
    const header = Buffer.alloc(8); header.write('icns', 'ascii');
    header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    fs.writeFileSync(path.join(resources, 'NikUI.icns'), Buffer.concat([header, ...chunks]));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
function buildPlan({ flavour, output, testHome, identity = 'Apple Development', acceptanceP2 = false, acceptanceRealTools = false, acceptanceCutover = false,
  version = require('../package.json').macApp.version, buildNumber = require('../package.json').macApp.buildNumber } = {}) {
  const selected = identityForBuild(flavour);
  if (typeof acceptanceP2 !== 'boolean' || typeof acceptanceRealTools !== 'boolean' || typeof acceptanceCutover !== 'boolean' || (acceptanceRealTools && !acceptanceP2) || acceptanceCutover && acceptanceP2) throw new Error('Invalid acceptance build selection');
  if (flavour === 'prod' && (testHome !== undefined || acceptanceP2 || acceptanceRealTools || acceptanceCutover)) throw new Error('PRODUCTION_TEST_OPTIONS_FORBIDDEN');
  if (typeof version !== 'string' || typeof buildNumber !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
      !/^[1-9][0-9]{0,8}$/.test(buildNumber) || /[\r\n]/.test(version + buildNumber)) throw new Error('Explicit semantic version and positive build number required');
  output ??= path.join(BASE, selected.appName + '.app');
  if (flavour === 'dev') testHome ??= path.join(BASE, 'dev-home');
  if (!path.isAbsolute(output) || (testHome !== undefined && !path.isAbsolute(testHome))) throw new Error('Absolute build paths required');
  noSymlinks(output); if (testHome !== undefined) noSymlinks(testHome);
  output = path.resolve(output).replace(/^\/tmp\//, '/private/tmp/');
  if (testHome !== undefined) testHome = path.resolve(testHome).replace(/^\/tmp\//, '/private/tmp/');
  if (!inside(BASE, output) || output === BASE || !output.endsWith('.app') ||
    (testHome !== undefined && (!inside(BASE, testHome) || testHome === BASE || inside(output, testHome) || inside(testHome, output))) ||
    inside(REPO, output) || !identity) throw new Error('Explicit separate outputs under /tmp/nik-mac/build required');
  const config = { version: 2, flavour, appID: selected.appID, label: selected.label, testOnly: flavour === 'dev',
    acceptanceP2, acceptanceRealTools, acceptanceCutover,
    ...(flavour === 'dev' ? { testHome, root: testHome + '/profile',
      keychainService: 'com.nikui.engine.test.' + crypto.createHash('sha256').update(testHome).digest('hex').slice(0, 32) }
      : { keychainService: PRODUCTION_SERVICE }) };
  if (config.root && Buffer.byteLength(config.root + '/c.sock') >= 104) throw new Error('SOCKET_PATH_TOO_LONG');
  return { ...selected, output, testHome, identity, config, version, buildNumber };
}
function build(options = {}) {
  const plan = buildPlan(options), { output } = plan;
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('arm64 macOS required');
  if (fs.existsSync(output)) throw new Error('Bundle exists: choose a fresh output or remove only your unregistered build before rebuilding');
  privateDirectory(BASE); privateDirectory(path.dirname(output));
  // Exclusive reservation: concurrent builds never share or remove an output.
  fs.mkdirSync(output, { mode: 0o700 });
  try { return assemble(plan, sourceInputs()); }
  catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
}
function assemble(plan, inputs) {
  const { output, testHome, identity, flavour, config, version, buildNumber, appID, label: LABEL, appName } = plan;
  const buildHome = path.join(BASE, 'build-home'); privateDirectory(buildHome);
  if (flavour === 'dev') {
    privateDirectory(testHome); privateDirectory(path.join(testHome, 'tmp')); privateDirectory(config.root);
  }
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
  buildIcon(path.join(contents, 'Resources'));
  // Extract on every build into a new directory: never trust a modified cache binary.
  const unpack = fs.mkdtempSync(path.join(download, 'verified-'));
  try {
    run('/usr/bin/tar', ['-xzf', archive, '-C', unpack]);
    fs.copyFileSync(path.join(unpack, `node-${NODE_VERSION}-darwin-arm64/bin/node`), path.join(engine, 'node'));
    fs.copyFileSync(path.join(unpack, `node-${NODE_VERSION}-darwin-arm64/LICENSE`), path.join(engine, 'NODE-LICENSE'));
  } finally { fs.rmSync(unpack, { recursive: true, force: true }); }
  for (const name of ['src', 'media']) fs.cpSync(path.join(REPO, name), path.join(engine, name), { recursive: true, dereference: false });
  // Generated source is a literal, sealed together with macEngine.js. JSON is
  // redundant metadata that must agree, never a runtime flavour selector.
  fs.writeFileSync(path.join(engine, 'src/macBuildIdentity.js'), "'use strict';\nmodule.exports = Object.freeze(" +
    JSON.stringify({ flavour, appID, label: LABEL }) + ');\n');
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(engine, 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(engine, 'package.json')));
  if (Object.keys(pkg.dependencies || {}).length) throw new Error('Runtime dependencies require an explicit packaging disposition');
  privateDirectory(path.join(contents, 'Helpers'));
  const keychain = buildKeychainHelper({ output: path.join(contents, 'Helpers/NikKeychain.app'), identity, moduleCache: cache, flavour });
  if (flavour === 'dev') buildKeychainHelper({ output: path.join(contents, 'Helpers/NikKeychainRebuilt.app'), identity, moduleCache: cache, version: '2', flavour });
  fs.writeFileSync(path.join(engine, 'mac-engine.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const executable = path.join(contents, 'MacOS/NikUI');
  compileMenu(executable, buildHome, cache, flavour);
  compile(path.join(REPO, 'helpers/mac-engine/launcher.swift'), path.join(contents, 'MacOS/nikd'), cache, flavour, true);
  const info = plist([entry('CFBundleIdentifier', appID), entry('CFBundleExecutable', 'NikUI'),
    entry('CFBundleName', appName), entry('CFBundleDisplayName', appName), entry('CFBundlePackageType', 'APPL'), entry('CFBundleVersion', buildNumber),
    entry('CFBundleShortVersionString', version), entry('LSMinimumSystemVersion', '14.0'),
    entry('CFBundleIconFile', 'NikUI.icns'), entry('LSApplicationCategoryType', 'public.app-category.developer-tools'),
    entry('NSPrincipalClass', 'NSApplication'), entry('NikBuildFlavour', flavour), entry('NikEngineLabel', LABEL),
    ...(flavour === 'dev' ? [entry('NikEngineTestHome', testHome), entry('NikEngineTestRoot', config.root)] : [])].join('\n'));
  fs.writeFileSync(path.join(contents, 'Info.plist'), info);
  const agents = path.join(contents, 'Library/LaunchAgents'); fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agents, LABEL + '.plist'), plist([
    entry('Label', LABEL), entry('BundleProgram', 'Contents/MacOS/nikd'), '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>', entry('ProcessType', 'Interactive'),
    `<key>AssociatedBundleIdentifiers</key><array><string>${appID}</string></array>`,
    ...(flavour === 'dev' ? [entry('WorkingDirectory', testHome), entry('StandardOutPath', path.join(testHome, 'engine.stdout.log')),
    entry('StandardErrorPath', path.join(testHome, 'engine.stderr.log')),
    `<key>EnvironmentVariables</key><dict>${entry('HOME', testHome)}${entry('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')}</dict>`] : [])
  ].join('\n')));
  // Retain the actual notifier under this flavour's distinct identity. No
  // permission prompt, registration or notification is issued by the build.
  const notifier = path.join(contents, 'Helpers/NikNotifier.app/Contents');
  compile(path.join(REPO, 'notifier/main.swift'), path.join(notifier, 'MacOS/nikui-notify'), cache, flavour);
  fs.writeFileSync(path.join(notifier, 'Info.plist'), plist([entry('CFBundleIdentifier', LABEL + '.notifier'),
    entry('CFBundleExecutable', 'nikui-notify'), entry('CFBundleName', appName + ' Notifications'),
    entry('CFBundlePackageType', 'APPL'), entry('CFBundleVersion', '1'), entry('LSMinimumSystemVersion', '14.0'),
    '<key>LSUIElement</key><true/>', entry('NSPrincipalClass', 'NSApplication')].join('\n')));
  // Build the pinned real voice helper; models and user caches are never copied.
  const voiceBuild = path.join(BASE, flavour + '-voice-build');
  const voiceArgs = ['swift', 'build', '--disable-sandbox', '--package-path', path.join(REPO, 'voice'),
    '--scratch-path', voiceBuild, '--cache-path', path.join(BASE, 'voice-cache'),
    '--config-path', path.join(BASE, 'voice-config'), '--security-path', path.join(BASE, 'voice-security'),
    '--force-resolved-versions', '-c', 'release', '--triple', 'arm64-apple-macosx14.0',
    '-Xswiftc', '-target', '-Xswiftc', TARGET, '-Xswiftc', '-D' + (flavour === 'prod' ? 'NIKUI_PRODUCTION' : 'NIKUI_DEVELOPMENT')];
  const voiceEnv = ['HOME=' + buildHome, 'CLANG_MODULE_CACHE_PATH=' + cache, 'SWIFTPM_MODULECACHE_OVERRIDE=' + cache,
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
    entry('CFBundleExecutable', 'nikui-voice'), entry('CFBundleName', appName + ' Voice'),
    entry('CFBundlePackageType', 'APPL'), entry('CFBundleVersion', '1'), entry('LSMinimumSystemVersion', '14.0'),
    '<key>LSBackgroundOnly</key><true/>'].join('\n')));
  fs.cpSync(path.join(REPO, 'voice'), path.join(engine, 'voice'), { recursive: true, filter: (source) => !source.split(path.sep).includes('.build') });
  sign(path.join(engine, 'node'), identity, path.join(REPO, 'helpers/mac-engine/node.entitlements'));
  sign(path.join(contents, 'MacOS/nikd'), identity);
  sign(path.dirname(notifier), identity);
  sign(path.dirname(voice), identity);
  const manifest = { version: 2, flavour, appID, label: LABEL, appVersion: version, buildNumber, target: TARGET, minimumOS: '14.0', team: TEAM,
    inputs: { revision: run('/usr/bin/git', ['-C', REPO, 'rev-parse', 'HEAD']).toString().trim(),
      swift: run('/usr/bin/xcrun', ['swiftc', '--version']).toString().trim(), sources: inputs,
      voiceResolvedSHA256: hash(path.join(REPO, 'voice/Package.resolved')) },
    node: { version: NODE_VERSION, arch: 'darwin-arm64', archive: NODE_ARCHIVE, sha256: NODE_SHA256,
      source: `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}`, archiveVerified: true, originalMinimumOS: '13.5' },
    keychain: { backend: keychain.backend, servicePrefix: keychain.servicePrefix },
    helpers: { notifier: 'signed; permission requested only by explicit user choice', voice: 'signed FluidAudio 0.17.5; resources retained; no models' }, files: {} };
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
  if (JSON.stringify(inputs) !== JSON.stringify(sourceInputs())) throw new Error('BUILD_INPUTS_CHANGED: retry from stable sources');
  inventory(contents);
  fs.writeFileSync(path.join(engine, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  sign(output, identity);
  // Fresh inode after swiftc/ad-hoc signing avoids stale kernel signature caches.
  for (const file of [executable, path.join(contents, 'MacOS/nikd'), path.join(engine, 'node'), path.join(notifier, 'MacOS/nikui-notify'), path.join(voice, 'MacOS/nikui-voice')]) {
    fs.copyFileSync(file, file + '.fresh'); fs.chmodSync(file + '.fresh', 0o700); fs.renameSync(file + '.fresh', file);
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', output]);
  const signature = spawnSync('/usr/bin/codesign', ['-dvv', output], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' }).stderr;
  if (!signature.includes('TeamIdentifier=' + TEAM) || !/Authority=Apple Development:/.test(signature) || !/flags=.*runtime/.test(signature)) throw new Error('Team KBA6653B4V Apple Development identity and hardened runtime required');
  return { output, executable, ...config, appVersion: version, buildNumber, node: manifest.node, keychainHelper: keychain.executable };
}
if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--flavour': 'flavour', '--output': 'output', '--test-home': 'testHome', '--identity': 'identity', '--version': 'version', '--build-number': 'buildNumber' }[args[i]];
    if (!key || !args[i + 1] || Object.hasOwn(options, key)) throw new Error('Usage: build-mac-app.sh --flavour prod|dev [--output /tmp/nik-mac/build/p3/name.app] [--test-home dev-home] [--identity identity] [--version 1.0.0] [--build-number 1]');
    options[key] = args[i + 1];
  }
  try { process.stdout.write(JSON.stringify(build(options)) + '\n'); }
  catch (error) { process.stderr.write(String(error.stderr || error.message) + '\n'); process.exitCode = 1; }
}
module.exports = { build, buildPlan, NODE_VERSION, NODE_SHA256, TARGET, BASE, TEAM };
