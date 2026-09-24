'use strict';

const { spawn } = require('child_process');

/**
 * Keeping the machine awake while there is something to stay awake for.
 *
 * A laptop that goes to sleep takes every instance with it, and the phone finds
 * a dead socket at three in the morning. So while an instance is working — or
 * while a phone could reach this window at all — this holds an assertion
 * against idle sleep, and lets go the moment there is nothing left to hold it
 * for.
 *
 * What it cannot do is stop the lid. A MacBook with its lid closed sleeps
 * whatever any process asks, unless it is plugged in with a display attached;
 * the only thing that overrides that is a system setting that needs an
 * administrator and outlives this process, which is not a thing to change on
 * somebody's behalf. So every place this is offered says so.
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
 * Working means working: a turn is in flight, and a laptop that sleeps halfway
 * through one loses it. Listening is the other reason, and it is enough on its
 * own — the switch exists so a phone can always reach this laptop, and the time
 * that matters most is when nothing is running and you want to start
 * something. An earlier rule held only while an instance was running, which let
 * the laptop sleep at exactly that moment.
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
  if (serving) return { hold: true, reason: 'listening for your phone' };
  return { hold: false, reason: null };
}

/**
 * The switch, as opposed to the thing it switches.
 *
 * One setting, changed from two places — the editor, and a phone that may be in
 * another country — and one rule applied to it. Both talk to this, so neither
 * has to know how the other changed it, and whoever is watching is told either
 * way: a phone that turned it off sees it off, and so does the other phone.
 */
class KeepAwake {
  /**
   * @param {object} deps
   * @param {Awake} deps.awake                       what does the holding
   * @param {() => boolean} deps.enabled             the setting, read fresh
   * @param {(on: boolean) => Promise} deps.write    the setting, written
   * @param {() => object[]} [deps.sessions]
   * @param {() => boolean} [deps.serving]
   */
  constructor(deps) {
    this.awake = deps.awake;
    this.enabled = deps.enabled;
    this.write = deps.write;
    this.sessions = deps.sessions || (() => []);
    this.serving = deps.serving || (() => false);
    // The lid is the other half of the same question — may this laptop sleep —
    // so it is answered here too, and anybody watching hears about both.
    this.lid = deps.lid || null;
    this.lidEnabled = deps.lidEnabled || (() => false);
    this.writeLid = deps.writeLid || null;
    this.listeners = new Set();
    this.said = null;
    if (this.lid) this.stopLid = this.lid.onChange(() => this.announce());
  }

  /** Apply the rule, and tell whoever is watching if what they would see changed. */
  reconsider() {
    const sessions = this.sessions();
    const verdict = shouldHold({
      enabled: this.enabled(),
      sessions,
      serving: this.serving()
    });
    if (verdict.hold) this.awake.hold(verdict.reason);
    else this.awake.release();

    // With the lid closed, only work keeps it going: a laptop shut in a bag
    // should not stay awake just in case a phone calls.
    if (this.lid) {
      if (this.lidEnabled()) {
        const busy = sessions.filter((s) => s.isBusy);
        this.lid.want(busy.length > 0, busy.length === 1
          ? `${busy[0].label} is working`
          : `${busy.length} instances are working`);
      } else {
        this.lid.stop();
      }
    }
    return this.announce();
  }

  /** Tell whoever is watching, if what they would see has changed. */
  announce() {
    const now = this.state();
    const shape = JSON.stringify(now);
    if (shape === this.said) return now;
    this.said = shape;
    for (const fn of this.listeners) {
      try { fn(now); } catch (_) { /* one listener's problem */ }
    }
    return now;
  }

  /** Whether it is on, and — a different question — whether it is holding. */
  state() {
    const held = this.awake.state();
    return {
      on: !!this.enabled(),
      held: held.held,
      since: held.since,
      reason: held.reason,
      supported: held.supported,
      lid: this.lid ? Object.assign({ on: !!this.lidEnabled() }, this.lid.state()) : null
    };
  }

  /** Turn it on or off, and answer with what is true afterwards. */
  async set(on) {
    await this.write(!!on);
    return this.reconsider();
  }

  /**
   * The lid switch. Turning it on needs the one-time approval to be in place
   * already: that is asked for at the laptop, where the password dialog is,
   * and never from a phone that cannot see it.
   */
  async setLid(on) {
    if (!this.lid || !this.writeLid) throw new Error('This laptop does not offer that.');
    if (on && !(await this.lid.ready())) {
      const err = new Error('Approve it once on the laptop first.');
      err.code = 'NEEDS_APPROVAL';
      throw err;
    }
    await this.writeLid(!!on);
    return this.reconsider();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose() {
    this.listeners.clear();
    if (this.stopLid) this.stopLid();
    if (this.lid) this.lid.dispose();
    this.awake.dispose();
  }
}

module.exports = { Awake, KeepAwake, shouldHold };
