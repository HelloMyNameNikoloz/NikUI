'use strict';
const path = require('path');
module.exports = () => {
  const checks = JSON.parse(require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'helpers/development-window.js')], { encoding: 'utf8', timeout: 15000 }));
  suite('P1-23 T01/T02/T05/T43/T58: explicitly isolated extension activation');
  for (const [name, actual, expected] of checks) checkEqual(name, actual, expected);
};
