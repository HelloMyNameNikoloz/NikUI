'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');

// Events shaped exactly like the CLI emits them, including the two traps:
// each content block arrives as its own single-block assistant event, and the
// usage on those events is a stale partial for the message in flight.
function turn(session, { msgId, text, tool, cumulativeCost, usage }) {
  session._handle({ type: 'stream_event', event: { type: 'message_start', message: { id: msgId } } });
  session._handle({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  session._handle({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } } });
  session._handle({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(3) } } });
  session._handle({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  session._handle({ type: 'assistant', uuid: 'u-' + msgId, message: { id: msgId, content: [{ type: 'text', text }], usage: { output_tokens: 8, input_tokens: 10 } } });

  if (tool) {
    session._handle({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: tool.id, name: tool.name } } });
    session._handle({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
    session._handle({ type: 'assistant', uuid: 'u2-' + msgId, message: { id: msgId, content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }] } });
    session._handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tool.id, content: tool.result }] } });
  }

  session._handle({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 1,
    total_cost_usd: cumulativeCost,
    usage: Object.assign({}, usage, { iterations: (usage && usage.iterations) || [usage] }),
    modelUsage: { 'claude-x': { contextWindow: 200000 } }
  });
}

module.exports = function () {
  suite('stream parsing');

  const s = new Session({ cwd: '/tmp' });
  s._handle({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-x', slash_commands: ['effort', 'model'], cwd: '/tmp' });

  s.send = function (text) { this._upsert({ id: 'u' + (this._seq++), kind: 'user', text, images: [] }); this._setStatus('working'); };
  s.send('first');
  turn(s, {
    msgId: 'msg_1', text: 'Hello there', tool: { id: 'tu_1', name: 'Bash', input: { command: 'echo hi' }, result: 'hi' },
    cumulativeCost: 0.01, usage: { input_tokens: 10, output_tokens: 49, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }
  });

  const texts = s.items.filter((i) => i.kind === 'text');
  const tools = s.items.filter((i) => i.kind === 'tool');
  checkEqual('streamed text is not duplicated by the final event', texts.length, 1);
  checkEqual('the streamed text is complete', texts[0].text, 'Hello there');
  checkEqual('one tool item, keyed by tool_use id', tools.length, 1);
  checkEqual('the tool carries its authoritative input', tools[0].input, { command: 'echo hi' });
  checkEqual('the tool result is attached', tools[0].result, 'hi');
  checkEqual('the tool is marked done', tools[0].status, 'done');
  check('item ids are unique', new Set(s.items.map((i) => i.id)).size === s.items.length);
  checkEqual('session id captured from init', s.claudeSessionId, 'sess-1');
  checkEqual('slash commands captured from init', s.meta.slashCommands, ['effort', 'model']);

  suite('cost and usage');

  const firstResult = s.items.filter((i) => i.kind === 'result').pop();
  checkEqual('the first turn is charged its own cost', Number(firstResult.costUsd.toFixed(6)), 0.01);
  checkEqual('tokens come from result.usage, not the stale assistant event', s.usage.output, 49);

  s.send('second');
  turn(s, {
    msgId: 'msg_2', text: 'Second reply', cumulativeCost: 0.025,
    usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }
  });

  const secondResult = s.items.filter((i) => i.kind === 'result').pop();
  checkEqual('the second turn is charged the delta, not the running total', Number(secondResult.costUsd.toFixed(6)), 0.015);
  checkEqual('the session total is the latest cumulative', Number(s.totalCost.toFixed(6)), 0.025);
  checkEqual('per-turn costs sum to the session total', Number((0.01 + 0.015).toFixed(6)), Number(s.totalCost.toFixed(6)));
  checkEqual('output tokens accumulate across turns', s.usage.output, 69);
  checkEqual('context is the last model call, not the turn total', s.contextTokens, 305);
  checkEqual('context window is picked up', s.contextWindow, 200000);
  checkEqual('turns counted', s.turns, 2);

  suite('what is left of the plan');

  const metered = new Session({ cwd: '/tmp' });
  const fiveHourReset = Math.floor(Date.now() / 1000) + 3600;
  const weekReset = Math.floor(Date.now() / 1000) + 200000;

  metered._handle({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed', utilization: 0.4,
      unifiedWindows: {
        five_hour: { utilization: 0.4, resetsAt: fiveHourReset },
        seven_day: { utilization: 0.12, resetsAt: weekReset }
      }
    },
    uuid: 'u', session_id: 's'
  });

  check('the five-hour window is read', metered.limits.windows.fiveHour.used === 0.4);
  check('and the weekly one', metered.limits.windows.week.used === 0.12);
  checkEqual('reset times are milliseconds, not seconds',
    metered.limits.windows.fiveHour.resetsAt, fiveHourReset * 1000);
  checkEqual('a window nobody reported stays empty', metered.limits.windows.weekOverage, null);
  checkEqual('being within them is not worth interrupting for',
    metered.items.filter((i) => i.kind === 'notice').length, 0);

  metered._handle({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.86,
      resetsAt: fiveHourReset,
      unifiedWindows: { five_hour: { utilization: 0.86, resetsAt: fiveHourReset } }
    }
  });
  const warned = metered.items.filter((i) => i.kind === 'notice').pop();
  check('getting close is said out loud', warned && /Approaching your five-hour limit/.test(warned.text));
  check('with how much of it has gone', warned && /86%/.test(warned.text));

  metered._handle({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.88 }
  });
  checkEqual('and not repeated while it stays that way',
    metered.items.filter((i) => i.kind === 'notice').length, 1);

  metered._handle({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resets_at: weekReset }
  });
  const blocked = metered.items.filter((i) => i.kind === 'notice').pop();
  check('running out is an error, not a note', blocked && blocked.level === 'error');
  check('and says which limit and when it comes back',
    blocked && /weekly limit is used up/.test(blocked.text) && /resets/.test(blocked.text));
  checkEqual('the snake-cased spelling is read too',
    metered.limits.resetsAt, weekReset * 1000);

  metered._handle({ type: 'rate_limit_event' });
  checkEqual('an event with nothing in it changes nothing', metered.limits.status, 'rejected');
  metered.dispose();

  suite('the CLI compacting the context is not invisible');

  const packed = new Session({ cwd: '/tmp' });
  packed.contextTokens = 180000;
  packed.contextWindow = 200000;

  // The documented shape.
  packed._handle({
    type: 'system', subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 181234 }
  });
  const boundary = packed.items.find((i) => i.kind === 'compact');
  check('a boundary lands in the conversation', !!boundary);
  checkEqual('it knows it was not asked for', boundary.trigger, 'automatic');
  checkEqual('and how full the context had got', boundary.before, 181234);
  checkEqual('it is counted', packed.compactions, 1);
  checkEqual('and the meter starts again from there', packed.contextTokens, 0);
  check('the moment is remembered', packed.lastCompactedAt > 0);

  // A shape we have not seen: the marker matters more than the field names.
  packed._handle({ type: 'system', subtype: 'context_compacted', compactMetadata: { trigger: 'manual' } });
  checkEqual('an unfamiliar spelling still registers', packed.compactions, 2);
  checkEqual('including who asked for it', packed.items.filter((i) => i.kind === 'compact').pop().trigger, 'manual');

  packed._handle({ type: 'system', subtype: 'stop_hook_summary' });
  checkEqual('and a system event about something else is left alone', packed.compactions, 2);

  packed.resetConversation();
  checkEqual('a fresh start has never compacted', packed.compactions, 0);
  packed.dispose();

  suite('a tab that renames itself says so');

  const named = new Session({ cwd: '/tmp' });
  named._write = function () {};
  Object.defineProperty(named, 'isRunning', { get: () => true });

  named.send('start on https://github.com/peuka/backend/pull/1327 please');
  checkEqual('the first number just names it', named.ticket, '1327');
  checkEqual('and that is not worth a line in the transcript',
    named.items.filter((i) => i.kind === 'notice').length, 0);

  named.send('now switch to https://github.com/peuka/backend/pull/1801');
  checkEqual('a new number renames it', named.ticket, '1801');
  const notice = named.items.filter((i) => i.kind === 'notice').pop();
  check('and that is announced', notice && /Renamed 1327 → 1801/.test(notice.text));
  check('with a way to stop it happening again', notice && /Rename it yourself/.test(notice.text));
  check('the notice comes after the prompt that caused it',
    named.items.indexOf(notice) > named.items.findIndex((i) => i.kind === 'user' && /switch to/.test(i.text)));
  named.dispose();

  suite('the turn log behind /status');

  checkEqual('one row per finished turn', s.turnLog.map((t) => t.n), [1, 2]);
  checkEqual('each row carries its own cost, not the running total',
    s.turnLog.map((t) => Number(t.costUsd.toFixed(6))), [0.01, 0.015]);
  checkEqual('each row carries its own tokens', s.turnLog.map((t) => t.output), [49, 20]);
  checkEqual('the duration comes off the wire', s.turnLog.map((t) => t.durationMs), [1200, 1200]);
  checkEqual('the tools of a turn are named', s.turnLog[0].tools, ['Bash']);
  checkEqual('a turn with no tools says so', s.turnLog[1].tools, []);
  checkEqual('the context after the turn is kept', s.turnLog[1].contextTokens, 305);
  checkEqual('the model that answered is kept', s.turnLog[0].model, 'claude-x');

  suite('context is not multiplied by tool calls');

  const c = new Session({ cwd: '/tmp' });
  c._handleResult({
    type: 'result', is_error: false, total_cost_usd: 0.001,
    usage: {
      input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0,
      // Four model calls in one turn; the top-level figures are their sum.
      iterations: [
        { input_tokens: 10, cache_read_input_tokens: 100 },
        { input_tokens: 10, cache_read_input_tokens: 300 },
        { input_tokens: 10, cache_read_input_tokens: 400 },
        { input_tokens: 10, cache_read_input_tokens: 400 }
      ]
    }
  });
  checkEqual('context is the last call, not the sum of all four', c.contextTokens, 410);
  check('the summed figure would have been far larger', 40 + 1200 > c.contextTokens);
  c.dispose();

  suite('restart clears conversation state');

  const before = { tokens: s.usage.output, turns: s.turns, cost: s.totalCost, context: s.contextTokens };
  check('there is state to clear', before.tokens > 0 && before.turns > 0 && before.cost > 0);
  check('the turns were logged for the status sheet', s.turnLog.length === before.turns);
  // The real reset a fresh restart runs, not a copy of it.
  s.resetConversation();
  const stats = s.stats();
  check('a fresh restart leaves no stale tokens', stats.output === 0 && stats.total === 0);
  check('a fresh restart leaves no stale turns or cost', stats.turns === 0 && stats.cost === 0);
  check('a fresh restart leaves no stale context', stats.contextTokens === 0);
  check('a fresh restart leaves no stale history',
    s.turnLog.length === 0 && s.items.length === 0 && s.errors === 0 && s.interrupts === 0);
  check('nor a clock still running from the old conversation',
    s.turnStartedAt === null && s.finishedAt === 0 && s.droppedItems === 0);

  suite('cost survives a resumed process');

  const r = new Session({ cwd: '/tmp', totalCost: 0.025 });
  r.start = function () { this._costBaseline = this.totalCost; };
  r.start();
  r._handleResult({ type: 'result', is_error: false, total_cost_usd: 0.004, usage: { input_tokens: 1, output_tokens: 2 } });
  checkEqual('a resumed process adds to the prior total', Number(r.totalCost.toFixed(6)), 0.029);
  const resumed = r.items.filter((i) => i.kind === 'result').pop();
  checkEqual('the resumed turn is charged only its own cost', Number(resumed.costUsd.toFixed(6)), 0.004);

  s.dispose();
  r.dispose();

  suite('an answer nobody can deliver does not look delivered');

  const gone = new Session({ cwd: '/tmp' });
  gone._upsert({ id: 'p1', kind: 'permission', requestId: 'r1', name: 'Bash', input: {}, resolved: null });
  checkEqual('the instance is not running', gone.isRunning, false);
  checkEqual('so the answer is refused rather than swallowed', gone.respondToPermission('r1', true), false);
  checkEqual('and it is not left looking busy', gone.status, 'idle');
  check('the reason is in the conversation',
    gone.items.some((i) => i.kind === 'notice' && /not running any more/.test(i.text)));
  gone.dispose();

  suite('a process on its way out does not feed the one replacing it');

  const swapping = new Session({ cwd: '/tmp' });
  const dying = { stdout: { on: () => {} }, stderr: { on: () => {}, setEncoding: () => {} }, on: () => {} };
  let fed = 0;
  swapping._onStdout = function () { fed++; };
  // What start() wires up, without spawning anything: the guard is the closure.
  const handler = (chunk) => { if (swapping.proc === dying) swapping._onStdout(chunk); };
  swapping.proc = dying;
  handler('{"type":"result"}');
  checkEqual('its output counts while it is the process', fed, 1);
  swapping.proc = { different: true };
  handler('{"type":"result"}');
  checkEqual('and is ignored once it is not', fed, 1);
  swapping.proc = null;
  swapping.dispose();
};
