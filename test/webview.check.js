#!/usr/bin/env node
'use strict';

// Drives the real webview in a real browser: the HTML the panel host serves,
// the actual media/*.js, and the messages the host would post. The offline
// suite can check what those modules return; only this can check that the
// page wires them together — prompt recall, the /status sheet, its navigation.
//
//   npm run test:webview
//
// Needs a Chrome binary. Skips (exit 0) when there is none, so it never turns
// a clean checkout red — set CHROME to point at one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { findChrome } = require('./helpers/chrome.js');
const { skipped } = require('./helpers/skip.js');

const ROOT = path.join(__dirname, '..');

const chrome = findChrome();
if (!chrome) {
  skipped('No Chrome found — the webview check did not run. Set CHROME=/path/to/chrome.');
}

const { install, fakeContext } = require('./helpers/vscode-stub.js');
install();
const { SessionPanel } = require('../src/panel.js');
const { Session } = require('../src/session.js');
const { buildReport } = require('../src/report.js');

// ---- a page built exactly the way the host builds it ----------------------

const context = fakeContext({ extensionUri: { fsPath: ROOT } });
const session = new Session({ cwd: ROOT });
session.totalCost = 0.42;
session.turns = 2;
session.usage = { input: 100, output: 900, cacheRead: 50000, cacheCreate: 800 };
session.contextTokens = 60000;
session.contextWindow = 200000;
session.turnLog = [1, 2].map((n) => ({
  n, at: Date.now() - n * 60000, durationMs: 3000 * n, costUsd: 0.2 * n,
  input: 50, output: 450, cacheRead: 25000, cacheCreate: 400, contextTokens: 30000 * n,
  tools: ['Bash'], model: 'claude-x', interrupted: false, isError: false
}));
session._upsert({ id: 't1', kind: 'tool', name: 'Bash', input: { command: 'ls -la' }, status: 'done' });
session._upsert({ id: 't2', kind: 'tool', name: 'Read', input: { file_path: path.join(ROOT, 'src/session.js') }, status: 'done' });

const panel = SessionPanel.show(session, context, {
  list: [session], get: () => session, focus() {}, knownCommands: () => ['status', 'effort']
});

let html = panel.panel.webview.html
  // The stub's cspSource is not a real origin. What the page must not contain
  // is checked offline (test/status.test.js); here the scripts have to run.
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace(/(src|href)="([^"]+)"/g, (m, attr, p) =>
    `${attr}="file://${path.join(ROOT, 'media', path.basename(p))}"`);

const report = buildReport({ session, fleet: [session], env: { vscode: '1.100.0', node: process.versions.node } });

const harness = `
<script>
  window.__errors = [];
  window.onerror = (m) => window.__errors.push(String(m));
  window.__state = [];
  window.acquireVsCodeApi = () => ({
    postMessage(m) { window.__posted.push(m); },
    setState(s) { window.__state.push(s); },
    getState() { return window.__state[window.__state.length - 1] || null; }
  });
  window.__posted = [];
</script>`;

const drive = `
<script>
  const REPORT = ${JSON.stringify(report)};
  const post = (m) => window.dispatchEvent(new MessageEvent('message', { data: m }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const out = {};

  setTimeout(() => {
    post({
      type: 'init', sessionId: 's1',
      items: [{ id: 'u1', kind: 'user', text: 'first prompt', images: [] },
              { id: 'u2', kind: 'user', text: 'second prompt', images: [] },
              { id: 'c1', kind: 'compact', trigger: 'automatic', before: 181234, at: Date.now() },
              { id: 't1', kind: 'tool', name: 'Bash', input: { command: 'cat big.log' }, status: 'done',
                result: 'y'.repeat(200), resultLength: 4200000, resultClipped: true }],
      dropped: 3, maxItems: 400,
      meta: { label: 'x', cwd: '/tmp', home: '/tmp', model: 'claude-x', permissionMode: 'bypassPermissions' },
      status: 'idle',
      stats: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4, total: 10, cost: 0.42, turns: 2, elapsedMs: 0, running: false, contextTokens: 60000, contextWindow: 200000 },
      queue: [], slashCommands: ['status', 'table'], commandArgs: {}, showThinking: true,
      ownCommands: ['status', 'table'], snippets: { table: 'TABLE INSTRUCTION' }
    });

    const mark = document.querySelector('.dropped');
    out.droppedNotice = mark ? mark.textContent : null;
    const clipped = document.querySelector('.tool .clipped');
    out.clipNotice = clipped ? clipped.textContent : null;

    const boundary = document.querySelector('.compacted');
    out.compactShown = boundary ? boundary.textContent : null;
    out.compactExplained = boundary ? boundary.getAttribute('title') : null;

    const chip = document.querySelector('#crumbs .perm-chip');
    out.permissionChip = chip ? chip.textContent.trim() : null;
    out.permissionFlagged = !!(chip && chip.classList.contains('warn'));

    const input = document.getElementById('input');
    key(input, 'ArrowUp');   out.recalledNewest = input.value;
    key(input, 'ArrowUp');   out.recalledOlder = input.value;
    key(input, 'ArrowUp');   out.stopsAtOldest = input.value;
    key(input, 'ArrowDown'); key(input, 'ArrowDown'); key(input, 'ArrowDown');
    out.draftCameBack = input.value;

    // A snippet: the panel keeps your words, the model gets the instruction.
    input.value = '/table fix the rollback';
    key(input, 'Enter');
    const snippetSend = window.__posted.filter((m) => m.type === 'send').pop() || {};
    out.snippetText = snippetSend.text;
    out.snippetSent = snippetSend.sent;
    out.snippetUsed = (snippetSend.snippets || []).join(',');

    post({ type: 'items', items: [{ id: 'us1', kind: 'user', text: 'fix the rollback',
      snippets: ['table'], images: [] }] });
    const snippetMark = document.querySelector('.used-snippets .snippet-chip');
    out.snippetChip = snippetMark ? snippetMark.textContent : null;
    out.snippetChipExplains = snippetMark ? snippetMark.getAttribute('title') : null;

    // The palette offers it, tagged as ours.
    input.value = '/tab';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const row = Array.from(document.querySelectorAll('#slash .row')).find((r) => /table/.test(r.textContent));
    out.snippetInPalette = row ? row.textContent.replace(/\s+/g, ' ').trim() : null;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // A snippet reads naturally at the end of a prompt, so the palette has to
    // offer it there too -- not only when the slash starts the line.
    input.value = 'fix the rollback /tab';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    out.trailingPaletteOpen = !document.getElementById('slash').hidden;
    const tailRow = Array.from(document.querySelectorAll('#slash .row')).find((r) => /table/.test(r.textContent));
    out.trailingPaletteOffers = !!tailRow;
    if (tailRow) tailRow.click();
    // Accepting must put back what came before the slash, not replace the line.
    out.trailingPaletteKeepsPrefix = input.value;

    // A URL and a path both contain a slash and neither is a command.
    input.value = 'see https://example.com/';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    out.urlOpensPalette = !document.getElementById('slash').hidden;
    input.value = 'open docs/validation/file.md';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    out.pathOpensPalette = !document.getElementById('slash').hidden;

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const sendsBeforeStatus = window.__posted.filter((m) => m.type === 'send').length;
    input.value = '/status';
    key(input, 'Enter');
    out.statusRequests = window.__posted.filter((m) => m.type === 'status').length;
    out.sentToCli = window.__posted.filter((m) => m.type === 'send').length - sendsBeforeStatus;
    out.composerCleared = input.value === '';

    post({ type: 'statusReport', report: REPORT });

    setTimeout(async () => {
      const sheet = document.getElementById('status');
      out.sheetOpen = !sheet.hidden;
      out.sections = sheet.querySelectorAll('.nav-item').length;
      out.charts = sheet.querySelectorAll('svg.chart').length;
      out.startsOnFleet = sheet.querySelector('.nav-item.on').dataset.section;
      out.fleetLeads = !!sheet.querySelector('.hero-label');

      sheet.querySelector('[data-section="tools"]').click();
      out.clickedToTools = sheet.querySelector('.nav-item.on').dataset.section;
      out.toolBars = sheet.querySelectorAll('.hbar svg.chart').length;
      const file = sheet.querySelector('[data-action^="open:"]');
      out.filesAreClickable = !!file;
      if (file) { file.click(); out.openedFile = (window.__posted.filter((m) => m.type === 'openFile').pop() || {}).path; }

      key(window, '5');
      out.keyedToFleet = sheet.querySelector('.nav-item.on').dataset.section;
      key(window, 'ArrowDown');
      out.arrowedOn = sheet.querySelector('.nav-item.on').dataset.section;
      key(window, '1');
      out.keyedBackToFleet = sheet.querySelector('.nav-item.on').dataset.section;

      sheet.querySelector('[data-act="refresh"]').click();
      out.refreshAsksAgain = window.__posted.filter((m) => m.type === 'status').length;

      key(window, 'Escape');
      out.sheetClosed = sheet.hidden;
      out.interruptedByEscape = window.__posted.filter((m) => m.type === 'interrupt').length;

      // Escape while a turn is running: armed first, acted on second.
      const composerEl = document.getElementById('input');
      post({ type: 'status', status: 'working' });
      key(composerEl, 'Escape');
      out.escArmed = !document.getElementById('esc-hint').hidden;
      out.escQuietOnFirstPress = window.__posted.filter((m) => m.type === 'interrupt').length;
      key(composerEl, 'Escape');
      out.escInterruptsOnSecond = window.__posted.filter((m) => m.type === 'interrupt').length;
      out.escHintCleared = document.getElementById('esc-hint').hidden;

      // And it never arms when there is nothing to interrupt.
      post({ type: 'status', status: 'idle' });
      key(composerEl, 'Escape');
      out.escIdleNoop = document.getElementById('esc-hint').hidden &&
        window.__posted.filter((m) => m.type === 'interrupt').length === 1;
      // ---- a whole message is copyable, and a drop has a target ----
      out.copyAllButtons = document.querySelectorAll('.copy-all').length;
      out.codeCopyStillThere = document.querySelectorAll('.copy:not(.copy-all)').length >= 0;

      document.dispatchEvent(new Event('dragenter', { bubbles: true }));
      out.dropTargetShown = document.body.classList.contains('dropping');
      document.dispatchEvent(new Event('dragleave', { bubbles: true }));
      out.dropTargetGone = !document.body.classList.contains('dropping');

      // ---- the sheet is a dialog ----
      out.sheetIsDialog = document.getElementById('status').getAttribute('role') === 'dialog' &&
        document.getElementById('status').getAttribute('aria-modal') === 'true';
      out.chartsAreLabelled = Array.from(document.querySelectorAll('svg.chart'))
        .every((c) => c.getAttribute('aria-label') || c.getAttribute('aria-hidden') === 'true');

      // ---- /status with arguments belongs to the CLI ----
      const composer2 = document.getElementById('input');
      const sentBefore = window.__posted.filter((m) => m.type === 'send').length;
      composer2.value = '/status something';
      key(composer2, 'Enter');
      out.statusWithArgsGoesToCli = window.__posted.filter((m) => m.type === 'send').length === sentBefore + 1;

      // ---- the queue does not empty on one click ----
      post({ type: 'queue', queue: [{ id: 'q1', text: 'first' }, { id: 'q2', text: 'second' }], drainAt: null });
      const clearBtn = () => document.querySelector('[data-clear]');
      clearBtn().click();
      out.queueArmed = clearBtn().textContent;
      out.queueSurvivedFirstClick = window.__posted.filter((m) => m.type === 'clearQueue').length;
      clearBtn().click();
      out.queueClearedOnSecond = window.__posted.filter((m) => m.type === 'clearQueue').length;

      // ---- find in conversation ----
      out.sheetOpenTold = window.__posted.some((m) => m.type === 'statusOpen' && m.open === true);
      out.sheetCloseTold = window.__posted.some((m) => m.type === 'statusOpen' && m.open === false);

      const findKey = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true });
      window.dispatchEvent(findKey);
      out.findOpened = !document.getElementById('find').hidden;

      const findInput = document.getElementById('find-input');
      findInput.value = 'prompt';
      findInput.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(200);
      out.findMatches = document.querySelectorAll('mark.hit').length;
      out.findCount = document.getElementById('find-count').textContent;
      out.findMarksCurrent = document.querySelectorAll('mark.hit.on').length;

      key(findInput, 'Enter');
      out.findSteps = document.getElementById('find-count').textContent;

      findInput.value = 'zzz-nothing-here';
      findInput.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(200);
      out.findEmpty = document.getElementById('find-count').textContent;
      out.findLeavesNoMarks = document.querySelectorAll('mark.hit').length === 0;

      findInput.value = 'prompt';
      findInput.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(200);
      key(findInput, 'Escape');
      out.findClosed = document.getElementById('find').hidden;
      out.findCleanedUp = document.querySelectorAll('mark.hit').length === 0;
      out.transcriptIntact = document.querySelectorAll('.turn-user').length;

      // Anyone who wants the CLI's single press can have it back.
      post({ type: 'init', sessionId: 's1', items: [], meta: { label: 'x', cwd: '/tmp', home: '/tmp' },
        status: 'idle', stats: {}, queue: [], slashCommands: [], commandArgs: {}, showThinking: true,
        singleEscape: true, dropped: 0, maxItems: 400 });
      post({ type: 'status', status: 'working' });
      const before = window.__posted.filter((m) => m.type === 'interrupt').length;
      key(document.getElementById('input'), 'Escape');
      out.singleEscapeInterrupts = window.__posted.filter((m) => m.type === 'interrupt').length === before + 1;

      // A draft has to outlive the webview being thrown away while hidden, and
      // VS Code gives no warning — so the page writes its state out on the way.
      const composer = document.getElementById('input');
      composer.value = 'half typed thought';
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      window.dispatchEvent(new Event('pagehide'));
      const last = window.__state[window.__state.length - 1] || {};
      out.draftSaved = last.draft === 'half typed thought';
      out.stateKeepsSession = !!last.sessionId;
      out.scrollSaved = typeof last.scrollTop === 'number';
      out.errors = window.__errors;
      document.title = JSON.stringify(out);
    }, 420);
  }, 80);
</script>`;

html = html.replace('<script', harness + '\n<script').replace('</body>', drive + '</body>');
const page = path.join(os.tmpdir(), 'nikui-webview-check.html');
fs.writeFileSync(page, html);

// ---- run it ---------------------------------------------------------------

const dom = execFileSync(chrome, [
  '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=5000',
  '--dump-dom', 'file://' + page
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

const title = (dom.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
if (!title || title === 'NikUI') {
  console.error('The page never finished: the webview scripts did not run.');
  process.exit(1);
}
const out = JSON.parse(title.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"));

const checks = [
  ['no script errors on the page', (out.errors || []).length === 0],
  ['dropped messages are accounted for, not hidden', /3 earlier messages/.test(out.droppedNotice || '')],
  ['and it says where the whole conversation is', /transcript/.test(out.droppedNotice || '')],
  ['a cut tool result says how much was cut', /4\.0 MB/.test(out.clipNotice || '')],
  ['a compaction is drawn in the conversation', /Compacted here automatically/.test(out.compactShown || '')],
  ['with how full the context had got', /181k tokens/.test(out.compactShown || '')],
  ['and what it means for what is above it', /only a summary/.test(out.compactExplained || '')],
  ['and that Claude still saw all of it', /given all of it/.test(out.clipNotice || '')],
  ['a half-typed draft is saved before the page goes away', out.draftSaved === true],
  ['and where the reader was', out.scrollSaved === true],
  ['the saved state still names the instance', out.stateKeepsSession === true],
  ['the permission mode is stated in the header', out.permissionChip === 'tools run without asking'],
  ['bypassing permissions is flagged, not whispered', out.permissionFlagged === true],
  ['up recalls the newest prompt', out.recalledNewest === 'second prompt'],
  ['up again recalls the one before', out.recalledOlder === 'first prompt'],
  ['the oldest prompt is the end of the line', out.stopsAtOldest === 'first prompt'],
  ['down walks back to the empty draft', out.draftCameBack === ''],
  ['/status asks the host for a report', out.statusRequests === 1],
  ['/status never reaches the CLI', out.sentToCli === 0],
  ['/status clears the composer', out.composerCleared === true],
  ['the report opens the sheet', out.sheetOpen === true],
  ['every section is in the rail', out.sections === 6],
  ['the overview draws its meter and its trend', out.charts >= 2],
  ['a bar is drawn for every tool used', out.toolBars === 2],
  ['it opens on the fleet', out.startsOnFleet === 'fleet'],
  ['with the whole window at the top', out.fleetLeads === true],
  ['clicking the rail changes section', out.clickedToTools === 'tools'],
  ['a touched file is clickable', out.filesAreClickable === true],
  ['clicking one asks the host to open it', /src\/session\.js$/.test(out.openedFile || '')],
  ['number keys jump to a section', out.keyedToFleet === 'timeline'],
  ['arrows move through the sections', out.arrowedOn === 'system'],
  ['and 1 goes back to the fleet', out.keyedBackToFleet === 'fleet'],
  ['refresh asks for a fresh report', out.refreshAsksAgain === 2],
  ['escape closes the sheet', out.sheetClosed === true],
  ['escape did not interrupt the turn instead', out.interruptedByEscape === 0],
  ['escape arms itself before abandoning a turn', out.escArmed === true],
  ['and the first press interrupts nothing', out.escQuietOnFirstPress === 0],
  ['the second press interrupts', out.escInterruptsOnSecond === 1],
  ['and the hint goes with it', out.escHintCleared === true],
  ['escape does nothing when nothing is running', out.escIdleNoop === true],
  ['the single-press setting restores the CLI behaviour', out.singleEscapeInterrupts === true],
  ['opening the sheet tells the host to keep it fresh', out.sheetOpenTold === true],
  ['and closing it tells the host to stop', out.sheetCloseTold === true],
  ['a whole message can be copied, not just its code', out.copyAllButtons === 3],
  ['dropping a file has a visible target', out.dropTargetShown === true],
  ['which goes away again', out.dropTargetGone === true],
  ['the sheet announces itself as a dialog', out.sheetIsDialog === true],
  ['every chart is labelled or hidden from a reader', out.chartsAreLabelled === true],
  ['/status with arguments goes to the CLI', out.statusWithArgsGoesToCli === true],
  ['clearing the queue asks first', out.queueArmed === 'Clear 2?'],
  ['and the first click clears nothing', out.queueSurvivedFirstClick === 0],
  ['the second click clears it', out.queueClearedOnSecond === 1],
  ['a snippet keeps your words in the panel', out.snippetText === 'fix the rollback'],
  ['and sends them with the instruction', out.snippetSent === 'fix the rollback\n\nTABLE INSTRUCTION'],
  ['naming which one was used', out.snippetUsed === 'table'],
  ['the prompt is marked with it', out.snippetChip === '+table'],
  ['and hovering the mark shows the instruction', /TABLE INSTRUCTION/.test(out.snippetChipExplains || '')],
  ['the palette offers it as ours', /table/.test(out.snippetInPalette || '') && /NikUI/.test(out.snippetInPalette || '')],
  ['a slash at the end of a prompt opens the palette', out.trailingPaletteOpen === true],
  ['and it offers the snippet there', out.trailingPaletteOffers === true],
  ['accepting one keeps what came before it', out.trailingPaletteKeepsPrefix === 'fix the rollback /table '],
  ['a URL does not open the palette', out.urlOpensPalette === false],
  ['nor does a path', out.pathOpensPalette === false],
  ['cmd+F opens find', out.findOpened === true],
  ['it finds every match', out.findMatches === 2],
  ['and counts them', out.findCount === '1 of 2'],
  ['with one of them current', out.findMarksCurrent === 1],
  ['enter walks to the next', out.findSteps === '2 of 2'],
  ['a search with no matches says so', out.findEmpty === 'no matches'],
  ['and leaves nothing highlighted', out.findLeavesNoMarks === true],
  ['escape closes find', out.findClosed === true],
  ['and takes its highlights with it', out.findCleanedUp === true],
  ['leaving the transcript exactly as it was', out.transcriptIntact === 3]
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) failed++;
}
if (out.errors && out.errors.length) console.error(out.errors.join('\n'));
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' webview checks passed');
process.exit(failed ? 1 : 0);
