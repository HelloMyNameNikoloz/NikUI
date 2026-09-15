'use strict';
const os = require('os');
const path = require('path');
const { install } = require('./helpers/vscode-stub.js');
install();
const { slugFor, transcriptPath, listSessions } = require('../src/history.js');
const { HistoryTree, matches, PAGE } = require('../src/historyTree.js');

module.exports = async function () {
  suite('history');

  checkEqual('slug replaces separators and dots',
    slugFor('/Users/x/Codes/Peuka/backend/.claude/worktrees/692-phase3a'),
    '-Users-x-Codes-Peuka-backend--claude-worktrees-692-phase3a');
  checkEqual('transcript path is derived from cwd and id',
    transcriptPath('/Users/x/Codes/Peuka', 'abc'),
    path.join(os.homedir(), '.claude', 'projects', '-Users-x-Codes-Peuka', 'abc.jsonl'));
  checkEqual('a missing cwd yields no path', transcriptPath(null, 'abc'), null);
  checkEqual('a missing id yields no path', transcriptPath('/tmp', null), null);

  // Reads whatever is really on this machine; assert shape, not contents.
  const recent = await listSessions({ limit: 5 });
  check('listing returns an array', Array.isArray(recent));
  if (recent.length) {
    const entry = recent[0];
    check('entries carry a session id', typeof entry.sessionId === 'string' && entry.sessionId.length > 0);
    check('entries carry a title', typeof entry.title === 'string' && entry.title.length > 0);
    check('entries carry a short name', typeof entry.label === 'string' && entry.label.length > 0);
    check('short names fit a tree row', recent.every((e) => e.label.length <= 29));
    check('short names are not raw links', recent.every((e) => !/^https?:/.test(e.label)));
    check('entries carry a modified date', entry.modified instanceof Date);
    check('titles are trimmed to a sane length', entry.title.length <= 80);
    check('titles are not harness payloads', !entry.title.startsWith('<'));
    check('newest first', recent.every((e, i) => i === 0 || recent[i - 1].mtimeMs >= e.mtimeMs));
  }

  // The row a transcript shows up as in the sidebar.
  const tree = new HistoryTree();
  const row = tree.getTreeItem({
    sessionId: 'abc-123', label: '1327', title: 'https://github.com/peuka/backend/pull/1327 look at this',
    cwd: '/Users/nikoloz/Codes/Peuka/backend', branch: 'main', modified: new Date()
  });
  checkEqual('a row is named like an instance', row.label, '1327');
  check('the row still says which folder', /backend/.test(row.description));
  check('the tooltip keeps the whole prompt', row.tooltip.value.indexOf('look at this') > 0);

  const unnamed = tree.getTreeItem({
    sessionId: 'def-456', label: '', title: 'no label was derived',
    cwd: '/tmp', branch: null, modified: new Date()
  });
  checkEqual('a row with no short name falls back to the prompt', unnamed.label, 'no label was derived');
  checkEqual('and does not repeat it in the tooltip',
    unnamed.tooltip.value.split('no label was derived').length - 1, 1);

  suite('finding something in History');

  const one = { label: '1327', title: 'fix the migration', cwd: '/Users/x/Codes/Peuka/backend', branch: 'main' };
  check('by name', matches(one, '1327'));
  check('by what was asked', matches(one, 'MIGRATION'));
  check('by folder', matches(one, 'backend'));
  check('by branch', matches(one, 'main'));
  check('and not by something that is not there', !matches(one, 'zzz'));

  const view = new HistoryTree();
  checkEqual('the header says what is being shown', view.summary, 'this workspace');
  view.toggleScope();
  checkEqual('and follows the scope', view.summary, 'all folders');
  view.setFilter('  crash  ');
  check('a filter is trimmed and shown', /crash/.test(view.summary));
  checkEqual('and it starts from the top of the list again', view.limit, PAGE);
  view.showMore();
  checkEqual('showing more asks for another page', view.limit, PAGE * 2);
  view.toggleScope();
  checkEqual('changing scope starts over', view.limit, PAGE);
  view.setFilter('');
  checkEqual('an empty filter clears it', view.summary, 'this workspace');

  const more = view.getTreeItem({ __more: true, more: 17, sessionId: 'more' });
  checkEqual('the last row offers the rest', more.label, 'Show 17 more');
  checkEqual('and clicking it asks for them', more.command.command, 'nikui.historyMore');
};
