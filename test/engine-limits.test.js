'use strict';
const fs = require('fs');
const { LIMITS } = require('../src/jsonlAuthority');
const { disk, receipt, intent, stamp, mid, errorCode } = require('./helpers/engine-disk');

module.exports = async function () {
  suite('T19: production limits and actual 10,000-entry disk boundary');
  checkEqual('production receipt, live-byte, outbox, payload and result caps match protocol v2',
    [LIMITS.maxEntries, LIMITS.maxBytes, LIMITS.maxOutbox, LIMITS.maxPayloadBytes, LIMITS.maxResultBytes, LIMITS.retentionMs, LIMITS.skewMs],
    [10000, 134217728, 1024, 15728640, 16777216, 86400000, 30000]);
  const full = disk();
  try {
    const store = await full.open();
    await store.commit((next) => { next.entries = Array.from({ length: 10000 }, (_, n) => receipt(next, n + 1)); });
    checkEqual('the actual production entry bound admits exactly 10k receipts', store.snapshot().entries.length, 10000);
    const before = fs.readFileSync(full.file);
    checkEqual('the next live receipt refuses capacity before any disk transition', await errorCode(() => store.commit((next) => { next.entries.push(receipt(next, 10001)); })), 'RECEIPT_FULL');
    checkEqual('capacity refusal neither evicts a live receipt nor appends a record', [store.snapshot().entries.length, fs.readFileSync(full.file).equals(before)], [10000, true]);
    await store.compact(); const scope = store.snapshot().scope; await store.close();
    const reopened = await full.open();
    checkEqual('real disk compaction/reopen retains all 10k receipts and scope', [reopened.snapshot().entries.length, reopened.snapshot().scope], [10000, scope]);
  } finally { await full.dispose(); }

  suite('T19: completion reservations prevent competing admission from stealing space');
  const reserved = disk();
  try {
    const store = await reserved.open({ limits: { maxBytes: 10000 } });
    await store.commit((next) => {
      for (let n = 1; n <= 2; n++) next.entries.push(receipt(next, n, { phase: 'prepared', outcome: 'pending', result: null, reservedResultBytes: 2500 }));
    });
    const original = store.snapshot(), before = fs.readFileSync(reserved.file);
    checkEqual('a competing result cannot consume already reserved completion bytes', await errorCode(() => store.commit((next) => {
      next.entries.push(receipt(next, 3, { result: { code: 'fixture', data: { saved: 'x'.repeat(4000) }, replies: [] } }));
    })), 'RECEIPT_FULL');
    checkEqual('reservation refusal preserves disk and all admitted entries', [fs.readFileSync(reserved.file).equals(before), store.snapshot()], [true, original]);
    checkEqual('one operation cannot enlarge its reservation after admission', await errorCode(() => store.commit((next) => { next.entries[0].reservedResultBytes++; })), 'AUTHORITY_INVALID');
    checkEqual('oversized completion fails before changing local state', await errorCode(() => store.commit((next) => {
      Object.assign(next.entries[0], { phase: 'completed', outcome: 'applied', reservedResultBytes: 0, result: { code: 'large', data: { saved: 'x'.repeat(2600) }, replies: [] } });
      next.values.effect = 'must not commit';
    })), 'AUTHORITY_INVALID');
    for (let n = 0; n < 2; n++) await store.commit((next) => {
      Object.assign(next.entries[n], { phase: 'completed', outcome: 'applied', reservedResultBytes: 0,
        result: { code: 'saved', data: { saved: String(n).repeat(2300) }, replies: [] } });
      next.values['effect' + n] = 'coupled';
    });
    checkEqual('both original operations can still commit their reserved results', store.snapshot().entries.map((entry) => entry.phase), ['completed', 'completed']);
    const completed = store.snapshot(); await store.close(); const reopened = await reserved.open({ limits: { maxBytes: 10000 } });
    checkEqual('completion reservations are replaced by full results on disk', reopened.snapshot(), completed);
  } finally { await reserved.dispose(); }

  suite('T19/T21: retention, clock rollback and unresolved payload quarantine');
  const timed = disk(); let at = stamp;
  try {
    const store = await timed.open({ now: () => at });
    await store.commit((next) => {
      next.entries.push(receipt(next, 1, { requestRef: 'outbox:1', outcome: 'unknown', result: null,
        error: { code: 'OUTCOME_UNKNOWN', message: 'Lost provider reply', retryable: false } }));
      next.outbox.push(intent(next, 1, { text: 'unknown must survive expiry', attachments: ['image-bytes'] }, { state: 'unknown' }));
      next.entries.push(receipt(next, 2, { phase: 'dispatching', outcome: 'pending', result: null, reservedResultBytes: 16384 }));
    });
    const ttl = store.snapshot().entries[0].expiresAt;
    at += 1000; await store.commit(() => {});
    checkEqual('unrelated commits and duplicates never refresh original retention', (await store.lookup({ principal: 'device:fixture', scope: store.snapshot().scope, mid: mid(1) })).expiresAt, ttl);
    checkEqual('a duplicate cannot change its immutable request hash', await errorCode(() => store.commit((next) => { next.entries[0].hash = 'f'.repeat(64); })), 'AUTHORITY_INVALID');
    checkEqual('a final result cannot be rewritten', await errorCode(() => store.commit((next) => {
      next.entries.push(receipt(next, 3)); next.entries[0].error = { code: 'OTHER', message: 'not evidence', retryable: false };
    })), 'AUTHORITY_INVALID');
    at = stamp + 86400001; await store.prune();
    checkEqual('retention also waits for issuedAt + TTL + skew', store.snapshot().entries.length, 2);
    at += 30000; await store.prune();
    checkEqual('expired receipts prune without removing unresolved full payload', [store.snapshot().entries.length, store.snapshot().outbox[0].payload], [0, { text: 'unknown must survive expiry', attachments: ['image-bytes'] }]);
    checkEqual('pruning never returns unknown work to a runnable queue', store.snapshot().outbox[0].state, 'unknown');
    checkEqual('unknown work cannot be deleted for capacity', await errorCode(() => store.commit((next) => { next.outbox = []; })), 'AUTHORITY_INVALID');
    checkEqual('unknown work cannot silently become queued', await errorCode(() => store.commit((next) => { next.outbox[0].state = 'queued'; })), 'AUTHORITY_INVALID');
    checkEqual('an expired immutable intent cannot become a fresh reservation', await errorCode(() => store.commit((next) => { next.entries.push(receipt(next, 1, { issuedAt: stamp })); })), 'EXPIRED');
    const high = store.snapshot().clockHighWater, scope = store.snapshot().scope; await store.close();
    at = stamp;
    const reopened = await timed.open({ now: () => at });
    checkEqual('clock high-water and scope survive real disk reopen', [reopened.snapshot().clockHighWater, reopened.snapshot().scope], [high, scope]);
    checkEqual('serious wall-clock rollback blocks new admission', await errorCode(() => reopened.commit((next) => { next.entries.push(receipt(next, 4)); })), 'CLOCK_SKEW');
    await reopened.commit((next) => { next.values.completionAllowed = true; });
    checkEqual('rollback never rewinds high-water or prevents non-admission recovery', [reopened.snapshot().clockHighWater, reopened.snapshot().values.completionAllowed], [high, true]);
  } finally { await timed.dispose(); }

  suite('T19: active outbox and physical reservation bounds refuse before admission');
  const outbox = disk();
  try {
    const store = await outbox.open({ limits: { maxOutbox: 1, maxLogBytes: 8000 } });
    await store.commit((next) => { next.outbox.push(intent(next, 1)); });
    checkEqual('the active-outbox bound counts unresolved payloads without receipts', await errorCode(() => store.commit((next) => { next.outbox.push(intent(next, 2)); })), 'RECEIPT_FULL');
    checkEqual('physical result space is reserved before append even with free live capacity', await errorCode(() => store.commit((next) => {
      next.entries.push(receipt(next, 3, { phase: 'prepared', outcome: 'pending', result: null, reservedResultBytes: 4096 }));
    })), 'RECEIPT_FULL');
    checkEqual('capacity refusal keeps the authority writable for completions', store.status().writable, true);
  } finally { await outbox.dispose(); }

  suite('T21: stale backup changes scope and quarantines previously runnable work');
  const restore = disk();
  try {
    const store = await restore.open();
    await store.commit((next) => {
      next.entries.push(receipt(next, 1, { requestRef: 'outbox:1' })); next.outbox.push(intent(next, 1, { text: 'may already have run after backup' }));
      next.entries.push(receipt(next, 2, { phase: 'dispatching', outcome: 'pending', result: null, reservedResultBytes: 16384, requestRef: 'outbox:2' }));
      next.outbox.push(intent(next, 2, { text: 'lost reply', sent: 'expanded bytes' }, { state: 'dispatching' }));
    });
    const backup = store.snapshot();
    await store.commit((next) => { next.outbox[0].state = 'completed'; next.values.laterEffect = true; });
    await store.restoreBackup(backup);
    const restored = store.snapshot();
    check('stale backup never retains the old authoritative scope', restored.scope !== backup.scope);
    checkEqual('backup runnable and dispatching inputs both become unknown in their original scope', restored.outbox.map((item) => [item.state, item.scope]), [['unknown', backup.scope], ['unknown', backup.scope]]);
    checkEqual('backup in-flight receipt is unknown with no reusable completion reservation', [restored.entries[1].outcome, restored.entries[1].reservedResultBytes], ['unknown', 0]);
    checkEqual('old-scope lookup refuses instead of returning missing', await errorCode(() => store.lookup({ principal: 'device:fixture', scope: backup.scope, mid: mid(1) })), 'SCOPE_CHANGED');
    checkEqual('historical receipts are not relabeled into the new scope', await store.lookup({ principal: 'device:fixture', scope: restored.scope, mid: mid(1) }), null);
    await store.compact(); await store.close(); const reopened = await restore.open();
    checkEqual('scope change and every quarantined full payload survive compaction/reopen', reopened.snapshot(), restored);
    checkEqual('even an explicit generic update cannot requeue restored uncertainty', await errorCode(() => reopened.commit((next) => { next.outbox[0].state = 'queued'; })), 'AUTHORITY_INVALID');
    await reopened.commit((next) => { next.outbox[0].state = 'completed'; }, { evidence: 'provider:exact-operation-accepted' });
    checkEqual('positive reconciliation evidence may explicitly resolve unknown work', reopened.snapshot().outbox[0].state, 'completed');
  } finally { await restore.dispose(); }

  suite('T19: actual durable payload byte boundary without truncation');
  const payloadDisk = disk();
  try {
    const store = await payloadDisk.open();
    const fullText = 'x'.repeat(LIMITS.maxPayloadBytes - Buffer.byteLength(JSON.stringify({ text: '' })));
    await store.commit((next) => { next.outbox.push(intent(next, 1, { text: fullText })); });
    checkEqual('exact 15 MiB serialized payload is admitted in full', Buffer.byteLength(JSON.stringify(store.snapshot().outbox[0].payload)), LIMITS.maxPayloadBytes);
    checkEqual('one byte over the durable prompt bound refuses before append', await errorCode(() => store.commit((next) => {
      next.outbox.push(intent(next, 2, { text: fullText + 'x' }));
    })), 'AUTHORITY_INVALID');
    const length = store.snapshot().outbox[0].payload.text.length; await store.close(); const reopened = await payloadDisk.open();
    checkEqual('real reopen preserves every accepted payload byte', [reopened.snapshot().outbox[0].payload.text.length, reopened.snapshot().outbox[0].payload.text === fullText], [length, true]);
  } finally { await payloadDisk.dispose(); }
};
