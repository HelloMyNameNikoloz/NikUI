'use strict';
module.exports = () => require('./helpers/headless').headlessChecks(require('path').join(__dirname, 'fixtures/engine/mac-core-loop.js'),
  { privateListener: true, controlListener: true });
