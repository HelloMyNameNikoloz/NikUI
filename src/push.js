'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');

/**
 * Web Push, by hand, because the alternative is a dependency tree in something
 * that already runs code on this machine.
 *
 * Two specifications meet here:
 *
 *  - **RFC 8291** encrypts the payload to the subscription's own key, so the
 *    push service that carries it — Apple's, Google's, Mozilla's — cannot read
 *    what an instance is doing. It carries an opaque block and nothing else.
 *  - **RFC 8292** signs a short-lived token with this window's own key, so the
 *    push service can tell that the sender is who it was subscribed to.
 *
 * The key derivation is left to Node's own HKDF rather than rebuilt out of
 * HMACs here: it is the part with the most ways to be subtly wrong, and Node's
 * is an implementation nobody here wrote.
 *
 * What is not claimed: a delivery through a real push service has not been
 * tested from this machine — that needs a device and a network. The encryption
 * is round-tripped against a separate decryptor in the browser, on a different
 * crypto stack, which catches the encoding and derivation mistakes; a shared
 * misreading of the specification it would not.
 */

const VAPID = 'nikui.vapid';
const TOKEN_LIFE_MS = 12 * 60 * 60 * 1000; // twelve hours; the spec's ceiling is 24
const DEFAULT_TTL = 12 * 60 * 60;          // how long a push service should hold it

/** This window's sending identity, made once and kept. */
function loadVapid(store) {
  const saved = store && store.get ? store.get(VAPID, null) : null;
  if (saved && saved.publicKey && saved.privateKey) {
    try { return build(fromBase64(saved.publicKey), fromBase64(saved.privateKey)); }
    catch (_) { /* unreadable: make another rather than refusing to notify */ }
  }
  const pair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  if (store && store.update) {
    store.update(VAPID, { publicKey: toBase64(pair.publicKey), privateKey: toBase64(pair.privateKey) });
  }
  return build(pair.publicKey, pair.privateKey);
}

function build(publicDer, privateDer) {
  const privateKey = crypto.createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
  return {
    privateKey,
    publicKey,
    // What the browser wants as `applicationServerKey`: the raw point, not the
    // DER wrapper Node hands out.
    applicationServerKey: toBase64(rawPoint(publicKey))
  };
}

/** The 65-byte uncompressed point, out of whatever Node calls a key. */
function rawPoint(key) {
  const jwk = key.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), fromBase64(jwk.x), fromBase64(jwk.y)]);
}

// ---- RFC 8292: proving who is sending ---------------------------------------

/**
 * A token for one push service, good for hours rather than for one message —
 * which is what the specification intends, and what keeps this from signing
 * something new for every notification.
 */
function vapidHeader(vapid, endpoint, subject, now) {
  const audience = new URL(endpoint).origin;
  const header = base64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = base64(JSON.stringify({
    aud: audience,
    exp: Math.floor(((now || Date.now()) + TOKEN_LIFE_MS) / 1000),
    sub: subject || 'mailto:nikui@localhost'
  }));
  const signature = crypto.sign('sha256', Buffer.from(header + '.' + claims, 'utf8'), {
    key: vapid.privateKey,
    // JWS wants r‖s, not DER. The same trap as every other signature here.
    dsaEncoding: 'ieee-p1363'
  });
  const token = header + '.' + claims + '.' + toBase64(signature);
  return `vapid t=${token}, k=${vapid.applicationServerKey}`;
}

// ---- RFC 8291: making it unreadable to the carrier ---------------------------

/**
 * Encrypt a payload to a subscription.
 *
 * @param {{p256dh: string, auth: string}} keys the subscription's own, base64url
 * @param {string|Buffer} payload
 * @param {Buffer} [salt] fixed only by the tests
 * @param {object} [ephemeral] fixed only by the tests
 * @returns {Buffer} the body to POST, headers aside
 */
function encrypt(keys, payload, salt, ephemeral) {
  const clientPublic = fromBase64(keys.p256dh);
  const authSecret = fromBase64(keys.auth);
  if (clientPublic.length !== 65 || clientPublic[0] !== 4) throw new Error('that is not a subscription key');
  if (authSecret.length !== 16) throw new Error('that is not an auth secret');

  const ecdh = ephemeral || crypto.createECDH('prime256v1');
  if (!ephemeral) ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(clientPublic);

  // The subscription's auth secret is the salt for the first derivation, and
  // both public keys go into the info — so a key derived for one subscription
  // is meaningless to any other.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'), clientPublic, serverPublic
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const used = salt || crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, used,
    Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, used,
    Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  // One record, so the padding delimiter says "this is the last of them".
  const record = Buffer.concat([body, Buffer.from([2])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188's header: the salt, the record size, and the key to unwrap it with.
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  return Buffer.concat([
    used, recordSize, Buffer.from([serverPublic.length]), serverPublic, sealed
  ]);
}

/**
 * The other direction, so a test can read back what was written. Not used in
 * anger — a real client decrypts this inside the browser — but a round trip
 * that nobody can run is a round trip nobody believes.
 */
function decrypt(body, clientPrivateRaw, authSecretBase64) {
  const salt = body.subarray(0, 16);
  const keyLength = body[20];
  const serverPublic = body.subarray(21, 21 + keyLength);
  const sealed = body.subarray(21 + keyLength);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(clientPrivateRaw);
  const clientPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(serverPublic);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'), clientPublic, serverPublic
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, fromBase64(authSecretBase64), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt,
    Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt,
    Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  // Trim the padding delimiter and anything after it.
  let end = record.length;
  while (end > 0 && record[end - 1] === 0) end--;
  return record.subarray(0, Math.max(0, end - 1)).toString('utf8');
}

// ---- sending ----------------------------------------------------------------

/**
 * One notification to one subscription.
 *
 * @returns {Promise<{ok: boolean, status: number, gone: boolean, reason: string|null}>}
 */
function send(subscription, message, options) {
  const o = options || {};
  const vapid = o.vapid;
  const request = o.request || post;
  let body;
  try {
    body = encrypt(subscription.keys, JSON.stringify(message));
  } catch (err) {
    return Promise.resolve({ ok: false, status: 0, gone: false, reason: err.message });
  }

  const headers = {
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    'content-length': body.length,
    ttl: String(o.ttl || DEFAULT_TTL),
    urgency: o.urgency || 'normal',
    authorization: vapidHeader(vapid, subscription.endpoint, o.subject, o.now)
  };
  if (o.topic) headers.topic = o.topic;

  return request(subscription.endpoint, headers, body).then((response) => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    // A subscription the push service no longer knows is dead: the device
    // uninstalled the app, or the browser threw it away. Stop trying.
    gone: response.status === 404 || response.status === 410,
    reason: response.status >= 400 ? (response.body || '').slice(0, 200) : null
  }));
}

function post(endpoint, headers, body) {
  return new Promise((resolve) => {
    const url = new URL(endpoint);
    const agent = url.protocol === 'http:' ? http : https;
    const req = agent.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers,
      timeout: 15000
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timed out' }); });
    req.on('error', (err) => resolve({ status: 0, body: String(err && err.message) }));
    req.end(body);
  });
}

const toBase64 = (buffer) => Buffer.from(buffer).toString('base64url');
const fromBase64 = (text) => Buffer.from(String(text || ''), 'base64url');
const base64 = (text) => Buffer.from(text, 'utf8').toString('base64url');

module.exports = {
  loadVapid, vapidHeader, encrypt, decrypt, send, rawPoint,
  TOKEN_LIFE_MS, DEFAULT_TTL
};
