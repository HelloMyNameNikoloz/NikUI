'use strict';
const path = require('path');
const { buildReport } = require('../src/report.js');
const sheet = require('../media/status.js');
const charts = require('../media/charts.js');

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

function report(extra) {
  const session = Object.assign({
    id: 'nik-a', label: '1327', ticket: '1327', customTitle: null,
    status: 'working', isBusy: true, isRunning: true,
    cwd: path.join(__dirname, '..'), claudeSessionId: 'abc-123', proc: { pid: 99 },
    startedAt: NOW - 3600000, processStartedAt: NOW - 600000, lastError: null,
    meta: { model: 'claude-opus-5' }, model: '', effort: 'max',
    permissionMode: 'bypassPermissions', outputStyle: 'Concise', claudePath: 'claude',
    autoTitle: true, extraArgs: [], queueDelayMs: 5000,
    totalCost: 0.55, turns: 3,
    usage: { input: 160, output: 2000, cacheRead: 80000, cacheCreate: 1200 },
    contextTokens: 150000, contextWindow: 200000, errors: 0, interrupts: 0,
    queue: [], drainAt: null,
    turnLog: [1, 2, 3].map((n) => ({
      n, at: NOW - (4 - n) * 600000, durationMs: 5000 * n, costUsd: 0.1 * n,
      input: 50, output: 600, cacheRead: 26000, cacheCreate: 0,
      contextTokens: 50000 * n, tools: ['Bash'], model: 'claude-opus-5',
      interrupted: false, isError: false
    })),
    items: [
      { kind: 'user', text: 'hello', images: [] },
      { kind: 'text', text: 'hi' },
      { kind: 'tool', name: 'Bash', input: { command: 'ls -la' }, status: 'done' },
      { kind: 'tool', name: 'Read', input: { file_path: '/repo/src/session.js' }, status: 'done' }
    ]
  }, extra || {});
  return buildReport({ session, fleet: [session], env: { vscode: '1.100.0', node: '26.7.0' }, now: NOW });
}

module.exports = async function () {
  suite('status sheet');

  const r = report();
  const sections = sheet.SECTIONS.map((s) => s.id);
  checkEqual('the fleet comes first, then this instance', sections,
    ['fleet', 'overview', 'usage', 'tools', 'timeline', 'system']);

  const rendered = sections.map((id) => sheet.renderSheet(r, id));
  check('every section renders something', rendered.every((html) => html.length > 800));
  check('the open section is marked in the nav',
    /class="nav-item on" data-section="tools"/.test(sheet.renderSheet(r, 'tools')));
  check('an unknown section falls back to the first', sheet.renderSheet(r, 'nope') === sheet.renderSheet(r, 'fleet'));
  check('every section is always listed', rendered.every((html) =>
    sections.every((id) => html.indexOf('data-section="' + id + '"') > 0)));

  // The webview's CSP has no 'unsafe-inline', so a style attribute would simply
  // be dropped and the chart would render wrong in the real panel.
  const all = rendered.join('');
  check('nothing carries an inline style', !/style="/.test(all));
  check('svg tags are balanced', (all.match(/<svg/g) || []).length === (all.match(/<\/svg>/g) || []).length);
  check('marks carry palette classes, never literal colours', !/fill="#|stroke="#/.test(all));

  suite('what the sheet says');

  const overview = sheet.renderSheet(r, 'overview');
  check('the headline cost is the reported one', overview.indexOf('$0.55') > 0);
  check('the status is spelled out, not just coloured', overview.indexOf('Working') > 0);
  check('a context window three quarters full is flagged amber', /class="level-warn"/.test(overview));
  check('a context window at the ceiling is flagged red',
    /class="level-critical"/.test(sheet.renderSheet(report({ contextTokens: 195000 }), 'overview')));
  check('the runway is spelled out', /before compaction/.test(overview));

  const tools = sheet.renderSheet(r, 'tools');
  check('a touched file offers to open itself', tools.indexOf('data-action="open:/repo/src/session.js"') > 0);
  const fleet = sheet.renderSheet(r, 'fleet');
  check('a fleet row offers to switch to it', fleet.indexOf('data-action="switch:nik-a"') > 0);
  check('the fleet leads with what the window costs', /Everything running in this window/.test(fleet));
  check('it breaks the instances down by state', /What the fleet is doing/.test(fleet));
  check('it compares their token mix', /Tokens by instance/.test(fleet));
  check('it shows how full each context is', /Context pressure/.test(fleet));
  check('it groups them by project', /By project/.test(fleet));
  check('it lists every instance in detail', /Every instance/.test(fleet));
  check('and names the records across the window', /Across the fleet/.test(fleet));
  check('a wide table can scroll instead of crushing its columns', /class="grid-scroll"/.test(fleet));

  suite('what is left of the plan');

  const now = Date.now();
  const metered = report({
    limits: {
      status: 'allowed_warning', type: 'five_hour', used: 0.86, resetsAt: now + 3600000,
      windows: {
        fiveHour: { used: 0.86, resetsAt: now + 3600000 },
        week: { used: 0.4, resetsAt: now + 200000000 },
        weekOverage: null
      },
      at: now
    }
  });
  const meteredFleet = sheet.renderSheet(metered, 'fleet');
  check('the fleet shows the plan', /Plan usage/.test(meteredFleet));
  check('the five-hour window by name', /Five-hour session/.test(meteredFleet));
  check('and the weekly one', /This week/.test(meteredFleet));
  check('it says what is left, not just what is gone', /14% left/.test(meteredFleet));
  check('and when it comes back', /resets in/.test(meteredFleet));
  check('a window under pressure is flagged amber', /level-warn/.test(meteredFleet));
  check('the instance page shows it too', /Plan usage/.test(sheet.renderSheet(metered, 'overview')));
  check('and the copyable summary', /5h 14% left, weekly 60% left/.test(sheet.asText(metered)));

  const unknown = sheet.renderSheet(report({ limits: null }), 'fleet');
  check('before anything is reported it says so', /Nothing reported yet/.test(unknown));
  check('rather than claiming a full tank', !/100% left/.test(unknown));

  suite('counts that only cover a window say so');

  const trimmed = report({ droppedItems: 312, maxItems: 400 });
  const trimmedTools = sheet.renderSheet(trimmed, 'tools');
  check('the tool card stops claiming a total', /in the last \d/.test(trimmedTools));
  check('and the page explains what was dropped', /were dropped to keep the panel light/.test(trimmedTools));
  check('the system tab shows the window', /In memory/.test(sheet.renderSheet(trimmed, 'system')));
  check('a conversation that fits still reads as a total', / in total/.test(sheet.renderSheet(r, 'tools')));

  suite('an instance restored from the last window');

  // How it left off and whether anything is running are two different facts,
  // and the sheet says both rather than letting one hide the other.
  const sleeping = report({ isAsleep: true, isRunning: false, status: 'done', isBusy: false });
  const sleepingOverview = sheet.renderSheet(sleeping, 'overview');
  check('it still says how the conversation left off', /Done/.test(sleepingOverview));
  check('and that nothing is running behind it', /opens where it left off/.test(sleepingOverview));
  check('the dot is that state, hollow', /sdot done asleep/.test(sleepingOverview));
  check('the system tab says what wakes it',
    /starts when you open it/.test(sheet.renderSheet(sleeping, 'system')));
  check('the fleet row agrees', /sdot done asleep/.test(sheet.renderSheet(sleeping, 'fleet')));
  check('the plain-text summary agrees too', /Status    done · asleep/.test(sheet.asText(sleeping)));

  suite('hostile input');

  const nasty = report({ label: '<img src=x onerror=alert(1)>', cwd: '/tmp/"><script>' });
  const nastyHtml = sheet.SECTIONS.map((s) => sheet.renderSheet(nasty, s.id)).join('');
  check('a label cannot inject markup', !/<img src=x/.test(nastyHtml));
  check('a path cannot break out of an attribute', !/<script>/.test(nastyHtml));

  suite('a brand new instance');

  const empty = report({
    turnLog: [], items: [], turns: 0, totalCost: 0, contextTokens: 0, contextWindow: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  });
  const emptyHtml = sheet.SECTIONS.map((s) => sheet.renderSheet(empty, s.id)).join('');
  check('an empty instance still renders every section', emptyHtml.length > 3000);
  check('no NaN leaks into the page', !/NaN|undefined|Infinity/.test(emptyHtml));
  check('the charts fall back to an empty track', /chart-empty/.test(emptyHtml));

  suite('formatting');

  checkEqual('tokens read as counts', [0, 999, 1500, 25000, 1250000].map(sheet.fmt.tokens),
    ['0', '999', '1.5k', '25k', '1.25M']);
  checkEqual('money keeps small amounts visible', [0, 0.0004, 0.42, 128].map(sheet.fmt.money),
    ['$0.00', '$0.0004', '$0.42', '$128']);
  checkEqual('durations read as time', [400, 9500, 65000, 3700000].map(sheet.fmt.ms),
    ['400ms', '9.5s', '1m 05s', '1h 01m']);
  checkEqual('bytes read as sizes', [900, 2048, 5242880].map(sheet.fmt.bytes), ['900 B', '2 KB', '5.0 MB']);

  suite('the copyable summary');

  const text = sheet.asText(r);
  check('it names the instance', /NikUI status — 1327/.test(text));
  check('it carries the cost', /\$0\.55/.test(text));
  check('it carries the token split', /cache read 80,000/.test(text));
  check('it is plain text', !/[<>]/.test(text.replace(/—/g, '')));

  suite('charts');

  checkEqual('an empty series still draws a track',
    /chart-empty/.test(charts.columns([], {})), true);
  check('a single point does not crash the area chart', charts.area([{ value: 1 }], {}).indexOf('<svg') === 0);
  check('bars are rounded at the data end only', /q0 -/.test(charts.columns([{ value: 5 }, { value: 1 }], {})));
  check('a tooltip is escaped into the mark',
    charts.columns([{ value: 1 }], { tip: () => '"><b>' }).indexOf('&quot;&gt;&lt;b&gt;') > 0);
  check('the meter turns critical at the top of the window', /level-critical/.test(charts.meter(0.95)));
  check('the meter is calm below the thresholds', /level-ok/.test(charts.meter(0.2)));
  check('a heat cell reports its own value', /data-tip="12:00 · 3 turns"/.test(charts.heat([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3])));
};
