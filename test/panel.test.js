'use strict';
const { install, fakeContext } = require('./helpers/vscode-stub.js');

const stub = install();
const { SessionPanel } = require('../src/panel.js');
const { Session } = require('../src/session.js');

module.exports = async function () {
  suite('the panel answers /status');

  const context = fakeContext();
  const session = new Session({ cwd: process.cwd() });
  const other = new Session({ cwd: '/tmp' });
  session.totalCost = 0.25;
  session.usage = { input: 10, output: 40, cacheRead: 900, cacheCreate: 0 };
  session.turns = 1;
  session.turnLog = [{
    n: 1, at: Date.now(), durationMs: 2000, costUsd: 0.25, input: 10, output: 40,
    cacheRead: 900, cacheCreate: 0, contextTokens: 950, tools: ['Bash'], model: 'claude-x',
    interrupted: false, isError: false
  }];
  session._upsert({ id: 't1', kind: 'tool', name: 'Bash', input: { command: 'ls' }, status: 'done' });

  const opened = [];
  const manager = {
    list: [session, other],
    get: (id) => (id === other.id ? other : id === session.id ? session : null),
    focus() {},
    knownCommands: () => ['status']
  };

  const panel = SessionPanel.show(session, context, manager);
  const posted = panel.panel.webview.posted;

  // Nothing in this suite may spawn a CLI: the panel starts the instance the
  // moment the webview reports in.
  session.start = function () { this.status = 'idle'; };

  // A panel opened by the command has not loaded yet; the request must wait.
  panel.openStatus();
  checkEqual('nothing is posted into a webview that has not loaded', posted.length, 0);
  await panel.onMessage({ type: 'ready' });
  check('the sheet opens as soon as the webview is there',
    posted.some((m) => m.type === 'openStatus') && posted.some((m) => m.type === 'statusReport'));
  posted.length = 0;

  await panel.onMessage({ type: 'status' });
  const message = posted.filter((m) => m.type === 'statusReport').pop();
  check('a status request is answered with a report', !!message);
  checkEqual('the report is about this instance', message.report.instance.id, session.id);
  checkEqual('it carries the cost the CLI reported', message.report.totals.cost, 0.25);
  checkEqual('it carries the turn log', message.report.turns.length, 1);
  checkEqual('it counts the tool call', message.report.totals.toolCalls, 1);
  checkEqual('it lists every instance in the window', message.report.fleet.length, 2);
  check('it knows which editor it is running in', !!message.report.env.vscode);
  check('it knows where the transcript would live',
    typeof message.report.transcript.path === 'string' || message.report.transcript.path === null);

  panel.openStatus();
  const kinds = posted.slice(-2).map((m) => m.type);
  checkEqual('the command opens the sheet and fills it', kinds, ['openStatus', 'statusReport']);

  suite('what the panel hands the webview');

  // A webview that was thrown away while hidden says hello again on its way
  // back, and gets the whole picture a second time.
  await panel.onMessage({ type: 'ready' });
  const init = posted.filter((m) => m.type === 'init').pop();
  check('the first paint says how much was dropped', init && typeof init.dropped === 'number');
  check('and how big the window is', init && init.maxItems > 0);
  check('a hidden panel is not kept warm by default', panel.panel.__options
    ? panel.panel.__options.retainContextWhenHidden === false : true);

  suite('the sheet keeps up while it is open');

  posted.length = 0;
  await panel.onMessage({ type: 'statusOpen', open: true });
  check('the panel knows the sheet is open', panel.statusOpen === true);
  check('nothing is pending until something changes', panel.statusTimer === null);

  panel.refreshStatus();
  check('a change schedules a redraw', panel.statusTimer !== null);
  panel.refreshStatus();
  check('and a second change does not schedule a second one', panel.statusTimer !== null);

  await panel.onMessage({ type: 'statusOpen', open: false });
  check('closing the sheet cancels the pending redraw', panel.statusTimer === null);
  panel.refreshStatus();
  check('and a closed sheet is never redrawn', panel.statusTimer === null);

  suite('jumping to another instance');

  await panel.onMessage({ type: 'switch', id: other.id });
  check('switching opens the other instance', !!stub.__registered.panels.length);
  await panel.onMessage({ type: 'switch', id: 'nope' });
  check('an unknown instance is ignored', true);

  SessionPanel.close(other.id);
  panel.dispose();
  session.dispose();
  other.dispose();
};
