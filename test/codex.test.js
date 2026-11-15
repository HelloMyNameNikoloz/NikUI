'use strict';

// The Codex workspace: Codex's conversations, driven from NikUI through
// `codex app-server`. A fake app-server stands in for the real one here, so
// what is checked is what NikUI asks for and how it draws the answers.

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { CodexIpc, frame } = require('../src/codexIpc.js');
const { CodexClient, CodexWorkspace, itemFrom, itemsFrom, picturesFor, bareCommand } = require('../src/codex.js');
const { CodexCache } = require('../src/codexCache.js');

/** A child process that answers like `codex app-server`, from a table. */
function fakeServer(answers) {
  const calls = [];
  let proc = null;
  const spawnFn = () => {
    proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => proc.emit('exit', 0);
    let buffer = '';
    proc.stdin.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        calls.push(msg);
        if (msg.id == null || !msg.method) continue;
        const answer = answers[msg.method];
        const result = typeof answer === 'function' ? answer(msg.params) : (answer || {});
        if (result && result.__error) proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: result.__error } }) + '\n');
        else proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      }
    });
    return proc;
  };
  return {
    spawnFn, calls,
    say: (method, params) => proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    ask: (id, method, params) => proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));

const thread = (id, extra) => Object.assign({
  id, name: null, preview: 'Fix the login page', cwd: '/Users/me/Codes/site',
  createdAt: 1000, updatedAt: 2000, status: { type: 'notLoaded' }, ephemeral: false
}, extra);

module.exports = async function () {
  suite('Codex items, drawn the way the panel draws ours');

  checkEqual('the shell wrapper is taken off a command', bareCommand('/bin/zsh -lc "npm test"'), 'npm test');
  checkEqual('and a plain one is left alone', bareCommand('ls -la'), 'ls -la');
  const bash = itemFrom({ type: 'commandExecution', id: 'c1', command: '/bin/zsh -lc \'git status\'', cwd: '/x', status: 'completed', aggregatedOutput: 'clean', exitCode: 0 });
  checkEqual('a command is a Bash tool', [bash.kind, bash.name, bash.input.command, bash.status, bash.result], ['tool', 'Bash', 'git status', 'done', 'clean']);
  check('a failed command is an error', itemFrom({ type: 'commandExecution', id: 'c2', command: 'x', status: 'failed', exitCode: 1 }).isError);
  checkEqual('a message is text', itemFrom({ type: 'agentMessage', id: 'a', text: 'hi' }).kind, 'text');
  checkEqual('a prompt is the user\'s, under the id we sent it with',
    itemFrom({ type: 'userMessage', id: 'u', clientId: 'nik1', content: [{ type: 'text', text: 'go' }] }).id, 'u:nik1');
  checkEqual('reasoning is thinking', itemFrom({ type: 'reasoning', id: 'r', summary: ['plan'], content: [] }).text, 'plan');
  checkEqual('an edit is an Edit', itemFrom({ type: 'fileChange', id: 'f', changes: [{ path: '/a.js', kind: { type: 'update' }, diff: '+x' }], status: 'completed' }).name, 'Edit');
  checkEqual('an MCP call keeps its server and tool', itemFrom({ type: 'mcpToolCall', id: 'm', server: 'gh', tool: 'pr', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } }).name, 'mcp__gh__pr');
  checkEqual('anything unknown is left out', itemFrom({ type: 'somethingNew', id: 'z' }), null);

  suite('pictures Codex works with are sent as data');

  const picDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikcx-'));
  const pic = path.join(picDir, 'shot.png');
  fs.writeFileSync(pic, Buffer.from('89504e470d0a1a0a', 'hex'));
  const big = path.join(picDir, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(600 * 1024, 1));
  let shrunk = 0;
  const pics = new CodexCache({ dir: path.join(picDir, 'cache'),
    shrink: (src, out) => { shrunk += 1; fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'small'); } });
  const filled = (item) => picturesFor(item, pics);

  const reply = itemFrom({ type: 'agentMessage', id: 'a2', text: `![sig](<${pic}>)` });
  check('a reply pointing at a picture on this Mac is drawn as written first', reply.text === `![sig](<${pic}>)` && reply._inline);
  check('then carries it inline', /^!\[sig\]\(data:image\/png;base64,/.test((await filled(reply)).text));
  checkEqual('a missing file is left as written', (await filled(itemFrom({ type: 'agentMessage', id: 'a3', text: '![x](/no/such.png)' }))).text, '![x](/no/such.png)');
  check('and a web picture is not fetched', !itemFrom({ type: 'agentMessage', id: 'a4', text: '![x](https://a.b/c.png)' })._inline);
  const prompt = itemFrom({ type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'look' }, { type: 'localImage', path: pic }] });
  checkEqual('a picture attached to a prompt is shown with it', (await filled(prompt)).images.map((i) => i.mediaType), ['image/png']);
  check('a picture Codex looked at is drawn', /data:image\/png/.test((await filled(itemsFrom({ type: 'imageView', id: 'v', path: pic })[0])).text));
  const generated = await filled(itemsFrom({ type: 'imageGeneration', id: 'g', status: 'completed', revisedPrompt: 'a cat', savedPath: big })[0]);
  check('an image it made is drawn with its prompt, made small', /^\*a cat\*\n\n!\[big\.png\]\(data:image\/jpeg;base64,/.test(generated.text) && shrunk === 1);
  await filled(itemsFrom({ type: 'imageGeneration', id: 'g2', status: 'completed', savedPath: big })[0]);
  checkEqual('and made small only once', shrunk, 1);
  const cua = itemsFrom({ type: 'mcpToolCall', id: 'm2', server: 'cua_repl', tool: 'js', arguments: { code: 'x', title: 'Click send' }, status: 'completed',
    result: { content: [{ type: 'text', text: 'clicked' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] } });
  checkEqual('a computer-use screenshot is drawn after its step', [cua.length, cua[0].result, /data:image\/png;base64,AAAA/.test((await filled(cua[1])).text)], [2, 'clicked\n[screenshot]', true]);

  suite('the Codex workspace lists what Codex has');

  const server = fakeServer({
    'initialize': { userAgent: 'fake' },
    'thread/list': { data: [thread('t1'), thread('t2', { name: 'Redesign', updatedAt: 3000 }), thread('sub', { parentThreadId: 't1' })], nextCursor: null },
    'thread/resume': { thread: thread('t1'), model: 'gpt-test' },
    'thread/turns/list': {
      data: [{
        id: 'turn1', status: 'completed', startedAt: 1500, completedAt: 1600, durationMs: 1000,
        items: [
          { type: 'userMessage', id: 'i1', content: [{ type: 'text', text: 'Fix the login page' }] },
          { type: 'agentMessage', id: 'i2', text: 'Done.' }
        ]
      }],
      nextCursor: null
    },
    'turn/start': { turn: { id: 'turn2', status: 'inProgress', items: [] } },
    'thread/start': { thread: thread('t3', { preview: '' }), model: 'gpt-test' }
  });
  const client = new CodexClient({ codexPath: '/fake/codex', spawnFn: server.spawnFn });
  const ws = new CodexWorkspace({ client, ipc: null });
  await ws.refresh();

  checkEqual('both conversations are there, newest first', ws.list.map((s) => s.id), ['cx-t2', 'cx-t1']);
  check('a sub-agent\'s thread is not a conversation of its own', !ws.get('cx-sub'));
  checkEqual('a named one goes by its name', ws.get('cx-t2').label, 'Redesign');
  checkEqual('an unnamed one by its first prompt', ws.get('cx-t1').label, 'Fix the login page');
  check('every one says it is Codex\'s', ws.list.every((s) => s.provider === 'codex'));
  check('the handshake came first', server.calls[0].method === 'initialize' && server.calls[1].method === 'initialized');

  suite('opening one picks the conversation up');

  const s = ws.get('cx-t1');
  check('not open yet', s.isAsleep);
  await s.start();
  check('open now', !s.isAsleep && s.isRunning);
  checkEqual('its turns are drawn', s.items.map((i) => i.kind), ['user', 'text', 'result']);
  checkEqual('and its model is known', s.meta.model, 'gpt-test');
  checkEqual('it reads as finished', s.status, 'done');

  suite('sending, and what comes back');

  checkEqual('a prompt is sent straight away', s.submit('add a test'), 'sent');
  await tick();
  const sent = server.calls.find((c) => c.method === 'turn/start');
  check('as a turn on that thread', sent && sent.params.threadId === 't1' && sent.params.input[0].text === 'add a test');
  const clientId = sent.params.clientUserMessageId;
  server.say('turn/started', { threadId: 't1', turn: { id: 'turn2', status: 'inProgress' } });
  await tick();
  check('it is working', s.isWorking);
  checkEqual('a second prompt meanwhile waits its turn', s.submit('then this'), 'queued');
  server.say('item/started', { threadId: 't1', turnId: 'turn2', item: { type: 'userMessage', id: 'srv', clientId, content: [{ type: 'text', text: 'add a test' }] } });
  server.say('item/agentMessage/delta', { threadId: 't1', turnId: 'turn2', itemId: 'm2', delta: 'Add' });
  server.say('item/agentMessage/delta', { threadId: 't1', turnId: 'turn2', itemId: 'm2', delta: 'ed.' });
  await tick();
  checkEqual('our own prompt is not drawn twice', s.items.filter((i) => i.kind === 'user' && i.text === 'add a test').length, 1);
  checkEqual('the reply streams in', s.items.find((i) => i.id === 'm2').text, 'Added.');

  server.ask(77, 'item/commandExecution/requestApproval', { threadId: 't1', turnId: 'turn2', itemId: 'c', command: 'rm -rf build' });
  await tick();
  const ask = s.items.find((i) => i.kind === 'permission');
  check('an approval Codex asks for is a permission prompt', ask && ask.input.command === 'rm -rf build' && s.status === 'waiting');
  check('answering it reaches Codex', s.respondToPermission(ask.requestId, true));
  await tick();
  const answer = server.calls.find((c) => c.id === 77 && c.result);
  checkEqual('as an accept', answer && answer.result.decision, 'accept');

  server.ask(78, 'item/permissions/requestApproval', { threadId: 't1', turnId: 'turn2', itemId: 'p', reason: 'fetch deps', permissions: { network: { enabled: true }, fileSystem: null } });
  await tick();
  const reach = s.items.find((i) => i.requestId === '78');
  check('a request for more reach is a permission prompt', reach && reach.name === 'Permissions' && reach.input.network);
  s.respondToPermission('78', true);
  await tick();
  checkEqual('allowing grants what was asked, for the turn', server.calls.find((c) => c.id === 78 && c.result).result, { permissions: { network: { enabled: true } }, scope: 'turn' });

  server.ask(79, 'mcpServer/elicitation/request', { threadId: 't1', turnId: 'turn2', serverName: 'cua', mode: 'form', message: 'Control the screen?' });
  await tick();
  s.respondToPermission('79', true);
  await tick();
  checkEqual('an MCP server asking to go ahead is answered', server.calls.find((c) => c.id === 79 && c.result).result.action, 'accept');

  server.ask(80, 'item/tool/requestUserInput', { threadId: 't1', turnId: 'turn2', itemId: 'q', isBlocking: true,
    questions: [{ id: 'which', header: 'Branch', question: 'Which branch?', options: [{ label: 'main', description: '' }, { label: 'dev', description: '' }] }] });
  await tick();
  check('Codex\'s question is shown, with its options', s.items.some((i) => i.id === 'q:80' && /Which branch\?/.test(i.text) && /- dev/.test(i.text)));
  checkEqual('the next prompt answers it', s.submit('Dev'), 'sent');
  await tick();
  checkEqual('as the option picked', server.calls.find((c) => c.id === 80 && c.result).result, { answers: { which: { answers: ['dev'] } } });
  checkEqual('and is not sent as a new turn', server.calls.filter((c) => c.method === 'turn/start').length, 1);

  server.say('turn/completed', { threadId: 't1', turn: { id: 'turn2', status: 'completed', items: [] } });
  await tick(30);
  checkEqual('when the turn ends the queue moves on', server.calls.filter((c) => c.method === 'turn/start').length, 2);
  checkEqual('and nothing is left waiting', s.queue.length, 0);

  suite('a new Codex conversation');

  const made = await ws.create({ cwd: '/Users/me/Codes/site' });
  check('starts open, in the folder asked for', made.id === 'cx-t3' && !made.isAsleep && made.cwd === '/Users/me/Codes/site');
  const started = server.calls.find((c) => c.method === 'thread/start');
  checkEqual('Codex was asked for it there', started.params.cwd, '/Users/me/Codes/site');

  suite('when Codex goes away');

  server.say('turn/started', { threadId: 't1', turn: { id: 'turn3', status: 'inProgress' } });
  await tick();
  client.proc.emit('exit', 1);
  await tick();
  check('a turn in flight is marked stopped, not left spinning', s.status === 'stopped' && !s.inTurn);
  check('and the conversation will reopen next time', s.isAsleep);

  ws.dispose();

  suite('a conversation opened before opens from what was kept');

  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikkeep-'));
  const reads = [];
  let history = [
    { id: 'k1', status: 'completed', items: [{ type: 'agentMessage', id: 'x1', text: 'First answer' }] },
    { id: 'k2', status: 'completed', items: [{ type: 'agentMessage', id: 'x2', text: 'Second answer' }] }
  ];
  const keeper = () => fakeServer({
    'initialize': {},
    'thread/list': { data: [thread('kept')], nextCursor: null },
    'thread/resume': { thread: thread('kept') },
    'thread/turns/list': (q) => { reads.push(q.limit); return { data: history.slice().reverse().slice(0, q.limit), nextCursor: null }; }
  });
  const open = async (opts) => {
    const srv = keeper();
    const w = new CodexWorkspace({ client: new CodexClient({ codexPath: '/fake/codex', spawnFn: srv.spawnFn }), ipc: null,
      cache: new CodexCache(Object.assign({ dir: keepDir, writeDelayMs: 0 }, opts)) });
    await w.refresh();
    return w;
  };
  const w1 = await open();
  await w1.get('cx-kept').start();
  await tick(30);
  w1.dispose();
  checkEqual('the first time, the latest turns are read in full', reads, [40]);
  check('and kept on disk', fs.existsSync(path.join(keepDir, 'threads', 'kept.json')));

  history.push({ id: 'k3', status: 'completed', items: [{ type: 'agentMessage', id: 'x3', text: 'Third answer' }] });
  const w2 = await open();
  const again = w2.get('cx-kept');
  const opening = again.start();
  check('the next time, what was kept is on screen before Codex answers', again.items.some((i) => i.text === 'Second answer'));
  await opening;
  checkEqual('and only the newest turns are read', reads.slice(1), [5]);
  checkEqual('which adds what is new, in order', again.items.filter((i) => i.kind === 'text').map((i) => i.text), ['First answer', 'Second answer', 'Third answer']);
  await tick(30);
  w2.dispose();

  const kept = JSON.parse(fs.readFileSync(path.join(keepDir, 'threads', 'kept.json'), 'utf8'));
  kept.savedAt = Date.now() - 8 * 24 * 3600 * 1000;
  fs.writeFileSync(path.join(keepDir, 'threads', 'kept.json'), JSON.stringify(kept));
  const w3 = await open();
  await w3.get('cx-kept').start();
  checkEqual('after a week it is read in full again', reads.slice(2), [40]);
  await tick(30);
  w3.dispose();

  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(keepDir, 'threads', 'kept.json'), old, old);
  new CodexCache({ dir: keepDir }).sweep();
  check('and a conversation not opened for a week is forgotten', !fs.existsSync(path.join(keepDir, 'threads', 'kept.json')));

  suite('a conversation the ChatGPT app has open');

  let locked = true;
  const held = fakeServer({
    'initialize': {},
    'thread/list': { data: [thread('busy')], nextCursor: null },
    'thread/resume': () => (locked ? { __error: 'thread busy already has an active writer' } : { thread: thread('busy') }),
    'thread/turns/list': { data: [{ id: 'old', status: 'completed', items: [{ type: 'agentMessage', id: 'x1', text: 'Earlier answer' }] }], nextCursor: null },
    'turn/start': { turn: { id: 'new', status: 'inProgress', items: [] } }
  });
  const ws2 = new CodexWorkspace({ client: new CodexClient({ codexPath: '/fake/codex', spawnFn: held.spawnFn }), ipc: null });
  await ws2.refresh();
  const busy = ws2.get('cx-busy');
  await busy.start();
  await busy.start();
  check('still shows its history', busy.items.some((i) => i.text === 'Earlier answer'));
  check('and says it is read-only here, not that it failed', busy.readOnly && busy.status !== 'error');
  checkEqual('once, however often it is opened', busy.items.filter((i) => i.kind === 'notice').length, 1);
  checkEqual('a prompt waits rather than failing', busy.submit('carry on'), 'queued');
  await tick();
  checkEqual('nothing is sent while the app holds it', held.calls.filter((c) => c.method === 'turn/start').length, 0);
  locked = false;
  ws2.get('cx-busy').update(thread('busy', { updatedAt: 9999 }));
  await tick(50);
  check('once the app lets go, the waiting prompt goes out', held.calls.some((c) => c.method === 'turn/start' && c.params.input[0].text === 'carry on'));
  check('and it is writable here', !busy.readOnly);
  ws2.dispose();

  suite('a conversation the ChatGPT app has open is sent through the app');

  // A stand-in for the app's IPC router: it introduces us, says who owns a
  // thread, and records what it is asked to send.
  const asked = [];
  let ownsIt = true;
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nikipc-')), 'ipc.sock');
  const router = net.createServer((conn) => {
    let buf = Buffer.alloc(0);
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8'));
        buf = buf.subarray(4 + buf.readUInt32LE(0));
        asked.push(msg);
        if (msg.type !== 'request') continue;
        const ok = (result, from) => conn.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', method: msg.method, handledByClientId: from || 'app', result }));
        if (msg.method === 'initialize') ok({ clientId: 'nik-client' }, 'router');
        else if (msg.method === 'thread-owner-discovery') {
          if (ownsIt) ok({ supportsUntrustedAppInput: true }, 'app-window');
          else conn.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'error', error: 'no-client-found' }));
        } else ok({ result: {} }, 'app-window');
      }
    });
    // The router asks every client whether it can handle a request.
    conn.write(frame({ type: 'client-discovery-request', requestId: 'd1', request: { method: 'x' } }));
  });
  await new Promise((r) => router.listen(sockPath, r));

  let appTurn = 'done';
  const viaApp = fakeServer({
    'initialize': {},
    'thread/list': { data: [thread('own')], nextCursor: null },
    'thread/resume': { __error: 'thread own already has an active writer' },
    'thread/turns/list': () => ({ data: [{ id: 'later', status: appTurn === 'running' ? 'inProgress' : 'completed', items: [] }], nextCursor: null })
  });
  const ws3 = new CodexWorkspace({ client: new CodexClient({ codexPath: '/fake/codex', spawnFn: viaApp.spawnFn }), ipc: new CodexIpc({ sockPath }) });
  await ws3.refresh();
  const own = ws3.get('cx-own');
  await own.start();
  check('it reads as the app\'s', own.readOnly);
  appTurn = 'running';
  own.submit('ship it');
  await tick(150);
  check('we answered the router\'s question with no', asked.some((m) => m.type === 'client-discovery-response' && m.response.canHandle === false));
  const handed = asked.find((m) => m.method === 'thread-follower-start-turn');
  check('the prompt is handed to the window that has it', handed && handed.targetClientId === 'app-window' && handed.sourceClientId === 'nik-client');
  checkEqual('as a turn on that conversation', handed && [handed.params.conversationId, handed.params.turnStart.request.input[0].text, handed.version], ['own', 'ship it', 2]);
  check('it is shown as sent and working', own.items.some((i) => i.kind === 'user' && i.text === 'ship it') && own.isWorking && !own.queue.length);
  check('and nothing went to Codex directly', !viaApp.calls.some((c) => c.method === 'turn/start'));
  await tick(1700);
  check('the turn the app runs is followed', own.inTurn);
  own.interrupt();
  await tick(50);
  const stop = asked.find((m) => m.method === 'thread-follower-interrupt-turn');
  checkEqual('stopping it asks the app', stop && [stop.params.expectedTurnId, stop.version], ['later', 4]);
  appTurn = 'done';
  await tick(1700);
  check('and when it ends, it is done here too', !own.inTurn && own.status === 'done');

  ownsIt = false;
  ws3.ipc._owners.clear();
  own.submit('one more');
  await tick(150);
  checkEqual('when no app window has it, the prompt waits in the queue', own.queue.length, 1);
  ws3.dispose();
  own.dispose();
  router.close();
};
