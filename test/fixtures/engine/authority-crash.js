'use strict';
const { openAuthority } = require('../../../src/jsonlAuthority');
const [file, step] = process.argv.slice(2);
(async () => {
  const store = await openAuthority({ file, hook: async (at) => { if (at === step) process.exit(73); } });
  if (!store.status().writable) process.exit(74);
  if (step.startsWith('append:')) {
    await store.commit((next) => {
      next.values.unacknowledged = true;
      next.entries.push({ v: 1, scope: next.scope, principal: 'device:fixture', mid: 'e'.repeat(32), target: 'session:fixture', what: 'send',
        issuedAt: next.clockHighWater, at: next.clockHighWater, expiresAt: next.clockHighWater + 86400000, hash: 'e'.repeat(64),
        phase: 'prepared', outcome: 'pending', result: null, error: null, reservedResultBytes: 16384, requestRef: 'outbox:crash' });
      next.outbox.push({ v: 1, id: 'outbox:crash', scope: next.scope, principal: 'device:fixture', mid: 'e'.repeat(32), state: 'prepared',
        payload: { text: 'full unacknowledged input', sent: 'expanded input', attachments: ['fixture image'] } });
    });
  } else await store.compact();
  await store.close(); process.exit(75);
})().catch(() => process.exit(76));
