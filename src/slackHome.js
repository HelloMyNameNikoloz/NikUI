'use strict';

// The window facade owns chrome and masked input. Service composition,
// credentials and their listeners belong to the injected Slack runtime.
const vscode = require('vscode');
const { SlackPanel } = require('./slackPanel');
const { createSlack, USER_TOKEN, APP_TOKEN, SESSION_TOKEN, SESSION_COOKIE } = require('./slackRuntime');
const cfg = () => vscode.workspace.getConfiguration('nikui');

function startSlack(context, deps = {}) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  bar.command = 'nikui.slack.open';
  const open = (how) => SlackPanel.show(context, runtime.room, how);
  const runtime = createSlack({
    secrets: context.secrets, settings: cfg,
    writeSetting: (key, value) => require('./settingsMenu').write(key, value),
    onDidChangeConfiguration: vscode.workspace.onDidChangeConfiguration
      ? (fn) => vscode.workspace.onDidChangeConfiguration(fn) : undefined,
    notifier: deps.notifier, devices: deps.devices, openTicket: deps.openTicket, log: deps.log,
    connect: () => vscode.commands.executeCommand('nikui.slack.connect'),
    disconnect: () => vscode.commands.executeCommand('nikui.slack.disconnect'),
    openSettings: () => vscode.commands.executeCommand('workbench.action.openSettings', 'nikui.slack'),
    openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    onState: (state) => {
      const waiting = state ? (state.conversations || []).filter((c) => c.pending) : [];
      if (!waiting.length) return void bar.hide();
      const names = waiting.map((c) => c.title).slice(0, 3).join(', ');
      bar.text = `$(comment-discussion) ${waiting.length}`;
      bar.tooltip = `Waiting on you in Slack: ${names}`;
      bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      bar.show();
    },
    onPopup: ({ conversation, message }) => {
      if (!cfg().get('slack.popupOnLaptop', true) || !conversation) return;
      open({ quietly: true, conversation: conversation.id });
      const who = conversation.title || 'Somebody';
      const said = message && message.text ? ': ' + clip(message.text, 90) : '';
      vscode.window.showInformationMessage(`Slack · ${who}${said}`, 'Reply').then((pick) => {
        if (pick) open({ conversation: conversation.id });
      });
    }
  });
  context.subscriptions.push(bar, runtime,
    vscode.commands.registerCommand('nikui.slack.open', () => open({})),
    vscode.commands.registerCommand('nikui.slack.connect', () => connect(runtime)),
    vscode.commands.registerCommand('nikui.slack.signIn', () => connectSession(runtime)),
    vscode.commands.registerCommand('nikui.slack.disconnect', async () => {
      await runtime.clearCredentials();
      vscode.window.setStatusBarMessage('NikUI: Slack disconnected', 3000);
    })
  );
  runtime.start();
  return { room: runtime.room, open };
}

/**
 * Ask for the two tokens, check them with Slack, and keep them.
 *
 * Checked before they are kept, so a token pasted with a missing character is
 * said to be wrong here, while it is still in your clipboard.
 */
async function connect(runtime) {
  const user = await vscode.window.showInputBox({
    title: 'Connect Slack (1 of 2)',
    prompt: 'The User OAuth Token from your Slack app’s “OAuth & Permissions” page, after “Install to Workspace”.',
    placeHolder: 'xoxp-…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (/^xoxp-[A-Za-z0-9-]+$/.test(String(v || '').trim()) ? null : 'A user token starts with xoxp-')
  });
  if (!user) return false;
  const app = await vscode.window.showInputBox({
    title: 'Connect Slack (2 of 2)',
    prompt: 'The App-Level Token (Basic Information → App-Level Tokens, with connections:write). Leave empty to check every 20 seconds instead of live.',
    placeHolder: 'xapp-… (optional)',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (!String(v || '').trim() || /^xapp-[A-Za-z0-9-]+$/.test(String(v).trim()) ? null : 'An app-level token starts with xapp-')
  });
  if (app === undefined) return false;

  const result = await runtime.keepApp({ userToken: user.trim(), appToken: app.trim() });
  if (!result.ok) {
    vscode.window.showErrorMessage(result.message);
    return false;
  }
  const who = result.who;
  const vips = cfg().get('slack.vips', []) || [];
  vscode.window.showInformationMessage(
    `Slack connected as ${(who && who.user) || 'you'}${who && who.team ? ' in ' + who.team : ''}.` +
    (vips.length ? '' : ' Add your VIPs next.'),
    vips.length ? 'Open Slack' : 'Add VIPs'
  ).then((pick) => { if (pick) vscode.commands.executeCommand('nikui.slack.open'); });
  return true;
}

/**
 * The session sign-in as a command, for the laptop: two masked boxes, the same
 * values the Slack page in a browser holds, the same keychain the app tokens
 * would use. Each is checked for shape before the next is asked.
 */
async function connectSession(runtime) {
  const token = await vscode.window.showInputBox({
    title: 'Sign in to Slack (1 of 2)',
    prompt: 'The session token from app.slack.com — DevTools → Console: JSON.parse(localStorage.localConfig_v2).teams[Object.keys(…)[0]].token',
    placeHolder: 'xoxc-…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (/^xoxc-[A-Za-z0-9-]+$/.test(String(v || '').trim().replace(/^['"`]+|['"`]+$/g, '')) ? null : 'A session token starts with xoxc-')
  });
  if (!token) return { ok: false };
  const cookie = await vscode.window.showInputBox({
    title: 'Sign in to Slack (2 of 2)',
    prompt: 'The value of the “d” cookie for app.slack.com — DevTools → Application → Cookies. Starts with xoxd-.',
    placeHolder: 'xoxd-…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (/^(d=)?xoxd-/.test(String(v || '').trim().replace(/^['"`]+|['"`]+$/g, '')) ? null : 'The d cookie starts with xoxd-')
  });
  if (!cookie) return { ok: false };

  const result = await runtime.keepSession({ token, cookie });
  if (!result.ok) {
    vscode.window.showErrorMessage(result.message || 'Slack did not accept that session.');
    return result;
  }
  const who = result.who;
  const vips = cfg().get('slack.vips', []) || [];
  vscode.window.showInformationMessage(
    `Slack connected as ${(who && who.user) || 'you'}${who && who.team ? ' in ' + who.team : ''}.` +
    (vips.length ? '' : ' Add your VIPs next.'),
    vips.length ? 'Open Slack' : 'Add VIPs'
  ).then((pick) => { if (pick) vscode.commands.executeCommand('nikui.slack.open'); });
  return result;
}

function clip(text, max) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

module.exports = { startSlack, USER_TOKEN, APP_TOKEN, SESSION_TOKEN, SESSION_COOKIE };
