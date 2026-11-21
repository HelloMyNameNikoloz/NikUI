'use strict';

const path = require('path');
const fs = require('fs');
const { RemoteServer } = require('./remote');
const { Terminals } = require('./terminal');
const { Voice } = require('./voice');
const { AppUpdate } = require('./appUpdate');
const { createHubRegistry } = require('./hub');

function absolute(value, name, optional = false) {
  if (optional && value === null) return;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(name + ' must be an explicit absolute path');
}

/** Construct only the resources explicitly enabled by the adapter. No tool,
 * model, HOME, package, APK or shell discovery is performed here. A null
 * feature is absent; a voice enabled() reader may also switch it off live.
 * Injected runners own their process implementation and must honor abort.
 */
function createRemoteResources({ home, terminal = null, voice = null, appUpdate = null,
  fs, now, timers = {} } = {}) {
  absolute(home, 'Terminal home');
  if (terminal && (typeof terminal.spawn !== 'function' || !terminal.shell || !terminal.env)) {
    throw new Error('Terminal spawn, shell and environment are required');
  }
  if (voice) {
    for (const key of ['dir', 'tmp', 'package', 'models']) absolute(voice[key], 'Voice ' + key, key === 'dir');
    if (voice.binary != null) absolute(voice.binary, 'Voice binary');
    if (typeof voice.run !== 'function' || typeof voice.enabled !== 'function' || !voice.env || !voice.platform || !voice.arch) {
      throw new Error('Voice runner, enabled reader, environment and platform are required');
    }
  }
  if (appUpdate) absolute(appUpdate.file, 'App update file');
  const common = { fs, now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
  return Object.freeze({
    terminals: terminal ? new Terminals(Object.assign({}, common, terminal, { home })) : null,
    voice: voice ? new Voice(Object.assign({}, common, voice)) : null,
    appUpdate: appUpdate ? new AppUpdate(Object.assign({ fs, now, timers }, appUpdate)) : null
  });
}

/** One private listener with explicitly recorded resource ownership. Delivery,
 * host and sessions are borrowed engine services. stop()/start() affects the
 * listener and viewers, retaining command blocks; dispose() also retires owned
 * resources. Exposure, warming, auto-start and port selection remain adapter
 * decisions. With no port specified start() requests an ephemeral loopback port.
 */
function createRemote({ root, resources, ownership, ...services } = {}) {
  absolute(root, 'Remote asset root');
  // macOS commonly supplies /var or /tmp aliases. Compare asset realpaths
  // against the canonical resource root, including relocated bundles.
  root = (services.fs || fs).realpathSync(root);
  if (!resources || !ownership) throw new Error('Remote resources and ownership are required');
  const held = {}, owns = {};
  for (const key of ['terminals', 'voice', 'appUpdate']) {
    held[key] = resources[key] || null;
    if (held[key] && !['owned', 'borrowed'].includes(ownership[key])) throw new Error('Explicit ownership required for ' + key);
    owns[key] = held[key] ? ownership[key] : null;
  }
  if (held.terminals && typeof held.terminals.subscribe !== 'function') throw new Error('Terminal event subscription is required');
  const hubs = services.hubs || createHubRegistry();
  const server = new RemoteServer(Object.assign({}, services, held, { root, hubs }));
  owns.hubs = services.hubs ? 'borrowed' : 'owned';
  owns.delivery = server.delivery ? 'borrowed' : null;
  owns.notificationStream = server.ownsNotificationStream ? 'owned' : 'borrowed';
  const unsubscribe = held.terminals ? held.terminals.subscribe((event) => server.terminalSaid(event)) : null;
  const disposeServer = server.dispose.bind(server);
  let closing = null;
  server.resources = Object.freeze(held);
  server.ownership = Object.freeze(owns);
  server.dispose = () => {
    if (closing) return closing;
    if (unsubscribe) unsubscribe();
    const tasks = [disposeServer()];
    if (!services.hubs) hubs.closeAllHubs();
    for (const key of ['terminals', 'voice', 'appUpdate']) {
      if (owns[key] !== 'owned') continue;
      const resource = held[key];
      try { tasks.push(key === 'appUpdate' ? resource.stop() : resource.dispose()); }
      catch (err) { tasks.push(Promise.reject(err)); }
    }
    closing = Promise.allSettled(tasks).then((results) => {
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;
    });
    return closing;
  };
  return server;
}

module.exports = { createRemoteResources, createRemote };
