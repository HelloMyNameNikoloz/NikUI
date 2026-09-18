#!/usr/bin/env node
'use strict';

// The app's own bundle, driven in a real browser against a real laptop.
//
//   node app/tools/app.check.js
//
// The bundle is served from a second origin — deliberately, because that is
// what an app is: the client living somewhere other than the server it talks
// to. Everything that used to be implied by "the page came from the laptop" has
// to be explicit now, and this is what proves it.

const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');
const { findChrome, launch, wait } = require(path.join(REPO, 'test', 'helpers', 'chrome.js'));
const { skipped } = require(path.join(REPO, 'test', 'helpers', 'skip.js'));

const chrome = findChrome();
if (!chrome) skipped('No Chrome found — the app check did not run. Set CHROME=/path/to/chrome.');

const { install, memoryState } = require(path.join(REPO, 'test', 'helpers', 'vscode-stub.js'));
install();
const { Session } = require(path.join(REPO, 'src', 'session.js'));
const { RemoteServer } = require(path.join(REPO, 'src', 'remote.js'));
const { LocalKey } = require(path.join(REPO, 'src', 'auth.js'));
const { DeviceStore } = require(path.join(REPO, 'src', 'devices.js'));
const { PairingWindow } = require(path.join(REPO, 'src', 'pairing.js'));
const { loadIdentity } = require(path.join(REPO, 'src', 'identity.js'));
const { closeAllHubs } = require(path.join(REPO, 'src', 'hub.js'));
const { build } = require('./build.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

/** The bundle, served the way a WebView serves it: from its own origin. */
function serveBundle(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(root, route === '/' ? 'index.html' : route);
      if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, body) => {
        if (err) { res.writeHead(404); return res.end('no such file'); }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const checks = [];
// Printed as they happen: a check that throws halfway through should still
// leave a record of everything that worked up to it.
const record = (name, ok) => {
  checks.push([name, !!ok]);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
};

(async () => {
  build();

  const session = new Session({ cwd: REPO });
  session.customTitle = 'app check';
  session.start = function () { this.everStarted = true; };
  session._write = function () {};
  Object.defineProperty(session, 'isRunning', { get: () => true });
  session._upsert({ id: 'u1', kind: 'user', text: 'what the app should show', images: [] });

  const devices = new DeviceStore(memoryState());
  const identity = loadIdentity(memoryState());
  const pairing = new PairingWindow();
  const laptop = new RemoteServer({
    root: REPO,
    host: {
      config: () => ({ showThinking: true, promptSnippets: {} }),
      home: '/home', knownCommands: () => ['status'],
      fleet: () => [session], env: () => ({ vscode: 'app check' })
    },
    sessions: { list: () => [session], get: (id) => (id === session.id ? session : null) },
    devices, identity, pairing, localKey: new LocalKey()
  });
  await laptop.start(0);

  const bundle = await serveBundle(path.join(APP, 'www'));
  const appOrigin = `http://127.0.0.1:${bundle.address().port}`;
  const laptopOrigin = `http://127.0.0.1:${laptop.port}`;
  // The laptop only answers to names it serves; an app reaching it by address
  // is the same case as the tailnet name, and has to be allowed the same way.
  laptop.publicHost = `127.0.0.1:${laptop.port}`;

  const phone = await launch(chrome);
  try {
    await phone.asPhone(390, 844);

    // ---- the way in --------------------------------------------------------
    await phone.navigate(appOrigin + '/index.html');
    record('an app with no laptop goes straight to the way in',
      await phone.until('location.pathname.endsWith("connect.html")', 6000));
    record('and asks for exactly three things',
      (await phone.evaluate('document.querySelectorAll(".field input").length')) === 3);
    record('with the code field sized for a thumb',
      (await phone.evaluate('Math.round(document.getElementById("code").getBoundingClientRect().height)')) >= 44);
    record('and 17px text, so iOS will not zoom it',
      (await phone.evaluate('parseFloat(getComputedStyle(document.getElementById("code")).fontSize)')) >= 16);
    record('it says what pairing grants before anybody taps',
      /watch/i.test(await phone.evaluate('document.body.textContent')));
    record('the device makes its key before the button is pressed',
      await phone.until('window.nikDevice.load().then(r => !!(r && r.privateKey))', 6000));
    record('and that key cannot be exported',
      (await phone.evaluate('window.nikDevice.load().then(r => r.privateKey.extractable === false)')) === true);

    // ---- pairing, for real -------------------------------------------------
    const open = pairing.start({
      host: `127.0.0.1:${laptop.port}`, scheme: 'http',
      fingerprint: identity.fingerprint, laptop: 'Check laptop'
    });
    await phone.evaluate(`(() => {
      document.getElementById('host').value = '127.0.0.1:${laptop.port}';
      document.getElementById('code').value = '${open.code}';
      document.getElementById('name').value = 'Check phone';
      document.getElementById('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    })()`);

    let paired = null;
    for (let i = 0; i < 100 && !paired; i++) {
      paired = devices.list()[0] || null;
      if (!paired) await wait(50);
    }
    if (!paired) {
      console.log('  note said: ' + JSON.stringify(await phone.evaluate('document.getElementById("note").textContent')));
      console.log('  refusals: ' + JSON.stringify(laptop.refusals.slice(-3)));
    }
    record('typing the code pairs the device', !!paired);
    record('under the name it was given', paired && paired.name === 'Check phone');
    record('read-only, as pairing always is', paired && paired.control === false);
    record('and the app remembers the laptop',
      (await phone.evaluate('JSON.parse(localStorage.getItem("nikui.app.laptop")).host')) ===
        `127.0.0.1:${laptop.port}`);

    // ---- the fleet ---------------------------------------------------------
    record('it lands on the instance list',
      await phone.until('location.pathname.endsWith("index.html")', 8000));
    record('which fills from the laptop over a socket',
      await phone.until('document.querySelectorAll(".rows .row").length === 1', 10000));
    record('naming the instance', /app check/.test(await phone.evaluate('document.body.textContent')));
    record('and saying it is connected',
      (await phone.evaluate('document.getElementById("link").textContent')) === 'Live');
    record('nothing scrolls sideways',
      (await phone.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')) === true);

    // ---- the conversation, the same client as the editor's ------------------
    await phone.evaluate('document.querySelector(".rows .row").click()');
    record('tapping an instance opens the conversation',
      await phone.until('!!document.getElementById("transcript")', 8000));
    record('over its own socket',
      await phone.until('document.getElementById("link").textContent === "Live"', 10000));
    record('showing what was already there',
      /what the app should show/.test(await phone.evaluate('document.getElementById("stream").textContent')));

    session._upsert({ id: 'a1', kind: 'text', text: 'streamed into the app' });
    record('and what happens next',
      await phone.until('document.getElementById("stream").textContent.includes("streamed into the app")', 6000));

    record('a watching device is offered no composer',
      (await phone.evaluate('document.body.classList.contains("read-only")')) === true);
    record('with a way back to the list',
      (await phone.evaluate('getComputedStyle(document.getElementById("back")).display')) !== 'none');

    // ---- settings ----------------------------------------------------------
    await phone.navigate(appOrigin + '/settings.html');
    record('settings draws itself', await phone.until('document.querySelectorAll(".group").length >= 5', 6000));
    record('and says whether it is connected',
      await phone.until('/Connected/.test(document.body.textContent)', 10000));
    record('what this device may do',
      /Watching only/.test(await phone.evaluate('document.body.textContent')));
    record('which laptop it is',
      new RegExp(`127.0.0.1:${laptop.port}`).test(await phone.evaluate('document.body.textContent')));
    record('and that the key is pinned',
      /pinned/i.test(await phone.evaluate('document.body.textContent')));
    record('every row is thumb-sized',
      (await phone.evaluate(`[...document.querySelectorAll('.row')]
        .every(r => Math.round(r.getBoundingClientRect().height) >= 44)`)) === true);

    // Granting control has to reach the app while it is open.
    devices.setControl(paired.id, true);
    record('a grant on the laptop shows up here',
      await phone.until('/Can send prompts/.test(document.body.textContent)', 8000));

    record('forgetting asks twice', (await phone.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.row')];
      const row = rows.find(r => /Forget this laptop/.test(r.textContent));
      row.click();
      return /Tap again/.test(row.textContent);
    })()`)) === true);

    // ---- it looks like one thing -------------------------------------------
    record('the app is dark whatever the phone is',
      (await phone.evaluate('getComputedStyle(document.body).backgroundColor')) === 'rgb(15, 15, 17)');
    record('and nothing threw on any screen',
      (await phone.evaluate('window.__errors ? window.__errors.length : 0')) === 0);
  } finally {
    phone.close();
    bundle.close();
    await laptop.dispose();
    closeAllHubs();
    session.dispose();
  }

  const failed = checks.filter(([, ok]) => !ok).length;
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' app checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
