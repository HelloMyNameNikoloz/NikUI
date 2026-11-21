'use strict';
const path = require('path');
const { headlessChecks } = require('./helpers/headless');
module.exports = () => headlessChecks(path.join(__dirname, 'fixtures/engine/composition.js'));
