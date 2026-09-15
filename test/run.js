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

(async () => {
  const dir = __dirname;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => process.argv[2] ? f.includes(process.argv[2]) : true)
    .sort();

  for (const file of files) {
    const mod = require(path.join(dir, file));
    if (typeof mod === 'function') await mod();
  }

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
})().catch((err) => { console.error(err); process.exit(1); });
