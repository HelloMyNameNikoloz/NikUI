'use strict';

// Keeping the work going with the lid closed.
//
// The flag this turns is global, needs root, and outlives the process that set
// it — so what is checked here is mostly the ways out: that the last job
// finishing puts it back, that a low battery does, that a second window does
// not clear it under the first, that a crash is cleaned up after, and that a
// Mac somebody set to never sleep themselves is left alone.
//
// The machine is a fake one — sudo, pmset, the lid and the battery — so nothing
// here asks for a password or keeps this laptop awake. The two shell scripts
// are real, and run for real where they can be without root.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { LidGuard, ruleFor, installScript, appleString, WATCHDOG, RULE } = require('../src/lid.js');

const { fakeMac, fakeTimers, watchdogs } = require('./helpers/mac.js');

function guard(mac, extra) {
  const e = extra || {};
  const timers = e.timers || fakeTimers();
  const dogs = e.dogs || watchdogs();
  const live = e.live || new Set();
  const pid = e.pid || 4242;
  live.add(pid);
  const lid = new LidGuard({
    platform: 'darwin',
    run: mac.run,
    spawn: dogs.spawn,
    dir: e.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-lid-')),
    pid,
    user: e.user || 'nikoloz',
    timers,
    isAlive: (p) => live.has(p),
    graceMs: 2 * 60 * 1000
  });
  return { lid, timers, dogs, live };
}

const MIN = 60 * 1000;

module.exports = async function () {
  suite('before the one-time approval, nothing is touched');

  {
    const mac = fakeMac();
    const { lid } = guard(mac);
    lid.want(true, '1327 is working');
    await lid.queue;
    checkEqual('sudo says no without a password', lid.state().approved, false);
    checkEqual('so sleep is not turned off', mac.flag, 0);
    checkEqual('and nothing claims to hold it', lid.state().held, false);
    check('and no password was asked for behind anybody’s back', mac.scripts.length === 0);
  }

  suite('the approval, asked for once, in macOS’s own dialog');

  {
    const mac = fakeMac();
    const { lid } = guard(mac);
    const done = await lid.setUp();
    check('it is approved', done.ok && lid.state().approved === true);
    const script = mac.scripts[0] || '';
    check('with administrator privileges, through the system dialog', /with administrator privileges$/.test(script));
    check('which says what it is for', /with the lid closed/.test(script) && /nothing else/.test(script));
    check('checked by visudo before it is moved into place', /visudo -cf/.test(script) &&
      script.indexOf('visudo') < script.indexOf('/bin/mv'));
    check('into a file sudo will actually read — no dot in the name', RULE === '/etc/sudoers.d/nikui-lid');
    check('allowing three commands and nothing more',
      ruleFor('nikoloz') === 'nikoloz ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, ' +
        '/usr/bin/pmset -a disablesleep 1, /usr/bin/pmset sleepnow');

    const refusing = fakeMac();
    refusing.cancel = true;
    const cancelled = await guard(refusing).lid.setUp();
    check('cancelling the dialog is a cancel, not an error', cancelled.ok === false && cancelled.cancelled === true);
    checkEqual('and changes nothing', refusing.approved, false);

    const odd = fakeMac();
    const strange = await guard(odd, { user: 'me; rm -rf /' }).lid.setUp();
    check('a user name that is not plain is refused rather than quoted', !strange.ok);
    checkEqual('before any dialog is shown', odd.scripts.length, 0);
  }

  suite('work running: closing the lid does not stop it');

  {
    const mac = fakeMac({ approved: true });
    const { lid, timers, dogs } = guard(mac);
    lid.want(true, '1327 is working');
    await lid.queue;
    checkEqual('sleep is turned off', mac.flag, 1);
    check('and held, for a reason it can say', lid.state().held && lid.state().reason === '1327 is working');
    check('this window has signed for it', fs.existsSync(path.join(lid.dir, '4242')));
    check('and marked it as ours to put back', fs.existsSync(path.join(lid.dir, 'owned')));
    const dog = dogs.running()[0];
    check('a watchdog outside this process is watching it', !!dog && dog.options.detached === true);
    checkEqual('told which process to outlive', dog && dog.options.env.NIKUI_PID, '4242');

    mac.lidClosed = true;
    lid.want(false);
    await timers.tick(MIN);
    checkEqual('the work finishing does not sleep it at once', mac.flag, 1);
    check('it says the work is done and it is finishing', lid.state().finishing);
    checkEqual('nor put to sleep yet', mac.slept, 0);

    lid.want(true, 'the answer you sent back');
    await timers.tick(5 * MIN);
    checkEqual('new work inside the grace keeps it going', mac.flag, 1);
    checkEqual('with nothing slept', mac.slept, 0);

    lid.want(false);
    await timers.tick(2 * MIN + 1);
    await lid.queue;
    checkEqual('once the grace is over, sleep is back on', mac.flag, 0);
    checkEqual('and with the lid shut, it goes to sleep now', mac.slept, 1);
    check('its name is off the list', !fs.existsSync(path.join(lid.dir, '4242')));
    check('and it is no longer ours to put back', !fs.existsSync(path.join(lid.dir, 'owned')));
    checkEqual('the watchdog is gone with it', dogs.running().length, 0);
    checkEqual('and nothing is left running on a timer', timers.pending(), 0);
  }

  suite('with the lid open, finishing is only finishing');

  {
    const mac = fakeMac({ approved: true });
    const { lid, timers } = guard(mac);
    lid.want(true, 'x');
    await lid.queue;
    lid.want(false);
    await timers.tick(3 * MIN);
    await lid.queue;
    checkEqual('sleep is back on', mac.flag, 0);
    checkEqual('and an open laptop is not put to sleep', mac.slept, 0);
  }

  suite('the switch turned off lets go at once');

  {
    const mac = fakeMac({ approved: true, lidClosed: true });
    const { lid } = guard(mac);
    lid.want(true, 'x');
    await lid.queue;
    await lid.stop();
    checkEqual('no grace, because nobody asked for one', mac.flag, 0);
    checkEqual('and a shut laptop sleeps', mac.slept, 1);
  }

  suite('the battery has a floor');

  {
    const low = fakeMac({ approved: true, battery: { ac: false, percent: 15 } });
    const { lid: refuses } = guard(low);
    refuses.want(true, 'x');
    await refuses.queue;
    checkEqual('at fifteen percent on battery it will not start holding', low.flag, 0);
    check('and says the battery is why', refuses.state().lowBattery);

    const plugged = fakeMac({ approved: true, battery: { ac: true, percent: 5 } });
    const { lid: charging } = guard(plugged);
    charging.want(true, 'x');
    await charging.queue;
    checkEqual('plugged in, the percentage does not matter', plugged.flag, 1);

    const draining = fakeMac({ approved: true, lidClosed: true, battery: { ac: false, percent: 60 } });
    const { lid, timers } = guard(draining);
    const told = [];
    lid.onGiveUp((why) => told.push(why));
    lid.want(true, '1327 is working');
    await lid.queue;
    checkEqual('on battery above the floor, it holds', draining.flag, 1);
    draining.battery = { ac: false, percent: 18 };
    await timers.tick(MIN);
    await lid.queue;
    checkEqual('at the floor it lets go, work or not', draining.flag, 0);
    checkEqual('and sleeps, because the lid is shut', draining.slept, 1);
    checkEqual('saying why, so a phone can be told', told[0] && told[0].percent, 18);
    checkEqual('and what was cut off', told[0] && told[0].reason, '1327 is working');
  }

  suite('a Mac somebody set to never sleep is left that way');

  {
    const mac = fakeMac({ approved: true, flag: true, lidClosed: true });
    const { lid, timers } = guard(mac);
    lid.want(true, 'x');
    await lid.queue;
    check('it leans on the flag that is there', lid.state().held);
    check('without claiming it', !fs.existsSync(path.join(lid.dir, 'owned')));
    checkEqual('without writing it', mac.calls.filter((c) => /disablesleep 1/.test(c) && !/-l/.test(c)).length, 0);
    lid.want(false);
    await timers.tick(3 * MIN);
    await lid.queue;
    checkEqual('and when the work is done, it is not cleared', mac.flag, 1);
    checkEqual('nor is the Mac put to sleep against its owner’s wishes', mac.slept, 0);
  }

  suite('two windows, one flag');

  {
    const mac = fakeMac({ approved: true, lidClosed: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-lid-'));
    const live = new Set();
    const timers = fakeTimers();
    const dogs = watchdogs();
    const a = guard(mac, { dir, live, timers, dogs, pid: 100 }).lid;
    const b = guard(mac, { dir, live, timers, dogs, pid: 200 }).lid;

    a.want(true, 'alpha');
    await a.queue;
    b.want(true, 'beta');
    await b.queue;
    checkEqual('the first sets it', mac.calls.filter((c) => c === '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1').length, 1);
    check('the second signs for it without setting it again', fs.existsSync(path.join(dir, '200')));

    await a.stop();
    checkEqual('one window letting go does not clear it under the other', mac.flag, 1);
    checkEqual('nor sleep the laptop the other is still working on', mac.slept, 0);

    await b.stop();
    checkEqual('the last one out puts it back', mac.flag, 0);
    checkEqual('and sleeps it, lid shut', mac.slept, 1);
  }

  suite('what a crash leaves behind is cleared on the next start');

  {
    const mac = fakeMac({ approved: true, flag: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-lid-'));
    fs.writeFileSync(path.join(dir, 'owned'), '1');
    fs.writeFileSync(path.join(dir, '999'), '1');   // a window that no longer exists
    await guard(mac, { dir }).lid.recover();
    checkEqual('ours, and nobody alive holding it: put back', mac.flag, 0);
    check('the dead window’s name is cleared', !fs.existsSync(path.join(dir, '999')));
    check('and the claim with it', !fs.existsSync(path.join(dir, 'owned')));

    const theirs = fakeMac({ approved: true, flag: true });
    await guard(theirs).lid.recover();
    checkEqual('never ours: never touched', theirs.flag, 1);
  }

  suite('somebody turning sleep back on by hand is believed');

  {
    const mac = fakeMac({ approved: true });
    const { lid, timers } = guard(mac);
    lid.want(true, 'x');
    await lid.queue;
    mac.flag = 0;
    await timers.tick(MIN);
    await lid.queue;
    checkEqual('it stops claiming to hold what it no longer holds', lid.state().held, false);
  }

  suite('the scripts, as the shell and AppleScript will read them');

  if (process.platform === 'darwin') {
    const script = installScript('nikoloz');
    let parsed = true;
    try { execFileSync('/bin/sh', ['-n', '-c', script]); } catch (_) { parsed = false; }
    check('the install script is valid shell', parsed);

    // Round-tripped through AppleScript itself: what arrives as root is
    // exactly what was written here, quotes and backslashes and all.
    const back = execFileSync('/usr/bin/osascript', ['-e', 'return ' + appleString(script)], { encoding: 'utf8' }).trim();
    checkEqual('and survives AppleScript’s quoting untouched', back, script);

    const rule = path.join(os.tmpdir(), 'nikui-rule-' + process.pid);
    fs.writeFileSync(rule, '# check\n' + ruleFor('nikoloz') + '\n');
    let valid = true;
    try { execFileSync('/usr/sbin/visudo', ['-cf', rule], { stdio: 'ignore' }); } catch (_) { valid = false; }
    fs.rmSync(rule, { force: true });
    check('the rule is one visudo accepts', valid);
  }

  {
    // The watchdog, run for real, with the one line that needs root swapped
    // for a note of having been reached.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-dog-'));
    const note = path.join(dir, 'reset');
    const script = WATCHDOG.replace('/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0', `echo reset > "${note}"`)
      .replace('sleep 5', 'sleep 0.1');

    const runDog = async (window, extraHolder) => {
      fs.writeFileSync(path.join(dir, String(window.pid)), '1');
      fs.writeFileSync(path.join(dir, 'owned'), '1');
      if (extraHolder) fs.writeFileSync(path.join(dir, String(extraHolder)), '1');
      const dog = spawn('/bin/sh', ['-c', script], {
        stdio: 'ignore', env: { PATH: '/usr/bin:/bin', NIKUI_PID: String(window.pid), NIKUI_DIR: dir }
      });
      window.kill();
      await new Promise((r) => dog.on('exit', r));
    };

    await runDog(spawn('/bin/sleep', ['30']));
    check('when the window goes, the watchdog puts sleep back', fs.existsSync(note));
    check('and takes the claim away', !fs.existsSync(path.join(dir, 'owned')));

    fs.rmSync(note, { force: true });
    await runDog(spawn('/bin/sleep', ['30']), process.pid);
    check('but not while another window is still holding it', !fs.existsSync(note));
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
