'use strict';

// Preloaded into real nikd CLI children, not the existing runner's VS Code
// stub. A caught or lazy attempt also makes an otherwise clean exit fail.
const Module = require('module');
let attempts = 0;
for (const name of ['_load', '_resolveFilename']) {
  const original = Module[name];
  Module[name] = function (request) {
    if (/^(?:node:)?vscode(?:\/|$)/.test(request)) { attempts++; throw new Error('VS Code poisoned in CLI fixture'); }
    return original.apply(this, arguments);
  };
}
process.once('exit', () => { if (attempts) process.exitCode = 91; });

if (process.env.NIKUI_DAEMON_DRAIN_FIXTURE === '1') {
  const load = Module._load;
  Module._load = function (request, parent) {
    const result = load.apply(this, arguments);
    if (request === './daemonRuntime' && parent?.filename.endsWith('/src/nikd.js')) return {
      ...result, startDaemon: async (options) => {
        const daemon = await result.startDaemon(options);
        daemon.engine.flush = () => new Promise(() => {});
        return daemon;
      }
    };
    return result;
  };
}

// Fault injection belongs to this fixture, never to nikd's public arguments.
if (process.env.NIKUI_DAEMON_CRASH_FIXTURE) {
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    const result = write.call(this, chunk, ...args);
    if (String(chunk).includes('"state":"running"')) {
      setImmediate(() => {
        if (process.env.NIKUI_DAEMON_CRASH_FIXTURE === 'rejection') void Promise.reject(new Error('PRIVATE_CRASH_PAYLOAD'));
        else throw new Error('PRIVATE_CRASH_PAYLOAD');
      });
    }
    return result;
  };
}
