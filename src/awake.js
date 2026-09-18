'use strict';

const { spawn } = require('child_process');

/**
 * Keeping the machine awake while there is something to stay awake for.
 *
 * A laptop that goes to sleep takes every instance with it, and the phone finds
 * a dead socket at three in the morning. So while an instance is working — or
 * running with a device able to reach it — this holds an assertion against idle
 * sleep, and lets go the moment there is nothing left to hold it for.
 *
 * Two things it deliberately does not do: it never keeps the display awake, and
 * it is off unless asked. Keeping somebody's laptop awake is not a decision to
 * make on their behalf, and a machine that never sleeps because of a forgotten
 * flag is its own bug — which is why the held process is also told to die with
 * this one, rather than trusted to be cleaned up.
 */
class Awake {
  /**
   * @param {object} [deps]
   * @param {Function} [deps.spawn] child_process.spawn, injected for the tests
   * @param {string} [deps.platform]
   * @param {number} [deps.pid]
   * @param {(line: string) => void} [deps.log]
   */
  constructor(deps) {
    const d = deps || {};
    this.spawn = d.spawn || spawn;
    this.platform = d.platform || process.platform;
    this.pid = d.pid || process.pid;
    this.log = d.log || (() => {});
    this.proc = null;
    this.since = null;
    this.reason = null;
  }

  get held() {
    return !!this.proc;
  }

  /** Whether this machine has a way to do it at all. */
  get supported() {
    return this.platform === 'darwin';
  }

  state() {
    return {
      held: this.held,
      since: this.since,
      reason: this.reason,
      supported: this.supported
    };
  }

  /**
   * Hold it, for a reason worth naming in the status sheet. Holding twice is
   * the same as holding once; only the reason is updated.
   */
  hold(reason) {
    this.reason = reason || 'an instance is working';
    if (this.proc) return true;
    if (!this.supported) {
      this.log('nothing to hold the machine awake with on ' + this.platform);
      return false;
    }
    try {
      // -i: no idle sleep. -s: no system sleep on mains power. Not -d: the
      // screen is welcome to turn off, and leaving it on all night would be a
      // rude way to keep a process alive.
      // -w: caffeinate exits when this process does, so a crash cannot leave
      // the machine awake forever.
      this.proc = this.spawn('caffeinate', ['-i', '-s', '-w', String(this.pid)], {
        stdio: 'ignore',
        detached: false
      });
      this.proc.on('exit', () => { this.proc = null; this.since = null; });
      this.proc.on('error', (err) => {
        this.log('could not hold the machine awake: ' + (err && err.message));
        this.proc = null;
        this.since = null;
      });
      if (this.proc.unref) this.proc.unref();
      this.since = Date.now();
      this.log('holding the machine awake: ' + this.reason);
      return true;
    } catch (err) {
      this.log('could not hold the machine awake: ' + (err && err.message));
      this.proc = null;
      return false;
    }
  }

  release() {
    if (!this.proc) { this.reason = null; return false; }
    const proc = this.proc;
    this.proc = null;
    this.since = null;
    this.reason = null;
    try { proc.kill(); } catch (_) { /* already gone */ }
    this.log('letting the machine sleep again');
    return true;
  }

  dispose() {
    this.release();
  }
}

/**
 * The rule for when it is held, in one place so the status sheet and the thing
 * doing the holding cannot disagree.
 *
 * Working means working: a turn is in flight. Running-and-reachable is the
 * overnight case — an idle instance is worth keeping alive only if something
 * could actually reach it, which means the server is listening.
 *
 * @returns {{hold: boolean, reason: string|null}}
 */
function shouldHold({ enabled, sessions, serving }) {
  if (!enabled) return { hold: false, reason: null };
  const list = sessions || [];
  const busy = list.filter((s) => s.isBusy);
  if (busy.length) {
    return {
      hold: true,
      reason: busy.length === 1
        ? `${busy[0].label} is working`
        : `${busy.length} instances are working`
    };
  }
  if (serving) {
    const running = list.filter((s) => s.isRunning);
    if (running.length) {
      return {
        hold: true,
        reason: `${running.length} instance${running.length === 1 ? '' : 's'} running and reachable`
      };
    }
  }
  return { hold: false, reason: null };
}

module.exports = { Awake, shouldHold };
