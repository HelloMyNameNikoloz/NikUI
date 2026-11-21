'use strict';

// Resolve window policy here. The engine never reads VS Code, discovers an
// account, installs a host or opens a keeper/daemon connection by itself.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createEngine, resolvedPath } = require('./engine');
const { editorSettings } = require('./editorHost');
const { Durable, placeOf } = require('./durable');
const { accountHome, homeArgs } = require('./codexHome');
const { CodexIpc } = require('./codexIpc');
const { findCodex, openDaemon } = require('./codex');
const { createDelivery } = require('./deliveryRuntime');
const { createRemoteResources, createRemote } = require('./remoteRuntime');
const { defaultShell } = require('./terminal');
const { defaultRun: runVoice } = require('./voice');
const { defaultApk } = require('./appUpdate');
const { createPrCi, createCi } = require('./prRuntime');

function windowPrCiOptions(context, services) {
  return Object.assign({ store: context.globalState,
    autoWatch: () => editorSettings().get('watchCIAfterPush', true),
    runners: { links: require('./prlink').defaultRun, feed: require('./prView').defaultRun, ci: require('./ci').defaultRun }
  }, services);
}

function createWindowPrCi(context, { engine, ...services } = {}) {
  const options = windowPrCiOptions(context, services);
  return engine ? engine.createPrCi(options) : createPrCi(options);
}

function createWindowCi(context, services) {
  const options = windowPrCiOptions(context, services);
  return createCi(Object.assign({}, options, { run: options.runners.ci }));
}

function createWindowDelivery(context, services = {}) {
  return createDelivery(Object.assign({}, services, { store: context.globalState,
    settings: editorSettings, secretPolicy: { mode: 'legacy-window' } }));
}

function createWindowRemote(context, { engine, log = () => {}, ...services } = {}) {
  const home = os.homedir(), root = context.extensionUri.fsPath;
  const resources = createRemoteResources({ home,
    terminal: editorSettings().get('remote.terminal', true)
      ? { spawn, shell: defaultShell(), env: process.env } : null,
    voice: {
      dir: context.globalStorageUri ? context.globalStorageUri.fsPath : null,
      tmp: os.tmpdir(), package: path.join(root, 'voice'),
      models: path.join(home, 'Library', 'Application Support', 'FluidAudio', 'Models'),
      run: runVoice, env: process.env, platform: process.platform, arch: process.arch,
      enabled: () => editorSettings().get('voice.enabled', true), log
    },
    appUpdate: { file: defaultApk(root), log }
  });
  const options = Object.assign({ hubs: require('./hub') }, services, { root, resources, log,
    ownership: { terminals: 'owned', voice: 'owned', appUpdate: 'owned' } });
  return engine ? engine.createRemote(options) : createRemote(options);
}

// The old cache was derived data without an account namespace. Remove only
// those two exact entries, and never follow a cache-root symlink out of storage.
function cleanLegacyCodexCache(storage, io = fs) {
  const root = path.join(storage, 'codex-cache');
  if (resolvedPath(root, io) !== root) return;
  for (const name of ['threads', 'pictures']) {
    const dir = path.join(root, name);
    // Most activations have nothing to migrate. Do not issue recursive
    // removals (or swallow access failures) on that ordinary fast path.
    try { io.lstatSync(dir); }
    catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    io.rmSync(dir, { recursive: true, force: true });
  }
}

function checkDirectory(file, io, required = false) {
  try {
    if (!io.statSync(file).isDirectory()) throw new Error('not a directory');
    io.accessSync(file, io.constants.R_OK | io.constants.X_OK);
  } catch (err) { if (required || err.code !== 'ENOENT') throw err; }
}

function createWindowEngine(context, { spawner, log = () => {}, fs: io = fs } = {}) {
  const settings = editorSettings();
  const home = resolvedPath(os.homedir(), io);
  let storage = context.globalStorageUri && context.globalStorageUri.fsPath;
  let codex, cacheRoot;
  // Filesystem trouble in an optional provider must not break activation or
  // retarget it to another account. Keep the reason on the workspace as well.
  try {
    if (storage) {
      storage = resolvedPath(storage, io);
      checkDirectory(storage, io);
    }
  } catch (err) {
    storage = null;
    codex = { unavailableReason: 'Codex storage unavailable: ' + err.message };
  }
  if (!codex) try {
    const requested = settings.get('codexAccount', 'work');
    // A genuinely absent Work directory retains the legacy Personal fallback.
    // A dangling Work symlink is a broken selected path, never that fallback.
    if (requested === 'work') resolvedPath(path.join(home, '.codex-work'), io);
    const chosen = accountHome(requested, home);
    const account = resolvedPath(chosen, io);
    checkDirectory(account, io, true);
    const app = account === resolvedPath(path.join(home, '.codex'), io);
    cacheRoot = storage ? path.join(storage, 'codex-cache') : path.join(os.tmpdir(), 'nikui-codex-' + crypto.randomUUID());
    resolvedPath(cacheRoot, io);
    checkDirectory(cacheRoot, io);
    codex = {
      home: account, codexPath: findCodex(settings.get('codexPath', '') || ''),
      spawnFn: spawn, env: process.env,
      args: homeArgs(chosen, { computerUse: settings.get('codexComputerUse', true),
        xcode: settings.get('codexXcode', true), home }),
      daemonFn: app ? openDaemon : null, ipc: app ? new CodexIpc({ log }) : null,
      cleanupDir: storage ? null : cacheRoot
    };
  } catch (err) {
    codex = { unavailableReason: 'Codex account/cache unavailable: ' + err.message };
  }
  if (codex.unavailableReason) log(codex.unavailableReason);
  if (storage) {
    try { cleanLegacyCodexCache(storage, io); }
    catch (err) { log('codex: legacy cache cleanup unavailable: ' + err.message); }
  }
  return createEngine({
    context, settings: editorSettings, spawner: spawner || spawn, log, fs: io,
    paths: { home, projects: path.join(home, '.claude', 'projects'), storage,
      codexCache: cacheRoot },
    durable: storage ? new Durable({ dir: storage, place: placeOf(vscode.workspace) }) : null,
    codex,
    delivery: { create: (services) => createWindowDelivery(context, services) }
  });
}

module.exports = { createWindowEngine, createWindowDelivery, createWindowRemote, createWindowPrCi, createWindowCi };
