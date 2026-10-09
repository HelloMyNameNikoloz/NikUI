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

  suite('Slack API: fetching a file, without handing the token to anywhere else');

  function imageResponse(bytes, contentType, contentLength) {
    return {
      status: 200,
      headers: {
        get: (name) => {
          const n = name.toLowerCase();
          if (n === 'content-type') return contentType === undefined ? 'image/png' : contentType;
          if (n === 'content-length') return contentLength === undefined ? String(bytes.length) : contentLength;
          return null;
        }
      },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
  }

  {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const fetch = fakeFetch([imageResponse(bytes)]);
    const api = createApi({ token: 'xoxp-secret', cookie: 'xoxd-abc', fetch });
    const result = await api.fetchFile('https://files.slack.com/files-pri/T1-F1/image.png');
    checkEqual('the mimetype comes back', result.mimetype, 'image/png');
    check('and the bytes', result.buffer.equals(bytes));
    check('the bearer token goes with it', fetch.calls[0].init.headers.authorization === 'Bearer xoxp-secret');
    check('and the session cookie, in session mode', fetch.calls[0].init.headers.cookie === 'd=xoxd-abc');
  }

  {
    const bytes = Buffer.from([5, 6]);
    const redirect = { status: 302, headers: { get: (n) => (n.toLowerCase() === 'location' ? 'https://cdn.example.net/img.png' : null) } };
    const fetch = fakeFetch([redirect, imageResponse(bytes)]);
    const api = createApi({ token: 'xoxc-secret', cookie: 'xoxd-abc', fetch });
    const result = await api.fetchFile('https://files.slack.com/files-pri/T1-F1/image.png');
    check('a redirect is followed', result.buffer.equals(bytes) && fetch.calls[1].url === 'https://cdn.example.net/img.png');
    check('redirects are not followed blindly', fetch.calls[0].init.redirect === 'manual');
    check('but neither token nor cookie follows it off Slack',
      !fetch.calls[1].init.headers.authorization && !fetch.calls[1].init.headers.cookie);
  }

  {
    const fetch = fakeFetch([]);
    const api = createApi({ token: 'xoxp-secret', appToken: 'xapp-app', fetch });
    let caught = null;
    try { await api.fetchFile('https://evil.example.com/token-please'); } catch (err) { caught = err; }
    checkEqual('a host that is not Slack\'s own files host is refused outright', caught && caught.code, 'bad_host');
    checkEqual('no request is even made', fetch.calls.length, 0);
  }

  {
    const fetch = fakeFetch([]);
    const api = createApi({ token: 'xoxp-secret', fetch });
    let caught = null;
    try { await api.fetchFile('https://slack.com.evil.example/x'); } catch (err) { caught = err; }
    checkEqual('a lookalike host fools nobody', caught && caught.code, 'bad_host');
  }

  {
    const fetch = fakeFetch([imageResponse(Buffer.from([1]), 'text/html')]);
    const api = createApi({ token: 'xoxp-secret', fetch });
    let caught = null;
    try { await api.fetchFile('https://files.slack.com/files-pri/T1-F1/x'); } catch (err) { caught = err; }
    checkEqual('a non-image content type is refused', caught && caught.code, 'bad_type');
  }

  {
    const big = 4 * 1024 * 1024;
    const fetch = fakeFetch([imageResponse(Buffer.alloc(1), 'image/png', String(big))]);
    const api = createApi({ token: 'xoxp-secret', fetch });
    let caught = null;
    try { await api.fetchFile('https://files.slack.com/files-pri/T1-F1/x'); } catch (err) { caught = err; }
    checkEqual('a declared size over 3 MB is refused before it is even downloaded', caught && caught.code, 'too_big');
  }

  {
    const fetch = fakeFetch([imageResponse(Buffer.alloc(4 * 1024 * 1024))]);
    const api = createApi({ token: 'xoxp-secret', fetch });
    let caught = null;
    try { await api.fetchFile('https://files.slack.com/files-pri/T1-F1/x'); } catch (err) { caught = err; }
    checkEqual('and so is one that turns out too big once downloaded', caught && caught.code, 'too_big');
  }

  {
    const fetch = fakeFetch([imageResponse(Buffer.from([9]))]);
    const api = createApi({ token: 'xoxp-user', appToken: 'xapp-app', fetch });
    await api.fetchFile('https://files.slack.com/files-pri/T1-F1/x');
    check('fetching a file never sends the app-level token', fetch.calls[0].init.headers.authorization === 'Bearer xoxp-user');
  }
};
