#!/usr/bin/env node
'use strict';

// native: pending Claude run. Builds a new signed DEV app + engine with the
// P2 synthetic providers. No production registration or live profile access.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict');
const { controlRequest } = require('../src/daemonControl');
const { readPrivateJson } = require('../src/daemonPaths');
const { atomicJson } = require('../src/engineOwner');
async function main() {
  const report = await require('./test-mac-engine').main({ menubar: true, acceptanceP2: true, macAppE2E: true, quiet: true,
    exercise: async ({ paths, first, run, controller, report: nativeReport }) => {
      const call = (action) => controlRequest(paths, { op: 'acceptance-p2', action });
      const seeded = await call('seed'); assert.equal(seeded.ok, true);
      assert.equal((await call('codex-busy')).ok, true); assert.equal((await call('codex-idle')).ok, true);
      const nonce = crypto.randomBytes(16).toString('hex');
      const statusFile = path.join(paths.root, 'mac-e2e-state.json');
      atomicJson(path.join(paths.root, 'mac-e2e-request.json'), { version: 1, nonce, scenario: 'r03-core' });
      const stages = [], statusReadErrors = [];
      async function stage(expected) {
        const deadline = Date.now() + 60000;
        let lastStatus = null, lastReadError = null;
        while (Date.now() < deadline) {
          if (fs.existsSync(statusFile)) {
            let status;
            try { status = readPrivateJson(statusFile); lastStatus = status; }
            catch (error) {
              lastReadError = error.code || error.message;
              statusReadErrors.push({ stage: expected, code: lastReadError, ...(error.errno !== undefined ? { errno: error.errno } : {}) });
            }
            if (!status) { await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
            assert.equal(status.nonce, nonce, 'Reject evidence from another native run');
            if (status.stage === 'failed') throw Object.assign(new Error(status.code), { code: status.code, diagnostics: { stage: expected, status, firstReadError: statusReadErrors[0] || null } });
            if (status.stage === expected) { stages.push(status); return status; }
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        let engine;
        try { engine = await call('state'); } catch (error) { engine = { error: error.code || error.message }; }
        throw Object.assign(new Error('Native app did not reach ' + expected), { code: 'MAC_E2E_TIMEOUT', diagnostics: { stage: expected, lastStatus, firstReadError: statusReadErrors[0] || null, lastReadError, engine } });
      }
      const sent = await stage('sent');
      assert.equal(sent.engineID, first.engine.id); assert.equal(sent.generation, first.generation);
      assert.equal(sent.matchingReceiptClearedDraft, true);
      assert.equal(sent.privateImageDrafts, true); assert.match(sent.attachmentHash, /^[a-f0-9]{64}$/);
      assert(controller('app-status').pids.includes(sent.pid));
      let state = await call('state');
      assert.equal(state.effects.claude, 1);
      assert(state.receipts.some((r) => r.mid === sent.sendMid && r.what === 'send' && r.outcome === 'applied'));
      assert.equal((await call('mac-core-stream-start')).ok, true);
      const streaming = await stage('streaming'); assert.equal(streaming.streamedInWebView, true);
      assert.equal((await call('mac-core-stream-end')).ok, true);
      assert.equal((await call('pending')).ok, true);
      // "approved" can be short-lived; "queued" retains all prior proof.
      const queued = await stage('queued');
      assert.equal(queued.duplicateRefused, true);
      assert.equal(queued.findInWebView, true);
      state = await call('state');
      assert.equal(state.effects.approvals, 1); assert.equal(state.effects.claude, 1);
      assert(state.receipts.some((r) => r.mid === queued.approvalMid && r.what === 'permission' && r.outcome === 'applied'));
      assert(state.outbox.some((q) => q.mid === queued.queueMid && q.state === 'queued' && q.target === 'session:p2-claude'));
      atomicJson(path.join(paths.root, 'mac-e2e-stop.json'), { nonce, stop: true });
      const stopped = await stage('stopped'); assert.equal(stopped.stopEndedTurn, true);
      state = await call('state');
      assert.equal(state.effects.interrupts, 1);
      assert.equal(state.effects.claude, 1, 'Removed queue must never start a second turn');
      assert(state.receipts.some((r) => r.mid === stopped.unqueueMid && r.what === 'unqueue' && r.outcome === 'applied'));
      assert(state.outbox.some((q) => q.mid === queued.queueMid && q.state === 'discarded'));
      assert(state.receipts.some((r) => r.mid === stopped.stopMid && r.what === 'interrupt' && r.outcome === 'applied'));
      atomicJson(path.join(paths.root, 'mac-e2e-queue-start.json'), { nonce });
      const surviving = await stage('queuedForStop');
      state = await call('state'); assert.equal(state.effects.claude, 2);
      assert(state.outbox.some((q) => q.mid === surviving.survivingQueueMid && q.state === 'queued'));
      atomicJson(path.join(paths.root, 'mac-e2e-queue-stop.json'), { nonce });
      const ran = await stage('queueRanAfterStop'); assert.equal(ran.queuedPromptSurvivedStopAndRan, true);
      state = await call('state');
      assert.equal(state.effects.interrupts, 2); assert.equal(state.effects.claude, 3, 'Queued prompt must run once after Stop');
      assert(state.receipts.some((r) => r.mid === ran.queuedStopMid && r.what === 'interrupt' && r.outcome === 'applied'));
      assert(state.outbox.some((q) => q.mid === surviving.survivingQueueMid && ['accepted', 'completed'].includes(q.state)));
      assert.equal((await call('finish')).ok, true);
      const done = await stage('done'); assert.equal(done.ok, true);
      assert.equal(done.finishedPromptAbsentFromQueue, true);
      state = await call('state'); assert.equal(state.effects.claude, 3);
      const evidence = path.join(run, 'mac-native-core.json');
      atomicJson(evidence, { version: 1, ok: true, stages, state, controllerStatus: nativeReport.controllerStatus,
        firstReadError: statusReadErrors[0] || null, statusReadErrors, fixture: 'P2 synthetic providers; native SwiftUI/AppKit/WebKit + SecItem + SMAppService' });
      return { ok: true, evidence, localEnrollment: true, sealedV2: true, streamingWebView: true,
        matchingReceipt: true, approval: true, duplicateRefused: true, queue: true, stop: true, queuedPromptSurvivedStopAndRan: true,
        privateImageDrafts: true, transcriptFind: true, lastStatus: first };
    } });
  const evidence = '/private/tmp/nik-mac/p3/r25-native-app-e2e.json';
  atomicJson(evidence, report);
  report.evidence = evidence;
  if (!report.ok) process.exitCode = 1;
  return report;
}
module.exports = { main };
if (require.main === module) void require('./native-command').runNative(main);
