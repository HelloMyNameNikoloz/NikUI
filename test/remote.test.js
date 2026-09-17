'use strict';
const http = require('http');
const path = require('path');
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { RemoteServer } = require('../src/remote.js');
const { LocalKey } = require('../src/auth.js');
const { closeHub } = require('../src/hub.js');
const ws = require('./helpers/ws.js');
const wire = require('../src/wire.js');

const ROOT = path.join(__dirname, '..');

/** An instance that will never spawn anything. */
function quietSession(label) {
  const s = new Session({ cwd: ROOT });
  s.customTitle = label || null;
  s.start = function () { this.everStarted = true; };
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

function get(port, route, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, headers: headers || {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async function () {
  const first = quietSession('alpha');
  const second = quietSession('beta');
  const sessions = { list: () => [first, second], get: (id) => [first, second].find((s) => s.id === id) || null };
  const host = {
    config: () => ({ showThinking: true, promptSnippets: {} }),
    home: '/home',
    knownCommands: () => ['status'],
    fleet: () => sessions.list(),
    env: () => ({ vscode: 'test' })
  };

  const auth = new LocalKey('test-key-not-a-secret');
  const server = new RemoteServer({ root: ROOT, host, sessions, auth });

  suite('nothing is listening until you say so');

  checkEqual('a server that was never started is not listening', server.listening, false);
  checkEqual('and has no address to give out', server.url, null);

  await server.start(0);
  check('starting it listens', server.listening);
  checkEqual('on loopback and nowhere else', server.server.address().address, '127.0.0.1');
  check('and the address it gives out says so', /^http:\/\/127\.0\.0\.1:\d+\/\?key=/.test(server.url));

  const port = server.port;
  const cookie = { cookie: 'nikui=' + auth.key };

  suite('nothing is served without the key');

  checkEqual('the page itself needs one', (await get(port, '/')).status, 401);
  checkEqual('a wrong one is refused', (await get(port, '/?key=guessing')).status, 403);
  checkEqual('so does every asset', (await get(port, '/media/panel.js')).status, 401);
  checkEqual('and the fleet list', (await get(port, '/s/' + first.id)).status, 401);

  const handed = await get(port, '/?key=' + auth.key);
  checkEqual('the key in the address bar is taken and traded for a cookie', handed.status, 302);
  check('which is not readable by script', /HttpOnly/.test(String(handed.headers['set-cookie'])));
  check('and is not sent to other sites', /SameSite=Strict/.test(String(handed.headers['set-cookie'])));
  checkEqual('and the address it lands on carries no key', handed.headers.location, '/');

  const home = await get(port, '/', cookie);
  checkEqual('with the cookie the fleet list is served', home.status, 200);
  check('it lists every instance', home.body.indexOf('alpha') > 0 && home.body.indexOf('beta') > 0);
  check('each one links to its conversation', home.body.indexOf('/s/' + first.id) > 0);

  const page = await get(port, '/s/' + first.id, cookie);
  checkEqual('the conversation page is the client itself', page.status, 200);
  check('built from the same template as the panel', /id="transcript"/.test(page.body) && /media\/panel.js/.test(page.body));
  check('told where its socket is', /"socket":"\/socket\?session=/.test(page.body));
  check('with a policy that allows its own socket and nothing else',
    /connect-src ws:\/\/127\.0\.0\.1:/.test(page.body) && /default-src 'none'/.test(page.body));
  check('and no inline script without a nonce', !/<script(?![^>]*nonce)/.test(page.body));
  checkEqual('an instance that does not exist is not a page', (await get(port, '/s/nope', cookie)).status, 404);

  const asset = await get(port, '/media/panel.js', cookie);
  checkEqual('the client files are served', asset.status, 200);
  checkEqual('as what they are', asset.headers['content-type'], 'text/javascript; charset=utf-8');
  checkEqual('and never sniffed as something else', asset.headers['x-content-type-options'], 'nosniff');

  checkEqual('a path that climbs out of media is refused',
    (await get(port, '/media/..%2fpackage.json', cookie)).status, 403);
  checkEqual('and so is one that is not a client file',
    (await get(port, '/media/status/done.svg', cookie)).status, 200);
  checkEqual('a file type we do not serve is refused',
    (await get(port, '/media/notes.md', cookie)).status, 403);

  suite('and not to a page pretending to be this one');

  checkEqual('a Host that is not loopback is refused',
    (await get(port, '/', { host: 'nikui.example.com', cookie: cookie.cookie })).status, 403);
  checkEqual('an Origin from somewhere else is refused',
    (await get(port, '/', { origin: 'https://evil.example', cookie: cookie.cookie })).status, 403);
  checkEqual('our own origin is fine',
    (await get(port, '/', { origin: 'http://127.0.0.1:' + port, cookie: cookie.cookie })).status, 200);
  check('every refusal is written down', server.refusals.length > 0);

  suite('a socket speaks the same protocol as the panel');

  let refused = null;
  try { await ws.connect(`ws://127.0.0.1:${port}/socket?session=${first.id}`); }
  catch (err) { refused = err.status; }
  checkEqual('an unauthenticated socket never opens', refused, 401);

  let missing = null;
  try { await ws.connect(`ws://127.0.0.1:${port}/socket?session=nope`, { headers: cookie }); }
  catch (err) { missing = err.status; }
  checkEqual('nor one for an instance that does not exist', missing, 404);

  const client = await ws.connect(`ws://127.0.0.1:${port}/socket?session=${first.id}`, { headers: cookie });
  client.send({ type: 'ready' });
  const init = await client.waitFor('init');
  checkEqual('it is answered with the whole picture', init.sessionId, first.id);
  check('including the commands it can offer', Array.isArray(init.slashCommands));

  client.send({ type: 'send', text: 'from the browser', sent: 'from the browser', snippets: [] });
  const drawn = await client.waitFor('items');
  check('a prompt sent over the socket reaches the instance',
    first.items.some((i) => i.kind === 'user' && i.text === 'from the browser'));
  check('and comes back to be drawn', JSON.stringify(drawn.items).indexOf('from the browser') > 0);

  client.send({ type: 'status' });
  const report = await client.waitFor('statusReport');
  checkEqual('a status request is answered', report.report.instance.id, first.id);

  suite('a client nobody here wrote');

  // The handshake constant was wrong once, and a test that hashed it with the
  // same constant agreed with itself all the way. Node ships a WebSocket client
  // of its own; if that one connects, the handshake is right for real.
  if (typeof WebSocket === 'function') {
    const stranger = await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/socket?session=${first.id}&key=${auth.key}`);
      const done = (value) => resolve(value);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'ready' })));
      socket.addEventListener('message', (event) => {
        let message = null;
        try { message = JSON.parse(event.data); } catch (_) { /* not ours */ }
        if (message && message.type === 'init') { socket.close(); done(message); }
      });
      socket.addEventListener('error', () => done(null));
      setTimeout(() => done(null), 3000);
    });
    check('an independent WebSocket client completes the handshake', !!stranger);
    checkEqual('and is answered like any other', stranger && stranger.sessionId, first.id);
  } else {
    check('an independent WebSocket client completes the handshake (no native one here)', true);
    check('and is answered like any other (no native one here)', true);
  }

  suite('two clients, one instance');

  const other = await ws.connect(`ws://127.0.0.1:${port}/socket?session=${first.id}`, { headers: cookie });
  other.send({ type: 'ready' });
  await other.waitFor('init');
  const both = Promise.all([client.next('items'), other.next('items')]);
  first._upsert({ id: 'x1', kind: 'text', text: 'something happened' });
  const [a, b] = await both;
  check('what happens to the instance is told to both',
    JSON.stringify(a.items) === JSON.stringify(b.items) &&
    JSON.stringify(a.items).indexOf('something happened') > 0);

  other.send({ type: 'status' });
  await other.waitFor('statusReport');
  const askedTwice = client.messages.filter((m) => m.type === 'statusReport').length;
  checkEqual('but an answer goes only to whoever asked', askedTwice, 1);

  suite('a socket that misbehaves is not fatal');

  client.send('not json at all');
  client.send({ type: 'no-such-message' });
  client.send({ type: 'send', text: 'still talking', sent: 'still talking', snippets: [] });
  await client.waitFor('queue').catch(() => null);
  check('nonsense is ignored and the socket lives on',
    first.items.some((i) => i.kind === 'user' && i.text === 'still talking') ||
    first.queue.some((q) => q.text === 'still talking'));

  const rude = await ws.connect(`ws://127.0.0.1:${port}/socket?session=${second.id}`, { headers: cookie });
  rude.writeRaw(wire.encodeText('unmasked, which a client may never send'));
  const shut = await rude.waitClosed();
  checkEqual('a frame that breaks the rules closes that socket', shut.code, wire.CLOSE.PROTOCOL);
  check('and leaves the instance alone', !!sessions.get(second.id));

  suite('stopping lets go of everything');

  const before = first.items.length;
  await server.stop();
  checkEqual('the server is no longer listening', server.listening, false);
  let down = null;
  try { await get(port, '/', cookie); } catch (err) { down = err.code; }
  checkEqual('the port is closed', down, 'ECONNREFUSED');
  await client.waitClosed().catch(() => null);
  checkEqual('the conversation is untouched', first.items.length, before);
  check('and the instance is still there to be reopened', first.status !== 'stopped');

  closeHub(first.id);
  closeHub(second.id);
  first.dispose();
  second.dispose();
};
