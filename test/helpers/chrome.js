'use strict';

// Finding a browser, and talking to one. Shared by the two checks that need a
// real engine: the webview page (file://) and the served client (http://).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ws = require('./ws.js');

function findChrome() {
  const candidates = [process.env.CHROME];
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    for (const dir of fs.readdirSync(cache)) {
      if (!/^chromium/.test(dir)) continue;
      for (const inner of ['chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        candidates.push(path.join(cache, dir, inner));
      }
    }
  } catch (_) { /* no playwright cache */ }
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A headless browser under remote control: navigate, run JavaScript, read the
 * page back. Enough of the DevTools protocol to drive the client, and no more.
 */
async function launch(binary) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-chrome-'));
  const proc = spawn(binary, [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await wait(50);
    try {
      const lines = fs.readFileSync(portFile, 'utf8').split('\n');
      if (lines[0] && Number(lines[0])) port = Number(lines[0]);
    } catch (_) { /* not written yet */ }
  }
  if (!port) { proc.kill(); throw new Error('the browser never opened a debugging port'); }

  const targets = await json(port, '/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { proc.kill(); throw new Error('the browser opened no page'); }

  const socket = await ws.connect(page.webSocketDebuggerUrl);
  let seq = 0;

  const call = async (method, params) => {
    const id = ++seq;
    socket.send({ id, method, params: params || {} });
    const reply = await socket.waitWhere((m) => m && m.id === id, 10000);
    if (reply.error) throw new Error(method + ': ' + reply.error.message);
    return reply.result;
  };

  return {
    port,
    call,
    /** Pretend to be a phone: viewport, pixel ratio and touch, as Chrome sees it. */
    asPhone: async (width, height) => {
      await call('Emulation.setDeviceMetricsOverride', {
        width: width || 390, height: height || 844, deviceScaleFactor: 3, mobile: true
      });
      await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    },
    /** What the browser should claim about the reader's preferences. */
    prefers: async (features) => {
      await call('Emulation.setEmulatedMedia', {
        features: Object.entries(features || {}).map(([name, value]) => ({ name, value }))
      });
    },
    /** A different shape of screen, for the layouts that are not a phone. */
    asScreen: async (width, height) => {
      await call('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 2, mobile: false
      });
    },
    navigate: async (url) => {
      await call('Page.navigate', { url });
      // Polling beats waiting on a load event: it is the same answer, and it
      // survives a page that finishes before the listener is attached.
      for (let i = 0; i < 100; i++) {
        const done = await evaluate(call, 'document.readyState === "complete"');
        if (done) return true;
        await wait(50);
      }
      throw new Error('the page never finished loading: ' + url);
    },
    evaluate: (expression) => evaluate(call, expression),
    /**
     * Run something in every page this browser loads, before its own scripts.
     *
     * The only way to stand in for something the page expects to already be
     * there — a native plugin, say — rather than patching it in afterwards and
     * testing a path the real app never takes.
     */
    beforeEachPage: async (source) => {
      // The Page domain has to be listening before it will keep a script.
      await call('Page.enable');
      await call('Page.addScriptToEvaluateOnNewDocument', { source });
    },
    /** Poll until an expression is true, or give up and say what it was. */
    until: async (expression, ms) => {
      const deadline = Date.now() + (ms || 5000);
      for (;;) {
        if (await evaluate(call, expression)) return true;
        if (Date.now() > deadline) return false;
        await wait(60);
      }
    },
    close: () => {
      try { socket.destroy(); } catch (_) { /* gone */ }
      try { proc.kill(); } catch (_) { /* gone */ }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* leave it */ }
    }
  };
}

async function evaluate(call, expression) {
  const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) {
    const thrown = out.exceptionDetails.exception || {};
    throw new Error((thrown.description || thrown.value || out.exceptionDetails.text) + '\n  in: ' + expression);
  }
  return out.result ? out.result.value : undefined;
}

function json(port, route) {
  return new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port, path: route, headers: { host: 'localhost:' + port } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    }).on('error', reject);
  });
}

module.exports = { findChrome, launch, wait };
