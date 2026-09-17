#!/usr/bin/env node
'use strict';

// The phase's whole point, proved end to end: a real browser opens the real
// server over a real socket, draws a live turn and sends a prompt back.
//
//   npm run test:remote
//
// Everything the offline suite cannot reach is here — the handshake a browser
// accepts or rejects, the content-security policy it enforces, the cookie it
// keeps, and what it does when the socket dies underneath it. Skips (exit 0)
// when there is no Chrome, so a clean checkout never goes red.

const path = require('path');
const { findChrome, launch, wait } = require('./helpers/chrome.js');

const chrome = findChrome();
if (!chrome) {
  console.log('No Chrome found — skipping the remote check. Set CHROME=/path/to/chrome to run it.');
  process.exit(0);
}

const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { RemoteServer } = require('../src/remote.js');
const { LocalKey } = require('../src/auth.js');
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

  const auth = new LocalKey();
  const server = new RemoteServer({
    root: ROOT,
    host: {
      config: () => ({ showThinking: true, promptSnippets: {} }),
      home: '/home',
      knownCommands: () => ['status'],
      fleet: () => [session],
      env: () => ({ vscode: 'browser check', node: process.versions.node })
    },
    sessions: { list: () => [session], get: (id) => (id === session.id ? session : null) },
    auth
  });
  await server.start(0);
  const base = `http://127.0.0.1:${server.port}`;

  const browser = await launch(chrome);
  try {
    // ---- the door -------------------------------------------------------
    await browser.navigate(`${base}/?key=${auth.key}`);
    record('the key in the address bar opens the fleet list',
      (await browser.evaluate('document.querySelectorAll(".row").length')) === 1);
    record('and is taken out of the address bar',
      !(await browser.evaluate('location.search')));
    record('the instance is named on it',
      /browser check/.test(await browser.evaluate('document.body.textContent')));

    await browser.navigate(`${base}/s/${session.id}`);
    record('the cookie alone is enough for the conversation page',
      (await browser.evaluate('!!document.getElementById("transcript")')));

    // ---- the socket -----------------------------------------------------
    const live = await browser.until('document.getElementById("link").textContent === "Live"', 8000);
    record('the browser opens a socket and says it is live', live);
    record('no script on the page was blocked or threw',
      (await browser.evaluate('window.__errors ? window.__errors.length : 0')) === 0);
    record('the conversation that was already there is drawn',
      /what was already here/.test(await browser.evaluate('document.getElementById("stream").textContent')));

    // ---- a live turn ----------------------------------------------------
    session._upsert({ id: 'a1', kind: 'text', text: 'streamed while you watch' });
    record('what happens in the instance appears in the browser',
      await browser.until('document.getElementById("stream").textContent.includes("streamed while you watch")', 4000));

    session._setStatus('working');
    record('and so does its state',
      await browser.until('document.getElementById("dot").className.includes("working")', 4000));
    session._setStatus('idle');

    // ---- a prompt, from the browser -------------------------------------
    await browser.evaluate(`(() => {
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
    record('and the composer is cleared, as in the panel',
      (await browser.evaluate('document.getElementById("input").value')) === '');

    // ---- the dashboard --------------------------------------------------
    await browser.evaluate(`(() => {
      const input = document.getElementById('input');
      input.value = '/status';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    record('/status draws the dashboard over the socket',
      await browser.until('!document.getElementById("status").hidden && ' +
        'document.querySelectorAll("#status .nav-item").length === 6', 5000));
    record('with the figures the host reported',
      /browser check/.test(await browser.evaluate('document.getElementById("status").textContent')));
    await browser.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');

    // ---- the network goes away ------------------------------------------
    const before = await browser.evaluate('document.querySelectorAll("#stream .msg").length');
    for (const client of [...server.clients]) client.close(1001, 'pulled the cable');
    record('the browser notices the socket died',
      await browser.until('document.getElementById("link").className.includes("off") || ' +
        'document.getElementById("link").className.includes("warn")', 4000));

    record('and reconnects on its own', await browser.until(
      'document.getElementById("link").textContent === "Live"', 15000));
    const after = await browser.evaluate('document.querySelectorAll("#stream .msg").length');
    record('with the conversation intact, not doubled', after === before);
    record('and the host sees exactly one client again', server.clients.size === 1);

    session._upsert({ id: 'a2', kind: 'text', text: 'after the reconnect' });
    record('a reconnected client is a live client',
      await browser.until('document.getElementById("stream").textContent.includes("after the reconnect")', 4000));

    // ---- and the server goes away ---------------------------------------
    await server.stop();
    record('stopping the server leaves the browser saying so', await browser.until(
      'document.getElementById("link").className.includes("off") || ' +
      'document.getElementById("link").className.includes("warn")', 6000));
  } finally {
    browser.close();
    await server.stop();
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
