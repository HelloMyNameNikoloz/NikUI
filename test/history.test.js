'use strict';
const os = require('os');
const path = require('path');
const { install } = require('./helpers/vscode-stub.js');
install();
const { slugFor, transcriptPath, listSessions } = require('../src/history.js');

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
    check('entries carry a modified date', entry.modified instanceof Date);
    check('titles are trimmed to a sane length', entry.title.length <= 80);
    check('titles are not harness payloads', !entry.title.startsWith('<'));
    check('newest first', recent.every((e, i) => i === 0 || recent[i - 1].mtimeMs >= e.mtimeMs));
  }
};
