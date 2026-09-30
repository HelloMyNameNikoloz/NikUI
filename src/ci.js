'use strict';

const path = require('path');
const { execFile } = require('child_process');

/**
 * Watching a pull request's CI, by asking GitHub rather than asking Claude.
 *
 * `gh pr view` says which PR the branch has, which commit it is at and how
 * each check is doing; `git rev-parse HEAD` says whether that commit is the
 * one here, so a watch started before the push waits for the push rather than
 * reporting on the commit before it. How long CI takes is the average of the
 * last ten runs `gh run list` knows about, or of the last ten this watched,
 * for checks that are not GitHub's.
 *
 * Nothing here knows about VS Code: running things, the clock and where the
 * durations are kept are handed in.
 */

// A command that put commits on GitHub, or a PR there. `--dry-run` did not.
const PUSHED = /(^|[;&|(\s])(git\s+(?:-C\s+\S+\s+)?push|gh\s+pr\s+create)\b(?![^;&|]*--dry-run)/;
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const HISTORY = 10;

const POLL_MS = 15000;
const PR_WAIT_MS = 30 * 60000;     // "create the PR, then /watch" has this long to find one
const CHECKS_WAIT_MS = 3 * 60000;  // a PR with no CI says so after this
const GIVE_UP_MS = 3 * 3600000;

const GRANT = 'The user ran /watch: you have their permission to commit and push to this branch, ' +
  'and to create or update its pull request, without asking first. NikUI is watching the PR\'s CI ' +
  'and tells them when it finishes, so there is no need to wait for it or poll it yourself.';

const defaultRun = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, Object.assign({ timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, options), (err, stdout, stderr) => {
    resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: String(stdout || ''), stderr: String(stderr || ''), missing: !!(err && err.code === 'ENOENT') });
  });
});

/** Whether a Bash command pushed, and from where. */
function pushedFrom(command, cwd) {
  const text = String(command || '');
  if (!PUSHED.test(text)) return null;
  // `cd somewhere && git push` pushed somewhere else's branch.
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(text);
  if (cd) return path.resolve(cwd || '/', cd[1].replace(/^["']|["']$/g, ''));
  const dashC = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+push\b/.exec(text);
  if (dashC) return path.resolve(cwd || '/', dashC[1].replace(/^["']|["']$/g, ''));
  return cwd || null;
}

/** One check, as either kind GitHub reports: a check run or a commit status. */
function readCheck(c) {
  const name = c.name || c.context || 'check';
  if (c.__typename === 'StatusContext' || (c.state && !c.status)) {
    const state = String(c.state || '').toUpperCase();
    return { name, done: state !== 'PENDING' && state !== 'EXPECTED', failed: FAILED.has(state),
      startedAt: Date.parse(c.startedAt || c.createdAt || '') || null, url: c.targetUrl || null };
  }
  const status = String(c.status || '').toUpperCase();
  const conclusion = String(c.conclusion || '').toUpperCase();
  return { name, done: status === 'COMPLETED', failed: status === 'COMPLETED' && FAILED.has(conclusion),
    startedAt: Date.parse(c.startedAt || '') || null, url: c.detailsUrl || null };
}

/**
 * How long the last runs took, newest first: one figure per commit, from the
 * first workflow starting to the last one finishing. Cancelled ones say
 * nothing about how long CI takes.
 */
function runDurations(runs, skipSha) {
  const bySha = new Map();
  for (const r of runs || []) {
    if (r.status !== 'completed' || r.conclusion === 'cancelled' || r.conclusion === 'skipped') continue;
    if (skipSha && r.headSha === skipSha) continue;
    const start = Date.parse(r.createdAt || r.startedAt || '');
    const end = Date.parse(r.updatedAt || '');
    if (!start || !end || end < start) continue;
    const seen = bySha.get(r.headSha);
    if (!seen) bySha.set(r.headSha, { start, end });
    else { seen.start = Math.min(seen.start, start); seen.end = Math.max(seen.end, end); }
  }
  return [...bySha.values()].sort((a, b) => b.end - a.end).slice(0, HISTORY).map((d) => d.end - d.start);
}

const average = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

class CiWatch {
  /**
   * @param {object} o
   * @param {string} o.cwd
   * @param {boolean} [o.asked]      started by /watch rather than by a push
   * @param {Function} [o.run]
   * @param {object} [o.history]    { get(repo) => ms[], add(repo, ms) }
   * @param {Function} o.onChange   (state) => void
   * @param {Function} [o.onFinish] (state) => void, once
   */
  constructor(o) {
    this.cwd = o.cwd;
    this.asked = !!o.asked;
    this.run = o.run || defaultRun;
    this.now = o.now || Date.now;
    this.setTimer = o.setTimeout || setTimeout;
    this.clearTimer = o.clearTimeout || clearTimeout;
    this.history = o.history || { get: () => [], add() {} };
    this.onChange = o.onChange || (() => {});
    this.onFinish = o.onFinish || (() => {});
    this.pollMs = o.pollMs || POLL_MS;
    this.startedAt = this.now();
    this.headSeenAt = null;
    this.sawUnfinished = false;
    this.averageMs = undefined; // unknown until asked; null once asked and there is none
    this.timer = null;
    this.stopped = false;
    this.state = { phase: 'looking', startedAt: this.startedAt };
  }

  start() { this.tick(); return this; }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  later() {
    if (this.stopped) return;
    this.timer = this.setTimer(() => { this.timer = null; this.tick(); }, this.pollMs);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  set(state) {
    this.state = Object.assign({ startedAt: this.startedAt }, state);
    this.onChange(this.state);
  }

  finish(state) {
    this.stop();
    this.set(Object.assign({ finished: true, finishedAt: this.now() }, state));
    this.onFinish(this.state);
  }

  async tick() {
    if (this.stopped) return;
    try {
      await this.poll();
    } catch (err) {
      this.finish({ phase: 'error', message: String((err && err.message) || err) });
    }
    if (!this.state.finished) this.later();
  }

  async poll() {
    const now = this.now();
    if (now - this.startedAt > GIVE_UP_MS) return this.finish({ phase: 'error', pr: this.state.pr, message: 'Gave up after three hours.' });

    const view = await this.run('gh', ['pr', 'view', '--json',
      'number,url,title,state,headRefOid,statusCheckRollup'], { cwd: this.cwd });
    if (this.stopped) return;
    if (view.missing) return this.finish({ phase: 'error', message: 'The GitHub CLI (gh) is not installed.' });
    if (!view.ok) {
      const why = (view.stderr || '').trim();
      if (/auth|log ?in/i.test(why) && !/no pull requests/i.test(why)) {
        return this.finish({ phase: 'error', message: 'gh is not logged in: run gh auth login.' });
      }
      if (/not a git repository/i.test(why)) return this.finish({ phase: 'error', message: 'Not a git repository.' });
      // A push with no PR behind it is not a PR to watch. /watch is
      // different: somebody may be about to make one.
      if (!this.asked) return this.finish({ phase: 'no-pr', quiet: true });
      if (now - this.startedAt > PR_WAIT_MS) return this.finish({ phase: 'error', message: 'No pull request for this branch.' });
      return this.set({ phase: 'no-pr' });
    }

    const data = JSON.parse(view.stdout);
    const pr = { number: data.number, url: data.url, title: data.title };
    if (data.state && data.state !== 'OPEN') return this.finish({ phase: data.state === 'MERGED' ? 'merged' : 'closed', pr });

    const head = await this.run('git', ['rev-parse', 'HEAD'], { cwd: this.cwd });
    const local = head.ok ? head.stdout.trim() : null;
    if (local && data.headRefOid && local !== data.headRefOid) {
      if (now - this.startedAt > PR_WAIT_MS) return this.finish({ phase: 'error', pr, message: 'This commit was never pushed.' });
      return this.set({ phase: 'push', pr });
    }
    if (!this.headSeenAt) this.headSeenAt = now;
    if (this.averageMs === undefined) this.averageMs = await this.expected(pr, data.headRefOid);

    const checks = (data.statusCheckRollup || []).map(readCheck);
    if (!checks.length) {
      if (now - this.headSeenAt > CHECKS_WAIT_MS) return this.finish({ phase: 'none', pr });
      this.sawUnfinished = true;
      return this.set({ phase: 'queued', pr, averageMs: this.averageMs, elapsedMs: now - this.headSeenAt });
    }

    const done = checks.filter((c) => c.done).length;
    const failing = checks.filter((c) => c.failed);
    const begun = Math.min(...checks.map((c) => c.startedAt || Infinity), this.headSeenAt);
    const elapsedMs = Math.max(0, now - begun);
    const counts = { pr, done, total: checks.length, averageMs: this.averageMs, elapsedMs };
    // The first failure is the news: nobody waits for the rest of a red run.
    if (failing.length) {
      return this.finish(Object.assign(counts, { phase: 'failed', failing: failing.map((c) => c.name), url: failing[0].url }));
    }
    if (done < checks.length) {
      this.sawUnfinished = true;
      return this.set(Object.assign(counts, { phase: 'running' }));
    }
    // Only a run this watched from the start says how long a run takes.
    if (this.sawUnfinished) this.history.add(repoOf(pr.url), elapsedMs);
    return this.finish(Object.assign(counts, { phase: 'passed' }));
  }

  /** What CI usually takes here: GitHub's last ten runs, or ours. */
  async expected(pr, sha) {
    // A PR's runs, if the repo has any: what runs on main is often a deploy.
    let durations = [];
    for (const only of [['--event', 'pull_request'], []]) {
      const runs = await this.run('gh', ['run', 'list', '--limit', '60', ...only, '--json',
        'headSha,createdAt,updatedAt,status,conclusion'], { cwd: this.cwd });
      if (!runs.ok) break;
      try { durations = runDurations(JSON.parse(runs.stdout), sha); } catch (_) { durations = []; }
      if (durations.length) break;
    }
    if (!durations.length) durations = (this.history.get(repoOf(pr.url)) || []).slice(0, HISTORY);
    return average(durations);
  }
}

/** https://github.com/owner/repo/pull/12 → https://github.com/owner/repo */
function repoOf(url) {
  const m = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)/.exec(String(url || ''));
  return m ? m[1] : String(url || '');
}

/** One line for a person: the strip's label, the sidebar, a notification. */
function describe(ci) {
  if (!ci) return '';
  const pr = ci.pr ? `PR #${ci.pr.number}` : 'CI';
  switch (ci.phase) {
    case 'looking': return 'Looking for the PR…';
    case 'no-pr': return 'Waiting for a PR';
    case 'push': return `${pr} · waiting for the push`;
    case 'queued': return `${pr} · CI starting`;
    case 'running': return `${pr} · CI ${ci.done}/${ci.total}`;
    case 'passed': return `${pr} is green`;
    case 'failed': return `${pr} failed: ${(ci.failing || []).slice(0, 2).join(', ')}` +
      ((ci.failing || []).length > 2 ? ` +${ci.failing.length - 2}` : '');
    case 'none': return `${pr} has no CI checks`;
    case 'merged': return `${pr} was merged`;
    case 'closed': return `${pr} was closed`;
    default: return ci.message || 'Cannot watch CI';
  }
}

/** "~3m left", from the average, or nothing while there is no average. */
function remaining(ci, elapsedMs) {
  if (!ci || !ci.averageMs || ci.finished) return '';
  const left = ci.averageMs - (elapsedMs == null ? ci.elapsedMs || 0 : elapsedMs);
  if (left <= 30000) return left <= 0 ? 'any moment' : '<1m left';
  return '~' + Math.ceil(left / 60000) + 'm left';
}

/**
 * Every instance's watch, one at a time each: a new push restarts it.
 * `notify(session, ci)` is told when one finishes worth telling about.
 */
class CiWatcher {
  constructor(deps) {
    this.run = deps.run;
    this.history = deps.history;
    this.notify = deps.notify || (() => {});
    this.autoWatch = deps.autoWatch || (() => true);
    this.watches = new Map();
    this.clearTimers = new Map();
    this.sessions = new Map();
  }

  /** Listen to a manager: pushes Claude makes, and /watch. */
  attach(manager) {
    const pushed = (session, cwd) => { if (this.autoWatch()) this.watch(session, { cwd }); };
    const asked = (session) => this.watch(session, { asked: true });
    const gone = (session) => this.forget(session.id);
    manager.on('pushed', pushed);
    manager.on('watch', asked);
    manager.on('removed', gone);
    return () => {
      manager.off('pushed', pushed);
      manager.off('watch', asked);
      manager.off('removed', gone);
      for (const id of [...this.watches.keys()]) this.forget(id);
    };
  }

  watch(session, opts) {
    const o = opts || {};
    const running = this.watches.get(session.id);
    // /watch on a watch already going changes nothing but whether its end is news.
    if (running && !running.state.finished && o.asked && !o.cwd) { running.asked = true; return running; }
    this.forget(session.id, true);
    const w = new CiWatch({
      cwd: o.cwd || session.cwd,
      asked: o.asked,
      run: this.run,
      history: this.history,
      onChange: (state) => {
        session.setCi(state);
        // /watch on a PR this branch is ahead of: that is a push waiting for
        // permission, and it has it now.
        if (w.asked && !w.prompted && state.phase === 'push' && !session.inTurn && !(session.queue || []).length) {
          w.prompted = true;
          session.pendingNote = null;
          session.submit('/watch', [], { sent: GRANT + ' This branch has commits its PR does not have yet: push them now.' });
        }
      },
      onFinish: (state) => {
        if (state.quiet) { this.forget(session.id); return; }
        // Already over when it was first looked at: a push that changed
        // nothing is not news, unless somebody asked.
        if (w.asked || w.sawUnfinished) this.notify(session, state);
        // A finished strip stays long enough to be seen, then goes.
        const t = setTimeout(() => { if (this.watches.get(session.id) === w) this.forget(session.id); }, 30 * 60000);
        if (t.unref) t.unref();
        this.clearTimers.set(session.id, t);
      }
    });
    this.watches.set(session.id, w);
    this.sessions.set(session.id, session);
    session.setCi(w.state);
    w.start();
    return w;
  }

  forget(id, keepStrip) {
    const w = this.watches.get(id);
    if (w) w.stop();
    this.watches.delete(id);
    const t = this.clearTimers.get(id);
    if (t) clearTimeout(t);
    this.clearTimers.delete(id);
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (w && !keepStrip && session) session.setCi(null);
  }
}

module.exports = { CiWatch, CiWatcher, pushedFrom, readCheck, runDurations, repoOf, describe, remaining, average, GRANT, PUSHED };
