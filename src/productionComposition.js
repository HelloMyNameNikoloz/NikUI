'use strict';

// Production provider/policy construction. This is deliberately separate from
// P2's isolated daemon. Admission still requires the attended source coordinator;
// neither the launcher nor an environment flag enables this module yet.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const { createEngine } = require('./engine');
const { createSelectedDelivery } = require('./daemonDelivery');
const { createToolResolver } = require('./toolResolver');
const { createPolicyAuthority } = require('./policyOwner');
const { noSymlinks, privateDirectory, fail } = require('./daemonPaths');
const { homeArgs } = require('./codexHome');
const { loadIdentity } = require('./identity');
const { loadVapid } = require('./push');
const insist = (value, code) => { if (!value) throw fail(code, code); };

function productionPaths(accountHome = os.userInfo().homedir) {
  insist(typeof accountHome === 'string' && path.isAbsolute(accountHome) && path.resolve(accountHome) === accountHome, 'PRODUCTION_ROOT_INVALID');
  return Object.freeze({ home: accountHome, root: path.join(accountHome, 'Library/Application Support/NikUI/engine') });
}

function createMacPower({ launch = spawn, platform = process.platform, pid = process.pid, lidGuard } = {}) {
  let owner = null, child = null, exited = null;
  const lid = lidGuard || new (require('./lid').LidGuard)({ platform, pid });
  const check = (generation) => insist(owner === generation, 'POLICY_OWNER_MISMATCH');
  return {
    fake: false,
    recover(generation) { insist(!owner && platform === 'darwin', 'POWER_UNAVAILABLE'); owner = generation; },
    awake(generation, held) {
      check(generation);
      if (!held) { if (child) child.kill('SIGTERM'); return; }
      if (child) return;
      const process = launch('/usr/bin/caffeinate', ['-i', '-s', '-w', String(pid)], { stdio: 'ignore', detached: false });
      child = process;
      exited = new Promise((resolve) => {
        const ended = () => { if (child === process) child = null; resolve(); };
        process.once('exit', ended); process.once('error', ended);
      });
      process.unref?.();
    },
    lid(generation, held) { check(generation); lid.want(held, 'NikUI work'); },
    async release(generation) {
      check(generation);
      lid.wanted = false;
      await lid.enqueue(() => lid.give(false)); lid.dispose();
      if (child) {
        child.kill('SIGTERM');
        let timer;
        try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('POWER_RELEASE_UNPROVEN', 'Owned assertion did not exit')), 5000); })]); }
        finally { clearTimeout(timer); }
      }
      owner = null;
    }
  };
}

async function createProductionComposition({ selection, generation, ownership, context, secretStore, settings,
  approvedProjects, codexHome, selectedPins, log = () => {}, dependencies = {} }) {
  // The factory has no runtime opt-in. Tests inject dependencies and an explicit
  // account resolver; the signed entry must supply its account-derived selection.
  const account = (dependencies.account || os.userInfo)().homedir;
  const expected = dependencies.paths || productionPaths(account);
  insist(selection?.flavour === 'prod' && selection.home === expected.home && selection.root === expected.root, 'PRODUCTION_ROOT_INVALID');
  insist(typeof generation === 'string' && generation && ownership?.generation === generation &&
    ownership.committed === true && typeof ownership.assertCurrent === 'function', 'SERVICE_OWNERSHIP_REQUIRED');
  ownership.assertCurrent();
  insist(context?.globalState && context?.workspaceState && secretStore && settings && selectedPins, 'CURRENT_STATE_IMPORT_REQUIRED');
  loadIdentity(secretStore, { required: true, fingerprint: selectedPins.fingerprint });
  loadVapid(secretStore, { required: true, applicationServerKey: selectedPins.applicationServerKey });
  insist(Array.isArray(approvedProjects) && approvedProjects.length > 0 && approvedProjects.every((cwd) =>
    typeof cwd === 'string' && path.isAbsolute(cwd) && path.resolve(cwd) === cwd), 'PROJECT_APPROVAL_REQUIRED');
  insist([path.join(account, '.codex'), path.join(account, '.codex-work')].includes(codexHome), 'CODEX_ACCOUNT_SELECTION_REQUIRED');
  for (const directory of [selection.root, codexHome, ...approvedProjects]) {
    noSymlinks(directory); insist(fs.statSync(directory).isDirectory(), 'PRODUCTION_PATH_UNAVAILABLE');
  }
  privateDirectory(selection.root, false);
  const configured = { node: process.execPath };
  for (const [name, key] of [['claude', 'claudePath'], ['codex', 'codexPath']]) if (settings.get(key, '')) configured[name] = settings.get(key);
  const resolver = dependencies.resolver || createToolResolver({ home: account, configured, env: {} });
  const resolved = await resolver.resolveAll();
  ownership.assertCurrent();
  const launch = dependencies.spawn || spawn;
  const env = Object.freeze({ ...resolved.childEnv, HOME: account, USERPROFILE: account, ZDOTDIR: account,
    TMPDIR: path.join(selection.root, 'tmp'), CODEX_HOME: codexHome, NIKUI_KEEPER_DIR: path.join(selection.root, 'keeper') });
  function providerSpawn(name) {
    return (_command, args, options = {}, session) => {
      ownership.assertCurrent();
      const executable = resolved.tools[name]?.path;
      insist(executable && path.isAbsolute(executable), 'TOOL_MISSING');
      const cwd = options.cwd || approvedProjects[0];
      insist(approvedProjects.some((approved) => cwd === approved || cwd.startsWith(approved + path.sep)), 'PROJECT_APPROVAL_REQUIRED');
      noSymlinks(cwd);
      const spawnProvider = name === 'claude' && dependencies.keeperSpawn || launch;
      return spawnProvider(executable, args, { ...options, cwd, env: { ...env } }, session);
    };
  }
  const sourceSettings = (cwd) => {
    const source = cwd && settings.forProject ? settings.forProject(cwd) : settings;
    return { ...source, get: (key, fallback) => key === 'claudePath' ? resolved.tools.claude?.path || '' : source.get(key, fallback) };
  };
  const state = path.join(selection.root, 'state');
  for (const directory of [state, env.TMPDIR]) privateDirectory(directory);
  const engine = createEngine({ context, settings: sourceSettings,
    paths: { home: account, projects: path.join(account, '.claude/projects'), storage: state, codexCache: path.join(state, 'codex-cache') },
    spawner: providerSpawn('claude'),
    codex: { home: codexHome, codexPath: resolved.tools.codex?.path || path.join(selection.root, 'missing-codex'),
      unavailableReason: resolved.tools.codex?.path ? null : 'TOOL_MISSING: codex', spawnFn: providerSpawn('codex'), env,
      args: homeArgs(codexHome, { home: account, computerUse: settings.get('codexComputerUse', false), xcode: settings.get('codexXcode', false) }),
      ...(dependencies.codexCache ? { cache: dependencies.codexCache } : {}) },
    delivery: { create: (services) => createSelectedDelivery({ ...services, selection: { ...selectedPins, store: secretStore },
      send: dependencies.sendPush || require('./push').send, sendApple: dependencies.sendApple || require('./apns').send,
      paths: { apnsKeyFile: null } }) }, log });
  const power = dependencies.power || createMacPower();
  engine.createPolicy({ authority: createPolicyAuthority(), generation, power,
    settings, claudeBusy: () => engine.manager.list.filter((s) => s.isBusy).length,
    codexBusy: () => engine.codex.list.filter((s) => s.isBusy).length,
    notifications: {
      chime() {}, // The app presents the durable publication, including sound.
      post() {},
      release() {} // No native presenter resource is acquired by this process.
    } });
  engine.manager.on('changed', () => engine.policy.reconsider());
  engine.codex.on('changed', () => engine.policy.reconsider());
  return { engine, tools: resolved.tools, childEnv: env, power, exposure: 'off',
    // The cutover activation adapter, not construction, chooses when to start.
    async start() { ownership.assertCurrent(); await engine.start(); },
    async dispose() { await engine.dispose(); } };
}
module.exports = { productionPaths, createMacPower, createProductionComposition };
