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

// Careful: this is a template literal, so a backslash in it is eaten before the
// browser ever sees it — a regex written /\s+/ here arrives as /s+/ and quietly
// matches the letter s. Double every backslash.
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
      queue: [], slashCommands: ['status', 'table', 'decisions', 'model'], showThinking: true,
      commandArgs: { model: [
        { value: 'claude-opus-5-5', label: 'Opus 5.5', detail: '' },
        { value: 'claude-opus-5-5[1m]', label: 'Opus 5.5', detail: '1M context' },
        { value: 'opus' }
      ] },
      ownCommands: ['status', 'table', 'decisions'],
      snippets: { table: 'TABLE INSTRUCTION', decisions: 'DECISIONS INSTRUCTION' }
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

    // When it was sent, and when the answer came back.
    const sentAt = new Date(); sentAt.setHours(9, 5, 0, 0);
    const backAt = new Date(2020, 2, 4, 17, 30);
    post({ type: 'items', items: [
      { id: 'ut1', kind: 'user', text: 'timed', images: [], at: sentAt.getTime() },
      { id: 'rt1', kind: 'result', durationMs: 65000, at: backAt.getTime() },
      { id: 'ut2', kind: 'user', text: 'untimed', images: [] }] });
    const sentTag = document.querySelector('[data-id="ut1"] .sent-at');
    out.sentAt = sentTag ? sentTag.textContent : null;
    out.sentAtTitle = sentTag ? sentTag.getAttribute('title') : null;
    const backTag = document.querySelector('.result .received-at');
    out.resultLine = backTag ? backTag.parentNode.textContent : null;
    out.receivedAt = backTag ? backTag.textContent : null;
    const untimed = document.querySelector('[data-id="ut2"]');
    out.untimedHasNoTime = !!untimed && !untimed.querySelector('.sent-at');
    post({ type: 'meta', clock: '12h' });
    out.sentAt12 = sentTag ? sentTag.textContent : null;
    out.receivedAt12 = backTag ? backTag.textContent : null;
    post({ type: 'meta', clock: '24h' });
    out.sentAtBack = sentTag ? sentTag.textContent : null;

    // A turn that ends asking you to push offers "pushed", one tap away.
    try {
    const chips = () => Array.from(document.querySelectorAll('#replies .reply-chip')).map((b) => b.textContent);
    post({ type: 'status', status: 'working' });
    post({ type: 'items', items: [
      { id: 'ux1', kind: 'user', text: 'make the change', images: [] },
      { id: 'tx1', kind: 'text', text: 'Committed. Tell me once it is pushed.' }] });
    out.repliesWhileWorking = chips().length;
    post({ type: 'items', items: [{ id: 'rx1', kind: 'result', durationMs: 4000, at: Date.now() }] });
    out.repliesBeforeDone = chips().length;
    post({ type: 'status', status: 'done' });
    out.replies = chips().join(',');
    out.repliesLast = document.getElementById('stream').lastElementChild.id;
    input.value = 'my own words';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    out.repliesWhileTyping = chips().length;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    out.repliesBack = chips().length;
    window.__posted.length = 0;
    const chip = document.querySelector('#replies .reply-chip');
    if (chip) chip.click();
    const chipSend = window.__posted.filter((m) => m.type === 'send').pop() || {};
    out.chipSent = chipSend.text;
    out.chipCleared = input.value === '' && !document.getElementById('replies');
    post({ type: 'status', status: 'done' });
    post({ type: 'items', items: [
      { id: 'tx2', kind: 'text', text: 'Shall I open the PR?' },
      { id: 'rx2', kind: 'result', isError: true, text: 'Error' }] });
    out.repliesAfterError = chips().length;
    post({ type: 'items', items: [{ id: 'rx3', kind: 'result', durationMs: 1000 }] });
    out.repliesYesNo = chips().join(',');
    post({ type: 'meta', replySuggestions: false });
    out.repliesSwitchedOff = chips().length;
    } catch (e) { out.replyError = String(e && e.stack || e); }

    // The palette offers it, tagged as ours.
    input.value = '/tab';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const row = Array.from(document.querySelectorAll('#slash .row')).find((r) => /table/.test(r.textContent));
    out.snippetInPalette = row ? row.textContent.replace(/\\s+/g, ' ').trim() : null;
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

    // As many snippets as you like: accepting one leaves the palette ready for
    // the next, and both instructions go with the prompt.
    input.value = 'fix the rollback /tab';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    input.value = input.value + '/dec';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    out.secondPaletteOpen = !document.getElementById('slash').hidden;
    key(input, 'Enter');
    out.chainedLine = input.value;
    key(input, 'Enter');
    const chained = window.__posted.filter((m) => m.type === 'send').pop() || {};
    out.chainedUsed = (chained.snippets || []).join(',');
    out.chainedSent = chained.sent;

    // A command that takes values: its own list, arrow navigable, and choosing
    // one finishes the line -- "/model claude-opus-5-5" is the whole prompt.
    input.value = '/model ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    out.valueRows = Array.from(document.querySelectorAll('#slash .row'))
      .map((r) => r.textContent.replace(/\\s+/g, ' ').trim());
    key(input, 'ArrowDown');
    const on = document.querySelector('#slash .row.on');
    out.valueHighlight = on ? on.textContent.replace(/\\s+/g, ' ').trim() : null;
    key(input, 'Enter');
    const modelSend = window.__posted.filter((m) => m.type === 'send').pop() || {};
    out.valueSent = modelSend.text;
    out.valueCleared = input.value === '';

    // Typing part of the identifier narrows it, from anywhere in the word.
    input.value = '/model opus';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    out.valueNarrowed = document.querySelectorAll('#slash .row').length;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // /settings: answered here, like /status — a sheet of switches.
    const SETTINGS = (thinking) => ({ groups: ['Claude', 'Your laptop'], rows: [
      { id: 'thinking', group: 'Claude', kind: 'toggle', label: 'Show thinking', value: thinking },
      { id: 'effort', group: 'Claude', kind: 'choice', label: 'Effort', value: 'max',
        choices: [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }] },
      { id: 'fontSize', group: 'Claude', kind: 'number', label: 'Text size', value: 13, min: 10, max: 24 },
      { id: 'lid', group: 'Your laptop', kind: 'toggle', label: 'Keep working with the lid closed', value: false,
        note: 'Asks for your password once, on the laptop.' }
    ] });
    const setSent = () => window.__posted.filter((m) => m.type === 'setSetting').pop() || {};
    const pane = document.getElementById('status');

    const beforeSettings = window.__posted.length;
    input.value = '/settings';
    key(input, 'Enter');
    out.settingsAsked = window.__posted.slice(beforeSettings).some((m) => m.type === 'settings');
    out.settingsNotSent = !window.__posted.slice(beforeSettings).some((m) => m.type === 'send');
    post({ type: 'settings', mayChange: true, local: true, settings: SETTINGS(true) });
    out.settingsOpen = !pane.hidden && !!pane.querySelector('.prefs');
    out.settingsGroups = Array.from(pane.querySelectorAll('.prefs-group h3')).map((h) => h.textContent).join('|');
    out.settingsNote = (pane.querySelector('[data-pref="lid"] .pref-note') || {}).textContent || '';
    out.allSettingsOffered = !!pane.querySelector('[data-act="all-settings"]');

    pane.querySelector('[data-toggle="thinking"]').click();
    out.toggleSent = setSent().id + '=' + setSent().value;
    out.toggleShownAtOnce = pane.querySelector('[data-toggle="thinking"]').getAttribute('aria-checked');
    out.togglePending = pane.querySelector('[data-pref="thinking"]').classList.contains('pending');

    const pick = pane.querySelector('[data-choose="effort"]');
    pick.value = 'high';
    pick.dispatchEvent(new Event('change', { bubbles: true }));
    out.choiceSent = setSent().id + '=' + setSent().value;

    pane.querySelector('[data-step="fontSize"][data-by="1"]').click();
    out.stepSent = setSent().id + '=' + setSent().value;

    // The laptop said no: the switch goes back, and the sheet says why.
    post({ type: 'settings', mayChange: true, local: true, refused: 'Approve it once on the laptop first.',
      settings: SETTINGS(true) });
    out.refusedShown = /Approve it once on the laptop first/.test(pane.textContent);
    out.switchBack = pane.querySelector('[data-toggle="thinking"]').getAttribute('aria-checked');

    // The arrows belong to /status's sections, and there are none here.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    out.arrowsLeaveIt = !!pane.querySelector('.prefs');

    const beforeClose = window.__posted.length;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.settingsClosed = (pane.hidden || pane.classList.contains("closing"));
    out.settingsCloseSaid = window.__posted.slice(beforeClose).some((m) => m.type === 'settingsOpen' && m.open === false);

    // A change made somewhere else, while nobody here asked, opens nothing.
    post({ type: 'settings', mayChange: true, local: true, settings: SETTINGS(false) });
    out.unaskedOpensNothing = (pane.hidden || pane.classList.contains("closing"));

    // A phone that may only watch sees the settings and cannot touch them.
    input.value = '/settings';
    key(input, 'Enter');
    post({ type: 'settings', mayChange: false, local: false, settings: SETTINGS(true) });
    out.watchLocked = Array.from(pane.querySelectorAll('[data-toggle], [data-choose], [data-step]')).every((c) => c.disabled);
    out.watchToldWhy = /can watch but not change settings/.test(pane.textContent);
    out.watchNoFullList = !pane.querySelector('[data-act="all-settings"]');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // /commands: reached from /settings, laid out like /status, and a snippet
    // edited, saved, refused and added from it.
    const COMMANDS = (extra) => [
      { name: 'status', kind: 'own', usage: '/status', description: 'A sheet of what this instance is doing.' },
      { name: 'watch', kind: 'own', usage: '/watch [prompt]', description: 'Watches the CI.' },
      { name: 'table', kind: 'snippet', prompt: 'Give me a table.', description: 'The plan as a table.',
        summary: 'The plan as a table.', shipped: true, edited: false, off: false }
    ].concat(extra || []);
    const lastPosted = (type) => window.__posted.filter((m) => m.type === type).pop() || {};
    input.value = '/settings';
    key(input, 'Enter');
    post({ type: 'settings', mayChange: true, local: true, settings: SETTINGS(true) });
    out.commandsRowInSettings = !!pane.querySelector('[data-act="commands"]');
    const beforeCommands = window.__posted.length;
    pane.querySelector('[data-act="commands"]').click();
    out.commandsAsked = window.__posted.slice(beforeCommands).some((m) => m.type === 'commands');
    post({ type: 'commands', mayChange: true, commands: COMMANDS() });
    out.commandsReplaceSettings = !pane.querySelector('.prefs') && !!pane.querySelector('.cmd-nav') &&
      window.__posted.slice(beforeCommands).some((m) => m.type === 'settingsOpen' && m.open === false);
    out.commandsLayout = !!pane.querySelector('.sheet-body .sheet-nav') && !!pane.querySelector('.sheet-body .sheet-content');
    out.commandsNav = Array.from(pane.querySelectorAll('[data-command]')).map((b) => b.dataset.command).join(',');
    pane.querySelector('[data-command="table"]').click();
    out.commandsPreview = (pane.querySelector('.cmd-prompt') || {}).textContent || '';
    pane.querySelector('[data-act="edit"]').click();
    const promptBox = pane.querySelector('#cmd-prompt');
    out.commandsEditFocused = document.activeElement === promptBox;
    promptBox.value = 'A shorter table.';
    promptBox.dispatchEvent(new Event('input', { bubbles: true }));
    // Somebody else saves something meanwhile: the draft survives the redraw.
    post({ type: 'commands', mayChange: true, commands: COMMANDS([{ name: 'other', kind: 'snippet', prompt: 'x',
      description: '', summary: 'x', shipped: false, edited: false, off: false }]) });
    out.commandsDraftKept = (pane.querySelector('#cmd-prompt') || {}).value;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    const saved = lastPosted('saveCommand');
    out.commandsSaveSent = [saved.was, saved.name, saved.prompt].join('|');
    out.commandsSaving = !!pane.querySelector('[data-act="save"][disabled]');
    post({ type: 'commands', mayChange: true, refused: 'There is already a /table.', name: 'table', commands: COMMANDS() });
    out.commandsRefusedShown = pane.textContent.includes('already a /table') && !!pane.querySelector('#cmd-prompt');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    post({ type: 'commands', mayChange: true, done: 'saveCommand', name: 'table', commands: COMMANDS() });
    out.commandsSavedCloses = !pane.querySelector('#cmd-prompt') && !!pane.querySelector('.cmd-prompt');
    // A new one, from the rail.
    pane.querySelector('[data-command="+new"]').click();
    out.commandsNewFocused = document.activeElement === pane.querySelector('#cmd-name');
    // The answer to something asked earlier must not shut a form opened since.
    post({ type: 'commands', mayChange: true, done: 'restoreCommand', name: 'table', commands: COMMANDS() });
    out.commandsLateReplyKeepsForm = !!pane.querySelector('#cmd-name');
    const field = (id, value) => { const el = pane.querySelector(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
    field('#cmd-name', 'checklist');
    field('#cmd-description', 'A checklist at the end');
    field('#cmd-prompt', 'End with a checklist.');
    pane.querySelector('[data-act="save"]').click();
    const added = lastPosted('saveCommand');
    out.commandsNewSent = [added.was, added.name, added.description, added.prompt].join('|');
    post({ type: 'commands', mayChange: true, done: 'saveCommand', name: 'checklist', commands: COMMANDS([{ name: 'checklist',
      kind: 'snippet', prompt: 'End with a checklist.', description: 'A checklist at the end', summary: 'A checklist at the end',
      shipped: false, edited: false, off: false }]) });
    out.commandsNewShown = !!pane.querySelector('.cmd-item.on[data-command="checklist"]');
    pane.querySelector('[data-act="ask-remove"]').click();
    out.commandsDeleteAsks = lastPosted('removeCommand').name !== 'checklist' && !!pane.querySelector('[data-act="remove"]');
    pane.querySelector('[data-act="remove"]').click();
    out.commandsDeleteSent = lastPosted('removeCommand').name;
    // Escape in the form puts the draft down; Escape again closes the page.
    pane.querySelector('[data-command="table"]').click();
    pane.querySelector('[data-act="edit"]').click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.commandsEscapeCancels = !pane.hidden && !pane.querySelector('#cmd-prompt');
    const beforeCommandsClose = window.__posted.length;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.commandsClosed = (pane.hidden || pane.classList.contains("closing")) &&
      window.__posted.slice(beforeCommandsClose).some((m) => m.type === 'commandsOpen' && m.open === false);
    // Typed, and for a phone that only watches.
    input.value = '/commands';
    key(input, 'Enter');
    out.commandsTypedNotSent = lastPosted('send').text !== '/commands';
    post({ type: 'commands', mayChange: false, commands: COMMANDS() });
    out.commandsWatchReadOnly = !pane.hidden && !pane.querySelector('[data-act="edit"]') &&
      !pane.querySelector('[data-command="+new"]') && /can watch but not change commands/.test(pane.textContent);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

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
    const sheetNow = document.getElementById('status');
    out.sheetBeforeReport = !sheetNow.hidden && !!sheetNow.querySelector('.skeleton[aria-busy="true"]');
    out.streamSkeletonGone = !document.querySelector('#stream .skeleton');

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
      out.sheetClosed = (sheet.hidden || sheet.classList.contains("closing"));
      out.sheetFadesOut = !sheet.hidden && sheet.classList.contains('closing');
      await new Promise((r) => setTimeout(r, 320));
      out.sheetGoneAfterFade = sheet.hidden && !sheet.classList.contains('closing') && sheet.innerHTML === '';
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
      // So does an image pasted and not yet sent. The reader is made
      // synchronous: under the virtual clock a real one never finishes.
      window.FileReader = function () {
        this.readAsDataURL = (f) => { this.result = 'data:' + f.type + ';base64,AAAA'; this.onload(); };
      };
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'shot.png', { type: 'image/png' }));
      composer.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      setTimeout(() => {
        window.dispatchEvent(new Event('pagehide'));
        const last = window.__state[window.__state.length - 1] || {};
        out.draftSaved = last.draft === 'half typed thought';
        out.imageSaved = !!(last.attachments && last.attachments.length === 1 && last.attachments[0].mediaType === 'image/png' && last.attachments[0].data);
        out.stateKeepsSession = !!last.sessionId;
        out.scrollSaved = typeof last.scrollTop === 'number';
        out.errors = window.__errors;
        document.title = JSON.stringify(out);
      }, 100);
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
  ['and so is an image pasted but not sent', out.imageSaved === true],
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
  ['/status opens the sheet at once, on a skeleton, before the report', out.sheetBeforeReport === true],
  ['the conversation skeleton is gone once the history arrives', out.streamSkeletonGone === true],
  ['escape closes the sheet', out.sheetClosed === true],
  ['by fading it out rather than vanishing', out.sheetFadesOut === true],
  ['and it is gone once the fade ends', out.sheetGoneAfterFade === true],
  ['the page ships a skeleton, not "Ask Claude anything", before the history', /id="stream"><div class="skeleton" aria-busy="true">/.test(html) && !/id="stream"><div class="empty">/.test(html)],
  ['escape did not interrupt the turn instead', out.interruptedByEscape === 0],
  ['escape arms itself before abandoning a turn', out.escArmed === true],
  ['and the first press interrupts nothing', out.escQuietOnFirstPress === 0],
  ['the second press interrupts', out.escInterruptsOnSecond === 1],
  ['and the hint goes with it', out.escHintCleared === true],
  ['escape does nothing when nothing is running', out.escIdleNoop === true],
  ['the single-press setting restores the CLI behaviour', out.singleEscapeInterrupts === true],
  ['opening the sheet tells the host to keep it fresh', out.sheetOpenTold === true],
  ['and closing it tells the host to stop', out.sheetCloseTold === true],
  ['a whole message can be copied, not just its code', out.copyAllButtons === 8],
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
  ['a prompt says when it was sent, as the time alone today', /^0?9[:.]05/.test(out.sentAt || '')],
  ['with the full date on hover', /^Sent /.test(out.sentAtTitle || '')],
  ['a finished turn says how long it took and when it came back', /Done/.test(out.resultLine || '') && /1m 05s/.test(out.resultLine || '')],
  ['an older one says which day', /Mar/.test(out.receivedAt || '') && /17[:.]30|5[:.]30/.test(out.receivedAt || '')],
  ['an item with no time shows none', out.untimedHasNoTime],
  ['switched to 12-hour, the times already shown are rewritten', /^9[:.]05/.test(out.sentAt12 || '') && /PM|pm/.test(out.receivedAt12 || '')],
  ['and back to 24-hour', out.sentAtBack === out.sentAt],
  ['no reply is suggested while the turn is still going', out.repliesWhileWorking === 0 && out.repliesBeforeDone === 0],
  ['asked to push, it offers "pushed"', out.replies === 'pushed'],
  ['under the finished turn, at the very end', out.repliesLast === 'replies'],
  ['not while you are typing your own reply', out.repliesWhileTyping === 0 && out.repliesBack === 1],
  ['one tap sends it', out.chipSent === 'pushed'],
  ['and the suggestion goes away', out.chipCleared],
  ['a turn that failed offers nothing', out.repliesAfterError === 0],
  ['a yes-or-no question offers yes and no', out.repliesYesNo === 'yes,no'],
  ['switched off in settings, none are offered', out.repliesSwitchedOff === 0],
  ['the palette offers it as ours', /table/.test(out.snippetInPalette || '') && /NikUI/.test(out.snippetInPalette || '')],
  ['a slash at the end of a prompt opens the palette', out.trailingPaletteOpen === true],
  ['and it offers the snippet there', out.trailingPaletteOffers === true],
  ['accepting one keeps what came before it', out.trailingPaletteKeepsPrefix === 'fix the rollback /table '],
  ['a second slash opens the palette again', out.secondPaletteOpen === true],
  ['and both snippets end up on the prompt',
    out.chainedLine === 'fix the rollback /table /decisions '],
  ['both instructions are sent', out.chainedUsed === 'table,decisions'],
  ['with the words that were typed',
    out.chainedSent === 'fix the rollback\n\nTABLE INSTRUCTION\n\nDECISIONS INSTRUCTION'],
  ['a command with values offers them', (out.valueRows || []).length === 3],
  ['each row reads as a person would say it', /Opus 5.5/.test((out.valueRows || [])[0] || '')],
  ['with the identifier beside it',
    /claude-opus-5-5/.test((out.valueRows || [])[0] || '')],
  ['and the wide one says what is wide about it',
    /1M context/.test((out.valueRows || [])[1] || '')],
  ['an arrow moves the highlight', /1M context/.test(out.valueHighlight || '')],
  ['choosing one sends the whole line', out.valueSent === '/model claude-opus-5-5[1m]'],
  ['and clears the composer', out.valueCleared === true],
  ['typing part of an identifier narrows the list', out.valueNarrowed === 3],
  ['/settings opens the sheet rather than going to the CLI', out.settingsAsked === true && out.settingsNotSent === true],
  ['it opens when the laptop answers', out.settingsOpen === true],
  ['in groups, in order, with Commands last', out.settingsGroups === 'Claude|Your laptop|Commands'],
  ['a row says what the laptop is doing', /password once/.test(out.settingsNote || '')],
  ['the editor is offered the full list', out.allSettingsOffered === true],
  ['a switch flips with one click', out.toggleSent === 'thinking=false'],
  ['and shows it at once', out.toggleShownAtOnce === 'false'],
  ['while the laptop confirms it', out.togglePending === true],
  ['a choice is sent as its value', out.choiceSent === 'effort=high'],
  ['a number steps by one', out.stepSent === 'fontSize=14'],
  ['a refused change says why', out.refusedShown === true],
  ['and the switch goes back to the truth', out.switchBack === 'true'],
  ['the arrows do not treat it as /status', out.arrowsLeaveIt === true],
  ['escape closes it', out.settingsClosed === true],
  ['and tells the laptop to stop sending it', out.settingsCloseSaid === true],
  ['a change from elsewhere opens nothing nobody asked for', out.unaskedOpensNothing === true],
  ['a watching device cannot change anything', out.watchLocked === true],
  ['and is told why', out.watchToldWhy === true],
  ['and is not offered the editor\u2019s full list', out.watchNoFullList === true],
  ['/settings has a way to /commands', out.commandsRowInSettings === true],
  ['which asks the laptop for them', out.commandsAsked === true],
  ['and replaces the settings sheet rather than stacking', out.commandsReplaceSettings === true],
  ['/commands is /status\u2019s layout: a rail and a page', out.commandsLayout === true],
  ['the rail lists every command, and a way to add one', out.commandsNav === 'status,watch,table,+new'],
  ['a snippet\u2019s prompt is previewed', out.commandsPreview === 'Give me a table.'],
  ['Edit puts the cursor in the prompt', out.commandsEditFocused === true],
  ['a change elsewhere does not throw the draft away', out.commandsDraftKept === 'A shorter table.'],
  ['Cmd+Enter saves it', out.commandsSaveSent === 'table|table|A shorter table.'],
  ['and the Save button says it is saving', out.commandsSaving === true],
  ['a refused save keeps the form and says why', out.commandsRefusedShown === true],
  ['a save goes back to the preview', out.commandsSavedCloses === true],
  ['New snippet puts the cursor in the name', out.commandsNewFocused === true],
  ['a late answer to an earlier change keeps a form opened since', out.commandsLateReplyKeepsForm === true],
  ['and sends what was typed', out.commandsNewSent === '|checklist|A checklist at the end|End with a checklist.'],
  ['the page goes to the one just added', out.commandsNewShown === true],
  ['delete asks once more first', out.commandsDeleteAsks === true],
  ['and then sends it', out.commandsDeleteSent === 'checklist'],
  ['escape in the form cancels the edit, not the page', out.commandsEscapeCancels === true],
  ['escape again closes it, and says so', out.commandsClosed === true],
  ['/commands typed is answered here, not sent', out.commandsTypedNotSent === true],
  ['a watching phone reads it and cannot change it', out.commandsWatchReadOnly === true],
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
  ['leaving the transcript exactly as it was', out.transcriptIntact === 6]
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) failed++;
}
if (out.errors && out.errors.length) console.error(out.errors.join('\n'));
if (out.replyError) console.error('reply suggestions threw: ' + out.replyError);
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' webview checks passed');
process.exit(failed ? 1 : 0);
