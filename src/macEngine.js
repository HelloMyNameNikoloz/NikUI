#!/usr/bin/env node
'use strict';

// The signed package entrypoint. The compiled source identity is independent
// of the JSON manifest. Validate both before any selected-root/Keychain I/O.
const fs = require('fs');
const path = require('path');
const { fail, privateDirectory, privateRoot, privateFile, readPrivateJson, checkPrivateTree } = require('./daemonPaths');
const { createSecItemAdapter, createKeychainStore } = require('./keychainStore');
const compiledIdentity = require('./macBuildIdentity');
const { validatePackage } = require('./macFlavour');

function packageConfiguration(args = process.argv.slice(2)) {
  const engine = path.resolve(__dirname, '..'), contents = path.resolve(engine, '../..');
  const config = JSON.parse(fs.readFileSync(path.join(engine, 'mac-engine.json'), 'utf8'));
  const selection = validatePackage(compiledIdentity, config, { accountHome: require('os').userInfo().homedir,
    envHome: process.env.HOME, args, execPath: fs.realpathSync(process.execPath), engine });
  // Production never enters P2's isolated composition. Check the committed
  // source lease before creating storage or opening the selected Keychain.
  if (selection.flavour === 'prod') {
    const ownership = require('./productionOwnership').committedOwnership(selection.root);
    const paths = privateRoot(selection.root, { create: false });
    const adapter = createSecItemAdapter({ helper: path.join(contents, 'Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
      home: selection.home, service: config.keychainService });
    return { config, selection, ownership, paths, adapter, contents };
  }
  privateDirectory(config.testHome, false);
  const paths = privateRoot(config.root);
  checkPrivateTree(paths.root);
  const adapter = createSecItemAdapter({ helper: path.join(contents, 'Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
    home: config.testHome, service: config.keychainService });
  return { config, selection, paths, adapter, contents };
}

async function main() {
  const configuration = packageConfiguration();
  try {
    require('./cutoverRecovery').remove(path.join(configuration.selection.root, 'engine-startup-failure.json'));
    return await runPackage(configuration);
  } catch (error) {
    try { require('./engineStartup').recordFailure(configuration, error); } catch (_) { /* stderr remains available */ }
    throw error;
  }
}
async function runPackage({ config, selection, adapter, paths, contents }) {
  if (selection.flavour === 'prod' || config.acceptanceCutover === true) {
    let daemon, requested = false;
    let stopping;
    const stop = () => stopping ||= (async () => {
      if (!daemon) return;
      await daemon.stop();
      // The package process owns this lifecycle. A completed intentional drain
      // must exit successfully even if a native/client handle outlives it;
      // launchd KeepAlive restarts only unsuccessful exits. Custody is separate.
      process.exit(0);
    })();
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      requested = true;
      if (daemon) void stop().catch(() => { process.exitCode = 1; });
    });
    let dependencies = {};
    if (selection.flavour === 'dev') {
      // This branch exists only behind the signed development configuration;
      // production validation rejects it before any selected-root effects.
      const fixture = require('./acceptanceFixture').createAcceptanceFixture({ root: selection.root, testOnly: true });
      dependencies = { account: () => ({ homedir: selection.home }), paths: selection,
        resolver: { resolveAll: async () => ({ tools: Object.fromEntries(['claude', 'codex', 'node', 'gh'].map((name) => [name,
          { path: path.join(selection.home, 'fixture-' + name), status: 'resolved', source: 'configured' }])), childEnv: { PATH: '/usr/bin:/bin' } }) },
        spawn: (file, ...args) => (file.endsWith('codex') ? fixture.adapters.codexSpawn : fixture.adapters.claudeSpawn)(file, ...args),
        power: require('./policyOwner').createFakePolicyAdapters().power,
        prRun: async () => ({ ok: false, stdout: '', code: 'FIXTURE_PR_UNAVAILABLE' }) };
      const fixtureTailnet = path.join(selection.home, 'fixture-bin/tailscale');
      if (fs.existsSync(fixtureTailnet)) dependencies.tailscale = new (require('./tunnel').Tailscale)({ binary: fixtureTailnet, probe: async () => true });
    }
    dependencies.startupProgress = (phase) => require('./engineOwner').atomicJson(path.join(selection.root, 'engine-startup-progress.json'),
      { version: 1, pid: process.pid, at: Date.now(), phase });
    dependencies.startupProgress('composition');
    daemon = await require('./productionRuntime').startProductionRuntime({ selection, secretAdapter: adapter, dependencies });
    dependencies.startupProgress('running');
    if (requested) await stop();
    return daemon;
  }
  // This package is exclusively a signed, randomly namespaced TEST profile.
  // A durable marker permits exactly one synthetic initialization. Later
  // missing/locked/denied items refuse; crashes never regenerate selected pins.
  const marker = path.join(paths.root, 'test-keychain-selection.json');
  if (!privateFile(marker, { optional: true })) {
    const fd = fs.openSync(marker, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, service: config.keychainService, phase: 'initializing' }) + '\n'); fs.fsyncSync(fd);
      const values = {}, memory = { get: (key) => values[key], update: (key, value) => { values[key] = value; } };
      const identity = require('./identity').loadIdentity(memory), vapid = require('./push').loadVapid(memory);
      values['nikd.selection'] = { fingerprint: identity.fingerprint, applicationServerKey: vapid.applicationServerKey };
      const store = createKeychainStore({ adapter, create: true, initial: values }); store.dispose();
      const selected = Buffer.from(JSON.stringify({ version: 1, service: config.keychainService, phase: 'selected', selection: values['nikd.selection'] }) + '\n');
      fs.ftruncateSync(fd, 0); fs.writeSync(fd, selected, 0, selected.length, 0); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  const selected = readPrivateJson(marker);
  if (selected.version !== 1 || selected.service !== config.keychainService || selected.phase !== 'selected') {
    throw fail('PACKAGE_CONFIGURATION', 'Test profile initialization is incomplete or belongs to another package');
  }
  const existing = createKeychainStore({ adapter });
  try {
    const pins = existing.get('nikd.selection');
    if (!pins || pins.fingerprint !== selected.selection?.fingerprint || pins.applicationServerKey !== selected.selection?.applicationServerKey) {
      throw fail('IDENTITY_UNAVAILABLE', 'The selected test identity changed; no regeneration');
    }
  } finally { existing.dispose(); }
  // Sealed by codesign; inherited environment/control requests cannot opt in.
  // These adapters can only simulate providers.
  const rehearsal = config.acceptanceP2 === true ? require('./acceptanceFixture').createAcceptanceFixture({ root: config.root,
    testOnly: true, allowRealTools: config.acceptanceRealTools === true, secretAdapter: adapter }) : null;
  if (rehearsal) { process.on('SIGTERM', rehearsal.cancel); process.on('SIGINT', rehearsal.cancel); }
  const daemon = await require('./nikd').main(['--root', config.root], { adapters: {
    ...rehearsal?.adapters,
    keychain: { adapter, account: 'store.v1' }, toolPaths: { node: process.execPath },
    package: { label: config.label, appID: config.appID, flavour: config.flavour, testOnly: true, acceptanceP2: !!rehearsal, macDesktopPresenter: true },
    control(request) {
      if (request.op === 'package-keychain-selftest' && Object.keys(request).length === 1) {
        return require('./keychainProbe').exerciseKeychain({ helper: path.join(contents, 'Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
          rebuiltHelper: path.join(contents, 'Helpers/NikKeychainRebuilt.app/Contents/MacOS/NikKeychain'), home: config.testHome });
      }
      if (request.op === 'package-test-cleanup' && Object.keys(request).length === 1) {
        adapter.delete('store.v1');
        return { ok: true, service: adapter.service, cleanup: adapter.read('store.v1') === null };
      }
      return rehearsal ? rehearsal.adapters.control(request) : { ok: false, code: 'CONTROL_UNSUPPORTED' };
    }
  } });
  rehearsal?.attach(daemon);
}
if (require.main === module) main().catch((error) => {
  const code = require('./engineStartup').safeCode(error);
  process.stderr.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
});
module.exports = { packageConfiguration, main };
