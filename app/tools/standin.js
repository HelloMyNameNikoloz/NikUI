#!/usr/bin/env node
'use strict';

// A laptop, for proving a phone works against one.
//
//   node app/tools/standin.js
//
// The editor's own window is the real thing and the only thing that matters,
// but it is also somebody's working session: reloading it to pick up new code
// interrupts every instance in it. This is the same server out of the same
// files, with nothing of the editor behind it, so a phone can be driven against
// the current code without anybody's work being thrown away.
//
// The phone reaches it over `adb reverse`, which puts this port on the phone's
// own localhost — and localhost is a secure context, so Web Crypto works and
// the device can hold a real key. That is the same reason the real path needs
// Tailscale's certificate: without a secure context there is no key at all.
//
// It prints a pairing code and then whatever the device does, so the run is
// readable from here rather than only on the phone.

const path = require('path');
const os = require('os');

const REPO = path.join(__dirname, '..', '..');
const { install, memoryState } = require(path.join(REPO, 'test', 'helpers', 'vscode-stub.js'));
install();

const { RemoteServer } = require(path.join(REPO, 'src', 'remote.js'));
const { DeviceStore } = require(path.join(REPO, 'src', 'devices.js'));
const { PairingWindow } = require(path.join(REPO, 'src', 'pairing.js'));
const { loadIdentity } = require(path.join(REPO, 'src', 'identity.js'));
const { LocalKey } = require(path.join(REPO, 'src', 'auth.js'));
const { Terminals } = require(path.join(REPO, 'src', 'terminal.js'));
const { Audience } = require(path.join(REPO, 'src', 'audience.js'));
const { Notifier } = require(path.join(REPO, 'src', 'notify.js'));

const PORT = Number(process.env.PORT || 4599);

const devices = new DeviceStore(memoryState());
const pairing = new PairingWindow({ ttlMs: 10 * 60 * 1000 });

// No instances: this exists to prove the terminal, and a terminal belongs to
// the machine rather than to any one conversation.
const sessions = { list: () => [], get: () => null };
const host = {
  config: () => ({ showThinking: true, promptSnippets: {} }),
  home: os.homedir(),
  knownCommands: () => [],
  fleet: () => [],
  env: () => ({ vscode: 'stand-in' }),
  audit: (entry) => devices.record(entry)
};

let server;
const terminals = new Terminals({ onEvent: (event) => server.terminalSaid(event) });

// The clock is ours, so ninety minutes takes as long as typing `skip 90`.
let offset = 0;
const now = () => Date.now() + offset;
const audience = new Audience({ now });

server = new RemoteServer({
  root: REPO,
  host,
  sessions,
  devices,
  terminals,
  identity: loadIdentity(memoryState()),
  pairing,
  localKey: new LocalKey(),
  audience,
  log: (line) => console.log('  ' + line)
});

const notifier = new Notifier({
  devices,
  vapid: null,
  audience,
  now,
  settings: () => ({ needsYou: true, quota: true, failed: true, turnFinished: true }),
  toSockets: (message) => server.notifyDevices(message),
  log: (line) => console.log('  ' + line)
});

/**
 * Driven by hand, because what is being checked is which phone buzzes and when.
 *
 * `steer` is a phone sending a prompt; `skip` is time passing without it being
 * touched; `fire` is the work finishing. Between them every rule this exists to
 * enforce can be walked through on a real phone in under a minute.
 */
require('readline').createInterface({ input: process.stdin }).on('line', async (line) => {
  const [word, rest] = String(line).trim().split(/\s+/);
  const phone = devices.list()[0];
  if (word === 'steer') {
    if (!phone) return console.log('  nothing paired yet');
    audience.steered('demo', phone.id);
    console.log('  ' + phone.name + ' now owns demo');
  } else if (word === 'skip') {
    offset += Number(rest || 90) * 60 * 1000;
    console.log('  ' + Math.round(offset / 60000) + ' minutes have passed');
  } else if (word === 'fire') {
    const out = await notifier.finished({ id: 'demo', customTitle: rest || 'A long job' });
    console.log('  fired: ' + JSON.stringify(out));
  } else if (word === 'state') {
    console.log('  ' + JSON.stringify(audience.state()));
  }
});

// Every device that pairs here may run commands. On a real laptop that is a
// deliberate second act; here the whole point is the terminal, and this server
// exists for as long as one command takes.
devices.onChange(() => {
  for (const device of devices.list()) {
    if (!device.control) {
      devices.setControl(device.id, true);
      console.log('  granted control to ' + device.name);
    }
  }
});

server.start(PORT).then(() => {
  const open = pairing.start({
    host: '127.0.0.1:' + PORT,
    scheme: 'http',
    fingerprint: server.identity.fingerprint,
    laptop: 'Stand-in'
  });
  console.log('listening on 127.0.0.1:' + PORT);
  console.log('pairing code: ' + open.code);
  console.log('point the phone at http://127.0.0.1:' + PORT + ' and type it in');
}).catch((err) => {
  console.error('could not start: ' + ((err && err.message) || err));
  process.exit(1);
});

process.on('SIGINT', () => {
  terminals.closeAll();
  server.stop().then(() => process.exit(0), () => process.exit(0));
});
