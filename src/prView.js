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
// Pull request or issue: GitHub numbers both out of one shared sequence per
// repo, so a ticket number means the same thing either way — used only where
// "is this a GitHub ticket link" matters and not "is this specifically a PR".
const TICKET_URL = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/;

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

/** As parsePrUrl, but a .../issues/123 link counts too. */
function parseTicketUrl(url) {
  const m = TICKET_URL.exec(String(url || '').trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

// A login+avatar, for either a User or a Bot (e.g. "github-actions"); a null
// author ("ghost", a deleted account) comes back as no fields at all.
const ACTOR_FIELDS = 'login avatarUrl(size:80)';

const QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      url number title state isDraft
      author { ${ACTOR_FIELDS} }
      createdAt
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
      commitCount: commits { totalCount }
      recentCommits: commits(last:100) {
        nodes { commit { oid messageHeadline committedDate author { user { login } name avatarUrl(size:80) } } }
      }
      reviewRequests(first:20) {
        nodes { requestedReviewer { ... on User { login avatarUrl(size:80) } ... on Team { name avatarUrl(size:80) } } }
      }
      latestReviews(first:20) {
        nodes { author { ${ACTOR_FIELDS} } state body submittedAt url }
      }
      reviewThreads(first:100) {
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          comments(first:50) {
            nodes { id databaseId author { ${ACTOR_FIELDS} } body createdAt url diffHunk pullRequestReview { id } }
          }
        }
      }
      comments(last:50) {
        nodes { id author { ${ACTOR_FIELDS} } body createdAt url }
      }
      files(first:100) {
        nodes { path additions deletions }
      }
      labels(first:50) {
        nodes { name color }
      }
      assignees(first:20) {
        nodes { login avatarUrl(size:80) }
      }
      timelineItems(last:100, itemTypes:[ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, LABELED_EVENT, UNLABELED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, RENAMED_TITLE_EVENT, HEAD_REF_DELETED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, BASE_REF_CHANGED_EVENT]) {
        totalCount
        nodes {
          __typename
          ... on IssueComment { id author { ${ACTOR_FIELDS} } body createdAt lastEditedAt url }
          ... on PullRequestReview { id author { ${ACTOR_FIELDS} } state body submittedAt url }
          ... on PullRequestCommit { commit { oid messageHeadline committedDate author { user { login } name avatarUrl(size:80) } } }
          ... on MergedEvent { actor { ${ACTOR_FIELDS} } createdAt mergeRefName commit { oid } }
          ... on ClosedEvent { actor { ${ACTOR_FIELDS} } createdAt }
          ... on ReopenedEvent { actor { ${ACTOR_FIELDS} } createdAt }
          ... on HeadRefForcePushedEvent { actor { ${ACTOR_FIELDS} } createdAt beforeCommit { oid } afterCommit { oid } ref { name } }
          ... on ReviewRequestedEvent { actor { ${ACTOR_FIELDS} } createdAt requestedReviewer { ... on User { login } ... on Team { name } } }
          ... on ReviewRequestRemovedEvent { actor { ${ACTOR_FIELDS} } createdAt requestedReviewer { ... on User { login } ... on Team { name } } }
          ... on LabeledEvent { actor { ${ACTOR_FIELDS} } createdAt label { name color } }
          ... on UnlabeledEvent { actor { ${ACTOR_FIELDS} } createdAt label { name color } }
          ... on ReadyForReviewEvent { actor { ${ACTOR_FIELDS} } createdAt }
          ... on ConvertToDraftEvent { actor { ${ACTOR_FIELDS} } createdAt }
          ... on RenamedTitleEvent { actor { ${ACTOR_FIELDS} } createdAt currentTitle previousTitle }
          ... on HeadRefDeletedEvent { actor { ${ACTOR_FIELDS} } createdAt headRefName }
          ... on AssignedEvent { actor { ${ACTOR_FIELDS} } createdAt assignee { ... on User { login } } }
          ... on UnassignedEvent { actor { ${ACTOR_FIELDS} } createdAt assignee { ... on User { login } } }
          ... on BaseRefChangedEvent { actor { ${ACTOR_FIELDS} } createdAt currentRefName previousRefName }
        }
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

/** A User/Bot/Team actor (author, actor, assignee, requestedReviewer…) → {login, avatar}. A null author is a ghost. */
function actorInfo(a) {
  if (!a) return { login: 'ghost', avatar: null };
  return { login: a.login || a.name || null, avatar: a.avatarUrl || null };
}

/** A commit's `author` (git identity, maybe linked to a GitHub user) → {login, avatar}. */
function commitAuthorInfo(a) {
  if (!a) return { login: null, avatar: null };
  const login = (a.user && a.user.login) || a.name || null;
  return { login, avatar: a.avatarUrl || null };
}

/** A `{commit:{...}}` node (from `commits` or a PullRequestCommit timeline item) → the commit shape. */
function readCommit(node) {
  const c = (node && node.commit) || node || {};
  const who = commitAuthorInfo(c.author);
  return { oid: c.oid || null, short: c.oid ? String(c.oid).slice(0, 7) : null, headline: c.messageHeadline || null,
    author: who.login, avatar: who.avatar, at: c.committedDate || null };
}

const EVENT_TEXT = {
  ReopenedEvent: () => 'reopened this pull request',
  ReadyForReviewEvent: () => 'marked this ready for review',
  ConvertToDraftEvent: () => 'marked this as a draft',
  ClosedEvent: () => 'closed this pull request',
  MergedEvent: (n) => `merged commit ${n.commit && n.commit.oid ? String(n.commit.oid).slice(0, 7) : '?'} into ${n.mergeRefName || '?'}`,
  HeadRefForcePushedEvent: (n) => `force-pushed the ${(n.ref && n.ref.name) || '?'} branch from ${n.beforeCommit && n.beforeCommit.oid ? String(n.beforeCommit.oid).slice(0, 7) : '?'} to ${n.afterCommit && n.afterCommit.oid ? String(n.afterCommit.oid).slice(0, 7) : '?'}`,
  ReviewRequestedEvent: (n) => `requested a review from ${(n.requestedReviewer && (n.requestedReviewer.login || n.requestedReviewer.name)) || '?'}`,
  ReviewRequestRemovedEvent: (n) => `removed a review request from ${(n.requestedReviewer && (n.requestedReviewer.login || n.requestedReviewer.name)) || '?'}`,
  LabeledEvent: (n) => `added the ${(n.label && n.label.name) || '?'} label`,
  UnlabeledEvent: (n) => `removed the ${(n.label && n.label.name) || '?'} label`,
  RenamedTitleEvent: (n) => `changed the title from ${n.previousTitle || '?'} to ${n.currentTitle || '?'}`,
  HeadRefDeletedEvent: (n) => `deleted the ${n.headRefName || '?'} branch`,
  AssignedEvent: (n) => `assigned ${(n.assignee && n.assignee.login) || '?'}`,
  UnassignedEvent: (n) => `unassigned ${(n.assignee && n.assignee.login) || '?'}`,
  BaseRefChangedEvent: (n) => `changed the base branch from ${n.previousRefName || '?'} to ${n.currentRefName || '?'}`
};

const EVENT_TYPE = {
  MergedEvent: 'merged', ClosedEvent: 'closed', ReopenedEvent: 'reopened', HeadRefForcePushedEvent: 'force_pushed',
  ReviewRequestedEvent: 'review_requested', ReviewRequestRemovedEvent: 'review_request_removed',
  LabeledEvent: 'labeled', UnlabeledEvent: 'unlabeled', ReadyForReviewEvent: 'ready_for_review',
  ConvertToDraftEvent: 'converted_to_draft', RenamedTitleEvent: 'renamed', HeadRefDeletedEvent: 'head_ref_deleted',
  AssignedEvent: 'assigned', UnassignedEvent: 'unassigned', BaseRefChangedEvent: 'base_ref_changed'
};

/** The timeline nodes GitHub returns → our flat `timeline` entries, grouping consecutive commits. */
function readTimeline(nodes, avatars) {
  const out = [];
  for (const n of nodes || []) {
    if (!n) continue;
    if (n.__typename === 'IssueComment') {
      const who = actorInfo(n.author);
      if (who.avatar) avatars[who.login] = who.avatar;
      out.push({ kind: 'comment', id: n.id || null, author: who.login, avatar: who.avatar, body: n.body || null,
        at: n.createdAt || null, url: n.url || null, edited: !!n.lastEditedAt });
    } else if (n.__typename === 'PullRequestReview') {
      const who = actorInfo(n.author);
      if (who.avatar) avatars[who.login] = who.avatar;
      out.push({ kind: 'review', id: n.id || null, author: who.login, avatar: who.avatar, state: n.state || null,
        body: n.body || null, at: n.submittedAt || null, url: n.url || null });
    } else if (n.__typename === 'PullRequestCommit') {
      const c = readCommit(n);
      if (c.avatar) avatars[c.author] = c.avatar;
      const last = out[out.length - 1];
      if (last && last.kind === 'commits') last.commits.push(c);
      else out.push({ kind: 'commits', at: c.at, commits: [c] });
    } else if (EVENT_TYPE[n.__typename]) {
      const who = actorInfo(n.actor);
      if (who.avatar) avatars[who.login] = who.avatar;
      const text = (EVENT_TEXT[n.__typename] || (() => ''))(n);
      out.push({ kind: 'event', type: EVENT_TYPE[n.__typename], actor: who.login, avatar: who.avatar,
        at: n.createdAt || null, text });
    }
  }
  return out;
}

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

  const avatars = {}; // login → avatar url, collected as we go

  const reviewed = new Map(); // login → {state, avatar}, latest review wins
  for (const n of (pr.latestReviews && pr.latestReviews.nodes) || []) {
    const login = n && n.author && n.author.login;
    if (login) reviewed.set(login, { state: n.state || null, avatar: (n.author && n.author.avatarUrl) || null, at: n.submittedAt || null });
  }
  // `stale` is filled in below, once the commits and comments are read.
  const reviewers = [];
  const asked = new Set(); // asked to review (again, if they already have)
  for (const n of (pr.reviewRequests && pr.reviewRequests.nodes) || []) {
    const who = n && n.requestedReviewer;
    const login = who && (who.login || who.name);
    if (!login) continue;
    asked.add(login);
    if (!reviewed.has(login)) {
      reviewers.push({ login, state: 'PENDING', avatar: who.avatarUrl || null, at: null, team: !who.login, stale: false, rerequested: false });
    }
  }
  for (const [login, r] of reviewed) {
    reviewers.push({ login, state: r.state, avatar: r.avatar, at: r.at, team: false, stale: false, rerequested: asked.has(login) });
  }
  for (const r of reviewers) if (r.avatar) avatars[r.login] = r.avatar;

  const reviews = ((pr.latestReviews && pr.latestReviews.nodes) || [])
    .filter((n) => n && n.body)
    .map((n) => ({ author: (n.author && n.author.login) || null, state: n.state || null, body: n.body,
      at: n.submittedAt || null, url: n.url || null }));

  const threads = ((pr.reviewThreads && pr.reviewThreads.nodes) || []).map((t) => ({
    id: t.id || null, resolved: !!t.isResolved, outdated: !!t.isOutdated, path: t.path || null,
    line: (t.line != null ? t.line : t.originalLine != null ? t.originalLine : null),
    diffHunk: ((t.comments && t.comments.nodes && t.comments.nodes[0] && t.comments.nodes[0].diffHunk) || null),
    comments: ((t.comments && t.comments.nodes) || []).map((c) => {
      const who = actorInfo(c.author);
      if (who.avatar) avatars[who.login] = who.avatar;
      return { id: c.id || null, databaseId: c.databaseId || null, author: who.login, avatar: who.avatar,
        body: c.body || null, at: c.createdAt || null, url: c.url || null,
        reviewId: (c.pullRequestReview && c.pullRequestReview.id) || null };
    })
  })).sort((a, b) => (a.resolved === b.resolved ? 0 : a.resolved ? 1 : -1));

  const comments = ((pr.comments && pr.comments.nodes) || []).map((c) => ({
    id: c.id || null, author: (c.author && c.author.login) || null, body: c.body || null,
    at: c.createdAt || null, url: c.url || null
  }));

  const files = ((pr.files && pr.files.nodes) || []).map((f) => ({
    path: f.path || null, additions: f.additions == null ? null : f.additions, deletions: f.deletions == null ? null : f.deletions
  }));

  const labels = ((pr.labels && pr.labels.nodes) || []).map((l) => ({ name: l.name || null, color: l.color || null }));

  const assignees = ((pr.assignees && pr.assignees.nodes) || []).map((a) => {
    if (a.avatarUrl) avatars[a.login] = a.avatarUrl;
    return { login: a.login || null, avatar: a.avatarUrl || null };
  });

  const commits = (((pr.recentCommits && pr.recentCommits.nodes) || [])).map(readCommit);
  for (const c of commits) if (c.avatar) avatars[c.author] = c.avatar;

  // A review is stale once the pull request has moved on without its reviewer:
  // a commit after it, or somebody else commenting after it (the author
  // answering the requested changes, typically). Their own later comments
  // are still their review talking, so those do not count. An approval goes
  // stale only with new code, as GitHub's own dismissal does: a comment after
  // it does not take back what was approved.
  const moves = commits.map((c) => ({ who: null, at: Date.parse(c.at) }))
    .concat(comments.map((c) => ({ who: c.author, at: Date.parse(c.at) })))
    .concat(...threads.map((t) => t.comments.map((c) => ({ who: c.author, at: Date.parse(c.at) }))))
    .filter((m) => Number.isFinite(m.at));
  for (const r of reviewers) {
    const at = Date.parse(r.at);
    if (r.state === 'PENDING' || !Number.isFinite(at)) continue;
    r.stale = moves.some((m) => m.at > at && (r.state === 'APPROVED' ? m.who === null : m.who !== r.login));
  }

  const timeline = readTimeline(pr.timelineItems && pr.timelineItems.nodes, avatars);

  const authorLogin = (pr.author && pr.author.login) || null;
  const authorAvatar = (pr.author && pr.author.avatarUrl) || null;
  if (authorLogin && authorAvatar) avatars[authorLogin] = authorAvatar;

  const urlParts = parsePrUrl(pr.url);
  return {
    url: pr.url || null, number: pr.number == null ? null : pr.number,
    repo: urlParts ? `${urlParts.owner}/${urlParts.repo}` : null,
    title: pr.title || null, state: pr.state || null, isDraft: !!pr.isDraft,
    author: authorLogin, authorAvatar, createdAt: pr.createdAt || null,
    headRef: pr.headRefName || null, baseRef: pr.baseRefName || null,
    headSha: pr.headRefOid || null, mergeable: pr.mergeable || null, reviewDecision: pr.reviewDecision || null,
    additions: pr.additions == null ? null : pr.additions, deletions: pr.deletions == null ? null : pr.deletions,
    changedFiles: pr.changedFiles == null ? null : pr.changedFiles, updatedAt: pr.updatedAt || null, body: pr.body || null,
    commitCount: (pr.commitCount && pr.commitCount.totalCount) == null ? null : pr.commitCount.totalCount,
    labels, assignees, checks, checkSummary, reviewers, reviews, threads, comments, files, commits, avatars,
    timeline, timelineTotal: (pr.timelineItems && pr.timelineItems.totalCount) == null ? null : pr.timelineItems.totalCount,
    fetchedAt: now
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
// Who can be mentioned changes when somebody joins the repository, which is
// rare enough that ten minutes stale is never noticed.
const MENTION_TTL_MS = 10 * 60 * 1000;

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

  /**
   * Who can be @mentioned on this pull request's repository — the list GitHub
   * itself suggests from — plus the organisation's teams when there is one
   * and the token may read them, and who "you" are so you are not suggested
   * to yourself. Read-only, and cached per repository: the list barely moves,
   * and it is asked for every time somebody types an @.
   *
   * With a `query` the search runs on GitHub's side, for repositories with
   * more people than one page holds; without one it is the first page, and
   * `complete` says whether that page was everybody.
   */
  async mentionables(url, query) {
    const parts = parsePrUrl(url);
    if (!parts) return { ok: false, users: [], teams: [], viewer: null, complete: true, message: 'Not a pull request.' };
    const q = String(query || '').replace(/^@/, '').trim().slice(0, 60);
    const key = parts.owner + '/' + parts.repo + '\n' + q.toLowerCase();
    if (!this.mentionCache) this.mentionCache = new Map();
    const hit = this.mentionCache.get(key);
    if (hit && this.now() - hit.at < MENTION_TTL_MS) return hit.value;

    const e = this.entries.get(url);
    const cwd = (e && e.cwd) || (e && e.watchers.size ? e.watchers.values().next().value.cwd : undefined);
    const PAGE = 100;
    const users = await this.run('gh', ['api', 'graphql',
      '-f', 'query=query($owner:String!,$name:String!,$q:String){viewer{login} repository(owner:$owner,name:$name){' +
        'mentionableUsers(first:' + PAGE + ',query:$q){totalCount nodes{login name avatarUrl(size:64)}}}}',
      '-f', 'owner=' + parts.owner, '-f', 'name=' + parts.repo].concat(q ? ['-f', 'q=' + q] : []), { cwd });
    if (!users.ok) return { ok: false, users: [], teams: [], viewer: null, complete: true, message: errorFor(users) };
    let data = null;
    try { data = JSON.parse(users.stdout).data; } catch (_) { data = null; }
    const found = data && data.repository && data.repository.mentionableUsers;
    const list = ((found && found.nodes) || []).filter((n) => n && n.login)
      .map((n) => ({ login: n.login, name: n.name || null, avatar: n.avatarUrl || null }));

    // "@org/fro" is looking for a team called fro…, so the org is not part of the search.
    const teamQ = q.includes('/') ? q.slice(q.indexOf('/') + 1) : q;
    // Teams only exist on an organisation, and reading them needs read:org —
    // a token without it, or a personal repository, simply has none to offer.
    const teamsRes = await this.run('gh', ['api', 'graphql',
      '-f', 'query=query($owner:String!,$q:String){organization(login:$owner){teams(first:50,query:$q){nodes{slug name}}}}',
      '-f', 'owner=' + parts.owner].concat(teamQ ? ['-f', 'q=' + teamQ] : []), { cwd });
    let teams = [];
    if (teamsRes.ok) {
      try {
        const org = JSON.parse(teamsRes.stdout).data.organization;
        teams = ((org && org.teams && org.teams.nodes) || []).filter((t) => t && t.slug)
          .map((t) => ({ login: parts.owner + '/' + t.slug, name: t.name || null, avatar: null, team: true }));
      } catch (_) { teams = []; }
    }

    const value = {
      ok: true, users: list, teams,
      viewer: (data && data.viewer && data.viewer.login) || null,
      complete: !found || (found.totalCount || 0) <= list.length
    };
    this.mentionCache.set(key, { at: this.now(), value });
    if (this.mentionCache.size > 200) this.mentionCache.delete(this.mentionCache.keys().next().value);
    return value;
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

module.exports = { PrFeed, normalize, QUERY, parsePrUrl, parseTicketUrl, threadPrompt, checkPrompt };
