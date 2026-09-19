#!/usr/bin/env node
'use strict';

// The status screen in real Mobile WebKit, on a real iPhone screen.
//
//   node app/tools/webkit.js [section]
//
// look.js draws the same screen in Chromium, which is fast and scriptable and
// not the engine this ever runs in. The parts most likely to differ are the
// parts this redesign leans on hardest: a <table> told to stop being a table,
// <td> told to be a grid, and ::before drawing a column heading out of an
// attribute. Blink and WebKit do not have to agree about any of that.
//
// So the bundle is served with one extra script — the laptop record and the
// report, handed straight to the page's own listener — and opened in Safari on
// a booted simulator. Nothing about the page, the stylesheet or the renderer is
// stood in for; only the socket is.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');
const OUT = path.join(APP, 'screens');
const WWW = path.join(APP, 'www');
const { build } = require('./build.js');
const { report, SECTIONS } = require('./look.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sim = (...argv) => execFileSync('xcrun', ['simctl', ...argv], { encoding: 'utf8' });

function booted() {
  const line = sim('list', 'devices', 'booted').split('\n').find((l) => l.includes('(Booted)'));
  const id = line && line.match(/\(([0-9A-F-]{36})\)/);
  return id ? id[1] : null;
}

/**
 * The bundle, plus the one script that stands in for the socket.
 *
 * Injected by the server rather than written into www/, so nothing that ships
 * ever contains it and there is no debug hook to forget to take out.
 */
function serve(section, down) {
  // Two halves, and the order matters. The page asks for a laptop while its own
  // scripts are still running and sends itself to connect.html if there is not
  // one, so the record has to be in place before the first of them — which
  // means the head, not the end of the body.
  //
  // And both are files, not inline. The page's own policy is `script-src 'self'`
  // — the same policy it ships with — so an inline script is silently dropped
  // and every screen is a picture of the word "Looking". Served from this
  // origin, they are allowed, and the policy under test is the real one.
  const files = {
    '/__first.js': `localStorage.setItem('nikui.app.laptop', JSON.stringify({
      host: 'nikolozs-macbook-pro.tailf76b2f.ts.net', scheme: 'https', name: 'Laptop' }));`,
    '/__seed.js': `window.__report = ${JSON.stringify(report())};
      window.__want = ${JSON.stringify(section)};
      // Safari on a simulator is a browser, not the app, so Capacitor's runtime
      // answers 'web' and the page lays itself out with the bar in the flow.
      // On iOS the bar floats over the content instead, which is the whole
      // reason the screen carries a top padding — so the class the stylesheet
      // reads is set here, after the page's own scripts have had their say.
      document.documentElement.classList.remove('plat-web');
      document.documentElement.classList.add('plat-ios');
      window.__down = ${Number(down) || 0};
      addEventListener('load', () => {
        const send = () => postMessage({ type: 'status', available: true, report: window.__report }, '*');
        send();
        // The screen redraws whole on every report, so the section is chosen
        // after it exists rather than before.
        setTimeout(() => {
          const b = document.querySelector('[data-section="' + window.__want + '"]');
          if (b) b.click();
          // There is no way to scroll a simulator from out here, and the part
          // worth looking at — a table that has stopped being a table — is
          // under the fold. So the page scrolls itself.
          if (window.__down) setTimeout(() => {
            const screen = document.querySelector('.screen');
            if (screen) screen.scrollTop = window.__down * window.innerHeight * 0.85;
          }, 400);
        }, 500);
        setInterval(send, 4000);
      });`
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = decodeURIComponent(req.url.split('?')[0]);
      if (files[route]) {
        res.writeHead(200, { 'content-type': TYPES['.js'] });
        return res.end(files[route]);
      }
      const file = path.join(WWW, route === '/' ? 'index.html' : route);
      if (!file.startsWith(WWW)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, body) => {
        if (err) { res.writeHead(404); return res.end('no such file'); }
        let out = body;
        if (file.endsWith('status.html')) {
          out = Buffer.from(String(body)
            .replace('<head>', '<head><script src="/__first.js"></' + 'script>')
            .replace('</body>', '<script src="/__seed.js"></' + 'script></body>'));
        }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        res.end(out);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const device = booted();
  if (!device) {
    console.error('No booted simulator. Open one in Simulator.app first.');
    process.exit(1);
  }
  build();
  fs.mkdirSync(OUT, { recursive: true });

  const argv = process.argv.slice(2);
  const down = Number(argv.find((a) => /^\d+$/.test(a)) || 0);
  const want = argv.filter((a) => SECTIONS.includes(a));
  for (const section of (want.length ? want : SECTIONS)) {
    const server = await serve(section, down);
    const url = 'http://127.0.0.1:' + server.address().port + '/status.html';
    // A system alert left over from a previous run — Safari offering to open the
    // installed app — blocks the page's main thread, so the report never
    // arrives and every screen is a picture of the word "Looking".
    try { sim('terminate', device, 'com.apple.mobilesafari'); } catch (_) { /* not running */ }
    await wait(600);
    sim('openurl', device, url);
    await wait(6000);
    const shot = path.join(OUT, 'webkit-' + section + (down ? '-' + (down + 1) : '') + '.png');
    sim('io', device, 'screenshot', shot);
    console.log('shot  ' + section + ' → ' + path.relative(REPO, shot));
    server.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
