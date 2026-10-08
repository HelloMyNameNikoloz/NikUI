'use strict';
const M = require('../media/mentions.js');

function memory() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
}

module.exports = function () {
  const now = Date.parse('2026-10-08T12:00:00Z');

  suite('@mentions: when the list opens');
  checkEqual('a bare @ opens it', M.trigger('Thanks @', 8), { start: 7, query: '' });
  checkEqual('at the very start', M.trigger('@pe', 3), { start: 0, query: 'pe' });
  checkEqual('the query is what follows', M.trigger('cc @peuka-a', 11), { start: 3, query: 'peuka-a' });
  checkEqual('a team', M.trigger('cc @org/we', 10), { start: 3, query: 'org/we' });
  checkEqual('only up to the caret', M.trigger('@ada and more', 4), { start: 0, query: 'ada' });
  check('an email address is not a mention', M.trigger('mail a@b', 8) === null);
  check('a space ends it', M.trigger('@ada ', 5) === null);
  check('inside inline code, no', M.trigger('run `@ada', 9) === null);
  check('inside a fenced block, no', M.trigger('```\n@ad', 7) === null);
  checkEqual('mentions in a sent comment', M.mentioned('@ada thanks, and @org/web — not a@b.com or `@x`'), ['ada', 'org/web']);

  suite('@mentions: matching');
  check('exact beats prefix beats word', M.match('ada', 'ada', '').score > M.match('ad', 'ada', '').score &&
    M.match('ad', 'ada', '').score > M.match('bo', 'peuka-bob', '').score);
  checkEqual('"bob" finds peuka-bob, marking the letters', M.match('bob', 'peuka-bob', '').login, [6, 7, 8]);
  check('a word of the name', M.match('love', 'ada', 'Ada Lovelace').score > 0);
  check('letters in order', M.match('pkb', 'peuka-bob', '').score > 0);
  check('nothing alike', M.match('zz', 'ada', 'Ada').score === 0);

  suite('@mentions: order');
  const st = {
    author: 'olga', createdAt: '2026-10-08T09:00:00Z',
    reviewers: [{ login: 'rev', state: 'PENDING' }, { login: 'me', state: 'APPROVED' }],
    comments: [{ author: 'carl', at: '2026-10-08T11:50:00Z' }],
    commits: [{ author: 'olga', at: '2026-10-08T08:00:00Z' }]
  };
  const parts = M.participants(st, now);
  checkEqual('the strongest part wins', parts.get('olga').says, 'Opened this PR');
  check('review requested is there', parts.get('rev').says === 'Review requested');
  const everyone = ['zed', 'amy', 'peuka-ada', 'peuka-bob', 'me', 'carl', 'olga', 'rev'].map((login) => ({ login }));

  const store = memory();
  M.remember(store, 'o/r', ['peuka-bob'], now - 3600e3);
  M.remember(store, 'o/r', ['peuka-bob', 'peuka-bob'], now - 60e3);
  M.remember(store, 'o/r', ['zed'], now - 30 * 86400e3);
  M.remember(store, 'other/repo', ['amy'], now);
  const history = M.loadHistory(store)['o/r'];
  checkEqual('remembered per repository, counted', [history['peuka-bob'].n, !!history.amy], [3, false]);

  const list = M.rank({ query: '', everyone, parts, history, viewer: 'me', now });
  const order = list.map((p) => p.login);
  checkEqual('with nothing typed: who you mention, then this PR, then everyone',
    order, ['peuka-bob', 'zed', 'rev', 'olga', 'carl', 'amy', 'peuka-ada']);
  check('you are never offered yourself', !order.includes('me'));
  checkEqual('the reason says why', list[0].reason, 'You mention often');
  check('…and a PR reason keeps its time', /^Commented 10m ago$/.test(list.find((p) => p.login === 'carl').reason));
  checkEqual('sections', list.map((p) => p.section).slice(0, 3), ['recent', 'recent', 'pr']);

  const typed = M.rank({ query: 'peuka', everyone, parts, history, viewer: 'me', now }).map((p) => p.login);
  checkEqual('typing narrows, your habit still breaks the tie', typed, ['peuka-bob', 'peuka-ada']);
  const word = M.rank({ query: 'a', everyone, parts, history, viewer: 'me', now }).map((p) => p.login);
  check('a prefix outranks a later word', word.indexOf('amy') < word.indexOf('peuka-ada'));
  checkEqual('teams come after people as good', M.rank({ query: 'o', everyone: [{ login: 'o/web', team: true }, { login: 'oz' }], now }).map((p) => p.login), ['oz', 'o/web']);
  check('someone only in the history is still offered', M.rank({ query: 'zed', everyone: [], history, now }).length === 1);
};
