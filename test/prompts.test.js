'use strict';
const { PromptHistory } = require('../media/prompts.js');

module.exports = function () {
  suite('prompt recall');

  const h = new PromptHistory();
  h.remember('first prompt');
  h.remember('second prompt');
  h.remember('third prompt');

  checkEqual('up recalls the newest prompt', h.older(''), 'third prompt');
  checkEqual('up again goes further back', h.older(''), 'second prompt');
  checkEqual('and further', h.older(''), 'first prompt');
  checkEqual('the oldest is the end of the line', h.older(''), 'first prompt');
  checkEqual('down comes back forward', h.newer(), 'second prompt');
  checkEqual('down again', h.newer(), 'third prompt');
  checkEqual('past the newest, the draft comes back', h.newer(), '');
  check('and recall is over', !h.browsing());
  checkEqual('down outside recall does nothing', h.newer(), null);

  const draft = new PromptHistory();
  draft.remember('sent earlier');
  checkEqual('the draft is remembered on the way up', draft.older('half typed'), 'sent earlier');
  checkEqual('and handed back on the way down', draft.newer(), 'half typed');

  const empty = new PromptHistory();
  checkEqual('nothing to recall yet', empty.older(''), null);

  const dedupe = new PromptHistory();
  check('a prompt is recorded once', dedupe.remember('hello'));
  check('the transcript echo of it is not', !dedupe.remember('hello', 'u1'));
  check('an id is only folded in once', dedupe.remember('other', 'u2') && !dedupe.remember('other', 'u2'));
  check('blank prompts are skipped', !dedupe.remember('   '));
  checkEqual('so the ring holds each prompt once', dedupe.entries, ['hello', 'other']);

  const trimmed = new PromptHistory();
  trimmed.remember('  padded  ');
  checkEqual('stored prompts are trimmed', trimmed.entries, ['padded']);

  const capped = new PromptHistory(3);
  ['a', 'b', 'c', 'd'].forEach((t) => capped.remember(t));
  checkEqual('the ring drops the oldest past its limit', capped.entries, ['b', 'c', 'd']);

  const edited = new PromptHistory();
  edited.remember('original');
  edited.older('');
  checkEqual('recall reports what it put in the box', edited.current(), 'original');
  edited.reset();
  check('an edit ends recall', !edited.browsing() && edited.current() === null);
};
