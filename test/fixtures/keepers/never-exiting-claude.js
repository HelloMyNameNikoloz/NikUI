#!/usr/bin/env node
'use strict';
// Like an interactive stream-json Claude: results/interrupts do not exit it.
// EOF deliberately does not exit either, exercising the keeper's escalation.
const fs = require('fs'), readline = require('readline');
const log = (event) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ ...event, pid: process.pid }) + '\n'); };
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
log({ event: 'start' });
let timer, n = 0, turn = 0, words = [];
const finish = () => {
  clearInterval(timer); timer = null;
  out({ type: 'assistant', uuid: 'answer-' + turn, message: { id: 'msg-' + turn, role: 'assistant', content: [{ type: 'text', text: words.join('') }] } });
  out({ type: 'result', subtype: 'success', total_cost_usd: 0.5 * turn, num_turns: 1, usage: { input_tokens: 10, output_tokens: n } });
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line); log({ event: 'input', type: msg.type });
  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') { finish(); return; }
  if (msg.type !== 'user' || timer) return;
  turn++; n = 0; words = [];
  out({ type: 'system', subtype: 'init', session_id: process.env.FAKE_SESSION_ID || 'r29-conversation', model: 'fixture', tools: [], slash_commands: [] });
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-' + turn } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  timer = setInterval(() => {
    const text = 'w' + (++n) + ' '; words.push(text);
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  }, Number(process.env.FAKE_MS || 25));
});
setInterval(() => {}, 60000); // Remains alive between turns and after stdin EOF.
