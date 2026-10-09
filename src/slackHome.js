'use strict';

const vscode = require('vscode');
const { SlackRoom } = require('./slackRoom');
const { SlackPanel } = require('./slackPanel');

/**
 * Slack, in this window: the tokens, the service watching it, the tab showing
 * it, and what happens when a VIP has waited too long.
 *
 * The tokens live in VS Code's secret storage — the system keychain — and
 * nowhere else: not in settings, not in the audit trail, never down a socket.
 */
const USER_TOKEN = 'nikui.slack.userToken';
const APP_TOKEN = 'nikui.slack.appToken';
// The other way in, for a workspace that will not have the app: the session
// Slack's own clients run on. One of the two pairs is kept, never both.
const SESSION_TOKEN = 'nikui.slack.sessionToken';
const SESSION_COOKIE = 'nikui.slack.sessionCookie';
const ALL_KEYS = [USER_TOKEN, APP_TOKEN, SESSION_TOKEN, SESSION_COOKIE];

const cfg = () => vscode.workspace.getConfiguration('nikui');
const minutes = (key, fallback) => {
  const n = Number(cfg().get(key, fallback));
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60000;
};

/**
 * @param {object} context
 * @param {object} deps
 * @param {object} [deps.notifier]   tells the phone
 * @param {object} [deps.devices]    for the audit trail
 * @param {(line: string) => void} [deps.log]
 */
function startSlack(context, deps) {
  const log = deps.log || (() => {});
  let service = null;
  let hasTokens = false;
  let authMode = null; // 'app' | 'session'
  let stopped = false;

  const settings = () => ({
    enabled: cfg().get('slack.enabled', false),
    hasTokens,
    authMode,
    vipList: cfg().get('slack.vips', []) || [],
    clock: cfg().get('clock', '24h')
  });

  const { write } = require('./settingsMenu');
  const room = new SlackRoom({
    service: () => service,
    settings,
    setVips: (list) => write('nikui.slack.vips', list),
    setEnabled: (on) => write('nikui.slack.enabled', !!on),
    connect: () => vscode.commands.executeCommand('nikui.slack.connect'),
    connectWith: (how) => keepSession(context, how).then((r) => { if (r && r.ok) rebuild(); return r; }),
    disconnect: () => vscode.commands.executeCommand('nikui.slack.disconnect'),
    openSettings: () => vscode.commands.executeCommand('workbench.action.openSettings', 'nikui.slack'),
    openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    audit: deps.devices ? (entry) => deps.devices.record(entry) : undefined,
    log
  });

  // A count in the status bar while somebody is waiting, and nothing at all
  // otherwise: a permanent Slack icon would be one more thing to stop seeing.
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  bar.command = 'nikui.slack.open';
  context.subscriptions.push(bar);
  const paintBar = () => {
    const now = service ? service.state() : null;
    const waiting = now ? (now.conversations || []).filter((c) => c.pending) : [];
    if (!waiting.length) return void bar.hide();
    const names = waiting.map((c) => c.title).slice(0, 3).join(', ');
    bar.text = `$(comment-discussion) ${waiting.length}`;
    bar.tooltip = `Waiting on you in Slack: ${names}`;
    bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    bar.show();
  };

  const config = () => ({
    enabled: cfg().get('slack.enabled', false),
    vips: cfg().get('slack.vips', []) || [],
    mentions: cfg().get('slack.mentions', true),
    popupAfterMs: minutes('slack.popupAfterMinutes', 1),
    alarmAfterMs: minutes('slack.alarmAfterMinutes', 3)
  });

  const open = (how) => SlackPanel.show(context, room, how);

  const onPopup = ({ conversation, message }) => {
    if (!cfg().get('slack.popupOnLaptop', true) || !conversation) return;
    open({ quietly: true, conversation: conversation.id });
    const who = conversation.title || 'Somebody';
    const said = message && message.text ? ': ' + clip(message.text, 90) : '';
    vscode.window.showInformationMessage(`Slack · ${who}${said}`, 'Reply').then((pick) => {
      if (pick) open({ conversation: conversation.id });
    });
  };

  const onAlarm = ({ conversation, message, title }) => {
    if (!cfg().get('slack.alarmOnPhone', true) || !deps.notifier || !conversation) return;
    const preview = cfg().get('slack.previewOnPhone', true) && message && message.text;
    deps.notifier.announce('slack', {
      title: title || `${conversation.title || 'Somebody'} is waiting on you in Slack`,
      body: preview ? clip(message.text, 280) : 'Open NikUI to read it.',
      tag: 'slack:' + conversation.id,
      conversation: conversation.id,
      alarm: true
    }).catch((err) => log(`slack: could not ring the phone: ${err && err.message}`));
  };

  async function build() {
    if (service) { try { service.stop(); } catch (_) { /* already */ } service = null; }
    const secrets = context.secrets;
    const userToken = secrets ? await secrets.get(USER_TOKEN) : null;
    const sessionToken = secrets && !userToken ? await secrets.get(SESSION_TOKEN) : null;
    const cookie = sessionToken ? await secrets.get(SESSION_COOKIE) : null;
    const token = userToken || (sessionToken && cookie ? sessionToken : null);
    const appToken = userToken && secrets ? await secrets.get(APP_TOKEN) : null;
    hasTokens = !!token;
    authMode = userToken ? 'app' : token ? 'session' : null;
    if (stopped || !token || !cfg().get('slack.enabled', false)) {
      paintBar();
      return void room.broadcast();
    }
    const { createApi } = require('./slack/api');
    const { createSocket } = require('./slack/socket');
    const { SlackService } = require('./slack/service');
    const api = createApi({ token, appToken, cookie: authMode === 'session' ? cookie : undefined });
    service = new SlackService({
      api,
      createSocket: appToken ? (opts) => createSocket(Object.assign({ api }, opts)) : null,
      config,
      log: (line) => log('slack: ' + line)
    });
    service.on('state', () => { room.broadcast(); paintBar(); });
    service.on('popup', onPopup);
    service.on('alarm', onAlarm);
    try { await service.start(); }
    catch (err) { log(`slack: could not start: ${err && err.message}`); }
    room.broadcast();
    paintBar();
  }

  const rebuild = () => build().catch((err) => log(`slack: ${err && err.message}`));

  context.subscriptions.push(
    vscode.commands.registerCommand('nikui.slack.open', () => open({})),
    vscode.commands.registerCommand('nikui.slack.connect', () => connect(context).then((ok) => { if (ok) rebuild(); })),
    vscode.commands.registerCommand('nikui.slack.signIn', () => connectSession(context).then((r) => { if (r && r.ok) rebuild(); })),
    vscode.commands.registerCommand('nikui.slack.disconnect', async () => {
      for (const key of ALL_KEYS) await context.secrets.delete(key);
      rebuild();
      vscode.window.setStatusBarMessage('NikUI: Slack disconnected', 3000);
    })
  );
  if (context.secrets && context.secrets.onDidChange) {
    context.subscriptions.push(context.secrets.onDidChange((e) => {
      if (ALL_KEYS.includes(e.key)) rebuild();
    }));
  }
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('nikui.slack') && !event.affectsConfiguration('nikui.clock')) return;
    if (event.affectsConfiguration('nikui.slack.enabled')) return void rebuild();
    if (service && service.restart && event.affectsConfiguration('nikui.slack')) {
      Promise.resolve(service.restart()).catch(() => {});
    }
    room.broadcast();
  }));
  context.subscriptions.push({ dispose: () => { stopped = true; if (service) service.stop(); } });

  rebuild();
  return { room, open };
}

/**
 * Ask for the two tokens, check them with Slack, and keep them.
 *
 * Checked before they are kept, so a token pasted with a missing character is
 * said to be wrong here, while it is still in your clipboard.
 */
async function connect(context) {
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

  let who;
  try {
    const { createApi } = require('./slack/api');
    who = await createApi({ token: user.trim() }).call('auth.test', {});
  } catch (err) {
    const { sayError } = require('./slackRoom');
    vscode.window.showErrorMessage('Slack did not accept that token: ' + sayError(err));
    return false;
  }
  await context.secrets.store(USER_TOKEN, user.trim());
  if (app.trim()) await context.secrets.store(APP_TOKEN, app.trim());
  else await context.secrets.delete(APP_TOKEN);
  const { write } = require('./settingsMenu');
  await write('nikui.slack.enabled', true);
  const vips = cfg().get('slack.vips', []) || [];
  vscode.window.showInformationMessage(
    `Slack connected as ${(who && who.user) || 'you'}${who && who.team ? ' in ' + who.team : ''}.` +
    (vips.length ? '' : ' Add your VIPs next.'),
    vips.length ? 'Open Slack' : 'Add VIPs'
  ).then((pick) => { if (pick) vscode.commands.executeCommand('nikui.slack.open'); });
  return true;
}

/**
 * The easy way in, and the one the setup page leads with: the session Slack's
 * own web client already holds. No app to create, nothing for an admin to
 * approve — the two values a browser keeps, pasted once.
 *
 * Checked against Slack before they are kept, so a value pasted short a
 * character is caught here while it is still on your clipboard. Keeping these
 * clears any app token, since only one way in is live at a time.
 *
 * @param {object} context
 * @param {{token: string, cookie: string}} how
 * @returns {Promise<{ok: boolean, message?: string, who?: object}>}
 */
async function keepSession(context, how) {
  const { createApi, cleanSession } = require('./slack/api');
  const cleaned = cleanSession(how && how.token, how && how.cookie);
  if (cleaned.error) return { ok: false, message: cleaned.error };
  let who;
  try {
    who = await createApi({ token: cleaned.token, cookie: cleaned.cookie }).call('auth.test', {});
  } catch (err) {
    const { sayError } = require('./slackRoom');
    return { ok: false, message: 'Slack did not accept that session: ' + sayError(err) };
  }
  const secrets = context.secrets;
  await secrets.store(SESSION_TOKEN, cleaned.token);
  await secrets.store(SESSION_COOKIE, cleaned.cookie);
  await secrets.delete(USER_TOKEN);
  await secrets.delete(APP_TOKEN);
  const { write } = require('./settingsMenu');
  await write('nikui.slack.enabled', true);
  return { ok: true, who };
}

/**
 * The session sign-in as a command, for the laptop: two masked boxes, the same
 * values the Slack page in a browser holds, the same keychain the app tokens
 * would use. Each is checked for shape before the next is asked.
 */
async function connectSession(context) {
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

  const result = await keepSession(context, { token, cookie });
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
