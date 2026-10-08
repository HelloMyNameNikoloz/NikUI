'use strict';
const { PrFeed, normalize, QUERY, parsePrUrl, threadPrompt, checkPrompt } = require('../src/prView.js');

// A shortened, sanitized version of a real `gh api graphql` response (verified
// against PR peuka/frontend#1172, trimmed and renamed for the test).
const FIXTURE = {
  data: {
    repository: {
      pullRequest: {
        url: 'https://github.com/o/r/pull/42',
        number: 42,
        title: 'Carry the error message through logout',
        state: 'OPEN',
        isDraft: false,
        author: { login: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
        createdAt: '2026-10-04T12:00:00Z',
        headRefName: 'fix/logout-message',
        baseRefName: 'main',
        headRefOid: 'deadbeef',
        mergeable: 'MERGEABLE',
        reviewDecision: 'CHANGES_REQUESTED',
        additions: 40,
        deletions: 12,
        changedFiles: 3,
        updatedAt: '2026-10-04T13:28:08Z',
        body: 'Fixes the lost error message after logout.',
        commits: { nodes: [{ commit: { oid: 'deadbeef', statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
          { __typename: 'CheckRun', name: 'Run Tests', status: 'COMPLETED', conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/o/r/actions/runs/1/job/1', startedAt: '2026-10-05T03:39:33Z',
            completedAt: '2026-10-05T03:40:47Z', checkSuite: { workflowRun: { databaseId: 1, workflow: { name: 'Test & Deploy' } } } },
          { __typename: 'CheckRun', name: 'Build', status: 'IN_PROGRESS', conclusion: null,
            detailsUrl: 'https://github.com/o/r/actions/runs/2/job/2', startedAt: '2026-10-05T03:41:00Z',
            completedAt: null, checkSuite: { workflowRun: { databaseId: 2, workflow: { name: 'Test & Deploy' } } } },
          { __typename: 'CheckRun', name: 'auto-merge', status: 'COMPLETED', conclusion: 'SKIPPED',
            detailsUrl: 'https://github.com/o/r/actions/runs/3/job/3', startedAt: '2026-10-05T03:26:08Z',
            completedAt: '2026-10-05T03:26:08Z', checkSuite: { workflowRun: { databaseId: 3, workflow: { name: 'Dependabot Auto-merge' } } } },
          { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', targetUrl: 'https://ci.example/1', createdAt: '2026-10-05T03:00:00Z' }
        ] } } } }] },
        reviewRequests: { nodes: [{ requestedReviewer: { name: 'bots' } }] },
        latestReviews: { nodes: [
          { author: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'Please fix this.', submittedAt: '2026-10-04T13:03:23Z', url: 'https://github.com/o/r/pull/42#pullrequestreview-1' },
          { author: { login: 'carol' }, state: 'APPROVED', body: '', submittedAt: '2026-10-04T14:00:00Z', url: 'https://github.com/o/r/pull/42#pullrequestreview-2' }
        ] },
        reviewThreads: { nodes: [
          { id: 'T1', isResolved: true, isOutdated: true, path: 'pages/account-delete.jsx', line: null, originalLine: 88, diffSide: 'RIGHT',
            comments: { nodes: [
              { id: 'C1', databaseId: 1001, author: { login: 'bob', avatarUrl: 'https://avatars.example/bob.png' }, body: 'Preserve the error across logout', createdAt: '2026-10-04T13:03:23Z',
                url: 'https://github.com/o/r/pull/42#discussion_r1', diffHunk: '@@ -1,2 +1,3 @@\n a\n+b\n c', pullRequestReview: { id: 'PRR0' } }
            ] } },
          { id: 'T2', isResolved: false, isOutdated: false, path: 'pages/login.jsx', line: 10, originalLine: 10, diffSide: 'RIGHT',
            comments: { nodes: [
              { id: 'C2', databaseId: 1002, author: { login: 'carol', avatarUrl: 'https://avatars.example/carol.png' }, body: 'nit', createdAt: '2026-10-04T15:00:00Z',
                url: 'https://github.com/o/r/pull/42#discussion_r2', diffHunk: '@@ -5,3 +5,4 @@\n x\n+y\n z', pullRequestReview: null }
            ] } }
        ] },
        comments: { nodes: [
          { id: 'IC1', author: { login: 'dave' }, body: 'Looks fine overall.', createdAt: '2026-10-05T18:48:33Z', url: 'https://github.com/o/r/pull/42#issuecomment-1' }
        ] },
        files: { nodes: [
          { path: 'pages/account-delete.jsx', additions: 30, deletions: 10 },
          { path: 'pages/login.jsx', additions: 10, deletions: 2 }
        ] },
        labels: { nodes: [{ name: 'agent: review-queued', color: 'c5def5' }] },
        assignees: { nodes: [{ login: 'ada', avatarUrl: 'https://avatars.example/ada.png' }] },
        commitCount: { totalCount: 4 },
        recentCommits: { nodes: [
          { commit: { oid: 'c1c1c1c1c1c1c1c1c1c1', messageHeadline: 'first commit', committedDate: '2026-10-04T12:05:00Z',
            author: { user: { login: 'ada' }, name: 'ada', avatarUrl: 'https://avatars.example/ada.png' } } },
          { commit: { oid: 'c2c2c2c2c2c2c2c2c2c2', messageHeadline: 'second commit', committedDate: '2026-10-04T12:10:00Z',
            author: { user: null, name: 'A Git Author', avatarUrl: null } } }
        ] },
        timelineItems: { totalCount: 120, nodes: [
          { __typename: 'PullRequestCommit', commit: { oid: 'c1c1c1c1c1c1c1c1c1c1', messageHeadline: 'first commit',
            committedDate: '2026-10-04T12:05:00Z', author: { user: { login: 'ada' }, name: 'ada', avatarUrl: 'https://avatars.example/ada.png' } } },
          { __typename: 'PullRequestCommit', commit: { oid: 'c2c2c2c2c2c2c2c2c2c2', messageHeadline: 'second commit',
            committedDate: '2026-10-04T12:10:00Z', author: { user: null, name: 'A Git Author', avatarUrl: null } } },
          { __typename: 'IssueComment', id: 'IC1', author: null, body: 'Deleted account commented.',
            createdAt: '2026-10-04T12:15:00Z', lastEditedAt: null, url: 'https://github.com/o/r/pull/42#issuecomment-2' },
          { __typename: 'PullRequestCommit', commit: { oid: 'c3c3c3c3c3c3c3c3c3c3', messageHeadline: 'third commit',
            committedDate: '2026-10-04T12:20:00Z', author: { user: { login: 'ada' }, name: 'ada', avatarUrl: 'https://avatars.example/ada.png' } } },
          { __typename: 'PullRequestReview', id: 'PRR1', author: { login: 'github-actions', avatarUrl: 'https://avatars.example/bot.png' },
            state: 'COMMENTED', body: 'Automated check passed.', submittedAt: '2026-10-04T12:30:00Z',
            url: 'https://github.com/o/r/pull/42#pullrequestreview-9' },
          { __typename: 'LabeledEvent', actor: { login: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
            createdAt: '2026-10-04T12:35:00Z', label: { name: 'agent: review-queued', color: 'c5def5' } },
          { __typename: 'MergedEvent', actor: { login: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
            createdAt: '2026-10-04T12:40:00Z', mergeRefName: 'main', commit: { oid: 'c3c3c3c3c3c3c3c3c3c3' } }
        ] }
      }
    }
  }
};

/** A fake `run`, and a clock the test moves by hand. */
function fakeClock(start) {
  let t = Date.parse(start);
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** Fake setTimeout/clearTimeout: synchronous registry, fired by the test. */
function fakeTimers() {
  let id = 0;
  const pending = new Map();
  const setTimeout = (fn, ms) => { const h = ++id; pending.set(h, { fn, ms }); return h; };
  const clearTimeout = (h) => { pending.delete(h); };
  // Fires every timer due within `ms` of "now", advancing the test clock as it goes.
  return {
    setTimeout, clearTimeout,
    fire: async (clock) => {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, { fn }] of due) await fn();
    },
    count: () => pending.size,
    msFor: (h) => pending.get(h) && pending.get(h).ms
  };
}

function okCheck(stdout) { return { ok: true, stdout, stderr: '' }; }

module.exports = async function () {
  suite('parsing a pull URL');
  checkEqual('owner, repo, number', parsePrUrl('https://github.com/o/r/pull/123'), { owner: 'o', repo: 'r', number: 123 });
  checkEqual('with a trailing path', parsePrUrl('https://github.com/o/r/pull/123/files'), { owner: 'o', repo: 'r', number: 123 });
  checkEqual('with a fragment', parsePrUrl('https://github.com/o/r/pull/123#discussion_r1'), { owner: 'o', repo: 'r', number: 123 });
  checkEqual('not a pull URL', parsePrUrl('https://github.com/o/r/issues/9'), null);
  checkEqual('not a URL at all', parsePrUrl('nonsense'), null);
  check('QUERY asks for a single PR', QUERY.includes('pullRequest(number:$number)'));

  suite('normalizing a PR');
  const s = normalize(FIXTURE);
  checkEqual('the basics', [s.url, s.number, s.repo, s.title, s.state, s.isDraft, s.author],
    ['https://github.com/o/r/pull/42', 42, 'o/r', 'Carry the error message through logout', 'OPEN', false, 'ada']);
  checkEqual('refs and sha', [s.headRef, s.baseRef, s.headSha], ['fix/logout-message', 'main', 'deadbeef']);
  checkEqual('size and decision', [s.additions, s.deletions, s.changedFiles, s.mergeable, s.reviewDecision],
    [40, 12, 3, 'MERGEABLE', 'CHANGES_REQUESTED']);

  checkEqual('checks: failing first, then pending, then the rest, alphabetical within',
    s.checks.map((c) => [c.name, c.status]),
    [['Run Tests', 'fail'], ['Build', 'pending'], ['auto-merge', 'skipped'], ['ci/legacy', 'pass']]);
  checkEqual('a check keeps its workflow and run id', [s.checks[0].workflow, s.checks[0].runId], ['Test & Deploy', 1]);
  checkEqual('a commit status has no workflow nor run id', [s.checks[3].workflow, s.checks[3].runId], [null, null]);
  checkEqual('checkSummary counts pass/fail/pending only', s.checkSummary, { total: 4, pass: 1, fail: 1, pending: 1 });

  checkEqual('a requested team that has not reviewed is PENDING',
    s.reviewers.find((r) => r.login === 'bots'),
    { login: 'bots', state: 'PENDING', avatar: null, at: null, team: true, stale: false, rerequested: false });
  checkEqual('one who has reviewed shows their state, and changes asked for and since answered are stale',
    s.reviewers.find((r) => r.login === 'bob'),
    { login: 'bob', state: 'CHANGES_REQUESTED', avatar: null, at: '2026-10-04T13:03:23Z', team: false, stale: true, rerequested: false });
  checkEqual('an approval is not made stale by a comment after it', s.reviewers.find((r) => r.login === 'carol').stale, false);
  {
    const moved = JSON.parse(JSON.stringify(FIXTURE));
    const pr = moved.data.repository.pullRequest;
    pr.comments.nodes = [];
    pr.reviewThreads.nodes = pr.reviewThreads.nodes.map((t) => Object.assign(t, { comments: { nodes: t.comments.nodes.filter((c) => c.author.login === 'bob') } }));
    pr.reviewRequests.nodes.push({ requestedReviewer: { login: 'bob' } });
    const quiet = normalize(moved);
    checkEqual('changes requested with only the reviewer talking since are not stale', quiet.reviewers.find((r) => r.login === 'bob').stale, false);
    checkEqual('asked again after reviewing is a re-request', quiet.reviewers.find((r) => r.login === 'bob').rerequested, true);
    checkEqual('and they are listed once', quiet.reviewers.filter((r) => r.login === 'bob').length, 1);
    pr.recentCommits.nodes.push({ commit: { oid: 'c3', messageHeadline: 'fix', committedDate: '2026-10-04T16:00:00Z', author: { user: { login: 'ada' }, name: 'ada' } } });
    const pushed = normalize(moved);
    checkEqual('a commit after them makes both stale', ['bob', 'carol'].map((l) => pushed.reviewers.find((r) => r.login === l).stale), [true, true]);
  }
  checkEqual('only reviews with a body are kept', s.reviews.map((r) => r.author), ['bob']);

  checkEqual('unresolved threads come first', s.threads.map((t) => t.id), ['T2', 'T1']);
  checkEqual('a thread carries its latest line and diff hunk', [s.threads[1].line, s.threads[1].diffHunk.includes('+b')], [88, true]);
  checkEqual('comments and files pass through', [s.comments.length, s.files.length], [1, 2]);

  suite('normalizing: GitHub-shaped extras');
  checkEqual('createdAt and authorAvatar', [s.createdAt, s.authorAvatar], ['2026-10-04T12:00:00Z', 'https://avatars.example/ada.png']);
  checkEqual('commitCount from commits.totalCount', s.commitCount, 4);
  checkEqual('labels keep name and colour without #', s.labels, [{ name: 'agent: review-queued', color: 'c5def5' }]);
  checkEqual('assignees carry an avatar', s.assignees, [{ login: 'ada', avatar: 'https://avatars.example/ada.png' }]);
  checkEqual('commits: oldest first, short sha, git-author name when unlinked',
    s.commits.map((c) => [c.author, c.short, c.avatar]),
    [['ada', 'c1c1c1c', 'https://avatars.example/ada.png'], ['A Git Author', 'c2c2c2c', null]]);
  checkEqual('timelineTotal is the raw totalCount, independent of how many nodes came back', s.timelineTotal, 120);

  checkEqual('timeline kinds in order, consecutive commits grouped, split by the comment between them',
    s.timeline.map((t) => t.kind), ['commits', 'comment', 'commits', 'review', 'event', 'event']);
  checkEqual('two consecutive commit items become one group of two', s.timeline[0].commits.map((c) => c.short), ['c1c1c1c', 'c2c2c2c']);
  checkEqual('a commit item separated by a comment starts a new group', s.timeline[2].commits.map((c) => c.short), ['c3c3c3c']);
  checkEqual('a ghost (deleted account) author', [s.timeline[1].author, s.timeline[1].avatar], ['ghost', null]);
  checkEqual('a bot author reviewing', [s.timeline[3].author, s.timeline[3].avatar, s.timeline[3].state],
    ['github-actions', 'https://avatars.example/bot.png', 'COMMENTED']);
  checkEqual('a labeled event: type and a plain-text fragment without the actor',
    [s.timeline[4].type, s.timeline[4].text], ['labeled', 'added the agent: review-queued label']);
  checkEqual('a merged event names the commit and target branch',
    [s.timeline[5].type, s.timeline[5].text], ['merged', 'merged commit c3c3c3c into main']);

  checkEqual('a thread comment carries its review id when it belongs to one', s.threads[1].comments[0].reviewId, 'PRR0');
  checkEqual('and null for a standalone (non-review) thread comment',
    s.threads.find((t) => t.id === 'T2').comments[0].reviewId, null);

  checkEqual('avatars collects every login seen anywhere, bots and ghosts aside',
    [s.avatars.ada, s.avatars.bob, s.avatars.carol, s.avatars['github-actions'], 'ghost' in s.avatars],
    ['https://avatars.example/ada.png', 'https://avatars.example/bob.png', 'https://avatars.example/carol.png', 'https://avatars.example/bot.png', false]);

  suite('normalizing partial data');
  checkEqual('no PR at all', normalize({ data: { repository: { pullRequest: null } } }), null);
  checkEqual('missing nested fields never throw', (() => {
    const partial = normalize({ data: { repository: { pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1 } } } });
    return [partial.title, partial.checks, partial.reviewers, partial.threads, partial.files,
      partial.labels, partial.assignees, partial.commits, partial.timeline, partial.commitCount, partial.timelineTotal, partial.avatars];
  })(), [null, [], [], [], [], [], [], [], [], null, null, {}]);

  suite('prompts for the composer');
  const tp = threadPrompt(s.threads[0], s);
  check('names the PR and the place', tp.includes('PR #42') && tp.includes('pages/login.jsx:10'));
  check('fences the diff', tp.includes('```diff') && tp.includes('+y'));
  check('quotes the comment', tp.includes('carol: nit'));
  check('ends with the instruction', tp.trim().endsWith('Address this review comment.'));

  const cp = checkPrompt(s.checks[0], 'line1\nline2\nFAILED: boom', s);
  check('names the failing check and its URL', cp.includes('Run Tests') && cp.includes(s.checks[0].url));
  check('fences the log tail', cp.includes('```\n') && cp.includes('FAILED: boom'));
  check('ends with the instruction', cp.trim().endsWith('Find why this check fails and fix it.'));
  check('caps the log to the last ~80 lines', (() => {
    const long = Array.from({ length: 200 }, (_, i) => 'l' + i).join('\n');
    const p = checkPrompt({ name: 'x', url: 'u' }, long, s);
    return !p.includes('l0\n') && p.includes('l199');
  })());

  suite('PrFeed: one fetcher per URL, shared by keys');
  {
    const clock = fakeClock('2026-10-06T10:00:00Z');
    const timers = fakeTimers();
    const calls = [];
    const run = async (file, args, opts) => {
      calls.push([file, ...args, opts && opts.cwd]);
      return okCheck(JSON.stringify(FIXTURE));
    };
    const feed = new PrFeed({ run, now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const states = [];
    feed.on('state', (url, st) => states.push([url, st.loading, !!st.state, st.error]));

    feed.watch('instanceA', { url: 'https://github.com/o/r/pull/42', cwd: '/repo', active: true });
    feed.watch('instanceB', { url: 'https://github.com/o/r/pull/42', cwd: '/repo', active: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    checkEqual('one `gh` call for two watchers of the same URL', calls.filter((c) => c[2] === 'graphql').length, 1);
    checkEqual('both see loading then loaded', states.filter((s2) => s2[0] === 'https://github.com/o/r/pull/42').map((s2) => s2[1]), [true, false]);
    check('get() returns the last state', feed.get('https://github.com/o/r/pull/42').state.number === 42);
  }

  suite('PrFeed: cadence');
  {
    const clock = fakeClock('2026-10-06T10:00:00Z');
    const timers = fakeTimers();
    let stdout = JSON.stringify(FIXTURE); // has one pending check
    const run = async () => okCheck(stdout);
    const feed = new PrFeed({ run, now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const url = 'https://github.com/o/r/pull/42';
    feed.watch('k1', { url, cwd: '/repo', active: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const e = feed.entries.get(url);
    checkEqual('active with a pending check refreshes in 15s', timers.msFor(e.timer), 15000);

    // Make the fixture all-settled, then let the scheduled refresh fire.
    const settled = JSON.parse(JSON.stringify(FIXTURE));
    settled.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[1].status = 'COMPLETED';
    settled.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[1].conclusion = 'SUCCESS';
    stdout = JSON.stringify(settled);
    clock.advance(15000);
    await timers.fire();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('once everything passes, it slows to 60s', timers.msFor(e.timer), 60000);

    feed.watch('k2', { url, cwd: '/repo', active: false });
    feed.unwatch('k1');
    checkEqual('no active watcher left: the timer stops', e.timer, null);

    feed.unwatch('k2');
  }

  suite('PrFeed: inactive watchers');
  {
    const clock = fakeClock('2026-10-06T10:00:00Z');
    const timers = fakeTimers();
    let n = 0;
    const run = async () => { n++; return okCheck(JSON.stringify(FIXTURE)); };
    const feed = new PrFeed({ run, now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const url = 'https://github.com/o/r/pull/99';
    feed.watch('k1', { url, cwd: '/repo', active: false });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('no data yet: it fetches once anyway', n, 1);
    checkEqual('but sets no timer', feed.entries.get(url).timer, null);

    clock.advance(30000); // under 2 minutes
    feed.watch('k1', { url, cwd: '/repo', active: false });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('fresh data: re-registering does not fetch again', n, 1);

    clock.advance(2 * 60000 + 1);
    feed.watch('k1', { url, cwd: '/repo', active: false });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('stale data: re-registering fetches once more', n, 2);
  }

  suite('PrFeed: becoming active');
  {
    const clock = fakeClock('2026-10-06T10:00:00Z');
    const timers = fakeTimers();
    let n = 0;
    const run = async () => { n++; return okCheck(JSON.stringify(FIXTURE)); };
    const feed = new PrFeed({ run, now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const url = 'https://github.com/o/r/pull/7';
    feed.watch('k1', { url, cwd: '/repo', active: false });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('one fetch to seed the chip', n, 1);

    clock.advance(5000); // fresher than 10s
    feed.watch('k1', { url, cwd: '/repo', active: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('fresh enough: no immediate refetch, but a timer starts', [n, !!feed.entries.get(url).timer], [1, true]);

    feed.unwatch('k1');
    clock.advance(20000); // now older than 10s
    feed.watch('k2', { url, cwd: '/repo', active: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('stale: becoming active refetches right away', n, 2);
  }

  suite('PrFeed: errors');
  {
    const clock = fakeClock('2026-10-06T10:00:00Z');
    const timers = fakeTimers();
    const missing = new PrFeed({ run: async () => ({ ok: false, missing: true, stdout: '', stderr: '' }),
      now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    missing.watch('k', { url: 'https://github.com/o/r/pull/1', cwd: '/repo', active: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('gh missing', missing.get('https://github.com/o/r/pull/1').error, 'The GitHub CLI (gh) is not installed.');

    const loggedOut = new PrFeed({ run: async () => ({ ok: false, stdout: '', stderr: 'run gh auth login to authenticate' }),
      now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    loggedOut.watch('k', { url: 'https://github.com/o/r/pull/1', cwd: '/repo', active: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('gh not logged in', loggedOut.get('https://github.com/o/r/pull/1').error, 'gh is not logged in: run gh auth login.');

    const other = new PrFeed({ run: async () => ({ ok: false, stdout: '', stderr: 'some other failure\nmore detail' }),
      now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    other.watch('k', { url: 'https://github.com/o/r/pull/1', cwd: '/repo', active: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    checkEqual('else the first line of stderr', other.get('https://github.com/o/r/pull/1').error, 'some other failure');
  }

  suite('PrFeed: actions');
  {
    const clock = fakeClock('2026-10-06T10:00:00Z');
    const timers = fakeTimers();
    const calls = [];
    const run = async (file, args, opts) => {
      calls.push([file, ...args]);
      if (args[0] === 'api') return okCheck(JSON.stringify(FIXTURE));
      return okCheck('');
    };
    const feed = new PrFeed({ run, now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const url = 'https://github.com/o/r/pull/42';
    feed.watch('k', { url, cwd: '/repo', active: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    calls.length = 0;

    const r1 = await feed.reply(url, 'T2', 'thanks, fixed');
    check('reply mutates the thread and says so', r1.ok && r1.message === 'Replied.');
    check('reply builds addPullRequestReviewThreadReply with the thread id and body', calls[0].some((a) => String(a).includes('addPullRequestReviewThreadReply')) &&
      calls[0].includes('id=T2') && calls[0].includes('body=thanks, fixed'));
    check('and refreshes afterwards', calls.some((c) => c[2] === 'graphql' && c.join(' ').includes('pullRequest(number')));

    calls.length = 0;
    const r2 = await feed.resolve(url, 'T2', true);
    check('resolve calls resolveReviewThread', r2.ok && calls[0].some((a) => String(a).includes('resolveReviewThread')));
    calls.length = 0;
    const r3 = await feed.resolve(url, 'T2', false);
    check('unresolve calls unresolveReviewThread', r3.ok && calls[0].some((a) => String(a).includes('unresolveReviewThread')));

    calls.length = 0;
    const r4 = await feed.comment(url, 'LGTM');
    checkEqual('comment runs gh pr comment', calls[0], ['gh', 'pr', 'comment', url, '--body', 'LGTM']);
    check('and says so', r4.ok && r4.message === 'Commented.');

    calls.length = 0;
    const r5 = await feed.rerunFailed(url);
    checkEqual('rerunFailed dedupes run ids and reruns each once', calls.filter((c) => c[1] === 'run' && c[2] === 'rerun').map((c) => c[2 + 1]), ['1']);
    check('and reports how many', r5.ok && r5.message.includes('1'));

    const log = await feed.failedLog(url, 1);
    check('failedLog runs gh run view --log-failed', calls.some((c) => c[0] === 'gh' && c[1] === 'run' && c[2] === 'view' && c.includes('--log-failed')));
    check('and keeps the tail', log.ok);

    const diffRun = async (file, args) => (args[0] === 'pr' && args[1] === 'diff') ? { ok: true, stdout: 'diff --git a b\n+x', stderr: '' } : okCheck('');
    const feed2 = new PrFeed({ run: diffRun, now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const d = await feed2.diff(url);
    checkEqual('diff runs gh pr diff', d.diff, 'diff --git a b\n+x');
  }

  suite('PrFeed: never throws out of a timer');
  {
    const clock = fakeClock('2026-10-06T10:00:00Z');
    const timers = fakeTimers();
    const feed = new PrFeed({ run: async () => { throw new Error('boom'); },
      now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    let threw = false;
    try {
      feed.watch('k', { url: 'https://github.com/o/r/pull/1', cwd: '/repo', active: true });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    } catch (e) { threw = true; }
    check('a thrown run() lands in the error, not an exception', !threw && feed.get('https://github.com/o/r/pull/1').error === 'boom');
  }

  suite('PrFeed: who can be mentioned');
  {
    const clock = fakeClock('2026-10-06T10:00:00Z');
    const calls = [];
    let teamsFail = false;
    const run = async (file, args) => {
      calls.push(args);
      const query = args[args.indexOf('-f') + 1];
      if (query.includes('organization(')) {
        if (teamsFail) return { ok: false, stdout: '', stderr: 'INSUFFICIENT_SCOPES read:org' };
        return okCheck(JSON.stringify({ data: { organization: { teams: { nodes: [{ slug: 'web', name: 'Web' }] } } } }));
      }
      return okCheck(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { mentionableUsers: { totalCount: 2, nodes: [
        { login: 'peuka-ada', name: 'Ada L', avatarUrl: 'https://a/ada' }, { login: 'bob', name: null, avatarUrl: null }] } } } }));
    };
    const feed = new PrFeed({ run, now: clock.now });
    const url = 'https://github.com/o/r/pull/42';
    const r = await feed.mentionables(url, '');
    checkEqual('users with names and avatars', r.users, [{ login: 'peuka-ada', name: 'Ada L', avatar: 'https://a/ada' }, { login: 'bob', name: null, avatar: null }]);
    checkEqual('teams carry the org', r.teams, [{ login: 'o/web', name: 'Web', avatar: null, team: true }]);
    check('the viewer, and everyone came in one page', r.viewer === 'me' && r.complete === true && r.ok === true);
    check('no query, no q', !calls[0].some((a) => /^q=/.test(a)) && calls[0].includes('owner=o') && calls[0].includes('name=r'));
    const before = calls.length;
    await feed.mentionables(url, '');
    checkEqual('asked again within ten minutes: from the cache', calls.length, before);
    teamsFail = true;
    const q = await feed.mentionables(url, '@Peuka');
    check('a query is passed on, without its @', calls[before].includes('q=Peuka'));
    check('teams that cannot be read are just none', q.ok && q.teams.length === 0 && q.users.length === 2);
    await feed.mentionables(url, 'o/we');
    check('a team query searches the slug, not the org', calls[calls.length - 1].includes('q=we'));
    const bad = await new PrFeed({ run: async () => ({ ok: false, stdout: '', stderr: 'gh: not logged in' }), now: clock.now }).mentionables(url, '');
    check('a failure says so', bad.ok === false && !!bad.message && bad.users.length === 0);
  }
};
