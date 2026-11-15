'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { CodexClient, CodexWorkspace, CODEX_COMMANDS } = require('../src/codex.js');

/** A child process that answers from a table and records the wire messages. */
function fakeServer(answers) {
  const calls = [];
  let proc;
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
        const finish = (value) => {
          const reply = value && value.__error
            ? { error: { code: -32600, message: value.__error } } : { result: value };
          proc.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', id: msg.id }, reply)) + '\n');
        };
        if (result && typeof result.then === 'function') result.then(finish, (err) => finish({ __error: err.message }));
        else finish(result);
      }
    });
    return proc;
  };
  return {
    spawnFn, calls,
    say: (method, params) => proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    exit: () => proc.emit('exit', 1)
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const thread = (id) => ({ id, cwd: '/tmp/nikui-commands', createdAt: 1000, updatedAt: 2000,
  preview: 'Check commands', status: { type: 'notLoaded' }, ephemeral: false });
const model = (id, efforts, extra) => Object.assign({ id, model: id, displayName: id,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })) }, extra);

/** Keep each test's history separate from the user's on-disk cache. */
async function fixture(extra, open) {
  const kept = new Map();
  const cache = { sweep() {}, read: (id) => kept.get(id), write: (id, value) => kept.set(id, value) };
  const answers = Object.assign({
    initialize: {},
    'thread/list': { data: [thread('cmd')], nextCursor: null },
    'thread/resume': { thread: thread('cmd'), model: 'gpt-test', reasoningEffort: 'medium' },
    'thread/turns/list': { data: [], nextCursor: null },
    'thread/goal/get': { goal: null },
    'turn/start': { turn: { id: 'running', status: 'inProgress', items: [] } },
    'turn/steer': { turnId: 'running' },
    'model/list': { data: [model('gpt-test', ['low', 'medium', 'high'], { isDefault: true }),
      model('gpt-other', ['medium', 'high', 'xhigh', 'max', 'ultra'])], nextCursor: null }
  }, extra);
  const server = fakeServer(answers);
  const client = new CodexClient({ codexPath: '/fake/codex', spawnFn: server.spawnFn });
  const ws = new CodexWorkspace({ client, ipc: null, cache });
  await ws.refresh();
  const s = ws.get('cx-cmd');
  if (open !== false) await s.start();
  const calls = (method) => server.calls.filter((c) => c.method === method);
  const command = async (text) => { s.submit(text); await tick(); };
  const notice = () => s.items.filter((i) => i.kind === 'notice').slice(-1)[0];
  return { answers, server, client, ws, s, calls, command, notice, kept };
}

module.exports = async function () {
  suite('Codex slash commands stay out of model input');
  checkEqual('the supported commands are exported', CODEX_COMMANDS,
    ['plan', 'goal', 'review', 'fork', 'undo', 'model', 'effort', 'steer']);
  {
    const { ws, s, calls, command, notice } = await fixture(null, false);
    checkEqual('commands are advertised before opening a thread', s.meta.slashCommands, CODEX_COMMANDS);
    checkEqual('the handshake enables the experimental protocol', calls('initialize')[0].params.capabilities.experimentalApi, true);
    checkEqual('plan starts in default mode', s.meta.mode, 'default');
    checkEqual('a command is accepted before the thread loads', s.submit('/plan on'), 'sent');
    await tick();
    await s.start();
    checkEqual('opening preserves the selected plan mode', s.meta.mode, 'plan');
    let meta = 0;
    s.on('meta', () => { meta += 1; });
    await command('/plan');
    checkEqual('plan alone toggles it off', s.meta.mode, 'default');
    await command('/plan on');
    checkEqual('plan on enables plan mode', s.meta.mode, 'plan');
    await command('/plan off');
    checkEqual('plan off disables it', s.meta.mode, 'default');
    check('mode changes notify listeners', meta >= 3);
    await command('/plan maybe');
    checkEqual('bad plan arguments preserve the mode', s.meta.mode, 'default');
    check('bad plan arguments produce a notice', notice() && /plan|on|off/i.test(notice().text));
    await command('/steer');
    check('empty steer produces a notice', notice() && /steer|text|message/i.test(notice().text));
    await command('/unknown');
    checkEqual('slash commands never become model turns', calls('turn/start').length, 0);
    s._question = { id: 52, questions: [{ id: 'answer', question: 'Continue?' }] };
    await command('/plan on');
    check('commands do not answer an outstanding model question', s._question && s._question.id === 52);
    ws.dispose();
  }

  suite('Codex plan and model settings follow turns and server updates');
  {
    const { ws, s, server, calls, command, notice } = await fixture();
    await command('/plan on');
    s.submit('make a plan');
    await tick();
    const sent = calls('turn/start')[0];
    checkEqual('turns carry the selected model and effort', sent && [sent.params.model, sent.params.effort], ['gpt-test', 'medium']);
    checkEqual('plan mode uses collaborationMode settings', sent && sent.params.collaborationMode,
      { mode: 'plan', settings: { model: 'gpt-test', reasoning_effort: 'medium', developer_instructions: null } });
    check('turn input contains the prompt without a command', sent && sent.params.input[0].text === 'make a plan');
    let meta = 0;
    s.on('meta', () => { meta += 1; });
    server.say('thread/settings/updated', { threadId: 'cmd', threadSettings: {
      model: 'gpt-other', effort: 'high', collaborationMode: { mode: 'default', settings: {
        model: 'gpt-other', reasoning_effort: 'high', developer_instructions: null } } } });
    checkEqual('server settings update model, effort and mode', [s.meta.model, s.model, s.effort, s.meta.mode],
      ['gpt-other', 'gpt-other', 'high', 'default']);
    check('server settings emit meta', meta > 0);
    await command('/plan on');
    checkEqual('commands during a turn do not enter the queue', s.queue.length, 0);
    check('commands during a turn still report their result', notice() && /plan/i.test(notice().text));
    ws.dispose();
  }

  suite('Codex goals follow replies and notifications');
  {
    let goal = { objective: 'Finish the tests', status: 'paused', tokenBudget: 123 };
    const { ws, s, server, calls, command, notice } = await fixture({
      'thread/goal/get': () => ({ goal }),
      'thread/goal/set': (p) => {
        goal = { objective: p.objective || goal.objective, status: p.status || 'active' };
        return { goal };
      },
      'thread/goal/clear': () => { goal = null; return { cleared: true }; }
    });
    checkEqual('opening reads the goal once', calls('thread/goal/get').length, 1);
    checkEqual('only the goal fields the UI needs are exposed', s.meta.goal, { objective: 'Finish the tests', status: 'paused' });
    let meta = 0;
    s.on('meta', () => { meta += 1; });
    await command('/goal');
    check('goal alone shows its objective and status', notice() && /Finish the tests/.test(notice().text) && /paused/i.test(notice().text));
    await command('/goal Ship the new commands');
    checkEqual('setting a goal uses explicit user provenance', calls('thread/goal/set')[0].params,
      { threadId: 'cmd', objective: 'Ship the new commands', status: 'active', origin: 'user' });
    checkEqual('setting a goal updates meta from the response', s.meta.goal, { objective: 'Ship the new commands', status: 'active' });
    for (const [commandName, status] of [['pause', 'paused'], ['resume', 'active'], ['done', 'complete']]) {
      await command('/goal ' + commandName);
      const request = calls('thread/goal/set').slice(-1)[0];
      checkEqual('goal ' + commandName + ' uses the protocol status', request && [request.params.threadId, request.params.status, request.params.origin],
        ['cmd', status, 'user']);
      checkEqual('goal ' + commandName + ' is reflected in meta', s.meta.goal && s.meta.goal.status, status);
    }
    server.say('thread/goal/updated', { threadId: 'cmd', goal: { objective: 'Changed elsewhere', status: 'blocked', tokenBudget: 100 } });
    checkEqual('external goal updates reach meta', s.meta.goal, { objective: 'Changed elsewhere', status: 'blocked' });
    const beforeOther = meta;
    server.say('thread/goal/cleared', { threadId: 'another-thread' });
    checkEqual('another thread cannot clear this goal', meta, beforeOther);
    server.say('thread/goal/cleared', { threadId: 'cmd' });
    checkEqual('a goal cleared elsewhere is removed', s.meta.goal, null);
    await command('/goal clear');
    checkEqual('clear uses explicit user provenance', calls('thread/goal/clear').slice(-1)[0].params, { threadId: 'cmd', origin: 'user' });
    check('goal changes emit meta', meta >= 5);
    await command('/goal');
    check('an absent goal is reported', notice() && /no .*goal|no goal|not set/i.test(notice().text));
    checkEqual('goal commands never start model turns', calls('turn/start').length, 0);
    ws.dispose();
  }

  suite('Codex model catalog and effort validation');
  {
    const { ws, s, calls, command, notice } = await fixture();
    let meta = 0;
    s.on('meta', () => { meta += 1; });
    await command('/model');
    const listing = notice() && notice().text;
    check('model lists include the available models', listing && listing.includes('gpt-test') && listing.includes('gpt-other'));
    check('model lists mark the current model', listing && /current|\*|✓|●/i.test(listing));
    await command('/model');
    checkEqual('the workspace caches the model catalog', calls('model/list').length, 1);
    await command('/effort high');
    checkEqual('effort alone selects a supported effort', s.effort, 'high');
    check('effort changes notify listeners', meta > 0);
    await command('/effort ultra');
    checkEqual('unsupported effort preserves the previous value', s.effort, 'high');
    check('unsupported effort explains the supported values', notice() && /support|low|medium|high/i.test(notice().text));
    await command('/effort impossible');
    checkEqual('unknown effort is rejected', s.effort, 'high');
    await command('/model unknown');
    checkEqual('unknown model preserves the current choice', s.meta.model, 'gpt-test');
    await command('/model gpt-other ultra');
    checkEqual('model and supported effort change together', [s.meta.model, s.model, s.effort], ['gpt-other', 'gpt-other', 'ultra']);
    check('model changes notify listeners', meta > 1);
    await command('/model gpt-test ultra');
    checkEqual('invalid effort cannot partially change the model', [s.meta.model, s.effort], ['gpt-other', 'ultra']);
    await command('/model gpt-test');
    checkEqual('a model switch uses its default when the old effort is unsupported', [s.meta.model, s.effort], ['gpt-test', 'medium']);
    await command('/model gpt-other max');
    s.submit('use this model');
    await tick();
    const sent = calls('turn/start')[0];
    checkEqual('future turns use the chosen model and effort', sent && [sent.params.model, sent.params.effort], ['gpt-other', 'max']);
    checkEqual('collaboration settings use the same model and effort', sent && sent.params.collaborationMode && sent.params.collaborationMode.settings,
      { model: 'gpt-other', reasoning_effort: 'max', developer_instructions: null });
    ws.dispose();
  }
  {
    const { ws, calls, command, notice } = await fixture({
      'model/list': (p) => p.cursor ? { data: [model('last-model', ['medium'])], nextCursor: null }
        : { data: [model('first-model', ['medium'])], nextCursor: 'next-model-page' }
    });
    await command('/model');
    checkEqual('the whole model catalog is read', calls('model/list').length, 2);
    check('later model pages appear in the list', notice() && notice().text.includes('last-model'));
    ws.dispose();
  }

  suite('Codex reviews stream inline');
  for (const [commandText, target] of [
    ['/review', { type: 'uncommittedChanges' }],
    ['/review main', { type: 'baseBranch', branch: 'main' }],
    ['/review commit abc123', { type: 'commit', sha: 'abc123' }]
  ]) {
    const { ws, s, server, calls, command, notice } = await fixture({
      'review/start': { reviewThreadId: 'cmd', turn: { id: 'review-turn', status: 'inProgress', items: [] } }
    });
    await command(commandText);
    checkEqual(commandText + ' selects its inline target', calls('review/start')[0] && calls('review/start')[0].params,
      { threadId: 'cmd', target, delivery: 'inline' });
    checkEqual(commandText + ' records the active review turn', s.turnId, 'review-turn');
    check(commandText + ' reports the review started', notice() && /review/i.test(notice().text));
    server.say('item/agentMessage/delta', { threadId: 'cmd', turnId: 'review-turn', itemId: 'review-reply', delta: 'Found an issue.' });
    check(commandText + ' streams into this conversation', s.items.some((i) => i.text === 'Found an issue.'));
    checkEqual(commandText + ' is never ordinary model text', calls('turn/start').length, 0);
    ws.dispose();
  }
  {
    const { ws, s, calls, command, notice } = await fixture();
    await command('/review commit');
    checkEqual('a commit review needs a sha', calls('review/start').length, 0);
    s.turnId = 'already-running';
    await command('/review');
    checkEqual('a review cannot overlap a running turn', calls('review/start').length, 0);
    check('an overlapping review explains why it did not start', notice() && /turn|running|finish|busy/i.test(notice().text));
    ws.dispose();
  }

  suite('Codex forks become loaded conversations');
  {
    const history = [{ id: 'inherited', status: 'completed', items: [{ type: 'agentMessage', id: 'inherited-answer', text: 'Earlier answer' }] }];
    const { ws, s, calls, command, notice } = await fixture({
      'thread/fork': { thread: Object.assign(thread('forked'), { turns: history }), model: 'gpt-other', reasoningEffort: 'high' },
      'thread/turns/list': (p) => ({ data: p.threadId === 'forked' ? history : [], nextCursor: null })
    });
    let opened;
    s.on('open', (id) => { opened = id; });
    await command('/fork');
    const fork = ws.get('cx-forked');
    checkEqual('fork requests the original thread', calls('thread/fork')[0] && calls('thread/fork')[0].params.threadId, 'cmd');
    check('forked thread is adopted and loaded', fork && fork.loaded && fork.isRunning);
    checkEqual('open tells the UI where to navigate', opened, 'cx-forked');
    checkEqual('fork keeps the returned model and effort', fork && [fork.meta.model, fork.effort], ['gpt-other', 'high']);
    check('forked history is available immediately', fork && fork.items.some((i) => i.text === 'Earlier answer'));
    check('fork reports its result', notice() && /fork/i.test(notice().text));
    ws.dispose();
  }

  suite('Codex undo redraws retained conversation history');
  {
    let history = [
      { id: 'last-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'removed-answer', text: 'Remove this' }] },
      { id: 'first-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'kept-answer', text: 'Keep this' }] }
    ];
    const { ws, s, calls, command, notice, kept } = await fixture({
      'thread/turns/list': () => ({ data: history, nextCursor: null }),
      'thread/revert': () => { history = history.slice(1); return { thread: Object.assign(thread('cmd'), { turns: [] }) }; }
    });
    let resets = 0;
    s.on('reset', () => { resets += 1; });
    await command('/undo');
    checkEqual('undo reverts before the most recent turn', calls('thread/revert')[0] && calls('thread/revert')[0].params,
      { threadId: 'cmd', beforeTurnId: 'last-turn' });
    check('retained answers are redrawn', s.items.some((i) => i.text === 'Keep this'));
    check('removed answers and results leave the conversation', !s.items.some((i) => i.id === 'removed-answer' || i.id === 'r:last-turn'));
    check('undo tells existing clients to reset', resets > 0);
    checkEqual('removed turns are gone from the cache too', kept.get('cmd').turns.map((t) => t.id), ['first-turn']);
    checkEqual('turn count reflects the retained history', s.turns, 1);
    check('undo states that files are not reverted', notice() && /files.*not.*revert|not.*revert.*files/i.test(notice().text));
    s.turnId = 'running';
    await command('/undo');
    checkEqual('undo does not run during a turn', calls('thread/revert').length, 1);
    ws.dispose();
  }
  {
    const { ws, calls, command, notice } = await fixture();
    await command('/undo');
    checkEqual('there is nothing to revert in an empty thread', calls('thread/revert').length, 0);
    check('empty undo is explained', notice() && /nothing|no .*turn/i.test(notice().text));
    ws.dispose();
  }

  suite('Codex steering sends input into the active turn');
  {
    const { ws, s, server, calls, command, notice } = await fixture();
    s.submit('start work');
    await tick();
    await command('/steer focus on tests');
    const steer = calls('turn/steer')[0];
    checkEqual('steering identifies the active turn', steer && [steer.params.threadId, steer.params.expectedTurnId], ['cmd', 'running']);
    checkEqual('steering strips the command prefix', steer && steer.params.input.map((i) => [i.type, i.text]), [['text', 'focus on tests']]);
    check('steering shows the input as the user message', s.items.some((i) => i.kind === 'user' && i.text === 'focus on tests'));
    checkEqual('steering neither queues nor starts another turn', [s.queue.length, calls('turn/start').length], [0, 1]);
    check('steering reports the result', notice() && /steer|sent/i.test(notice().text));
    server.say('item/started', { threadId: 'cmd', turnId: 'running', item: { type: 'userMessage', id: 'steered-user',
      clientId: steer && steer.params.clientUserMessageId, content: [{ type: 'text', text: 'focus on tests' }] } });
    checkEqual('the steered user message is not duplicated by its server echo', s.items.filter((i) => i.kind === 'user' && i.text === 'focus on tests').length, 1);
    ws.dispose();
  }
  {
    const { ws, s, calls, command } = await fixture();
    await command('/steer start here');
    checkEqual('idle steering starts a normal turn', calls('turn/start')[0] && calls('turn/start')[0].params.input[0].text, 'start here');
    checkEqual('idle steering does not use turn/steer', calls('turn/steer').length, 0);
    check('idle steering draws only the message text', s.items.some((i) => i.kind === 'user' && i.text === 'start here'));
    ws.dispose();
  }
  {
    const { ws, s, answers, calls, notice } = await fixture();
    s.submit('start work');
    await tick();
    s.submit('first queued');
    s.submit('second queued', [{ mediaType: 'image/png', data: 'AAAA' }], { sent: 'expanded second', snippets: ['snippet'] });
    const first = s.queue[0].id;
    const second = s.queue[1].id;
    s.promote(second);
    await tick();
    const steer = calls('turn/steer')[0];
    checkEqual('send now removes only the selected queued input', s.queue.map((q) => q.id), [first]);
    check('send now retains expanded text and attachments', steer && steer.params.input[0].text === 'expanded second' && steer.params.input.some((i) => i.type === 'image'));
    check('send now keeps the displayed text and snippets', s.items.some((i) => i.kind === 'user' && i.text === 'second queued' && i.snippets[0] === 'snippet'));
    s.promote(first);
    await tick();
    checkEqual('the first queue entry can also be sent now', [s.queue.length, calls('turn/steer').length], [0, 2]);
    s.submit('keep on failure');
    const failedId = s.queue[0].id;
    answers['turn/steer'] = { __error: 'active turn changed' };
    s.promote(failedId);
    await tick();
    check('a failed send now keeps its queued prompt', s.queue.some((q) => q.id === failedId));
    check('a failed send now is reported', notice() && /active turn changed/.test(notice().text));
    ws.dispose();
  }

  suite('Codex computer use is visible while its MCP call runs');
  {
    const { ws, s, server } = await fixture();
    let meta = 0;
    s.on('meta', () => { meta += 1; });
    const call = (id, title, status, serverName) => ({ type: 'mcpToolCall', id, server: serverName || 'cua_repl', tool: 'js', arguments: title ? { title } : {}, status });
    const say = (method, item) => server.say(method, { threadId: 'cmd', turnId: 'running', item });
    s.turnId = 'running';
    const before = Date.now();
    say('item/started', call('mac-a', 'Click Save', 'inProgress'));
    check('computer use records when it began', s.meta.usingMac && s.meta.usingMac.since >= before && s.meta.usingMac.since <= Date.now());
    checkEqual('computer use displays the call title', s.meta.usingMac && s.meta.usingMac.title, 'Click Save');
    const afterStart = meta;
    say('item/completed', call('unrelated', 'Other tool', 'completed', 'github'));
    checkEqual('unrelated tool completion leaves computer use active', meta, afterStart);
    say('item/started', call('mac-b', 'Type a name', 'inProgress'));
    say('item/completed', call('mac-a', 'Click Save', 'completed'));
    check('another running computer call keeps the indicator active', s.meta.usingMac && s.meta.usingMac.title === 'Type a name');
    say('item/completed', call('mac-b', 'Type a name', 'completed'));
    checkEqual('computer use clears after its last call completes', s.meta.usingMac, null);
    say('item/started', call('mac-c', null, 'inProgress'));
    check('calls without a title are still shown', s.meta.usingMac && typeof s.meta.usingMac.since === 'number');
    s.interrupt();
    checkEqual('interrupt clears computer use immediately', s.meta.usingMac, null);
    say('item/started', call('mac-d', 'Read screen', 'inProgress'));
    server.say('turn/completed', { threadId: 'cmd', turn: { id: 'running', status: 'completed', items: [] } });
    checkEqual('turn completion clears computer use', s.meta.usingMac, null);
    await tick();
    s.turnId = 'again';
    say('item/started', call('mac-e', 'Open app', 'inProgress'));
    server.exit();
    checkEqual('process exit clears computer use', s.meta.usingMac, null);
    check('computer-use changes emit meta events', meta >= 8);
    ws.dispose();
  }

  suite('Codex command errors stay in the conversation');
  for (const [commandText, method] of [['/goal next task', 'thread/goal/set'], ['/review', 'review/start'],
    ['/fork', 'thread/fork'], ['/model', 'model/list'], ['/steer redirect', 'turn/steer']]) {
    const { ws, s, calls, command, notice } = await fixture({ [method]: { __error: 'server refused this command' } });
    if (method === 'turn/steer') s.turnId = 'running';
    await command(commandText);
    check(commandText + ' errors are visible', notice() && notice().text.includes('server refused this command'));
    checkEqual(commandText + ' errors never fall back to model text', calls('turn/start').length, 0);
    ws.dispose();
  }

  suite('Codex delayed replies preserve command order and history');
  {
    let release;
    const catalog = new Promise((resolve) => { release = resolve; });
    const { ws, s, calls } = await fixture({ 'model/list': () => catalog });
    s.submit('/model gpt-other max');
    s.submit('use the new settings immediately');
    await tick();
    checkEqual('ordinary input waits for an earlier model command', calls('turn/start').length, 0);
    release({ data: [model('gpt-other', ['medium', 'max'])], nextCursor: null });
    await tick();
    const sent = calls('turn/start')[0];
    checkEqual('the waiting input gets the newly selected settings', sent && [sent.params.model, sent.params.effort], ['gpt-other', 'max']);
    checkEqual('only the ordinary input is sent after the command', sent && sent.params.input[0].text, 'use the new settings immediately');
    ws.dispose();
  }
  {
    let release;
    const reply = new Promise((resolve) => { release = resolve; });
    const { ws, s, server, calls } = await fixture({ 'turn/steer': () => reply });
    s.turnId = 'running';
    s.submit('/steer use this direction');
    await tick();
    const steer = calls('turn/steer')[0];
    server.say('item/started', { threadId: 'cmd', turnId: 'running', item: {
      type: 'userMessage', id: 'early-steer-echo', clientId: steer && steer.params.clientUserMessageId,
      content: [{ type: 'text', text: 'use this direction' }] } });
    release({ turnId: 'running' });
    await tick();
    checkEqual('an early steer echo draws one user message', s.items.filter((i) => i.kind === 'user' && i.text === 'use this direction').length, 1);
    ws.dispose();
  }
  {
    let release;
    const reply = new Promise((resolve) => { release = resolve; });
    const { ws, s, server, calls } = await fixture({ 'turn/steer': () => reply });
    s.turnId = 'running';
    s.submit('send this now');
    const id = s.queue[0].id;
    s.promote(id);
    await tick();
    server.say('turn/completed', { threadId: 'cmd', turn: { id: 'running', status: 'completed', items: [] } });
    await tick();
    checkEqual('a turn ending cannot also drain an input being steered', calls('turn/start').length, 0);
    release({ turnId: 'running' });
    await tick();
    checkEqual('successful steering removes the queued input after the turn ends', s.queue.length, 0);
    checkEqual('send now is delivered once across the turn boundary', [calls('turn/steer').length, calls('turn/start').length], [1, 0]);
    ws.dispose();
  }
  {
    let history = [
      { id: 'old-last', status: 'completed', items: [{ type: 'agentMessage', id: 'stale-answer', text: 'Stale answer' }] },
      { id: 'old-first', status: 'completed', items: [{ type: 'agentMessage', id: 'retained-answer', text: 'Retained answer' }] }
    ];
    let release;
    const reply = new Promise((resolve) => { release = resolve; });
    const { ws, s, answers, command, kept } = await fixture({
      'thread/turns/list': () => ({ data: history, nextCursor: null }),
      'thread/revert': () => { history = history.slice(1); return { thread: thread('cmd') }; }
    });
    const stale = history.slice();
    answers['thread/turns/list'] = (p) => p.limit === 5 ? reply : { data: history, nextCursor: null };
    const loading = s._loadTurns(false);
    await tick();
    await command('/undo');
    release({ data: stale, nextCursor: null });
    await loading;
    check('a read started before undo cannot redraw removed history', !s.items.some((i) => i.id === 'stale-answer'));
    checkEqual('a stale history reply cannot restore the removed cached turn', kept.get('cmd').turns.map((t) => t.id), ['old-first']);
    ws.dispose();
  }
  {
    const { ws, s, command, notice } = await fixture({ 'thread/goal/get': { __error: 'goals unavailable' } });
    check('unsupported goals do not prevent opening a conversation', s.loaded && s.status !== 'error');
    checkEqual('unsupported goal loading is silent', s.items.filter((i) => i.kind === 'notice').length, 0);
    await command('/goal');
    check('an explicit unavailable goal command explains the error', notice() && /goals unavailable/.test(notice().text));
    ws.dispose();
  }
  {
    let release;
    const reply = new Promise((resolve) => { release = resolve; });
    const { ws, s, server } = await fixture({ 'thread/goal/get': () => reply }, false);
    const opening = s.start();
    await tick();
    server.say('thread/goal/updated', { threadId: 'cmd', goal: { objective: 'New goal while opening', status: 'active' } });
    release({ goal: null });
    await opening;
    checkEqual('an old goal read cannot replace a newer goal notification', s.meta.goal, { objective: 'New goal while opening', status: 'active' });
    ws.dispose();
  }

  suite('Codex goal objectives are plain text');
  {
    const { ws, s, calls, command } = await fixture({
      'thread/goal/set': (p) => ({ goal: { objective: p.objective, status: 'active' } })
    });
    for (const objective of ['constructor', 'toString', '__proto__']) {
      await command('/goal ' + objective);
      const request = calls('thread/goal/set').slice(-1)[0];
      checkEqual(objective + ' is sent as the goal objective', request && request.params.objective, objective);
      checkEqual(objective + ' is exposed as the current objective', s.meta.goal && s.meta.goal.objective, objective);
    }
    ws.dispose();
  }

  suite('Codex pending settings survive delayed server state');
  {
    const oldSettings = { model: 'gpt-test', effort: 'medium', collaborationMode: { mode: 'default', settings: {
      model: 'gpt-test', reasoning_effort: 'medium', developer_instructions: null } } };
    const { ws, s, server, calls, command } = await fixture();
    await command('/plan on');
    await command('/model gpt-other ultra');
    server.say('thread/settings/updated', { threadId: 'cmd', threadSettings: oldSettings });
    checkEqual('old server settings preserve the choices for the following turn', [s.meta.mode, s.meta.model, s.effort], ['plan', 'gpt-other', 'ultra']);
    s.submit('run with my chosen settings');
    await tick();
    const sent = calls('turn/start')[0];
    checkEqual('the following turn carries the preserved choices', sent && [sent.params.model, sent.params.effort,
      sent.params.collaborationMode && sent.params.collaborationMode.mode], ['gpt-other', 'ultra', 'plan']);
    server.say('thread/settings/updated', { threadId: 'cmd', threadSettings: { model: 'gpt-other', effort: 'ultra',
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-other', reasoning_effort: 'ultra', developer_instructions: null } } } });
    server.say('thread/settings/updated', { threadId: 'cmd', threadSettings: oldSettings });
    checkEqual('after acknowledgement later external choices can take effect', [s.meta.mode, s.meta.model, s.effort], ['default', 'gpt-test', 'medium']);
    ws.dispose();
  }
  {
    const { ws, s, command } = await fixture({
      'thread/resume': { thread: thread('cmd'), model: 'gpt-test', reasoningEffort: 'medium', collaborationMode: {
        mode: 'default', settings: { model: 'gpt-test', reasoning_effort: 'medium', developer_instructions: null } } }
    });
    await command('/plan on');
    await command('/model gpt-other ultra');
    s.readOnly = true;
    await s._takeWriter();
    checkEqual('taking the writer preserves choices made while waiting', [s.meta.mode, s.meta.model, s.effort], ['plan', 'gpt-other', 'ultra']);
    check('taking the writer still releases read-only state', !s.readOnly);
    ws.dispose();
  }
  {
    const { ws, s, calls, command } = await fixture({ 'thread/resume': { __error: 'thread cmd already has an active writer' } });
    const handed = [];
    ws.ipc = { available: true, ownerOf: async () => 'app-owner',
      request: async (method, params) => { handed.push({ method, params }); }, dispose() {} };
    checkEqual('a held thread can start without knowing its model', s.meta.model, null);
    await command('/plan on');
    s.submit('plan through the app');
    await tick();
    const request = handed[0] && handed[0].params.turnStart.request;
    check('a held thread resolves a model before sending plan mode', calls('model/list').length > 0);
    checkEqual('IPC carries the complete plan collaboration settings', request && request.collaborationMode,
      { mode: 'plan', settings: { model: 'gpt-test', reasoning_effort: 'medium', developer_instructions: null } });
    checkEqual('the app receives the prompt once', handed.length, 1);
    ws.dispose();
  }

  suite('Codex reviews use the selected settings');
  {
    const { ws, s, server, calls, command } = await fixture({
      'review/start': { reviewThreadId: 'cmd', turn: { id: 'selected-review', status: 'inProgress', items: [] } }
    });
    await command('/plan on');
    await command('/model gpt-other ultra');
    await command('/review');
    const update = calls('thread/settings/update')[0];
    checkEqual('review synchronizes its selected model and effort', update && [update.params.threadId, update.params.model, update.params.effort],
      ['cmd', 'gpt-other', 'ultra']);
    checkEqual('review synchronizes its selected collaboration mode', update && update.params.collaborationMode,
      { mode: 'plan', settings: { model: 'gpt-other', reasoning_effort: 'ultra', developer_instructions: null } });
    check('review starts after settings are synchronized', update && server.calls.indexOf(update) < server.calls.indexOf(calls('review/start')[0]));
    checkEqual('the review remains the active turn', s.turnId, 'selected-review');
    ws.dispose();
  }

  suite('Codex completed computer calls stay cleared across old history reads');
  for (const ending of ['completion', 'interrupt', 'exit']) {
    const { ws, s, server } = await fixture();
    const item = { type: 'mcpToolCall', id: 'stale-mac', server: 'cua_repl', tool: 'js',
      arguments: { title: 'Old screenshot' }, status: 'inProgress' };
    const history = [{ id: 'running', status: 'inProgress', items: [item] }];
    let release;
    const reply = new Promise((resolve) => { release = resolve; });
    ws.reader = async () => ({ request: () => reply });
    s.turnId = 'running';
    server.say('item/started', { threadId: 'cmd', turnId: 'running', item });
    const loading = s._loadTurns(false);
    await tick();
    if (ending === 'completion') server.say('item/completed', { threadId: 'cmd', turnId: 'running', item: Object.assign({}, item, { status: 'completed' }) });
    else if (ending === 'interrupt') s.interrupt();
    else server.exit();
    checkEqual(ending + ' clears the computer-use indicator before the read returns', s.meta.usingMac, null);
    release({ data: history, nextCursor: null });
    await loading;
    checkEqual(ending + ' is not undone by the old history read', s.meta.usingMac, null);
    ws.dispose();
  }

  suite('Codex turn completion can precede its start response');
  {
    let release;
    let starts = 0;
    const reply = new Promise((resolve) => { release = resolve; });
    const { ws, s, server, calls } = await fixture({
      'turn/start': () => ++starts === 1 ? reply : { turn: { id: 'following-turn', status: 'inProgress', items: [] } }
    });
    s.submit('first input');
    await tick();
    server.say('turn/started', { threadId: 'cmd', turn: { id: 'fast-turn', status: 'inProgress', items: [] } });
    s.submit('next input');
    server.say('turn/completed', { threadId: 'cmd', turn: { id: 'fast-turn', status: 'completed', items: [] } });
    release({ turn: { id: 'fast-turn', status: 'inProgress', items: [] } });
    await tick();
    checkEqual('a late start response cannot revive the completed turn', s.turnId, 'following-turn');
    checkEqual('the waiting input drains after the start request finishes', s.queue.length, 0);
    checkEqual('the next input is sent once', calls('turn/start').map((c) => c.params.input[0].text), ['first input', 'next input']);
    ws.dispose();
  }

  suite('Codex goal mutation replies cannot replace newer notifications');
  for (const mutation of ['set', 'clear']) {
    for (const notification of ['updated', 'cleared']) {
      let release;
      const reply = new Promise((resolve) => { release = resolve; });
      const latest = { objective: 'Newer goal elsewhere', status: 'paused' };
      const { ws, s, server, notice } = await fixture({
        'thread/goal/get': { goal: { objective: 'Initial goal', status: 'active' } },
        ['thread/goal/' + mutation]: () => reply
      });
      s.submit(mutation === 'set' ? '/goal An older objective' : '/goal clear');
      await tick();
      server.say('thread/goal/' + notification, { threadId: 'cmd', goal: latest });
      release(mutation === 'set' ? { goal: { objective: 'An older objective', status: 'active' } } : { cleared: true });
      await tick();
      checkEqual(mutation + ' reply preserves the newer ' + notification + ' state', s.meta.goal, notification === 'updated' ? latest : null);
      check(mutation + ' reports the newer ' + notification + ' state', notice() && notice().level !== 'error' &&
        (notification === 'updated' ? notice().text.includes(latest.objective) : /clear/i.test(notice().text)));
      ws.dispose();
    }
  }
};
