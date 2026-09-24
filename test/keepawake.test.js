'use strict';

// Keeping the laptop awake, switched from a phone.
//
// The whole point is the case where you are not at the laptop: it is in a cafe,
// you are in another country, and whether it goes to sleep is the difference
// between reaching it tonight and not reaching it until somebody opens the lid.
// So everything here is over a real socket, from real paired devices, against
// the same switch the editor uses — and with two of them, because a switch one
// phone flips has to be seen flipped on the other.

const path = require('path');
const { EventEmitter } = require('events');
const { install, memoryState } = require('./helpers/vscode-stub.js');
install();
const { RemoteServer } = require('../src/remote.js');
const { LocalKey } = require('../src/auth.js');
const { DeviceStore } = require('../src/devices.js');
const { PairingWindow } = require('../src/pairing.js');
const { loadIdentity } = require('../src/identity.js');
const { Awake, KeepAwake } = require('../src/awake.js');
const ws = require('./helpers/ws.js');
const { makeDevice } = require('./helpers/device.js');

const ROOT = path.join(__dirname, '..');

async function signIn(client, device) {
  const challenge = await client.waitFor('@challenge');
  const answer = await device.answer(challenge, device.id);
  client.send(answer);
  if (device.box) client.seal(device.box);
  return client.waitFor('@welcome');
}

/**
 * The next message that matches, ignoring everything that has already arrived.
 *
 * Not the helper's own predicate wait, which looks through history first — and
 * history here is full of answers that match: every "is it on" before this
 * one. Waiting on one of those resolves at once, the next question goes out
 * while the last answer is still in flight, and every check after it is
 * reading the one before.
 */
//
// Nothing arriving is an answer too — a failed check, rather than a thrown
// timeout that takes every other result in the run down with it.
const hears = (client, matches, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => {
    client.removeListener('message', on);
    resolve({ type: 'nothing', nothing: true });
  }, ms || 4000);
  const on = (m) => {
    if (!matches(m)) return;
    clearTimeout(timer);
    client.removeListener('message', on);
    resolve(m);
  };
  client.on('message', on);
});

/**
 * Ask, and wait for the answer to this question rather than the last one: a
 * switch asked to go on is answered on, or refused. The broadcast and the
 * direct reply say the same thing, so whichever lands first will do.
 */
const asks = (client, message) => {
  const wanted = message.type === 'awake:set' ? !!message.on : null;
  const reply = hears(client, (m) => m && m.type === 'awake' &&
    (wanted === null || !!m.refused || m.on === wanted));
  client.send(message);
  return reply;
};

module.exports = async function () {
  // caffeinate, without a machine to keep awake.
  const spawned = [];
  const awake = new Awake({
    platform: 'darwin',
    pid: 4242,
    spawn: (command, args) => {
      const proc = new EventEmitter();
      proc.line = [command].concat(args).join(' ');
      proc.killed = false;
      proc.kill = () => { proc.killed = true; proc.emit('exit', 0); };
      proc.unref = () => {};
      spawned.push(proc);
      return proc;
    }
  });
  const holding = () => spawned.filter((p) => !p.killed).length;

  // The setting, as the editor holds it. `refuse` is a write that fails, which
  // a phone has to be told about rather than left waiting on.
  let setting = false;
  let refuse = null;
  let server = null;
  const keeping = new KeepAwake({
    awake,
    enabled: () => setting,
    write: async (on) => { if (refuse) throw new Error(refuse); setting = on; },
    serving: () => !!(server && server.listening)
  });

  const devices = new DeviceStore(memoryState());
  server = new RemoteServer({
    root: ROOT,
    host: {
      config: () => ({ showThinking: true, promptSnippets: {} }),
      home: '/home', knownCommands: () => [], fleet: () => [], env: () => ({})
    },
    sessions: { list: () => [], get: () => null },
    devices,
    identity: loadIdentity(memoryState()),
    pairing: new PairingWindow(),
    localKey: new LocalKey('test-key-not-a-secret'),
    keepAwake: keeping
  });
  keeping.onChange(() => server.broadcastAwake());
  await server.start(0);
  keeping.reconsider();
  const socket = () => `ws://127.0.0.1:${server.port}/socket`;

  const phone = await makeDevice('A phone');
  const tablet = await makeDevice('A tablet');
  phone.id = devices.add({ name: phone.name, publicKey: phone.publicKey }).id;
  tablet.id = devices.add({ name: tablet.name, publicKey: tablet.publicKey }).id;

  const one = await ws.connect(socket());
  await signIn(one, phone);
  const two = await ws.connect(socket());
  await signIn(two, tablet);

  try {
    suite('any paired device can see whether the laptop will stay awake');

    const first = await asks(one, { type: 'awake' });
    check('it is offered', first.available);
    checkEqual('and off to begin with', first.on, false);
    checkEqual('so nothing is holding the laptop', first.held, false);
    checkEqual('a device that only watches is told it may not change it', first.mayChange, false);
    checkEqual('and nothing was started to find that out', spawned.length, 0);

    suite('a device that only watches cannot switch it');

    const refused = await asks(one, { type: 'awake:set', on: true });
    check('it is refused, and told why', /watch but not change/.test(refused.refused || ''));
    checkEqual('the setting is untouched', setting, false);
    checkEqual('and the laptop is still allowed to sleep', holding(), 0);
    check('the attempt is written down',
      devices.recent(5).some((e) => e.action === 'tried to keep the laptop awake' && e.allowed === false));

    suite('granting control is news to that row');

    const granted = hears(one, (m) => m && m.type === 'awake' && m.mayChange === true);
    devices.setControl(phone.id, true);
    check('the phone is told it may change it now, without asking', !(await granted).nothing);

    suite('switching it on, from the phone');

    const otherHears = hears(two, (m) => m && m.type === 'awake' && m.on === true);
    const on = await asks(one, { type: 'awake:set', on: true });
    checkEqual('it is on', on.on, true);
    checkEqual('and holding', on.held, true);
    checkEqual('the setting says so', setting, true);
    checkEqual('with one assertion', holding(), 1);
    checkEqual('against idle and system sleep, never the display, and dying with the window',
      (spawned[0] || {}).line, 'caffeinate -i -s -w 4242');
    checkEqual('for a reason it can say', on.reason, 'listening for your phone');
    check('since a time it can show', typeof on.since === 'number');
    const seen = await otherHears;
    check('the other device is told without asking', !seen.nothing);
    checkEqual('in its own terms: it still may not change it', seen.mayChange, false);
    check('written down as that phone keeping the laptop awake',
      devices.recent(5).some((e) => e.action === 'kept the laptop awake' && e.device === 'A phone'));

    // Switching to what it already is broadcasts nothing, because nothing
    // changed. The phone that asked is still owed an answer: one that never
    // comes reads, on a phone, as the laptop having gone away.
    //
    // An answer that says "on" could be the last question's, still in flight,
    // so this waits for the laptop to have written this one down.
    const kept = () => devices.recent(50).filter((e) => e.action === 'kept the laptop awake').length;
    const before = kept();
    const again = await asks(one, { type: 'awake:set', on: true });
    for (let i = 0; i < 200 && kept() === before; i++) await new Promise((r) => setTimeout(r, 10));
    checkEqual('switching it on again is still answered', again.on, true);
    checkEqual('and the laptop did hear it', kept(), before + 1);
    checkEqual('and is still one assertion', holding(), 1);

    suite('switched at the laptop, and the phones see it');

    const offAtLaptop = hears(one, (m) => m && m.type === 'awake' && m.on === false);
    const offOther = hears(two, (m) => m && m.type === 'awake' && m.on === false);
    await keeping.set(false);
    check('the phone is told', !(await offAtLaptop).nothing);
    check('and so is the other one', !(await offOther).nothing);
    checkEqual('and the laptop may sleep again', holding(), 0);

    suite('switching it off, from the phone');

    await asks(one, { type: 'awake:set', on: true });
    checkEqual('back on', holding(), 1);
    const off = await asks(one, { type: 'awake:set', on: false });
    checkEqual('off', off.on, false);
    checkEqual('nothing held', off.held, false);
    checkEqual('what was started is ended', holding(), 0);
    check('written down as letting it sleep',
      devices.recent(5).some((e) => e.action === 'let the laptop sleep'));

    suite('when the laptop cannot do what was asked');

    refuse = 'settings are read-only here';
    const failed = await asks(one, { type: 'awake:set', on: true });
    check('the phone is told why, rather than left waiting',
      /read-only/.test(failed.refused || ''));
    checkEqual('and what is still true', failed.on, false);
    checkEqual('nothing was held on the strength of it', holding(), 0);
    refuse = null;
  } finally {
    one.close();
    two.close();
    keeping.dispose();
    await server.stop();
  }

  suite('a window that offers no switch says so');

  {
    const plain = new RemoteServer({
      root: ROOT,
      host: { config: () => ({}), home: '/home', knownCommands: () => [], fleet: () => [], env: () => ({}) },
      sessions: { list: () => [], get: () => null },
      devices: new DeviceStore(memoryState()),
      identity: loadIdentity(memoryState()),
      pairing: new PairingWindow(),
      localKey: new LocalKey('another-test-key')
    });
    checkEqual('rather than inventing an answer',
      plain.awakeMessage({ device: { kind: 'device', control: true } }),
      { type: 'awake', available: false });
    check('and broadcasting nothing, without complaint',
      (() => { plain.broadcastAwake(); return true; })());
  }
};
