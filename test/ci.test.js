'use strict';
const { EventEmitter } = require('events');
const ci = require('../src/ci.js');
const { CiWatch, CiWatcher, pushedFrom, readCheck, runDurations, describe, remaining, GRANT } = ci;

const SHA = 'abc123';
const MIN = 60000;

/** A GitHub that says what the test says, and a clock the test moves. */
function fake(world) {
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push([file, ...args, opts && opts.cwd]);
    if (file === 'gh' && args[0] === 'pr') {
      if (world.missing) return { ok: false, missing: true, stdout: '', stderr: '' };
      if (!world.pr) return { ok: false, stdout: '', stderr: 'no pull requests found for branch "x"' };
      return { ok: true, stdout: JSON.stringify(world.pr), stderr: '' };
    }
    if (file === 'gh' && args[0] === 'run') return { ok: true, stdout: JSON.stringify(world.runs || []), stderr: '' };
    if (file === 'git') return { ok: true, stdout: (world.head || SHA) + '\n', stderr: '' };
    return { ok: false, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const pr = (checks, extra) => Object.assign({ number: 12, url: 'https://github.com/o/r/pull/12', title: 'Add it',
  state: 'OPEN', headRefOid: SHA, statusCheckRollup: checks }, extra);
const run = (status, conclusion, startedAt) => ({ __typename: 'CheckRun', name: 'test-' + status, status, conclusion, startedAt });

function watch(world, opts) {
  let t = Date.parse('2026-09-30T10:00:00Z');
  const states = [];
  const finished = [];
  const added = [];
  const { run: runner, calls } = fake(world);
  const w = new CiWatch(Object.assign({
    cwd: '/repo', run: runner, now: () => t,
    setTimeout: () => null, clearTimeout: () => {},
    history: { get: () => world.ours || [], add: (repo, ms) => added.push([repo, ms]) },
    onChange: (s) => states.push(s), onFinish: (s) => finished.push(s)
  }, opts));
  return { w, states, finished, added, calls, advance: (ms) => { t += ms; }, at: () => t };
}

module.exports = async function () {
  suite('which commands pushed');
  check('git push', pushedFrom('git push', '/r') === '/r');
  check('git push -u origin branch, after a commit', pushedFrom('git commit -m x && git push -u origin b', '/r') === '/r');
  check('gh pr create', pushedFrom('gh pr create --fill', '/r') === '/r');
  check('from a folder it went into', pushedFrom('cd ../other && git push', '/a/r') === '/a/other');
  check('git -C somewhere push', pushedFrom('git -C /x/y push', '/r') === '/x/y');
  check('not a dry run', pushedFrom('git push --dry-run', '/r') === null);
  check('not git pull, nor git status', pushedFrom('git pull && git status', '/r') === null);
  check('not a word that contains push', pushedFrom('echo pushover', '/r') === null);

  suite('reading checks');
  check('a finished check run', readCheck(run('COMPLETED', 'SUCCESS')).done && !readCheck(run('COMPLETED', 'SUCCESS')).failed);
  check('a failed one', readCheck(run('COMPLETED', 'FAILURE')).failed);
  check('a skipped one is not a failure', !readCheck(run('COMPLETED', 'SKIPPED')).failed);
  check('one in progress', !readCheck(run('IN_PROGRESS', '')).done);
  check('a pending commit status', !readCheck({ __typename: 'StatusContext', context: 'ci/x', state: 'PENDING' }).done);
  check('an erroring commit status', readCheck({ __typename: 'StatusContext', context: 'ci/x', state: 'ERROR' }).failed);

  suite('how long CI takes here');
  const runs = [];
  for (let i = 0; i < 14; i++) {
    const start = Date.parse('2026-09-01T00:00:00Z') + i * 3600000;
    // Two workflows per commit: the commit's time is first start to last end.
    runs.push({ headSha: 's' + i, status: 'completed', conclusion: 'success',
      createdAt: new Date(start).toISOString(), updatedAt: new Date(start + 2 * MIN).toISOString() });
    runs.push({ headSha: 's' + i, status: 'completed', conclusion: 'failure',
      createdAt: new Date(start + MIN).toISOString(), updatedAt: new Date(start + 4 * MIN).toISOString() });
  }
  runs.push({ headSha: 'c', status: 'completed', conclusion: 'cancelled', createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T05:00:00Z' });
  runs.push({ headSha: 'r', status: 'in_progress', conclusion: '', createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:01:00Z' });
  const d = runDurations(runs);
  checkEqual('ten, one per commit, newest first', d.length, 10);
  check('first start to last end', d.every((x) => x === 4 * MIN));
  check('cancelled and unfinished runs say nothing', runDurations(runs.slice(-2)).length === 0);
  check('the commit being watched is left out', runDurations(runs, 's13').length === 10 && runDurations(runs.slice(0, 2), 's0').length === 0);

  suite('watching a PR');
  {
    const world = { pr: pr([run('IN_PROGRESS', '', '2026-09-30T09:59:00Z'), run('COMPLETED', 'SUCCESS', '2026-09-30T09:59:00Z')]), runs };
    const t = watch(world);
    await t.w.tick();
    const s = t.states[t.states.length - 1];
    checkEqual('running, one of two done', [s.phase, s.done, s.total], ['running', 1, 2]);
    checkEqual('with the average of the last ten', s.averageMs, 4 * MIN);
    checkEqual('timed from when the checks started', s.elapsedMs, MIN);
    checkEqual('which leaves about three minutes', remaining(s), '~3m left');
    checkEqual('said as the sidebar says it', describe(s), 'PR #12 · CI 1/2');
    check('asked in the folder it pushed from', t.calls.every((c) => c[c.length - 1] === '/repo'));

    world.pr = pr([run('COMPLETED', 'SUCCESS', '2026-09-30T09:59:00Z'), run('COMPLETED', 'SUCCESS', '2026-09-30T09:59:00Z')]);
    t.advance(2 * MIN);
    await t.w.tick();
    checkEqual('green, and finished once', [t.finished.length, t.finished[0].phase], [1, 'passed']);
    checkEqual('and it remembers how long that took', t.added, [['https://github.com/o/r', 3 * MIN]]);
    check('and stops asking', t.w.stopped);
  }
  {
    const t = watch({ pr: pr([run('IN_PROGRESS', ''), run('COMPLETED', 'FAILURE')]) });
    await t.w.tick();
    const s = t.finished[0];
    checkEqual('the first failure ends it', s && s.phase, 'failed');
    checkEqual('naming what failed', describe(s), 'PR #12 failed: test-COMPLETED');
  }
  {
    const world = { pr: pr([run('COMPLETED', 'SUCCESS')], { headRefOid: 'old' }), head: SHA };
    const t = watch(world, { asked: true });
    await t.w.tick();
    checkEqual('a PR behind this commit waits for the push', t.states.pop().phase, 'push');
    world.pr = pr([]);
    await t.w.tick();
    checkEqual('then for CI to start', t.states.pop().phase, 'queued');
    t.advance(4 * MIN);
    await t.w.tick();
    checkEqual('and says so if there never is any', t.finished[0] && t.finished[0].phase, 'none');
  }
  {
    const world = { pr: null };
    const t = watch(world, { asked: true });
    await t.w.tick();
    checkEqual('/watch before the PR exists waits for one', t.states.pop().phase, 'no-pr');
    world.pr = pr([run('QUEUED', '')]);
    await t.w.tick();
    checkEqual('and picks it up when it does', t.states.pop().phase, 'running');
  }
  {
    const t = watch({ pr: null });
    await t.w.tick();
    check('a push with no PR is not watched', t.finished[0] && t.finished[0].quiet);
  }
  {
    const t = watch({ pr: pr([run('QUEUED', '')]), ours: [2 * MIN, 4 * MIN] });
    await t.w.tick();
    checkEqual('with no Actions history, its own is the average', t.states.pop().averageMs, 3 * MIN);
  }
  {
    const t = watch({ missing: true });
    await t.w.tick();
    checkEqual('without gh it says so', t.finished[0].message, 'The GitHub CLI (gh) is not installed.');
  }
  {
    const t = watch({ pr: pr([], { state: 'MERGED' }) });
    await t.w.tick();
    checkEqual('a merged PR is over', t.finished[0].phase, 'merged');
  }

  suite('one watch per instance');
  {
    const world = { pr: pr([run('COMPLETED', 'SUCCESS')]) };
    const manager = new EventEmitter();
    const session = new EventEmitter();
    Object.assign(session, { id: 's1', cwd: '/repo', inTurn: false, queue: [], ci: null, sent: [],
      setCi(s) { this.ci = s; }, submit(text, a, o) { this.sent.push([text, o && o.sent]); } });
    const told = [];
    const watcher = new CiWatcher({ run: fake(world).run, notify: (s, state) => told.push(state.phase) });
    const detach = watcher.attach(manager);

    manager.emit('pushed', session, '/repo');
    await new Promise((r) => setTimeout(r, 20));
    checkEqual('a push that was already green shows it', session.ci && session.ci.phase, 'passed');
    checkEqual('but is not news', told, []);

    manager.emit('watch', session);
    await new Promise((r) => setTimeout(r, 20));
    checkEqual('/watch on it is', told, ['passed']);

    world.pr = pr([run('COMPLETED', 'SUCCESS')], { headRefOid: 'older' });
    manager.emit('watch', session);
    await new Promise((r) => setTimeout(r, 20));
    checkEqual('/watch with commits the PR lacks asks for the push', session.sent.length, 1);
    check('and says it may', session.sent[0][1].startsWith(GRANT));

    manager.emit('removed', session);
    checkEqual('an instance that goes takes its watch with it', watcher.watches.size, 0);
    detach();
  }
};
