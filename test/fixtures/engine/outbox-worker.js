'use strict';
// Abrupt-exit fixture. Its provider boundary is an in-process function; no
// keeper, CLI, network or user-owned application is contacted.
const fs = require('fs');
const { openAuthority } = require('../../../src/jsonlAuthority');
const { createEngineState, DOMAIN } = require('../../../src/engineState');
const root = process.argv[2], phase = process.argv[3], at = 1795179601000;
(async () => {
  const authority = await openAuthority({ file: root + '/authority.jsonl', now: () => at });
  const runtime = await createEngineState({ authority, root, now: () => at, ready: () => true, deliver: () => process.exit(78) });
  if (!authority.snapshot().values[DOMAIN].instances.length) await runtime.register({ id: 'instance-7', cwd: root });
  if (phase === 'accept') {
    const answer = await runtime.dispatch({ authenticated: true, principal: 'device:phone-1', role: 'conversation', target: 'session:instance-7',
      seat: { id: 'phone-1', control: true, local: false, editor: false } }, { type: 'send', mid: 'a'.repeat(32), scope: authority.snapshot().scope, issuedAt: at,
      ...JSON.parse(fs.readFileSync(root + '/input.json', 'utf8')) });
    if (answer.outcome !== 'applied') throw new Error('Fixture acceptance failed');
    process.exit(77);
  }
  runtime.start(); await runtime.drain('session:instance-7');
  throw new Error('Fixture did not cross its dispatch boundary');
})().catch((error) => { process.stderr.write(error.stack); process.exit(79); });
