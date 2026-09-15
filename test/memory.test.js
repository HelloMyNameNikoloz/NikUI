'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session, clip, TOOL_RESULT_MAX, DEFAULT_MAX_ITEMS } = require('../src/session.js');

const toolResult = (session, id, text, isError) => session._handleUser({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!isError }] }
});

module.exports = function () {
  suite('a huge tool result cannot sink the panel');

  checkEqual('clip leaves a small string alone', clip('hello', 100), { text: 'hello', length: 5, clipped: false });
  const cut = clip('x'.repeat(50), 10);
  checkEqual('clip keeps the head', cut.text, 'x'.repeat(10));
  checkEqual('and remembers the real size', [cut.length, cut.clipped], [50, true]);
  checkEqual('a budget of zero means no budget', clip('x'.repeat(50), 0).text.length, 50);

  const s = new Session({ cwd: '/tmp' });
  s._upsert({ id: 'tool:t1', kind: 'tool', name: 'Bash', input: { command: 'cat big.log' }, status: 'running' });
  toolResult(s, 't1', 'y'.repeat(TOOL_RESULT_MAX * 3));

  const tool = s.items.find((i) => i.id === 'tool:t1');
  checkEqual('the result is cut to the budget', tool.result.length, TOOL_RESULT_MAX);
  checkEqual('the real length is kept', tool.resultLength, TOOL_RESULT_MAX * 3);
  check('and it is marked as cut', tool.resultClipped === true);
  checkEqual('the tool is still marked done', tool.status, 'done');

  s._upsert({ id: 'tool:t2', kind: 'tool', name: 'Read', input: {}, status: 'running' });
  toolResult(s, 't2', 'short');
  const small = s.items.find((i) => i.id === 'tool:t2');
  checkEqual('a small result is untouched', small.result, 'short');
  check('and is not marked as cut', !small.resultClipped);

  suite('the streamed copy of a tool input is not kept twice');

  const t = new Session({ cwd: '/tmp' });
  const stream = (ev) => t._handle({ type: 'stream_event', event: ev });
  stream({ type: 'message_start', message: { id: 'm1' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Write' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/a.txt"}' } });
  stream({ type: 'content_block_stop', index: 0 });
  const written = t.items.find((i) => i.id === 'tool:tu1');
  checkEqual('the input is parsed', written.input, { file_path: '/tmp/a.txt' });
  check('and the raw json it arrived as is gone', !('rawInput' in written));

  suite('a long conversation stays bounded');

  const b = new Session({ cwd: '/tmp', maxItems: 5 });
  for (let i = 0; i < 12; i++) b._upsert({ id: 'u' + i, kind: 'user', text: 'prompt ' + i, images: [] });
  checkEqual('the window holds', b.items.length, 5);
  checkEqual('the oldest went', b.items[0].id, 'u7');
  checkEqual('and they were counted', b.droppedItems, 7);
  check('a dropped item is out of the index too', b._itemIndex.get('u0') === undefined);

  const busy = new Session({ cwd: '/tmp', maxItems: 3 });
  busy._upsert({ id: 'tool:live', kind: 'tool', name: 'Bash', input: {}, status: 'running' });
  for (let i = 0; i < 10; i++) busy._upsert({ id: 'n' + i, kind: 'notice', text: 'x' });
  check('a tool still running is never dropped', busy._itemIndex.get('tool:live') !== undefined);
  check('so the window can bulge rather than break', busy.items.length > 3);
  toolResult(busy, 'live', 'done now');
  busy._upsert({ id: 'after', kind: 'notice', text: 'x' });
  check('and once it finishes the backlog goes', busy.items.length <= 3 + 1);

  const asked = new Session({ cwd: '/tmp', maxItems: 2 });
  asked._upsert({ id: 'p1', kind: 'permission', requestId: 'r1', name: 'Bash', input: {}, resolved: null });
  for (let i = 0; i < 6; i++) asked._upsert({ id: 'q' + i, kind: 'notice', text: 'x' });
  check('an unanswered permission is never dropped', asked._itemIndex.get('p1') !== undefined);

  const unlimited = new Session({ cwd: '/tmp', maxItems: 0 });
  for (let i = 0; i < 50; i++) unlimited._upsert({ id: 'z' + i, kind: 'notice', text: 'x' });
  checkEqual('zero means keep everything', unlimited.items.length, 50);
  checkEqual('and nothing is reported as dropped', unlimited.droppedItems, 0);

  checkEqual('the default window is the documented one', new Session({ cwd: '/tmp' }).maxItems, DEFAULT_MAX_ITEMS);

  b.resetConversation();
  checkEqual('a fresh start forgets what it dropped', b.droppedItems, 0);

  [s, t, b, busy, asked, unlimited].forEach((x) => x.dispose());
};
