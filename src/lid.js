'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

/**
 * Keeping the work going with the lid closed.
 *
 * A MacBook with its lid shut goes to sleep whatever any process asks, unless
 * it has power and a display attached. The one thing that overrides that is a
 * system flag — `pmset disablesleep` — and setting it needs root. So:
 *
 *   Once, with your admin password, NikUI is allowed to run exactly three
 *   commands without one: sleep off, sleep on, and sleep now. Nothing else.
 *   After that it needs nobody. A job started from a phone in another country
 *   keeps running with the lid closed, and when the last one is done the
 *   laptop goes to sleep, the way a closed laptop should.
 *
 * The flag is global and it outlives this process, which makes it the most
 * dangerous thing NikUI touches: a Mac that cannot sleep, in a bag, gets hot
 * and flat. So every way out of here puts it back —
 *
 *   - the last job finishing, after a grace for the answer you send back;
 *   - the battery reaching its floor;
 *   - the switch being turned off;
 *   - this window closing, or crashing: a watchdog outside this process waits
 *     for it to go and puts the flag back itself;
 *   - the next start, which clears whatever a crash of the whole machine left.
 *
 * And it only ever puts back what it set. A Mac somebody had told never to
 * sleep before NikUI came along is left the way they told it.
 */

const PMSET = '/usr/bin/pmset';
const SUDO = '/usr/bin/sudo';
const RULE = '/etc/sudoers.d/nikui-lid';

// Long enough to read "finished" on a phone and answer it before the laptop
// has gone; short enough that a closed laptop is asleep before it is in a bag
// for long.
const GRACE_MS = 2 * 60 * 1000;

// Below this, on battery, a closed laptop sleeps even with work running: a job
// cut off at twenty percent can be resumed, and a Mac run flat cannot say so.
const BATTERY_FLOOR = 20;

const CHECK_MS = 60 * 1000;

// Only what the system ships, whatever PATH the editor was started with.
const PLAIN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function defaultDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'NikUI', 'lid');
}

function run(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, Object.assign({ timeout: 15000, env: { PATH: PLAIN_PATH } }, opts || {}),
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      }));
  });
}

/** An AppleScript string literal: quotes and backslashes are the only escapes. */
const appleString = (text) => '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

// A user name that can be written into a sudoers rule as it stands. Anything
// else is refused rather than quoted: this file decides who is root.
const PLAIN_USER = /^[a-z_][a-z0-9_.-]*$/i;

/** The rule, exactly: three commands, their arguments fixed, for one user. */
function ruleFor(user) {
  return `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0, ${PMSET} -a disablesleep 1, ${PMSET} sleepnow`;
}

/**
 * The script that installs it, run as root by macOS's own password dialog.
 *
 * Written into the root-owned directory it ends up in, under a name sudo
 * ignores while it is being checked — a name with a dot in it — so there is no
 * moment where a half-written rule is live, and nothing in a world-writable
 * place for anyone to swap. Checked by visudo before it is moved into place: a
 * broken file in sudoers.d is how a machine loses sudo altogether.
 */
function installScript(user) {
  return [
    'set -e',
    '/bin/mkdir -p /etc/sudoers.d',
    'f=$(/usr/bin/mktemp /etc/sudoers.d/.nikui.XXXXXX)',
    "trap '/bin/rm -f \"$f\"' EXIT",
    "/usr/bin/printf '%s\\n' '# Added by NikUI: keep working with the lid closed. Delete this file to undo.' '" +
      ruleFor(user) + "' > \"$f\"",
    '/usr/sbin/visudo -cf "$f" >/dev/null',
    '/usr/sbin/chown root:wheel "$f"',
    '/bin/chmod 0440 "$f"',
    '/bin/mv -f "$f" ' + RULE
  ].join('; ');
}

// Outside this process, so a crash cannot take it down too. It waits for the
// window to go, then does what the window would have done: takes its name off
// the list and, if nobody else is on it and the flag is ours, puts it back.
const WATCHDOG = [
  'while kill -0 "$NIKUI_PID" 2>/dev/null; do sleep 5; done',
  'rm -f "$NIKUI_DIR/$NIKUI_PID"',
  'for f in "$NIKUI_DIR"/[0-9]*; do [ -e "$f" ] || continue; kill -0 "${f##*/}" 2>/dev/null && exit 0; rm -f "$f"; done',
  '[ -e "$NIKUI_DIR/owned" ] || exit 0',
  '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0 && rm -f "$NIKUI_DIR/owned"'
].join('\n');

class LidGuard {
  /**
   * @param {object} [deps]
   * @param {string} [deps.platform]
   * @param {Function} [deps.run]     (file, args, opts) => Promise<{code, stdout, stderr}>
   * @param {Function} [deps.spawn]   for the watchdog
   * @param {string} [deps.dir]       where the windows holding the flag sign their names
   * @param {number} [deps.pid]
   * @param {string} [deps.user]
   * @param {object} [deps.timers]
   */
  constructor(deps) {
    const d = deps || {};
    this.platform = d.platform || process.platform;
    this.run = d.run || run;
    this.spawn = d.spawn || spawn;
    this.fs = d.fs || fs;
    this.dir = d.dir || defaultDir();
    this.pid = d.pid || process.pid;
    this.user = d.user || safeUser();
    this.now = d.now || (() => Date.now());
    this.graceMs = d.graceMs != null ? d.graceMs : GRACE_MS;
    this.floor = d.floor != null ? d.floor : BATTERY_FLOOR;
    this.checkMs = d.checkMs || CHECK_MS;
    this.timers = d.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
    this.log = d.log || (() => {});
    this.isAlive = d.isAlive || alive;

    this.approved = null;   // unknown until sudo has been asked
    this.held = false;
    this.since = null;
    this.reason = null;
    this.wanted = false;
    this.battery = null;    // { ac, percent }
    this.graceTimer = null;
    this.checkTimer = null;
    this.watchdog = null;
    this.listeners = new Set();
    this.giveUps = new Set();
    this.queue = Promise.resolve();
  }

  get supported() {
    return this.platform === 'darwin';
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Told when it lets go with work still running, so a phone can be told why. */
  onGiveUp(fn) { this.giveUps.add(fn); return () => this.giveUps.delete(fn); }

  changed() {
    const now = this.state();
    for (const fn of this.listeners) { try { fn(now); } catch (_) { /* theirs */ } }
  }

  state() {
    return {
      supported: this.supported,
      approved: this.approved,
      held: this.held,
      since: this.since,
      reason: this.held ? this.reason : null,
      // The work is done and the grace is running: a closed lid sleeps soon.
      finishing: !!this.graceTimer,
      battery: this.battery,
      lowBattery: this.tooLow()
    };
  }

  /** One thing at a time: a release must not land in the middle of a hold. */
  enqueue(job) {
    this.queue = this.queue.then(job).catch((err) => this.log('lid: ' + ((err && err.message) || err)));
    return this.queue;
  }

  // ---- what is asked of it ------------------------------------------------

  /**
   * Whether work is running, said on every change. Holding starts at once;
   * letting go waits out the grace, so a queue draining between two turns — or
   * an answer sent back from the notification — does not find a laptop asleep.
   */
  want(active, reason) {
    this.wanted = !!active;
    if (active) {
      if (reason) this.reason = reason;
      this.cancelGrace();
      if (!this.held) this.enqueue(() => this.take());
      return;
    }
    if (this.held && !this.graceTimer) {
      this.graceTimer = this.timers.setTimeout(() => {
        this.graceTimer = null;
        if (!this.wanted) this.enqueue(() => this.give(true));
      }, this.graceMs);
      this.changed();
    }
  }

  /** The switch turned off: no grace, because nobody asked for one. */
  stop() {
    this.wanted = false;
    this.cancelGrace();
    if (this.held) return this.enqueue(() => this.give(true));
    return this.queue;
  }

  cancelGrace() {
    if (!this.graceTimer) return;
    this.timers.clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.changed();
  }

  // ---- the one-time approval ------------------------------------------------

  /** Whether the rule is in place: sudo says so without being given a password. */
  async ready() {
    if (!this.supported) { this.approved = false; return false; }
    const out = await this.run(SUDO, ['-n', '-l', PMSET, '-a', 'disablesleep', '1']);
    const was = this.approved;
    this.approved = out.code === 0;
    if (was !== this.approved) this.changed();
    return this.approved;
  }

  /**
   * Ask for the admin password, once, in macOS's own dialog, and install the
   * rule. The dialog says what it is for; cancelling it changes nothing.
   *
   * @returns {Promise<{ok: boolean, cancelled?: boolean, reason?: string}>}
   */
  async setUp() {
    if (!this.supported) return { ok: false, reason: 'Only a Mac can be kept awake with the lid closed.' };
    if (!PLAIN_USER.test(this.user)) {
      return { ok: false, reason: `The user name "${this.user}" cannot be written into the rule safely.` };
    }
    const prompt = 'NikUI wants to keep your Mac working with the lid closed while Claude is running a job. ' +
      'This lets NikUI turn sleep off and back on, and nothing else.';
    const script = 'do shell script ' + appleString(installScript(this.user)) +
      ' with prompt ' + appleString(prompt) + ' with administrator privileges';
    const out = await this.run('/usr/bin/osascript', ['-e', script], { timeout: 5 * 60 * 1000 });
    if (out.code !== 0) {
      const cancelled = /-128|cancel/i.test(out.stderr);
      return cancelled
        ? { ok: false, cancelled: true }
        : { ok: false, reason: (out.stderr || 'macOS would not install it').trim() };
    }
    const ok = await this.ready();
    return ok ? { ok: true } : { ok: false, reason: 'It was installed, but sudo does not accept it.' };
  }

  /** The approval taken back: the flag first, while there is still a way to clear it. */
  async takeDown() {
    await this.stop();
    const script = 'do shell script ' + appleString('/bin/rm -f ' + RULE) +
      ' with prompt ' + appleString('NikUI will stop keeping your Mac awake with the lid closed.') +
      ' with administrator privileges';
    const out = await this.run('/usr/bin/osascript', ['-e', script], { timeout: 5 * 60 * 1000 });
    await this.ready();
    return out.code === 0 ? { ok: true } : { ok: false, cancelled: /-128|cancel/i.test(out.stderr) };
  }

  // ---- holding and letting go -----------------------------------------------

  async take() {
    if (this.held || !this.wanted || !this.supported) return;
    if (!(await this.ready())) {
      this.log('lid: not approved yet, so a closed lid will still sleep this Mac');
      return;
    }
    await this.readBattery();
    if (this.tooLow()) {
      this.log(`lid: battery at ${this.battery.percent}%, so a closed lid will sleep this Mac`);
      this.changed();
      return;
    }
    this.sign();
    // Set already and not by us means somebody wants this Mac awake for
    // reasons of their own: leaning on that is fine, clearing it later would
    // not be — which is what `owned` is for.
    if (!(await this.flag())) {
      const out = await this.sudo('-a', 'disablesleep', '1');
      if (out.code !== 0) {
        this.unsign();
        this.log('lid: could not turn sleep off: ' + (out.stderr || out.code).toString().trim());
        this.changed();
        return;
      }
      this.claim();
    }
    this.held = true;
    this.since = this.now();
    this.guard();
    this.startChecks();
    this.log('lid: closing the lid will not stop ' + (this.reason || 'the work'));
    this.changed();
    // The work can finish while sudo is being asked; that is a grace like any other.
    if (!this.wanted) this.want(false);
  }

  /**
   * Let go. If nobody else is holding and the flag was ours, it goes back — and
   * if the lid is shut by then, the laptop sleeps now, because that is what
   * closing it asked for.
   */
  async give(sleepIfClosed) {
    if (!this.held) return;
    this.held = false;
    this.since = null;
    this.cancelGrace();
    this.stopChecks();
    this.unguard();
    this.unsign();
    let freed = false;
    if (!this.others().length && this.owned()) {
      const out = await this.sudo('-a', 'disablesleep', '0');
      if (out.code === 0) { this.unclaim(); freed = true; }
      else this.log('lid: could not turn sleep back on: ' + (out.stderr || out.code).toString().trim());
    }
    this.changed();
    if (sleepIfClosed && freed && await this.closed()) {
      this.log('lid: the work is done and the lid is closed, so this Mac is going to sleep');
      await this.sudo('sleepnow');
    }
  }

  /**
   * On start: whatever a crash left behind — ours, and nobody still holding it
   * — is put back.
   */
  recover() {
    // In the same line as everything else, so a job starting the moment the
    // window opens cannot have its hold cleared by the tidy-up running beside it.
    return this.enqueue(() => this.tidy());
  }

  async tidy() {
    if (!this.supported || this.held) return;
    if (this.owned() && !this.others().length && await this.flag()) {
      const out = await this.sudo('-a', 'disablesleep', '0');
      if (out.code === 0) {
        this.unclaim();
        this.log('lid: put sleep back on, after a window that was holding it went away');
      }
    } else if (this.owned() && !this.others().length) {
      this.unclaim();
    }
  }

  // ---- the machine ------------------------------------------------------------

  sudo(...args) {
    return this.run(SUDO, ['-n', PMSET].concat(args));
  }

  /** Whether sleep is turned off right now, by anybody. */
  async flag() {
    const out = await this.run(PMSET, ['-g']);
    const m = /SleepDisabled\s+(\d)/.exec(out.stdout);
    return !!(m && m[1] === '1');
  }

  async closed() {
    const out = await this.run('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4']);
    return /"AppleClamshellState"\s*=\s*Yes/.test(out.stdout);
  }

  async readBattery() {
    const out = await this.run(PMSET, ['-g', 'batt']);
    const percent = /(\d+)%/.exec(out.stdout);
    this.battery = {
      // A Mac with no battery is on mains power by definition.
      ac: /AC Power/.test(out.stdout) || !percent,
      percent: percent ? Number(percent[1]) : null
    };
    return this.battery;
  }

  tooLow() {
    const b = this.battery;
    return !!(b && !b.ac && b.percent != null && b.percent <= this.floor);
  }

  startChecks() {
    this.stopChecks();
    this.checkTimer = this.timers.setInterval(() => this.enqueue(() => this.check()), this.checkMs);
  }

  stopChecks() {
    if (!this.checkTimer) return;
    this.timers.clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  /** Once a minute while holding: the battery, and whether the flag is still set. */
  async check() {
    if (!this.held) return;
    const before = JSON.stringify(this.battery);
    await this.readBattery();
    if (this.tooLow()) {
      const lidShut = await this.closed();
      if (lidShut && this.wanted) {
        for (const fn of this.giveUps) {
          try { fn({ why: 'battery', percent: this.battery.percent, reason: this.reason }); } catch (_) { /* theirs */ }
        }
      }
      this.log(`lid: battery down to ${this.battery.percent}%, letting go`);
      return this.give(true);
    }
    // Somebody turned it back on by hand. Say so rather than claim to hold it.
    if (!(await this.flag())) {
      this.log('lid: sleep was turned back on from outside NikUI');
      this.held = false;
      this.since = null;
      this.stopChecks();
      this.unguard();
      this.unsign();
      this.unclaim();
      return this.changed();
    }
    if (JSON.stringify(this.battery) !== before) this.changed();
  }

  // ---- who is holding it ------------------------------------------------------

  ensureDir() {
    try { this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); } catch (_) { /* there already */ }
  }

  sign() { this.ensureDir(); this.fs.writeFileSync(path.join(this.dir, String(this.pid)), String(this.now())); }
  unsign() { try { this.fs.unlinkSync(path.join(this.dir, String(this.pid))); } catch (_) { /* gone */ } }
  claim() { this.ensureDir(); this.fs.writeFileSync(path.join(this.dir, 'owned'), String(this.now())); }
  unclaim() { try { this.fs.unlinkSync(path.join(this.dir, 'owned')); } catch (_) { /* gone */ } }
  owned() { try { return this.fs.existsSync(path.join(this.dir, 'owned')); } catch (_) { return false; } }

  /** Every other window still holding it, clearing the names of any that are gone. */
  others() {
    let names = [];
    try { names = this.fs.readdirSync(this.dir); } catch (_) { return []; }
    const live = [];
    for (const name of names) {
      if (!/^\d+$/.test(name) || Number(name) === this.pid) continue;
      if (this.isAlive(Number(name))) live.push(Number(name));
      else { try { this.fs.unlinkSync(path.join(this.dir, name)); } catch (_) { /* gone */ } }
    }
    return live;
  }

  guard() {
    this.unguard();
    try {
      this.watchdog = this.spawn('/bin/sh', ['-c', WATCHDOG], {
        detached: true,
        stdio: 'ignore',
        env: { PATH: PLAIN_PATH, NIKUI_PID: String(this.pid), NIKUI_DIR: this.dir }
      });
      if (this.watchdog && this.watchdog.unref) this.watchdog.unref();
    } catch (err) {
      this.log('lid: no watchdog, so a crash here would leave sleep off until the next start: ' +
        ((err && err.message) || err));
      this.watchdog = null;
    }
  }

  unguard() {
    if (!this.watchdog) return;
    try { this.watchdog.kill(); } catch (_) { /* gone */ }
    this.watchdog = null;
  }

  /**
   * The window is going. The watchdog is left running on purpose: it puts the
   * flag back once this process has actually gone, which is the one moment
   * that cannot be raced. Doing it here instead would mean killing the
   * watchdog and then hoping a sudo finishes before the process does.
   */
  dispose() {
    this.cancelGrace();
    this.stopChecks();
    this.wanted = false;
    this.listeners.clear();
    this.giveUps.clear();
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

function safeUser() {
  try { return os.userInfo().username; } catch (_) { return process.env.USER || ''; }
}

module.exports = { LidGuard, ruleFor, installScript, appleString, WATCHDOG, RULE, GRACE_MS, BATTERY_FLOOR };
