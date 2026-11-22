'use strict';
const path = require('path');
const { createProductionKeeper } = require('../src/productionKeeper');
const { DaemonKeeper } = require('../src/daemonKeeper');
module.exports = async () => {
  suite('R11 service keeper after logout/reboot and exact legacy continuity');
  const root = '/fixture/service', legacy = '/fixture/legacy', values = new Map(), calls = [], links = [];
  const run = { runId: 'released-run', key: 'old', meta: { instance: 'old', cwd: '/fixture/project', conversation: 'conversation' },
    owned: false, exit: null, released: true, compatible: true };
  let legacyLive = true, listed = [run];
  const factory = (options) => {
    const link = { ...options, socket: null, socketPath: path.join(options.dir, 'k1.sock'),
      manifest: new Map(options.store.get('nikd.keeper.v1', { runs: [] }).runs.map((r) => [r.meta.instance, r])),
      async _list() { calls.push(['list', this.dir]); return this.dir === legacy ? listed : []; },
      spawner() { return async (_cmd, _args, _opts, session) => {
        const runs = await this._list(); DaemonKeeper.prototype._check.call(this, { instance: session.id, cwd: session.cwd, conversation: session.claudeSessionId || null }, runs);
        calls.push(['spawn', this.dir]); return { dir: this.dir };
      }; },
      async attach(session) { calls.push(['attach', this.dir, session.id]); return true; },
      async close() { calls.push(['close', this.dir]); }
    };
    links.push(link); return link;
  };
  const options = { root, store: { get: (k, fallback) => values.get(k) || fallback, update: (k, v) => values.set(k, v) },
    sources: [{ files: { keeper: { directory: legacy } }, keeper: { transferred: [run] } }], factory,
    probe: async (file) => file.startsWith(legacy + '/') && legacyLive ? 'live' : 'absent' };
  let keeper = createProductionKeeper(options);
  check('a transferred run reattaches to its original live keeper', await keeper.attach({ id: 'old' }));
  checkEqual('legacy continuity uses the exact released ID and existing-only link', calls.at(-1), ['attach', legacy, 'old']);
  checkEqual('the legacy keeper can never be launched by the service', links.find((s) => s.dir === legacy).existingOnly, true);
  const fresh = await keeper.spawner()('synthetic', [], {}, { id: 'new', cwd: '/fixture/project' });
  checkEqual('new runs use only the service-owned keeper directory', fresh.dir, root + '/keeper');
  let duplicate;
  try { await keeper.spawner()('synthetic', [], {}, { id: 'different', cwd: '/fixture/project', claudeSessionId: 'conversation' }); } catch (e) { duplicate = e.code; }
  checkEqual('new runs cannot duplicate a conversation still held by the source keeper', duplicate, 'KEEPER_CONVERSATION_LIVE');
  await keeper.close(); legacyLive = false; calls.length = 0;
  keeper = createProductionKeeper(options);
  checkEqual('after reboot an absent legacy keeper is treated as gone', await keeper.attach({ id: 'old' }), false);
  const afterReboot = await keeper.spawner()('synthetic', [], {}, { id: 'after-reboot', cwd: '/fixture/project' });
  checkEqual('a fresh Claude run after reboot can start in the owned directory', afterReboot.dir, root + '/keeper');
  check('the service neither dials nor starts a replacement at the vanished legacy directory', !calls.some((s) => ['spawn', 'list'].includes(s[0]) && s[1] === legacy));
  legacyLive = true; listed = [];
  checkEqual('a restarted keeper with a missing old run permits resuming that conversation', await keeper.attach({ id: 'old' }), false);
  listed = [{ ...run, runId: 'other-live-run', key: 'other', meta: { ...run.meta, instance: 'other' } }];
  checkEqual('a lost old run never permits duplicating a currently live conversation', await keeper.attach({ id: 'old' }), 'elsewhere');
  await keeper.close();
};

