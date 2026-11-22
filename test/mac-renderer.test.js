'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { renderMarkdown, escapeHtml } = require('../media/markdown');
module.exports = () => {
  suite('P3 shared renderer extraction preserves VS Code transcript output');
  const frozen = fs.readFileSync(path.join(__dirname, 'fixtures/panel-paint-v1.js'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../media/transcript-renderer.js'), 'utf8');
  const items = [
    { kind: 'user', text: '<img onerror=bad()> ქართული 👋', at: 123, snippets: ['test'], images: [{ mediaType: 'image/jpeg', name: 'test', data: '/+==', width: 3, height: 4 }] },
    { kind: 'text', text: '# Heading\n\n**strong** [link](https://example.com)\n\n```js\nconst x = "<";\n```', streaming: true },
    { kind: 'thinking', text: 'marked text' }, { kind: 'thinking', text: '' },
    { kind: 'tool', name: 'Bash', input: { command: 'echo "<"' }, status: 'running' },
    { kind: 'tool', name: 'Read', input: { file_path: '/a/b' }, status: 'done', result: 'tool result', resultClipped: true, resultLength: 20000 },
    { kind: 'tool', name: 'Bash', input: {}, status: 'stopped', isError: true, result: 'error' },
    { kind: 'permission', name: 'Bash', input: { command: 'echo ok' }, requestId: 'approval' },
    { kind: 'permission', name: 'Bash', resolved: 'allow' }, { kind: 'permission', name: 'Read', resolved: 'deny' },
    { kind: 'result', durationMs: 2500, costUsd: 0.003, at: 999 }, { kind: 'result', interrupted: true },
    { kind: 'compact', trigger: 'manual', before: 200000 }, { kind: 'notice', text: '<script>', level: 'error' },
    { kind: 'future', text: 'kept unknown' }
  ];
  const element = () => ({ className: '', innerHTML: '', textContent: '', hidden: false, title: '',
    querySelector: () => ({ open: true }), querySelectorAll: () => [] });
  for (const inApp of [false, true]) for (const showThinking of [false, true]) {
    const helpers = { esc: escapeHtml, icon: (name, size) => '<i>' + name + size + '</i>',
      clockTag: (n, c) => '<time class="' + c + '">' + n + '</time>', pretty: JSON.stringify,
      summarise: (v) => JSON.stringify(v || {}), fmtBytes: (n) => n + ' characters', fmtDuration: (n) => n + 'ms' };
    const old = vm.runInNewContext('(' + frozen.trim() + ')', { ...helpers, window: { renderMarkdown },
      showThinking, IN_APP: inApp, snippetText: { test: 'standing instruction' }, vscode: { postMessage() {} } });
    const sharedContext = vm.createContext({ window: { renderMarkdown } });
    vm.runInContext(source, sharedContext);
    const shared = sharedContext.window.NikTranscriptRenderer.create({ ...helpers, inApp, showThinking: () => showThinking, snippetText: () => ({ test: 'standing instruction' }), postMessage() {} }).paint;
    for (const item of items) {
      const before = element(), after = element(); old(before, item); shared(after, item);
      const view = (el) => [el.className, el.innerHTML, el.textContent, el.hidden, el.title];
      checkEqual([item.kind, 'inApp=' + inApp, 'thinking=' + showThinking].join(' '), view(after), view(before));
    }
  }
  const paint = require('../media/transcript-renderer').create({ esc: escapeHtml, clockTag: () => '' }).paint;
  for (const images of [
    [{ mediaType: 'image/jpeg', data: 'AAAA" style="position:fixed"', width: 1, height: 2 }],
    [{ mediaType: 'image/svg+xml', data: 'AAAA', width: 1, height: 2 }],
    [{ mediaType: 'image/jpeg', data: 'AAAA', width: '1" onclick="bad()', height: 2 }],
    [{ mediaType: 'image/png', data: 'AAAA', width: 2, height: -4 }]
  ]) {
    const el = element(); paint(el, { kind: 'user', text: '', images });
    check('untrusted image attributes cannot add markup ' + JSON.stringify(images), !/style=|onclick=|svg\+xml|height="-/.test(el.innerHTML));
  }
  check('valid large base64 is bounded without recursive regexp overflow', !!require('../media/transcript-renderer').imageSource({ mediaType: 'image/jpeg', data: 'AAAA'.repeat(500000) }));
  for (const [mediaType, data] of [['image/jpeg', 'YQ'], ['image/avif', 'YWI'], ['image/png', 'Y Q==\n']]) {
    const el = element(); paint(el, { kind: 'user', text: '', images: [{ mediaType, data, width: '40000', height: '4' }] });
    check('producer raster data is normalized safely ' + mediaType, el.innerHTML.includes('width="40000" height="4"') && el.innerHTML.includes(';base64,YQ==') || mediaType === 'image/avif' && el.innerHTML.includes(';base64,YWI='));
  }
  // Check the served order as well as output parity: neither host may load a
  // panel which has not registered its shared painter yet.
  const page = fs.readFileSync(path.join(__dirname, '../src/page.js'), 'utf8');
  check('VS Code loads the shared renderer before panel.js', page.indexOf("'transcript-renderer.js'") < page.indexOf("'panel.js'", page.indexOf('const SCRIPTS')));
  const mac = fs.readFileSync(path.join(__dirname, '../media/mac-transcript.html'), 'utf8');
  check('Mac loads the same markdown, highlighter and painter', ['highlight.js', 'markdown.js', 'transcript-renderer.js'].every((name) => mac.includes('src="' + name + '"')));
  check('Mac CSP refuses inline styles', !mac.includes("'unsafe-inline'") && mac.includes("style-src-attr 'none'"));
  check('Mac page forbids network, frames and form submission', ["connect-src 'none'", "frame-src 'none'", "form-action 'none'"].every((v) => mac.includes(v)));
};
