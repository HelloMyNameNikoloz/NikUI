#!/usr/bin/env node
'use strict';

// Drives the GitHub pane inside the real panel page: the HTML the panel host
// serves (src/page.js, with media/prpane.js now in its SCRIPTS), a real
// browser, and the messages the hub would post. The offline suite has
// nothing like a DOM to check the drawer's layout against; only this can
// say whether the chip toggles it, the tabs switch, and a hostile PR body
// stays text.
//
//   node test/prpane.check.js
//
// Needs a Chrome binary. Skips (exit 0) when there is none, so it never turns
// a clean checkout red — set CHROME=/path/to/chrome.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { findChrome, launch } = require('./helpers/chrome.js');
const { skipped } = require('./helpers/skip.js');

const ROOT = path.join(__dirname, '..');

const chrome = findChrome();
if (!chrome) {
  skipped('No Chrome found — the PR pane check did not run. Set CHROME=/path/to/chrome.');
}

const { install, fakeContext } = require('./helpers/vscode-stub.js');
install();
const { SessionPanel } = require('../src/panel.js');
const { Session } = require('../src/session.js');

// ---- a page built exactly the way the host builds it -----------------------

const context = fakeContext({ extensionUri: { fsPath: ROOT } });
const session = new Session({ cwd: ROOT });
const panel = SessionPanel.show(session, context, {
  list: [session], get: () => session, focus() {}, knownCommands: () => []
});

let html = panel.panel.webview.html
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace(/(src|href)="([^"]+)"/g, (m, attr, p) =>
    `${attr}="file://${path.join(ROOT, 'media', path.basename(p))}"`);

const harness = `
<style>
  /* VS Code injects these into the real webview; the harness fakes its
     default dark theme so the screenshots look like the product, not a
     browser's default light page. */
  :root {
    color-scheme: dark;
    --vscode-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-editor-background: #1e1e1e;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #cccccc;
  }
  html, body { background: #1e1e1e; }
</style>
<script>
  window.__errors = [];
  window.onerror = (m) => window.__errors.push(String(m));
  window.__state = [];
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage(m) { window.__posted.push(m); },
    setState(s) { window.__state.push(s); },
    getState() { return window.__state[window.__state.length - 1] || null; }
  });
</script>`;

html = html.replace('<script', harness + '\n<script');
const page = path.join(os.tmpdir(), 'nikui-prpane-check.html');
fs.writeFileSync(page, html);

const NOW = Date.now();
const iso = (deltaMs) => new Date(NOW + deltaMs).toISOString();

const META_LINKED = {
  label: 'nikui', cwd: ROOT, home: os.homedir(), prUrl: 'https://github.com/acme/nikui/pull/691',
  prPane: { open: false, tab: 'overview', width: null, full: false } // old tab name: must map to 'conversation'
};

const ANA_AVATAR = 'https://avatars.githubusercontent.com/u/2?v=4';
const NIK_AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4';

const PR_STATE = {
  url: 'https://github.com/acme/nikui/pull/691', number: 691, repo: 'acme/nikui',
  title: 'Add the PR pane', state: 'OPEN', isDraft: false, author: 'nik', authorAvatar: NIK_AVATAR,
  createdAt: iso(-900000),
  headRef: 'pr-pane', baseRef: 'main', headSha: 'abc123', mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
  additions: 120, deletions: 14, changedFiles: 3, updatedAt: iso(-60000),
  commitCount: 2,
  body: 'Adds the drawer.\n\n<img src=x onerror="window.__xss=1">\n<script>window.__xss=2</script>\n\n' +
    '| Property | Value |\n| --- | --- |\n| dimensions | 1200 x 800 x 600 mm |\n',
  labels: [{ name: 'enhancement', color: 'a2eeef' }, { name: 'bug', color: 'd73a4a' }],
  assignees: [{ login: 'nik', avatar: NIK_AVATAR }],
  reviewers: [{ login: 'ana', state: 'APPROVED', avatar: ANA_AVATAR }, { login: 'ghost', state: 'PENDING', avatar: null, team: true },
    { login: 'bob', state: 'CHANGES_REQUESTED', avatar: null, at: iso(-300000), stale: true, rerequested: true }],
  avatars: { nik: NIK_AVATAR, ana: ANA_AVATAR },
  checks: [
    { name: 'build', workflow: 'CI', status: 'fail', url: 'https://github.com/acme/nikui/actions/runs/1', startedAt: NOW - 60000, completedAt: NOW - 30000, runId: 'run-1' },
    { name: 'lint', workflow: 'CI', status: 'pass', url: 'https://github.com/acme/nikui/actions/runs/2', startedAt: NOW - 60000, completedAt: NOW - 50000, runId: 'run-2' }
  ],
  checkSummary: { total: 2, pass: 1, fail: 1, pending: 0 },
  commits: [
    { oid: 'abc123def456', short: 'abc123d', headline: 'Add the drawer', author: 'nik', avatar: NIK_AVATAR, at: iso(-150000) },
    { oid: 'def456abc789', short: 'def456a', headline: '<script>bad</script> commit', author: 'ghost', avatar: null, at: iso(-140000) }
  ],
  threads: [
    { id: 'th-1', resolved: false, outdated: false, path: 'media/prpane.js', line: 12, diffHunk: '@@ -1,2 +1,3 @@\n+new line',
      comments: [{ id: 'c1', databaseId: 1, author: 'ana', avatar: ANA_AVATAR, body: 'Why `esc` here <script>bad</script>?', at: iso(-90000), url: 'https://github.com/acme/nikui/pull/691#c1', reviewId: 'rev-1' }] },
    { id: 'th-2', resolved: true, outdated: false, path: 'media/prpane.css', line: 4, diffHunk: '@@ -1 +1 @@\n+ok',
      comments: [{ id: 'c2', databaseId: 2, author: 'nik', avatar: NIK_AVATAR, body: 'fixed', at: iso(-80000), url: 'https://github.com/acme/nikui/pull/691#c2' }] }
  ],
  // oldest first; one of every kind, plus a ghost/null avatar on the commit.
  timeline: [
    { kind: 'comment', id: 'tc1', author: 'nik', avatar: NIK_AVATAR, body: 'Opening this up for review.', at: iso(-200000), url: 'https://github.com/acme/nikui/pull/691#issuecomment-1' },
    { kind: 'commits', at: iso(-150000), commits: [{ oid: 'abc123def456', short: 'abc123d', headline: 'Add the drawer', author: 'ghost', avatar: null, at: iso(-150000) }] },
    { kind: 'event', type: 'labeled', actor: 'nik', avatar: NIK_AVATAR, at: iso(-120000), text: 'added the <script>bad</script> label' },
    { kind: 'review', id: 'rev-1', author: 'ana', avatar: ANA_AVATAR, state: 'APPROVED', body: 'Looks **good**', at: iso(-100000), url: 'https://github.com/acme/nikui/pull/691#review-1' }
  ],
  timelineTotal: 7, // 3 more than shown above, so the "earlier items" banner shows
  comments: [{ id: 'cc1', author: 'nik', body: 'Opening this up for review.', at: iso(-200000), url: 'https://github.com/acme/nikui/pull/691#issuecomment-1' }],
  files: [{ path: 'media/prpane.js', additions: 100, deletions: 2 }, { path: 'media/prpane.css', additions: 20, deletions: 12 }],
  fetchedAt: iso(0) // ISO, not a number — the bug this check guards against
};

// A long conversation, for the scroll-to-bottom button.
const LONG_TIMELINE = [];
for (let i = 0; i < 60; i++) {
  LONG_TIMELINE.push({ kind: 'comment', id: 'lc' + i, author: 'nik', avatar: NIK_AVATAR, body: 'Comment number ' + i + '.', at: iso(-500000 + i * 1000) });
}
const PR_STATE_LONG = Object.assign({}, PR_STATE, { timeline: LONG_TIMELINE, timelineTotal: LONG_TIMELINE.length });

const DIFF_TEXT = 'diff --git a/media/prpane.js b/media/prpane.js\n' +
  'index 111..222 100644\n--- a/media/prpane.js\n+++ b/media/prpane.js\n' +
  '@@ -1,2 +1,3 @@\n context\n-old line\n+new line\n+another new line\n';

(async () => {
  const out = {};
  const browser = await launch(chrome);
  try {
    await browser.asScreen(1280, 860);
    await browser.navigate('file://' + page);
    await browser.until('window.__posted.length > 0', 4000);

    const post = async (message) => browser.evaluate(
      `(function(){ window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} })); return true; })()`
    );
    const posted = async () => browser.evaluate('window.__posted');
    const click = async (selector) => browser.evaluate(
      `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`
    );
    const text = async (selector) => browser.evaluate(
      `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); return e ? e.textContent : null; })()`
    );
    const attr = async (selector, name) => browser.evaluate(
      `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); return e ? e.getAttribute(${JSON.stringify(name)}) : null; })()`
    );
    const exists = async (selector) => browser.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    const hidden = async (selector) => browser.evaluate(
      `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); return !e || e.hidden; })()`
    );
    const clearPosted = async () => browser.evaluate('window.__posted.length = 0; true');
    const bodyText = async () => browser.evaluate('document.getElementById("pr-pane").textContent');

    // ---- init: a PR linked, the pane closed -----------------------------
    await post({
      type: 'init', sessionId: 's1', items: [], meta: META_LINKED, status: 'idle',
      stats: {}, queue: [], slashCommands: [], commandArgs: {}, showThinking: true,
      dropped: 0, maxItems: 400
    });
    out.chipShownBeforeData = !(await hidden('#pr-chip'));
    out.chipNumberBeforeData = await text('.pr-chip-num');
    out.paneClosedInitially = await hidden('#pr-pane');

    // ---- while the pull request is loading, the pane shows a skeleton the
    // shape of the real header and body, not a single dim line -------------
    await post({ type: 'pr:state', prUrl: PR_STATE.url, loading: true, error: null, state: null });
    await post({ type: 'meta', meta: Object.assign({}, META_LINKED, { prPane: { open: true, tab: 'conversation', width: null, full: false } }) });
    out.loadingSkeletonShown = await exists('.pr-pane-head .pr-skel-head') && await exists('.pr-pane-body .pr-skel-body');
    out.loadingAriaBusy = (await attr('.pr-pane-head', 'aria-busy')) === 'true' && (await attr('.pr-pane-body', 'aria-busy')) === 'true';
    await post({ type: 'meta', meta: Object.assign({}, META_LINKED, { prPane: { open: false, tab: 'conversation', width: null, full: false } }) });

    // ---- the chip, once pr:state answers --------------------------------
    await post({ type: 'pr:state', prUrl: PR_STATE.url, loading: false, error: null, state: PR_STATE });
    out.chipNumber = await text('.pr-chip-num');
    out.chipFailDot = await exists('.pr-chip-dot.fail');
    out.chipBubble = await text('.pr-chip-bubble');

    // ---- clicking the chip opens the drawer, defaulting to Conversation ---
    // (meta remembered the old tab name 'overview' — it must map forward.)
    await clearPosted();
    await click('#pr-chip');
    out.paneOpened = !(await hidden('#pr-pane'));
    const openMsg = (await posted()).find((m) => m.type === 'pr:pane');
    out.paneOpenPosted = openMsg && openMsg.open === true && openMsg.tab === 'conversation';
    out.conversationTabOn = /^Conversation/.test(await text('.pr-tab.on') || '');

    // ---- no "NaNd ago" anywhere, ever (fetchedAt/updatedAt/createdAt/at are
    // ISO strings on the wire) ------------------------------------------
    out.noNaN = !/NaN/.test(await bodyText());

    // ---- avatars are round at every size, without style="" in the markup:
    // the editor's CSP drops those, and this harness does not apply it -------
    out.avatarsSquare = await browser.evaluate(`(function(){
      var all = [].slice.call(document.querySelectorAll('#pr-pane .avatar'));
      return all.length > 0 && all.every(function (a) {
        var r = a.getBoundingClientRect(), m = /\\bs(\\d+)\\b/.exec(a.className);
        if (!r.width && !r.height) return true;  // in a collapsed section
        return m && Math.round(r.width) === +m[1] && Math.round(r.height) === +m[1];
      });
    })()`);
    out.noInlineStyleMarkup = await browser.evaluate(
      `!/\\sstyle="/.test(document.getElementById('pr-pane').innerHTML.replace(/\\sstyle="(--hue:[^"]*|background:[^"]*|height:[^"]*|opacity:[^"]*)"/g, ''))`);

    // ---- the pane head ----------------------------------------------------
    out.titleShown = /Add the PR pane/.test(await text('.pr-title') || '');
    out.stateWordShown = /Open/.test(await text('.pr-state-pill') || '');
    out.mergeLineShown = /nik.*wants to merge.*main.*pr-pane/.test((await text('.pr-merge-line') || '').replace(/\s+/g, ' '));
    out.changeBarShown = await exists('.pr-changebar i.add');

    // ---- a hostile PR body renders as text, never runs ---------------------
    out.xssDidNotRun = await browser.evaluate('window.__xss === undefined');
    out.noScriptTag = !(await exists('.pr-tl-card-body script'));
    out.markdownStillWorks = await exists('.pr-tl-card-body strong, .pr-tl-card-body code, .pr-tl-card-body img');

    // ---- a markdown table's first column isn't broken mid-word ------------
    const dimCellHeight = await browser.evaluate(`(function(){
      var cells = Array.from(document.querySelectorAll('.pr-tl-card-body td'));
      var cell = cells.find((c) => /dimensions/.test(c.textContent));
      return cell ? cell.getBoundingClientRect().height : null;
    })()`);
    out.tableCellNotShattered = dimCellHeight != null && dimCellHeight < 36;

    // ---- Conversation: description first, then the timeline in order ------
    out.rowOrder = await browser.evaluate(`(function(){
      var rows = Array.from(document.querySelectorAll('.pr-timeline > .pr-tl-row'));
      return rows.map((r) => r.className.replace('pr-tl-row ', ''));
    })()`);
    out.descriptionFirst = out.rowOrder && /pr-tl-description/.test(out.rowOrder[0] || '');
    out.orderIsCommentCommitsEventReview =
      out.rowOrder && out.rowOrder.length === 5 &&
      /comment/.test(out.rowOrder[1]) && /commits/.test(out.rowOrder[2]) &&
      /event/.test(out.rowOrder[3]) && /review/.test(out.rowOrder[4]);

    // ---- the review card contains its inline thread ------------------------
    out.reviewHasThread = await browser.evaluate(`(function(){
      var review = document.querySelector('.pr-tl-review .pr-review-card');
      return !!review && !!review.querySelector('.pr-thread[data-l], .pr-thread') &&
        /media\\/prpane\\.js/.test(review.textContent);
    })()`);

    // ---- earlier items not shown, with a link to GitHub --------------------
    out.earlierBannerShown = /earlier items/.test(await text('.pr-tl-earlier') || '');
    await clearPosted();
    await click('.pr-tl-earlier a');
    out.earlierOpensGithub = (await posted()).some((m) => m.type === 'pr:open' && m.url === PR_STATE.url);

    // ---- avatars: a real <img> for a known login, a fallback for null -----
    out.knownAvatarImg = await browser.evaluate(`(function(){
      var row = document.querySelector('.pr-tl-review .pr-tl-gutter .avatar img');
      return row ? row.getAttribute('src') : null;
    })()`) === ANA_AVATAR;
    out.nullAvatarFallsBack = await browser.evaluate(`(function(){
      var row = document.querySelector('.pr-tl-commits .pr-commit-list .avatar');
      return !!row && !row.querySelector('img') && row.getAttribute('data-initial') === 'G';
    })()`);

    // ---- events render as text, never HTML ---------------------------------
    out.eventTextIsEscaped = /<script>bad<\/script> label/.test(await text('.pr-tl-event-line') || '');

    // ---- every reviewer in the header, what blocks the merge first --------
    out.headReviews = await browser.evaluate(`[...document.querySelectorAll('.pr-pane-head .pr-head-reviews .pr-rv')].map((li) =>
      li.querySelector('.pr-rv-login').textContent + ':' + li.querySelector('.pr-rv-state').textContent +
      (li.querySelector('.pr-rv-stale') ? ':stale' : '') + (li.querySelector('.pr-rv-again') ? ':again' : '')).join('|')`);

    // ---- narrow: a compact reviewers/labels row, no sidebar ----------------
    out.compactRowShownNarrow = !(await hidden('.pr-compact-row'));
    out.sidebarHiddenNarrow = !(await exists('.pr-sidebar')) || await browser.evaluate(
      "getComputedStyle(document.querySelector('.pr-sidebar')).display === 'none'"
    );

    // ---- tabs switch and post the quadruple ------------------------------
    await clearPosted();
    await click('[data-tab="threads"]');
    out.threadsTabOn = /^Threads/.test(await text('.pr-tab.on') || '');
    const threadsMsg = (await posted()).find((m) => m.type === 'pr:pane');
    out.threadsTabPosted = threadsMsg && threadsMsg.tab === 'threads' && threadsMsg.open === true && typeof threadsMsg.full === 'boolean';
    out.unresolvedFirst = await browser.evaluate(
      "!document.querySelector('.pr-pane-body > .pr-thread').classList.contains('resolved')"
    );
    out.resolvedCollapsed = await exists('.pr-resolved-group');
    out.threadCommentXssIsText = /<script>bad<\/script>/.test(await text('.pr-thread .pr-comment-body') || '');
    out.threadAvatarShown = await exists('.pr-thread .pr-comment-head .avatar');

    // ---- Ask Claude posts the thread id -------------------------------------
    await clearPosted();
    await click('[data-ask-thread="th-1"]');
    const askMsg = (await posted()).find((m) => m.type === 'pr:askThread');
    out.askThreadSent = askMsg && askMsg.threadId === 'th-1';

    // ---- Commits tab: grouped, with avatars and short shas ------------------
    await clearPosted();
    await click('[data-tab="commits"]');
    out.commitsTabOn = /^Commits/.test(await text('.pr-tab.on') || '');
    out.commitsGrouped = await exists('.pr-commit-group h5');
    out.commitShaShown = /abc123d/.test(await text('.pr-commit-group') || '');
    out.commitHeadlineEscaped = /<script>bad<\/script> commit/.test(await text('.pr-commit-group') || '');

    // ---- Checks tab: failing first, re-run, ask to fix ----------------------
    await clearPosted();
    await click('[data-tab="checks"]');
    out.checksTabFailBadge = /1/.test(await text('.pr-tab.on .pr-tab-badge') || '');
    out.failingCheckFirst = (await text('.pr-checks li:first-child .pr-check-name') || '').indexOf('build') === 0;
    await click('[data-ask-check="run-1"]');
    const askCheckMsg = (await posted()).find((m) => m.type === 'pr:askCheck');
    out.askCheckSent = askCheckMsg && askCheckMsg.runId === 'run-1' && askCheckMsg.name === 'build';
    await click('[data-act="rerun"]');
    out.rerunSent = (await posted()).some((m) => m.type === 'pr:rerun');

    // ---- Files: one diff request, then rendered --------------------------
    await clearPosted();
    await click('[data-tab="files"]');
    const diffRequests1 = (await posted()).filter((m) => m.type === 'pr:diff').length;
    out.diffRequestedOnce = diffRequests1 === 1;
    await post({ type: 'pr:diff', diff: DIFF_TEXT, truncated: false });
    out.diffRendered = await exists('.pr-diff span.add');
    out.diffDelShown = await exists('.pr-diff span.del');
    // Switching away and back must not ask again — the diff is already loaded.
    await click('[data-tab="conversation"]');
    await clearPosted();
    await click('[data-tab="files"]');
    out.diffNotRequestedTwice = (await posted()).filter((m) => m.type === 'pr:diff').length === 0;

    // ---- a screenshot of the open pane, for a human to look at -------------
    await click('[data-tab="conversation"]');
    await browser.shot('/tmp/prpane-open.png');

    // ---- full page: fills the tab, posts full:true, the sidebar appears ----
    await clearPosted();
    await click('[data-act="full"]');
    out.fullClassApplied = await browser.evaluate("document.getElementById('pr-pane').classList.contains('full')");
    const fullMsg = (await posted()).find((m) => m.type === 'pr:pane');
    out.fullPosted = fullMsg && fullMsg.full === true;
    out.sidebarShownFull = await browser.evaluate(
      "(function(){ var s = document.querySelector('.pr-sidebar'); return !!s && getComputedStyle(s).display !== 'none'; })()"
    );
    out.sidebarHasReviewers = /ana/.test(await text('.pr-sidebar') || '');
    out.sidebarHasLabels = await exists('.pr-sidebar .pr-label-chip');
    await browser.shot('/tmp/prpane-full.png');

    // ---- exit full page again before the rest of the checks ----------------
    await click('[data-act="full"]');
    out.fullClassRemoved = !(await browser.evaluate("document.getElementById('pr-pane').classList.contains('full')"));

    // ---- a long conversation scrolls, with a scroll-to-bottom button --------
    await post({ type: 'pr:state', prUrl: PR_STATE_LONG.url, loading: false, error: null, state: PR_STATE_LONG });
    await browser.evaluate("(function(){ var b = document.querySelector('.pr-pane-body'); b.scrollTop = 0; b.dispatchEvent(new Event('scroll')); return true; })()");
    out.scrollBtnShownWhenScrolledUp = !(await hidden('.pr-scroll-bottom'));
    await click('.pr-scroll-bottom');
    out.scrollReachedBottom = await browser.until(`(function(){
      var b = document.querySelector('.pr-pane-body');
      return b.scrollHeight - b.scrollTop - b.clientHeight < 40;
    })()`, 3000);
    out.scrollBtnHidesAtBottom = await hidden('.pr-scroll-bottom');

    // ---- an update with identical data touches nothing: the body element
    // and its scroll position survive untouched -----------------------------
    await browser.evaluate(
      "(() => { var b = document.querySelector('.pr-pane-body'); b.scrollTop = 123; b.__sameBodyNode = true; return true; })()"
    );
    await post({ type: 'pr:state', prUrl: PR_STATE_LONG.url, loading: false, error: null, state: PR_STATE_LONG });
    out.bodyNodeUntouchedOnIdenticalUpdate = await browser.evaluate(
      "(() => { var b = document.querySelector('.pr-pane-body'); return !!b && b.__sameBodyNode === true; })()"
    );
    out.bodyScrollTopUntouchedOnIdenticalUpdate = (await browser.evaluate("document.querySelector('.pr-pane-body').scrollTop")) === 123;

    // ---- the header folds away with the scroll, and comes back with it ------
    const scrollTo = async (y) => {
      await browser.evaluate(`(function(){ var b = document.querySelector('.pr-pane-body'); b.scrollTop = ${y}; b.dispatchEvent(new Event('scroll')); return true; })()`);
      await new Promise((r) => setTimeout(r, 60));
      return browser.evaluate("Math.round(document.querySelector('.pr-head-more').getBoundingClientRect().height)");
    };
    await scrollTo(0); // lets the smooth scroll to the bottom above finish
    const headOpen = await scrollTo(0);
    const headPart = await scrollTo(40);
    const headGone = await scrollTo(700);
    out.titleStaysFolded = /Add the PR pane/.test(await text('.pr-title') || '') &&
      await browser.evaluate("document.querySelector('.pr-title').getBoundingClientRect().height > 0");
    const headBack = await scrollTo(670);
    const headTop = await scrollTo(0);
    out.headFold = [headOpen > 60, Math.abs(headPart - (headOpen - 40)) <= 2, headGone === 0, Math.abs(headBack - 30) <= 2, headTop === headOpen];

    // ---- back to the regular fixture for the rest ---------------------------
    await post({ type: 'pr:state', prUrl: PR_STATE.url, loading: false, error: null, state: PR_STATE });

    // ---- an update that only changes the checks leaves the header alone:
    // a reviewer's avatar <img> in it is the very same node afterwards -------
    await browser.evaluate(
      "(() => { var img = document.querySelector('.pr-pane-head .pr-head-reviews .avatar img'); if (img) img.__sameNode = true; return !!img; })()"
    );
    const PR_STATE_CHECKS_ONLY = Object.assign({}, PR_STATE, {
      checks: [
        { name: 'build', workflow: 'CI', status: 'fail', url: 'https://github.com/acme/nikui/actions/runs/1', startedAt: NOW - 60000, completedAt: NOW - 10000, runId: 'run-1' },
        { name: 'lint', workflow: 'CI', status: 'pass', url: 'https://github.com/acme/nikui/actions/runs/2', startedAt: NOW - 60000, completedAt: NOW - 40000, runId: 'run-2' },
        { name: 'typecheck', workflow: 'CI', status: 'pending', url: 'https://github.com/acme/nikui/actions/runs/3', runId: 'run-3' }
      ],
      checkSummary: { total: 3, pass: 1, fail: 1, pending: 1 }
    });
    await post({ type: 'pr:state', prUrl: PR_STATE_CHECKS_ONLY.url, loading: false, error: null, state: PR_STATE_CHECKS_ONLY });
    out.headAvatarSameNodeAfterChecksOnlyUpdate = await browser.evaluate(
      "(() => { var img = document.querySelector('.pr-pane-head .pr-head-reviews .avatar img'); return !!img && img.__sameNode === true; })()"
    );
    // revert, so the rest of the checks run against the original fixture
    await post({ type: 'pr:state', prUrl: PR_STATE.url, loading: false, error: null, state: PR_STATE });

    // ---- Esc while focus is inside the pane closes it -----------------------
    await browser.evaluate("document.querySelector('.pr-pane-body').focus(); true");
    await browser.evaluate(
      "document.getElementById('pr-pane').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
    );
    out.escSlidesOut = await browser.evaluate("(() => { const h = document.getElementById('pr-pane'); return !h.hidden && h.classList.contains('leaving') && getComputedStyle(h).transitionDuration.startsWith('0.38'); })()");
    await new Promise((r) => setTimeout(r, 600));
    out.escClosedPane = await hidden('#pr-pane');
    out.escSettled = await browser.evaluate("(() => { const h = document.getElementById('pr-pane'); return !h.classList.contains('moving') && !h.classList.contains('leaving') && !h.style.transform && !document.body.className.includes('pr-'); })()");

    // ---- an action's reply re-enables the buttons, with a message -----------
    await click('#pr-chip');
    await click('[data-tab="threads"]');
    await click('[data-resolve="th-1"]');
    out.resolveSentAndDisabled = await browser.evaluate(
      "document.querySelector('[data-resolve=\\'th-1\\']').disabled"
    );
    await post({ type: 'pr:done', action: 'resolve', ok: true, message: 'Resolved.' });
    out.doneMessageShown = /Resolved/.test(await text('.pr-done-banner') || '');
    out.reEnabledAfterDone = !(await browser.evaluate(
      "(document.querySelector('[data-resolve=\\'th-1\\']') || {}).disabled"
    ));

    // ---- a refresh mid-reply keeps the reply, the focus and the caret ------
    await browser.evaluate(
      "(() => { const t = document.querySelector('textarea[data-draft=\\'th-1\\']'); t.focus(); t.value = 'half a reply'; " +
      "t.dispatchEvent(new Event('input', { bubbles: true })); t.setSelectionRange(4, 4); return true; })()"
    );
    await post({ type: 'pr:state', prUrl: PR_STATE.url, loading: false, error: null, state: PR_STATE });
    out.replyKeptAcrossRefresh = await browser.evaluate(
      "(() => { const t = document.activeElement; return !!t && t.getAttribute('data-draft') === 'th-1' && " +
      "t.value === 'half a reply' && t.selectionStart === 4; })()"
    );

    // ---- meta with prPane.open:true opens it on init, the old tab name maps -
    await post({
      type: 'init', sessionId: 's2', items: [],
      meta: Object.assign({}, META_LINKED, { prPane: { open: true, tab: 'comments', width: 500, full: false } }),
      status: 'idle', stats: {}, queue: [], slashCommands: [], commandArgs: {}, showThinking: true,
      dropped: 0, maxItems: 400
    });
    out.openOnInit = !(await hidden('#pr-pane'));
    out.openOnInitTab = /^Threads/.test(await text('.pr-tab.on') || '');

    // ---- no PR linked: the chip is gone, an open pane offers Link a PR ------
    await post({
      type: 'meta', meta: Object.assign({}, META_LINKED, { prUrl: null, prPane: { open: true, tab: 'conversation', width: null, full: false } })
    });
    out.chipGoneWithNoPr = await hidden('#pr-chip');
    out.linkButtonShown = await exists('[data-act="link"]');
    await clearPosted();
    await click('[data-act="link"]');
    out.linkSent = (await posted()).some((m) => m.type === 'pr:link');

    out.errors = await browser.evaluate('window.__errors');
  } finally {
    browser.close();
  }

  const checks = [
    ['avatars are as wide as they are tall, at the size they ask for', out.avatarsSquare === true],
    ['the pane writes no style="" into its markup', out.noInlineStyleMarkup === true],
    ['the chip shows the number before pr:state answers', out.chipShownBeforeData === true && out.chipNumberBeforeData === '#691'],
    ['the pane starts closed', out.paneClosedInitially === true],
    ['while loading, the header and body show their skeleton', out.loadingSkeletonShown === true],
    ['and mark themselves aria-busy', out.loadingAriaBusy === true],
    ['once pr:state answers, the chip keeps the number', out.chipNumber === '#691'],
    ['and shows a red dot for the failing check', out.chipFailDot === true],
    ['and the unresolved thread count', /1/.test(out.chipBubble || '')],
    ['clicking the chip opens the drawer', out.paneOpened === true],
    ['defaulting to the Conversation tab', out.paneOpenPosted === true && out.conversationTabOn === true],
    ['no "NaNd ago" anywhere — fetchedAt etc. are ISO strings', out.noNaN === true],
    ['the pane head shows the PR title', out.titleShown === true],
    ['its state as a pill', out.stateWordShown === true],
    ['the "wants to merge ... into ... from ..." line', out.mergeLineShown === true],
    ["GitHub's five-block change bar", out.changeBarShown === true],
    ['a hostile PR body never runs', out.xssDidNotRun === true],
    ['nor does it leave a script tag in the DOM', out.noScriptTag === true],
    ['ordinary markdown still renders', out.markdownStillWorks === true],
    ["a markdown table's narrow column isn't shattered letter by letter", out.tableCellNotShattered === true],
    ['the description card comes first in the timeline', out.descriptionFirst === true],
    ['then the timeline items in order: comment, commits, event, review', out.orderIsCommentCommitsEventReview === true],
    ["a review card contains its reviewer's inline thread", out.reviewHasThread === true],
    ['earlier items not shown are called out', out.earlierBannerShown === true],
    ['and link to the PR on GitHub', out.earlierOpensGithub === true],
    ['a known login gets a real avatar image', out.knownAvatarImg === true],
    ['a null avatar falls back to an initial', out.nullAvatarFallsBack === true],
    ['event text renders as text, never HTML', out.eventTextIsEscaped === true],
    ['narrow: a compact reviewers/labels row shows', out.compactRowShownNarrow === true],
    ['scrolling down folds the header as far as it scrolled, up brings it back as far, the top opens it all',
      JSON.stringify(out.headFold) === '[true,true,true,true,true]'],
    ['folded, the title is still there', out.titleStaysFolded === true],
    ['an update that only changes the checks leaves a header avatar the same node', out.headAvatarSameNodeAfterChecksOnlyUpdate === true],
    ['the header lists every reviewer, changes requested first, stale and re-requested marked',
      out.headReviews === 'bob:Changes requested:stale:again|ana:Approved|ghost:Awaiting review'],
    ['and the full sidebar does not', out.sidebarHiddenNarrow === true],
    ['clicking a tab switches it', out.threadsTabOn === true],
    ['and posts the whole state, including full', out.threadsTabPosted === true],
    ['unresolved threads come first', out.unresolvedFirst === true],
    ['resolved ones are collapsed', out.resolvedCollapsed === true],
    ['a hostile thread comment renders as text', out.threadCommentXssIsText === true],
    ['thread comments show an avatar', out.threadAvatarShown === true],
    ['Ask Claude sends the thread id', out.askThreadSent === true],
    ['Commits tab groups by day', out.commitsTabOn === true && out.commitsGrouped === true],
    ['and shows the short sha', out.commitShaShown === true],
    ['commit headlines render as text, never HTML', out.commitHeadlineEscaped === true],
    ['the Checks tab badges the failing count', out.checksTabFailBadge === true],
    ['failing checks sort first', out.failingCheckFirst === true],
    ['Ask Claude to fix sends the run id and name', out.askCheckSent === true],
    ['Re-run failed asks the host', out.rerunSent === true],
    ['opening Files asks for the diff once', out.diffRequestedOnce === true],
    ['the diff renders added lines', out.diffRendered === true],
    ['and removed ones', out.diffDelShown === true],
    ['leaving and returning to Files does not ask again', out.diffNotRequestedTwice === true],
    ['the full-page toggle fills the tab', out.fullClassApplied === true],
    ['and posts full:true', out.fullPosted === true],
    ['which reveals the sidebar', out.sidebarShownFull === true],
    ['with reviewers', out.sidebarHasReviewers === true],
    ['and labels', out.sidebarHasLabels === true],
    ['toggling again exits full page', out.fullClassRemoved === true],
    ['a long conversation shows the scroll-to-bottom button when scrolled up', out.scrollBtnShownWhenScrolledUp === true],
    ['clicking it reaches the bottom', out.scrollReachedBottom === true],
    ['and the button hides once there', out.scrollBtnHidesAtBottom === true],
    ['an update with identical data leaves the body element alone', out.bodyNodeUntouchedOnIdenticalUpdate === true],
    ["and its scroll position", out.bodyScrollTopUntouchedOnIdenticalUpdate === true],
    ['Escape slides the pane out on the closing spring', out.escSlidesOut === true],
    ['Escape with focus inside the pane closes it', out.escClosedPane === true],
    ['and leaves nothing of the slide behind', out.escSettled === true],
    ['an action disables its button until the host answers', out.resolveSentAndDisabled === true],
    ['pr:done shows the message', out.doneMessageShown === true],
    ['and re-enables the button', out.reEnabledAfterDone === true],
    ['a refresh mid-reply keeps the text, focus and caret', out.replyKeptAcrossRefresh === true],
    ['meta.prPane.open opens the drawer on init', out.openOnInit === true],
    ["on the tab it remembered, old name 'comments' mapped to Threads", out.openOnInitTab === true],
    ['with no PR linked, the chip disappears', out.chipGoneWithNoPr === true],
    ['but an open pane offers to link one', out.linkButtonShown === true],
    ['which asks the host', out.linkSent === true],
    ['no script errors over the whole run', (out.errors || []).length === 0]
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
    if (!ok) failed++;
  }
  console.log('\nScreenshots: /tmp/prpane-open.png, /tmp/prpane-full.png');
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' PR pane checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
