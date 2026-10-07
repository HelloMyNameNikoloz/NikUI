'use strict';

const { execFile } = require('child_process');
const { EventEmitter } = require('events');

/**
 * The laptop side of a per-instance "GitHub pane": one PR's full picture —
 * description, checks, reviews, review threads, comments, files — fetched
 * with `gh api graphql` and kept fresh while somebody is looking at it.
 *
 * Nothing here knows about VS Code: running things and the clock are handed
 * in, same as ci.js and prlink.js.
 */

const PR_URL = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

const FAIL_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAIL_STATES = new Set(['FAILURE', 'ERROR']);

const ACTIVE_FAST_MS = 15000;   // some check is still running: a pane open and watching wants this soon
const ACTIVE_SLOW_MS = 60000;   // everything settled: no rush
const IDLE_FRESH_MS = 10000;    // becoming active: a fetch this fresh is fresh enough
const BACKGROUND_STALE_MS = 2 * 60000; // nobody is looking, but the header chip wants a number this old at most

const defaultRun = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, Object.assign({ timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, options), (err, stdout, stderr) => {
    resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: !!(err && err.code === 'ENOENT') });
  });
});

/** https://github.com/owner/repo/pull/123(/files)(#discussion) → {owner, repo, number} */
function parsePrUrl(url) {
  const m = PR_URL.exec(String(url || '').trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

const QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      url number title state isDraft
      author { login }
      headRefName baseRefName headRefOid
      mergeable reviewDecision
      additions deletions changedFiles updatedAt body
      commits(last:1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first:100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion detailsUrl startedAt completedAt
                    checkSuite { workflowRun { databaseId workflow { name } } }
                  }
                  ... on StatusContext {
                    context state targetUrl createdAt
                  }
                }
              }
            }
          }
        }
      }
      reviewRequests(first:20) {
        nodes { requestedReviewer { ... on User { login } ... on Team { name } } }
      }
      latestReviews(first:20) {
        nodes { author { login } state body submittedAt url }
      }
      reviewThreads(first:100) {
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          comments(first:50) {
            nodes { id databaseId author { login } body createdAt url diffHunk }
          }
        }
      }
      comments(last:50) {
        nodes { id author { login } body createdAt url }
      }
      files(first:100) {
        nodes { path additions deletions }
      }
    }
  }
}`;

/** One check, as either kind GitHub reports: a check run or a commit status. */
function readCheck(c) {
  if (!c) return null;
  if (c.__typename === 'StatusContext') {
    const state = String(c.state || '').toUpperCase();
    let status = 'pending';
    if (state === 'SUCCESS') status = 'pass';
    else if (FAIL_STATES.has(state)) status = 'fail';
    return { name: c.context || null, workflow: null, status, url: c.targetUrl || null,
      startedAt: c.createdAt || null, completedAt: null, runId: null };
  }
  const workflowRun = c.checkSuite && c.checkSuite.workflowRun;
  const status = String(c.status || '').toUpperCase();
  const conclusion = String(c.conclusion || '').toUpperCase();
  let mapped = 'pending';
  if (status === 'COMPLETED') {
    if (conclusion === 'SUCCESS') mapped = 'pass';
    else if (FAIL_CONCLUSIONS.has(conclusion)) mapped = 'fail';
    else if (conclusion === 'SKIPPED') mapped = 'skipped';
    else if (conclusion === 'NEUTRAL' || conclusion === 'STALE') mapped = 'neutral';
  }
  return { name: c.name || null, workflow: (workflowRun && workflowRun.workflow && workflowRun.workflow.name) || null,
    status: mapped, url: c.detailsUrl || null, startedAt: c.startedAt || null, completedAt: c.completedAt || null,
    runId: (workflowRun && workflowRun.databaseId) || null };
}

const RANK = { fail: 0, pending: 1, pass: 2, skipped: 2, neutral: 2 };

/** failing first, then pending, then the rest; name order within each group. */
function orderChecks(checks) {
  return checks.slice().sort((a, b) => {
    const r = (RANK[a.status] == null ? 2 : RANK[a.status]) - (RANK[b.status] == null ? 2 : RANK[b.status]);
    if (r) return r;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/** The raw `gh api graphql` response → the flat snapshot the pane renders. */
function normalize(json) {
  const pr = json && json.data && json.data.repository && json.data.repository.pullRequest;
  const now = new Date().toISOString();
  if (!pr) return null;

  let checks = [];
  try {
    const rollup = pr.commits.nodes[0].commit.statusCheckRollup;
    checks = ((rollup && rollup.contexts && rollup.contexts.nodes) || []).map(readCheck).filter(Boolean);
  } catch (_) { checks = []; }
  checks = orderChecks(checks);
  const checkSummary = {
    total: checks.length,
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    pending: checks.filter((c) => c.status === 'pending').length
  };

  const reviewed = new Map(); // login → state, latest review wins
  for (const n of (pr.latestReviews && pr.latestReviews.nodes) || []) {
    const login = n && n.author && n.author.login;
    if (login) reviewed.set(login, n.state || null);
  }
  const reviewers = [];
  for (const n of (pr.reviewRequests && pr.reviewRequests.nodes) || []) {
    const who = n && n.requestedReviewer;
    const login = who && (who.login || who.name);
    if (login && !reviewed.has(login)) reviewers.push({ login, state: 'PENDING' });
  }
  for (const [login, state] of reviewed) reviewers.push({ login, state: state || null });

  const reviews = ((pr.latestReviews && pr.latestReviews.nodes) || [])
    .filter((n) => n && n.body)
    .map((n) => ({ author: (n.author && n.author.login) || null, state: n.state || null, body: n.body,
      at: n.submittedAt || null, url: n.url || null }));

  const threads = ((pr.reviewThreads && pr.reviewThreads.nodes) || []).map((t) => ({
    id: t.id || null, resolved: !!t.isResolved, outdated: !!t.isOutdated, path: t.path || null,
    line: (t.line != null ? t.line : t.originalLine != null ? t.originalLine : null),
    diffHunk: ((t.comments && t.comments.nodes && t.comments.nodes[0] && t.comments.nodes[0].diffHunk) || null),
    comments: ((t.comments && t.comments.nodes) || []).map((c) => ({
      id: c.id || null, databaseId: c.databaseId || null, author: (c.author && c.author.login) || null,
      body: c.body || null, at: c.createdAt || null, url: c.url || null
    }))
  })).sort((a, b) => (a.resolved === b.resolved ? 0 : a.resolved ? 1 : -1));

  const comments = ((pr.comments && pr.comments.nodes) || []).map((c) => ({
    id: c.id || null, author: (c.author && c.author.login) || null, body: c.body || null,
    at: c.createdAt || null, url: c.url || null
  }));

  const files = ((pr.files && pr.files.nodes) || []).map((f) => ({
    path: f.path || null, additions: f.additions == null ? null : f.additions, deletions: f.deletions == null ? null : f.deletions
  }));

  const urlParts = parsePrUrl(pr.url);
  return {
    url: pr.url || null, number: pr.number == null ? null : pr.number,
    repo: urlParts ? `${urlParts.owner}/${urlParts.repo}` : null,
    title: pr.title || null, state: pr.state || null, isDraft: !!pr.isDraft,
    author: (pr.author && pr.author.login) || null, headRef: pr.headRefName || null, baseRef: pr.baseRefName || null,
    headSha: pr.headRefOid || null, mergeable: pr.mergeable || null, reviewDecision: pr.reviewDecision || null,
    additions: pr.additions == null ? null : pr.additions, deletions: pr.deletions == null ? null : pr.deletions,
    changedFiles: pr.changedFiles == null ? null : pr.changedFiles, updatedAt: pr.updatedAt || null, body: pr.body || null,
    checks, checkSummary, reviewers, reviews, threads, comments, files, fetchedAt: now
  };
}

/** The composer prompt for "address this review comment". */
function threadPrompt(thread, snapshot) {
  const n = snapshot && snapshot.number;
  const where = `${thread.path || '?'}:${thread.line != null ? thread.line : '?'}`;
  const hunk = String(thread.diffHunk || '').split('\n').slice(-12).join('\n');
  const lines = (thread.comments || []).map((c) => `${c.author || 'someone'}: ${c.body || ''}`).join('\n\n');
  return `A review comment on PR #${n != null ? n : '?'}, at ${where}:\n\n` +
    '```diff\n' + hunk + '\n```\n\n' + lines + '\n\nAddress this review comment.';
}

/** The composer prompt for "find why this check fails and fix it". */
function checkPrompt(check, log, snapshot) {
  const n = snapshot && snapshot.number;
  const tail = String(log || '').split('\n').slice(-80).join('\n');
  return `The check "${check.name}" is failing on PR #${n != null ? n : '?'}: ${check.url || '(no URL)'}\n\n` +
    '```\n' + tail + '\n```\n\nFind why this check fails and fix it.';
}

/** owner/name parsed from a PR URL, for the calls that take --repo. */
function repoOf(url) {
  const p = parsePrUrl(url);
  return p ? `${p.owner}/${p.repo}` : null;
}

function errorFor(result) {
  if (result.missing) return 'The GitHub CLI (gh) is not installed.';
  const stderr = (result.stderr || '').trim();
  if (/auth login|not logged/i.test(stderr)) return 'gh is not logged in: run gh auth login.';
  return stderr.split('\n')[0] || 'gh failed.';
}

/**
 * One watched PR. Several instances (watchers, keyed by their id) may watch
 * the same URL; there is one fetcher per URL, shared between them.
 */
class PrFeed extends EventEmitter {
  constructor(o) {
    super();
    o = o || {};
    this.run = o.run || defaultRun;
    this.now = o.now || Date.now;
    this.setTimer = o.setTimeout || setTimeout;
    this.clearTimer = o.clearTimeout || clearTimeout;
    this.entries = new Map(); // url → entry
    this.keyToUrl = new Map(); // watcher key → url
  }

  entry(url) {
    let e = this.entries.get(url);
    if (!e) {
      e = { watchers: new Map(), cwd: null, timer: null, fetching: null, lastFetchAt: null, last: null };
      this.entries.set(url, e);
    }
    return e;
  }

  activeCount(e) {
    let n = 0;
    for (const w of e.watchers.values()) if (w.active) n++;
    return n;
  }

  /** Registers or updates a watcher. `active` says the pane is open and visible. */
  watch(key, opts) {
    const o = opts || {};
    const url = o.url;
    const prevUrl = this.keyToUrl.get(key);
    if (prevUrl && prevUrl !== url) this.unwatch(key);
    if (!url) { this.keyToUrl.delete(key); return; }

    const e = this.entry(url);
    const wasActive = e.watchers.has(key) && e.watchers.get(key).active;
    e.watchers.set(key, { cwd: o.cwd, active: !!o.active });
    if (o.cwd) e.cwd = o.cwd;
    this.keyToUrl.set(key, url);

    const activeNow = this.activeCount(e);
    if (activeNow > 0) {
      const becameActive = !!o.active && !wasActive;
      const stale = e.lastFetchAt == null || this.now() - e.lastFetchAt >= IDLE_FRESH_MS;
      if (becameActive && stale) {
        this.refresh(url);
      } else if (!e.timer && !e.fetching) {
        this.schedule(url);
      }
    } else {
      const stale = e.lastFetchAt == null || this.now() - e.lastFetchAt >= BACKGROUND_STALE_MS;
      if (stale && !e.fetching) this.refresh(url);
    }
  }

  unwatch(key) {
    const url = this.keyToUrl.get(key);
    if (!url) return;
    this.keyToUrl.delete(key);
    const e = this.entries.get(url);
    if (!e) return;
    e.watchers.delete(key);
    if (e.watchers.size === 0 || this.activeCount(e) === 0) {
      if (e.timer) this.clearTimer(e.timer);
      e.timer = null;
    }
  }

  /** How soon the next automatic refresh of an active URL should land. */
  interval(e) {
    const pending = e.last && e.last.state && e.last.state.checkSummary ? e.last.state.checkSummary.pending : 0;
    return pending > 0 ? ACTIVE_FAST_MS : ACTIVE_SLOW_MS;
  }

  schedule(url) {
    const e = this.entries.get(url);
    if (!e) return;
    if (e.timer) this.clearTimer(e.timer);
    e.timer = this.setTimer(() => { e.timer = null; this.refresh(url); }, this.interval(e));
    if (e.timer && e.timer.unref) e.timer.unref();
  }

  afterFetch(url) {
    const e = this.entries.get(url);
    if (!e) return;
    if (this.activeCount(e) > 0) this.schedule(url);
    else if (e.timer) { this.clearTimer(e.timer); e.timer = null; }
  }

  get(url) {
    const e = this.entries.get(url);
    return e && e.last ? e.last : null;
  }

  /** Forces a fetch now; a fetch already in flight for this URL is reused. */
  refresh(url) {
    const e = this.entry(url);
    if (e.fetching) return e.fetching;
    const prevState = e.last ? e.last.state : null;
    const loading = { state: prevState, loading: true, error: null, prUrl: url };
    e.last = loading;
    this.emit('state', url, loading);

    e.fetching = (async () => {
      let result;
      try {
        const parsed = parsePrUrl(url);
        if (!parsed) {
          result = { state: null, loading: false, error: 'Not a pull request URL.', prUrl: url };
        } else {
          const cwd = e.cwd || (e.watchers.size ? e.watchers.values().next().value.cwd : undefined);
          const res = await this.run('gh', ['api', 'graphql', '-f', 'query=' + QUERY,
            '-F', 'owner=' + parsed.owner, '-F', 'name=' + parsed.repo, '-F', 'number=' + parsed.number], { cwd });
          if (!res.ok) {
            result = { state: prevState, loading: false, error: errorFor(res), prUrl: url };
          } else {
            let snapshot = null;
            try { snapshot = normalize(JSON.parse(res.stdout)); } catch (err) { snapshot = null; }
            result = { state: snapshot, loading: false, error: snapshot ? null : 'Could not read the PR.', prUrl: url };
          }
        }
      } catch (err) {
        result = { state: prevState, loading: false, error: String((err && err.message) || err), prUrl: url };
      }
      e.last = result;
      e.lastFetchAt = this.now();
      this.emit('state', url, result);
      return result;
    })();

    e.fetching = e.fetching.finally(() => { e.fetching = null; this.afterFetch(url); });
    return e.fetching;
  }

  /** `gh api graphql` for a mutation, as plain `{ok, stderr}`. */
  async mutate(url, query, fields) {
    const e = this.entries.get(url);
    const cwd = (e && e.cwd) || (e && e.watchers.size ? e.watchers.values().next().value.cwd : undefined);
    const args = ['api', 'graphql', '-f', 'query=' + query];
    for (const k of Object.keys(fields)) args.push('-f', k + '=' + fields[k]);
    return this.run('gh', args, { cwd });
  }

  async reply(url, threadId, body) {
    const res = await this.mutate(url,
      'mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}){comment{id}}}',
      { id: threadId, body });
    if (res.ok) this.refresh(url);
    return { ok: res.ok, message: res.ok ? 'Replied.' : errorFor(res) };
  }

  async resolve(url, threadId, resolved) {
    const name = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const res = await this.mutate(url, `mutation($id:ID!){${name}(input:{threadId:$id}){thread{id}}}`, { id: threadId });
    if (res.ok) this.refresh(url);
    return { ok: res.ok, message: res.ok ? (resolved ? 'Resolved.' : 'Marked unresolved.') : errorFor(res) };
  }

  async comment(url, body) {
    const e = this.entries.get(url);
    const cwd = (e && e.cwd) || (e && e.watchers.size ? e.watchers.values().next().value.cwd : undefined);
    const res = await this.run('gh', ['pr', 'comment', url, '--body', body], { cwd });
    if (res.ok) this.refresh(url);
    return { ok: res.ok, message: res.ok ? 'Commented.' : errorFor(res) };
  }

  async rerunFailed(url) {
    const e = this.entries.get(url);
    const cwd = (e && e.cwd) || (e && e.watchers.size ? e.watchers.values().next().value.cwd : undefined);
    const repo = repoOf(url);
    const snapshot = e && e.last && e.last.state;
    const runIds = [...new Set((snapshot && snapshot.checks || []).filter((c) => c.status === 'fail' && c.runId).map((c) => c.runId))];
    if (!runIds.length) return { ok: false, message: 'No failing checks to rerun.' };
    let ok = true;
    let message = `Re-ran ${runIds.length} failed check(s).`;
    for (const id of runIds) {
      const res = await this.run('gh', ['run', 'rerun', String(id), '--failed', '--repo', repo], { cwd });
      if (!res.ok) { ok = false; message = errorFor(res); break; }
    }
    if (ok) this.refresh(url);
    return { ok, message };
  }

  async failedLog(url, runId) {
    const e = this.entries.get(url);
    const cwd = (e && e.cwd) || (e && e.watchers.size ? e.watchers.values().next().value.cwd : undefined);
    const repo = repoOf(url);
    const res = await this.run('gh', ['run', 'view', String(runId), '--log-failed', '--repo', repo],
      { cwd, maxBuffer: 32 * 1024 * 1024 });
    if (!res.ok) return { ok: false, log: '', message: errorFor(res) };
    const lines = res.stdout.split('\n');
    return { ok: true, log: lines.slice(-200).join('\n') };
  }

  async diff(url) {
    const e = this.entries.get(url);
    const cwd = (e && e.cwd) || (e && e.watchers.size ? e.watchers.values().next().value.cwd : undefined);
    const res = await this.run('gh', ['pr', 'diff', url], { cwd, maxBuffer: 32 * 1024 * 1024 });
    if (!res.ok) return { ok: false, diff: '', message: errorFor(res) };
    const cap = 400 * 1024;
    let diff = res.stdout;
    let truncated = false;
    if (diff.length > cap) { diff = diff.slice(0, cap); truncated = true; }
    return { ok: true, diff, truncated };
  }

  dispose() {
    for (const e of this.entries.values()) if (e.timer) this.clearTimer(e.timer);
    this.entries.clear();
    this.keyToUrl.clear();
  }
}

module.exports = { PrFeed, normalize, QUERY, parsePrUrl, threadPrompt, checkPrompt };
