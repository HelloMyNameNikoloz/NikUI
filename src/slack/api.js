'use strict';

/**
 * Slack's Web API, by hand: a POST to slack.com/api/<method>, a bearer token,
 * and a JSON body that says `ok` or doesn't. The whole surface this needs is
 * a dozen methods — a dependency would buy nothing but another thing asked to
 * keep the token secret.
 *
 * Two tokens matter: a user token (xoxp-) for everything that reads or posts
 * as the person, and an app-level token (xapp-) for the one method that opens
 * a Socket Mode connection. Which one a call wants is the `app` option, not
 * the method name, since Slack does not say so itself.
 *
 * Or no app at all: the session Slack's own web and desktop clients use — an
 * xoxc- token with the `d` cookie it belongs to. Same methods, same answers,
 * as you; it simply lasts until that browser session is signed out, and there
 * is no Socket Mode without an app, so the service polls.
 */

const BASE = 'https://slack.com/api/';

/**
 * @param {object} deps
 * @param {string} deps.token        the user token (xoxp-)
 * @param {string} [deps.appToken]   the app-level token (xapp-), for Socket Mode only
 * @param {string} [deps.cookie]     the session's `d` cookie, URL-encoded, when `token` is an xoxc-
 * @param {Function} [deps.fetch]   injectable; defaults to the global `fetch`
 * @param {Function} [deps.sleep]   injectable (ms) => Promise, for the 429 wait
 */
function createApi({ token, appToken, cookie, fetch: fetchImpl, sleep } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /**
   * One call. Retries exactly once on a 429, after the wait Slack asked for.
   *
   * @param {string} method     e.g. 'conversations.history'
   * @param {object} [params]
   * @param {{app?: boolean}} [options]  `app: true` sends the app-level token
   * @returns {Promise<object>} the JSON body, once `ok` is true
   */
  async function call(method, params, options) {
    return attempt(method, params, options || {}, true);
  }

  async function attempt(method, params, options, retryOn429) {
    const useToken = options.app ? appToken : token;
    if (!useToken) {
      throw Object.assign(new Error('no Slack token is set for ' + method), { code: 'no_token' });
    }
    if (!doFetch) {
      throw Object.assign(new Error('no fetch is available to reach Slack'), { code: 'no_fetch' });
    }

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null) continue;
      body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }

    let response;
    try {
      response = await doFetch(BASE + method, {
        method: 'POST',
        headers: Object.assign({
          authorization: 'Bearer ' + useToken,
          'content-type': 'application/x-www-form-urlencoded'
        }, cookie && !options.app ? { cookie: 'd=' + cookie } : {}),
        body: body.toString()
      });
    } catch (_) {
      // Whatever the network said, the token is not part of it.
      throw Object.assign(new Error('could not reach Slack'), { code: 'network' });
    }

    if (response.status === 429 && retryOn429) {
      const header = response.headers && response.headers.get ? response.headers.get('retry-after') : null;
      const retryAfter = Number(header) > 0 ? Number(header) : 1;
      await wait(retryAfter * 1000);
      return attempt(method, params, options, false);
    }

    let json;
    try {
      json = await response.json();
    } catch (_) {
      throw Object.assign(new Error('Slack sent back something that was not JSON'), { code: 'bad_response' });
    }

    if (!json || json.ok !== true) {
      const code = (json && json.error) || 'unknown_error';
      throw Object.assign(new Error('Slack refused ' + method + ': ' + code), { code });
    }
    return json;
  }

  return { call };
}

/**
 * A session as pasted: quotes, a `d=` in front, a `; Path=/…` behind, or the
 * cookie already decoded by whatever it was copied from — all of it happens,
 * and none of it should be a reason to say no. The cookie goes back on the
 * wire URL-encoded, which is how Slack set it.
 *
 * @returns {{token: string, cookie: string} | {error: string}}
 */
function cleanSession(rawToken, rawCookie) {
  const strip = (v) => String(v || '').trim().replace(/^['"`]+|['"`]+$/g, '').trim();
  const token = strip(rawToken);
  let cookie = strip(rawCookie).replace(/^d=/, '').split(';')[0].trim();
  if (!/^xoxc-[A-Za-z0-9-]+$/.test(token)) return { error: 'The session token starts with xoxc-.' };
  if (!/^xoxd-/.test(cookie)) return { error: 'The d cookie starts with xoxd-.' };
  if (/[/+=]/.test(cookie)) cookie = encodeURIComponent(cookie);
  if (!/^xoxd-[A-Za-z0-9%._-]+$/.test(cookie)) return { error: 'That does not look like the whole d cookie.' };
  return { token, cookie };
}

module.exports = { createApi, cleanSession };
