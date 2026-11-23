#!/usr/bin/env node
'use strict';
// native: pending Claude run. Only the freshly built relocated DEV service.
const assert = require('assert/strict'), path = require('path'), fs = require('fs');
const native = require('./native-command');
async function main() {
  return require('./test-mac-engine').main({ quiet: true, exercise: async ({ app, built, controller, report }) => {
    const adapter = require('../src/keychainStore').createSecItemAdapter({
      helper: path.join(app, 'Contents/Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
      service: built.keychainService, home: built.testHome });
    const before = adapter.read('store.v1'); assert(before);
    let restored = false;
    try {
      controller('intentional-stop');
      assert.equal(controller('validate-removal').ok, true);
      adapter.update('store.v1', Buffer.from('{corrupt-disposable-selected-store'));
      let refused;
      try { controller('start'); } catch (error) { refused = error; }
      assert(refused, 'Corrupt test selection must refuse startup');
      assert(fs.readFileSync(path.join(built.testHome, 'engine.stderr.log'), 'utf8').includes('KEYCHAIN_CORRUPT'));
      assert.equal(controller('status').control, null);
      report.failedStartupJob = native.command('/bin/launchctl', ['print', `gui/${process.getuid()}/com.nikui.engine.development`]);
      report.failedStartup = native.failureEvidence(refused);
      assert.equal(controller('validate-removal').ok, true);
      report.stoppedCleanup = await native.cleanupDevelopmentJob({ attempted: true, controller });
      assert(report.stoppedCleanup.absent); assert.equal(native.developmentJobExists(), false);
      report.checks.failedStartupUnregistersOwnBundleAndProvesAbsence = true;
      adapter.update('store.v1', before); restored = true;
      assert.deepEqual(adapter.read('store.v1'), before);
      controller('register'); const next = controller('start');
      return { lastStatus: next.control };
    } finally {
      if (!restored) adapter.update('store.v1', before);
    }
  } });
}
if (require.main === module) void native.runNative(main);
module.exports = { main };
