'use strict';

// Called exclusively after --native has created/registered this exact bundle.
// Existing tailnet configuration is observed, never adopted or modified.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createSecItemAdapter } = require('../src/keychainStore');
const { controlRequest } = require('../src/daemonControl');
const { LABEL } = require('./build-mac-engine');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
function findRouteTool() {
  const selected = process.env.NIKUI_P2_TAILSCALE;
  if (selected && !path.isAbsolute(selected)) throw new Error('NIKUI_P2_TAILSCALE must be an absolute CLI path');
  return [selected, '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'].filter(Boolean).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch (_) { return false; }
  }) || null;
}
function routeSnapshot(tool, run = spawnSync) {
  if (!tool) return { status: 'unconfigured/unrun', code: 'TAILSCALE_NOT_RESOLVED' };
  const r = run(tool, ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' } });
  if (r.error || r.status !== 0) return { status: 'unconfigured/unrun', code: 'TAILSCALE_STATUS_UNAVAILABLE' };
  try { return { status: 'observed', sha256: hash(JSON.stringify(canonical(JSON.parse(r.stdout)))) }; }
  catch (_) { return { status: 'unconfigured/unrun', code: 'TAILSCALE_STATUS_INVALID' }; }
}
async function corruptSelectedStore(context) {
  const { built, app, paths, controller, run } = context;
  const evidence = path.join(run, 'p2-corrupt-selected-store.json');
  const adapter = createSecItemAdapter({ helper: path.join(app, 'Contents/Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
    service: built.keychainService, home: built.testHome });
  const before = adapter.read('store.v1'); assert(before);
  const marker = path.join(paths.root, 'test-keychain-selection.json'), markerHash = hash(fs.readFileSync(marker));
  const proof = { status: 'running', evidence, label: LABEL, exactService: adapter.service };
  let restored = false, unregistered = false;
  try {
    controller('intentional-stop');
    adapter.update('store.v1', Buffer.from('{corrupt-selected-test-store'));
    let refused;
    try { controller('start'); } catch (e) { refused = e; }
    assert(refused, 'Corrupt selected store unexpectedly started');
    const log = fs.readFileSync(path.join(built.testHome, 'engine.stderr.log'), 'utf8');
    assert(log.split(/\r?\n/).some((s) => { try { return JSON.parse(s).code === 'KEYCHAIN_CORRUPT'; } catch (_) { return false; } }));
    assert.equal(controller('status').control, null);
    assert.equal(hash(fs.readFileSync(marker)), markerHash);
    assert.equal(fs.existsSync(paths.secrets), false);
    controller('unregister'); unregistered = true;
    adapter.update('store.v1', before);
    assert.equal(hash(adapter.read('store.v1')), hash(before)); restored = true;
    controller('register'); unregistered = false;
    const restarted = controller('start').control;
    const state = await controlRequest(paths, { op: 'acceptance-p2', action: 'state' });
    const selection = JSON.parse(fs.readFileSync(marker, 'utf8')).selection;
    assert.equal(state.fingerprint, selection.fingerprint); assert.equal(state.applicationServerKey, selection.applicationServerKey);
    Object.assign(proof, { status: 'passed', refusal: 'KEYCHAIN_CORRUPT', noFileFallback: true,
      selectedMarkerUnchanged: true, restoredExactBytes: true,
      lastStatus: { pid: restarted.pid, generation: restarted.generation } });
    return proof;
  } finally {
    // Even a failed registration/start never destroys the only selected key.
    // Restore this exact test service only; the outer driver's finally owns
    // its registration/job/bundle cleanup.
    if (!restored) { adapter.update('store.v1', before); restored = true; }
    proof.restored = restored; proof.unregisteredAtExit = unregistered;
    fs.writeFileSync(evidence, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  }
}
module.exports = { routeSnapshot, findRouteTool, corruptSelectedStore };
