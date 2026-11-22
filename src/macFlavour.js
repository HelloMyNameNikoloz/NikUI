'use strict';

// Pure policy shared by the packager and packaged entrypoint. These functions
// validate a compiled identity; they never select one from runtime input.
const path = require('path');
const { fail } = require('./daemonPaths');
const BASE = '/private/tmp/nik-mac/build';
const PRODUCTION_SERVICE = 'com.nikui.engine.production.selected-store-v1';
const IDENTITIES = Object.freeze({
  prod: Object.freeze({ flavour: 'prod', appID: 'com.nikui.app', label: 'com.nikui.engine', appName: 'NikUI' }),
  dev: Object.freeze({ flavour: 'dev', appID: 'com.nikui.app.dev', label: 'com.nikui.engine.development', appName: 'NikUI Dev' })
});
const canonical = (value) => typeof value === 'string' && value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value) && path.resolve(value) === value;
function identityForBuild(flavour) {
  if (!Object.hasOwn(IDENTITIES, flavour)) throw fail('BUILD_FLAVOUR_REQUIRED', 'Select --flavour prod or dev at build time');
  return IDENTITIES[flavour];
}
function validatePackage(identity, config, { accountHome, envHome, args, execPath, engine }) {
  const expected = identityForBuild(identity.flavour);
  if (identity.appID !== expected.appID || identity.label !== expected.label || config.version !== 2 ||
      config.flavour !== expected.flavour || config.appID !== expected.appID || config.label !== expected.label ||
      config.testOnly !== (expected.flavour === 'dev') || !engine || execPath !== path.join(engine, 'node')) {
    throw fail('PACKAGE_CONFIGURATION', 'Compiled package identity disagrees');
  }
  let home, root;
  if (expected.flavour === 'prod') {
    if (!canonical(accountHome) || !accountHome.startsWith('/Users/') || accountHome === '/Users/Shared' || accountHome.startsWith('/Users/Shared/') ||
        ['testHome', 'root'].some((k) => Object.hasOwn(config, k)) || config.acceptanceP2 !== false || config.acceptanceRealTools !== false || config.acceptanceCutover !== false ||
        config.keychainService !== PRODUCTION_SERVICE) throw fail('PRODUCTION_ROOT_INVALID', 'Production cannot select test roots or fixtures');
    home = accountHome; root = path.join(home, 'Library/Application Support/NikUI/engine');
  } else {
    home = config.testHome; root = config.root;
    if (!canonical(home) || !canonical(root) || !home.startsWith(BASE + '/') || root !== home + '/profile' ||
        !/^com\.nikui\.engine\.test\.[a-f0-9]{32}$/.test(config.keychainService) ||
        typeof config.acceptanceP2 !== 'boolean' || typeof config.acceptanceRealTools !== 'boolean' || typeof config.acceptanceCutover !== 'boolean' ||
        (config.acceptanceRealTools && !config.acceptanceP2)) throw fail('EXPLICIT_TEST_HOME_REQUIRED', 'Development requires its sealed private profile');
  }
  if (envHome !== home || !Array.isArray(args) || args.length !== 2 || args[0] !== '--root' || args[1] !== root) {
    throw fail('PACKAGE_CONFIGURATION', 'Runtime cannot override the selected HOME/root');
  }
  if (Buffer.byteLength(root + '/c.sock') >= 104) throw fail('SOCKET_PATH_TOO_LONG', 'Selected control socket exceeds the macOS path bound');
  return Object.freeze({ home, root, ...expected });
}
module.exports = { identityForBuild, validatePackage, PRODUCTION_SERVICE, BASE };
