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
const { makeDevice } = require(path.join(REPO, 'test', 'helpers', 'device.js'));
const { Terminals } = require(path.join(REPO, 'src', 'terminal.js'));
const { EventEmitter } = require('events');

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
  // A shell that never runs anything: what is under test on this side is the
  // screen, and a real `npm test` inside a test is a way to wait four minutes.
  let shell = null;
  const terminals = new Terminals({
    shell: '/bin/testsh',
    spawn: (bin, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      child.ran = args[1];
      shell = child;
      return child;
    },
    onEvent: (event) => laptop.terminalSaid(event)
  });

  const laptop = new RemoteServer({
    root: REPO,
    terminals,
    host: {
      config: () => ({ showThinking: true, promptSnippets: {} }),
      home: '/home', knownCommands: () => ['status'],
      fleet: () => [session], env: () => ({ vscode: 'app check' })
    },
    sessions: { list: () => [session], get: (id) => (id === session.id ? session : null) },
    devices, identity, pairing, localKey: new LocalKey(),
    // The window as the editor files it, so the phone is checked against the
    // shape it will actually be sent rather than a flat list.
    folders: { list: () => [{ id: 'f1', name: 'Phone epic', sessions: [session.id] }] },
    projectRoot: (cwd) => cwd,
    history: async () => [{
      sessionId: 'past-1', label: 'an earlier turn', title: 'what happened before',
      cwd: REPO, branch: 'main', modified: new Date()
    }],
    // The same report the editor's /status builds, from the same builder.
    report: () => require(path.join(REPO, 'src', 'report.js'))
      .buildReport({ session, fleet: [session], env: { home: '/home' } })
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
    // Anything a screen throws, kept. A check that asks "did anything throw"
    // and reads an array nobody fills is a check that always passes.
    await phone.beforeEachPage(`
      window.__errors = [];
      window.addEventListener('error', (e) => window.__errors.push(
        String((e && e.message) || e) + ' @ ' + String((e && e.filename) || '') + ':' + ((e && e.lineno) || 0)));
      window.addEventListener('unhandledrejection', (e) => window.__errors.push(
        'unhandled: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || e)));
    `);

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

    // The failure somebody actually hits: a laptop the phone has no route to.
    // "Load failed" is what the browser says; it has to become something that
    // tells you what to do about it.
    record('a laptop this phone cannot reach says so in words', (await phone.evaluate(`(async () => {
      const form = document.getElementById('form');
      const host = document.getElementById('host').value;
      document.getElementById('host').value = 'nowhere.tailabcdef.ts.net';
      document.getElementById('form').hidden = false;
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 200));
        const said = document.getElementById('note').textContent;
        if (/Could not reach/.test(said)) {
          document.getElementById('host').value = host;
          return /Tailscale/.test(said);
        }
      }
      document.getElementById('host').value = host;
      return false;
    })()`)) === true);

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
    // ---- the window, filed the way the editor files it ----------------------
    record('the fleet is drawn as cards rather than one long list',
      await phone.until('document.querySelectorAll(".rows-card").length >= 1', 8000));
    record('every peer screen is reachable from a tab bar',
      (await phone.evaluate(`[...document.querySelectorAll('.tab-label')].map(n => n.textContent).join(',')`))
        === 'Instances,Status,Terminal,History,Settings');
    record('the one you are on being the one that is marked',
      (await phone.evaluate(`document.querySelector('.tab.here .tab-label').textContent`)) === 'Instances');
    record('each tab drawn with the product\u2019s own icons',
      (await phone.evaluate('document.querySelectorAll(".tabs .tab .ico").length')) ===
      (await phone.evaluate('document.querySelectorAll(".tabs .tab").length')));
    record('and none of them wearing the same glyph as another',
      (await phone.evaluate(`(() => {
        const seen = [...document.querySelectorAll('.tabs .tab .ico svg')].map(s => s.innerHTML);
        return new Set(seen).size === seen.length;
      })()`)) === true);

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

    // A path long enough that a narrow screen cannot show all of it: what it
    // keeps has to be the end, because the front is what you already knew.
    session._upsert({
      id: 'k1', kind: 'tool', name: 'Edit', status: 'done', isError: false,
      input: { file_path: '/Users/somebody/Codes/a-project/packages/core/src/auth.js' }
    });
    record('a path too long for the screen keeps the end, not the front',
      await phone.until(`(() => {
        const t = [...document.querySelectorAll('.summary-text')].map(n => n.textContent).join(' ');
        return /auth\\.js/.test(t) && /^…\\//.test(t.trim());
      })()`, 8000));

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
    // ---- the other devices, from this one ------------------------------------
    //
    // Losing a phone is the moment you are not at the laptop, and the laptop was
    // the only place with a remove button. So the list is on the phone, with the
    // same rule as sending a prompt: your own is always yours to hand back, and
    // anybody else's needs the grant.

    const other = devices.add({
      name: 'The other phone',
      publicKey: (await makeDevice('The other phone')).publicKey,
      protection: 'strongbox'
    });

    record('settings lists every device paired with the laptop',
      await phone.until(`/The other phone/.test(document.body.textContent) &&
        /Check phone/.test(document.body.textContent)`, 8000));
    record('and says which row is this one',
      /This device/.test(await phone.evaluate('document.body.textContent')));
    record('with where each keeps its key',
      /Security chip/.test(await phone.evaluate('document.body.textContent')));
    record('a watching-only device is not offered somebody else\u2019s remove',
      (await phone.evaluate(`(() => {
        const row = [...document.querySelectorAll('.row')].find(r => /The other phone/.test(r.textContent));
        return !!row && row.tagName !== 'BUTTON';
      })()`)) === true);
    record('and is told why',
      /Only a device that may send prompts/.test(await phone.evaluate('document.body.textContent')));

    record('the device rows are thumb-sized and fit the screen',
      (await phone.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.row')].filter(r =>
          /The other phone|Check phone/.test(r.textContent));
        if (rows.length < 2) return false;
        return rows.every(r => {
          const box = r.getBoundingClientRect();
          return Math.round(box.height) >= 44 && box.right <= window.innerWidth + 1 && box.left >= -1;
        });
      })()`)) === true);

    devices.setControl(paired.id, true);
    record('granting control turns the other row into a control',
      await phone.until(`(() => {
        const row = [...document.querySelectorAll('.row')].find(r => /The other phone/.test(r.textContent));
        return !!row && row.tagName === 'BUTTON';
      })()`, 8000));

    record('one tap arms it rather than doing it',
      (await phone.evaluate(`(() => {
        const row = [...document.querySelectorAll('.row')].find(r => /The other phone/.test(r.textContent));
        row.click();
        return /Tap again/.test(row.textContent);
      })()`)) === true && !!devices.get(other.id));

    await phone.evaluate(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => /Tap again/.test(r.textContent));
      row.click();
    })()`);
    let removed = null;
    for (let i = 0; i < 100 && !removed; i++) {
      removed = devices.get(other.id) ? null : true;
      if (!removed) await wait(50);
    }
    record('the second tap removes it, on the laptop', !!removed);
    record('and it leaves the phone\u2019s list without a reload',
      await phone.until('!/The other phone/.test(document.body.textContent)', 8000));
    record('written down as one device removing another',
      devices.recent(8).some((e) => /removed another device/.test(e.action)));

    devices.setControl(paired.id, false);
    await phone.until('/Watching only/.test(document.body.textContent)', 8000);

    record('settings says the connection is sealed',
      await phone.until('/End-to-end encrypted/.test(document.body.textContent)', 10000));
    record('and offers a way to check it really is your laptop',
      /Check this is your laptop/i.test(await phone.evaluate('document.body.textContent')));
    record('which opens the fingerprint up to be read out loud',
      (await phone.evaluate(`(() => {
        const row = [...document.querySelectorAll('.row')].find(r => /Check this is your laptop/i.test(r.textContent));
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

    // Nothing on any screen may be cut off without having been told to be: an
    // ellipsis is a decision, text that simply vanishes is a bug.
    const CLIPPED = `(() => {
      const bad = [];
      for (const node of document.querySelectorAll('body *')) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (style.textOverflow === 'ellipsis' && style.overflow !== 'visible') continue;
        // Text that exists only for a screen reader is clipped on purpose.
        if (node.classList.contains('sr-only')) continue;
        if (style.webkitLineClamp && style.webkitLineClamp !== 'none') continue;
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
        const text = (node.textContent || '').trim();
        if (!text) continue;
        if (node.scrollWidth > node.clientWidth + 2) {
          bad.push((node.id ? '#' + node.id : node.className || node.tagName) + ': ' + text.slice(0, 30));
        }
      }
      return bad.slice(0, 6).join(' | ');
    })()`;
    for (const screen of ['index.html', 'status.html', 'terminal.html', 'history.html', 'settings.html']) {
      await phone.navigate(appOrigin + '/' + screen);
      await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 10000);
      const cut = await phone.evaluate(CLIPPED);
      record('nothing is cut off on ' + screen + (cut ? ' — ' + cut : ''), cut === '');
    }
    await phone.navigate(appOrigin + '/settings.html');
    await phone.until('document.querySelectorAll(".group").length >= 5', 10000);

    // Liquid Glass is Apple's material, so it belongs on Apple's hardware and
    // nowhere else. What is checked is that: the class gates it, and the chrome
    // — not the content — is what becomes glass.
    await phone.navigate(appOrigin + '/index.html');
    await phone.until('document.querySelectorAll(".tabs .tab").length === 3', 10000);
    record('a phone that is not an iPhone gets no glass',
      (await phone.evaluate(`getComputedStyle(document.querySelector('.tabs')).backdropFilter`))
        .indexOf('blur(30px)') < 0);
    await phone.evaluate(`document.documentElement.classList.add('plat-ios')`);
    record('and an iPhone gets it on the chrome',
      (await phone.evaluate(`getComputedStyle(document.querySelector('.tabs')).backdropFilter`))
        .indexOf('blur(30px)') >= 0);
    record('floating clear of the edges rather than welded to them',
      (await phone.evaluate(`(() => {
        const box = document.querySelector('.tabs').getBoundingClientRect();
        return box.left > 4 && (window.innerWidth - box.right) > 4;
      })()`)) === true);
    record('with the content passing under it',
      (await phone.evaluate(`getComputedStyle(document.querySelector('.tabs')).position`)) === 'absolute');
    record('and never on the cards somebody has to read',
      (await phone.evaluate(`getComputedStyle(document.querySelector('.rows-card')).backdropFilter`)) === 'none');
    await phone.evaluate(`document.documentElement.classList.remove('plat-ios')`);

    // The capsule: where it starts, that it can be pushed, and that pushing it
    // far enough goes somewhere.
    await phone.evaluate(`document.documentElement.classList.add('plat-ios')`);
    record('the selected tab is a capsule rather than a colour',
      (await phone.evaluate('!!document.querySelector(".tabs .tab-pill")')) === true);
    record('drawn where it belongs before anything can animate',
      (await phone.evaluate(`(() => {
        const pill = document.querySelector('.tab-pill').getBoundingClientRect();
        const tab = document.querySelectorAll('.tabs .tab')[0].getBoundingClientRect();
        return Math.abs(pill.left - tab.left) < 6;
      })()`)) === true);
    record('and it is glass in its own right on an iPhone',
      (await phone.evaluate(`getComputedStyle(document.querySelector('.tab-pill')).backdropFilter`))
        .indexOf('blur(12px)') >= 0);

    record('a finger dragged across the strip carries it', (await phone.evaluate(`(() => {
      const tabs = document.getElementById('tabs');
      const box = tabs.getBoundingClientRect();
      const pill = document.querySelector('.tab-pill');
      const at = (x) => ({ clientX: x, clientY: box.top + box.height / 2, pointerId: 1, pointerType: 'touch', button: 0, bubbles: true, cancelable: true });
      tabs.setPointerCapture = () => {};
      tabs.dispatchEvent(new PointerEvent('pointerdown', at(box.left + box.width / 6)));
      tabs.dispatchEvent(new PointerEvent('pointermove', at(box.left + box.width * 0.84)));
      const held = pill.classList.contains('held');
      const moved = pill.getBoundingClientRect().left > box.left + box.width / 3;
      tabs.dispatchEvent(new PointerEvent('pointerup', at(box.left + box.width * 0.84)));
      return held && moved;
    })()`)) === true);
    record('and letting go over another tab goes there',
      await phone.until('location.pathname.endsWith("settings.html")', 8000));
    await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 10000);
    record('with the capsule already under the new tab when it lands',
      (await phone.evaluate(`(() => {
        const pill = document.querySelector('.tab-pill').getBoundingClientRect();
        // The tab this landed on, found by name rather than by counting: a new
        // tab should not move an index that was never about the index.
        const tab = [...document.querySelectorAll('.tabs .tab')]
          .find((t) => /Settings/.test(t.textContent)).getBoundingClientRect();
        return Math.abs(pill.left - tab.left) < 6;
      })()`)) === true);
    await phone.evaluate(`document.documentElement.classList.remove('plat-ios')`);
    await phone.navigate(appOrigin + '/index.html');
    await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 10000);

    // The tint travels with the capsule rather than switching at a threshold:
    // halfway across, two tabs are half lit.
    record('a tab takes the colour by degrees as the capsule crosses it',
      (await phone.evaluate(`(() => {
        const tabs = document.getElementById('tabs');
        const box = tabs.getBoundingClientRect();
        tabs.setPointerCapture = () => {};
        const at = (x) => ({ clientX: x, clientY: box.top + box.height / 2, pointerId: 3, pointerType: 'touch', button: 0, bubbles: true, cancelable: true });
        tabs.dispatchEvent(new PointerEvent('pointerdown', at(box.left + box.width / 8)));
        // Straddling the boundary between the first two tabs.
        tabs.dispatchEvent(new PointerEvent('pointermove', at(box.left + box.width / 4)));
        const lit = [...document.querySelectorAll('.tabs .tab')]
          .map(t => Number(getComputedStyle(t).getPropertyValue('--lit')));
        tabs.dispatchEvent(new PointerEvent('pointercancel', at(box.left + box.width / 4)));
        const partial = lit.filter(v => v > 0.05 && v < 0.95).length;
        return partial >= 2;
      })()`)) === true);

    // A swipe across the content is the tab strip too, for a thumb that is
    // nowhere near the bottom of the screen.
    record('swiping the content sideways changes tab',
      await (async () => {
        await phone.navigate(appOrigin + '/index.html');
        await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 10000);
        await phone.evaluate(`(() => {
          const screen = document.querySelector('.screen');
          const box = screen.getBoundingClientRect();
          const y = box.top + box.height / 2;
          const at = (x) => ({ clientX: x, clientY: y, pointerId: 4, pointerType: 'touch', button: 0, bubbles: true, cancelable: true });
          screen.dispatchEvent(new PointerEvent('pointerdown', at(box.right - 40)));
          screen.dispatchEvent(new PointerEvent('pointermove', at(box.right - 120)));
          screen.dispatchEvent(new PointerEvent('pointermove', at(box.left + 40)));
          screen.dispatchEvent(new PointerEvent('pointerup', at(box.left + 40)));
        })()`);
        return phone.until('location.pathname.endsWith("status.html")', 8000);
      })());
    record('and a vertical drag does not',
      await (async () => {
        await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 10000);
        await phone.evaluate(`(() => {
          const screen = document.querySelector('.screen');
          const box = screen.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const at = (y) => ({ clientX: x, clientY: y, pointerId: 5, pointerType: 'touch', button: 0, bubbles: true, cancelable: true });
          screen.dispatchEvent(new PointerEvent('pointerdown', at(box.top + 60)));
          screen.dispatchEvent(new PointerEvent('pointermove', at(box.top + 200)));
          screen.dispatchEvent(new PointerEvent('pointerup', at(box.top + 320)));
        })()`);
        await wait(900);
        return (await phone.evaluate('location.pathname')).endsWith('status.html');
      })());
    // The point of this screen is that it is not a second opinion: the same
    // report, drawn by the same renderer the editor's panel uses.
    record('the status screen draws the panel\u2019s own sheet',
      await phone.until('document.querySelectorAll(".sheet-nav [data-section]").length >= 3', 15000));
    record('from the report the laptop builds for /status',
      /Tokens|Cost|Tools|Context/i.test(await phone.evaluate('document.body.textContent')));
    record('and its sections can be moved between',
      (await phone.evaluate(`(() => {
        const rail = [...document.querySelectorAll('.sheet-nav [data-section]')];
        if (rail.length < 2) return false;
        const before = document.querySelector('.sheet-body').textContent;
        rail[1].click();
        return document.querySelector('.sheet-body').textContent !== before;
      })()`)) === true);

    // ---- and it is a phone screen, not a panel squeezed into one -------------
    //
    // This screen draws a layout built for the width of an editor. Left alone it
    // reads like a spreadsheet through a letterbox: six unlabelled glyphs for
    // the sections, a ten-column table scrolling sideways past the edge of the
    // screen, and one card nineteen hundred points tall. Each of those is
    // checked here rather than looked at once, because each came back the
    // moment something else moved.

    record('every section is named, not just iconned',
      (await phone.evaluate(`[...document.querySelectorAll('.sheet-nav [data-section] span')]
        .every((s) => s.textContent.trim() && s.getBoundingClientRect().width > 8)`)) === true);

    const layout = JSON.parse(await phone.evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = [];
      const rail = [...document.querySelectorAll('.sheet-nav [data-section]')];
      for (const button of rail) {
        button.click();
        await wait(60);
        const vw = window.innerWidth;
        const all = [...document.querySelectorAll('.sheet-content *')];
        // A strip you swipe is allowed to run off its own ends; the page is not.
        const inStrip = (el) => {
          for (let p = el.parentElement; p; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (/auto|scroll/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 2) return true;
          }
          return false;
        };
        const wide = all.filter((el) => {
          if (el.ownerSVGElement || inStrip(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 1 && (r.right > vw + 1 || r.left < -1);
        }).length;
        const tiny = all.filter((el) => el.children.length === 0 && el.textContent.trim() &&
          el.getBoundingClientRect().width > 0 &&
          parseFloat(getComputedStyle(el).fontSize) < 12).length;
        // Measured, not asked: hidden is an attribute a stylesheet can lose an
        // argument with, and a row still on the screen is still on the screen
        // however it is marked.
        const rows = [...document.querySelectorAll('.sheet-content table.grid')]
          .map((t) => [...t.tBodies[0].rows]
            .filter((r) => r.getBoundingClientRect().height > 0).length);
        out.push({
          id: button.dataset.section,
          screens: document.querySelector('.screen').scrollHeight / window.innerHeight,
          wide, tiny, rows
        });
      }
      return JSON.stringify(out);
    })()`));

    const worstWide = layout.filter((s) => s.wide);
    record('nothing on any section is wider than the screen',
      worstWide.length === 0 || !console.log('  wide on: ' +
        worstWide.map((s) => s.id + '×' + s.wide).join(', ')));
    record('and nothing on one is smaller than 12px',
      layout.every((s) => s.tiny === 0) || !console.log('  small text on: ' +
        layout.filter((s) => s.tiny).map((s) => s.id).join(', ')));
    // Stacking a table makes each row about seven times taller, so a table that
    // was fine on a panel is two screens on a phone unless it is folded.
    record('no table opens with more than a handful of rows',
      layout.every((s) => s.rows.every((n) => n <= 6)) || !console.log('  long tables: ' +
        JSON.stringify(layout.map((s) => [s.id, s.rows]))));
    record('and no section is more than about three screens tall',
      layout.every((s) => s.screens < 3.6) || !console.log('  tall: ' +
        layout.map((s) => s.id + ' ' + s.screens.toFixed(2)).join(', ')));
    record('a folded table can still be opened in full',
      (await phone.evaluate(`(() => {
        const more = document.querySelector('.show-all');
        if (!more) return 'none';
        const table = more.previousElementSibling;
        const shown = () => [...table.tBodies[0].rows]
          .filter((r) => r.getBoundingClientRect().height > 0).length;
        const before = shown();
        more.click();
        const after = shown();
        return after > before && !document.querySelector('.show-all');
      })()`)) !== false);

    await phone.navigate(appOrigin + '/index.html');
    await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 10000);

    // The glitch this is here to stop coming back: a spring integrated badly
    // flips its velocity every step and the capsule teleports. Measured, not
    // eyeballed — every frame of a real flick, looking for a jump.
    record('the capsule never jumps, however hard it is thrown',
      await (async () => {
        await phone.navigate(appOrigin + '/index.html');
        await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 10000);
        const worst = await phone.evaluate(`(() => new Promise((resolve) => {
          const pill = document.querySelector('.tab-pill');
          const tabs = document.getElementById('tabs');
          const box = tabs.getBoundingClientRect();
          tabs.setPointerCapture = () => {};
          const at = (x) => ({ clientX: x, clientY: box.top + box.height / 2, pointerId: 9, pointerType: 'touch', button: 0, bubbles: true, cancelable: true });
          const read = () => {
            const t = getComputedStyle(pill).transform;
            const m = t === 'none' ? [1,0,0,1,0,0] : t.replace(/matrix\\(|\\)/g,'').split(',').map(Number);
            return m[4];
          };
          let worst = 0;
          let was = read();
          let n = 0;
          tabs.dispatchEvent(new PointerEvent('pointerdown', at(box.left + box.width * 0.1)));
          let flick = 0;
          const push = () => {
            flick++;
            const x = box.left + box.width * (0.1 + flick * 0.1);
            tabs.dispatchEvent(new PointerEvent('pointermove', at(x)));
            if (flick < 8) requestAnimationFrame(push);
            else tabs.dispatchEvent(new PointerEvent('pointercancel', at(x)));
          };
          const watch = () => {
            const now = read();
            worst = Math.max(worst, Math.abs(now - was));
            was = now;
            if (++n < 70) requestAnimationFrame(watch); else resolve(worst);
          };
          requestAnimationFrame(push);
          requestAnimationFrame(watch);
        }))()`);
        console.log('      worst single-frame movement: ' + Math.round(worst) + 'pt');
        return worst < 60;
      })());
    // DOMMatrix rather than unpicking the string: matrix() has six numbers and
    // matrix3d() sixteen, scaleY sits in a different place in each, and a
    // regular expression for it inside a template literal loses its backslash.
    const shape = await phone.evaluate(`(() => {
      const m = new DOMMatrix(getComputedStyle(document.querySelector('.tab-pill')).transform);
      return m.a + ',' + m.d;
    })()`);
    const [sx, sy] = String(shape).split(',').map(Number);
    console.log('      capsule shape: scaleX ' + sx.toFixed(3) + ' scaleY ' + sy.toFixed(3));
    record('and its stretch stays inside the bar rather than bursting out of it',
      sx <= 1.2 && sy >= 0.88);

    // A laptop that answers the handshake and then ignores a question is not an
    // unreachable laptop, and saying so sends somebody to look at their network
    // instead of at the window that needs reloading.
    record('a laptop that cannot build a status says so at once',
      await (async () => {
        const knew = laptop.report;
        laptop.report = null;
        await phone.navigate(appOrigin + '/status.html');
        const said = await phone.until('/too old/i.test(document.body.textContent)', 12000);
        laptop.report = knew;
        return said;
      })());

    // The case actually hit: a laptop running a client from before this screen
    // existed answers the handshake and then ignores the question entirely.
    record('and one that simply never answers says to reload it, not to check the network',
      await (async () => {
        const knew = laptop.statusMessage;
        laptop.statusMessage = () => ({ type: 'not-a-thing-this-client-knows' });
        await phone.navigate(appOrigin + '/status.html');
        const said = await phone.until('/older NikUI|reload/i.test(document.body.textContent)', 16000);
        const blamed = /Cannot reach/.test(await phone.evaluate('document.body.textContent'));
        laptop.statusMessage = knew;
        return said && !blamed;
      })());

    await phone.navigate(appOrigin + '/index.html');
    await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 10000);

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

    // ---- a command on the laptop, from the phone -----------------------------
    //
    // Behind the same grant as a prompt, because it is a shell on somebody's
    // machine. What it is not is a terminal emulator: each run is a block with
    // a command, its output and how it ended, which is the thing a phone can
    // actually show.

    devices.setControl(paired.id, true);
    await phone.navigate(appOrigin + '/terminal.html');
    record('the terminal screen offers somewhere to run',
      await phone.until('/Open a terminal/.test(document.body.textContent)', 10000));
    record('rooted beside an instance, named',
      /app check/.test(await phone.evaluate('document.body.textContent')));

    await phone.evaluate(`[...document.querySelectorAll('.row')][0].click()`);
    record('opening one gives you somewhere to type',
      await phone.until('document.getElementById("runner").hidden === false', 8000));

    await phone.evaluate(`(() => {
      document.getElementById('command').value = 'echo hello';
      document.getElementById('runner').dispatchEvent(new Event('submit', { cancelable: true }));
    })()`);
    record('a command runs on the laptop',
      await phone.until('/echo hello/.test(document.body.textContent)', 8000));
    record('and the laptop is the thing that ran it', shell && shell.ran === 'echo hello');

    shell.stdout.emit('data', 'hello\n');
    record('output arrives as it is printed',
      await phone.until('/hello/.test(document.querySelector(".run-out").textContent)', 6000));
    record('with a way to stop it while it is going',
      /Stop/.test(await phone.evaluate('document.querySelector(".run-foot").textContent')));

    shell.emit('close', 0, null);
    record('and how it ended when it is done',
      await phone.until('/Done/.test(document.querySelector(".run-foot").textContent)', 6000));

    const failing = shell;
    await phone.evaluate(`(() => {
      document.getElementById('command').value = 'false';
      document.getElementById('runner').dispatchEvent(new Event('submit', { cancelable: true }));
    })()`);
    await phone.until('document.querySelectorAll(".run").length === 2', 8000);
    void failing;
    shell.emit('close', 1, null);
    record('one that failed is marked as failed',
      await phone.until('document.querySelectorAll(".run.bad").length === 1', 6000));
    record('with the exit code on it',
      /Exit 1/.test(await phone.evaluate('document.body.textContent')));

    // ---- and the button that got you here ------------------------------------
    //
    // Claude says "run this"; the block it says it in is the place to say yes.

    session._upsert({
      id: 'cmd1', kind: 'text', streaming: false,
      text: 'Run this when you get a moment:\n\n```bash\nnpm run build\n```\n\nAnd this is not one:\n\n```python\nprint(1)\n```',
      images: []
    });
    await phone.navigate(appOrigin + '/conversation.html?session=' + session.id);
    record('a shell block in the conversation gets a run button',
      await phone.until('document.querySelectorAll("pre .run-it").length === 1', 12000));
    record('and a block that is not shell does not',
      (await phone.evaluate(`(() => {
        const python = [...document.querySelectorAll('pre')].find(p => p.dataset.lang === 'python');
        return !!python && !python.querySelector('.run-it');
      })()`)) === true);
    record('every code block still offers a copy, runnable or not',
      (await phone.evaluate(`(() => {
        const all = [...document.querySelectorAll('pre')];
        return all.length >= 2 && all.every(p => !!p.querySelector('.copy'));
      })()`)) === true);

    await phone.evaluate(`document.querySelector('pre .run-it').click()`);
    record('tapping it opens the terminal',
      await phone.until('location.pathname.endsWith("terminal.html")', 8000));
    await phone.settled();
    record('and runs what the block said, without being typed',
      await phone.until('document.querySelectorAll(".run").length >= 1', 10000) &&
      /npm run build/.test(await phone.evaluate('document.body.textContent')));
    record('on the laptop, in that instance\u2019s folder', shell && shell.ran === 'npm run build');
    shell.emit('close', 0, null);

    // ---- and it is not something a watching device can reach -----------------

    devices.setControl(paired.id, false);
    await phone.navigate(appOrigin + '/terminal.html');
    record('a device that only watches is told it cannot',
      await phone.until('/watch, but not run commands/.test(document.body.textContent)', 10000));
    record('and is given nowhere to type',
      (await phone.evaluate('document.getElementById("runner").hidden')) === true);
    devices.setControl(paired.id, true);

    // ---- the chip loses the key the record points at -------------------------
    //
    // The record is a name; the key is in the chip. Rebuild the app under a
    // different signing team and the keychain access group changes with it, so
    // the new build sees none of what the old one stored — while the WebView's
    // own storage, sitting in the same container, survives untouched. The phone
    // then holds a perfectly good-looking identity pointing at nothing, and
    // every signature fails with a sentence about a name.
    //
    // A locked phone looks almost identical from here and means the opposite,
    // so it is driven first: whatever this does about a missing key, it must not
    // do it to a phone that is merely in a pocket.

    const before = await phone.evaluate(
      '(async () => JSON.stringify(await window.nikDevice.load()))()');
    const wasPublic = JSON.parse(before).publicKey;

    await phone.evaluate('window.__chip.jam(true)');
    const whileLocked = JSON.parse(await phone.evaluate(
      '(async () => JSON.stringify(await window.nikDevice.ensure()))()'));
    record('a locked phone does not lose its identity',
      whileLocked.publicKey === wasPublic);
    record('and is not told it has to pair again', !whileLocked.lostKey);
    await phone.evaluate('window.__chip.jam(false)');

    const madeBefore = await phone.evaluate('window.__chip.made()');
    await phone.evaluate('window.__chip.wipe()');
    const after = JSON.parse(await phone.evaluate(
      '(async () => JSON.stringify(await window.nikDevice.ensure()))()'));
    record('a key that is really gone is noticed', !!after.lostKey);
    record('and a new one is made rather than nothing working',
      !!after.publicKey && after.publicKey !== wasPublic);
    record('in the chip, which is still a chip', after.protection === 'secure-enclave');
    record('it really was made, not copied from the old record',
      (await phone.evaluate('window.__chip.made()')) === madeBefore + 1);
    record('the pairing that named the old key is not carried over',
      after.id === null && after.fingerprint === null);
    record('and the new key can actually sign',
      (await phone.evaluate(`(async () => {
        try { return !!(await window.nikDevice.sign('hello')); } catch (_) { return false; }
      })()`)) === true);

    // Said out loud, because being silently unpaired looks like the laptop
    // going away and sends somebody to the wrong end of the problem.
    await phone.navigate(appOrigin + '/connect.html');
    record('and the app says why it is asking to pair again',
      await phone.until('/needs pairing again/.test(document.body.textContent)', 8000));

    // ---- the lock on the app's own front door --------------------------------
    //
    // It stops the person this phone is handed to. Not the laptop's safety —
    // that is the key in the chip — but the difference between somebody
    // borrowing your phone and somebody sending prompts to your machine.

    const tap = (text) => phone.evaluate(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => new RegExp(${JSON.stringify(text)}).test(r.textContent));
      if (!row) return false;
      row.click();
      return true;
    })()`);
    const key = (digit) => phone.evaluate(`(() => {
      const k = [...document.querySelectorAll('.lock-key')]
        .find(b => b.textContent.trim() === ${JSON.stringify(String(digit))});
      if (!k) return false;
      k.click();
      return true;
    })()`);
    const punch = async (code) => { for (const d of String(code)) await key(d); };
    // The row's own value, not the word appearing somewhere on the page: "On"
    // is in half the sentences on this screen, and an assertion that matches
    // any of them passes whatever the setting actually says.
    const rowSays = (label, value) => phone.until(
      '(() => {' +
      '  const row = [...document.querySelectorAll(".row")].find(r =>' +
      '    r.querySelector("b") && r.querySelector("b").textContent.indexOf(' + JSON.stringify(label) + ') >= 0);' +
      '  const said = row && row.querySelector(".row-value");' +
      '  return !!said && said.textContent.trim() === ' + JSON.stringify(value) + ';' +
      '})()', 8000);

    const enter = () => phone.evaluate(`(() => {
      const go = [...document.querySelectorAll('.lock-key')].find(b => b.getAttribute('aria-label') === 'Unlock' ||
        b.getAttribute('aria-label') === 'Continue');
      if (!go) return false;
      go.click();
      return true;
    })()`);

    await phone.navigate(appOrigin + '/settings.html');
    await phone.until('document.querySelectorAll(".group").length >= 5', 8000);
    await phone.evaluate('window.__setFace({ say: "cancelled" })');

    record('settings offers to lock the app', await tap('Require a passcode'));
    record('which asks for a passcode, twice',
      await phone.until('/Choose a passcode/.test(document.body.textContent)', 6000));

    await punch('2468');
    await enter();
    record('and will not take a code that does not match the first',
      await (async () => {
        await phone.until('/Enter it again/.test(document.body.textContent)', 4000);
        await punch('1357');
        await enter();
        return phone.until('/did not match/.test(document.body.textContent)', 4000);
      })());

    await punch('2468');
    await enter();
    await phone.until('/Enter it again/.test(document.body.textContent)', 4000);
    await punch('2468');
    await enter();
    record('two that agree turn it on', await rowSays('Require a passcode', 'On'));

    // The thing that matters: a fresh start is covered before it has drawn.
    // Session storage is what makes moving between screens free, so clearing it
    // is what "the app was killed and opened again" looks like from here.
    const coldStart = async (page) => {
      await phone.evaluate("window.sessionStorage.removeItem('nikui.app.unlocked')");
      await phone.navigate(appOrigin + (page || '/index.html'));
    };

    await coldStart();
    record('opening the app again asks for it',
      await phone.until('document.querySelector(".lock") !== null', 8000));
    record('and nothing behind it is on the screen',
      (await phone.evaluate(`[...document.body.children]
        .filter(el => !el.classList.contains('lock'))
        .every(el => el.offsetParent === null)`)) === true);

    record('a wrong one is refused and said so',
      await (async () => {
        await punch('1111');
        await enter();
        return phone.until('/Wrong passcode/.test(document.body.textContent)', 4000);
      })());

    record('the right one opens it',
      await (async () => {
        await punch('2468');
        await enter();
        return phone.until('document.querySelector(".lock") === null', 6000);
      })());
    record('and the app is there underneath',
      await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 8000));

    record('moving between screens does not ask again',
      await (async () => {
        await phone.navigate(appOrigin + '/settings.html');
        await phone.until('document.querySelectorAll(".group").length >= 5', 8000);
        return (await phone.evaluate('document.querySelector(".lock") === null')) === true;
      })());

    // Three tries with a face, and then the keypad — the rule that stops a phone
    // held up to the wrong face turning into a loop of prompts.
    await phone.evaluate('window.__setFace({ say: "no", asked: 0 })');
    await coldStart();
    await phone.until('document.querySelector(".lock") !== null', 8000);
    // Offered once without being asked — on a phone, holding it up is the thing
    // you were going to do anyway — and then twice more on the button.
    record('a face is offered the moment the lock appears',
      await phone.until('window.__face.asked === 1', 8000));
    const again = () => phone.evaluate(`(() => {
      const b = document.querySelector('.lock-face');
      if (!b || b.hidden || b.disabled) return false;
      b.click();
      return true;
    })()`);
    record('and can be asked for twice more', await (async () => {
      await phone.until('document.querySelector(".lock-face") && !document.querySelector(".lock-face").hidden', 4000);
      if (!await again()) return false;
      await phone.until('window.__face.asked === 2', 4000);
      await phone.until('document.querySelector(".lock-face") && !document.querySelector(".lock-face").hidden', 4000);
      if (!await again()) return false;
      return phone.until('window.__face.asked === 3', 4000);
    })());
    record('three is the end of it', await (async () => {
      await wait(300);
      const offered = await phone.evaluate('!!document.querySelector(".lock-face") && !document.querySelector(".lock-face").hidden');
      return offered === false && (await phone.evaluate('window.__face.asked')) === 3;
    })());
    record('and then the passcode is the only way in',
      await phone.until(`/Enter your passcode instead/.test(document.body.textContent) &&
        document.querySelector('.lock-face').hidden === true`, 6000));

    await phone.evaluate('window.__setFace({ say: "yes" })');
    await punch('2468');
    await enter();
    await phone.until('document.querySelector(".lock") === null', 6000);

    record('turning the lock off needs the passcode',
      await (async () => {
        await phone.navigate(appOrigin + '/settings.html');
        await phone.until('document.querySelectorAll(".group").length >= 5', 8000);
        await tap('Require a passcode');
        return phone.until('/turn the lock off/.test(document.body.textContent)', 6000);
      })());

    await punch('2468');
    await enter();
    record('and then it is off', await rowSays('Require a passcode', 'Off'));
    record('so the app opens straight away again',
      await (async () => {
        await phone.navigate(appOrigin + '/index.html');
        await phone.until('document.querySelectorAll(".tabs .tab").length >= 4', 8000);
        return (await phone.evaluate('document.querySelector(".lock") === null')) === true;
      })());

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
