'use strict';
const { SlackService } = require('../src/slack/service.js');

/** Records every call; answers from a handler keyed by method. */
function fakeApi(handlers) {
  const calls = [];
  return {
    calls,
    call: async (method, params, options) => {
      calls.push({ method, params, options });
      const h = handlers[method];
      if (h === undefined) throw Object.assign(new Error('no fake handler for ' + method), { code: 'test_gap' });
      const value = typeof h === 'function' ? h(params, options) : h;
      if (value instanceof Error) throw value;
      return value;
    }
  };
}

/** A clock that only moves when told to, and timers that only fire when told to. */
function fakeClock(start) {
  let at = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => at,
    advance: (ms) => { at += ms; },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    async fireAll() {
      const due = [...timers.entries()];
      for (const [id, fn] of due) { timers.delete(id); fn(); }
      await flush();
    }
  };
}

function flush(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 15); i++) p = p.then(() => new Promise((resolve) => setImmediate(resolve)));
  return p;
}

module.exports = async function () {
  suite('the Slack service');

  // ---- VIP resolution ------------------------------------------------------
  {
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me', team_id: 'T1', team: 'Team', url: 'https://t.slack.com/' }),
      'users.info': (p) => p.user === 'U100'
        ? { ok: true, user: { id: 'U100', name: 'dave', profile: { display_name: 'Dave D' } } }
        : Object.assign(new Error('user_not_found'), { code: 'user_not_found' }),
      'users.lookupByEmail': (p) => p.email === 'bob@example.com'
        ? { ok: true, user: { id: 'U200', name: 'bob', profile: { display_name: 'Bob' } } }
        : Object.assign(new Error('users_not_found'), { code: 'users_not_found' }),
      'users.list': () => ({ ok: true, members: [{ id: 'U300', name: 'carol', profile: { display_name: 'Carol C' } }], response_metadata: { next_cursor: '' } }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U100', is_im: true }, { id: 'D2', user: 'U200', is_im: true }], response_metadata: { next_cursor: '' } }),
      'conversations.history': () => ({ ok: true, messages: [] }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } })
    };
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: ['U100', 'bob@example.com', 'Carol', 'Nobody'], mentions: true, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();

    check('resolves a VIP given as an id', service.vips.some((v) => v.id === 'U100' && v.name === 'Dave D'));
    check('resolves a VIP given as an email', service.vips.some((v) => v.id === 'U200' && v.name === 'Bob'));
    check('resolves a VIP given as a handle', service.vips.some((v) => v.id === 'U300'));
    checkEqual('reports the one that could not be resolved', service.state().unresolved, ['Nobody']);
    check('maps each VIP to their DM channel', service.imChannels.get('U100') === 'D1' && service.imChannels.get('U200') === 'D2');
    checkEqual('state carries exactly the resolved vips', service.state().vips.length, 3);
    service.stop();
  }

  // ---- ingest: mentions, own messages, subtypes, dedupe -------------------
  {
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [] }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } })
    };
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: [], mentions: true, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();

    service._handleIncoming({ type: 'message', channel: 'C1', user: 'UME', text: 'hi <@UME>', ts: '10' });
    checkEqual('a message from me is never escalated', service.escalator.pending().length, 0);

    service._handleIncoming({ type: 'message', channel: 'C1', user: 'U2', text: 'hey <@UME>', ts: '11', subtype: 'message_changed' });
    checkEqual('an edit is ignored', service.escalator.pending().length, 0);

    service._handleIncoming({ type: 'message', channel: 'C1', user: 'U2', text: 'hey <@UME>', ts: '12', subtype: 'thread_broadcast' });
    checkEqual('a thread broadcast mention is kept', service.escalator.pending().length, 1);
    checkEqual('and read as a mention, from a non-VIP', service.escalator.pending()[0].item.kind, 'mention');

    service._handleIncoming({ type: 'message', channel: 'C1', user: 'U2', text: 'hey <@UME>', ts: '12' });
    checkEqual('the same channel+ts arriving twice (socket, then poll) is not counted twice', service.escalator.pending().length, 1);

    service.stop();
  }

  // ---- ingest: VIP DM and VIP-elsewhere-mentioning-me ----------------------
  {
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U100', is_im: true }] }),
      'users.info': () => ({ ok: true, user: { id: 'U100', name: 'dave', profile: { display_name: 'Dave' } } }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } })
    };
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: ['U100'], mentions: true, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();

    service._handleIncoming({ type: 'message', channel: 'D1', user: 'U100', text: 'hello', ts: '20', channel_type: 'im' });
    checkEqual('a DM from a VIP is kind vip', service.escalator.pending()[0].item.kind, 'vip');

    service._handleIncoming({ type: 'message', channel: 'C5', user: 'U100', text: 'hey <@UME> look', ts: '21', channel_type: 'channel' });
    const inChannel = service.escalator.pending().find((p) => p.item.conversationId === 'C5');
    check('a VIP mentioning me anywhere is still kind vip', !!inChannel && inChannel.item.kind === 'vip');

    service.stop();
  }

  // ---- escalator timing through the service's own due timer ---------------
  {
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U100', is_im: true }] }),
      'users.info': () => ({ ok: true, user: { id: 'U100', name: 'dave', profile: { display_name: 'Dave' } } }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'conversations.info': () => ({ ok: true, channel: { last_read: '0' } }),
      'conversations.history': () => ({ ok: true, messages: [] })
    };
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: ['U100'], mentions: false, popupAfterMs: 60000, alarmAfterMs: 180000, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();

    const popups = [];
    const alarms = [];
    service.on('popup', (p) => popups.push(p));
    service.on('alarm', (a) => alarms.push(a));

    service._handleIncoming({ type: 'message', channel: 'D1', user: 'U100', text: 'ping', ts: '1000.1', channel_type: 'im' });

    clock.advance(59999);
    await clock.fireAll();
    checkEqual('nothing fires before a minute', popups.length, 0);

    clock.advance(1);
    await clock.fireAll();
    checkEqual('a popup fires at a minute, unseen', popups.length, 1);
    checkEqual('naming who it is from', popups[0].conversation.with.name, 'Dave');

    clock.advance(119999);
    await clock.fireAll();
    checkEqual('no alarm yet, one second early', alarms.length, 0);

    clock.advance(1);
    await clock.fireAll();
    checkEqual('the alarm fires at three minutes, still unseen', alarms.length, 1);
    check('with a title naming the sender', /Dave/.test(alarms[0].title));

    service.stop();
  }

  // ---- seen via Slack's own read marker cancels the popup ------------------
  {
    let lastRead = '0';
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U100', is_im: true }] }),
      'users.info': () => ({ ok: true, user: { id: 'U100', name: 'dave', profile: { display_name: 'Dave' } } }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'conversations.info': () => ({ ok: true, channel: { last_read: lastRead } }),
      'conversations.history': () => ({ ok: true, messages: [] })
    };
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: ['U100'], mentions: false, popupAfterMs: 60000, alarmAfterMs: 180000, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();
    const popups = [];
    service.on('popup', (p) => popups.push(p));

    service._handleIncoming({ type: 'message', channel: 'D1', user: 'U100', text: 'ping', ts: '2000.1', channel_type: 'im' });
    lastRead = '2000.1'; // read in Slack itself before the minute is up
    clock.advance(60000);
    await clock.fireAll();
    checkEqual('seen in Slack cancels the popup rather than firing it', popups.length, 0);
    checkEqual('and it is no longer pending', service.escalator.pending().length, 0);
    service.stop();
  }

  // ---- a reply in Slack itself cancels the alarm ---------------------------
  {
    let repliedTs = null;
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U100', is_im: true }] }),
      'users.info': () => ({ ok: true, user: { id: 'U100', name: 'dave', profile: { display_name: 'Dave' } } }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'conversations.info': () => ({ ok: true, channel: { last_read: '0' } }),
      'conversations.history': () => ({ ok: true, messages: repliedTs ? [{ user: 'UME', ts: repliedTs }] : [] })
    };
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: ['U100'], mentions: false, popupAfterMs: 60000, alarmAfterMs: 180000, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();
    const alarms = [];
    service.on('alarm', (a) => alarms.push(a));

    service._handleIncoming({ type: 'message', channel: 'D1', user: 'U100', text: 'ping', ts: '3000.1', channel_type: 'im' });
    clock.advance(60000);
    await clock.fireAll(); // popup due, unseen, fires (not asserted here)
    repliedTs = '3000.2'; // answered from Slack directly, after the ping
    clock.advance(120000);
    await clock.fireAll();
    checkEqual('a reply posted in Slack cancels the alarm', alarms.length, 0);
    checkEqual('and clears the conversation as pending', service.state().conversations.find((c) => c.id === 'D1').pending, false);
    service.stop();
  }

  // ---- seenInNikui resolves without ever calling Slack ---------------------
  {
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U100', is_im: true }] }),
      'users.info': () => ({ ok: true, user: { id: 'U100', name: 'dave', profile: { display_name: 'Dave' } } }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } })
    };
    const api = fakeApi(handlers);
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api, config: () => ({ enabled: true, vips: ['U100'], mentions: false, popupAfterMs: 60000, alarmAfterMs: 180000, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();

    service._handleIncoming({ type: 'message', channel: 'D1', user: 'U100', text: 'ping', ts: '4000.1', channel_type: 'im' });
    const before = api.calls.length;
    service.seenInNikui('D1');
    checkEqual('seenInNikui makes no Slack call at all', api.calls.length, before);
    checkEqual('and resolves what was pending', service.escalator.pending().length, 0);
    service._handleIncoming({ type: 'message', channel: 'D1', user: 'U100', text: 'still there?', ts: '4001.1', channel_type: 'im' });
    check('having looked once does not silence the next message', service.escalator.pending().length === 1);
    check('nor is it counted as seen when it falls due', (await service._isSeen(service.escalator.pending()[0].item)) === false);
    service._handleIncoming({ type: 'message', channel: 'D1', user: 'UME', text: 'yes', ts: '4002.1', channel_type: 'im' });
    checkEqual('answering in Slack itself clears it at once', service.escalator.pending().length, 0);
    service.stop();
  }

  // ---- reply(): posts, then marks read up to the newest ts -----------------
  {
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [] }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'chat.postMessage': () => ({ ok: true, ts: '5000.5' }),
      'conversations.history': () => ({ ok: true, messages: [{ ts: '5000.5', user: 'UME' }] }),
      'conversations.mark': () => ({ ok: true })
    };
    const api = fakeApi(handlers);
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api, config: () => ({ enabled: true, vips: [], mentions: false, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();

    const result = await service.reply('D9', 'got it');
    checkEqual('reply returns the posted ts', result.ts, '5000.5');
    const methods = api.calls.map((c) => c.method);
    check('it posts before marking', methods.indexOf('chat.postMessage') < methods.lastIndexOf('conversations.mark'));
    const mark = api.calls.find((c) => c.method === 'conversations.mark');
    checkEqual('marking the right channel and ts', mark.params, { channel: 'D9', ts: '5000.5' });

    let refused = null;
    try { await service.reply('D9', '   '); } catch (err) { refused = err; }
    check('an empty reply is refused rather than sent', refused && refused.refused === true);
    service.stop();
  }

  // ---- poll interval stretches under enough VIPs ---------------------------
  {
    const service = new SlackService({ api: fakeApi({}), config: () => ({}) });
    service.cfg = { pollMs: 20000 };
    service.vips = [{ id: 'U1' }];
    checkEqual('with few VIPs the configured interval stands', service._effectivePollMs(), 20000);
    service.vips = Array.from({ length: 200 }, (_, i) => ({ id: 'U' + i }));
    check('with many VIPs the interval stretches past what was configured', service._effectivePollMs() > 20000);
  }

  // ---- errors never carry the token -----------------------------------------
  {
    const handlers = {
      'auth.test': () => Object.assign(new Error('invalid_auth: token xoxp-super-secret rejected'), { code: 'invalid_auth' }),
      'conversations.list': () => ({ ok: true, channels: [] })
    };
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: [], mentions: false, pollMs: 20000 })
    });
    await service.start();
    check('a human sentence, not Slack’s own wording', service.state().error === 'Slack refused the token — connect again.');
    check('and never the token itself', !/xoxp-/.test(service.state().error));
    service.stop();
  }
};
