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
const { SOURCE: CHIP } = require(path.join(REPO, 'test', 'helpers', 'chip.js'));
const { SOURCE: PHONE } = require(path.join(REPO, 'test', 'helpers', 'phone.js'));
const { Notifier } = require(path.join(REPO, 'src', 'notify.js'));

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
  // Deliberately not the version in the bundle: a phone carrying a different
  // copy of the client from the laptop is the case worth seeing said out loud.
  laptop.version = '99.99.99';
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
    // The native bits of a phone, from the first screen onward.
    await phone.beforeEachPage(PHONE);

    // ---- the way in --------------------------------------------------------
    await phone.navigate(appOrigin + '/index.html');
    record('an app with no laptop goes straight to the way in',
      await phone.until('location.pathname.endsWith("connect.html")', 6000));
    // The way in is two steps and nothing to fill in: pairing is meant to be
    // pointing a camera at a laptop, so typing is behind a word rather than in
    // front of one.
    record('which asks for nothing at all to begin with',
      (await phone.evaluate('[...document.querySelectorAll(".field input")].filter(i => i.offsetParent).length')) === 0);
    record('and says what to do, in order',
      (await phone.evaluate('document.querySelectorAll("#steps li").length')) === 2);
    record('naming the command to run on the laptop',
      /Pair a device/.test(await phone.evaluate('document.getElementById("steps").textContent')));
    record('and the camera as the second step',
      /camera/i.test(await phone.evaluate('document.getElementById("steps").textContent')));

    await phone.evaluate('document.getElementById("type-instead").click()');
    record('typing it is still there for when that does not work',
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

    // The way it is meant to happen: the phone's own camera reads the square on
    // the laptop and hands the link to the app. Nothing is typed.
    record('the laptop offers a code the app itself can open',
      /^nikui:\/\/pair#/.test(pairing.state().appLink));
    await phone.evaluate(`window.__buzz.scan(${JSON.stringify(pairing.state().appLink)})`);
    record('scanning it turns the screen into one question',
      await phone.until('!document.getElementById("invited").hidden', 6000));
    record('which names the laptop asking',
      /Check laptop/.test(await phone.evaluate('document.getElementById("invited").textContent')));
    record('and its address, so it can be recognised',
      new RegExp(`127.0.0.1:${laptop.port}`).test(
        await phone.evaluate('document.getElementById("invited").textContent')));
    record('nothing is filled in by hand',
      (await phone.evaluate('document.getElementById("code").value')) === open.code);
    record('and the phone says something happened',
      (await phone.evaluate('window.__buzz.buzzes().length')) > 0);

    await phone.evaluate(`document.getElementById('name').value = 'Check phone'`);
    await phone.evaluate('document.getElementById("accept").click()');

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

    // The connection that just filled that list: sealed, from the server's own
    // point of view rather than the app's claim about it.
    const sockets = [...laptop.clients].filter((c) => c.device && c.device.kind === 'device');
    record('the app’s connection is sealed end to end',
      sockets.length > 0 && sockets.every((c) => !!c.box && c.sealed === true));
    record('and what crosses it is an envelope, not a message',
      sockets.length > 0 && JSON.stringify(sockets[0].box.seal('{"type":"fleet"}')).indexOf('fleet') < 0);

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
    record('settings says the connection is sealed',
      await phone.until('/End-to-end encrypted/.test(document.body.textContent)', 10000));
    record('and offers a way to check it really is your laptop',
      /really your laptop/i.test(await phone.evaluate('document.body.textContent')));
    record('which opens the fingerprint up to be read out loud',
      (await phone.evaluate(`(() => {
        const row = [...document.querySelectorAll('.row')].find(r => /really your laptop/i.test(r.textContent));
        row.click();
        const proof = document.querySelector('.proof');
        return !!proof && proof.textContent.trim().split(/\\s+/).length >= 3;
      })()`)) === true);
    record('in type big enough to compare without squinting',
      (await phone.evaluate('parseFloat(getComputedStyle(document.querySelector(".proof")).fontSize)')) >= 17);

    record('every row is thumb-sized',
      (await phone.evaluate(`[...document.querySelectorAll('.row')]
        .every(r => Math.round(r.getBoundingClientRect().height) >= 44)`)) === true);

    // Granting control has to reach the app while it is open.
    devices.setControl(paired.id, true);
    record('a grant on the laptop shows up here',
      await phone.until('/Can send prompts/.test(document.body.textContent)', 8000));

    // ---- being told ---------------------------------------------------------
    //
    // The laptop decides, the socket carries it, the phone shows it. Driven
    // through the real Notifier so the decision is the same one a real window
    // would make, not a message made up for the test.

    const notifier = new Notifier({
      devices, vapid: null,
      settings: () => ({ needsYou: true, quota: true, failed: true, turnFinished: true }),
      toSockets: (message) => laptop.notifyDevices(message)
    });

    record('notifications are off until somebody turns them on',
      (await phone.evaluate('JSON.stringify(window.NikNotify.prefs().on)')) === 'false');
    await phone.evaluate('window.__buzz.clear()');
    await notifier.needsYou({ id: session.id, customTitle: 'app check', items: [] });
    await wait(300);
    record('and nothing is shown while they are',
      (await phone.evaluate('window.__buzz.shown().length')) === 0);

    await phone.evaluate(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => /Tell me things/.test(r.textContent));
      row.click();
    })()`);
    record('turning them on asks the phone first, and only then',
      await phone.until('window.NikNotify.prefs().on === true', 6000));
    record('the switches for what to be told appear',
      await phone.until(`[...document.querySelectorAll('.row')]
        .some(r => /Something needs an answer/.test(r.textContent))`, 6000));
    record('with a channel for the one that should make a sound',
      (await phone.evaluate('window.__buzz.channels().indexOf("nikui-needs-you") >= 0')) === true);
    record('and one for everything that should not',
      (await phone.evaluate('window.__buzz.channels().indexOf("nikui-news") >= 0')) === true);

    await phone.evaluate('window.__buzz.clear()');
    notifier.settled({ id: session.id, status: 'idle' });
    await notifier.needsYou({ id: session.id, customTitle: 'app check', items: [] });
    record('now the laptop can reach this phone without a push service at all',
      await phone.until('window.__buzz.shown().length === 1', 8000));
    const shown = JSON.parse(await phone.evaluate('JSON.stringify(window.__buzz.shown()[0])'));
    record('saying which instance it is', /app check/.test(shown.title || ''));
    record('on the channel that makes a sound', shown.channelId === 'nikui-needs-you');
    record('carrying the instance, so a tap can open it',
      shown.extra && shown.extra.session === session.id);
    record('and its own icon rather than a white square',
      shown.smallIcon === 'ic_stat_nikui');

    // The same news twice is one notification, not two — the laptop's tag says
    // "this is the same thing", and the phone turns that into one id.
    record('the same news keeps the same id',
      (await phone.evaluate(`window.NikNotify.idFor('needs-you:x') === window.NikNotify.idFor('needs-you:x')`)) === true);
    record('and different news does not',
      (await phone.evaluate(`window.NikNotify.idFor('needs-you:x') !== window.NikNotify.idFor('failed:x')`)) === true);

    // Every turn finishing is off by default on both ends, for the same reason:
    // four agents finishing overnight is a phone buzzing all night. Switching
    // it on and off again is the check that these switches do anything.
    const flip = () => phone.evaluate(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => /A turn finished/.test(r.textContent));
      row.click();
    })()`);

    await flip();
    await phone.evaluate('window.__buzz.clear()');
    await notifier.finished({ id: session.id, customTitle: 'app check' });
    record('a kind this phone switched on is shown',
      await phone.until('window.__buzz.shown().length === 1', 6000));

    await flip();
    await phone.evaluate('window.__buzz.clear()');
    await notifier.finished({ id: session.id, customTitle: 'app check' });
    await wait(400);
    record('and one it switched off is carried down the socket but not shown',
      (await phone.evaluate('window.__buzz.shown().length')) === 0);

    await phone.evaluate('window.__buzz.clear()');
    await phone.evaluate(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => /Send me one now/.test(r.textContent));
      row.click();
    })()`);
    record('there is a way to check it works, and it does',
      await phone.until('window.__buzz.shown().length === 1', 6000));

    record('a phone that can keep watching is offered it',
      await phone.until(`[...document.querySelectorAll('.row')]
        .some(r => /Keep watching in the background/.test(r.textContent))`, 6000));
    await phone.evaluate(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => /Keep watching in the background/.test(r.textContent));
      row.click();
    })()`);
    record('and turning it on starts the watcher',
      await phone.until('window.__buzz.watching() === true', 6000));

    // ---- the one door that goes through somebody else's machine --------------
    //
    // An iPhone cannot keep a socket open, so the only way to reach a closed
    // app is Apple. That needs a token from the phone, which travels up the
    // socket it is already holding rather than through an endpoint of its own.

    // Now as an iPhone, which cannot keep a socket open at all.
    await phone.evaluate('window.__buzz.beAn("ios")');
    await phone.navigate(appOrigin + '/settings.html');
    await phone.until('document.querySelectorAll(".group").length >= 5', 8000);
    record('an iPhone is not offered a thing it cannot do',
      (await phone.evaluate(`[...document.querySelectorAll('.row')]
        .every(r => !/Keep watching in the background/.test(r.textContent))`)) === true);
    record('and is offered the only thing that does reach it while closed',
      await phone.until(`[...document.querySelectorAll('.row')]
        .some(r => /While NikUI is closed/.test(r.textContent))`, 6000));
    await phone.evaluate(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => /While NikUI is closed/.test(r.textContent));
      row.click();
    })()`);
    let appleToken = null;
    for (let i = 0; i < 120 && !appleToken; i++) {
      const held = devices.get(paired.id);
      if (held && held.apns) appleToken = held.apns.token;
      if (!appleToken) await wait(50);
    }
    record('setting it up tells the laptop where Apple can find this phone', !!appleToken);
    record('as the token iOS gave it', appleToken === 'f'.repeat(64));
    record('and the app says so afterwards',
      await phone.until('/While NikUI is closed/.test(document.body.textContent) && ' +
        '[...document.querySelectorAll(".row")].some(r => /While NikUI is closed/.test(r.textContent) && /On/.test(r.textContent))', 8000));


    record('tapping a notification opens the instance it was about',
      await (async () => {
        await phone.evaluate('window.__buzz.clear()');
        notifier.settled({ id: session.id, status: 'idle' });
        await notifier.needsYou({ id: session.id, customTitle: 'app check', items: [] });
        await phone.until('window.__buzz.shown().length === 1', 6000);
        await phone.evaluate('window.__buzz.tapLast()');
        return phone.until('location.search.indexOf("session=") >= 0', 6000);
      })());

    await phone.navigate(appOrigin + '/settings.html');
    record('forgetting asks twice', (await phone.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.row')];
      const row = rows.find(r => /Forget this laptop/.test(r.textContent));
      row.click();
      return /Tap again/.test(row.textContent);
    })()`)) === true);

    // ---- it looks like one thing -------------------------------------------
    // ---- the polish, checked rather than asserted ---------------------------

    await phone.navigate(appOrigin + '/settings.html');
    record('a laptop running a different client says so',
      await phone.until('/99.99.99/.test(document.body.textContent)', 10000));
    record('in the words somebody can act on',
      /Update the app to match/.test(await phone.evaluate('document.body.textContent')));

    record('there is one paragraph saying what any of this is', (await phone.evaluate(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => /What is this/.test(r.textContent));
      row.click();
      const said = document.querySelector('.explain');
      return !!said && said.textContent.length > 120;
    })()`)) === true);
    record('and it says what runs where',
      /Nothing runs on this phone/i.test(await phone.evaluate('document.body.textContent')));

    record('a tap that changes something is felt',
      (await phone.evaluate('window.__buzz.buzzes().length')) > 0);

    // Anybody who has asked their phone to stop animating things gets none of it.
    await phone.prefers({ 'prefers-reduced-motion': 'reduce' });
    await phone.navigate(appOrigin + '/index.html');
    record('asking for less motion gets less motion',
      (await phone.evaluate('getComputedStyle(document.querySelector(".screen")).animationName')) === 'none');
    await phone.prefers({ 'prefers-reduced-motion': 'no-preference' });
    await phone.navigate(appOrigin + '/index.html');
    record('and not asking gets the one that makes it feel like one app',
      (await phone.evaluate('getComputedStyle(document.querySelector(".screen")).animationName')) !== 'none');

    // A tablet, or a phone on its side, must not stretch a 44pt row across
    // eleven inches of glass.
    await phone.asScreen(1024, 768);
    await phone.navigate(appOrigin + '/settings.html');
    await phone.until('document.querySelectorAll(".group").length >= 5', 8000);
    record('a wider screen keeps the content readable rather than stretching it',
      (await phone.evaluate('document.querySelector(".screen").getBoundingClientRect().width')) <= 600);
    record('and centres it', (await phone.evaluate(`(() => {
      const box = document.querySelector('.screen').getBoundingClientRect();
      return Math.abs(box.left - (window.innerWidth - box.right)) < 4;
    })()`)) === true);
    await phone.asPhone(390, 844);

    await phone.navigate(appOrigin + '/index.html');
    record('every icon button says what it is, for anybody who cannot see it',
      (await phone.evaluate(`[...document.querySelectorAll('button')]
        .filter(b => !b.textContent.trim())
        .every(b => !!b.getAttribute('aria-label'))`)) === true);
    record('and the connection state announces itself when it changes',
      (await phone.evaluate(`(() => {
        const pill = document.getElementById('link');
        return !!pill && (pill.getAttribute('aria-live') === 'polite' || pill.getAttribute('role') === 'status');
      })()`)) === true);

    record('the app is dark whatever the phone is',
      (await phone.evaluate('getComputedStyle(document.body).backgroundColor')) === 'rgb(15, 15, 17)');

    // ---- the key moves into the chip, without pairing again ------------------
    //
    // This device paired with a browser key, because that is all it had. From
    // here on it has a Secure Enclave — the case of a phone that was paired
    // before this existed, and the one that cannot be staged on a desk.

    record('before: the laptop knows this key is only in a browser',
      devices.get(paired.id).protection === 'software');
    const wasKey = devices.get(paired.id).fingerprint;

    await phone.beforeEachPage(CHIP);
    await phone.navigate(appOrigin + '/settings.html');
    record('with a chip, the app knows its key could be better',
      await phone.until(`[...document.querySelectorAll('.row')]
        .some(r => /Move it into the chip/.test(r.textContent))`, 8000));
    record('and says where the key is now',
      /In this app/.test(await phone.evaluate('document.body.textContent')));
    // The rows this phase added are held to what every other row is held to.
    record('the rows it added are thumb-sized too',
      (await phone.evaluate(`[...document.querySelectorAll('.row')]
        .every(r => Math.round(r.getBoundingClientRect().height) >= 44)`)) === true);
    record('and say what they do in words, not in cryptography',
      !/SPKI|P-256|ECDSA|r‖s|DER|base64/i.test(await phone.evaluate('document.body.textContent')));

    await phone.evaluate(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => /Move it into the chip/.test(r.textContent));
      row.click();
    })()`);

    let movedTo = null;
    for (let i = 0; i < 160 && !movedTo; i++) {
      const now = devices.get(paired.id);
      if (now && now.fingerprint !== wasKey) movedTo = now;
      if (!movedTo) await wait(50);
    }
    if (!movedTo) {
      console.log('  settings said: ' + JSON.stringify(
        await phone.evaluate('document.querySelector(".bar-title").textContent')));
      console.log('  refusals: ' + JSON.stringify(laptop.refusals.slice(-3)));
    }
    record('tapping it moves the key', !!movedTo);
    record('the laptop took the new one, having been shown the old one authorised it',
      !!movedTo && movedTo.fingerprint !== wasKey);
    record('it is the same device, not a new one', devices.list().length === 1);
    record('with the name it already had', !!movedTo && movedTo.name === 'Check phone');
    record('and the permission it was already granted', !!movedTo && movedTo.control === true);
    record('the laptop records where the key now is',
      !!movedTo && movedTo.protection === 'secure-enclave');
    record('and what it used to be, so a surprise move can be found',
      !!movedTo && movedTo.previousFingerprint === wasKey);
    record('the move is in the trail',
      devices.recent(5).some((line) => /replaced its key/.test(line.action)));
    record('the app says so too',
      await phone.until('/Secure Enclave/.test(document.body.textContent)', 8000));

    // The point of all of it: the device still connects, now signing with a key
    // whose signatures arrive in a shape the laptop had to be taught to read.
    await phone.navigate(appOrigin + '/index.html');
    record('and it still connects, signing with the key in the chip',
      await phone.until('document.getElementById("link").textContent === "Live"', 12000));
    record('which the laptop verified as the new key, not the old one',
      devices.get(paired.id).fingerprint === movedTo.fingerprint);

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
