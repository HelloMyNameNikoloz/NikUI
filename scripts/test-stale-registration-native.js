#!/usr/bin/env node
'use strict';
// native: pending Claude run. Only the freshly built disposable DEV job.
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const native = require('./native-command');
async function main() {
  return require('./test-mac-engine').main({ quiet: true, exercise: async ({ controller, report, paths }) => {
    const label = 'com.nikui.engine.development', target = `gui/${process.getuid()}/${label}`;
    function stale() {
      controller('intentional-stop');
      assert.equal(controller('validate-removal').ok, true);
      native.command('/bin/launchctl', ['bootout', target]);
      assert.equal(native.developmentJobExists(), false);
      const status = controller('status');
      assert(['enabled', 'requiresApproval'].includes(status.registration), JSON.stringify(status));
      assert.equal(controller('validate-removal').ok, true);
      return status;
    }
    report.staleRegistration = stale();
    assert.equal(controller('register').registration, 'enabled');
    assert.equal(native.developmentJobExists(), true);
    controller('start'); assert.equal(controller('validate-registration').ok, true);
    report.checks.registerRepairsEnabledRecordWithoutLaunchdJob = true;
    report.staleBeforeStart = stale();
    const restarted = controller('start');
    assert(restarted.control.pid > 0); assert.equal(controller('validate-registration').ok, true);
    report.checks.startRepairsEnabledRecordWithoutLaunchdJob = true;
    report.staleBeforeRemoval = stale();
    // Recreate the exact completed-handback Stop branch in this disposable
    // profile. BTM remains enabled while launchd's exact job is already gone.
    const journal = path.join(paths.root, 'cutover-request.json'), ownerDirectory = path.join(paths.root, 'o');
    const owner = path.join(ownerDirectory, 'engine-owner.json'), hadDirectory = fs.existsSync(ownerDirectory);
    assert(!fs.existsSync(journal) && !fs.existsSync(owner));
    require('../src/daemonPaths').privateDirectory(ownerDirectory);
    try {
      require('../src/engineOwner').atomicJson(journal, { stage: 'returned' });
      require('../src/engineOwner').atomicJson(owner, { mode: 'window' });
      report.stopAfterJobDisappeared = controller('intentional-stop');
      assert.equal(report.stopAfterJobDisappeared.engine, 'stopped');
      assert.equal(native.developmentJobExists(), false);
      report.checks.handbackStopAcceptsExactAbsentJob = true;
    } finally {
      for (const file of [journal, owner]) if (fs.existsSync(file)) fs.unlinkSync(file);
      if (!hadDirectory) fs.rmdirSync(ownerDirectory);
    }
    const removed = controller('unregister');
    assert(['notRegistered', 'notFound'].includes(removed.registration));
    assert.equal(native.developmentJobExists(), false);
    report.statusAfterStaleRemoval = controller('status');
    assert(['notRegistered', 'notFound'].includes(report.statusAfterStaleRemoval.registration));
    assert.equal(report.statusAfterStaleRemoval.control, null);
    report.checks.staleOwnRegistrationRemovalProvesJobAndRecordAbsence = true;
    controller('register'); return { lastStatus: controller('start').control };
  } });
}
if (require.main === module) void native.runNative(main);
module.exports = { main };
