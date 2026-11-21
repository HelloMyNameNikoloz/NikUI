'use strict';

// Portable counterpart of macEngine's acceptance composition. This is a
// separate JS process, with a fake selected Keychain adapter; no native helper,
// installed profile, service registration or machine adapter is used.
const fs = require('fs'), path = require('path');
const { privateRoot, readPrivateJson } = require('../../src/daemonPaths');
const { atomicJson } = require('../../src/engineOwner');
const { memoryKeychain } = require('./keychain');
const { createKeychainStore } = require('../../src/keychainStore');

async function main(root) {
  process.umask(0o077);
  const paths = privateRoot(root), file = path.join(root, 'keychain-fixture.json');
  const adapter = memoryKeychain();
  adapter.portable = true; // Preserve the adapter contract without claiming native evidence.
  if (fs.existsSync(file)) for (const [account, bytes] of readPrivateJson(file)) adapter.values.set(account, Buffer.from(bytes, 'base64'));
  for (const op of ['add', 'update', 'delete']) {
    const effect = adapter[op];
    adapter[op] = (...args) => {
      const result = effect(...args);
      atomicJson(file, [...adapter.values].map(([account, bytes]) => [account, bytes.toString('base64')]));
      return result;
    };
  }
  if (!fs.existsSync(file)) {
    const values = {}, memory = { get: (key) => values[key], update: (key, value) => { values[key] = value; } };
    const identity = require('../../src/identity').loadIdentity(memory), vapid = require('../../src/push').loadVapid(memory);
    values['nikd.selection'] = { fingerprint: identity.fingerprint, applicationServerKey: vapid.applicationServerKey };
    createKeychainStore({ adapter, create: true, initial: values }).dispose();
  }
  const fixture = require('../../src/acceptanceFixture').createAcceptanceFixture({ root, testOnly: true, secretAdapter: adapter });
  const daemon = await require('../../src/daemonRuntime').startDaemon({ root, adapters: {
    ...fixture.adapters, keychain: { adapter, account: 'store.v1' }, toolPaths: { node: process.execPath },
    package: { label: 'com.nikui.engine.dev', testOnly: true, acceptanceP2: true, portable: true },
    tools: { knownDirs: [], lookup: async () => ({ path: '/usr/bin:/bin:/usr/sbin:/sbin', tools: {} }) }
  } });
  fixture.attach(daemon);
  let stopping;
  const stop = () => stopping ||= daemon.stop().then(() => { if (process.connected) process.disconnect(); });
  process.on('message', (message) => { if (message?.op === 'stop') void stop(); });
  process.once('disconnect', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.send({ ok: true, status: daemon.status() });
}
if (require.main === module) main(process.argv[2]).catch((error) => {
  process.send?.({ ok: false, code: error.code || 'PORTABLE_DAEMON_FAILED' });
  process.exitCode = 1;
  process.disconnect?.();
});
module.exports = { main };
