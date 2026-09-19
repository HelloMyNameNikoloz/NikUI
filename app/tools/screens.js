#!/usr/bin/env node
'use strict';

// Every screen of the app, on a real phone, as a picture.
//
//   node app/tools/screens.js            # pair, walk every screen, save PNGs
//   node app/tools/screens.js --keep     # leave it paired and the server up
//
// The browser check proves the app works. It cannot tell you that a line of
// text is cut in half, that a row is crowded, or that a screen looks wrong —
// and those are the only things somebody holding the phone will notice. So this
// drives the real app on the real device and brings back what it actually looks
// like.
//
// The phone is reached over adb (wireless, on the tailnet), and the WebView
// through its own debugging socket, so every step is the app's own code.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(REPO, 'app', 'screens');
const ADB = path.join(process.env.HOME, 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
const PHONE = process.env.NIKUI_PHONE || '100.64.251.31:35323';
const APP = 'com.nikoloz.nikui.debug';

const adb = (...argv) => execFileSync(ADB, ['-s', PHONE, ...argv], { encoding: 'utf8', timeout: 90000 });
const adbRaw = (...argv) => execFileSync(ADB, ['-s', PHONE, ...argv], { timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the WebView, driven the way a finger drives it -------------------------

const ws = require(path.join(REPO, 'test', 'helpers', 'ws.js'));

function forwardDevtools() {
  const sockets = adb('shell', 'cat', '/proc/net/unix').match(/webview_devtools_remote_\d+/g) || [];
  if (!sockets.length) return false;
  try { adb('forward', '--remove', 'tcp:9333'); } catch (_) { /* none yet */ }
  adb('forward', 'tcp:9333', 'localabstract:' + sockets[sockets.length - 1]);
  return true;
}

const listPages = () => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: 9333, path: '/json', timeout: 8000 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.on('timeout', () => { req.destroy(); reject(new Error('devtools did not answer')); });
});

async function attach(match, tries) {
  for (let i = 0; i < (tries || 30); i++) {
    try {
      forwardDevtools();
      const page = (await listPages()).find((p) =>
        p.type === 'page' && p.webSocketDebuggerUrl && (!match || match.test(p.url)));
      if (page) return open(page);
    } catch (_) { /* the app is still starting */ }
    await wait(600);
  }
  throw new Error('could not attach to ' + (match || 'the app'));
}

async function open(page) {
  const socket = await ws.connect(page.webSocketDebuggerUrl);
  let seq = 0;
  const evaluate = async (expression) => {
    const id = ++seq;
    socket.send({ id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true } });
    const reply = await socket.waitWhere((m) => m && m.id === id, 20000);
    if (reply.error) throw new Error(reply.error.message);
    const out = reply.result || {};
    if (out.exceptionDetails) {
      const thrown = out.exceptionDetails.exception || {};
      throw new Error(thrown.description || thrown.value || 'threw in the page');
    }
    return out.result ? out.result.value : undefined;
  };
  const until = async (expression, ms) => {
    const deadline = Date.now() + (ms || 12000);
    for (;;) {
      try { if (await evaluate(expression)) return true; } catch (_) { /* navigating */ }
      if (Date.now() > deadline) return false;
      await wait(300);
    }
  };
  return { url: page.url, evaluate, until, close: () => { try { socket.destroy(); } catch (_) { /* gone */ } } };
}

/** A picture of whatever is on the screen right now. */
function shoot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  const png = adbRaw('exec-out', 'screencap', '-p');
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, png);
  return file;
}

/**
 * What is cut off, clipped or spilling — the things a picture shows and an
 * assertion usually does not. Measured in the page rather than guessed from
 * the picture.
 */
const OVERFLOW = `(() => {
  const bad = [];
  const seen = new Set();
  for (const node of document.querySelectorAll('body *')) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const text = (node.textContent || '').trim().slice(0, 40);
    const where = node.id ? '#' + node.id : node.className ? '.' + String(node.className).split(' ')[0] : node.tagName;
    // Text wider than the box it is in, and not allowed to scroll or wrap out.
    // Text that was *told* to shorten itself is not a fault: an ellipsis is a
    // decision. What this is looking for is text with nowhere to go and no
    // instruction about it — the kind that simply disappears.
    // Visually hidden text is clipped on purpose; that is what it is for.
    if (node.classList.contains('sr-only')) continue;
    const shortens = style.textOverflow === 'ellipsis' && style.overflow !== 'visible';
    const clipped = !shortens && node.scrollWidth > node.clientWidth + 2 &&
      style.overflowX !== 'auto' && style.overflowX !== 'scroll';
    const clamped = style.webkitLineClamp && style.webkitLineClamp !== 'none';
    const tall = !clamped && node.scrollHeight > node.clientHeight + 2 &&
      style.overflowY !== 'auto' && style.overflowY !== 'scroll';
    const offscreen = box.right > window.innerWidth + 1 || box.left < -1;
    const key = where + ':' + text;
    if ((clipped || tall || offscreen) && text && !seen.has(key)) {
      seen.add(key);
      bad.push({
        where, text,
        why: clipped ? 'cut off sideways' : tall ? 'taller than its box' : 'off the side of the screen',
        w: Math.round(box.width), sw: node.scrollWidth, h: Math.round(box.height), sh: node.scrollHeight
      });
    }
  }
  return JSON.stringify(bad.slice(0, 12));
})()`;

module.exports = { adb, adbRaw, attach, open, shoot, wait, forwardDevtools, OVERFLOW, OUT, APP, PHONE, REPO };
