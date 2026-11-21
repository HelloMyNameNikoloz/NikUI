'use strict';
const path = require('path');
const { headlessChecks } = require('./helpers/headless');
const { signingKeychainArgs } = require('../scripts/build-keychain-helper');
module.exports = () => {
  suite('P2 R4: signing identity remains tied to getpwuid home');
  const expected = '/fixture/real-account/Library/Keychains/login.keychain-db';
  let seen;
  checkEqual('signing explicitly selects login keychain independent of TEST HOME',
    signingKeychainArgs({ userHome: () => '/fixture/real-account', exists: (file) => (seen = file, true) }), ['--keychain', expected]);
  checkEqual('the only lookup is inside the selected account home', seen, expected);
  checkEqual('missing login keychain preserves the codesign default search',
    signingKeychainArgs({ userHome: () => '/fixture/missing', exists: () => false }), []);
  headlessChecks(path.join(__dirname, 'fixtures/engine/menubar.js'), { privateListener: true, controlListener: true });
};
