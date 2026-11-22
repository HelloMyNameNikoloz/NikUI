'use strict';

// Swift's headless Mac integration fixture. Real nikd composition and sockets;
// synthetic providers only. Never uses Keychain, launchd or the live profile.
const path = require('path'), readline = require('readline');
const { startDaemon } = require('../../src/daemonRuntime');
const { createAcceptanceFixture } = require('../../src/acceptanceFixture');
const { controlRequest } = require('../../src/daemonControl');
(async () => {
  const root = path.resolve(process.argv[2]);
  const fixture = createAcceptanceFixture({ root, testOnly: true });
  const daemon = await startDaemon({ root, adapters: { ...fixture.adapters,
    tools: { knownDirs: [], lookup: async () => ({ tools: {} }) } } });
  fixture.attach(daemon);
  const call = (action) => controlRequest(daemon.paths, { op: 'acceptance-p2', action });
  for (const action of ['seed', 'codex-busy', 'codex-idle']) {
    const result = await call(action); if (!result.ok) throw new Error(JSON.stringify(result));
  }
  process.stdout.write(JSON.stringify({ root, generation: daemon.generation, engine: daemon.status().engine }) + '\n');
  const input = readline.createInterface({ input: process.stdin });
  let lane = Promise.resolve();
  input.on('line', (action) => { lane = lane.then(async () => {
    if (action === 'stop') { await daemon.stop(); input.close(); process.exit(0); }
    process.stdout.write(JSON.stringify(await call(action)) + '\n');
  }).catch((error) => { console.error(error); process.exit(1); }); });
  input.on('close', () => { void daemon.stop(); });
})().catch((error) => { console.error(error); process.exit(1); });
