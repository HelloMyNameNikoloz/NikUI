'use strict';
const { createApi, cleanSession } = require('../src/slack/api.js');

/** A fetch that answers from a queue, remembering what it was asked. */
function fakeFetch(queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (typeof next === 'function') return next();
    return next;
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body, headers) {
  return {
    status,
    headers: { get: (name) => (headers || {})[name.toLowerCase()] || null },
    json: async () => body
  };
}

module.exports = async function () {
  suite('Slack API, by hand');

  {
    const fetch = fakeFetch([jsonResponse(200, { ok: true, user_id: 'U1', user: 'niko' })]);
    const api = createApi({ token: 'xoxp-secret', fetch });
    const result = await api.call('auth.test', {});
    checkEqual('a plain call returns the JSON body', result.user_id, 'U1');
    check('the token travels as a bearer header, not a query string',
      fetch.calls[0].init.headers.authorization === 'Bearer xoxp-secret' &&
      !fetch.calls[0].url.includes('xoxp-secret'));
  }

  {
    const fetch = fakeFetch([jsonResponse(200, { ok: false, error: 'channel_not_found' })]);
    const api = createApi({ token: 'xoxp-secret', fetch });
    let caught = null;
    try { await api.call('conversations.history', { channel: 'C1' }); } catch (err) { caught = err; }
    check('ok:false throws, with the Slack error as a code', caught && caught.code === 'channel_not_found');
    check('and never repeats the token in the message', !/xoxp-secret/.test(caught.message));
  }

  {
    let waited = null;
    const sleep = async (ms) => { waited = ms; };
    const fetch = fakeFetch([
      jsonResponse(429, null, { 'retry-after': '2' }),
      jsonResponse(200, { ok: true, members: [] })
    ]);
    const api = createApi({ token: 'xoxp-secret', fetch, sleep });
    const result = await api.call('users.list', {});
    checkEqual('a 429 is retried once, after Retry-After', waited, 2000);
    check('and the retry succeeds', result.ok);
    checkEqual('exactly two requests were made', fetch.calls.length, 2);
  }

  {
    // A second 429 is not retried again — one retry, not a loop.
    let waits = 0;
    const sleep = async () => { waits++; };
    const fetch = fakeFetch([
      jsonResponse(429, null, { 'retry-after': '1' }),
      jsonResponse(429, null, { 'retry-after': '1' })
    ]);
    const api = createApi({ token: 'xoxp-secret', fetch, sleep });
    let caught = null;
    try { await api.call('users.list', {}); } catch (err) { caught = err; }
    checkEqual('only one retry is attempted', waits, 1);
    check('the second 429 is reported rather than retried forever', !!caught);
  }

  {
    const fetch = async () => { throw new Error('ECONNRESET'); };
    const api = createApi({ token: 'xoxp-secret', fetch });
    let caught = null;
    try { await api.call('auth.test', {}); } catch (err) { caught = err; }
    checkEqual('a network failure is its own code', caught && caught.code, 'network');
    check('with no token in it either', !/xoxp-secret/.test(caught.message));
  }

  {
    const fetch = fakeFetch([jsonResponse(200, { ok: true, url: 'wss://example' })]);
    const api = createApi({ token: 'xoxp-user', appToken: 'xapp-app', fetch });
    await api.call('apps.connections.open', {}, { app: true });
    check('the app option sends the app-level token, not the user one',
      fetch.calls[0].init.headers.authorization === 'Bearer xapp-app');
  }

  {
    const api = createApi({ token: null, fetch: fakeFetch([]) });
    let caught = null;
    try { await api.call('auth.test', {}); } catch (err) { caught = err; }
    checkEqual('with no token, it refuses rather than asking Slack', caught && caught.code, 'no_token');
  }

  suite('Slack API: a browser session, not an app');

  {
    const fetch = fakeFetch([jsonResponse(200, { ok: true, user: 'niko' })]);
    const api = createApi({ token: 'xoxc-sess', cookie: 'xoxd-abc%2F', fetch });
    await api.call('auth.test', {});
    check('the d cookie rides along with the session token',
      fetch.calls[0].init.headers.cookie === 'd=xoxd-abc%2F' &&
      fetch.calls[0].init.headers.authorization === 'Bearer xoxc-sess');
  }

  {
    // Socket Mode uses the app token and must not carry a user's cookie.
    const fetch = fakeFetch([jsonResponse(200, { ok: true, url: 'wss://x' })]);
    const api = createApi({ token: 'xoxc-sess', cookie: 'xoxd-abc', appToken: 'xapp-a', fetch });
    await api.call('apps.connections.open', {}, { app: true });
    check('an app-token call sends no cookie', !('cookie' in fetch.calls[0].init.headers));
  }

  {
    checkEqual('a clean pair passes, the cookie kept as Slack set it',
      cleanSession('xoxc-aaa', 'xoxd-bbb'), { token: 'xoxc-aaa', cookie: 'xoxd-bbb' });
    checkEqual('quotes, a d= prefix and a trailing ; Path are all forgiven',
      cleanSession('"xoxc-aaa"', 'd=xoxd-bbb; Path=/; HttpOnly'), { token: 'xoxc-aaa', cookie: 'xoxd-bbb' });
    check('a decoded cookie is re-encoded', cleanSession('xoxc-a', 'xoxd-a/b+c=').cookie === 'xoxd-a%2Fb%2Bc%3D');
    check('a token of the wrong shape is named', /xoxc-/.test(cleanSession('xoxb-nope', 'xoxd-b').error));
    check('a cookie of the wrong shape is named', /xoxd-/.test(cleanSession('xoxc-a', 'nope').error));
  }
};
