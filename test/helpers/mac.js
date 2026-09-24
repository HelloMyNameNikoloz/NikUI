'use strict';

// A Mac, as far as NikUI's lid switch can tell: sudo, pmset, the lid, the
// battery, and a clock that only moves when it is told to. Shared by every
// check that needs a laptop which can be closed without anybody closing one.

/** A Mac, as far as pmset, sudo and ioreg can tell. */
function fakeMac(options) {
  const o = options || {};
  const mac = {
    approved: !!o.approved,
    flag: o.flag ? 1 : 0,
    lidClosed: !!o.lidClosed,
    battery: o.battery || { ac: true, percent: 80 },
    cancel: false,
    slept: 0,
    scripts: [],
    calls: []
  };
  mac.run = async (file, args) => {
    mac.calls.push([file].concat(args).join(' '));
    const said = (stdout, code) => ({ code: code || 0, stdout: stdout || '', stderr: code ? 'refused' : '' });
    if (file === '/usr/bin/sudo') {
      if (!mac.approved) return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
      if (args[1] === '-l') return said('/usr/bin/pmset -a disablesleep 1\n');
      if (args.slice(1).join(' ') === '/usr/bin/pmset sleepnow') { mac.slept++; return said(); }
      const m = /disablesleep (\d)$/.exec(args.join(' '));
      if (m) { mac.flag = Number(m[1]); return said(); }
      return said('', 1);
    }
    if (file === '/usr/bin/pmset' && args.join(' ') === '-g') {
      return said(' sleep 1\n' + (mac.flag ? ' SleepDisabled\t\t1\n' : ''));
    }
    if (file === '/usr/bin/pmset' && args.join(' ') === '-g batt') {
      const b = mac.battery;
      return said(`Now drawing from '${b.ac ? 'AC Power' : 'Battery Power'}'\n` +
        (b.percent == null ? '' : ` -InternalBattery-0 (id=1)\t${b.percent}%; ${b.ac ? 'charging' : 'discharging'};\n`));
    }
    if (file === '/usr/sbin/ioreg') {
      return said(`  |   "AppleClamshellState" = ${mac.lidClosed ? 'Yes' : 'No'}\n`);
    }
    if (file === '/usr/bin/osascript') {
      mac.scripts.push(args[1]);
      if (mac.cancel) return { code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' };
      if (/rm -f \/etc\/sudoers\.d\/nikui-lid/.test(args[1])) mac.approved = false;
      else mac.approved = true;
      return said();
    }
    return said('', 1);
  };
  return mac;
}

/** Time, by hand: nothing waits two real minutes for a grace to run out. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  const add = (fn, ms, every) => { const id = ++seq; due.set(id, { fn, at: now + ms, every }); return id; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: (id) => due.delete(id),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: (id) => due.delete(id),
    pending: () => due.size,
    async tick(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else due.delete(id);
        t.fn();
        await settle();
      }
      now = until;
      await settle();
    }
  };
}

const settle = () => new Promise((r) => setImmediate(r));

function watchdogs() {
  const spawned = [];
  const fakeSpawn = (file, args, options) => {
    const proc = { file, args, options, killed: false, kill() { this.killed = true; }, unref() {} };
    spawned.push(proc);
    return proc;
  };
  return { spawn: fakeSpawn, spawned, running: () => spawned.filter((p) => !p.killed) };
}

module.exports = { fakeMac, fakeTimers, watchdogs, settle };
