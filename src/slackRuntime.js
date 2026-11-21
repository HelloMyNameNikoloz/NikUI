'use strict';

// Slack composition shared by the window and an injected headless owner.
// SecretStorage keeps its get/store/delete/onDidChange({key}) contract; no
// credential, configuration or service listener belongs to a viewer.
const { SlackRoom, sayError } = require('./slackRoom');
const { createApi: defaultApi, cleanSession } = require('./slack/api');
const { createSocket: defaultSocket } = require('./slack/socket');
const { SlackService } = require('./slack/service');

const USER_TOKEN = 'nikui.slack.userToken';
const APP_TOKEN = 'nikui.slack.appToken';
const SESSION_TOKEN = 'nikui.slack.sessionToken';
const SESSION_COOKIE = 'nikui.slack.sessionCookie';
const ALL_KEYS = [USER_TOKEN, APP_TOKEN, SESSION_TOKEN, SESSION_COOKIE];

function clip(text, max) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/**
 * settings is a get/inspect/update source or a fresh-source function.
 * writeSetting uses fully qualified keys. Configuration and secret events
 * return disposables, just like the extension APIs. The factory is inert
 * until start(); start and dispose are idempotent, rebuilds are serialized.
 * UI actions and popups are optional callbacks supplied by the window.
 */
function createSlack({ secrets, settings, writeSetting, onDidChangeConfiguration,
  createApi = defaultApi, createSocket = defaultSocket,
  createService = (opts) => new SlackService(opts), serviceOptions = {},
  notifier, devices, openTicket, connect, disconnect, openSettings, openUrl,
  onPopup, onState, log = () => {} } = {}) {
  if (!settings) throw new Error('Slack settings are required');
  const source = () => typeof settings === 'function' ? settings() : settings;
  const get = (key, fallback) => source().get(key, fallback);
  const write = (key, value) => writeSetting ? writeSetting('nikui.' + key, value) : source().update(key, value);
  const minutes = (key, fallback) => {
    const n = Number(get(key, fallback));
    return (Number.isFinite(n) && n > 0 ? n : fallback) * 60000;
  };
  const config = () => ({
    enabled: get('slack.enabled', false), vips: get('slack.vips', []) || [],
    muted: get('slack.muted', []) || [], mentions: get('slack.mentions', true),
    popupAfterMs: minutes('slack.popupAfterMinutes', 1),
    alarmAfterMs: minutes('slack.alarmAfterMinutes', 3)
  });
  let service = null, unlistenService = null;
  let hasTokens = false, authMode = null;
  let started = false, disposed = false, revision = 0, writing = 0;
  let work = Promise.resolve();
  let credentialWork = Promise.resolve();
  const subscriptions = [];
  let durableSeen = {};
  function restoreSeen(seen) {
    durableSeen = structuredClone(seen || {});
    if (service?._nikuiSeen) for (const [id, value] of Object.entries(durableSeen)) service._nikuiSeen.set(id, value.ts);
  }
  const room = new SlackRoom({
    service: () => service,
    settings: () => ({ enabled: get('slack.enabled', false), hasTokens, authMode,
      vipList: get('slack.vips', []) || [], mutedList: get('slack.muted', []) || [], clock: get('clock', '24h') }),
    setVips: (list) => write('slack.vips', list),
    setMuted: (list) => write('slack.muted', list),
    setEnabled: (on) => write('slack.enabled', !!on),
    connect, connectWith: (how) => keepSession(how), disconnect, openSettings, openUrl, openTicket,
    audit: devices ? (entry) => devices.record(entry) : undefined, log
  });
  function changed() {
    if (disposed) return;
    room.broadcast();
    if (onState) onState(service ? service.state() : null);
  }
  function retire() {
    const old = service;
    service = null;
    if (unlistenService) { unlistenService(); unlistenService = null; }
    if (old) { try { old.stop(); } catch (_) { /* already stopped */ } }
  }
  function alarm({ conversation, message, title }) {
    if (!get('slack.alarmOnPhone', true) || !notifier || !conversation) return;
    const preview = get('slack.previewOnPhone', true) && message && message.text;
    Promise.resolve(notifier.announce('slack', {
      title: title || `${conversation.title || 'Somebody'} is waiting on you in Slack`,
      body: preview ? clip(message.text, 280) : 'Open NikUI to read it.',
      tag: 'slack:' + conversation.id, conversation: conversation.id, alarm: true
    })).catch((err) => log(`slack: could not ring the phone: ${err && err.message}`));
  }
  function enqueue(fn) {
    work = work.then(fn).catch((err) => log(`slack: ${err && err.message}`));
    return work;
  }
  function rebuild() {
    if (disposed || !started || writing) return work;
    const version = ++revision;
    retire();
    return enqueue(async () => {
      if (disposed || version !== revision) return;
      // Keep calls bound to their store: SecretStorage implementations may use
      // `this`, and onDidChange is an event method, not an EventEmitter.
      const userToken = secrets ? await secrets.get(USER_TOKEN) : null;
      const sessionToken = secrets && !userToken ? await secrets.get(SESSION_TOKEN) : null;
      const cookie = sessionToken ? await secrets.get(SESSION_COOKIE) : null;
      const token = userToken || (sessionToken && cookie ? sessionToken : null);
      const appToken = userToken && secrets ? await secrets.get(APP_TOKEN) : null;
      if (disposed || version !== revision) return;
      hasTokens = !!token;
      authMode = userToken ? 'app' : token ? 'session' : null;
      if (!token || !get('slack.enabled', false)) return changed();
      const api = createApi({ token, appToken, cookie: authMode === 'session' ? cookie : undefined });
      const current = createService(Object.assign({}, serviceOptions, {
        api, createSocket: appToken ? (opts) => createSocket(Object.assign({ api }, opts)) : null,
        config, log: (line) => log('slack: ' + line)
      }));
      service = current;
      restoreSeen(durableSeen);
      const popup = (event) => { if (onPopup) onPopup(event); };
      current.on('state', changed);
      current.on('popup', popup);
      current.on('alarm', alarm);
      unlistenService = () => {
        current.removeListener('state', changed);
        current.removeListener('popup', popup);
        current.removeListener('alarm', alarm);
      };
      try { await current.start(); }
      catch (err) { log(`slack: could not start: ${err && err.message}`); }
      if (!disposed && version === revision) changed();
    });
  }
  function configurationChanged(event) {
    if (disposed || !event) return;
    if (!event.affectsConfiguration('nikui.slack') && !event.affectsConfiguration('nikui.clock')) return;
    if (event.affectsConfiguration('nikui.slack.enabled')) return rebuild();
    if (event.affectsConfiguration('nikui.slack')) {
      const current = service, version = revision;
      return enqueue(async () => {
        if (!disposed && current && current === service && version === revision && current.restart) await current.restart();
        changed();
      });
    }
    changed();
  }
  function start() {
    if (disposed || started) return work;
    started = true;
    if (secrets && secrets.onDidChange) subscriptions.push(secrets.onDidChange((event) => {
      if (ALL_KEYS.includes(event.key)) rebuild();
    }));
    if (onDidChangeConfiguration) subscriptions.push(onDidChangeConfiguration(configurationChanged));
    return rebuild();
  }
  function credentials(fn) {
    const result = credentialWork.then(async () => {
      if (disposed) throw new Error('Slack has been disposed');
      writing++;
      // Invalidate a read already in flight before changing any credentials.
      revision++;
      retire();
      try { return await fn(); }
      finally { if (!--writing) await rebuild(); }
    });
    credentialWork = result.catch(() => {});
    return result;
  }
  async function keepSession(how) {
    const cleaned = cleanSession(how && how.token, how && how.cookie);
    if (cleaned.error) return { ok: false, message: cleaned.error };
    let who;
    try { who = await createApi({ token: cleaned.token, cookie: cleaned.cookie }).call('auth.test', {}); }
    catch (err) { return { ok: false, message: 'Slack did not accept that session: ' + sayError(err) }; }
    await credentials(async () => {
      await secrets.store(SESSION_TOKEN, cleaned.token);
      await secrets.store(SESSION_COOKIE, cleaned.cookie);
      await secrets.delete(USER_TOKEN);
      await secrets.delete(APP_TOKEN);
      await write('slack.enabled', true);
    });
    return { ok: true, who };
  }
  async function keepApp({ userToken, appToken }) {
    let who;
    try { who = await createApi({ token: userToken }).call('auth.test', {}); }
    catch (err) { return { ok: false, message: 'Slack did not accept that token: ' + sayError(err) }; }
    await credentials(async () => {
      await secrets.store(USER_TOKEN, userToken);
      if (appToken) await secrets.store(APP_TOKEN, appToken);
      else await secrets.delete(APP_TOKEN);
      await secrets.delete(SESSION_TOKEN);
      await secrets.delete(SESSION_COOKIE);
      await write('slack.enabled', true);
    });
    return { ok: true, who };
  }
  async function clearCredentials() {
    await credentials(async () => { for (const key of ALL_KEYS) await secrets.delete(key); });
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    revision++;
    for (const sub of subscriptions.splice(0)) {
      try { if (sub) sub.dispose(); } catch (err) { log('slack: could not dispose listener: ' + (err && err.message)); }
    }
    retire();
    room.clients.clear();
  }
  return { room, start, rebuild, keepSession, keepApp, clearCredentials, dispose, restoreSeen,
    get ready() { return work; }, get service() { return service; } };
}

module.exports = { createSlack, USER_TOKEN, APP_TOKEN, SESSION_TOKEN, SESSION_COOKIE };
