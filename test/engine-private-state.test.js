'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { privateRoot, privateFile, checkPrivateTree } = require('../src/daemonPaths');
const { createTestStore } = require('../src/daemonStore');
const { acquireRootLock, diagnoseRoot } = require('../src/daemonLock');
const { createDaemonConfig, disposition, PROJECT } = require('../src/daemonConfig');
const { createEngine } = require('../src/engine');
const { createMachineHost } = require('../src/machineHost');
const { context, clock } = require('./fixtures/engine/fakes');
const manifest = require('../package.json').contributes.configuration.properties;
const error = async (fn) => { try { await fn(); return null; } catch (err) { return err.code || err.message; } };

module.exports = async function () {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-p-')));
  const root = path.join(home, 'd'), file = path.join(root, 'secrets.test.json');
  const paths = privateRoot(root);
  const write = (file, data) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  try {
    suite('T11/T20: explicit private daemon path guards');
    checkEqual('no default root can fall back to HOME', await error(() => privateRoot()), 'ROOT_REQUIRED');
    checkEqual('relative roots refuse', await error(() => privateRoot('relative')), 'ROOT_REQUIRED');
    checkEqual('HOME itself refuses, including a temporary HOME', await error(() => privateRoot(home, { envHome: home })), 'FORBIDDEN_ROOT');
    const forbidden = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'private');
    checkEqual('an editor profile refuses before any mkdir', await error(() => privateRoot(forbidden)), 'FORBIDDEN_ROOT');
    checkEqual('refused editor profile has no filesystem effects', fs.existsSync(path.join(home, 'Library')), false);
    const p2Home = fs.realpathSync(fs.mkdtempSync('/tmp/nd-p2-'));
    try {
      const production = path.join(p2Home, 'Library', 'Application Support', 'NikUI');
      checkEqual('R10: the P2 application support path under HOME is accepted',
        privateRoot(production, { envHome: p2Home }).root, production);
      checkEqual('R10: Code children still refuse alongside the P2 path',
        await error(() => privateRoot(path.join(p2Home, 'Library', 'Application Support', 'Code', 'User', 'private'), { envHome: p2Home })), 'FORBIDDEN_ROOT');
    } finally { fs.rmSync(p2Home, { recursive: true, force: true }); }
    checkEqual('extension globalStorage refuses in any source profile', await error(() => privateRoot(path.join(home, 'x', 'globalStorage', 'nikui'))), 'FORBIDDEN_ROOT');
    const alias = path.join(home, 'alias'); fs.symlinkSync(root, alias);
    checkEqual('a symlink root refuses', await error(() => privateRoot(alias)), 'UNSAFE_PATH');
    checkEqual('a symlink ancestor refuses', await error(() => privateRoot(path.join(alias, 'child'))), 'UNSAFE_PATH');
    const long = path.join(home, 'ü'.repeat(40));
    checkEqual('socket byte length, including Unicode, has a clear guard', await error(() => privateRoot(long)), 'SOCKET_PATH_TOO_LONG');
    checkEqual('overlong root is not created', fs.existsSync(long), false);
    const shared = path.join(home, 'shared'); fs.mkdirSync(shared, { mode: 0o755 });
    checkEqual('an existing permissive directory refuses without chmod', await error(() => privateRoot(shared)), 'UNSAFE_DIRECTORY');
    checkEqual('refusal preserves directory permissions', fs.statSync(shared).mode & 0o777, 0o755);
    const sentinel = path.join(home, 'source-state'); write(sentinel, 'DO NOT TOUCH');
    const redirect = path.join(root, 'derived-cache'); fs.symlinkSync(sentinel, redirect);
    checkEqual('nested source-state redirects refuse even in dormant caches', await error(() => checkPrivateTree(root)), 'UNSAFE_PATH');
    fs.unlinkSync(redirect);

    suite('T41: test-only 0600 file secrets preserve bytes and event shape');
    checkEqual('the file adapter cannot be mistaken for production storage', await error(() => createTestStore(file)), 'TEST_STORE_ONLY');
    const store = createTestStore(file, { testOnly: true }), events = [];
    const subscription = store.onDidChange((event) => events.push(event));
    await store.store('credential', 'SYNTHETIC-SECRET');
    checkEqual('the exact file permissions are private', fs.statSync(file).mode & 0o777, 0o600);
    checkEqual('SecretStorage emits a key-only event', events, [{ key: 'credential' }]);
    const reopened = createTestStore(file, { testOnly: true });
    checkEqual('synthetic keys persist across store reopen', reopened.get('credential'), 'SYNTHETIC-SECRET');
    const old = fs.readFileSync(file, 'utf8'), rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return rename(from, to); };
    try { checkEqual('write failure is visible', await error(() => store.store('credential', 'replacement')), 'EACCES'); }
    finally { fs.renameSync = rename; }
    checkEqual('failed update preserves prior disk and in-memory bytes', [fs.readFileSync(file, 'utf8'), store.get('credential')], [old, 'SYNTHETIC-SECRET']);
    checkEqual('failed update emits no credential change', events.length, 1);
    subscription.dispose(); await store.delete('credential');
    checkEqual('disposed event subscriptions stay detached', events.length, 1);
    store.dispose(); reopened.dispose();
    write(file, '{broken');
    check('corrupt storage refuses instead of resetting', await error(() => createTestStore(file, { testOnly: true })) !== null);
    checkEqual('corrupt bytes are preserved', fs.readFileSync(file, 'utf8'), '{broken');
    write(file, { version: 2, purpose: 'nikd-isolated-p1', values: {} });
    checkEqual('newer secret format refuses', await error(() => createTestStore(file, { testOnly: true })), 'STORE_UNAVAILABLE');
    fs.unlinkSync(file); fs.symlinkSync(sentinel, file);
    checkEqual('secret symlink refuses', await error(() => createTestStore(file, { testOnly: true })), 'UNSAFE_FILE');
    fs.unlinkSync(file); fs.linkSync(sentinel, file);
    checkEqual('secret hardlink refuses', await error(() => createTestStore(file, { testOnly: true })), 'UNSAFE_FILE');
    fs.unlinkSync(file); write(file, old); fs.chmodSync(file, 0o644);
    checkEqual('insecure secret file refuses without repair', await error(() => createTestStore(file, { testOnly: true })), 'UNSAFE_FILE');
    fs.unlinkSync(file);
    checkEqual('all secret/path faults leave source state untouched', fs.readFileSync(sentinel, 'utf8'), 'DO NOT TOUCH');
    const stat = fs.lstatSync;
    fs.lstatSync = function (file, ...args) { const st = stat.call(this, file, ...args); if (file === root) st.uid += 1; return st; };
    try { checkEqual('foreign-owned paths refuse without chown', await error(() => privateRoot(root)), 'UNSAFE_DIRECTORY'); }
    finally { fs.lstatSync = stat; }

    suite('T08: exclusive owner lock and conservative stale recovery');
    const first = await acquireRootLock(paths);
    const original = fs.readFileSync(paths.lock, 'utf8');
    checkEqual('a live but unavailable owner is never stolen', await error(() => acquireRootLock(paths, { alive: () => 'alive', probe: async () => 'absent' })), 'OWNER_UNAVAILABLE');
    checkEqual('owner refusal preserves the lock bytes', fs.readFileSync(paths.lock, 'utf8'), original);
    first.release(); first.release();
    write(paths.lock, { version: 1, pid: 123, token: 'dead-fixture' });
    checkEqual('socket uncertainty prevents dead-pid takeover', await error(() => acquireRootLock(paths, { alive: () => 'dead', probe: async () => 'unproved' })), 'OWNER_UNAVAILABLE');
    checkEqual('a live endpoint prevents dead-pid takeover', await error(() => acquireRootLock(paths, { alive: () => 'dead', probe: async () => 'live' })), 'OWNER_EXISTS');
    const recovered = await acquireRootLock(paths, { alive: () => 'dead', probe: async () => 'absent' });
    check('proved dead pid plus absent endpoint permits O_EXCL recovery', JSON.parse(fs.readFileSync(paths.lock)).token === recovered.token);
    recovered.release();
    const recoveryLock = paths.lock + '.reap';
    write(recoveryLock, { version: 1, pid: 124, token: 'dead-reaper' });
    const reaperBytes = fs.readFileSync(recoveryLock, 'utf8');
    const diagnosis = await diagnoseRoot(paths, { alive: () => 'dead', probe: async () => 'absent' });
    checkEqual('R10: dead recovery lock doctor prints the exact manual fix', diagnosis.manualFix, "rm -- '" + recoveryLock + "'");
    check('R10: manual recovery requires stopped starts and never removes the endpoint', /all nikd starts.*stopped/.test(diagnosis.hint));
    checkEqual('R10: doctor never performs its manual fix', fs.readFileSync(recoveryLock, 'utf8'), reaperBytes);
    checkEqual('R10: live/unproved recovery never suggests removing its lock',
      (await diagnoseRoot(paths, { alive: () => 'alive', probe: async () => 'absent' })).manualFix, undefined);
    checkEqual('R10: even a dead reaper cannot authorize removing a live endpoint',
      (await diagnoseRoot(paths, { alive: () => 'dead', probe: async () => 'live' })).manualFix, undefined);
    fs.unlinkSync(recoveryLock);
    write(paths.lock, '{partial owner');
    checkEqual('an incomplete/unreadable owner is not assumed dead', await error(() => acquireRootLock(paths)), 'OWNER_UNPROVEN');
    checkEqual('unproved owner bytes survive', fs.readFileSync(paths.lock, 'utf8'), '{partial owner');
    fs.unlinkSync(paths.lock);
    const endpoint = net.createServer();
    await new Promise((resolve) => endpoint.listen(paths.socket, resolve)); fs.chmodSync(paths.socket, 0o600);
    try {
      const inode = privateFile(paths.socket, { socket: true }).ino;
      checkEqual('a socket with no owner record is never unlinked', await error(() => acquireRootLock(paths)), 'OWNER_UNPROVEN');
      checkEqual('the unproved live endpoint keeps its inode', fs.lstatSync(paths.socket).ino, inode);
      checkEqual('failed acquisition leaves no new root lock', fs.existsSync(paths.lock), false);
    } finally { await new Promise((resolve) => endpoint.close(resolve)); }

    suite('T06/P1-02: service settings enforce all 58 scope dispositions');
    checkEqual('every contributed key has an explicit service disposition', Object.keys(manifest).length, 58);
    checkEqual('editor values are excluded from daemon imports', await error(() => createDaemonConfig({ root, user: { statusEmoji: false } })), 'CONFIG_SCOPE');
    checkEqual('machine policy cannot arrive in project settings', await error(() => createDaemonConfig({ root, projects: [{ root,
      approved: true, provenance: { profile: 'p', workspace: 'w', rawScope: 'folder' }, values: { claudePath: '/source/secret/tool' } }] })), 'CONFIG_SCOPE');
    for (const key of Object.keys(manifest).map((key) => key.slice(6))) {
      check('mapping is exhaustive for ' + key, ['editor-only', 'machine-policy-local-only', 'engine-user'].includes(disposition(key)));
      if (!PROJECT.has(key)) {
        checkEqual('project scope refuses ' + key, await error(() => createDaemonConfig({ root, projects: [{ root, approved: true,
          provenance: { profile: 'p', workspace: 'w', rawScope: 'folder' }, values: { [key]: manifest['nikui.' + key].default } }] })), 'CONFIG_SCOPE');
      }
    }
    checkEqual('project values require owner approval and provenance', await error(() => createDaemonConfig({ root, projects: [{ root, values: { model: 'project' } }] })), 'CONFIG_PROVENANCE');
    const project = path.join(root, 'project'), other = path.join(root, 'other');
    const source = createDaemonConfig({ root, user: { model: 'owner', fontSize: 15, promptSnippets: { owner: 'owner prompt', private: 'owner default' } }, projects: [{ root: project, approved: true,
      provenance: { profile: 'fixture', workspace: 'file:///fixture', rawScope: 'workspaceFolderValue' }, values: { model: 'project', showThinking: false,
        resumePrompt: '  private project nudge\n', promptSnippets: { private: 'project prompt' } } }] });
    checkEqual('project values apply only to the explicit project', [source.get('model'), source.forProject(project).get('model'),
      source.forProject(other).get('model'), source.forProject(project).get('fontSize')], ['owner', 'project', 'owner', 15]);
    checkEqual('machine policy remains local-owner only after construction', await error(() => source.update('claudePath', '/new/tool')), 'LOCAL_OWNER_REQUIRED');
    const engine = createEngine({ context: context(), settings: source, paths: { home: root, projects: root }, timers: clock(),
      spawner() { throw new Error('not started'); }, codex: { unavailableReason: 'fixture' } });
    try {
      const a = engine.manager.create({ cwd: project, autoStart: false }), b = engine.manager.create({ cwd: other, autoStart: false });
      checkEqual('actual engine sessions use the scoped model source', [a.model, b.model], ['project', 'owner']);
      checkEqual('project snippets merge with manifest defaults through the actual manager', engine.manager.configFor(project).promptSnippets.private, 'project prompt');
      checkEqual('project snippets retain independent owner snippets', engine.manager.configFor(project).promptSnippets.owner, 'owner prompt');
      const host = createMachineHost({ manager: engine.manager, settings: source, env: { home: root } });
      checkEqual('host rendering reads the requested project without changing fleet defaults', [host.config(project).showThinking, host.config(other).showThinking, host.env(a).showThinking], [false, true, false]);
      a.resume = ({ nudge }) => { a.fixtureNudge = nudge; return true; };
      b.resume = ({ nudge }) => { b.fixtureNudge = nudge; return true; };
      engine.manager.pause = { until: 1 }; engine.manager.resumeFromLimit();
      checkEqual('project-aware resume preserves raw prompt bytes and other projects keep the default', [a.fixtureNudge, b.fixtureNudge], ['  private project nudge\n', source.get('resumePrompt')]);
    } finally { await engine.dispose(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
};
