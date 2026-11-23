'use strict';
const { fork } = require('child_process'), path = require('path');
const jobs = new Map();
const custodians = new Set();
async function supervise(directory) {
  if (jobs.has(directory)) return;
  const child = fork(path.join(__dirname, '../fixtures/keepers/custody-supervisor.js'), [directory],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  jobs.set(directory, child);
  child.on('message', (message) => {
    if (message.started) custodians.add(message.started);
    if (message.exited) custodians.delete(message.exited);
  });
  child.once('exit', () => { if (jobs.get(directory) === child) jobs.delete(directory); });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
}
async function stop(directory) {
  const child = jobs.get(directory);
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.send('stop', () => {}); });
}
async function closeAll() {
  await Promise.all([...jobs.keys()].map(stop));
  if (custodians.size) throw Error('TEST_CUSTODIANS_REMAIN: ' + [...custodians].join(','));
}
module.exports = { supervise, stop, closeAll, jobs, custodians };
