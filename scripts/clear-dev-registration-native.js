#!/usr/bin/env node
'use strict';
// Explicit native gate baseline/final cleanup, never production or another label.
const path = require('path'), assert = require('assert/strict'), native = require('./native-command');
async function main() {
  const app = '/private/tmp/nik-mac/build/p3/final/NikUI Dev.app';
  const controller = action => JSON.parse(native.command(path.join(app, 'Contents/MacOS/NikUI'), [action]));
  const identity = controller('build-identity');
  assert.equal(identity.flavour, 'dev'); assert.equal(identity.label, 'com.nikui.engine.development');
  const cleanup = await native.cleanupDevelopmentJob({ attempted: true, controller });
  const status = controller('status');
  assert(['notRegistered', 'notFound'].includes(status.registration));
  assert.equal(native.developmentJobExists(), false); assert.equal(status.control, null);
  return { ok: true, app, cleanup, status };
}
if (require.main === module) void native.runNative(main);
module.exports = { main };
