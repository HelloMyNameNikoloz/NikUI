'use strict';
// Disposable cross-process SecItem substitute; never a system Keychain.
const fs = require('fs');
const { atomicJson } = require('../../../src/engineOwner');
module.exports = (file) => {
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const initial = read();
  return { service: initial.service, backend: 'login-file-keychain',
    read(account) { const data = read().values[account]; return data === undefined ? null : Buffer.from(data, 'base64'); },
    add(account, bytes) { const state = read(); if (state.values[account] !== undefined) throw Error('duplicate test credential');
      state.values[account] = Buffer.from(bytes).toString('base64'); atomicJson(file, state); },
    update(account, bytes) { const state = read(); if (state.values[account] === undefined) throw Error('missing test credential');
      state.values[account] = Buffer.from(bytes).toString('base64'); atomicJson(file, state); },
    delete(account) { const state = read(); delete state.values[account]; atomicJson(file, state); }
  };
};
