'use strict';

const crypto = require('crypto');
const path = require('path');
const { createLocalManagement } = require('./localManagement');
const { createLocalSettings } = require('./localSettings');
const { createLocalHistory } = require('./localHistory');
const { PairingWindow } = require('./pairing');
const { DOMAIN } = require('./engineState');
const { createDaemonConfig } = require('./daemonConfig');
const { REVOCATIONS, reconcileDeviceRevocations } = require('./wireMutations');
const { fail } = require('./daemonPaths');
const CLIENTS = 'nikd.developmentClients.v1';

// Explicit isolated-daemon composition. No production engine imports this.
function createDaemonManagement({ engine, paths, authority, currentState, settings, secrets, generation, running, bridge, keeper, canRun = false,
  provenance = { profile: 'isolated:' + crypto.createHash('sha256').update(paths.root).digest('hex'), workspace: paths.root, rawScope: 'user' },
  approvedProjects = () => [], adapters = {} }) {
  const store = { get: (key, fallback) => authority.snapshot().values[key] ?? fallback,
    update: (key, value, revalidate = () => {}) => authority.commit((s) => { revalidate(); s.values[key] = structuredClone(value); }) };
  let management;
  const history = createLocalHistory({ root: path.join(paths.home, '.claude', 'projects'), history: engine.history,
    approvedProject: (cwd) => management.knownProject(cwd),
    existing: (conversation) => engine.manager.list.find((s) => s.claudeSessionId === conversation),
    owners: async (conversation) => {
      if (adapters.historyOwners) return adapters.historyOwners(conversation);
      if (keeper) {
        const runs = await keeper._list();
        return { complete: true, owners: [{ connected: true, metaVersion: keeper.metaVersion,
          runs: runs.map((r) => ({ conversation: r.meta?.conversation, exited: !!r.exit })) }] };
      }
      const current = () => ({ complete: true, owners: [{ connected: true, metaVersion: 1,
        runs: engine.manager.list.filter((s) => s.proc).map((s) => ({ conversation: s.claudeSessionId, exited: false })) }] });
      // Direct providers in this daemon are in-process synthetic adapters.
      // All admissions share this JS turn; external keeper owners must supply
      // an actual all-owner guard instead of treating a cached list as one.
      return { ...current(), guarded: true, revalidate: current, release() {} };
    },
    resume: ({ cwd, conversation }) => {
      if (!canRun) throw fail('HISTORY_RESUME_UNAVAILABLE', 'Provider execution is disabled');
      const existing = engine.manager.list.find((s) => s.claudeSessionId === conversation);
      if (existing) return { id: existing.id, resumed: false };
      const names = engine.manager.context.globalState.get('nikui.names.v1', {});
      const s = engine.manager.create({ cwd, resume: conversation, title: names[conversation] || null });
      return { id: s.id, resumed: true };
    } });
  const pairing = engine.delivery.pairing || new PairingWindow();
  management = createLocalManagement({ engine, currentState, root: paths.home, generation,
    admitting: () => running() && currentState.status().admitting,
    authorize: (context) => context.principal.startsWith('local-client:') && secrets.get(CLIENTS, [])
      .some((c) => !c.revoked && context.principal === 'local-client:' + c.id), store, history, provenance,
    announcedProjects: () => [...new Set([...(bridge()?.projects() || []), ...approvedProjects()])],
    settings: (context) => createLocalSettings({ root: paths.home, read: () => authority.snapshot().values[DOMAIN].settings,
      commit: async (_next, revalidate, change) => {
        const committed = await authority.commit((s) => {
          revalidate(); const latest = s.values[DOMAIN].settings;
          let values;
          if (change.scope === 'user') { values = latest.user; (latest.provenance ||= {})[change.key] = change.provenance; }
          else {
            let project = latest.projects.find((p) => p.root === change.root);
            if (!project) { project = { root: change.root, approved: true, provenance: change.provenance, values: {} }; latest.projects.push(project); }
            project.provenance = change.provenance; values = project.values;
          }
          if (change.value === null) delete values[change.key]; else values[change.key] = change.value;
          createDaemonConfig({ ...latest, root: paths.home });
        }); settings.refreshAll(committed.values[DOMAIN].settings); engine.policy?.reconsider();
      }, approvedProject: (cwd) => management.knownProject(cwd), provenance,
      editorStore: { get: (key, fallback) => store.get('engine.editor.' + context.principal, {})[key] ?? fallback,
        update: (key, value, revalidate) => authority.commit((s) => { revalidate();
          const name = 'engine.editor.' + context.principal;
          s.values[name] = { ...(s.values[name] || {}), [key]: structuredClone(value) }; }) } }),
    adapters: {
      async revokeDevice(id, forget, revalidate) {
        const d = engine.delivery.devices.get(id);
        if (!d) throw fail('NOT_FOUND', 'Device not found');
        revalidate();
        if (!forget) { engine.delivery.devices.setControl(id, false); return { id, control: false }; }
        const enrollment = crypto.createHash('sha256').update(JSON.stringify([d.id, d.publicKey || null, d.pairedAt || null])).digest('hex');
        await authority.commit((s) => {
          revalidate(); const fresh = engine.delivery.devices.get(id);
          if (!fresh || crypto.createHash('sha256').update(JSON.stringify([fresh.id, fresh.publicKey || null, fresh.pairedAt || null])).digest('hex') !== enrollment) throw fail('STALE_RESOURCE', 'Device changed');
          (s.values[REVOCATIONS] ||= []).push({ device: id, enrollment });
        });
        currentState.activateDeviceRevocation(id);
        reconcileDeviceRevocations(authority, engine.delivery.devices, engine.delivery.audience, id);
        return { id, forgotten: true };
      },
      pairing(action, args, revalidate) {
        revalidate();
        if (action === 'open') {
          pairing.ttl = args.seconds * 1000;
          pairing.start({ host: '127.0.0.1:' + engine.remote.port, fingerprint: engine.delivery.identity.fingerprint, laptop: 'Isolated NikUI test' });
        } else if (action === 'close') pairing.close('local-owner');
        const state = pairing.state();
        return { ...state, qr: state.open ? { text: state.link, appText: state.appLink } : null };
      },
      localClients(action, args, context, revalidate) {
        revalidate();
        const saved = secrets.get(CLIENTS, []);
        if (action === 'list') return { clients: saved.map(({ id, kind, revoked }) => ({ id, kind, revoked: !!revoked })) };
        const selected = saved.find((c) => c.id === args.id);
        if (!selected) throw fail('NOT_FOUND', 'Local enrollment not found');
        selected.revoked = true;
        secrets.update(CLIENTS, action === 'forget' ? saved.filter((c) => c !== selected) : saved);
        // Enqueue this command's response before dropping its own connection.
        setImmediate(() => bridge()?.revoke(args.id));
        return { id: args.id, revoked: true, forgotten: action === 'forget' };
      },
      ...adapters
    } });
  return management;
}

module.exports = { createDaemonManagement };
