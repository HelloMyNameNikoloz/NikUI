#!/usr/bin/env node
'use strict';

// The phases' whole point, proved end to end in a real browser: this laptop
// streams a live turn over a socket, and a device that has never seen the key
// pairs itself with a key it generates, watches without being able to steer,
// and is cut off the moment it is revoked.
//
//   npm run test:remote
//
// Everything the offline suite cannot reach is here — the handshake a browser
// accepts or rejects, the content-security policy it enforces, WebCrypto and
// IndexedDB doing the real work, and what happens when the socket dies
// underneath the page. Skips (exit 0) when there is no Chrome.

const path = require('path');
const { findChrome, launch, wait } = require('./helpers/chrome.js');

const chrome = findChrome();
if (!chrome) {
  console.log('No Chrome found — skipping the remote check. Set CHROME=/path/to/chrome to run it.');
  process.exit(0);
}

const { install, memoryState } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { RemoteServer } = require('../src/remote.js');
const { LocalKey } = require('../src/auth.js');
const { DeviceStore } = require('../src/devices.js');
const { PairingWindow } = require('../src/pairing.js');
const { loadIdentity } = require('../src/identity.js');
const { closeAllHubs } = require('../src/hub.js');

const ROOT = path.join(__dirname, '..');
const checks = [];
const record = (name, ok) => checks.push([name, !!ok]);

(async () => {
  // An instance that will never spawn anything, with a conversation already in it.
  const session = new Session({ cwd: ROOT });
  session.customTitle = 'browser check';
  session.start = function () { this.everStarted = true; };
  session._write = function () {};
  Object.defineProperty(session, 'isRunning', { get: () => true });
  session._upsert({ id: 'u1', kind: 'user', text: 'what was already here', images: [] });

  const memento = memoryState();
  const devices = new DeviceStore(memento);
  const identity = loadIdentity(memoryState());
  const pairing = new PairingWindow();
  const auth = new LocalKey();

  const server = new RemoteServer({
    root: ROOT,
    host: {
      config: () => ({ showThinking: true, promptSnippets: {} }),
      home: '/home',
      knownCommands: () => ['status'],
      fleet: () => [session],
      env: () => ({ vscode: 'browser check', node: process.versions.node }),
      audit: (entry) => devices.record(entry)
    },
    sessions: { list: () => [session], get: (id) => (id === session.id ? session : null) },
    devices, identity, pairing, localKey: auth
  });
  await server.start(0);
  const base = `http://127.0.0.1:${server.port}`;

  // ---- this laptop ----------------------------------------------------------
  const laptop = await launch(chrome);
  try {
    await laptop.navigate(`${base}/?key=${auth.key}`);
    record('the key in the address bar is taken out of it',
      !(await laptop.evaluate('location.search')));
    record('and the window appears, over the socket',
      await laptop.until('document.querySelectorAll(".row").length === 1', 8000));
    record('with the instance named on it',
      /browser check/.test(await laptop.evaluate('document.body.textContent')));

    await laptop.navigate(`${base}/s/${session.id}`);
    record('the cookie alone opens a conversation',
      (await laptop.evaluate('!!document.getElementById("transcript")')));
    record('the socket signs in without ceremony',
      await laptop.until('document.getElementById("link").textContent === "Live"', 8000));
    record('no script on the page was blocked or threw',
      (await laptop.evaluate('window.__errors ? window.__errors.length : 0')) === 0);
    record('the conversation that was already there is drawn',
      /what was already here/.test(await laptop.evaluate('document.getElementById("stream").textContent')));

    session._upsert({ id: 'a1', kind: 'text', text: 'streamed while you watch' });
    record('what happens in the instance appears in the browser',
      await laptop.until('document.getElementById("stream").textContent.includes("streamed while you watch")', 4000));

    await laptop.evaluate(`(() => {
      const input = document.getElementById('input');
      input.value = 'sent from the browser';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    let arrived = false;
    for (let i = 0; i < 60 && !arrived; i++) {
      arrived = session.items.some((item) => item.kind === 'user' && item.text === 'sent from the browser') ||
        session.queue.some((q) => q.text === 'sent from the browser');
      if (!arrived) await wait(50);
    }
    record('a prompt typed in the browser reaches the instance', arrived);

    await laptop.evaluate(`(() => {
      const input = document.getElementById('input');
      input.value = '/status';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    record('/status draws the dashboard over the socket',
      await laptop.until('!document.getElementById("status").hidden && ' +
        'document.querySelectorAll("#status .nav-item").length === 6', 5000));
    await laptop.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');

    const before = await laptop.evaluate('document.querySelectorAll("#stream .msg").length');
    for (const client of [...server.clients]) client.close(1001, 'pulled the cable');
    record('the browser notices the socket died',
      await laptop.until('document.getElementById("link").className.includes("off") || ' +
        'document.getElementById("link").className.includes("warn")', 4000));
    record('and reconnects on its own',
      await laptop.until('document.getElementById("link").textContent === "Live"', 15000));
    record('with the conversation intact, not doubled',
      (await laptop.evaluate('document.querySelectorAll("#stream .msg").length')) === before);
  } finally {
    laptop.close();
  }

  // ---- a device that has never seen the key ---------------------------------
  const phone = await launch(chrome);
  try {
    await phone.navigate(`${base}/`);
    record('a device with no key gets the page but no window',
      (await phone.evaluate('document.querySelectorAll(".row").length')) === 0);
    record('and is told to pair rather than left blank',
      await phone.until('document.body.textContent.includes("not paired")', 8000));
    record('with a way to do it', (await phone.evaluate('!!document.querySelector(\'a[href="/pair"]\')')));

    const open = pairing.start({
      host: `127.0.0.1:${server.port}`,
      fingerprint: identity.fingerprint,
      laptop: 'Check laptop'
    });
    await phone.navigate(open.link);
    record('the pairing link fills in the code it carried',
      await phone.until(`document.getElementById('code') && document.getElementById('code').value === '${open.code}'`, 6000));
    record('and the device makes itself a key that cannot be exported',
      (await phone.evaluate(`(async () => {
        const r = await window.nikDevice.load();
        return !!r && r.privateKey.extractable === false && r.privateKey.type === 'private';
      })()`)) === true);

    await phone.evaluate(`(() => {
      document.getElementById('name').value = 'Check phone';
      document.getElementById('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    })()`);
    let paired = null;
    for (let i = 0; i < 80 && !paired; i++) {
      paired = devices.list()[0] || null;
      if (!paired) await wait(50);
    }
    record('a real WebCrypto signature pairs the device', !!paired);
    record('under the name it gave', paired && paired.name === 'Check phone');
    record('read-only, because that is all pairing grants', paired && paired.control === false);
    record('the page says the same', await phone.until('document.body.textContent.includes("separate grant")', 4000));
    record('and the device pinned the laptop it paired with',
      (await phone.evaluate('window.nikDevice.load().then(r => r.fingerprint)')) === identity.fingerprint);

    await phone.navigate(`${base}/s/${session.id}`);
    record('the paired device signs in with no key and no cookie',
      await phone.until('document.getElementById("link").textContent === "Live"', 10000));
    record('and sees the conversation',
      /what was already here/.test(await phone.evaluate('document.getElementById("stream").textContent')));
    record('but the composer is not offered to it',
      (await phone.evaluate('document.body.classList.contains("read-only")')) === true);

    const held = session.items.length + session.queue.length;
    await phone.evaluate(`(() => {
      // Past the client's own courtesy: the frame a forged client would send.
      window.nikForged = true;
      const input = document.getElementById('input');
      input.disabled = false;
      input.value = 'forged from a read-only device';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await wait(400);
    record('a prompt forged past the client is refused by the host',
      session.items.length + session.queue.length === held);
    record('and written down against the device that tried it',
      devices.recent(5).some((e) => e.action === 'send' && e.allowed === false && e.device === 'Check phone'));

    devices.setControl(paired.id, true);
    record('granting control reaches the socket it is already holding',
      await phone.until('!document.body.classList.contains("read-only")', 5000));

    devices.forget(paired.id);
    record('and forgetting the device closes that socket',
      await phone.until('document.getElementById("link").className.includes("off")', 6000));
    record('with nothing left on the laptop', devices.list().length === 0);
  } finally {
    phone.close();
  }

  // ---- and on a screen the size of a phone ----------------------------------
  const small = await launch(chrome);
  try {
    await small.asPhone(390, 844);
    await small.navigate(`${base}/?key=${auth.key}`);
    await small.until('document.querySelectorAll(".row").length === 1', 8000);
    record('the fleet is the home screen, and it fits',
      (await small.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')) === true);
    record('with rows big enough for a thumb',
      (await small.evaluate('Math.round(document.querySelector(".row").getBoundingClientRect().height)')) >= 44);

    await small.evaluate('document.querySelector(".row").click()');
    record('tapping one opens that conversation',
      await small.until('!!document.getElementById("transcript")', 6000));
    await small.until('document.getElementById("link").textContent === "Live"', 8000);

    record('nothing scrolls sideways',
      (await small.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')) === true);
    record('there is a way back to the fleet',
      (await small.evaluate('getComputedStyle(document.getElementById("back")).display')) !== 'none');
    record('the shortcut list, which no phone can use, is gone',
      (await small.evaluate('getComputedStyle(document.querySelector(".hint")).display')) === 'none');
    record('the composer is on screen, above the fold',
      (await small.evaluate(`(() => {
        const box = document.querySelector('.composer').getBoundingClientRect();
        return box.bottom <= window.innerHeight + 1 && box.top > 0;
      })()`)) === true);
    record('its text is big enough that iOS will not zoom the page',
      (await small.evaluate('parseFloat(getComputedStyle(document.getElementById("input")).fontSize)')) >= 16);
    record('send and stop are thumb-sized',
      (await small.evaluate(`(() => {
        const send = document.getElementById('send').getBoundingClientRect();
        return Math.round(send.height) >= 44 && Math.round(send.width) >= 44;
      })()`)) === true);
    record('the page tracks the visual viewport, not the window',
      !!(await small.evaluate('document.documentElement.style.getPropertyValue("--app-height")')));

    await small.evaluate(`(() => {
      const input = document.getElementById('input');
      input.value = '/status';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    record('the dashboard opens full screen',
      await small.until('!document.getElementById("status").hidden && ' +
        'document.getElementById("status").getBoundingClientRect().width >= window.innerWidth - 1', 6000));
    record('its sections are a strip you can reach with one thumb',
      (await small.evaluate(`(() => {
        const nav = document.querySelector('.sheet-nav');
        const item = document.querySelector('.sheet .nav-item').getBoundingClientRect();
        return getComputedStyle(nav).flexDirection === 'row' && Math.round(item.height) >= 44;
      })()`)) === true);

    const before = await small.evaluate('document.querySelector("#status .nav-item.on").dataset.section');
    await small.evaluate(`(() => {
      const sheet = document.getElementById('status');
      const at = (x) => [new Touch({ identifier: 1, target: sheet, clientX: x, clientY: 400 })];
      sheet.dispatchEvent(new TouchEvent('touchstart', { touches: at(300), bubbles: true }));
      sheet.dispatchEvent(new TouchEvent('touchend', { changedTouches: at(120), bubbles: true }));
    })()`);
    const after = await small.evaluate('document.querySelector("#status .nav-item.on").dataset.section');
    record('and swiping moves between them', before !== after);
    record('one section at a time, in order', after === 'overview');
  } finally {
    small.close();
    await server.dispose();
    closeAllHubs();
    session.dispose();
  }

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
    if (!ok) failed++;
  }
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' remote checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
