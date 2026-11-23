#!/usr/bin/env node
'use strict';

// A short-lived idle engine check for the attended Move path. Import the real
// production composition, but never construct it before its ownership commit.
// No selected profile, socket, Keychain, provider or keeper is opened here.
function preflight() {
  const fs = require('fs'), path = require('path');
  const engine = path.resolve(__dirname, '..');
  const identity = require('./macBuildIdentity');
  const config = JSON.parse(fs.readFileSync(path.join(engine, 'mac-engine.json'), 'utf8'));
  const selection = require('./macFlavour').validatePackage(identity, config, {
    accountHome: require('os').userInfo().homedir, envHome: process.env.HOME,
    args: process.argv.slice(2), execPath: fs.realpathSync(process.execPath), engine
  });
  const runtime = require('./productionRuntime');
  if (typeof runtime.startProductionRuntime !== 'function') throw Error('ENGINE_PREFLIGHT_FAILED');
  return { ok: true, mode: 'idle-preflight', appID: selection.appID, label: selection.label,
    pid: process.pid, executable: fs.realpathSync(process.execPath) };
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(preflight()) + '\n'); }
  catch (_) { process.stdout.write(JSON.stringify({ ok: false, code: 'ENGINE_PREFLIGHT_FAILED' }) + '\n'); process.exitCode = 1; }
}
module.exports = { preflight };
