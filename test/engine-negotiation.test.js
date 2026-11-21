'use strict';

const path = require('path');
const { RemoteServer } = require('../src/remote');
const { LocalKey } = require('../src/auth');
const { CORE } = require('../src/protocolV2');
const ws = require('./helpers/ws');

module.exports = async function () {
  suite('P1-13: actual authenticated remote sockets retain the P1-24 v1 network gate');
  const localKey = new LocalKey(), clients = [];
  const engine = { id: 'e'.repeat(32), boot: 'b'.repeat(32), version: 'fixture', mode: 'service' };
  const server = new RemoteServer({ root: path.resolve(__dirname, '..'), localKey,
    sessions: { get: () => null, list: () => [] }, host: { config: () => ({}), fleet: () => [] },
    applicationProtocol: { engine, testOnlyV2: true, caps: CORE, receipts: { scope: 'a'.repeat(32) } },
    appOnly: () => true, log() {} });
  let registrations = 0;
  server.rememberApple = () => { registrations++; };
  server.issueListener = (client) => { registrations++; client.post({ type: '@listener', secret: 'fixture-bearer' }); };
  async function connect() {
    const client = await ws.connect(`ws://127.0.0.1:${server.port}/socket`, { headers: { authorization: 'Bearer ' + localKey.key } });
    clients.push(client); await client.waitFor('@challenge'); return client;
  }
  async function authenticate(client) {
    client.send({ type: '@auth', device: null, nonce: 'fixture-nonce' }); return client.waitFor('@welcome');
  }
  const hello = { type: 'hello', proto: { min: 1, max: 2 }, caps: CORE, client: { id: 'f'.repeat(32), kind: 'test', version: 'fixture' } };
  try {
    await server.start(0, { exactly: true });
    const first = await connect();
    first.send(hello); first.send({ type: '@apple', token: 'synthetic-before-auth' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    check('application negotiation/work before authentication is dropped', first.messages.every((m) => !['welcome', '@welcome'].includes(m.type)) && registrations === 0);
    const advert = await authenticate(first);
    checkEqual('network gate cannot be bypassed by a testOnlyV2 dependency option', [advert.proto, advert.caps], [{ min: 1, max: 1 }, []]);
    first.send({ ...hello, from: { local: false }, client: { ...hello.client, kind: 'mac' } });
    const selected = await first.waitFor('welcome');
    checkEqual('authenticated local socket negotiates honest v1', [selected.proto, selected.caps, selected.receipts, selected.engine], [1, [], null, engine]);
    checkEqual('transport fixes seat authority independently of client labels', selected.seat, { id: 'local', control: true, local: true, editor: false });
    first.send(hello); const repeated = await first.waitFor('protocol:error');
    checkEqual('second hello closes this socket with protocol error', repeated.code, 'BAD_HELLO');
    const unsupported = await connect(); await authenticate(unsupported);
    unsupported.send({ ...hello, proto: { min: 2, max: 2 } });
    checkEqual('v2-only client is refused before any mutation', (await unsupported.waitFor('protocol:error')).code, 'NO_COMMON_PROTOCOL');
    unsupported.send({ type: '@apple', token: 'synthetic-after-refusal' });
    const apple = await connect(); await authenticate(apple); apple.send({ type: '@apple', token: 'synthetic-valid' });
    const listener = await connect(); await authenticate(listener); listener.send({ type: '@listen' });
    await listener.waitFor('@listener');
    checkEqual('old-client first-frame Apple/listener messages are dispatched once unchanged', registrations, 2);
    checkEqual('independent sockets pin independently', [...server.clients].filter((c) => c.applicationProtocol?.proto === 1).length, 2);
  } finally { for (const client of clients) client.socket.destroy(); await server.dispose(); }
};
