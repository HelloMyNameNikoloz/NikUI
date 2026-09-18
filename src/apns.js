'use strict';

const crypto = require('crypto');
const http2 = require('http2');

/**
 * Telling an iPhone something while NikUI is closed.
 *
 * This is the one thing in the product that cannot be done between the two
 * machines. iOS suspends an app the moment it leaves the screen — no
 * entitlement, no setting and no service changes that — so the only way to
 * reach a closed app is Apple's own push network, and the only way to use that
 * is an Apple Developer account. Everything here is inert until one is
 * configured, and says so rather than failing quietly.
 *
 * What Apple sees: that a message exists, its size, and the device it is for.
 * The alert text goes through them, which is unavoidable and is why the titles
 * name an instance rather than quoting it. Android needs none of this — it
 * keeps the socket open behind a foreground service instead.
 *
 * The token is a JWT signed with an ES256 key, which is the same shape as the
 * VAPID token in src/push.js. Apple wants it refreshed at least hourly and no
 * more often than every twenty minutes, so it is made once and kept for fifty.
 */

const PRODUCTION = 'api.push.apple.com';
const SANDBOX = 'api.sandbox.push.apple.com';
const TOKEN_LIFE_MS = 50 * 60 * 1000;

/**
 * @param {() => {teamId?: string, keyId?: string, keyFile?: string, bundleId?: string,
 *   production?: boolean}} read  where the settings come from, read fresh
 */
function loadApns(read) {
  const fs = require('fs');
  let cached = null;

  const settings = () => {
    const raw = (typeof read === 'function' ? read() : read) || {};
    return {
      teamId: String(raw.teamId || '').trim(),
      keyId: String(raw.keyId || '').trim(),
      keyFile: String(raw.keyFile || '').trim(),
      bundleId: String(raw.bundleId || 'com.nikoloz.nikui').trim(),
      production: raw.production !== false
    };
  };

  /**
   * Whether this could send anything, and what is missing if not. Phrased as
   * things to go and do, because that is what somebody reading it needs.
   */
  function state() {
    const now = settings();
    const missing = [];
    if (!now.teamId) missing.push('your Apple team ID');
    if (!now.keyId) missing.push('the key ID of an APNs key');
    if (!now.keyFile) missing.push('the .p8 file that key came in');
    else if (!fs.existsSync(now.keyFile)) missing.push('a .p8 file at ' + now.keyFile);
    return {
      configured: missing.length === 0,
      missing,
      bundleId: now.bundleId,
      host: now.production ? PRODUCTION : SANDBOX
    };
  }

  function token(now) {
    const at = now || Date.now();
    if (cached && at - cached.at < TOKEN_LIFE_MS) return cached.jwt;
    const { teamId, keyId, keyFile } = settings();
    const key = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
    const head = base64({ alg: 'ES256', kid: keyId });
    const claims = base64({ iss: teamId, iat: Math.floor(at / 1000) });
    const signature = crypto.sign('sha256', Buffer.from(head + '.' + claims),
      { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    cached = { at, jwt: `${head}.${claims}.${signature}` };
    return cached.jwt;
  }

  /** For a key that has been replaced, and for the tests. */
  function forget() { cached = null; }

  return { state, token, forget, settings };
}

const base64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * What arrives on the phone.
 *
 * `interruption-level` is the difference between a notification that lights a
 * locked screen and one that waits: something that cannot go on without you is
 * time-sensitive, and everything else is not. Getting that backwards is how an
 * app ends up muted.
 */
function payload(message) {
  const urgent = message.kind === 'needs-you';
  return {
    aps: {
      alert: {
        title: String(message.title || 'NikUI').slice(0, 120),
        body: String(message.body || '').slice(0, 300)
      },
      sound: urgent ? 'default' : undefined,
      'interruption-level': urgent ? 'time-sensitive' : 'active',
      'thread-id': message.tag ? String(message.tag).slice(0, 64) : undefined
    },
    kind: message.kind || null,
    session: message.session || null,
    at: message.at || Date.now()
  };
}

/**
 * Send one, to one device token.
 *
 * @param {string} deviceToken  the hex token the phone was given by iOS
 * @param {object} message      title, body, kind, tag, session
 * @param {object} opts         { apns, request, now }
 * @returns {Promise<{ok: boolean, status?: number, gone?: boolean, reason?: string}>}
 */
async function send(deviceToken, message, opts) {
  const apns = opts.apns;
  const ready = apns.state();
  if (!ready.configured) {
    return { ok: false, gone: false, reason: 'not set up: needs ' + ready.missing.join(', ') };
  }
  const hex = String(deviceToken || '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 32) return { ok: false, gone: true, reason: 'that is not a device token' };

  const urgent = message.kind === 'needs-you';
  const headers = {
    ':method': 'POST',
    ':path': '/3/device/' + hex,
    authorization: 'bearer ' + apns.token(opts.now),
    'apns-topic': ready.bundleId,
    'apns-push-type': 'alert',
    'apns-priority': urgent ? '10' : '5',
    // A notification about a state that has already changed is worse than none,
    // so nothing here outlives the hour it was made in.
    'apns-expiration': String(Math.floor((opts.now || Date.now()) / 1000) + 3600)
  };
  // The same news replaces the old news rather than stacking under it.
  if (message.tag) headers['apns-collapse-id'] = String(message.tag).slice(0, 64);

  const post = opts.request || request;
  try {
    const answer = await post(ready.host, headers, JSON.stringify(payload(message)));
    if (answer.status === 200) return { ok: true, status: 200 };
    const said = read(answer.body);
    // Apple says the app was removed, or the token belongs to another build.
    // Either way there is nothing at the other end of it.
    const gone = answer.status === 410 ||
      (answer.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(said));
    return { ok: false, status: answer.status, gone, reason: said };
  } catch (err) {
    return { ok: false, gone: false, reason: (err && err.message) || 'the send failed' };
  }
}

const read = (body) => {
  try { return JSON.parse(body).reason || body; } catch (_) { return String(body || ''); }
};

/** HTTP/2, because APNs speaks nothing else. */
function request(host, headers, body) {
  return new Promise((resolve, reject) => {
    const session = http2.connect('https://' + host);
    const done = (fn, value) => { try { session.close(); } catch (_) { /* gone */ } fn(value); };
    session.on('error', (err) => done(reject, err));
    const stream = session.request(headers);
    let answer = '';
    let status = 0;
    stream.setEncoding('utf8');
    stream.on('response', (got) => { status = got[':status']; });
    stream.on('data', (chunk) => { answer += chunk; });
    stream.on('error', (err) => done(reject, err));
    stream.on('end', () => done(resolve, { status, body: answer }));
    stream.setTimeout(10000, () => { try { stream.close(); } catch (_) { /* gone */ } });
    stream.end(body);
  });
}

module.exports = { loadApns, send, payload, request, PRODUCTION, SANDBOX, TOKEN_LIFE_MS };
