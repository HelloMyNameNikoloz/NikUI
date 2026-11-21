'use strict';

// Explicit development-package acceptance gate. Only fresh test services are
// touched; no credential bytes enter the returned report, logs or argv.
const assert = require('assert/strict'), crypto = require('crypto'), fs = require('fs');
const { spawnSync } = require('child_process');
const { createSecItemAdapter } = require('./keychainStore');
function requirement(helper) {
  const result = spawnSync('/usr/bin/codesign', ['-d', '-r-', helper], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const value = (result.stdout + result.stderr).match(/designated => (.+)/)?.[1];
  assert(value); return value;
}
function exerciseKeychain({ helper, rebuiltHelper, home } = {}) {
  const service = 'com.nikui.engine.test.' + crypto.randomBytes(16).toString('hex');
  const options = { service, home }, first = createSecItemAdapter({ ...options, helper });
  const second = createSecItemAdapter({ ...options, helper: rebuiltHelper });
  const accounts = ['probe', 'raw-empty', 'missing'];
  const secret = Buffer.from('synthetic-private-ქართული\n"\\\u0000👋');
  const updated = Buffer.from('updated\nქართული\u0000');
  const report = { version: 1, ok: false, backend: first.backend, service, checks: {}, cleanup: false };
  const checks = report.checks;
  try {
    assert.equal(requirement(helper), requirement(rebuiltHelper)); checks.rebuildRequirement = true;
    report.helperHashes = [helper, rebuiltHelper].map((file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    assert.notEqual(report.helperHashes[0], report.helperHashes[1]); checks.rebuiltBytesDiffer = true;
    assert.equal(first.read('probe'), null); checks.initiallyMissing = true;
    first.add('probe', secret); report.writeAccessibility = first.metadata(); checks.add = true;
    assert(['AfterFirstUnlockThisDeviceOnly', 'AfterFirstUnlock'].includes(report.writeAccessibility.accessible)); checks.accessibility = true;
    assert(first.read('probe').equals(secret)); report.readAccessibility = first.metadata(); checks.readArbitraryBytes = true;
    assert.throws(() => first.add('probe', Buffer.from('replacement')), { code: 'KEYCHAIN_DUPLICATE' });
    assert(first.read('probe').equals(secret)); checks.nondestructiveDuplicate = true;
    assert(second.read('probe').equals(secret)); checks.rebuiltHelperReadsExisting = true;
    second.update('probe', updated); assert(first.read('probe').equals(updated)); checks.update = true;
    assert.throws(() => second.update('missing', secret), { code: 'KEYCHAIN_NOT_FOUND' }); checks.missingUpdate = true;
    second.add('raw-empty', Buffer.alloc(0)); assert.equal(first.read('raw-empty').length, 0); checks.emptyBytes = true;
    assert.equal(second.delete('raw-empty'), true); assert.equal(first.read('raw-empty'), null);
    assert.equal(second.delete('raw-empty'), false); checks.deleteAndMissing = true;
    const foreign = createSecItemAdapter({ helper, home, service: 'com.nikui.engine.dev.' + crypto.randomBytes(16).toString('hex') });
    assert.throws(() => foreign.read('probe'), { code: 'KEYCHAIN_NAMESPACE' }); checks.isolatedNamespace = true;
    report.ok = true;
  } finally {
    // Include every attempted account, even if add succeeded but its response
    // failed. Keep trying other deletions if one fails; never mask leftovers.
    const failures = [];
    for (const account of accounts) {
      try { first.delete(account); assert.equal(first.read(account), null); }
      catch (error) { failures.push(error); }
    }
    report.cleanup = failures.length === 0;
    if (failures.length) throw Object.assign(new Error('Test Keychain cleanup failed'), { code: 'KEYCHAIN_TEST_CLEANUP_FAILED' });
  }
  return report;
}
module.exports = { exerciseKeychain, requirement };
