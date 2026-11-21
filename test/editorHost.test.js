'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function () {
  suite('the extension host keeps editor behavior through composition');
  // A clean process lets us replace browser/tab/limit adapters before loading
  // the extension provider, without opening anything or querying real accounts.
  const checks = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers/editor-host.js')],
    { encoding: 'utf8', timeout: 20000 }));
  for (const [name, actual, expected] of checks) checkEqual(name, actual, expected);
};
