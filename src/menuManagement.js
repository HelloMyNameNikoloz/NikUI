'use strict';

// Private local-owner administration only. These commands are never registered
// with the HTTP/phone dispatcher. Settings are staged, not applied to live runs.
const fs = require('fs');
const path = require('path');
const { inside, noSymlinks, fail } = require('./daemonPaths');
const { executable } = require('./toolResolver');
const SETTINGS = 'engine.menuSettings.v1';
const IMPORT_BLOCKER = 'PRODUCTION_CUTOVER_DISABLED';
const HEARTBEAT_MS = 25000;
const insist = (v, code) => { if (!v) throw fail(code, code); };
const defaults = (home) => ({ revision: 0, tools: { claude: null, codex: null, node: null, gh: null },
  codexHome: path.join(home, '.codex-work'), port: 0, bind: '127.0.0.1' });
function validateSettings(value, { home, pinnedNode, requireExecutable = true }) {
  insist(value && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Number.isInteger(value.port) && value.port >= 0 && value.port <= 65535, 'CONFIG_INVALID');
  // RemoteServer's existing loopback security boundary is retained. Exposure
  // needs a separate generation-owned route contract, never a text field.
  insist(value.bind === '127.0.0.1', 'BIND_LOOPBACK_REQUIRED');
  insist(typeof value.codexHome === 'string' && value.codexHome !== home &&
    value.codexHome.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value.codexHome) &&
    path.resolve(value.codexHome) === value.codexHome && inside(home, value.codexHome), 'CODEX_HOME_OUTSIDE_TEST_PROFILE');
  noSymlinks(value.codexHome);
  if (fs.existsSync(value.codexHome)) insist(fs.statSync(value.codexHome).isDirectory(), 'CODEX_HOME_INVALID');
  insist(value.tools && Object.keys(value.tools).sort().join(',') === 'claude,codex,gh,node', 'CONFIG_INVALID');
  for (const [name, file] of Object.entries(value.tools)) {
    if (file === null) continue;
    insist(typeof file === 'string' && file.length <= 4096 && !/[\x00-\x1f\x7f]/.test(file) && path.isAbsolute(file) &&
      path.resolve(file) === file && (!requireExecutable || executable(file)), 'TOOL_PATH_INVALID');
    // Executable symlinks (e.g. Homebrew) are valid tools. They are never
    // invoked during validation, and no shell argument is constructed.
    insist(name !== 'node' || !pinnedNode || file === pinnedNode, 'BUNDLED_NODE_PINNED');
  }
  return structuredClone(value);
}
const equivalent = (a, b) => a.codexHome === b.codexHome && a.port === b.port && a.bind === b.bind &&
  ['claude', 'codex', 'node', 'gh'].every((key) => a.tools[key] === b.tools[key]);
function createMenuManagement({ paths, authority, engine, status, bridge, refreshTools, activeSettings, pinnedNode,
  heartbeatMs = HEARTBEAT_MS }) {
  const observers = new Set();
  let disposed = false, pending;
  const read = () => structuredClone(authority.snapshot().values[SETTINGS] || activeSettings);
  const requiresRestart = () => !equivalent(read(), activeSettings);
  function snapshot() {
    const current = status();
    const outbox = authority.snapshot().outbox;
    // The current-state diagnostic is authoritative about unresolved outcomes;
    // do not infer safety from an empty visible fleet or from editor focus.
    const state = current.authority?.currentState || {};
    const fleet = engine.remote.fleetMessage();
    fleet.instances = fleet.instances.map((row) => ({ ...row, running: !!engine.manager.get(row.id)?.proc }));
    fleet.codex = fleet.codex.map((row) => ({ ...row, running: !row.asleep || ['working', 'waiting'].includes(row.status) }));
    return { status: current, fleet, browserURL: engine.remote.url,
      settings: read(), requiresRestart: requiresRestart(), importBlocker: IMPORT_BLOCKER,
      updateBlockers: [...new Set([...(!current.authority?.writable || state.issue ? ['AUTHORITY_UNAVAILABLE'] : []),
        ...(engine.manager.list.some((s) => s.isBusy) || engine.codex.list.some((s) => s.isBusy) ? ['OWNED_WORK_BUSY'] : []),
        ...(current.lifecycle.phase !== 'running' ? ['DRAINING'] : []),
        ...(outbox.some((q) => ['dispatching', 'unknown'].includes(q.state)) ? ['UNSAFE_OPERATION_PENDING'] : []),
        ...(state.dispatches || state.drains ? ['PROVIDER_DISPATCH_ACTIVE'] : [])])] };
  }
  function changed() {
    if (disposed || pending || !observers.size) return;
    pending = setTimeout(() => { pending = null; for (const observer of observers) observer.send(); }, 250);
    pending.unref();
  }
  const onChanged = () => changed();
  engine.manager.on('changed', onChanged);
  engine.codex.on('changed', onChanged);
  async function command(op, args, revalidate) {
    if (op === 'menu.snapshot') return snapshot();
    if (op === 'tools.refresh') { await refreshTools(); revalidate(); changed(); return snapshot(); }
    if (op === 'engine.settings.get') return { settings: read(), requiresRestart: requiresRestart() };
    insist(op === 'engine.settings.update', 'LOCAL_COMMAND_UNSUPPORTED');
    const next = validateSettings(args, { home: paths.home, pinnedNode });
    await authority.commit((saved) => {
      revalidate();
      const current = saved.values[SETTINGS] || activeSettings;
      insist(current.revision === next.revision, 'STALE_SETTINGS');
      saved.values[SETTINGS] = { ...next, revision: current.revision + 1 };
    });
    changed();
    return { settings: read(), requiresRestart: requiresRestart() };
  }
  function observe(request, socket) {
    if (!bridge().localContext(request) || request.generation !== status().generation) {
      socket.end(JSON.stringify({ ok: false, code: 'ENROLLMENT_OR_GENERATION_INVALID' }) + '\n'); return;
    }
    let previous;
    const observer = { send(force = false) {
      try {
        if (!bridge().localContext(request) || disposed || socket.writableLength > 524288) return socket.destroy();
        const data = snapshot();
        const signature = JSON.stringify({ ...data, fleet: { ...data.fleet, at: 0 } });
        if (!force && signature === previous) return;
        previous = signature;
        const frame = JSON.stringify({ type: 'menu:snapshot', version: 1, data });
        if (Buffer.byteLength(frame) > 262144) return socket.destroy();
        socket.write(frame + '\n');
      } catch (_) { socket.destroy(); }
    } };
    observers.add(observer);
    const heartbeat = setInterval(() => observer.send(true), heartbeatMs); heartbeat.unref();
    socket.once('close', () => { clearInterval(heartbeat); observers.delete(observer); });
    // This is a receive-only subscription. Unexpected input closes it.
    socket.on('data', () => socket.destroy());
    observer.send();
  }
  return { command, snapshot, observe, changed, get observerCount() { return observers.size; },
    dispose() {
      disposed = true; clearTimeout(pending);
      engine.manager.removeListener('changed', onChanged); engine.codex.removeListener('changed', onChanged);
      // createControl owns sockets; it destroys them during the next drain stage.
    } };
}
module.exports = { SETTINGS, IMPORT_BLOCKER, HEARTBEAT_MS, defaults, validateSettings, createMenuManagement };
