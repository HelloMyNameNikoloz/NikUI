'use strict';

// Fault the real portable clients, not a mock negotiatedClient: the harness
// must identify an unpersisted send rather than timing out in its seal hook.
const fs = require('fs'), path = require('path');
const helper = require('./browser-client'), browser = helper.browser;
helper.browser = (...args) => {
  const client = browser(...args), socket = client.socket;
  client.socket = () => {
    const transport = socket(), post = transport.postMessage;
    transport.postMessage = (message, ...rest) => message?.text === 'P2 synthetic identical resend' ? false : post(message, ...rest);
    return transport;
  };
  return client;
};
const run = fs.mkdtempSync('/private/tmp/nik-mac/p2/refused-');
require('../../scripts/acceptance-p2').portable(run).then(() => {
  throw new Error('Injected send refusal unexpectedly passed');
}, (error) => {
  const report = JSON.parse(fs.readFileSync(path.join(run, 'p2-scenarios.json'), 'utf8'));
  process.stdout.write(JSON.stringify({ error: { code: error.code, message: error.message, diagnostics: error.diagnostics },
    failure: report.failure, check: report.checks.at(-1), cleanup: report.cleanup }) + '\n');
}).catch((error) => { console.error(error); process.exitCode = 1; });
