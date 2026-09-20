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

server = new RemoteServer({
  root: REPO,
  host,
  sessions,
  devices,
  terminals,
  identity: loadIdentity(memoryState()),
  pairing,
  localKey: new LocalKey(),
  log: (line) => console.log('  ' + line)
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
