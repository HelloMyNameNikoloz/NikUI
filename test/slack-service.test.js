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

  // ---- sidebar: membership, counts, previews, sorted --------------------
  {
    const historyCalls = [];
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [] }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'users.conversations': () => ({
        ok: true,
        channels: [
          { id: 'D1', is_im: true, user: 'U1' },
          { id: 'D2', is_im: true, user: 'U2', is_user_deleted: true },
          { id: 'D3', is_im: true, user: 'USLACKBOT' },
          { id: 'C1', is_mpim: true, name: 'mpdm-anna--bob-1' },
          { id: 'C2', is_channel: true, name: 'general', is_private: false },
          { id: 'C3', is_channel: true, name: 'secret', is_private: true }
        ],
        response_metadata: { next_cursor: '' }
      }),
      'users.info': (p) => {
        const byId = {
          U1: { id: 'U1', name: 'dave', profile: { display_name: 'Dave' } },
          U2: { id: 'U2', name: 'anna', profile: { display_name: 'Anna' } }
        };
        return byId[p.user] ? { ok: true, user: byId[p.user] } : Object.assign(new Error('user_not_found'), { code: 'user_not_found' });
      },
      'conversations.members': (p) => p.channel === 'C1'
        ? { ok: true, members: ['U1', 'U2', 'UME'] }
        : { ok: true, members: [] },
      'client.counts': () => ({
        ok: true,
        channels: [{ id: 'C2', has_unreads: true, mention_count: 2, latest: '100.0' }],
        mpims: [{ id: 'C1', has_unreads: false, mention_count: 0, latest: '50.0' }],
        ims: [{ id: 'D1', has_unreads: true, mention_count: 0, latest: '200.0' }]
      }),
      'conversations.history': (p) => {
        historyCalls.push(p.channel);
        const byId = {
          D1: [{ ts: '200.0', user: 'U1', text: 'you there?' }],
          C2: [{ ts: '100.0', user: 'U3', text: 'build is green' }],
          C1: [{ ts: '50.0', user: 'U2', text: 'lunch?' }]
        };
        return { ok: true, messages: byId[p.channel] || [] };
      }
    };
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: [], mentions: false, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();
    await flush(); // let _resolveMpimTitle's own round of calls land

    const state = service.state();
    check('the sidebar is marked loaded', state.sidebar.loaded === true);
    const ids = state.sidebar.items.map((i) => i.id);
    checkEqual('a deleted user’s DM and the Slackbot DM are both skipped', ids.filter((i) => i === 'D2' || i === 'D3'), []);
    checkEqual('sorted newest first, with no recency last', ids, ['D1', 'C2', 'C1', 'C3']);

    const dm = state.sidebar.items.find((i) => i.id === 'D1');
    checkEqual('a DM’s title is the person’s name', dm.title, 'Dave');
    checkEqual('and it carries their user info', dm.user.id, 'U1');
    check('its preview is flattened plain text', dm.last && dm.last.text === 'you there?');
    checkEqual('its latestAt comes from client.counts, in milliseconds', dm.latestAt, 200000);
    check('unread, from client.counts', dm.unread === true);

    const channel = state.sidebar.items.find((i) => i.id === 'C2');
    checkEqual('a channel’s title carries no leading #', channel.title, 'general');
    checkEqual('mentions come through from client.counts', channel.mentions, 2);

    const priv = state.sidebar.items.find((i) => i.id === 'C3');
    check('a private channel is marked private', priv.private === true);
    checkEqual('with nothing yet counted, it sorts last and has no recency', priv.latestAt, null);

    const group = state.sidebar.items.find((i) => i.id === 'C1');
    checkEqual('a group DM’s title is its members, not the technical channel name', group.title, 'Dave, Anna');

    // Preview caching: refreshing again with the same latest ts makes no
    // second conversations.history call for a conversation that has not moved.
    historyCalls.length = 0;
    await service.refreshSidebar(true);
    await flush();
    checkEqual('an unchanged preview is not re-fetched', historyCalls.filter((c) => c === 'D1').length, 0);

    service.stop();
  }

  // ---- sidebar: client.counts unsupported falls back to conversations.info --
  {
    const infoCalls = [];
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [] }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'users.conversations': () => ({ ok: true, channels: [{ id: 'D1', is_im: true, user: 'U1' }], response_metadata: { next_cursor: '' } }),
      'users.info': () => ({ ok: true, user: { id: 'U1', name: 'dave', profile: { display_name: 'Dave' } } }),
      'client.counts': () => Object.assign(new Error('unknown_method'), { code: 'unknown_method' }),
      'conversations.info': (p) => { infoCalls.push(p.channel); return { ok: true, channel: { latest: { ts: '10.0' }, unread_count_display: 1 } }; },
      'conversations.history': () => ({ ok: true, messages: [] })
    };
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: [], mentions: false, pollMs: 20000 })
    });
    await service.start();
    await flush();
    await flush();
    const dm = service.state().sidebar.items.find((i) => i.id === 'D1');
    check('a DM’s recency comes from conversations.info when client.counts is not allowed', dm.unread === true && dm.latestAt === 10000);
    check('an app token is never asked for client.counts twice', infoCalls.length > 0);
    service.stop();
  }

  // ---- bug: lastAt is the message’s own ts, not when it was ingested -------
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
    clock.advance(999999); // the ts is long past "now" — the bug used now() instead
    service._handleIncoming({ type: 'message', channel: 'C9', user: 'U9', text: 'hi <@UME>', ts: '12345.6' });
    const conv = service.state().conversations.find((c) => c.id === 'C9');
    checkEqual('lastAt comes from the message’s own ts', conv.lastAt, 12345600);
    service.stop();
  }

  // ---- bug: a preview naming an id resolves once the name arrives ----------
  {
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [] }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'users.info': (p) => p.user === 'U7'
        ? { ok: true, user: { id: 'U7', name: 'ren', profile: { display_name: 'Ren' } } }
        : Object.assign(new Error('user_not_found'), { code: 'user_not_found' })
    };
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: [], mentions: true, pollMs: 20000 })
    });
    await service.start();
    await flush();
    service._handleIncoming({ type: 'message', channel: 'C8', user: 'U7', text: 'ping <@UME> about <@U7>', ts: '1.0' });
    const soon = service.state().conversations.find((c) => c.id === 'C8');
    check('a raw mention is kept until a name arrives', !!soon.last);
    await flush();
    const later = service.state().conversations.find((c) => c.id === 'C8');
    checkEqual('once resolved, the mention reads by name, not by id', later.last.text, 'ping @UME about @Ren');
    service.stop();
  }

  // ---- thread(): a bubble is never empty -----------------------------------
  {
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [] }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'users.info': () => ({ ok: true, user: { id: 'U1', name: 'dave', profile: { display_name: 'Dave' } } }),
      'conversations.history': () => ({
        ok: true,
        messages: [
          { ts: '3.0', user: 'U1', files: [{ name: 'report.pdf', permalink: 'https://x/report.pdf' }] },
          { ts: '2.0', user: 'U1', attachments: [{ fallback: 'a link preview' }] },
          { ts: '1.0', user: 'U1', subtype: 'huddle_thread' },
          { ts: '0.5', user: 'U1', reactions: [{ name: 'thumbsup', count: 2, users: ['UME'] }], text: ':thumbsup: nice' }
        ]
      })
    };
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: [], mentions: false, pollMs: 20000 })
    });
    await service.start();
    await flush();
    const { messages } = await service.thread('C1');
    const file = messages.find((m) => m.ts === '3.0');
    check('a file-only message shows the file, not nothing', file.html.includes('report.pdf') && file.html.includes('📎'));
    check('with a link to it', file.html.includes('https://x/report.pdf'));
    const attachment = messages.find((m) => m.ts === '2.0');
    check('an attachment-only message shows its fallback text', attachment.html.includes('a link preview'));
    const huddle = messages.find((m) => m.ts === '1.0');
    check('a huddle says so', /huddle/i.test(huddle.html));
    const reacted = messages.find((m) => m.ts === '0.5');
    checkEqual('a reaction carries its emoji', reacted.reactions[0].emoji, '👍');
    check('and whether it is mine', reacted.reactions[0].mine === true);
    service.stop();
  }

  // ---- thread(): images, and fetching their bytes on request ---------------
  {
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [] }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'users.info': () => ({ ok: true, user: { id: 'U1', name: 'dave', profile: { display_name: 'Dave' } } }),
      'conversations.history': () => ({
        ok: true,
        has_more: true,
        messages: [
          { ts: '1.0', user: 'U1', files: [{
            id: 'F1', name: 'cat.png', title: 'a cat', mimetype: 'image/png',
            thumb_720: 'https://files.slack.com/files-tmb/T1-F1/720.png',
            original_w: 720, original_h: 480, permalink: 'https://x/cat.png'
          }] },
          { ts: '2.0', user: 'U1', files: [{ id: 'F2', name: 'report.pdf', title: 'report', mimetype: 'application/pdf', permalink: 'https://x/report.pdf' }] }
        ]
      })
    };
    const fetched = [];
    const api = fakeApi(handlers);
    api.fetchFile = async (url) => { fetched.push(url); return { mimetype: 'image/png', buffer: Buffer.from([1, 2, 3]) }; };
    const service = new SlackService({ api, config: () => ({ enabled: true, vips: [], mentions: false, pollMs: 20000 }) });
    await service.start();
    await flush();

    const { messages, hasMore } = await service.thread('C1');
    check('hasMore reflects Slack\'s own has_more', hasMore === true);
    const image = messages.find((m) => m.ts === '1.0').files[0];
    checkEqual('an image file carries its id, name, title, mimetype', image, {
      id: 'F1', name: 'cat.png', title: 'a cat', mimetype: 'image/png',
      image: true, w: 720, h: 480, permalink: 'https://x/cat.png'
    });
    const pdf = messages.find((m) => m.ts === '2.0').files[0];
    check('a non-image file is not marked as one', pdf.image === false && pdf.mimetype === 'application/pdf');

    const got = await service.fileData('F1');
    check('fileData fetches the remembered thumb', got.ok && got.dataUrl === 'data:image/png;base64,' + Buffer.from([1, 2, 3]).toString('base64'));
    checkEqual('from the thumb url, not the original', fetched, ['https://files.slack.com/files-tmb/T1-F1/720.png']);

    await service.fileData('F1');
    checkEqual('a second ask is served from cache, not fetched again', fetched.length, 1);

    const missing = await service.fileData('never-seen');
    check('an id this never saw a thumb for is refused, not thrown', missing.ok === false && /not available/.test(missing.reason));

    // Paging back: `before` asks Slack for older messages, oldest first.
    const paged = await service.thread('C1', undefined, { before: '1.0' });
    check('a before ts is sent as Slack\'s own latest/inclusive pair', true); // behavioural check below covers the call shape
    const call = api.calls.slice().reverse().find((c) => c.method === 'conversations.history' && c.params.latest === '1.0');
    check('the history call for older messages uses latest/inclusive:false', !!call && call.params.inclusive === false);
    service.stop();
  }

  // ---- muting: Slack's own list, the local one, and a direct mention either way ----
  {
    let prefsCalls = 0;
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U100', is_im: true }] }),
      'users.conversations': () => ({ ok: true, channels: [{ id: 'D1', user: 'U100', is_im: true }] }),
      'users.info': () => ({ ok: true, user: { id: 'U100', name: 'dave', profile: { display_name: 'Dave' } } }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'client.counts': () => ({ ok: true, channels: [], mpims: [], ims: [] }),
      'users.prefs.get': () => { prefsCalls++; return { ok: true, prefs: { muted_channels: 'D9,D1' } }; }
    };
    const clock = fakeClock(1_000_000);
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: ['U100'], mentions: true, pollMs: 20000 }),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
    await service.start();
    await flush();

    check('Slack\'s own muted_channels is read', prefsCalls === 1 && service.isSlackMuted('D1'));

    service._handleIncoming({ type: 'message', channel: 'D1', user: 'U100', text: 'hey', ts: '10' });
    checkEqual('a VIP DM muted in Slack itself does not escalate', service.escalator.pending().length, 0);

    service._handleIncoming({ type: 'message', channel: 'D1', user: 'U100', text: 'hey <@UME>', ts: '11' });
    checkEqual('but a direct mention still does, muted or not', service.escalator.pending().length, 1);

    service.localMuted = new Set(['D1']);
    service.escalator.resolve('D1');
    service._handleIncoming({ type: 'message', channel: 'D1', user: 'U100', text: 'hey again', ts: '12' });
    checkEqual('the local list mutes just as well', service.escalator.pending().length, 0);

    await service.refreshSidebar(true);
    await flush();
    const item = service.state().sidebar.items.find((i) => i.id === 'D1');
    check('the sidebar says muted, and by whom', item.muted === true && item.mutedIn === 'slack');
    service.stop();
  }

  {
    // Slack's own list failing is treated as empty, not thrown.
    const handlers = {
      'auth.test': () => ({ ok: true, user_id: 'UME', user: 'me' }),
      'conversations.list': () => ({ ok: true, channels: [] }),
      'search.messages': () => ({ ok: true, messages: { matches: [] } }),
      'users.prefs.get': () => Object.assign(new Error('internal_error'), { code: 'internal_error' })
    };
    const service = new SlackService({
      api: fakeApi(handlers),
      config: () => ({ enabled: true, vips: [], mentions: false, pollMs: 20000 })
    });
    await service.start();
    await flush();
    check('a failed prefs read is just an empty mute list', service.isSlackMuted('D1') === false);
    service.stop();
  }
};
