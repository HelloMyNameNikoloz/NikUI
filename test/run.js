#!/usr/bin/env node
'use strict';

// Tiny runner: no dependencies, so `node test/run.js` works on a clean checkout.
const fs = require('fs');
const path = require('path');

const results = [];
let currentSuite = 'general';

global.suite = (name) => { currentSuite = name; };
global.check = (name, condition) => { results.push({ suite: currentSuite, name, ok: !!condition }); };
global.checkEqual = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ suite: currentSuite, name, ok, actual, expected });
};

// No suite may reach the keeper the real windows are using: anything that
// builds a KeeperLink without naming a folder gets a throwaway one instead.
// An inherited override may itself name a live keeper. Never reuse it.
process.env.NIKUI_KEEPER_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nk-test-'));
// Portable tests must never register a real launchd job. This test-only
// supervisor exercises the identical custodian crash/reload entry point.
const custodySupervisor = require('./helpers/custody-supervisor');
require('../src/keeperRescue').supervise = custodySupervisor.supervise;
require('../src/keeperRescue').retireCustody = async (directory) => {
  // Product cleanup is covered with a launchctl I/O trap in R37. Portable
  // integrations must never inspect or mutate a real login-session job.
  try {
    const status = await require('../src/daemonControl').controlRequest({ socket: require('../src/keeperRescue').socketFor(directory) }, { op: 'status' });
    if (status.runs?.length) return { retained: true };
  } catch (_) {}
  await custodySupervisor.stop(directory); return { removed: true };
};

(async () => {
  const dir = __dirname;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => process.argv[2] ? f.includes(process.argv[2]) : true)
    .sort();

  for (const file of files) {
    if (process.env.NIKUI_TEST_PROGRESS === '1') console.error('Running ' + file);
    const mod = require(path.join(dir, file));
    if (typeof mod === 'function') await mod();
    if (process.env.NIKUI_TEST_PROGRESS === '1') console.error('Finished ' + file);
  }
  await custodySupervisor.closeAll();

  let failed = 0;
  let suite = null;
  for (const r of results) {
    if (r.suite !== suite) { suite = r.suite; console.log('\n' + suite); }
    if (!r.ok) {
      failed++;
      console.log('  FAIL  ' + r.name);
      if ('actual' in r) console.log('        actual   ' + JSON.stringify(r.actual));
      if ('expected' in r) console.log('        expected ' + JSON.stringify(r.expected));
    } else {
      console.log('  ok    ' + r.name);
    }
  }

  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
  process.exit(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await custodySupervisor.closeAll(); process.exit(1); });
