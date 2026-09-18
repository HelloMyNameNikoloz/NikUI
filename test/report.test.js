'use strict';
const path = require('path');
const { buildReport, readGit, readItems, contextRunway } = require('../src/report.js');

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

function turn(n, extra) {
  return Object.assign({
    n,
    at: NOW - (10 - n) * 600000,
    durationMs: 4000 + n * 1000,
    costUsd: 0.01 * n,
    input: 40,
    output: 500,
    cacheRead: 20000,
    cacheCreate: n === 1 ? 1200 : 0,
    contextTokens: 30000 + n * 5000,
    tools: ['Bash', 'Read'].slice(0, (n % 2) + 1),
    model: 'claude-opus-5',
    interrupted: false,
    isError: false
  }, extra || {});
}

function fakeSession(extra) {
  return Object.assign({
    id: 'nik-a', label: '1327', ticket: '1327', customTitle: null,
    status: 'done', isBusy: false, isRunning: true,
    cwd: path.join(__dirname, '..'), claudeSessionId: 'abc-123', proc: { pid: 4242 },
    startedAt: NOW - 3600000, processStartedAt: NOW - 1800000, lastError: null,
    meta: { model: 'claude-opus-5' }, model: '', effort: 'max',
    permissionMode: 'bypassPermissions', outputStyle: 'Concise', claudePath: 'claude',
    autoTitle: true, extraArgs: [], queueDelayMs: 5000,
    totalCost: 0.55, turns: 4,
    usage: { input: 160, output: 2000, cacheRead: 80000, cacheCreate: 1200 },
    contextTokens: 55000, contextWindow: 200000, errors: 1, interrupts: 2,
    queue: [], drainAt: null,
    turnLog: [turn(1), turn(2), turn(3), turn(4)],
    items: [
      { kind: 'user', text: 'fix the crash', images: [{ name: 'shot.png' }] },
      { kind: 'thinking', text: 'x'.repeat(300) },
      { kind: 'text', text: 'y'.repeat(900) },
      { kind: 'tool', name: 'Bash', input: { command: 'npm test -- --watch' }, status: 'done' },
      { kind: 'tool', name: 'Bash', input: { command: 'git status' }, status: 'running' },
      { kind: 'tool', name: 'Read', input: { file_path: '/repo/src/session.js' }, status: 'done' },
      { kind: 'tool', name: 'Read', input: { file_path: '/repo/src/session.js' }, status: 'done' },
      { kind: 'tool', name: 'Edit', input: { file_path: '/repo/src/panel.js' }, status: 'done', isError: true },
      { kind: 'permission' },
      { kind: 'notice', text: 'restored' }
    ]
  }, extra || {});
}

module.exports = async function () {
  suite('status report');

  const session = fakeSession();
  const other = {
    id: 'nik-b', label: 'mobile', status: 'working', isBusy: true, totalCost: 0.9,
    usage: { input: 10, output: 20, cacheRead: 5000, cacheCreate: 0 }, turns: 2,
    contextTokens: 40000, contextWindow: 200000, cwd: '/Users/x/Codes/Peuka'
  };
  const r = buildReport({ session, fleet: [session, other], env: { transcriptPath: '/nope/missing.jsonl' }, now: NOW });

  // Money is reported, never recomputed.
  checkEqual('the cost is the one the CLI reported', r.totals.cost, session.totalCost);
  checkEqual('per-turn costs come from the turn log', r.turns.map((t) => t.costUsd), [0.01, 0.02, 0.03, 0.04]);
  checkEqual('tokens are kept split by type', r.totals.tokens,
    { input: 160, output: 2000, cacheRead: 80000, cacheCreate: 1200, total: 83360 });
  checkEqual('cache hit rate is cache reads over everything read',
    Number(r.totals.cacheHitRate.toFixed(4)), Number((80000 / 81360).toFixed(4)));
  checkEqual('context is reported against the window', r.totals.contextPct, 0.275);

  checkEqual('worked time is the sum of the turns', r.totals.workedMs, 5000 + 6000 + 7000 + 8000);
  checkEqual('idle time is the rest of the session', r.totals.idleMs, 3600000 - 26000);
  checkEqual('the average turn is the worked time over the turns', r.totals.avgTurnMs, 6500);
  // Both sides from the same turns: the running total is the whole session's
  // and the worked time is only the turns still in hand, so mixing them used to
  // print a rate that did not match either number beside it.
  const logged = 0.01 + 0.02 + 0.03 + 0.04;
  check('the burn rate is the logged money over the logged hours',
    Math.abs(r.totals.burnPerHour - logged / (26000 / 3600000)) < 1e-9);
  check('and the average turn cost multiplies back to it',
    Math.abs(r.totals.avgCost * r.totals.turnsLogged - logged) < 1e-9);
  checkEqual('with the count it was measured over', r.totals.turnsLogged, 4);
  check('throughput is output over worked seconds',
    Math.abs(r.totals.outputPerSecond - 2000 / 26) < 1e-9);

  suite('what the items say');

  checkEqual('tool calls are counted per tool',
    r.tools.map((t) => [t.name, t.calls, t.errors]), [['Bash', 2], ['Read', 2], ['Edit', 1, 1]].map((x) =>
      [x[0], x[1], x[2] || 0]));
  checkEqual('a failed tool is counted once', r.totals.toolErrors, 1);
  checkEqual('a tool still in flight is visible', r.totals.toolsRunning, 1);
  checkEqual('the busiest files rank first', r.files.map((f) => [f.name, f.count]),
    [['session.js', 2], ['panel.js', 1]]);
  checkEqual('shell commands are grouped by their first word',
    r.commands.map((c) => c.cmd + ':' + c.count), ['npm:1', 'git:1']);
  checkEqual('images are counted', r.totals.images, 1);
  checkEqual('thinking share is a fraction of what was written',
    Number(r.totals.thinkingShare.toFixed(2)), 0.25);
  checkEqual('interrupts and errors survive', [r.totals.interrupts, r.totals.errors], [2, 1]);

  suite('the derived headline numbers');

  checkEqual('context growth is measured over recent turns', r.runway.growthPerTurn, 5000);
  checkEqual('headroom is what is left under the compaction line',
    r.runway.turnsLeft, Math.floor((200000 * 0.9 - 55000) / 5000));
  checkEqual('a session with one turn has no trend yet',
    contextRunway([turn(1)], 30000, 200000), null);
  checkEqual('a shrinking context reports no runway',
    contextRunway([turn(1, { contextTokens: 9000 }), turn(2, { contextTokens: 5000 })], 5000, 200000).turnsLeft, null);

  checkEqual('the longest turn is found', r.records.longest.n, 4);
  checkEqual('the costliest turn is found', r.records.costliest.n, 4);
  checkEqual('peak context is found', r.records.peakContext.tokens, 50000);
  checkEqual('the hourly buckets hold every turn', r.hourly.reduce((a, b) => a + b, 0), 4);
  checkEqual('there are 24 buckets', r.hourly.length, 24);

  suite('the rest of the window');

  checkEqual('the fleet is ranked by cost', r.fleet.map((f) => f.label), ['mobile', '1327']);
  const me = r.fleet.find((f) => f.active);
  check('each instance is measured, not just listed', me &&
    typeof me.cacheHitRate === 'number' && typeof me.workedMs === 'number' &&
    typeof me.toolCalls === 'number' && Array.isArray(me.spend));
  checkEqual('its tokens are split by type',
    [me.input, me.output, me.cacheRead, me.cacheCreate], [160, 2000, 80000, 1200]);
  checkEqual('and its queue is counted', me.queue, 0);
  checkEqual('the fleet totals add up', r.fleetTotals.cost, 0.55 + 0.9);
  checkEqual('and count what is happening',
    [r.fleetTotals.instances, r.fleetTotals.working, r.fleetTotals.turns], [2, 1, 6]);
  checkEqual('this instance knows its share of the spend',
    Number(r.fleetTotals.share.toFixed(4)), Number((0.55 / 1.45).toFixed(4)));
  check('the fleet is also grouped by project', Array.isArray(r.projects) && r.projects.length >= 1);
  check('a project row sums its instances',
    r.projects.every((p) => p.instances > 0 && typeof p.cost === 'number'));
  checkEqual('the instance being reported on is marked',
    r.fleet.filter((f) => f.active).map((f) => f.label), ['1327']);
  checkEqual('a missing transcript is reported, not thrown', r.transcript.exists, false);
  checkEqual('the report says how much of the conversation it could see',
    r.window, { kept: session.items.length, dropped: 0, limit: 0 });
  checkEqual('the queue is reported', r.queue.length, 0);

  // This repo is a git checkout, so the real reader is exercised here.
  const git = readGit(__dirname);
  check('the branch is read straight out of .git', git && typeof git.branch === 'string');
  checkEqual('a folder outside any repo has no branch', readGit('/'), null);
  checkEqual('no cwd, no git', readGit(null), null);

  suite('an instance that has not run yet');

  const fresh = buildReport({
    session: fakeSession({
      turnLog: [], items: [], turns: 0, totalCost: 0, contextTokens: 0, contextWindow: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, errors: 0, interrupts: 0
    }),
    fleet: [], env: {}, now: NOW
  });
  checkEqual('everything is zero rather than NaN', [
    fresh.totals.cacheHitRate, fresh.totals.contextPct, fresh.totals.avgTurnMs,
    fresh.totals.avgCost, fresh.totals.burnPerHour, fresh.totals.outputPerSecond,
    fresh.totals.thinkingShare
  ], [0, 0, 0, 0, 0, 0, 0]);
  checkEqual('there are no records without turns', fresh.records, null);
  checkEqual('there is no runway without turns', fresh.runway, null);

  suite('reading a transcript of items');

  const read = readItems([{ kind: 'tool', name: 'Bash', input: { command: '  ' }, status: 'done' }]);
  checkEqual('a blank command is not counted', read.commands, []);
  checkEqual('a tool with no file path touches nothing', read.files, []);
};
