'use strict';

// The phone app updates itself from the laptop it is paired with.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { install, memoryState } = require('./helpers/vscode-stub.js');
install();
const { AppUpdate, readZipEntry } = require('../src/appUpdate.js');
const { RemoteServer } = require('../src/remote.js');
const { LocalKey } = require('../src/auth.js');
const { DeviceStore } = require('../src/devices.js');
const { PairingWindow } = require('../src/pairing.js');
const { loadIdentity } = require('../src/identity.js');

/** A zip, the way an APK is one: some entries stored, some deflated. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, deflate] of entries) {
    const raw = Buffer.from(text);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([dir, end]));
}

const apk = (build) => zip([
  ['AndroidManifest.xml', 'binary manifest', false],
  ['assets/public/version.json', JSON.stringify({ client: '0.2.0', app: '0.2.12', build }), true],
  ['classes.dex', 'x'.repeat(5000), true]
]);

const get = (port, route) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port, path: route }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
  }).on('error', () => resolve({ status: 0 }));
});

module.exports = async function () {
  suite('updating the phone app from the laptop');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikupdate-'));
  const file = path.join(dir, 'app-debug.apk');

  checkEqual('one file comes out of a zip, stored or deflated',
    JSON.parse(readZipEntry(apk('abc'), 'assets/public/version.json')).build, 'abc');
  checkEqual('and a file that is not there is nothing', readZipEntry(apk('abc'), 'nope'), null);

  const update = new AppUpdate({ file });
  checkEqual('with no build on disk there is nothing to offer', update.current(), null);

  fs.writeFileSync(file, zip([['assets/public/version.json', '{"app":"0.2.12"}', false]]));
  checkEqual('a build without a fingerprint is not offered', update.current(), null);

  fs.writeFileSync(file, apk('first'));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  const info = update.current();
  checkEqual('a build is known by the fingerprint inside it', info && info.build, 'first');
  checkEqual('with the checksum the phone will verify',
    info && info.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));

  const server = new RemoteServer({
    root: path.join(__dirname, '..'),
    host: { config: () => ({}), home: '/home', knownCommands: () => [], fleet: () => [], env: () => ({}) },
    sessions: { list: () => [], get: () => null },
    devices: new DeviceStore(memoryState()),
    identity: loadIdentity(memoryState()),
    pairing: new PairingWindow(),
    localKey: new LocalKey('test-key-not-a-secret'),
    appUpdate: update
  });
  await server.start(0);
  // This machine's own browser: no device record to outlive.
  const phone = { device: null };

  checkEqual('a phone already running that build is offered nothing',
    server.appUpdateFor(phone, { type: 'app:update', build: 'first' }).available, false);
  const offer = server.appUpdateFor(phone, { type: 'app:update', build: 'older' });
  check('a phone on another build is offered this one', offer.available === true && offer.build === 'first');
  check('with an address of its own', /^\/app\/update\.apk\?t=[\w-]{20,}$/.test(offer.path));

  const got = await get(server.port, offer.path);
  checkEqual('the address downloads the build', got.status, 200);
  checkEqual('as an Android package', got.type, 'application/vnd.android.package-archive');
  check('byte for byte', got.body.equals(fs.readFileSync(file)));
  checkEqual('a made-up address gets nothing', (await get(server.port, '/app/update.apk?t=guess')).status, 410);
  checkEqual('nor does no address at all', (await get(server.port, '/app/update.apk')).status, 410);

  // Rebuilt between the offer and the download: the phone must ask again,
  // or it would install something it was never given the checksum of.
  fs.writeFileSync(file, apk('second'));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
  checkEqual('an address for an older build stops working once rebuilt', (await get(server.port, offer.path)).status, 410);
  checkEqual('and the next offer is the new build',
    server.appUpdateFor(phone, { type: 'app:update', build: 'first' }).build, 'second');

  const lapsed = server.appUpdateFor(phone, { type: 'app:update', build: 'first' });
  const token = decodeURIComponent(lapsed.path.split('t=')[1]);
  update.tokens.get(token).until = Date.now() - 1;
  checkEqual('and an address does not last forever', (await get(server.port, lapsed.path)).status, 410);

  const removed = server.appUpdateFor({ device: { id: 'since-removed' } }, { type: 'app:update', build: 'first' });
  checkEqual('an address handed to a device that has been removed stops working',
    (await get(server.port, removed.path)).status, 410);

  const none = new RemoteServer({
    root: path.join(__dirname, '..'),
    host: { config: () => ({}), home: '/home', knownCommands: () => [], fleet: () => [], env: () => ({}) },
    sessions: { list: () => [], get: () => null },
    devices: new DeviceStore(memoryState()),
    identity: loadIdentity(memoryState()),
    pairing: new PairingWindow(),
    localKey: new LocalKey('test-key-not-a-secret')
  });
  checkEqual('a laptop with no app build offers nothing', none.appUpdateFor(phone, { type: 'app:update' }).available, false);

  await server.stop();
  update.stop();
  fs.rmSync(dir, { recursive: true, force: true });
};
