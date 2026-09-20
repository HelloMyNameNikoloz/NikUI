'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
// One implementation of "is that a command", shared with the client that draws
// the button: two copies of a guess drift into two different guesses.
const { looksRunnable, cleanCommand } = require('../media/runnable.js');

/**
 * Running a command on this machine, from somewhere else.
 *
 * Not a terminal emulator. There is no PTY here — this project has no
 * dependencies and will not grow one for this — so there is no job control, no
 * cursor addressing, and nothing interactive: `vim` has nothing to draw on and
 * `sudo` has nowhere to ask. What there is instead is the thing you actually
 * want from a phone, and which a real terminal is a clumsy way to get: a
 * command, its output, and whether it worked.
 *
 * That shape is better for this than a stream of bytes would be. Each run is a
 * block with a beginning, an end and an exit code, so a phone can show it as
 * one thing, say whether it failed, and let you scroll back through what you
 * have run without parsing a screen.
 *
 * `cd` is the one thing a person expects to persist, and it does: the working
 * directory belongs to the terminal rather than to the command, and a bare `cd`
 * moves it. Everything else is its own process, which is why one command
 * falling over cannot take the session with it.
 */

// A command that never finishes would otherwise hold a process open until the
// window closed. Fifteen minutes is longer than a build and shorter than a
// mistake nobody notices.
const LIMIT_MS = 15 * 60 * 1000;

// Enough scrollback to read what happened, little enough that a command that
// prints forever cannot fill the memory of the editor running it.
const KEEP_BYTES = 200 * 1024;

let counter = 0;

class Terminals {
  /**
   * @param {{spawn?: Function, shell?: string, now?: Function, onEvent?: Function}} deps
   */
  constructor(deps) {
    const d = deps || {};
    this.spawn = d.spawn || spawn;
    this.shell = d.shell || defaultShell();
    this.now = d.now || (() => Date.now());
    this.onEvent = d.onEvent || (() => {});
    this.limitMs = d.limitMs || LIMIT_MS;
    this.sessions = new Map();
  }

  /** A place to run things, rooted somewhere. */
  open({ cwd, name }) {
    const id = 't' + (++counter) + '-' + Math.random().toString(36).slice(2, 8);
    const session = {
      id,
      name: name || (cwd ? path.basename(cwd) : 'Terminal'),
      cwd: cwd || os.homedir(),
      openedAt: this.now(),
      running: null,
      history: []
    };
    this.sessions.set(id, session);
    return this.describe(session);
  }

  get(id) { return this.sessions.get(String(id)) || null; }

  list() {
    return [...this.sessions.values()].map((s) => this.describe(s));
  }

  describe(session) {
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      busy: !!session.running,
      command: session.running ? session.running.command : null
    };
  }

  close(id) {
    const session = this.get(id);
    if (!session) return false;
    this.stop(id);
    this.sessions.delete(session.id);
    return true;
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  /**
   * Run one command.
   *
   * @returns {{ok: true, run: object} | {ok: false, reason: string}}
   */
  run(id, command) {
    const session = this.get(id);
    if (!session) return { ok: false, reason: 'that terminal is not open' };
    if (session.running) return { ok: false, reason: 'that terminal is busy' };

    const text = String(command == null ? '' : command).trim();
    if (!text) return { ok: false, reason: 'nothing to run' };
    // Not a limit anybody meets by accident; it is there so a paste of a whole
    // file does not become a command line.
    if (text.length > 8000) return { ok: false, reason: 'that command is too long' };

    // `cd` on its own is the one thing that has to outlive the process that
    // ran it, because a working directory is what a person means by "where I
    // am". Anything more complicated is a command like any other.
    const moved = text.match(/^cd\s*(?:(['"])(.*)\1|([^\s;&|]*))\s*$/);
    if (moved) {
      const wanted = (moved[2] !== undefined ? moved[2] : moved[3]) || '';
      const to = !wanted || wanted === '~'
        ? os.homedir()
        : path.resolve(session.cwd, wanted.replace(/^~(?=\/|$)/, os.homedir()));
      let ok = false;
      try { ok = require('fs').statSync(to).isDirectory(); } catch (_) { ok = false; }
      if (!ok) {
        const run = this.began(session, text);
        this.say(session, run, 'err', 'cd: no such directory: ' + wanted + '\n');
        return { ok: true, run: this.ended(session, run, 1, null) };
      }
      session.cwd = to;
      const run = this.began(session, text);
      this.say(session, run, 'out', to + '\n');
      return { ok: true, run: this.ended(session, run, 0, null) };
    }

    const run = this.began(session, text);
    let child;
    try {
      // Through a login shell, so what runs is what would run if you typed it:
      // the same aliases are absent, but the same PATH, the same nvm, the same
      // everything a profile sets up. `-lc` rather than an interactive shell
      // because there is no terminal for an interactive one to talk to.
      child = this.spawn(this.shell, ['-lc', text], {
        cwd: session.cwd,
        env: Object.assign({}, process.env, {
          // Tools that draw progress bars and colour when they see a terminal
          // are looking at this. There is no terminal.
          TERM: 'dumb',
          NO_COLOR: '1',
          CI: '1'
        })
      });
    } catch (err) {
      this.say(session, run, 'err', ((err && err.message) || 'could not start a shell') + '\n');
      return { ok: true, run: this.ended(session, run, null, 'could not start a shell') };
    }

    session.running = run;
    run.child = child;

    if (child.stdout) child.stdout.on('data', (chunk) => this.say(session, run, 'out', String(chunk)));
    if (child.stderr) child.stderr.on('data', (chunk) => this.say(session, run, 'err', String(chunk)));

    const giveUp = setTimeout(() => {
      this.say(session, run, 'err', '\n[stopped after ' + Math.round(this.limitMs / 60000) + ' minutes]\n');
      this.stop(session.id);
    }, this.limitMs);
    if (giveUp.unref) giveUp.unref();
    run.timer = giveUp;

    child.on('error', (err) => {
      this.say(session, run, 'err', ((err && err.message) || 'that would not run') + '\n');
      this.ended(session, run, null, (err && err.message) || 'that would not run');
    });
    child.on('close', (code, signal) => {
      this.ended(session, run, code, signal ? 'stopped (' + signal + ')' : null);
    });

    return { ok: true, run: this.shape(run) };
  }

  /** Stop whatever is running, without closing the terminal. */
  stop(id) {
    const session = this.get(id);
    if (!session || !session.running) return false;
    const run = session.running;
    try { if (run.child) run.child.kill('SIGTERM'); } catch (_) { /* already gone */ }
    // A process that ignores a polite ask gets an impolite one, once.
    const harder = setTimeout(() => {
      try { if (run.child && !run.done) run.child.kill('SIGKILL'); } catch (_) { /* gone */ }
    }, 2000);
    if (harder.unref) harder.unref();
    return true;
  }

  // ---- what a run looks like from outside --------------------------------------

  began(session, command) {
    const run = {
      id: session.id + ':' + (session.history.length + 1),
      terminal: session.id,
      command,
      cwd: session.cwd,
      at: this.now(),
      output: '',
      exit: null,
      note: null,
      done: false
    };
    session.history.push(run);
    while (session.history.length > 60) session.history.shift();
    this.onEvent({ type: 'term:began', run: this.shape(run), terminal: this.describe(session) });
    return run;
  }

  say(session, run, stream, text) {
    if (!text) return;
    run.output += text;
    if (run.output.length > KEEP_BYTES) {
      run.output = '…\n' + run.output.slice(-KEEP_BYTES);
    }
    this.onEvent({ type: 'term:out', run: run.id, terminal: session.id, stream, text });
  }

  ended(session, run, exit, note) {
    if (run.done) return this.shape(run);
    run.done = true;
    run.exit = exit === undefined ? null : exit;
    run.note = note || null;
    run.tookMs = this.now() - run.at;
    if (run.timer) clearTimeout(run.timer);
    run.child = null;
    if (session.running === run) session.running = null;
    this.onEvent({ type: 'term:done', run: this.shape(run), terminal: this.describe(session) });
    return this.shape(run);
  }

  /** Without the child, which is not anybody else's to hold. */
  shape(run) {
    return {
      id: run.id,
      terminal: run.terminal,
      command: run.command,
      cwd: run.cwd,
      at: run.at,
      exit: run.exit,
      note: run.note,
      done: run.done,
      tookMs: run.tookMs || 0,
      output: run.output
    };
  }

  /** Everything a screen needs to draw a terminal it has just opened. */
  scrollback(id) {
    const session = this.get(id);
    if (!session) return null;
    return {
      terminal: this.describe(session),
      runs: session.history.map((run) => this.shape(run))
    };
  }
}

/**
 * The shell a person would get if they opened one.
 *
 * $SHELL, because that is the one they chose. Windows is not served here: this
 * builds `-lc` arguments, which cmd.exe does not take, and pretending otherwise
 * would fail further away from the cause.
 */
function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

module.exports = { Terminals, defaultShell, looksRunnable, cleanCommand, LIMIT_MS, KEEP_BYTES };
