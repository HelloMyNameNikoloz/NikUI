'use strict';

// Running a command on this machine, from somewhere else.
//
// Nothing here spawns anything: the shell is injected, so what is checked is
// the decisions — what gets run, where, what is refused, and what the other end
// is told — rather than whether this laptop has bash.

const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const { Terminals, looksRunnable, cleanCommand } = require('../src/terminal.js');

/** A child process, as far as this is concerned. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  return child;
}

function harness(options) {
  const calls = [];
  const events = [];
  let child = null;
  const terminals = new Terminals(Object.assign({
    shell: '/bin/testsh',
    spawn: (bin, args, opts) => {
      calls.push({ bin, args, opts });
      child = fakeChild();
      return child;
    },
    onEvent: (event) => events.push(event)
  }, options || {}));
  return { terminals, calls, events, child: () => child };
}

module.exports = async function () {
  suite('a terminal is a place, and a command is a process');

  {
    const { terminals, calls, events, child } = harness();
    const made = terminals.open({ cwd: '/tmp/project', name: 'alpha' });
    check('opening one gives it an id', !!made.id);
    checkEqual('rooted where it was told', made.cwd, '/tmp/project');
    checkEqual('and it is not busy', made.busy, false);

    const out = terminals.run(made.id, 'npm test');
    checkEqual('running is accepted', out.ok, true);
    checkEqual('through a shell', calls[0].bin, '/bin/testsh');
    checkEqual('told to read the profile and then the command', calls[0].args[0], '-lc');
    checkEqual('which is the command as given', calls[0].args[1], 'npm test');
    checkEqual('in the terminal’s own directory', calls[0].opts.cwd, '/tmp/project');
    // Half the tools on a machine draw progress bars and colour when they think
    // something is watching. Nothing is watching.
    checkEqual('with nothing pretending to be a terminal', calls[0].opts.env.TERM, 'dumb');
    checkEqual('and colour turned off', calls[0].opts.env.NO_COLOR, '1');
    check('the other end is told it began', events.some((e) => e.type === 'term:began'));
    checkEqual('and the terminal says it is busy', terminals.describe(terminals.get(made.id)).busy, true);

    child().stdout.emit('data', Buffer.from('all good\n'));
    child().stderr.emit('data', Buffer.from('a warning\n'));
    const spoken = events.filter((e) => e.type === 'term:out');
    checkEqual('output is passed on as it arrives', spoken.length, 2);
    checkEqual('with which stream it came from', spoken[1].stream, 'err');

    child().emit('close', 0, null);
    const done = events.filter((e) => e.type === 'term:done').pop();
    checkEqual('finishing is announced', done.run.exit, 0);
    checkEqual('with everything it said', done.run.output, 'all good\na warning\n');
    checkEqual('and the terminal is free again', done.terminal.busy, false);
  }

  suite('what it will not do');

  {
    const { terminals, calls } = harness();
    const made = terminals.open({ cwd: '/tmp' });

    checkEqual('nothing to run is refused', terminals.run(made.id, '   ').ok, false);
    checkEqual('so is a command for a terminal that is not open',
      terminals.run('nope', 'ls').ok, false);
    checkEqual('and one long enough to be a pasted file',
      terminals.run(made.id, 'x'.repeat(9000)).ok, false);
    checkEqual('none of which started anything', calls.length, 0);

    terminals.run(made.id, 'sleep 10');
    const second = terminals.run(made.id, 'ls');
    checkEqual('a busy terminal takes one command at a time', second.ok, false);
    check('and says why', /busy/.test(second.reason));
    checkEqual('so only the first ran', calls.length, 1);
  }

  suite('cd is the one thing that outlives the command');

  {
    const { terminals, calls, events } = harness();
    const made = terminals.open({ cwd: os.tmpdir() });
    const up = path.dirname(os.tmpdir());

    const moved = terminals.run(made.id, 'cd ' + up);
    checkEqual('moving is accepted', moved.ok, true);
    checkEqual('without starting a process', calls.length, 0);
    checkEqual('and the terminal is there now', terminals.get(made.id).cwd, up);
    checkEqual('which it says', moved.run.exit, 0);

    const nowhere = terminals.run(made.id, 'cd /definitely/not/a/place');
    checkEqual('somewhere that is not there fails', nowhere.run.exit, 1);
    check('and says so', /no such directory/.test(nowhere.run.output));
    checkEqual('leaving the terminal where it was', terminals.get(made.id).cwd, up);

    terminals.run(made.id, 'cd');
    checkEqual('a bare cd goes home', terminals.get(made.id).cwd, os.homedir());

    // `cd foo && make` is a command, not a move: what it does to a directory is
    // the shell's business and ends with the shell.
    terminals.run(made.id, 'cd /tmp && ls');
    checkEqual('anything more than a move is just a command', calls.length, 1);
    check('the moves are in the scrollback like everything else',
      events.filter((e) => e.type === 'term:began').length >= 3);
  }

  suite('stopping, and giving up');

  {
    const { terminals, child } = harness();
    const made = terminals.open({ cwd: '/tmp' });
    terminals.run(made.id, 'sleep 100');
    checkEqual('stopping asks politely first', terminals.stop(made.id) && child().signals[0], 'SIGTERM');
    child().emit('close', null, 'SIGTERM');
    checkEqual('and the run is marked as stopped',
      terminals.scrollback(made.id).runs.pop().note, 'stopped (SIGTERM)');
    checkEqual('stopping an idle terminal is not an error', terminals.stop(made.id), false);
  }

  {
    // A command that never finishes would hold a process until the window went
    // away. It is given a limit, and the limit is enforced by killing it.
    const { terminals, child } = harness({ limitMs: 20 });
    const made = terminals.open({ cwd: '/tmp' });
    terminals.run(made.id, 'tail -f /var/log/everything');
    await new Promise((r) => setTimeout(r, 60));
    check('one that runs forever is stopped', child().signals.includes('SIGTERM'));
    check('and says why', /stopped after/.test(terminals.scrollback(made.id).runs.pop().output));
  }

  suite('what a screen is given to draw');

  {
    const { terminals, child } = harness();
    const made = terminals.open({ cwd: '/tmp', name: 'alpha' });
    terminals.run(made.id, 'echo one');
    child().emit('close', 0, null);
    terminals.run(made.id, 'echo two');
    child().emit('close', 1, null);

    const back = terminals.scrollback(made.id);
    checkEqual('the scrollback is every run in order', back.runs.map((r) => r.command),
      ['echo one', 'echo two']);
    checkEqual('with how each one ended', back.runs.map((r) => r.exit), [0, 1]);
    check('and no child process in it, which is nobody else’s to hold',
      back.runs.every((r) => !('child' in r)));
    checkEqual('a scrollback for a terminal that is gone is nothing',
      terminals.scrollback('nope'), null);

    terminals.close(made.id);
    checkEqual('closing takes it off the list', terminals.list().length, 0);
    checkEqual('and it cannot be run in any more', terminals.run(made.id, 'ls').ok, false);
  }

  {
    // A command that prints forever must not be able to fill the editor's
    // memory, so the scrollback of one run is capped and says it was cut.
    const { terminals, child } = harness();
    const made = terminals.open({ cwd: '/tmp' });
    terminals.run(made.id, 'yes');
    for (let i = 0; i < 40; i++) child().stdout.emit('data', 'x'.repeat(10000));
    const run = terminals.scrollback(made.id).runs.pop();
    check('a run that prints forever is trimmed', run.output.length < 260 * 1024);
    check('and says it was', run.output.startsWith('…'));
  }

  suite('which blocks are worth a run button');

  check('one that says it is shell', looksRunnable('bash', 'npm test'));
  check('or console, which is what some people write', looksRunnable('console', 'npm test'));
  check('one that says it is something else is not', !looksRunnable('python', 'print(1)'));
  check('nor is json', !looksRunnable('json', '{"a": 1}'));
  check('nor a diff', !looksRunnable('diff', '+ added'));

  check('no language, and it looks like a command', looksRunnable('', 'npm run build'));
  check('several of them still does', looksRunnable('', 'cd app\nnpm install\nnpm test'));
  check('a prompt in front is still a command', looksRunnable('', '$ npm test'));
  check('but code is not', !looksRunnable('', 'const x = 1;'));
  check('nor is a function', !looksRunnable('', 'function go() {'));
  check('nor an import', !looksRunnable('', 'import os'));
  check('nor a whole file of anything', !looksRunnable('', Array(20).fill('ls').join('\n')));
  check('nor one enormous line', !looksRunnable('', 'ls ' + 'x'.repeat(500)));
  check('nor nothing at all', !looksRunnable('', '   '));

  checkEqual('the prompt is not part of the command', cleanCommand('$ npm test'), 'npm test');
  checkEqual('on every line of it', cleanCommand('$ cd app\n$ npm test'), 'cd app\nnpm test');
  checkEqual('and a root prompt counts too', cleanCommand('# apt update'), 'apt update');
  checkEqual('a command with no prompt is left alone',
    cleanCommand('git commit -m "$ money"'), 'git commit -m "$ money"');
};
