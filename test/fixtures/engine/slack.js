'use strict';

const { createSlack, USER_TOKEN, APP_TOKEN, SESSION_TOKEN, SESSION_COOKIE } = require('../../../src/slackRuntime');
const { SlackService } = require('../../../src/slack/service');
const { settings, Secrets, clock, deferred, tick } = require('./fakes');

module.exports = async function () {
  const runtimes = [];
  function fixture(initial = {}, extra = {}) {
    const secrets = new Secrets(initial), source = settings({ 'slack.enabled': true, 'slack.mentions': false });
    const timers = clock(), services = [], sockets = [], apis = [], calls = [], audit = [], announcements = [], logs = [];
    let broadcasts = 0;
    const runtime = createSlack({ secrets, settings: source,
      onDidChangeConfiguration: (fn) => source.onDidChangeConfiguration(fn),
      log: (line) => logs.push(line), devices: { record: (entry) => audit.push(entry) },
      notifier: { announce: async (...args) => announcements.push(args) },
      onState: () => broadcasts++,
      createApi: (credentials) => {
        apis.push(credentials);
        return { call: async (method, params) => {
          calls.push({ token: credentials.token, method, params });
          if (credentials.token === 'xoxc-rejected' || credentials.token === 'xoxp-rejected') throw Object.assign(new Error('rejected'), { code: 'invalid_auth' });
          if (method === 'auth.test') return { user_id: 'UME', user: 'fixture', team_id: 'T1' };
          if (method === 'chat.postMessage') return { ts: '42.000007' };
          if (method === 'conversations.history') return { messages: [{ user: 'UME', ts: '43.000001', text: 'newer message' }] };
          return { ok: true, channels: [], groups: [], ims: [], mpims: [], messages: [], prefs: {} };
        } };
      },
      createSocket: (opts) => {
        const socket = { opts, starts: 0, stops: 0, start() { this.starts++; }, stop() { this.stops++; } };
        sockets.push(socket); return socket;
      },
      createService: (opts) => {
        const service = new SlackService(Object.assign({}, opts, { now: timers.now,
          setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }));
        service.starts = 0; service.stops = 0;
        const start = service.start, stop = service.stop;
        service.start = function () { this.starts++; return start.call(this); };
        service.stop = function () { this.stops++; return stop.call(this); };
        services.push(service); return service;
      }, ...extra
    });
    runtimes.push(runtime);
    return { runtime, secrets, source, timers, services, sockets, apis, calls, audit, announcements, logs,
      broadcasts: () => broadcasts };
  }
  try {
    suite('T04/T41/T47: Slack service composition preserves SecretStorage and auth modes');
    const f = fixture({ [USER_TOKEN]: 'xoxp-initial', [APP_TOKEN]: 'xapp-initial' });
    const { runtime, secrets, source } = f;
    checkEqual('construction is inert and owns no listeners yet', [f.services.length, secrets.listeners.size, source.listeners.size], [0, 0, 0]);
    const firstStart = runtime.start();
    check('repeated start shares its original work', runtime.start() === firstStart);
    await firstStart; await tick();
    const first = runtime.service;
    checkEqual('one owner starts one service and socket', [f.services.length, first.starts, f.sockets[0].starts], [1, 1, 1]);
    checkEqual('listeners are installed once with the native disposable event shape', [secrets.listeners.size, source.listeners.size], [1, 1]);
    checkEqual('app credentials reach only the injected API', f.apis[0], { token: 'xoxp-initial', appToken: 'xapp-initial', cookie: undefined });
    checkEqual('state preserves app sign-in mode', [runtime.room.stateFor({ local: true }).hasTokens,
      runtime.room.stateFor({ local: true }).authMode, runtime.room.stateFor({ local: true }).mayReply], [true, 'app', true]);
    secrets.changed('an.unrelated.secret'); await runtime.ready;
    checkEqual('unrelated secrets cannot replace Slack', f.services.length, 1);
    const local = [], phone = [];
    runtime.room.join('local', { local: true }, (message) => local.push(message));
    runtime.room.join('phone', { local: false, control: false, device: { name: 'fixture' } }, (message) => phone.push(message));
    const denied = await runtime.room.handle('phone', { type: 'slack:reply', id: 'no', conversation: 'D1', text: 'no' });
    check('a watch-only seat still cannot send', !denied && phone.some((m) => m.type === 'slack:sent' && !m.ok)
      && !f.calls.some((call) => call.method === 'chat.postMessage'));
    const posted = await runtime.room.handle('local', { type: 'slack:reply', id: 'reply', conversation: 'D1', text: 'fixture reply', thread: '40.000002' });
    checkEqual('the headless handler exposes the exact posted reply timestamp', posted, { ts: '42.000007' });
    checkEqual('the existing reply event adds that provider timestamp', local.find((m) => m.type === 'slack:sent').ts, '42.000007');
    checkEqual('posting preserves the thread and text', f.calls.find((call) => call.method === 'chat.postMessage').params,
      { channel: 'D1', text: 'fixture reply', thread_ts: '40.000002' });
    checkEqual('mark-read may advance without replacing the posted timestamp', f.calls.find((call) => call.method === 'conversations.mark').params,
      { channel: 'D1', ts: '43.000001' });
    runtime.room.join('controller', { local: false, control: true, device: { name: 'fixture' } }, () => {});
    await runtime.room.handle('controller', { type: 'slack:reply', id: 'allowed', conversation: 'D1', text: 'allowed' });
    check('the audit still records allowed and denied paired reply attempts', f.audit.some((row) => row.allowed === false) && f.audit.some((row) => row.allowed === true));
    runtime.room.leave('local');
    checkEqual('closing a viewer does not stop the service', first.stops, 0);
    await secrets.store(USER_TOKEN, 'xoxp-replacement'); await runtime.ready; await tick();
    checkEqual('credential replacement starts one successor and stops the old socket once',
      [f.services.length, first.stops, f.sockets[0].stops, runtime.service.starts], [2, 1, 1, 1]);
    checkEqual('retired services retain no owner listeners', ['state', 'popup', 'alarm'].map((event) => first.listenerCount(event)), [0, 0, 0]);
    checkEqual('replacement keeps exactly one credential subscription', secrets.listeners.size, 1);
    const second = runtime.service;
    const beforeClock = f.broadcasts();
    await source.update('clock', '12h'); await runtime.ready;
    check('a clock change broadcasts fresh state without restarting Slack', f.broadcasts() > beforeClock && second.starts === 1);
    await source.update('slack.popupAfterMinutes', 2); await runtime.ready;
    checkEqual('other Slack configuration preserves the service and applies minutes',
      [runtime.service === second, second.cfg.popupAfterMs, second.starts, second.stops], [true, 120000, 2, 1]);
    const oldCount = f.services.length;
    const session = await runtime.keepSession({ token: '"xoxc-session"', cookie: 'd=xoxd-fixture; Path=/' });
    await tick();
    check('session sign-in validates before keeping credentials', session.ok && session.who.user_id === 'UME');
    checkEqual('one credential transaction produces one replacement', f.services.length - oldCount, 1);
    checkEqual('session credentials replace the app pair', [...secrets.values.entries()].sort(),
      [[SESSION_COOKIE, 'xoxd-fixture'], [SESSION_TOKEN, 'xoxc-session']].sort());
    checkEqual('session mode uses its cookie and polling', [runtime.room.stateFor({ local: true }).authMode,
      f.apis[f.apis.length - 1].cookie, runtime.service.createSocket], ['session', 'xoxd-fixture', null]);
    const sessionService = runtime.service;
    const rejected = await runtime.keepSession({ token: 'xoxc-rejected', cookie: 'xoxd-fixture' });
    check('a rejected session keeps the running service and old credentials', !rejected.ok && /did not accept/.test(rejected.message)
      && runtime.service === sessionService && secrets.values.get(SESSION_TOKEN) === 'xoxc-session');
    check('malformed session values are rejected before calling Slack', !(await runtime.keepSession({ token: 'bad', cookie: 'bad' })).ok);
    const app = await runtime.keepApp({ userToken: 'xoxp-poll', appToken: '' });
    check('app sign-in can still poll without an app token', app.ok && runtime.service.createSocket === null);
    checkEqual('returning to app mode removes the session pair', [...secrets.values.entries()], [[USER_TOKEN, 'xoxp-poll']]);
    const pollService = runtime.service;
    const failedApp = await runtime.keepApp({ userToken: 'xoxp-rejected', appToken: '' });
    check('a rejected app token does not replace its predecessor', !failedApp.ok && runtime.service === pollService);
    await runtime.clearCredentials(); await tick();
    checkEqual('disconnect clears both auth modes and stops the service once', [secrets.values.size, runtime.service,
      pollService.stops, runtime.room.stateFor({ local: true }).hasTokens], [0, null, 1, false]);
    runtime.dispose(); runtime.dispose();
    checkEqual('shutdown disposes credential and config subscriptions once', [secrets.disposals, secrets.listeners.size, source.listeners.size], [1, 0, 0]);
    checkEqual('shutdown does not stop already replaced services again', [first.stops, sessionService.stops, pollService.stops], [1, 1, 1]);
    checkEqual('shutdown retires all owned timers', f.timers.tasks.size, 0);
    check('neither state, logs nor audit retain credentials', !/xox[pacd]-/.test(JSON.stringify({ state: runtime.room.stateFor({ local: true }), logs: f.logs, audit: f.audit })));

    suite('T04: disabled/incomplete credentials and configuration preserve window semantics');
    const disabled = fixture({ [USER_TOKEN]: 'xoxp-disabled' });
    disabled.source.values['slack.enabled'] = false;
    await disabled.runtime.start();
    checkEqual('disabled Slack reports credentials without starting a service', [disabled.services.length,
      disabled.runtime.room.stateFor({}).hasTokens], [0, true]);
    await disabled.source.update('slack.enabled', true); await disabled.runtime.ready;
    checkEqual('enabling starts once', [disabled.services.length, disabled.runtime.service.starts], [1, 1]);
    const enabled = disabled.runtime.service;
    await disabled.source.update('slack.enabled', false); await disabled.runtime.ready;
    checkEqual('disabling stops once', [enabled.stops, disabled.runtime.service], [1, null]);
    const incomplete = fixture({ [SESSION_TOKEN]: 'xoxc-incomplete' });
    await incomplete.runtime.start();
    checkEqual('a session without its cookie cannot start or claim credentials', [incomplete.services.length,
      incomplete.runtime.room.stateFor({}).hasTokens], [0, false]);
    incomplete.runtime.dispose(); incomplete.runtime.dispose();
    await incomplete.secrets.store(SESSION_COOKIE, 'xoxd-late'); await incomplete.runtime.start();
    checkEqual('events and start after shutdown cannot resurrect the service', incomplete.services.length, 0);

    suite('T04/T41: overlapping credential reads and start/dispose races');
    const gate = deferred();
    const stale = fixture({ [USER_TOKEN]: 'xoxp-old' });
    const read = stale.secrets.get;
    let firstRead = true;
    stale.secrets.get = async function (key) {
      const value = await read.call(this, key);
      if (firstRead) { firstRead = false; await gate.promise; }
      return value;
    };
    stale.runtime.start(); await tick();
    await stale.secrets.store(USER_TOKEN, 'xoxp-new');
    gate.resolve(); await stale.runtime.ready;
    checkEqual('a stale credential read never constructs a service', stale.apis.map((api) => api.token), ['xoxp-new']);
    checkEqual('overlapping rebuilds still start only one service', stale.services.map((service) => service.starts), [1]);
    const disposeGate = deferred(), gone = fixture({ [USER_TOKEN]: 'xoxp-gone' });
    gone.secrets.get = () => disposeGate.promise;
    gone.runtime.start(); await tick(); gone.runtime.dispose(); disposeGate.resolve('xoxp-gone');
    await gone.runtime.ready;
    checkEqual('disposal during a secret read prevents construction', [gone.services.length, gone.secrets.disposals], [0, 1]);
    const signIn = deferred(), stopped = fixture({ [USER_TOKEN]: 'xoxp-stopped' }, {
      createApi: () => ({ call: () => signIn.promise })
    });
    stopped.runtime.start(); await tick();
    const stoppedService = stopped.runtime.service;
    stopped.runtime.dispose(); signIn.resolve({ user_id: 'UME' }); await stopped.runtime.ready; await tick();
    checkEqual('disposal during service.start prevents a late socket/timer', [stoppedService.starts, stoppedService.stops,
      stopped.sockets.length, stopped.timers.tasks.size], [1, 1, 0, 0]);
    const locked = fixture({ [USER_TOKEN]: 'xoxp-locked' });
    locked.secrets.get = async () => { throw new Error('fixture store locked'); };
    await locked.runtime.start();
    checkEqual('a locked store cannot fall through to API/network or construction', [locked.apis.length, locked.services.length], [0, 0]);
    check('a store failure is diagnosable', locked.logs.some((line) => /store locked/.test(line)));
    const concurrent = fixture();
    await concurrent.runtime.start();
    await Promise.all([concurrent.runtime.keepSession({ token: 'xoxc-concurrent', cookie: 'xoxd-concurrent' }),
      concurrent.runtime.keepApp({ userToken: 'xoxp-concurrent', appToken: '' })]);
    checkEqual('concurrent validated sign-ins serialize complete credential pairs', [...concurrent.secrets.values.entries()],
      [[USER_TOKEN, 'xoxp-concurrent']]);
    checkEqual('the final service belongs to the complete final sign-in', [concurrent.runtime.room.stateFor({}).authMode,
      concurrent.apis.at(-1).token], ['app', 'xoxp-concurrent']);

    suite('T02: two Slack owners interleave without cross-disposal or credentials');
    const left = fixture({ [USER_TOKEN]: 'xoxp-left' }), right = fixture({ [USER_TOKEN]: 'xoxp-right' });
    await Promise.all([left.runtime.start(), right.runtime.start()]);
    left.runtime.dispose();
    await right.secrets.store(USER_TOKEN, 'xoxp-right-new'); await right.runtime.ready;
    checkEqual('disposing one owner leaves the other subscribed and replaceable', [left.services[0].stops,
      right.services.length, right.services[0].stops, right.runtime.service.starts, right.secrets.listeners.size], [1, 2, 1, 1, 1]);
    checkEqual('the surviving API uses only its own credential source', right.apis.map((api) => api.token), ['xoxp-right', 'xoxp-right-new']);
  } finally { for (const runtime of runtimes.reverse()) runtime.dispose(); }
};
