'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { outsideWorktree } = require('../src/manager.js');

module.exports = function () {
  suite('an instance keeps the name and folder it was given');

  {
    const s = new Session({ cwd: '/Users/nikoloz/Codes/NikUI', autoTitle: false });
    s.proc = { exitCode: null, killed: false, kill() {}, stdin: { writable: true, write() {}, end() {} } };
    s.send('fix PR #42 please');
    s._handle({ type: 'system', subtype: 'init', session_id: 'x', model: 'm', tools: [], slash_commands: [],
      cwd: '/Users/nikoloz/Codes/NikUI/.claude/worktrees/agent-a8q39238e' });
    checkEqual('entering a worktree does not move it', s.cwd, '/Users/nikoloz/Codes/NikUI');
    checkEqual('and nothing in a prompt renames it', s.label, 'NikUI');
    s.rename('My work');
    checkEqual('a name you give it is the name', s.label, 'My work');
  }

  {
    const s = new Session({ cwd: '/p/Peuka', autoTitle: true, ticket: 'PR 7' });
    checkEqual('with automatic naming asked for, it still names', s.label, 'PR 7');
  }

  {
    const s = new Session({ cwd: '/Users/nikoloz/Codes/NikUI' });
    s.proc = { exitCode: null, killed: false, kill() {}, stdin: { writable: true, write() {}, end() {} } };
    s.send('review PR #1327');
    checkEqual('by default it is named after its PR', s.label, '1327');
    s.rename('Mine');
    s.send('now look at PR #1400');
    checkEqual('until you rename it, and then never again', s.label, 'Mine');
  }

  checkEqual('one saved inside a worktree comes back in its project',
    outsideWorktree('/Users/nikoloz/Codes/NikUI/.claude/worktrees/agent-a8q39238e'), '/Users/nikoloz/Codes/NikUI');
  checkEqual('and deeper inside one too',
    outsideWorktree('/p/NikUI/.claude/worktrees/agent-1/src'), '/p/NikUI');
  checkEqual('an ordinary folder is left alone', outsideWorktree('/p/NikUI/src'), '/p/NikUI/src');
};
