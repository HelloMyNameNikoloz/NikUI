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

const META_LINKED = {
  label: 'nikui', cwd: ROOT, home: os.homedir(), prUrl: 'https://github.com/acme/nikui/pull/691',
  prPane: { open: false, tab: 'overview', width: null }
};

const PR_STATE = {
  url: 'https://github.com/acme/nikui/pull/691', number: 691, repo: 'acme/nikui',
  title: 'Add the PR pane', state: 'OPEN', isDraft: false, author: 'nik',
  headRef: 'pr-pane', baseRef: 'main', headSha: 'abc123', mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
  additions: 120, deletions: 14, changedFiles: 3, updatedAt: NOW, body: 'Adds the drawer.\n\n<img src=x onerror="window.__xss=1">\n<script>window.__xss=2</script>',
  checks: [
    { name: 'build', workflow: 'CI', status: 'fail', url: 'https://github.com/acme/nikui/actions/runs/1', startedAt: NOW - 60000, completedAt: NOW - 30000, runId: 'run-1' },
    { name: 'lint', workflow: 'CI', status: 'pass', url: 'https://github.com/acme/nikui/actions/runs/2', startedAt: NOW - 60000, completedAt: NOW - 50000, runId: 'run-2' }
  ],
  checkSummary: { total: 2, pass: 1, fail: 1, pending: 0 },
  reviewers: [{ login: 'ana', state: 'APPROVED' }],
  reviews: [{ author: 'ana', state: 'APPROVED', body: 'Looks **good**', at: NOW - 100000, url: 'https://github.com/acme/nikui/pull/691#review-1' }],
  threads: [
    { id: 'th-1', resolved: false, outdated: false, path: 'media/prpane.js', line: 12, diffHunk: '@@ -1,2 +1,3 @@\n+new line',
      comments: [{ id: 'c1', databaseId: 1, author: 'ana', body: 'Why `esc` here <script>bad</script>?', at: NOW - 90000, url: 'https://github.com/acme/nikui/pull/691#c1' }] },
    { id: 'th-2', resolved: true, outdated: false, path: 'media/prpane.css', line: 4, diffHunk: '@@ -1 +1 @@\n+ok',
      comments: [{ id: 'c2', databaseId: 2, author: 'nik', body: 'fixed', at: NOW - 80000, url: 'https://github.com/acme/nikui/pull/691#c2' }] }
  ],
  comments: [{ id: 'cc1', author: 'nik', body: 'Opening this up for review.', at: NOW - 200000, url: 'https://github.com/acme/nikui/pull/691#issuecomment-1' }],
  files: [{ path: 'media/prpane.js', additions: 100, deletions: 2 }, { path: 'media/prpane.css', additions: 20, deletions: 12 }],
  fetchedAt: NOW
};

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
    const exists = async (selector) => browser.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    const hidden = async (selector) => browser.evaluate(
      `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); return !e || e.hidden; })()`
    );
    const clearPosted = async () => browser.evaluate('window.__posted.length = 0; true');

    // ---- init: a PR linked, the pane closed -----------------------------
    await post({
      type: 'init', sessionId: 's1', items: [], meta: META_LINKED, status: 'idle',
      stats: {}, queue: [], slashCommands: [], commandArgs: {}, showThinking: true,
      dropped: 0, maxItems: 400
    });
    out.chipShownBeforeData = !(await hidden('#pr-chip'));
    out.chipNumberBeforeData = await text('.pr-chip-num');
    out.paneClosedInitially = await hidden('#pr-pane');

    // ---- the chip, once pr:state answers --------------------------------
    await post({ type: 'pr:state', prUrl: PR_STATE.url, loading: false, error: null, state: PR_STATE });
    out.chipNumber = await text('.pr-chip-num');
    out.chipFailDot = await exists('.pr-chip-dot.fail');
    out.chipBubble = await text('.pr-chip-bubble');

    // ---- clicking the chip opens the drawer, and says so -----------------
    await clearPosted();
    await click('#pr-chip');
    out.paneOpened = !(await hidden('#pr-pane'));
    const openMsg = (await posted()).find((m) => m.type === 'pr:pane');
    out.paneOpenPosted = openMsg && openMsg.open === true && openMsg.tab === 'overview';

    // ---- the pane head ----------------------------------------------------
    out.titleShown = /Add the PR pane/.test(await text('.pr-title') || '');
    out.refsShown = /pr-pane.*main/.test((await text('.pr-head-sub') || '').replace(/\s+/g, ' '));
    out.badgeShown = /Open/.test(await text('.pr-badge') || '');

    // ---- a hostile PR body renders as text, never runs ---------------------
    out.xssDidNotRun = await browser.evaluate('window.__xss === undefined');
    out.noScriptTag = !(await exists('.pr-body script'));
    out.markdownStillWorks = await exists('.pr-body strong, .pr-body code, .pr-body img');

    // ---- tabs switch and post the triple ------------------------------------
    await clearPosted();
    await click('[data-tab="comments"]');
    out.commentsTabOn = /^Comments/.test(await text('.pr-tab.on') || '');
    const commentsMsg = (await posted()).find((m) => m.type === 'pr:pane');
    out.commentsTabPosted = commentsMsg && commentsMsg.tab === 'comments' && commentsMsg.open === true;
    out.unresolvedFirst = await browser.evaluate(
      "!document.querySelector('.pr-pane-body > .pr-thread').classList.contains('resolved')"
    );
    out.resolvedCollapsed = await exists('.pr-resolved-group');
    out.threadCommentXssIsText = /<script>bad<\/script>/.test(await text('.pr-thread .pr-comment-body') || '');

    // ---- Ask Claude posts the thread id -------------------------------------
    await clearPosted();
    await click('[data-ask-thread="th-1"]');
    const askMsg = (await posted()).find((m) => m.type === 'pr:askThread');
    out.askThreadSent = askMsg && askMsg.threadId === 'th-1';

    // ---- checks tab: failing first, re-run, ask to fix ----------------------
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
    await click('[data-tab="overview"]');
    await clearPosted();
    await click('[data-tab="files"]');
    out.diffNotRequestedTwice = (await posted()).filter((m) => m.type === 'pr:diff').length === 0;

    // ---- a screenshot of the open pane, for a human to look at -------------
    await browser.shot('/tmp/prpane-open.png');

    // ---- Esc while focus is inside the pane closes it -----------------------
    await browser.evaluate("document.querySelector('.pr-pane-body').focus(); true");
    await browser.evaluate(
      "document.getElementById('pr-pane').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
    );
    out.escClosedPane = await hidden('#pr-pane');

    // ---- an action's reply re-enables the buttons, with a message -----------
    await click('#pr-chip');
    await click('[data-tab="comments"]');
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

    // ---- meta with prPane.open:true opens it on init -------------------------
    await post({
      type: 'init', sessionId: 's2', items: [],
      meta: Object.assign({}, META_LINKED, { prPane: { open: true, tab: 'checks', width: 500 } }),
      status: 'idle', stats: {}, queue: [], slashCommands: [], commandArgs: {}, showThinking: true,
      dropped: 0, maxItems: 400
    });
    out.openOnInit = !(await hidden('#pr-pane'));
    out.openOnInitTab = await text('.pr-tab.on');
    out.openOnInitTab = /^Checks/.test(out.openOnInitTab || '');

    // ---- no PR linked: the chip is gone, an open pane offers Link a PR ------
    await post({
      type: 'meta', meta: Object.assign({}, META_LINKED, { prUrl: null, prPane: { open: true, tab: 'overview', width: null } })
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
    ['the chip shows the number before pr:state answers', out.chipShownBeforeData === true && out.chipNumberBeforeData === '#691'],
    ['the pane starts closed', out.paneClosedInitially === true],
    ['once pr:state answers, the chip keeps the number', out.chipNumber === '#691'],
    ['and shows a red dot for the failing check', out.chipFailDot === true],
    ['and the unresolved thread count', /1/.test(out.chipBubble || '')],
    ['clicking the chip opens the drawer', out.paneOpened === true],
    ['and tells the host, with the tab', out.paneOpenPosted === true],
    ['the pane head shows the PR title', out.titleShown === true],
    ['and the branches', out.refsShown === true],
    ['and its state', out.badgeShown === true],
    ['a hostile PR body never runs', out.xssDidNotRun === true],
    ['nor does it leave a script tag in the DOM', out.noScriptTag === true],
    ['ordinary markdown still renders', out.markdownStillWorks === true],
    ['clicking a tab switches it', out.commentsTabOn === true],
    ['and posts the whole triple', out.commentsTabPosted === true],
    ['unresolved threads come first', out.unresolvedFirst === true],
    ['resolved ones are collapsed', out.resolvedCollapsed === true],
    ['a hostile thread comment renders as text', out.threadCommentXssIsText === true],
    ['Ask Claude sends the thread id', out.askThreadSent === true],
    ['the Checks tab badges the failing count', out.checksTabFailBadge === true],
    ['failing checks sort first', out.failingCheckFirst === true],
    ['Ask Claude to fix sends the run id and name', out.askCheckSent === true],
    ['Re-run failed asks the host', out.rerunSent === true],
    ['opening Files asks for the diff once', out.diffRequestedOnce === true],
    ['the diff renders added lines', out.diffRendered === true],
    ['and removed ones', out.diffDelShown === true],
    ['leaving and returning to Files does not ask again', out.diffNotRequestedTwice === true],
    ['Escape with focus inside the pane closes it', out.escClosedPane === true],
    ['an action disables its button until the host answers', out.resolveSentAndDisabled === true],
    ['pr:done shows the message', out.doneMessageShown === true],
    ['and re-enables the button', out.reEnabledAfterDone === true],
    ['a refresh mid-reply keeps the text, focus and caret', out.replyKeptAcrossRefresh === true],
    ['meta.prPane.open opens the drawer on init', out.openOnInit === true],
    ['on the tab it remembered', out.openOnInitTab === true],
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
  console.log('\nScreenshot: /tmp/prpane-open.png');
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' PR pane checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
