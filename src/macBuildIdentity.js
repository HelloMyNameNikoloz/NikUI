'use strict';
// Replaced with one literal by build-mac-app.js BEFORE signing. Never read an
// environment variable, command-line flag or package JSON to choose a flavour.
module.exports = Object.freeze({ flavour: 'dev', appID: 'com.nikui.app.dev', label: 'com.nikui.engine.development' });
