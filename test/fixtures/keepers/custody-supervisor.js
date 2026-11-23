'use strict';
// Portable stand-in for launchd's process-exit notification. Never installed
// or shipped in an app. There is no recurring liveness probe.
const { spawn } = require('child_process'), path = require('path');
let child, stopping = false, attempts = 0;
function start() {
  child = spawn(process.execPath, [path.resolve(__dirname, '../../../src/keeperRescue.js'), process.argv[2]],
    { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.send?.({ started: child.pid });
  child.on('error', () => {});
  child.on('exit', (code) => {
    process.send?.({ exited: child.pid });
    if (stopping || code === 0 || code === 78) process.exit(0);
    setTimeout(start, Math.min(1000, 25 * 2 ** Math.min(attempts++, 5)));
  });
}
process.on('message', (message) => {
  if (message !== 'stop') return;
  stopping = true;
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  else process.exit(0);
});
process.on('disconnect', () => { stopping = true; if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); else process.exit(0); });
start();
