'use strict';
module.exports = () => require('./helpers/headless').headlessChecks(require('path').join(__dirname, 'fixtures/engine/mac-enrollment.js'),
  { privateListener: true, controlListener: true });
