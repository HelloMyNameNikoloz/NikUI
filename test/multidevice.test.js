'use strict';

// More than one phone, at the same time, able to take each other off.
//
// Everything else about devices is written as though there were one. There is
// not: a phone and a tablet, or a phone and the one you are replacing it with,
// or the old phone you want gone from somewhere that is not the laptop — losing
// a phone is precisely the moment you are not sitting at the machine where the
// only remove button used to be.
//
// So: two sockets at once, each seeing the other; who may remove whom, and the
// refusals written down; and a removal reaching a socket that is already open
// rather than meaning "next time".

const path = require('path');
const { install, memoryState } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { RemoteServer } = require('../src/remote.js');
const { LocalKey } = require('../src/auth.js');
const { DeviceStore } = require('../src/devices.js');
const { PairingWindow } = require('../src/pairing.js');
const { loadIdentity } = require('../src/identity.js');
const { buildReport } = require('../src/report.js');
const ws = require('./helpers/ws.js');
const { makeDevice } = require('./helpers/device.js');

const ROOT = path.join(__dirname, '..');

function quietSession(name) {
  const s = new Session({ cwd: ROOT });
  s.customTitle = name || null;
  s.start = function () { this.everStarted = true; };
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

// `waitFor` hands back the first message of a type that ever arrived, which is
// right for a handshake and wrong for a list that is asked for again and again:
// every later wait would resolve instantly to the first answer. So anything
// expecting a *fresh* list arms the wait before sending the question.
const asks = (client, message) => {
  const reply = client.next('devices', 4000);
  client.send(message);
  return reply;
};

async function signIn(client, device) {
  const challenge = await client.waitFor('@challenge');
  const answer = await device.answer(challenge, device.id);
  client.send(answer);
  if (device.box) client.seal(device.box);
  return client.waitFor('@welcome');
}

module.exports = async function () {
  const only = quietSession('alpha');
  const sessions = { list: () => [only], get: (id) => (id === only.id ? only : null) };
  const host = {
    config: () => ({ showThinking: true, promptSnippets: {} }),
    home: '/home', knownCommands: () => ['status'],
    fleet: () => [only], env: () => ({ vscode: 'test' })
  };

  const devices = new DeviceStore(memoryState());
  const auth = new LocalKey('test-key-not-a-secret');
  host.audit = (entry) => devices.record(entry);

  const server = new RemoteServer({
    root: ROOT, host, sessions, devices,
    identity: loadIdentity(memoryState()),
    pairing: new PairingWindow(), localKey: auth,
    report: () => buildReport({ session: only, fleet: [only], env: { vscode: 'test' } })
  });
  await server.start(0);
  const port = server.port;
  const socket = () => `ws://127.0.0.1:${port}/socket`;

  // ---- two of them, at once -------------------------------------------------

  suite('two devices are paired, and both are connected at once');

  const phone = await makeDevice('A phone');
  const tablet = await makeDevice('A tablet');
  phone.id = devices.add({ name: phone.name, publicKey: phone.publicKey, protection: 'secure-enclave' }).id;
  tablet.id = devices.add({ name: tablet.name, publicKey: tablet.publicKey, protection: 'strongbox' }).id;
  checkEqual('the laptop holds two records', devices.list().length, 2);
  check('with keys of their own', devices.list()[0].publicKey !== devices.list()[1].publicKey);

  const one = await ws.connect(socket());
  const seatedOne = await signIn(one, phone);
  const two = await ws.connect(socket());
  const seatedTwo = await signIn(two, tablet);

  checkEqual('the first is seated as itself', seatedOne.device.name, 'A phone');
  checkEqual('and the second as itself', seatedTwo.device.name, 'A tablet');
  check('neither took the other’s seat', seatedOne.device.id !== seatedTwo.device.id);

  one.send({ type: 'ready' });
  two.send({ type: 'ready' });
  const fleetOne = await one.waitFor('fleet');
  const fleetTwo = await two.waitFor('fleet');
  checkEqual('both are shown the window', fleetOne.instances.length, 1);
  checkEqual('and it is the same window', fleetTwo.instances[0].id, fleetOne.instances[0].id);

  // Two sockets asking the same question at the same time is the ordinary case,
  // not a race to be survived once.
  one.send({ type: 'status' });
  two.send({ type: 'status' });
  const statusOne = await one.waitFor('status');
  const statusTwo = await two.waitFor('status');
  check('both can ask for the status at once', statusOne.available && statusTwo.available);

  // ---- seeing each other ----------------------------------------------------

  suite('each device can see what else is paired');

  const listOne = await asks(one, { type: 'devices' });
  checkEqual('the list has both', listOne.devices.length, 2);
  checkEqual('and says which one is asking', listOne.me, phone.id);
  check('the asker is marked as itself',
    listOne.devices.find((d) => d.id === phone.id).me === true);
  check('and the other is not',
    listOne.devices.find((d) => d.id === tablet.id).me === false);
  check('both are shown as connected now',
    listOne.devices.every((d) => d.here === true));
  check('how each holds its key is carried over',
    listOne.devices.find((d) => d.id === tablet.id).protection === 'strongbox');
  checkEqual('a device that only watches is told it may not manage', listOne.mayManage, false);
  check('and no private key is anywhere in the message',
    !/privateKey|\bd\b":/.test(JSON.stringify(listOne)));

  // ---- who may remove whom --------------------------------------------------

  suite('a device that only watches cannot remove another');

  const refused = await asks(one, { type: 'forget', id: tablet.id });
  check('it is refused', /may watch/.test(refused.refused || ''));
  checkEqual('and the other is still there', devices.list().length, 2);
  check('the attempt is written down',
    devices.recent(5).some((e) => e.action === 'tried to remove another device' && e.allowed === false));
  check('with the device that tried it', devices.recent(5)[0].device === 'A phone');

  suite('but it can always remove itself');

  const tabletSees = two.next('devices', 4000);
  one.send({ type: 'forget', id: phone.id });
  const gone = await one.waitClosed();
  check('its own socket is closed', !!gone);
  checkEqual('and the record is gone', devices.list().length, 1);
  checkEqual('the one left is the other', devices.list()[0].id, tablet.id);
  check('which is written down as its own doing',
    devices.recent(5).some((e) => e.action === 'removed itself' && e.allowed === true));

  const told = await tabletSees;
  checkEqual('the device still connected is told, without being asked', told.devices.length, 1);
  check('and can no longer see the one that left',
    !told.devices.some((d) => d.id === phone.id));

  // ---- removing somebody else ----------------------------------------------

  suite('a device with control can remove another');

  const phoneAgain = await makeDevice('The phone again');
  phoneAgain.id = devices.add({ name: phoneAgain.name, publicKey: phoneAgain.publicKey }).id;
  const back = await ws.connect(socket());
  await signIn(back, phoneAgain);
  back.send({ type: 'ready' });
  await back.waitFor('fleet');

  const granted = two.waitWhere((m) => m && m.type === 'devices' && m.mayManage === true, 4000);
  devices.setControl(tablet.id, true);
  checkEqual('control is what makes the difference', (await granted).mayManage, true);

  two.send({ type: 'forget', id: phoneAgain.id });
  const cut = await back.waitClosed();
  check('the removed device loses the socket it was holding', !!cut);
  checkEqual('and the laptop keeps only the remover', devices.list().length, 1);
  check('written down as one device removing another',
    devices.recent(6).some((e) => e.action === 'removed another device' && e.detail === 'The phone again'));

  suite('and the removed device cannot come back on the old key');

  const denied = await ws.connect(socket());
  const askAgain = await denied.waitFor('@challenge');
  denied.send(await phoneAgain.answer(askAgain, phoneAgain.id));
  const no = await denied.waitFor('@denied');
  check('its key is not known any more', /not paired/.test(no.reason));
  await denied.waitClosed();

  suite('the edges of removing');

  const nothing = await asks(two, { type: 'forget', id: 'a-device-that-never-existed' });
  check('removing something that is not there says so', /already gone/.test(nothing.refused || ''));
  checkEqual('and changes nothing', devices.list().length, 1);

  const blank = await asks(two, { type: 'forget' });
  check('so does removing nothing at all', /already gone/.test(blank.refused || ''));

  // The last device removing itself is allowed: it is the honest end of "this
  // phone is not mine any more", and the laptop can always pair another.
  two.send({ type: 'forget', id: tablet.id });
  await two.waitClosed();
  checkEqual('the last device may still hand itself back', devices.list().length, 0);

  suite('a client that is not a device cannot touch the list');

  const browser = await ws.connect(socket(), { headers: { cookie: 'nikui=' + auth.key } });
  const hello = await browser.waitFor('@challenge');
  browser.send({ type: '@auth', device: null, nonce: 'this-machine-has-the-key' });
  await browser.waitFor('@welcome');
  void hello;
  const barred = await asks(browser, { type: 'forget', id: 'anything' });
  check('it is told only a paired device may', /only a paired device/.test(barred.refused || ''));

  browser.close();
  two.close();
  await server.stop();
};
