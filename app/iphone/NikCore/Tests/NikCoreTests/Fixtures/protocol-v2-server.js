'use strict';
// Private stdio peer: real Gate, Box, negotiation, JSONL authority and receipt
// dispatcher, with one fake provider write. Never opens a port or a live root.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), readline = require('readline');
const root = process.argv[2], directory = process.argv[3];
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'interop.json'), 'utf8'));
const { Gate } = require(path.join(root, 'src/auth.js'));
const { DeviceStore } = require(path.join(root, 'src/devices.js'));
const identity = require(path.join(root, 'src/identity.js'));
const { CORE, canonical } = require(path.join(root, 'src/protocolV2.js'));
const { openAuthority } = require(path.join(root, 'src/jsonlAuthority.js'));
const { createReceiptDispatcher } = require(path.join(root, 'src/receiptDispatcher.js'));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
function privateKey(raw) {
  const d = Buffer.from(raw, 'hex'), ec = crypto.createECDH('prime256v1'); ec.setPrivateKey(d);
  const pub = ec.getPublicKey(null, 'uncompressed');
  return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: d.toString('base64url'), x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
}
(async () => {
  fs.chmodSync(directory, 0o700);
  const hostPrivate = privateKey(vectors.hostRaw), publicKey = crypto.createPublicKey(hostPrivate).export({ type: 'spki', format: 'der' }).toString('base64url');
  const host = identity.loadIdentity({ get: () => ({ publicKey, privateKey: hostPrivate.export({ type: 'pkcs8', format: 'der' }).toString('base64url') }) });
  const memory = new Map(), devices = new DeviceStore({ get: (k, d) => memory.has(k) ? memory.get(k) : d, update: (k, v) => { memory.set(k, v); return Promise.resolve(); } });
  devices.save([{ id: 'device1', name: 'Fixture iPhone', publicKey: vectors.deviceSPKI, fingerprint: identity.fingerprintOf(Buffer.from(vectors.deviceSPKI, 'base64url')), control: true, protection: 'software' }]);
  const gate = new Gate({ devices, identity: host, requireSealed: () => true }), challenge = gate.challenge();
  const authority = await openAuthority({ file: path.join(directory, 'authority.jsonl') });
  let sends = 0, box, negotiation;
  const run = { id: 'a81ec16e4ac74040a9107dbe669380b5', turn: 'turn-9' };
  const dispatcher = createReceiptDispatcher({ authority, authorize: () => true, handlers: {
    ready: { apply: () => ({ code: 'ok', data: { instance: 'instance-7', run }, replies: [] }) },
    send: { execute: async ({ message }) => { sends++; return { outcome: 'applied', result: { code: 'accepted', data: { instance: 'instance-7', queueId: 'q-29', operation: message.mid }, replies: [] } }; } }
  } });
  await dispatcher.recover();
  emit({ challenge: gate.challengeMessage(challenge) });
  const input = readline.createInterface({ input: process.stdin });
  let lane = Promise.resolve();
  input.on('line', line => {
    lane = lane.then(async () => {
      const frame = JSON.parse(line);
      if (frame.fixture === 'canonical') { emit(frame.values.map(value => canonical(value))); return; }
      if (frame.fixture === 'stop') {
        negotiation?.dispose(); await dispatcher.dispose(); await authority.close();
        emit({ sends }); input.close(); return;
      }
      if (!box) {
        const answer = gate.answer(challenge, frame, { address: '127.0.0.1' });
        if (!answer.ok) throw new Error(answer.reason);
        box = answer.box;
        negotiation = dispatcher.createSocket({ authenticated: true, sealed: true, testOnlyV2: true, caps: CORE,
          context: { authenticated: true, principal: 'device:device1', role: 'conversation', target: 'session:instance-7', seat: { id: 'device1', control: true, local: false, editor: false } },
          engine: { id: 'ae6a9e02284843bb9868f91637382219', boot: 'b8be34d36b164aeb84fc417dd4304e9b', version: 'fixture', mode: 'service' },
          post: value => emit(box.seal(JSON.stringify(value))), close: () => { throw new Error('Negotiation refused'); }
        });
        emit(box.seal(JSON.stringify({ ...answer.welcome, ...negotiation.advertisement })));
      } else {
        const clear = box.open(frame); if (clear === null) throw new Error('Swift frame failed Node Box');
        await negotiation.receive(JSON.parse(clear));
      }
    }).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; input.close(); });
  });
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exit(1); });
