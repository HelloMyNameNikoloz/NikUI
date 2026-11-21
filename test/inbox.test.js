'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
require('./helpers/vscode-stub').install();
const { watchInbox } = require('../src/extension');

module.exports = async function () {
  suite('notification inbox survives unavailable filesystem events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-inbox-'));
  const originalWatch = fs.watch;
  const inboxes = [];
  try {
    for (const asynchronous of [false, true]) {
      let closed = 0;
      const watcher = new EventEmitter();
      watcher.close = () => { closed++; };
      fs.watch = () => {
        if (!asynchronous) throw Object.assign(new Error('fixture watcher limit'), { code: 'EMFILE' });
        return watcher;
      };
      const heard = [];
      const inbox = watchInbox(dir, id => heard.push(id));
      inboxes.push(inbox);
      fs.watch = originalWatch;
      if (asynchronous) watcher.emit('error', Object.assign(new Error('fixture FSEvents failure'), { code: 'EMFILE' }));
      const renamed = inbox.path + '.tmp';
      fs.writeFileSync(renamed, 'own-instance'); fs.renameSync(renamed, inbox.path);
      fs.writeFileSync(path.join(dir, 'clicks', 'another-window'), 'other-instance');
      for (let i = 0; i < 30 && !heard.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
      checkEqual((asynchronous ? 'asynchronous' : 'synchronous') + ' watch failure still delivers only this inbox', heard, ['own-instance']);
      check('a delivered click is consumed', !fs.existsSync(inbox.path));
      if (asynchronous) checkEqual('the failed native watcher is closed', closed, 1);
      inbox.dispose();
      fs.writeFileSync(inbox.path, 'after-disposal');
      await new Promise(resolve => setTimeout(resolve, 300));
      checkEqual('disposal stops fallback delivery', heard, ['own-instance']);
    }
  } finally {
    fs.watch = originalWatch;
    for (const inbox of inboxes) inbox.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
