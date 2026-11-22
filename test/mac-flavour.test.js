'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { identityForBuild, validatePackage, PRODUCTION_SERVICE } = require('../src/macFlavour');
const { buildPlan, BASE } = require('../scripts/build-mac-app');
const accountHome = '/Users/fixture-owner', engine = '/fixture/NikUI.app/Contents/Resources/engine';
const code = (fn) => { try { fn(); return null; } catch (error) { return error.code || error.message; } };
const runtime = (plan) => ({ accountHome, envHome: plan.flavour === 'dev' ? plan.testHome : accountHome,
  args: ['--root', plan.config.root || accountHome + '/Library/Application Support/NikUI/engine'], execPath: engine + '/node', engine });

// Run the actual package entrypoint with an I/O trap. Metadata reads are
// allowed; every selected-root, Keychain or runtime effect is counted.
function packagedEntry(identity, config, envHome, args) {
  const effects = [], module = { exports: {} };
  const fakeRequire = (name) => {
    if (name === 'fs') return { readFileSync(file) {
      if (file !== engine + '/mac-engine.json') throw new Error('unexpected read');
      return JSON.stringify(config);
    }, realpathSync: () => engine + '/node' };
    if (name === 'path') return path;
    if (name === 'os') return { userInfo: () => ({ homedir: accountHome }) };
    if (name === './macBuildIdentity') return identity;
    if (name === './macFlavour') return require('../src/macFlavour');
    if (name === './productionOwnership') return { committedOwnership() { throw Object.assign(new Error('unconfigured'), { code: 'SOURCE_HANDSHAKE_UNAVAILABLE' }); } };
    if (name === './daemonPaths') return { ...require('../src/daemonPaths'),
      privateDirectory: () => effects.push('directory'), privateRoot: () => { effects.push('root'); return {}; },
      checkPrivateTree: () => effects.push('tree') };
    if (name === './keychainStore') return { createSecItemAdapter: () => effects.push('keychain') };
    throw new Error('Unexpected runtime import: ' + name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/macEngine.js'), 'utf8'), {
    require: fakeRequire, module, __dirname: engine + '/src',
    process: { argv: ['node', 'macEngine.js'], execPath: engine + '/node', env: { HOME: envHome, NIKUI_FLAVOUR: 'dev', NIKUI_NATIVE_TESTS: '1' } }
  });
  return { effects, failure: code(() => module.exports.packageConfiguration(args)) };
}

module.exports = () => {
  suite('P3 compiled Mac flavour isolation');
  const prod = buildPlan({ flavour: 'prod' }), dev = buildPlan({ flavour: 'dev' });
  checkEqual('production app and engine identities differ deliberately', [prod.appID, prod.label], ['com.nikui.app', 'com.nikui.engine']);
  checkEqual('development has separate app and engine identities', [dev.appID, dev.label], ['com.nikui.app.dev', 'com.nikui.engine.development']);
  checkEqual('both default products live under p3', [prod.output, dev.output], [BASE + '/NikUI.app', BASE + '/NikUI Dev.app']);
  check('production manifest has no selectable HOME/root', !Object.hasOwn(prod.config, 'testHome') && !Object.hasOwn(prod.config, 'root'));
  checkEqual('production selected Keychain service is stable', prod.config.keychainService, PRODUCTION_SERVICE);
  checkEqual('development manifest namespace is reproducible for a fixed HOME', dev.config, buildPlan({ flavour: 'dev' }).config);
  checkEqual('missing flavour refuses before build effects', code(() => buildPlan()), 'BUILD_FLAVOUR_REQUIRED');
  checkEqual('unknown flavour refuses before build effects', code(() => buildPlan({ flavour: 'production' })), 'BUILD_FLAVOUR_REQUIRED');
  for (const extra of [{ testHome: dev.testHome }, { acceptanceP2: true }, { acceptanceP2: true, acceptanceRealTools: true }, { acceptanceCutover: true }]) {
    checkEqual('production refuses test build options ' + Object.keys(extra), code(() => buildPlan({ flavour: 'prod', ...extra })), 'PRODUCTION_TEST_OPTIONS_FORBIDDEN');
  }
  for (const options of [{ output: '/Applications/NikUI.app' }, { output: '/tmp/nik-mac/build/p3/../escape.app' }, { version: '1.0\n' }, { buildNumber: '0' }]) {
    check('invalid output/version/build refuses: ' + JSON.stringify(options), code(() => buildPlan({ flavour: 'prod', ...options })) !== null);
  }
  checkEqual('P2 builder can never build production', code(() => require('../scripts/build-mac-engine').build({ flavour: 'prod' })), 'DEVELOPMENT_PROFILE_ONLY');
  const selected = validatePackage(identityForBuild('prod'), prod.config, runtime(prod));
  checkEqual('production runtime selects account-derived persistent root', selected.root, accountHome + '/Library/Application Support/NikUI/engine');
  checkEqual('development runtime keeps its sealed private profile', validatePackage(identityForBuild('dev'), dev.config, runtime(dev)).root, dev.config.root);
  for (const [name, config] of [
    ['test HOME', { ...prod.config, testHome: dev.testHome }], ['test root', { ...prod.config, root: dev.config.root }],
    ['fixture', { ...prod.config, acceptanceP2: true }], ['real tools', { ...prod.config, acceptanceRealTools: true }], ['cutover rehearsal', { ...prod.config, acceptanceCutover: true }],
    ['test Keychain', { ...prod.config, keychainService: dev.config.keychainService }]
  ]) {
    checkEqual('production rejects ' + name, code(() => validatePackage(identityForBuild('prod'), config, runtime(prod))), 'PRODUCTION_ROOT_INVALID');
    const trapped = packagedEntry(identityForBuild('prod'), config, accountHome, runtime(prod).args);
    checkEqual('package refuses ' + name + ' before selected-root/Keychain effects', [trapped.failure, trapped.effects], ['PRODUCTION_ROOT_INVALID', []]);
  }
  for (const [name, extra] of [
    ['test-root argv', { args: ['--root', dev.config.root] }], ['test HOME environment', { envHome: dev.testHome }],
    ['external Node', { execPath: '/opt/homebrew/bin/node' }], ['flavour CLI switch', { args: ['--flavour', 'dev'] }]
  ]) checkEqual('production refuses runtime ' + name, code(() => validatePackage(identityForBuild('prod'), prod.config, { ...runtime(prod), ...extra })), 'PACKAGE_CONFIGURATION');
  checkEqual('prod source identity rejects a complete dev manifest', code(() => validatePackage(identityForBuild('prod'), dev.config, runtime(dev))), 'PACKAGE_CONFIGURATION');
  checkEqual('dev source identity rejects production manifest', code(() => validatePackage(identityForBuild('dev'), prod.config, runtime(prod))), 'PACKAGE_CONFIGURATION');
  checkEqual('dev can never select production label', code(() => validatePackage(identityForBuild('dev'), { ...dev.config, label: prod.label }, runtime(dev))), 'PACKAGE_CONFIGURATION');
  for (const home of ['/tmp/test', '/private/tmp/nik-mac/build/p3/dev-home', '/Users/Shared/fixture', '/Users/owner/../test']) {
    checkEqual('production refuses non-account/test root ' + home, code(() => validatePackage(identityForBuild('prod'), prod.config, { ...runtime(prod), accountHome: home })), 'PRODUCTION_ROOT_INVALID');
  }
  const inert = packagedEntry(identityForBuild('prod'), prod.config, accountHome, runtime(prod).args);
  checkEqual('unconfigured production never enters synthetic composition or touches storage', inert, { effects: [], failure: 'SOURCE_HANDSHAKE_UNAVAILABLE' });
  for (const [home, args] of [[dev.testHome, runtime(prod).args], [accountHome, runtime(dev).args]]) {
    const refused = packagedEntry(identityForBuild('prod'), prod.config, home, args);
    checkEqual('actual package refuses test environment/argv without storage effects', [refused.failure, refused.effects], ['PACKAGE_CONFIGURATION', []]);
  }
  checkEqual('development build refuses overlong socket paths before output creation', code(() => buildPlan({ flavour: 'dev', testHome: BASE + '/' + 'a'.repeat(100) })), 'SOCKET_PATH_TOO_LONG');
  const longHome = '/Users/' + 'a'.repeat(100);
  checkEqual('production refuses overlong socket without falling back to a test path', code(() => validatePackage(identityForBuild('prod'), prod.config,
    { ...runtime(prod), accountHome: longHome, envHome: longHome, args: ['--root', longHome + '/Library/Application Support/NikUI/engine'] })), 'SOCKET_PATH_TOO_LONG');
};
