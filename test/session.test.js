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
  // Exercise the same reset the fresh-restart path performs.
  s.items = []; s._itemIndex.clear(); s._streamedMsgIds.clear(); s._blockToItem.clear();
  s.totalCost = 0; s._costBaseline = 0; s.usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  s.pendingUsage = null; s.turns = 0; s.contextTokens = 0; s.lastError = null; s.replayed = false;
  const stats = s.stats();
  check('a fresh restart leaves no stale tokens', stats.output === 0 && stats.total === 0);
  check('a fresh restart leaves no stale turns or cost', stats.turns === 0 && stats.cost === 0);
  check('a fresh restart leaves no stale context', stats.contextTokens === 0);

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
};
