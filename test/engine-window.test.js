'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { headlessChecks } = require('./helpers/headless');

module.exports = () => {
  headlessChecks(path.join(__dirname, 'fixtures/engine/constructors.js'));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nik-engine-window-')));
  try {
    const checks = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'fixtures/engine/window.js')], {
      encoding: 'utf8', timeout: 20000,
      env: { HOME: home, TMPDIR: home, NIKUI_ENGINE_FIXTURE_ROOT: home, PATH: '/usr/bin:/bin' }
    }));
    suite('T07/R02: the extension adapters retain window behavior');
    for (const [name, actual, expected] of checks) checkEqual(name, actual, expected);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
};
