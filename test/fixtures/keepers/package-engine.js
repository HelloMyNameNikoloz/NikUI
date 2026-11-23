'use strict';
// Portable package process: real production graph and original borrowed run,
// file-backed fixture credentials and process proofs; no native registration.
const fs = require('fs'), path = require('path'), Module = require('module');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const repo = path.resolve(__dirname, '../../..');
require('../../../src/keeperRescue').supervise = async () => { throw Error('PORTABLE_CUSTODY_REGISTRATION_FORBIDDEN'); };
const facts = new Map(config.facts);
const dependencies = {
  account: () => ({ homedir: config.selection.home }), paths: config.selection,
  resolver: { resolveAll: async () => ({ tools: Object.fromEntries(['claude', 'codex', 'node', 'gh'].map(name =>
    [name, { path: '/fixture/' + name, status: 'resolved', source: 'configured' }])), childEnv: { PATH: '/usr/bin:/bin' } }) },
  power: { recover() {}, awake() {}, lid() {}, release() {} },
  spawn() { throw Error('NO_REPLACEMENT_PROVIDER_ALLOWED'); },
  codexCache: { read: () => null, write() {}, sweep() {}, dispose() {}, picture: async () => null },
  keeperFactory: options => options.legacy ? new (require('../../../src/legacyKeeper').LegacyKeeper)({ ...options,
    processSnapshot: async () => facts }) : new (require('../../../src/daemonKeeper').DaemonKeeper)(options)
};
// Compile the actual package lifecycle, leaving package validation/Keychain
// native work to Claude. Only its runtime adapters are replaced by fixtures.
const entry = path.join(process.env.NIKUI_R39_BASELINE || repo, 'src/macEngine.js');
const mod = new Module(entry); mod.filename = entry; mod.paths = Module._nodeModulePaths(path.dirname(entry));
const original = mod.require.bind(mod);
mod.require = name => name === './productionRuntime' ? { startProductionRuntime: options =>
  require('../../../src/productionRuntime').startProductionRuntime({ ...options, dependencies: { ...dependencies, ...options.dependencies } }) } : original(name);
mod._compile(fs.readFileSync(entry, 'utf8') + '\nmodule.exports.runPackage=runPackage;', entry);
mod.exports.runPackage({ config: {}, selection: config.selection,
  adapter: require('./file-keychain')(config.keychain) }).then(runtime => {
    process.send({ ready: true, status: runtime.status() });
  }).catch(error => { process.stderr.write(error.stack + '\n'); process.exit(78); });
