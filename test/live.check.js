#!/usr/bin/env node
'use strict';
// Opt-in end-to-end check against the real `claude` binary. Costs tokens, so it
// is not part of `npm test`. Run with: npm run test:live
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');

const results = [];
const check = (name, ok) => results.push({ name, ok: !!ok });

const s = new Session({ cwd: '/tmp', model: 'claude-haiku-4-5-20251001', permissionMode: 'bypassPermissions' });
const sentOrder = [];
const gaps = [];
let lastFinish = null;
let turns = 0;

s.on('items', (items) => {
  for (const it of items) {
    if (it.kind === 'user' && !it._seen) {
      it._seen = true;
      sentOrder.push(it.text.trim().slice(-1));
      if (lastFinish) gaps.push(Date.now() - lastFinish);
    }
    if (it.kind === 'result' && !it._done) {
      it._done = true;
      lastFinish = Date.now();
      turns++;
    }
  }
});

s.start();
setTimeout(() => s.submit('run `echo live-ok` with Bash then say exactly: A'), 600);
// Both of these land while the first turn is still running, so both must queue.
setTimeout(() => {
  check('a prompt sent while busy is queued', s.submit('say exactly: B') === 'queued');
  check('and they stack', s.submit('say exactly: C') === 'queued');
  check('the queue holds both', s.queue.length === 2);
}, 2500);

setTimeout(() => {
  const stats = s.stats();
  const tools = s.items.filter((i) => i.kind === 'tool');
  const texts = s.items.filter((i) => i.kind === 'text');
  const costs = s.items.filter((i) => i.kind === 'result').map((r) => r.costUsd);

  check('three turns ran', turns === 3);
  check('queued prompts ran in order', sentOrder.join('') === 'ABC');
  check('each queued prompt waited ~5s', gaps.length >= 2 && gaps.every((g) => g >= 4800 && g < 15000));
  check('the tool ran and its result came back', tools.some((t) => t.status === 'done' && String(t.result).includes('live-ok')));
  check('assistant text captured without duplicates', texts.length > 0 && new Set(texts.map((t) => t.text)).size === texts.length);
  check('per-turn costs sum to the session total', Math.abs(costs.reduce((a, b) => a + b, 0) - s.totalCost) < 1e-9);
  check('no single turn is charged the whole session', costs.every((c) => c <= s.totalCost + 1e-12));
  check('output tokens look real', stats.output > 10);
  check('context measured below the window', stats.contextTokens > 0 && stats.contextTokens < stats.contextWindow);
  check('slash commands arrived with init', s.meta.slashCommands.length > 0);
  check('session id captured for resume', !!s.claudeSessionId);
  check('queue drained', s.queue.length === 0);

  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log((r.ok ? '  ok    ' : '  FAIL  ') + r.name); }
  console.log('\n' + (results.length - failed) + '/' + results.length + ' live checks passed');
  console.log('cost this run: $' + s.totalCost.toFixed(4));
  s.dispose();
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}, 90000);
