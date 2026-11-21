#!/usr/bin/env node
'use strict';
// Speaks just enough of `claude --output-format stream-json` for the keeper
// tests: each prompt is answered word by word, slowly, and a prompt that says
// ASK first asks permission. Everything it is told goes to $FAKE_LOG.
const fs = require('fs');
const log = (o) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n'); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const WORDS = Number(process.env.FAKE_WORDS || 12);
const MS = Number(process.env.FAKE_MS || 40);
log({ pid: process.pid });
let turn = 0;
let waiting = null;
const queue = [];
let busy = false;

function answer(text) {
  busy = true;
  turn += 1;
  const id = 'msg_' + turn;
  out({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake', tools: [], slash_commands: [] });
  const go = () => {
    out({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    let n = 0;
    const words = [];
    const tick = setInterval(() => {
      n += 1;
      const w = 'w' + n + ' ';
      words.push(w);
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } } });
      if (n < WORDS) return;
      clearInterval(tick);
      out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      out({ type: 'assistant', uuid: 'u' + id, message: { id, role: 'assistant', content: [{ type: 'text', text: words.join('') }] } });
      out({ type: 'result', subtype: 'success', is_error: false, duration_ms: WORDS * MS, num_turns: 1, result: words.join(''),
        total_cost_usd: 0.5 * turn, usage: { input_tokens: 10, output_tokens: 5 } });
      busy = false;
      if (queue.length) answer(queue.shift());
    }, MS);
  };
  if (/ASK/.test(text)) {
    waiting = go;
    out({ type: 'control_request', request_id: 'perm-' + turn, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  } else go();
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, at); buf = buf.slice(at + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log({ got: msg.type, sub: msg.response && msg.response.request_id });
    if (msg.type === 'user') {
      const text = msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (busy) queue.push(text); else answer(text);
    } else if (msg.type === 'control_response' && waiting) {
      const go = waiting; waiting = null; go();
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(143));
