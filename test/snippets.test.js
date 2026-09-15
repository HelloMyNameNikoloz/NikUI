'use strict';
const { expand, names, nameOf } = require('../media/snippets.js');

const SNIPPETS = { table: 'TABLE INSTRUCTION', Review: 'REVIEW INSTRUCTION', off: '  ' };

module.exports = function () {
  suite('prompt snippets');

  checkEqual('a word on its own is a snippet name', nameOf('/table'), 'table');
  checkEqual('case does not matter', nameOf('/TABLE'), 'table');
  checkEqual('a word with a slash inside is not one', nameOf('src/table'), null);
  checkEqual('nor is a bare word', nameOf('table'), null);
  checkEqual('an empty snippet is not offered', names(SNIPPETS).sort(), ['review', 'table']);

  suite('what gets sent');

  const first = expand('/table fix the rollback path', SNIPPETS);
  checkEqual('the panel keeps what you typed', first.text, 'fix the rollback path');
  checkEqual('the model gets it with the instruction', first.sent,
    'fix the rollback path\n\nTABLE INSTRUCTION');
  checkEqual('and the prompt says which one', first.used, ['table']);

  const last = expand('fix the rollback path /table', SNIPPETS);
  checkEqual('the word works at the end too', last.text, 'fix the rollback path');
  checkEqual('with the same result', last.sent, 'fix the rollback path\n\nTABLE INSTRUCTION');

  const alone = expand('/table', SNIPPETS);
  checkEqual('on its own there is nothing to keep', alone.text, '');
  checkEqual('and the instruction is the whole prompt', alone.sent, 'TABLE INSTRUCTION');

  const both = expand('/table do the thing /table', SNIPPETS);
  checkEqual('the same one twice is still one instruction', both.sent,
    'do the thing\n\nTABLE INSTRUCTION');
  checkEqual('and it is named once', both.used, ['table']);

  const two = expand('/table do the thing /review', SNIPPETS);
  checkEqual('two different ones both apply', two.used, ['table', 'review']);
  checkEqual('in the order they were written', two.sent,
    'do the thing\n\nTABLE INSTRUCTION\n\nREVIEW INSTRUCTION');

  suite('everything else is left alone');

  checkEqual('an ordinary prompt is untouched', expand('just do it', SNIPPETS).sent, 'just do it');
  checkEqual('and carries no snippets', expand('just do it', SNIPPETS).used, []);
  checkEqual('a command nobody defined is left for the CLI',
    expand('/compact', SNIPPETS).sent, '/compact');
  checkEqual('a snippet with no text behind it does nothing',
    expand('/off tidy up', SNIPPETS).sent, '/off tidy up');
  checkEqual('the word in the middle of a sentence is just a word',
    expand('run /table after this', SNIPPETS).sent, 'run /table after this');
  checkEqual('no snippets configured, nothing happens', expand('/table now', {}).sent, '/table now');
  checkEqual('an empty prompt stays empty', expand('   ', SNIPPETS).sent, '');
  checkEqual('surrounding whitespace is tidied', expand('  /table  do it  ', SNIPPETS).text, 'do it');
};
