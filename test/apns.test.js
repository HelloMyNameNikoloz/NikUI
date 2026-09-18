'use strict';

// Telling an iPhone something while the app is closed.
//
// This is the only path in the product that goes through somebody else's
// machine, and the only one that cannot be run from here: it needs an Apple
// Developer account, a key issued to it, and a real device token. So everything
// but the socket is driven — the token that proves who is sending, what Apple
// is actually asked to deliver, and every way it can say no.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const apns = require('../src/apns.js');
const { memoryState } = require('./helpers/vscode-stub.js');
const { DeviceStore } = require('../src/devices.js');
const { Notifier } = require('../src/notify.js');

/** An APNs auth key, in the shape Apple issues one. */
function makeKey() {
  const pair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const file = path.join(os.tmpdir(), 'nikui-apns-' + crypto.randomBytes(6).toString('hex') + '.p8');
  fs.writeFileSync(file, pair.privateKey);
  return { file, publicKey: crypto.createPublicKey(pair.publicKey) };
}

const TOKEN = 'a'.repeat(64);

module.exports = async function () {
  suite('nothing is sent until somebody has set it up');

  const nothing = apns.loadApns(() => ({}));
  const missing = nothing.state();
  check('an unconfigured window knows it is unconfigured', missing.configured === false);
  checkEqual('and says what is missing, as things to go and do', missing.missing.length, 3);
  check('in words rather than in the names of settings',
    missing.missing.every((m) => !/[a-z][A-Z]/.test(m) && !/nikui\./.test(m)));

  const nowhere = await apns.send(TOKEN, { title: 'x' }, { apns: nothing });
  check('and sending is refused rather than attempted', nowhere.ok === false);
  check('without claiming the device is gone', nowhere.gone === false);

  const pointing = apns.loadApns(() => ({ teamId: 'T', keyId: 'K', keyFile: '/no/such/key.p8' }));
  check('a key file that is not there is named as the thing missing',
    /no\/such\/key.p8/.test(pointing.state().missing.join(' ')));

  suite('the token that proves who is sending');

  const key = makeKey();
  const ready = apns.loadApns(() => ({
    teamId: 'TEAM123456', keyId: 'KEY1234567', keyFile: key.file, bundleId: 'com.nikoloz.nikui'
  }));
  check('a window with all four is ready', ready.state().configured === true);
  checkEqual('and sends to the production network by default', ready.state().host, apns.PRODUCTION);
  checkEqual('sandbox when asked',
    apns.loadApns(() => ({
      teamId: 'T', keyId: 'K', keyFile: key.file, production: false
    })).state().host, apns.SANDBOX);

  const jwt = ready.token(Date.UTC(2026, 0, 1));
  const [head, claims, signature] = jwt.split('.');
  checkEqual('the token is a JWT Apple will read',
    JSON.parse(Buffer.from(head, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
  checkEqual('issued by the team that owns the key',
    JSON.parse(Buffer.from(claims, 'base64url').toString()).iss, 'TEAM123456');
  checkEqual('and stamped with when it was made',
    JSON.parse(Buffer.from(claims, 'base64url').toString()).iat, Date.UTC(2026, 0, 1) / 1000);
  check('signed with the key, in the encoding Apple verifies',
    crypto.verify('sha256', Buffer.from(head + '.' + claims),
      { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));

  checkEqual('the same token is reused rather than remade every time',
    ready.token(Date.UTC(2026, 0, 1) + 60000), jwt);
  check('but not past the hour Apple allows it to live',
    ready.token(Date.UTC(2026, 0, 1) + apns.TOKEN_LIFE_MS + 1000) !== jwt);

  suite('what Apple is asked to deliver');

  const posted = [];
  const accepting = (host, headers, body) => {
    posted.push({ host, headers, body: JSON.parse(body) });
    return Promise.resolve({ status: 200, body: '' });
  };

  const out = await apns.send(TOKEN, {
    title: 'alpha needs an answer', body: 'Allow Bash?', kind: 'needs-you',
    tag: 'needs-you:nik-1', session: 'nik-1'
  }, { apns: ready, request: accepting, now: Date.UTC(2026, 0, 1) });

  check('a delivery Apple accepts is a success', out.ok === true);
  checkEqual('it goes to the device it was addressed to', posted[0].headers[':path'], '/3/device/' + TOKEN);
  checkEqual('under the app it is for', posted[0].headers['apns-topic'], 'com.nikoloz.nikui');
  checkEqual('as an alert rather than a silent wake', posted[0].headers['apns-push-type'], 'alert');
  checkEqual('at the priority that lights a locked screen', posted[0].headers['apns-priority'], '10');
  checkEqual('replacing the same news rather than stacking under it',
    posted[0].headers['apns-collapse-id'], 'needs-you:nik-1');
  check('and expiring within the hour, because a stale one is worse than none',
    Number(posted[0].headers['apns-expiration']) === Date.UTC(2026, 0, 1) / 1000 + 3600);

  checkEqual('the alert says which instance', posted[0].body.aps.alert.title, 'alpha needs an answer');
  checkEqual('and what it is asking', posted[0].body.aps.alert.body, 'Allow Bash?');
  checkEqual('something that cannot go on without you is time-sensitive',
    posted[0].body.aps['interruption-level'], 'time-sensitive');
  checkEqual('with a sound', posted[0].body.aps.sound, 'default');
  checkEqual('and the instance, so a tap can open it', posted[0].body.session, 'nik-1');

  posted.length = 0;
  await apns.send(TOKEN, { title: 'beta finished', kind: 'turn-finished', tag: 'f' },
    { apns: ready, request: accepting });
  checkEqual('everything else waits to be picked up', posted[0].body.aps['interruption-level'], 'active');
  checkEqual('quietly', posted[0].body.aps.sound, undefined);
  checkEqual('at the lower priority', posted[0].headers['apns-priority'], '5');

  suite('every way it can say no');

  const refusing = (status, body) => () => Promise.resolve({ status, body: JSON.stringify({ reason: body }) });

  const gone = await apns.send(TOKEN, { title: 'x' },
    { apns: ready, request: refusing(410, 'Unregistered') });
  check('a device Apple has never heard of is reported as gone', gone.gone === true);
  check('and not as a success', gone.ok === false);

  const wrongBuild = await apns.send(TOKEN, { title: 'x' },
    { apns: ready, request: refusing(400, 'DeviceTokenNotForTopic') });
  check('a token from another build is gone too', wrongBuild.gone === true);

  const badToken = await apns.send(TOKEN, { title: 'x' },
    { apns: ready, request: refusing(400, 'BadDeviceToken') });
  check('and so is one Apple will not read', badToken.gone === true);

  const ourFault = await apns.send(TOKEN, { title: 'x' },
    { apns: ready, request: refusing(403, 'ExpiredProviderToken') });
  check('a key problem is not blamed on the device', ourFault.gone === false);
  check('and says what Apple said', /ExpiredProviderToken/.test(ourFault.reason));

  const broken = await apns.send(TOKEN, { title: 'x' },
    { apns: ready, request: () => Promise.reject(new Error('the network went away')) });
  check('a network that fails does not throw', broken.ok === false);
  check('nor conclude the device is gone', broken.gone === false);

  const rubbish = await apns.send('not-a-token', { title: 'x' }, { apns: ready, request: accepting });
  check('something that is not a token is refused before Apple is troubled', rubbish.gone === true);

  suite('a device that says where to find it');

  const store = new DeviceStore(memoryState());
  const { makeDevice } = require('./helpers/device.js');
  const phone = await makeDevice('An iPhone');
  const record = store.add({ name: phone.name, publicKey: phone.publicKey });

  check('a token is kept against the device that offered it',
    !!store.subscribeApple(record.id, TOKEN.toUpperCase()));
  checkEqual('in one case, so it is the same string every time',
    store.get(record.id).apns.token, TOKEN);
  checkEqual('and it is findable', store.appleSubscribers().length, 1);
  check('something that is not a token is not kept',
    store.subscribeApple(record.id, 'nope') === null);
  check('and a device nobody paired cannot offer one',
    store.subscribeApple('not-a-device', TOKEN) === null);

  store.forget(record.id);
  checkEqual('forgetting the device forgets where to reach it', store.appleSubscribers().length, 0);

  suite('and the window uses it only when it is set up');

  const asked = [];
  const withApple = new Notifier({
    devices: store, vapid: null, apns: ready, now: () => 1000,
    sendApple: (token, message) => { asked.push({ token, message }); return Promise.resolve({ ok: true }); },
    send: async () => ({ ok: true })
  });
  const iphone = await makeDevice('Another iPhone');
  const second = store.add({ name: iphone.name, publicKey: iphone.publicKey });
  store.subscribeApple(second.id, TOKEN);

  const told = await withApple.announce('needs-you', { title: 'alpha needs an answer', tag: 't' });
  checkEqual('a configured window reaches the iPhone', asked.length, 1);
  checkEqual('with the words it would have shown anywhere else',
    asked[0].message.title, 'alpha needs an answer');
  checkEqual('and counts it as sent', told.sent, 1);

  asked.length = 0;
  const withoutApple = new Notifier({
    devices: store, vapid: null, apns: nothing, now: () => 1000,
    sendApple: (token, message) => { asked.push({ token, message }); return Promise.resolve({ ok: true }); },
    send: async () => ({ ok: true })
  });
  await withoutApple.announce('needs-you', { title: 'alpha needs an answer', tag: 't' });
  checkEqual('an unconfigured one does not try, and does not complain', asked.length, 0);

  asked.length = 0;
  const losing = new Notifier({
    devices: store, vapid: null, apns: ready, now: () => 1000,
    sendApple: () => Promise.resolve({ ok: false, gone: true, reason: 'Unregistered' }),
    send: async () => ({ ok: true })
  });
  await losing.announce('needs-you', { title: 'x', tag: 't' });
  checkEqual('a device Apple says is gone stops being written to',
    store.appleSubscribers().length, 0);
  check('and it is written down, so it is not a mystery later',
    store.recent(5).some((line) => /notifications stopped/.test(line.action)));

  fs.unlinkSync(key.file);
};
