'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createEngine } = require('../../src/engine');
const { Durable } = require('../../src/durable');
const { createTestStore } = require('../../src/daemonStore');
const { createSyntheticOwner } = require('../../src/engineOwner');
const { createParticipantGate, exportContext, createSyntheticImporter, GLOBAL_KEYS, WORKSPACE_KEYS } = require('../../src/engineTransfer');
const { settings, clock } = require('../fixtures/engine/fakes');
const { errorCode, deferred } = require('./engine-disk');
const mkdir = (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

async function cutoverFixture(dir, { count = 2, waitMs = 50, fault } = {}) {
  dir = path.join(path.dirname(dir), crypto.createHash('sha256').update(path.basename(dir)).digest('hex').slice(0, 4));
  mkdir(dir);
  const selected = path.join(dir, 's'), targetRoot = path.join(dir, 't'); mkdir(selected); mkdir(targetRoot);
  const options = { root: selected, profile: 'test-profile', install: 'test-build-location', testOnly: true, waitMs, fault };
  const owner = createSyntheticOwner(options); await owner.initialize();
  const sources = [], trace = [], secrets = { 'nikui.identity': { publicKey: 'synthetic-public', privateKey: 'synthetic-private' },
    'nikui.vapid': { public: 'synthetic-vapid', private: 'synthetic-vapid-private' } };
  for (let i = 1; i <= count; i++) {
    const member = await owner.admit({ id: 'window-' + i, build: 'loaded-meta-build', metaVersion: 1 });
    const home = path.join(selected, 'w' + i); mkdir(home); mkdir(path.join(home, 'state')); mkdir(path.join(home, 'projects'));
    const fakeClock = clock(), gate = createParticipantGate({ owner, member, timers: fakeClock });
    const rawGlobal = createTestStore(path.join(home, 'global.json'), { testOnly: true });
    const rawWorkspace = createTestStore(path.join(home, 'workspace.json'), { testOnly: true });
    const context = { globalState: gate.store(rawGlobal), workspaceState: gate.store(rawWorkspace) };
    const durable = new Durable({ dir: path.join(home, 'state'), place: 'workspace:' + home, fs: gate.fs(fs) });
    const engine = createEngine({ context, paths: { home, projects: path.join(home, 'projects'), storage: path.join(home, 'state') },
      settings: settings({ model: 'fixture-model' }), spawner: () => { throw new Error('Synthetic exports never spawn providers'); },
      codex: { unavailableReason: 'Synthetic export fixture' }, timers: fakeClock, fs: gate.fs(fs), durable });
    const session = engine.manager.create({ id: 'session-' + i, cwd: home, resume: 'conversation-' + i, autoStart: false });
    session.rename('Source ' + i);
    let folderSequence = 0; engine.folders.nextId = () => 'folder-' + i + '-' + (++folderSequence);
    session.queue = [{ id: 'queue-' + i, text: 'full 🧪 prompt '.repeat(2000), sent: 'expanded '.repeat(2000),
      snippets: Array.from({ length: 12 }, (_, n) => 'snippet-' + n), attachments: [{ mime: 'image/png', data: 'FULL-IMAGE-BYTES' }] }];
    const folder = engine.folders.create('Folder ' + i); engine.folders.place(session, folder.id);
    engine.manager.limits = { at: 123, remaining: 0 }; engine.manager.pause = { until: 9999999999999 }; engine.manager.limitOverride = 42;
    engine.ledger.data.instances.shared = { cost: i * 2, tokens: i * 10, turns: i, firstAt: 100 - i, lastAt: 100 + i };
    engine.ledger.pending = true;
    let admitting = true, detached = false;
    const source = { member, engine, gate, fakeClock, context, rawGlobal, rawWorkspace, home,
      get admitting() { return admitting; }, get detached() { return detached; },
      exportState: () => exportContext({ context, engine, settings: { version: 1, user: { model: 'fixture-model' }, projects: [] },
        provenance: { profile: 'test-profile', workspace: home, rawScope: 'workspace' },
        globalKeys: GLOBAL_KEYS, workspaceKeys: WORKSPACE_KEYS,
        secrets: { get: (key) => secrets[key] }, secretKeys: Object.keys(secrets),
        files: { durable: () => durable._read() } }),
      quiesce: (t) => gate.quiesce(t, {
        closeAdmission() { admitting = false; trace.push(['close', member.id]); },
        cancel() { fakeClock.tasks.clear(); trace.push(['cancel', member.id]); },
        drain() { trace.push(['drain', member.id]); },
        flush() { engine.manager.persist(); engine.flush(); trace.push(['flush', member.id]); },
        detach() { detached = true; fakeClock.tasks.clear(); for (const s of engine.manager.list) s.removeAllListeners(); trace.push(['detach', member.id]); },
        releaseResources() { return { released: true, owned: [] }; },
        exportState: async () => { trace.push(['export', member.id]); return source.exportState(); }
      }) };
    sources.push(source);
  }
  let starts = 0;
  const importer = createSyntheticImporter({ root: targetRoot, target: 'test-service', owner, testOnly: true,
    activate() { starts++; trace.push(['activate']); } });
  const inventory = () => ({ complete: true, scope: owner.scope, ids: sources.map((s) => s.member.id), otherScopes: [] });
  return { owner, options, selected, targetRoot, importer, sources, trace, secrets, inventory, get starts() { return starts; },
    async close() {
      // Retired source engines do not run dispose-time persistence. Their
      // listeners/timers are already detached; close read caches explicitly.
      for (const s of sources) {
        s.fakeClock.tasks.clear(); s.engine.history.dispose(); s.engine.codex.dispose();
        s.rawGlobal.dispose(); s.rawWorkspace.dispose();
        for (const session of s.engine.manager.list) session.removeAllListeners();
      }
    } };
}

module.exports = { cutoverFixture, mkdir, errorCode, deferred };
