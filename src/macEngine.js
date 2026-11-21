#!/usr/bin/env node
'use strict';

// The real isolated engine in the signed development bundle. There is no
// source-profile discovery or production label. Provider execution is disabled;
// a sealed --real-tools rehearsal can run fresh sandboxed CLI prompts only.
const fs = require('fs');
const path = require('path');
const { fail, privateDirectory, privateRoot, privateFile, readPrivateJson, checkPrivateTree } = require('./daemonPaths');
const { createSecItemAdapter, createKeychainStore } = require('./keychainStore');

function packageConfiguration(args = process.argv.slice(2)) {
  const engine = path.resolve(__dirname, '..'), contents = path.resolve(engine, '../..');
  const config = JSON.parse(fs.readFileSync(path.join(engine, 'mac-engine.json'), 'utf8'));
  if (config.version !== 1 || config.label !== 'com.nikui.engine.dev' || config.testOnly !== true ||
    !config.testHome?.startsWith('/private/tmp/nik-mac/build/') ||
    !config.root?.startsWith(config.testHome + '/') || process.env.HOME !== config.testHome ||
    args.length !== 2 || args[0] !== '--root' || args[1] !== config.root ||
    fs.realpathSync(process.execPath) !== path.join(engine, 'node')) throw fail('PACKAGE_CONFIGURATION', 'Signed test package configuration disagrees');
  privateDirectory(config.testHome, false);
  const paths = privateRoot(config.root);
  checkPrivateTree(paths.root);
  const adapter = createSecItemAdapter({ helper: path.join(contents, 'Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
    home: config.testHome, service: config.keychainService });
  return { config, paths, adapter, contents };
}

async function main() {
  const { config, adapter, paths, contents } = packageConfiguration();
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
    package: { label: config.label, testOnly: true, acceptanceP2: !!rehearsal },
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
  const code = ['KEYCHAIN_DENIED', 'KEYCHAIN_LOCKED', 'KEYCHAIN_NOT_FOUND', 'KEYCHAIN_CORRUPT', 'KEYCHAIN_DUPLICATE', 'PACKAGE_CONFIGURATION'].includes(error.code)
    ? error.code : 'SIGNED_TEST_ENGINE_UNAVAILABLE';
  process.stderr.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
});
module.exports = { packageConfiguration, main };
