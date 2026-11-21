'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SessionManager } = require('./manager');
const { createHistory } = require('./history');
const { FolderStore } = require('./folders');
const { Ledger } = require('./ledger');
const { CodexWorkspace } = require('./codex');
const { CodexCache } = require('./codexCache');
const { createCommandCatalog } = require('./commandCatalog');
const { createSlack } = require('./slackRuntime');
const { createDelivery } = require('./deliveryRuntime');
const { createRemote } = require('./remoteRuntime');
const { createPrCi } = require('./prRuntime');
const { createPolicyOwner } = require('./policyOwner');

// Resolve existing ancestors too: a not-yet-created cache/account under a
// symlink has the same identity before and after its directory is created.
function resolvedPath(file, io = fs) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Engine paths must be absolute');
  let at = path.resolve(file);
  const tail = [];
  for (;;) {
    try { return path.join(io.realpathSync(at), ...tail); }
    catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
      let entry;
      try { entry = io.lstatSync(at); } catch (_) { /* an ordinary missing path */ }
      if (entry && entry.isSymbolicLink()) throw new Error('Engine path contains an unresolved symlink: ' + at);
      const up = path.dirname(at);
      if (up === at) throw err;
      tail.unshift(path.basename(at));
      at = up;
    }
  }
}

/**
 * Compose only the services extracted so far. Adapters supply context stores,
 * a settings source, paths {home, projects, storage?, codexCache?}, a Claude
 * spawner and exactly one Codex {home, codexPath, spawnFn, args?, env?, cache?}.
 * Supply a cache instance or paths.codexCache; storage-less windows omit ledger.
 * Account labels/fallbacks/tool discovery are adapter policy, resolved once
 * before this call. No process or viewer starts at construction. Optional
 * Slack/delivery start with start(); session restoration remains the caller's choice.
 * Optional delivery supplies its store, explicit secret policy (or factory),
 * APNs paths/key access and transports. nextId defaults to legacy session IDs.
 * Provider connections/cache instances passed in are owned by this engine;
 * a borrowed daemon handle must expose close/disconnect for the connection,
 * and never conveys ownership of the external process.
 * createRemote()/createPrCi() attach one later-composed graph each, after the
 * adapter supplies its host/resources or runners/policy. They start no listener;
 * PR/CI subscriptions start with start() (or an explicit prCi.start()).
 */
function createEngine({ context, settings, paths, spawner, nextId, durable, codex, slack, delivery,
  fs: io = fs, now = Date.now, timers = { setTimeout, clearTimeout }, log = () => {} } = {}) {
  if (!context || !context.globalState || !context.workspaceState) throw new Error('Engine stores are required');
  if (!settings) throw new Error('Engine settings are required');
  if (!paths) throw new Error('Engine paths are required');
  if (typeof spawner !== 'function') throw new Error('An injected Claude spawner is required');
  if (!codex || Array.isArray(codex) || codex.accounts || codex.account) {
    throw new Error('Exactly one resolved Codex account is required');
  }
  const home = resolvedPath(paths.home, io);
  const projects = resolvedPath(paths.projects, io);
  const unavailable = codex.unavailableReason || null;
  const account = unavailable ? null : resolvedPath(codex.home, io);
  if (!unavailable && !codex.codexPath) throw new Error('A resolved Codex executable is required');
  if (!unavailable && typeof codex.spawnFn !== 'function') throw new Error('An injected Codex spawner is required');
  const appAccount = !unavailable && account === resolvedPath(path.join(home, '.codex'), io);
  if (!appAccount && (codex.daemonFn || codex.ipc)) throw new Error('Only the resolved app account may borrow Codex connections');
  const storage = paths.storage ? resolvedPath(paths.storage, io) : null;
  const cacheRoot = !unavailable && paths.codexCache ? resolvedPath(paths.codexCache, io) : null;
  if (!unavailable && !cacheRoot && !codex.cache) throw new Error('An injected Codex cache or cache root is required');
  // A thread id is unique only within its canonical account, including when
  // two account labels resolve to the same directory. Old unscoped caches are
  // derived data and can be rebuilt without touching provider-owned homes.
  const cacheDir = cacheRoot ? path.join(cacheRoot, crypto.createHash('sha256').update(account).digest('hex').slice(0, 24)) : null;
  const source = (cwd) => typeof settings === 'function' ? settings(cwd)
    : cwd && typeof settings.forProject === 'function' ? settings.forProject(cwd) : settings;
  const history = createHistory({ root: projects, fs: io,
    names: () => context.globalState.get('nikui.names.v1', {}) || {} });
  const commandCatalog = createCommandCatalog();
  const manager = new SessionManager(context, { settings: source, history, commandCatalog, spawner, nextId });
  if (durable) manager.useDurable(durable);
  const folders = new FolderStore(context, durable);
  const ledger = storage ? new Ledger({ dir: storage, fs: io, now }) : null;
  const cache = unavailable ? { read: () => null, write() {}, sweep() {}, dispose() {}, picture: async () => null }
    : codex.cache || new CodexCache({ dir: cacheDir, home, cleanupDir: codex.cleanupDir });
  const workspace = new CodexWorkspace({
    codexPath: codex.codexPath, home: account, args: (codex.args || []).slice(),
    spawnFn: codex.spawnFn, env: Object.assign({}, codex.env), daemonFn: codex.daemonFn || null,
    ipc: codex.ipc || null, createReader: codex.createReader, cache, appAccount, defaultCwd: home, unavailableReason: unavailable, log
  });
  const deliveryRuntime = delivery ? (delivery.create || createDelivery)(Object.assign({ settings: source, fs: io, now, log }, delivery, { manager })) : null;
  const slackRuntime = slack ? createSlack(Object.assign({ settings: source, log,
    notifier: deliveryRuntime && deliveryRuntime.notifier, devices: deliveryRuntime && deliveryRuntime.devices }, slack)) : null;
  let disposed = false, started = false, remembering = null, remote = null, prCi = null, policy = null, closing = null;
  const remember = () => {
    if (ledger) ledger.record(manager.list);
    for (const session of manager.list) folders.remember(session);
  };
  const changed = () => {
    if (disposed || remembering !== null) return;
    remembering = timers.setTimeout(() => { remembering = null; if (!disposed) remember(); }, 2000);
  };
  manager.on('changed', changed);
  return {
    manager, history, folders, ledger, codex: workspace, slack: slackRuntime, delivery: deliveryRuntime, commandCatalog,
    account: Object.freeze({ home: account, id: account ? crypto.createHash('sha256').update(account).digest('hex') : null, app: appAccount, cacheDir }),
    get remote() { return remote; },
    get prCi() { return prCi; },
    get policy() { return policy; },
    createPolicy(options) {
      if (disposed || started) throw new Error('Attach policy before engine start');
      if (policy) throw new Error('Engine already owns power/notification policy');
      // Codex busy is deliberately supplied by the service adapter. The
      // legacy window does not attach this P1 interface.
      policy = createPolicyOwner(Object.assign({ settings: source,
        claudeBusy: () => manager.list.filter((s) => s.isBusy).length }, options));
      return policy;
    },
    createPrCi(options) {
      if (disposed) throw new Error('Engine is closed');
      if (prCi) throw new Error('Engine already owns PR/CI services');
      prCi = createPrCi(Object.assign({ now, timers }, options, { manager, store: context.globalState }));
      return prCi;
    },
    createRemote(options) {
      if (disposed) throw new Error('Engine is closed');
      if (remote) throw new Error('Engine already owns a remote server');
      remote = createRemote(Object.assign({ delivery: deliveryRuntime, folders, fs: io,
        sessions: { list: () => manager.list, get: (id) => manager.get(id) || workspace.get(id) || null },
        history: (ask) => history.listSessions(ask) }, options));
      return remote;
    },
    start() {
      if (disposed || started) return slackRuntime ? slackRuntime.ready : Promise.resolve();
      started = true;
      if (deliveryRuntime) deliveryRuntime.start();
      if (prCi) prCi.start();
      const tasks = [];
      if (policy) tasks.push(policy.start());
      if (slackRuntime) tasks.push(slackRuntime.start());
      return Promise.all(tasks).then(() => {});
    },
    flush() { if (!disposed) { remember(); if (ledger) ledger.flush(); } },
    dispose() {
      if (disposed) return closing;
      disposed = true;
      manager.removeListener('changed', changed);
      if (remembering !== null) timers.clearTimeout(remembering);
      remembering = null;
      const tasks = [];
      if (remote) tasks.push(remote.dispose());
      if (policy) tasks.push(policy.dispose());
      if (tasks.length) closing = Promise.all(tasks).then(() => {});
      if (prCi) prCi.dispose();
      if (deliveryRuntime) deliveryRuntime.dispose();
      if (slackRuntime) slackRuntime.dispose();
      workspace.dispose();
      try { remember(); if (ledger) ledger.flush(); }
      finally { try { manager.dispose(); } finally { history.dispose(); } }
      return closing;
    }
  };
}

module.exports = { createEngine, resolvedPath };
