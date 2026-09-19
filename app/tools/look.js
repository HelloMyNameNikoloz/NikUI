#!/usr/bin/env node
'use strict';

// The phone's screens, at phone size, as pictures and as measurements.
//
//   node app/tools/look.js                 # every section of Status
//   node app/tools/look.js fleet usage     # only these
//
// The device harness (screens.js) needs a phone on the end of a cable and a
// laptop it has paired with. This needs neither, so it can be run after every
// edit — which is the difference between designing a screen and guessing at it.
// The page, the stylesheet and the renderer are the app's own; only the report
// is handed over directly rather than arriving down a socket.
//
// It prints what a picture cannot: how far the screen scrolls, what is wider
// than the viewport, and the size of the smallest text on it.

const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');
const OUT = path.join(APP, 'screens');
const { findChrome, launch, wait } = require(path.join(REPO, 'test', 'helpers', 'chrome.js'));
const { install, memoryState } = require(path.join(REPO, 'test', 'helpers', 'vscode-stub.js'));
install();
const { Session } = require(path.join(REPO, 'src', 'session.js'));
const { buildReport } = require(path.join(REPO, 'src', 'report.js'));
const { build } = require('./build.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

function serve(root) {
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

/**
 * An instance with enough behind it that every section has something to draw.
 *
 * A status screen looks fine with nothing in it. The long values, the deep tool
 * list and the many turns are the whole point: they are what a real one has and
 * what a layout has to survive.
 */
function report() {
  const session = new Session({ cwd: path.join(REPO, '..', 'a-rather-long-project-name') });
  session.customTitle = 'Phone epic — the status screen, and everything under it';
  session.start = function () { this.everStarted = true; };
  session._write = function () {};
  Object.defineProperty(session, 'isRunning', { get: () => true });

  session.startedAt = Date.now() - 1000 * 60 * 87;
  session.usage = { input: 412_300, output: 88_140, cacheRead: 2_904_551, cacheCreate: 311_002 };
  session.model = 'claude-opus-5';
  session.contextTokens = 158_400;
  session.contextWindow = 200_000;

  const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Glob', 'Task', 'WebFetch',
    'NotebookEdit', 'TodoWrite', 'MultiEdit', 'WebSearch'];
  session.turnLog = [];
  for (let i = 0; i < 14; i++) {
    // The shape `buildReport` reads, field for field. A turn whose numbers sit
    // somewhere else renders NaN, and a harness that shows NaN is a harness
    // that sends you looking for a bug in the screen.
    session.turnLog.push({
      n: i + 1,
      at: Date.now() - 1000 * 60 * (86 - i * 6),
      durationMs: 9000 + i * 2200,
      costUsd: 0.21 + i * 0.043,
      input: 9000 + i * 300,
      output: 1800 + i * 90,
      cacheRead: 120000 + i * 4000,
      cacheCreate: 8000,
      contextTokens: 40000 + i * 9000,
      model: 'claude-opus-5',
      interrupted: i === 6,
      isError: i === 11,
      tools: TOOLS.slice(0, 3 + (i % 9))
    });
  }

  session._upsert({ id: 'u1', kind: 'user', text: 'make the status screen readable', images: [] });
  for (let i = 0; i < 9; i++) {
    session._upsert({
      id: 't' + i, kind: 'tool', name: TOOLS[i % TOOLS.length],
      input: { file_path: '/Users/somebody/Codes/a-rather-long-project-name/src/very/deep/module.js' },
      text: 'did a thing', images: []
    });
  }

  return buildReport({
    session,
    fleet: [session],
    env: { vscode: '1.99.0', node: process.version, os: 'darwin 27.0.0', claude: '2.0.14' }
  });
}

const SECTIONS = ['fleet', 'overview', 'usage', 'tools', 'timeline', 'system'];

// A screen is too tall when it is more than about two phone-fulls: past that
// nobody scrolls to the end, and anything down there might as well not be on it.
const TALL = 3.1;

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('No Chrome found. Set CHROME=/path/to/chrome.'); process.exit(1); }
  build();
  fs.mkdirSync(OUT, { recursive: true });

  const wanted = process.argv.slice(2).filter((a) => SECTIONS.includes(a));
  const sections = wanted.length ? wanted : SECTIONS;

  const bundle = await serve(path.join(APP, 'www'));
  const origin = 'http://127.0.0.1:' + bundle.address().port;
  const phone = await launch(chrome);
  const notes = [];

  try {
    await phone.asPhone(393, 852);
    await phone.beforeEachPage(`
      window.localStorage.setItem('nikui.app.laptop', JSON.stringify({
        host: 'nikolozs-macbook-pro.tailf76b2f.ts.net', scheme: 'https', name: 'Laptop'
      }));
      window.__errors = [];
      window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
    `);
    await phone.navigate(origin + '/status.html');

    const REPORT = JSON.stringify(report());
    for (const id of sections) {
      // Posted rather than fetched: the screen's own listener, the same message
      // the laptop sends, and no socket in the way.
      await phone.evaluate(
        `window.postMessage({ type: 'status', available: true, report: ${REPORT} }, '*')`);
      await phone.until('document.querySelector("[data-section]") !== null', 6000);
      await phone.evaluate(`(() => {
        const b = document.querySelector('[data-section="${id}"]');
        if (b) b.click();
      })()`);
      await wait(250);

      const seen = await phone.evaluate(`(() => {
        const vh = window.innerHeight, vw = window.innerWidth;
        const doc = document.documentElement;
        const all = [...document.querySelectorAll('body *')];
        // Whatever actually scrolls: the body on one layout, a pane on another.
        const panes = [doc, document.body, ...all]
          .filter((el) => el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 80);
        const tallest = panes.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || doc;

        // A strip you swipe is allowed to have things off both its ends; that is
        // what a strip is. Only what the *page* cannot reach counts as too wide.
        const inStrip = (el) => {
          for (let p = el.parentElement; p; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (/auto|scroll/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 2) return true;
          }
          return false;
        };
        const hidden = (el) => el.closest('.sr-only') || el.classList.contains('sr-only');

        const wide = all.filter((el) => {
          // Inside an <svg> the coordinates are the drawing's, not the page's,
          // and the viewBox clips anyway. The root svg is the thing that can
          // actually be too wide, and it is checked like everything else.
          if (el.ownerSVGElement) return false;
          if (inStrip(el) || hidden(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 1 && (r.right > vw + 1 || r.left < -1);
        }).slice(0, 6).map((el) => el.tagName.toLowerCase() +
          (el.className && el.className.baseVal === undefined ? '.' + el.className : '') +
          ' → ' + Math.round(el.getBoundingClientRect().right) + 'px');

        const leaves = all.filter((el) => el.children.length === 0 &&
          el.textContent.trim() && !hidden(el) && el.getBoundingClientRect().width > 0);

        // The tab bar is 10pt on purpose: that is what a native iOS tab bar is,
        // and matching it is the point. Everything else is content.
        const chrome = (el) => !!el.closest('.tabs');

        const small = leaves.filter((el) => !chrome(el)).map((el) => ({
          px: Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10,
          what: el.tagName.toLowerCase() + '.' + (el.className || '') + ' "' +
            el.textContent.trim().slice(0, 24) + '"'
        })).filter((x) => x.px < 12).slice(0, 4);

        // Stacking a table makes each row about seven times taller, so one that
        // read fine on a panel is two screens here unless it opens folded.
        const rows = [...document.querySelectorAll('.sheet-content table.grid')]
          .map((t) => [...t.tBodies[0].rows]
            .filter((r) => r.getBoundingClientRect().height > 0).length)
          .filter((n) => n > 6);

        const clipped = leaves.filter((el) => {
          const s = getComputedStyle(el);
          if (s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none') return false;
          return el.scrollWidth > el.clientWidth + 2;
        }).slice(0, 5).map((el) => el.textContent.trim().slice(0, 40));

        const blocks = [...document.querySelectorAll('.sheet-content > *')].map((el) =>
          (el.querySelector('h3, .hero-label') || el).textContent.trim().slice(0, 26) +
          ' ' + Math.round(el.getBoundingClientRect().height) + 'px');
        return JSON.stringify({
          blocks,
          vh, vw,
          scroll: tallest.scrollHeight,
          screens: +(tallest.scrollHeight / vh).toFixed(2),
          wide, clipped, small, rows,
          errors: window.__errors.length
        });
      })()`);
      const m = JSON.parse(seen);

      const shot = await phone.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(OUT, 'status-' + id + '.png'), Buffer.from(shot.data, 'base64'));

      // What is under the fold is where the tables are, and the tables were the
      // whole complaint. A picture of the top of a screen proves nothing about
      // the part nobody could read.
      for (let page = 1; page * m.vh < m.scroll && page < 4; page++) {
        await phone.evaluate(`(() => {
          const panes = [document.documentElement, document.body,
            ...document.querySelectorAll('*')]
            .filter((el) => el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 80);
          const tallest = panes.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
          if (tallest) tallest.scrollTop = ${'${page}'} * ${'${m.vh}'} * 0.9;
        })()`.replace('${page}', page).replace('${m.vh}', m.vh));
        await wait(180);
        const down = await phone.call('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT, 'status-' + id + '-' + (page + 1) + '.png'),
          Buffer.from(down.data, 'base64'));
      }

      const bad = [];
      if (m.screens > TALL) bad.push(m.screens + ' screens tall');
      if (m.wide.length) bad.push(m.wide.length + ' wider than the screen');
      if (m.clipped.length) bad.push(m.clipped.length + ' cut off');
      if (m.rows.length) bad.push('a table opens with ' + Math.max(...m.rows) + ' rows');
      if (m.small.length) bad.push('text under 12px');
      if (m.errors) bad.push(m.errors + ' errors thrown');
      notes.push({ id, m, bad });
      console.log((bad.length ? 'LOOK  ' : 'ok    ') + id.padEnd(9) +
        String(m.screens).padStart(5) + ' screens' +
        (bad.length ? '   — ' + bad.join('; ') : ''));
      for (const w of m.wide) console.log('         wide: ' + w);
      for (const c of m.clipped) console.log('         cut:  ' + c);
      for (const t of m.small) console.log('         ' + t.px + 'px: ' + t.what);
      if (process.env.BLOCKS) for (const b of m.blocks) console.log('         · ' + b);
    }
  } finally {
    phone.close();
    bundle.close();
  }

  console.log('\npictures in app/screens/');
  process.exit(notes.some((n) => n.bad.length) ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
