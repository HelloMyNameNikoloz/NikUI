#!/usr/bin/env node
'use strict';

// Real bundled screens with a deterministic laptop on the other end. Keeping
// the fixtures at the transport boundary exercises the app's own renderers.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { findChrome, launch, wait } = require('../../test/helpers/chrome');
const { build } = require('./build');
const { renderPage } = require('../../src/page');
const { report } = require('./look');
const ROOT = path.join(__dirname, '..', 'www');
const OUT = path.join(__dirname, '..', 'screens', process.argv.includes('--before') ? 'before' : 'after');
const now = Date.now();
const fleet = {
  type: 'fleet', projects: [{ name: 'NikUI', path: '/Users/nik/Codes/NikUI' }, { name: 'Atlas', path: '/Users/nik/Codes/Atlas' }],
  folders: [{id:'phone',name:'Phone work'}], codexState: { loaded: true },
  instances: [
    { id: 'cl-design', label: 'Polish the pairing flow', status: 'waiting', cwd: '/Users/nik/Codes/NikUI', cost: 1.24, activeAt: now - 120000, project: { name: 'NikUI', path: '/Users/nik/Codes/NikUI' } },
    { id: 'cl-read', label: 'Tidy the settings page', status: 'done', cwd: '/Users/nik/Codes/NikUI', cost: 0.21, activeAt: now - 1800000, project: { name: 'NikUI', path: '/Users/nik/Codes/NikUI' } },
    { id: 'cl-tests', label: 'Add keyboard navigation', status: 'done', unread: true, cwd: '/Users/nik/Codes/Atlas', cost: 0.38, activeAt: now - 900000, project: { name: 'Atlas', path: '/Users/nik/Codes/Atlas' } }
  ],
  codex: [
    { id: 'cx-mobile', provider: 'codex', label: 'Build a better mobile workspace', status: 'working', cwd: '/Users/nik/Codes/NikUI', activeAt: now - 30000 },
    { id: 'cx-review', provider: 'codex', label: 'Review the authentication changes', status: 'idle', cwd: '/Users/nik/Codes/Atlas', activeAt: now - 3600000 }
  ]
};
function conversation(provider) {
  const codex = provider === 'codex';
  return {
    type: 'init', sessionId: codex ? 'cx-mobile' : 'cl-design', status: codex ? 'working' : 'waiting', showThinking: true, fontSize: 13,
    meta: { provider, label: codex ? 'Mobile workspace' : 'Pairing flow', cwd: '/Users/nik/Codes/NikUI', home: '/Users/nik',
      model: codex ? 'gpt-5.5' : 'claude-opus-4-6', effort: 'high', permissionMode: codex ? null : 'default',
      mode: codex ? 'plan' : null, goal: codex ? { objective: 'Ship a thoughtful phone experience for both agents', status: 'active' } : null,
      usingMac: codex ? { title: 'Checking the mobile layout in Chrome' } : null },
    stats: { input: 18400, output: 3200, total: 21600, cost: codex ? 0 : 1.24, turns: 3, elapsedMs: 84000, running: false },
    slashCommands: codex ? ['plan', 'goal', 'review', 'fork', 'undo', 'model', 'effort', 'steer'] : ['status', 'model', 'effort', 'plan'],
    commandArgs: { model: [{ value: 'gpt-5.5', label: 'GPT-5.5' }], effort: ['low', 'medium', 'high'] },
    items: [
      { id: 'u1', kind: 'user', text: 'Make the phone app feel calm, clear, and easy to use with one hand.', at: now - 180000 },
      { id: 'a1', kind: 'text', text: codex ? 'I’ll start with the moments you use most:\n\n1. **See what needs you** across Claude and Codex.\n2. **Start in the right folder** in a couple of taps.\n3. **Stay in control** with clear plan, goal, and stop actions.\n\nI’m checking the layout on a phone before changing the details.' : 'The new pairing flow is ready. I’d like to run the app checks to make sure connecting still works.\n\nYour pairing key stays on this device.', at: now - 90000 },
      ...(codex ? [{ id: 't1', kind: 'tool', name: 'Read', input: { file_path: 'app/shell/app.css' }, result: 'Read 248 lines', at: now - 60000 }] : [
        { id: 'p1', kind: 'permission', requestId: 'permission-fixture', name: 'Bash', input: { command: 'npm run test:app' }, at: now - 30000 }
      ])
    ]
  };
}
const history = { type: 'history', available: true, entries: [
  { sessionId: 'cx-mobile', provider: 'codex', label: 'A better mobile workspace', cwd: '/Users/nik/Codes/NikUI', modified: now - 600000, branch: 'mobile-redesign' },
  { sessionId: 'cl-design', provider: 'claude', label: 'Simplify the pairing flow', cwd: '/Users/nik/Codes/NikUI', modified: now - 5400000, branch: 'main' },
  { sessionId: 'cx-review', provider: 'codex', label: 'Review authentication changes', cwd: '/Users/nik/Codes/Atlas', modified: now - 86400000 },
  { sessionId: 'cl-tests', provider: 'claude', label: 'Keyboard navigation and focus states', cwd: '/Users/nik/Codes/Atlas', modified: now - 100000000 }
] };
const terminal = { id: 'term-fixture', name: 'NikUI', cwd: '/Users/nik/Codes/NikUI' };
const runs = [
  { id: 'r1', command: 'git status --short', output: ' M app/shell/app.css\n M media/home.js\n M media/panel.js', done: true, exit: 0, tookMs: 120 },
  { id: 'r2', command: 'npm run test:app', output: '> nikui-app checks\n\n✓ Shared client stays in sync\n✓ Pairing and device controls\n✓ Phone navigation\n\n148 checks passed', done: true, exit: 0, tookMs: 2400 }
];
fleet.instances[0].sessionId = 'cl-design';
fleet.instances[1].sessionId = 'cl-tests';
for (let i = 0; i < 6; i++) fleet.instances.push({ id: 'cl-extra-' + i, label: ['Check notification delivery', 'Fix the terminal reconnect', 'Prepare the next release', 'Review database migrations', 'Update accessibility labels', 'Test the background listener'][i], status: i === 0 ? 'working' : 'idle', cwd: '/Users/nik/Codes/Atlas', activeAt: now - (i + 2) * 3600000 });
history.entries.push({ sessionId: 'older-claude', provider: 'claude', label: 'Investigate a previous release', cwd: '/Users/nik/Codes/Atlas', modified: now - 3 * 86400000 });
const workspaceReport = report();
workspaceReport.fleet.push({ ...workspaceReport.fleet[0], id: 'cl-third', label: 'Keyboard navigation', status: 'waiting', busy: false });
const fixtures = { fleet, history, terminal, runs, codex: conversation('codex'), claude: conversation('claude'), report: workspaceReport };
const mock = `window.__sent = []; window.nikTransport = () => ({
  getState: () => null, setState: () => {}, retry: () => {window.__retries=(window.__retries||0)+1}, sealed: () => true, __state: () => window.__offline ? 'offline' : 'online',
  postMessage: (m) => { window.__sent.push(m); const f = window.__fixtures;
    const reply = (data) => setTimeout(() => window.postMessage(data, '*'), 10);
    if (m.type === 'history') reply(f.history);
    if (m.type === 'status') reply({type:'status', available:true, report:f.report});
    if (m.type === 'term:list') reply({type:'term:list', terminals:[f.terminal]});
    if (m.type === 'term:attach') reply({type:'term:scrollback', terminal:f.terminal, runs:f.runs});
    if (m.type === 'awake') reply({type:'awake',available:true,supported:true,on:true,held:true,mayChange:true,since:Date.now()-3600000});
  }
});`;

async function main() {
  build();
  fs.mkdirSync(OUT, { recursive: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/media/transport.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(mock); }
    // An Android phone whose laptop has a newer build: Capacitor's own file,
    // with the updater plugin standing in for the native one.
    if (url.pathname === '/capacitor.js' && /[?&]update/.test(req.headers.referer || '')) {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(fs.readFileSync(path.join(ROOT, 'capacitor.js'), 'utf8') + `;Capacitor.getPlatform=()=>'android';Capacitor.Plugins.Updater={
        status:()=>Promise.resolve({}), addListener:(n,fn)=>{if(n==='progress')window.__progress=fn;return{remove(){}}},
        canInstall:()=>Promise.resolve({allowed:true}), install:()=>new Promise(()=>{}), confirm:()=>Promise.resolve(), allow:()=>Promise.resolve()};`);
    }
    if (url.pathname === '/health') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.end('{}'); }
    if (url.pathname === '/editor.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(renderPage({ asset: (file) => 'media/' + file, nonce: 'fixture', csp: "default-src 'self' data:; script-src 'self'; style-src 'self'", head: '<link rel="stylesheet" href="media/browser.css">' }));
    }
    if (url.pathname.startsWith('/screens/')) {
      res.setHeader('Content-Type', 'image/png');
      return fs.createReadStream(path.join(OUT, path.basename(url.pathname))).pipe(res);
    }
    if (url.pathname === '/gallery.html') {
      const platform = url.searchParams.get('platform') === 'android' ? 'android' : 'ios';
      const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<html><head><style>*{box-sizing:border-box}body{margin:0;background:#778782;font:14px system-ui;display:grid;grid-template-columns:repeat(4,393px)}figure{margin:0}figcaption{height:32px;padding:6px 12px}img{display:block;width:393px;height:852px}</style></head><body>' +
        ['instances','codex','claude','status','history','settings','terminal','connect'].map((name) => '<figure><figcaption>' + platform + ' · ' + theme + ' · ' + name + '</figcaption><img src="/screens/' + platform + '-' + theme + '-' + name + '.png"></figure>').join('') + '</body></html>');
    }
    const file = path.resolve(ROOT, '.' + url.pathname);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const phone = await launch(findChrome());
  let failed = false;
  let checks = 0;
  const check = async (name, expression) => {
    checks++;
    const ok = await phone.evaluate(expression);
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
    if (!ok) failed = true;
  };
  const tap = async (selector) => {
    const point = await phone.evaluate(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({block:'nearest',inline:'nearest'});
      const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);
    await phone.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await phone.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(30);
  };
  try {
    await phone.asPhone(393, 852);
    await phone.beforeEachPage(`window.__fixtures = ${JSON.stringify(fixtures)};
      window.__contrast = (a,b) => {
        const channels = c => c.startsWith('#') ? [1,3,5].map(i=>parseInt(c.slice(i,i+2),16)) : c.match(/[0-9.]+/g).slice(0,3).map(Number);
        const lum = c => channels(c).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
        const x=lum(a), y=lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
      };
      window.__errors = []; addEventListener('error', e => window.__errors.push(e.message));
      if (location.pathname === '/editor.html') window.acquireVsCodeApi = () => ({});
      try { localStorage.setItem('nikui.app.laptop', JSON.stringify({host:'127.0.0.1:${server.address().port}',scheme:'http',name:'MacBook Pro',pairedAt:Date.now()-86400000})); if (location.pathname === '/connect.html') localStorage.removeItem('nikui.app.laptop'); } catch (_) {}
    `);
    const themes = process.argv.includes('--before') ? ['dark'] : ['dark', 'light'];
    const platforms = process.argv.includes('--before') ? ['ios'] : ['ios', 'android'];
    const measures = [];
    for (const platform of platforms) for (const theme of themes) {
      await phone.prefers({ 'prefers-color-scheme': theme, 'prefers-reduced-motion': 'reduce' });
      for (const name of ['instances', 'codex', 'claude', 'status', 'history', 'settings', 'terminal', 'connect']) {
        const page = ({instances:'index', history:'index', codex:'conversation', claude:'conversation'})[name] || name;
        await phone.navigate(origin + '/' + page + '.html' + (page === 'conversation' ? '?session=' + (name === 'codex' ? 'cx-mobile' : 'cl-design') : name === 'history' ? '?scope=earlier' : name === 'instances' ? '?scope=active' : ''));
        if (platform === 'ios' && theme === 'dark' && name === 'instances' && !process.argv.includes('--before')) {
          await check('Chats shows loading rows before the laptop replies', `document.querySelectorAll('.row-skeleton').length>0`);
          await phone.shot(path.join(OUT, 'instances-loading.png'));
        }
        await phone.evaluate(`(() => {
          const h = document.documentElement; h.classList.remove('plat-web'); h.classList.add('plat-${platform}');
          h.style.setProperty('--app-top','${platform === 'ios' ? 59 : 24}px'); h.style.setProperty('--app-bottom','${platform === 'ios' ? 34 : 24}px');
          window.postMessage({type:'@welcome',device:{control:true},version:'0.2.10'},'*');
          window.postMessage(__fixtures.fleet,'*');
          ${page === 'conversation' ? `window.postMessage(__fixtures.${name},'*');` : ''}
        })()`);
        await wait(250);

        await wait(100);
        const m = await phone.evaluate(`(() => {
          const vw=innerWidth;
          const wide=[...document.querySelectorAll('body *')].filter(e=>{
            if(e.closest('.tabs,.sheet-nav,.conversation-tools,.agent-actions')||e.ownerSVGElement) return false;
            const r=e.getBoundingClientRect(); return r.width>0&&(r.left < -1||r.right>vw+1);
          }).slice(0,5).map(e=>e.tagName+'.'+e.className);
          const palette=getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim();
          const chat=document.body.classList.contains('app-conversation') ? {
            header:document.querySelector('body > header').getBoundingClientRect().height,
            footer:document.querySelector('.work-main > footer').getBoundingClientRect().height,
            transcript:document.getElementById('transcript').getBoundingClientRect().height,
            small:[...document.querySelectorAll('body *')].filter(e=>e.children.length===0 && e.textContent.trim() && e.getBoundingClientRect().width>0 && parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.className),
            smallTargets:[...document.querySelectorAll('header a[href], header button, .composer button, #input, .mac-bar button, .goal-bar button, .perm .actions button, .tool summary, .copy, .run-it')].filter(e=>{
              const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && (r.width<44 || r.height<44);
            }).map(e=>e.id || e.className)
          } : null;
          return {name:'${name}',theme:'${theme}',platform:'${platform}',palette,wide,chat,errors:__errors};
        })()`);
        measures.push(m);
        if (m.wide.length || m.errors.length) failed = true;
        if (!process.argv.includes('--before') && m.chat) {
          await check('readable text and 44px controls: ' + platform + ' ' + theme + ' ' + name, `${!m.chat.small.length && !m.chat.smallTargets.length}`);
          if (m.chat.small.length || m.chat.smallTargets.length) console.log(JSON.stringify(m.chat));
          await check('the transcript has most of the phone: ' + platform + ' ' + theme + ' ' + name, `${m.chat.transcript > 852 / 2}`);
        }
        if (!process.argv.includes('--before') && m.palette !== (theme === 'light' ? '#f3f5f3' : '#000000')) { failed = true; console.log('FAIL  palette does not follow ' + theme); }
        if (!process.argv.includes('--before')) {
          await check('readable foreground and secondary contrast: ' + platform + ' ' + theme + ' ' + name, `(()=>{const s=getComputedStyle(document.documentElement), bg=s.getPropertyValue('--app-bg').trim(); return __contrast(s.getPropertyValue('--app-text').trim(),bg)>=4.5 && __contrast(s.getPropertyValue('--app-dim').trim(),bg)>=4.5})()`);
          if (name==='instances') await check('working is yellow, finished green once opened and blue until then: ' + platform + ' ' + theme, `(()=>{const v=(n)=>{const e=document.createElement('i');e.style.color='var(--app-'+n+')';document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c};const dot=(id)=>getComputedStyle(document.querySelector('.row[data-instance="'+id+'"] .sdot')).backgroundColor;return dot('cx-mobile')===v('yellow')&&dot('cl-read')===v('green')&&dot('cl-tests')===v('blue')&&v('yellow')!==v('green')&&v('blue')!==v('green')})()`);
          if (name==='instances') await check('seven visible chats: ' + platform + ' ' + theme, `(()=>{const bottom=Math.min(document.querySelector('.tabs').getBoundingClientRect().top,document.getElementById('create').getBoundingClientRect().top);return [...document.querySelectorAll('.row')].filter(r=>r.getBoundingClientRect().bottom<=bottom).length>=7})()`);
          if (name==='settings') await check('Settings values fit in full: ' + platform + ' ' + theme, `[...document.querySelectorAll('.settings-main .row-value > span')].every(e=>e.scrollWidth<=e.clientWidth+1)`);
        }
        const file = path.join(OUT, `${platform}-${theme}-${name}.png`);
        await phone.shot(file);
        console.log(path.basename(file), JSON.stringify({wide:m.wide,errors:m.errors}));
        if (!process.argv.includes('--before') && platform === 'ios' && theme === 'dark' && name === 'instances') {
          await check('four tabs, with History in Chats and Slack in Settings', `document.querySelectorAll('.tabs .tab').length === 4 && !document.querySelector('.tabs').textContent.includes('Slack')`);
          await check('both providers share the initial list', `document.querySelectorAll('.row[data-provider="claude"]').length === 9 && document.querySelectorAll('.row[data-provider="codex"]').length === 2`);
          await check('the blocked conversation comes first', `document.querySelector('.rows .row').dataset.instance === 'cl-design'`);
          await check('at least seven conversations fit before New chat', `(()=>{const bottom=document.getElementById('create').getBoundingClientRect().top;return [...document.querySelectorAll('.rows .row')].filter(r=>r.getBoundingClientRect().bottom<=bottom).length>=7})()`);
          await check('the list starts within 120px below the title bar', `document.querySelector('.rows .row').getBoundingClientRect().top-document.querySelector('.bar').getBoundingClientRect().bottom<=120`);
          await phone.evaluate(`document.querySelector('.chat-filters').open=true; document.querySelector('[data-ws="codex"]').click()`);
          await check('the provider filter keeps only Codex', `document.querySelectorAll('.rows .row').length === 2 && [...document.querySelectorAll('.rows .row')].every(r=>r.dataset.provider === 'codex')`);
          await phone.evaluate(`document.querySelector('[data-ws="all"]').click(); var f=document.querySelector('.fleet-search'); f.value='no-such-conversation'; f.dispatchEvent(new Event('input'));`);
          await check('an empty search explains the result', `!!document.querySelector('.empty-state') && document.querySelector('.empty-state').textContent.includes('matching')`);
          await phone.evaluate(`var f=document.querySelector('.fleet-search'); f.value=''; f.dispatchEvent(new Event('input')); document.querySelector('.chat-filters').open=false; document.querySelector('[data-scope="earlier"]').click()`);
          await check('Earlier merges both providers without duplicate conversations', `document.querySelectorAll('.rows .row').length===5 && new Set([...document.querySelectorAll('.row')].map(r=>r.dataset.instance)).size===5`);
          await phone.evaluate(`document.querySelector('[data-scope="active"]').click(); var f=document.querySelector('.fleet-search'); f.value='release'; f.dispatchEvent(new Event('input'))`);
          await check('search covers active and earlier conversations together', `document.querySelectorAll('.row').length===2 && !!document.querySelector('[data-instance="past:older-claude"]') && !!document.querySelector('[data-instance="cl-extra-2"]')`);
          await phone.evaluate(`var f=document.querySelector('.fleet-search'); f.value=''; f.dispatchEvent(new Event('input'))`);
          await phone.evaluate(`document.querySelector('.chat-filters').open=true; document.getElementById('edit').click()`);
          await phone.evaluate(`(()=>{const row=document.querySelector('[data-instance="cl-design"]'), handle=row.querySelector('.row-handle'), r=handle.getBoundingClientRect(); row.setPointerCapture=()=>{}; const event={bubbles:true,pointerType:'touch',pointerId:9,clientX:r.left+4,clientY:r.top+4}; handle.dispatchEvent(new PointerEvent('pointerdown',event)); handle.dispatchEvent(new PointerEvent('pointerup',event)); row.click()})()`);
          await check('ending a drag does not also open the tap-to-move sheet', `!document.querySelector('.app-sheet-backdrop:not([hidden])')`);
          await wait(420);
          await phone.evaluate(`document.querySelector('[data-instance="cl-design"]').click()`);
          await check('Organize offers a tap alternative to dragging', `document.querySelector('.app-sheet-backdrop:not([hidden]) h2').textContent==='Move conversation'`);
          await phone.evaluate(`[...document.querySelectorAll('.agent-option')].find(b=>b.textContent==='Phone work').click(); var placed=__sent.findLast(m=>m.type==='instance:place'); window.postMessage({type:'instance:placed',id:placed.id},'*')`); await wait(30);
          await check('tap-to-move keeps the instance and folder IDs and restores focus', `__sent.some(m=>m.type==='instance:place'&&m.instance==='cl-design'&&m.folderId==='phone') && document.activeElement.dataset.instance==='cl-design'`);
          await phone.evaluate(`document.getElementById('edit').click(); var picker=document.querySelector('.fleet-sort'); picker.value='attention'; picker.dispatchEvent(new Event('change'))`);
          await phone.evaluate(`document.getElementById('create').click()`); await wait(100);
          await phone.shot(path.join(OUT, 'new-conversation.png'));
          await phone.evaluate(`document.querySelector('[data-provider="codex"].chip').click(); document.querySelector('.create-row').click()`);
          await check('starting Codex sends the selected project and provider', `__sent.some(m=>m.type==='instance:new'&&m.provider==='codex'&&m.cwd==='/Users/nik/Codes/NikUI')`);
          await phone.evaluate(`const m=__sent.findLast(m=>m.type==='instance:new'); window.postMessage({type:'@refused',id:m.id,reason:'Laptop is reconnecting. Try again.'},'*')`);
          await wait(50);
          await check('a refused start leaves the project usable and explains why', `!document.querySelector('.create-row').classList.contains('busy') && document.getElementById('createNote').textContent.includes('reconnecting')`);
          await phone.shot(path.join(OUT, 'new-conversation-error.png'));
          await phone.evaluate(`window.__sheetBack=(window.NikBack||[]).some(close=>close())`);
          await check('New chat dismisses on Android Back and restores focus', `__sheetBack && document.querySelector('.app-sheet-backdrop').hidden && document.activeElement.id==='create'`);
          await tap('#create');
          await check('New chat remembers the selected provider', `document.querySelector('.create-providers .on').dataset.provider==='codex'`);
          await phone.evaluate(`document.querySelector('.create-providers [data-provider="claude"]').click(); document.querySelector('.create-group').open=true; document.querySelector('[data-folder="phone"]').click(); document.querySelector('.create-row').click(); var retryStart=__sent.findLast(m=>m.type==='instance:new'); window.postMessage({type:'@refused',id:retryStart.id,reason:'Try once more.'},'*')`); await wait(30);
          await check('refused creation preserves the provider and organizing group', `__sent.some(m=>m.type==='instance:new'&&m.folderId==='phone') && document.querySelector('.create-providers .on').dataset.provider==='claude' && document.querySelector('[data-folder="phone"]').classList.contains('on')`);
          await phone.evaluate(`document.querySelector('.app-sheet-backdrop:not([hidden]) .sheet-close').click()`);
          await phone.evaluate(`window.__offline=true`); await wait(2200);
          await check('cached Chats visibly says it is stale and offers Retry', `document.body.classList.contains('stale') && !document.getElementById('lede').hidden && document.getElementById('create').getBoundingClientRect().height===0 && document.getElementById('retry').getBoundingClientRect().bottom<=document.querySelector('.tabs').getBoundingClientRect().top`);
          await phone.shot(path.join(OUT, 'instances-stale.png')); await tap('#retry');
          await check('Retry asks the transport to reconnect', `__retries>0`);
          await phone.evaluate(`window.__offline=false; window.postMessage({type:'fleet',instances:[],codex:[],projects:[],folders:[],codexState:{loaded:true}},'*')`); await wait(30);
          await phone.shot(path.join(OUT, 'instances-empty.png'));
        }
        if (!process.argv.includes('--before') && platform === 'ios' && theme === 'dark' && name === 'codex') {
          const tools = () => tap('[data-agent="more"]');
          const option = (label) => phone.evaluate(`(()=>{const b=[...document.querySelectorAll('.agent-dialog .agent-option')].find(b=>b.textContent.startsWith(${JSON.stringify(label)})); if(!b) throw Error('Missing tool: '+${JSON.stringify(label)}); b.click()})()`);
          await check('one labelled Tools button shares the composer row', `document.querySelector('.composer-actions').contains(document.getElementById('conversation-tools')) && document.querySelectorAll('#conversation-tools button').length===1 && document.querySelector('.agent-label').textContent==='Plan' && document.querySelector('.composer').getBoundingClientRect().height<=104`);
          await check('there is one visible Stop while working and Queue remains available', `document.querySelector('.mac-stop').getBoundingClientRect().height===44 && document.getElementById('stop').getBoundingClientRect().height===0 && document.getElementById('send').textContent.trim()==='Queue'`);
          await tools(); await option('Plan ·');
          await tap('.goal-chip'); await option('Pause goal'); await tap('.mac-stop');
          await check('plan, goal pause, and Mac stop use the real protocol', `__sent.some(m=>m.text==='/plan off') && __sent.some(m=>m.text==='/goal pause') && __sent.some(m=>m.type==='interrupt')`);
          await phone.evaluate(`document.getElementById('input').value='Keep my half-written prompt'`);
          await tools(); await option('Model ·');
          await phone.shot(path.join(OUT, 'model-picker.png'));
          await option('GPT-5.5');
          await check('the model picker preserves the draft', `document.getElementById('input').value==='Keep my half-written prompt' && __sent.some(m=>m.text==='/model gpt-5.5')`);
          await tools(); await option('Goal ·');
          await phone.evaluate(`const field=document.querySelector('.agent-dialog input'); field.value='Finish the mobile redesign'; document.querySelector('.agent-dialog form').requestSubmit()`);
          await check('a goal can be set without slash typing', `__sent.some(m=>m.text==='/goal Finish the mobile redesign')`);
          await tools(); await option('Goal ·'); await option('Clear goal');
          await check('clearing a goal is a tap action', `__sent.some(m=>m.text==='/goal clear')`);
          await tools(); await phone.shot(path.join(OUT, 'conversation-tools.png'));
          await check('review and undo wait for an active turn to finish', `[...document.querySelectorAll('.agent-option')].filter(b=>/Review|Undo/.test(b.textContent)).every(b=>b.disabled)`);
          await option('Reasoning effort ·'); await option('high');
          await check('effort is selected by tap', `__sent.some(m=>m.text==='/effort high')`);
          await tools(); await option('Steer the current turn');
          await check('Steer is clearly labelled before sending', `document.getElementById('send').textContent.trim()==='Steer'`);
          await tap('#send');
          await check('steering sends the draft to the current turn', `__sent.some(m=>m.text==='/steer Keep my half-written prompt') && !document.body.classList.contains('steering')`);
          await phone.evaluate(`window.postMessage({type:'meta',meta:{...__fixtures.codex.meta,goal:{objective:'A paused goal',status:'paused'}}},'*'); window.postMessage({type:'status',status:'idle'},'*')`); await wait(30);
          await check('Stop disappears when work ends', `document.querySelector('.mac-bar').getBoundingClientRect().height===0 && document.getElementById('send').textContent.trim()==='Send'`);
          await tap('.goal-chip'); await option('Resume goal'); await tools(); await option('Fork conversation');
          await check('a paused goal resumes and a chat forks by tap', `__sent.some(m=>m.text==='/goal resume') && __sent.some(m=>m.text==='/fork')`);
          await tools(); await option('Undo last turn…');
          await check('undo explains the effect before sending', `!__sent.some(m=>m.text==='/undo') && document.querySelector('.agent-dialog-note').textContent.includes('Files')`);
          await option('Undo last turn');
          await check('confirming undo sends the command', `__sent.some(m=>m.text==='/undo')`);
          await tools(); await phone.evaluate(`window.__backClosed=(window.NikBack||[]).some(close=>close())`);
          await check('Android Back dismisses tools and restores focus', `__backClosed && !document.querySelector('.agent-dialog').open && document.activeElement.dataset.agent==='more'`);
          await phone.evaluate(`document.getElementById('input').value=''; document.getElementById('input').dispatchEvent(new Event('input')); window.postMessage({type:'queue',queue:[{id:'q1',text:'First prompt'},{id:'q2',text:'Next prompt'}]},'*')`); await wait(30);
          await check('the queue collapses to one count', `document.querySelector('.queue-toggle').textContent.startsWith('2 queued') && !document.querySelector('#queue .queue-row')`);
          await tap('.queue-toggle'); await phone.shot(path.join(OUT, 'conversation-queue.png'));
          await tap('[data-promote="q2"]'); await tap('[data-edit="q1"]'); await tap('[data-unqueue="q2"]');
          await check('queue promotion, editing, and removal retain their IDs', `__sent.some(m=>m.type==='promoteQueued'&&m.id==='q2') && __sent.some(m=>m.type==='editQueued'&&m.id==='q1') && __sent.some(m=>m.type==='unqueue'&&m.id==='q2')`);
          await tap('[data-clear]'); await check('queue clearing asks before sending', `!__sent.some(m=>m.type==='clearQueue')`);
          await tap('[data-clear]'); await check('confirmed clearing sends the real action', `__sent.some(m=>m.type==='clearQueue')`);
          await phone.evaluate(`window.postMessage({type:'queue',queue:[]},'*'); window.postMessage({type:'@device',device:{control:false}},'*')`); await wait(30);
          await phone.evaluate(`window.__beforeWatch=__sent.length; document.querySelector('[data-agent="more"]').click(); document.querySelector('.mac-stop').click()`);
          await check('watching devices cannot use tap controls to steer', `__sent.length===__beforeWatch && getComputedStyle(document.querySelector('.mac-stop')).display==='none'`);
          await check('a watching Codex device has no sending controls', `document.querySelector('.composer').getBoundingClientRect().height===0`);
        }
        if (!process.argv.includes('--before') && platform === 'ios' && theme === 'dark' && name === 'claude') {
          await check('opening a phone conversation leaves the keyboard closed', `document.activeElement.id !== 'input'`);
          await check('the phone retains its text size when the laptop uses smaller type', `document.documentElement.style.getPropertyValue('--nik-font-size')==='16px'`);
          await phone.evaluate(`window.__copied=[]; window.__execCommand=document.execCommand; document.execCommand=(command)=>{if(command==='copy') __copied.push(document.activeElement.value); return true}; window.__messageHeight=document.querySelector('.turn-user').getBoundingClientRect().height`);
          await check('message actions stay quiet while reading', `getComputedStyle(document.querySelector('.turn-user .copy-all')).opacity==='0'`);
          await tap('.turn-user .said');
          await check('tapping a message reveals Copy without changing its height', `getComputedStyle(document.querySelector('.turn-user .copy-all')).opacity==='1' && getComputedStyle(document.querySelector('.sent-at')).opacity==='1' && document.querySelector('.turn-user').getBoundingClientRect().height===__messageHeight`);
          await phone.shot(path.join(OUT, 'conversation-message-actions.png'));
          await tap('.turn-user .copy-all');
          await check('the revealed action copies the user message', `__copied.some(text=>text.startsWith(__fixtures.claude.items[0].text))`);
          await tap('.msg-text p'); await tap('.msg-text .copy-all');
          await check('assistant text can also be copied by touch', `__copied.some(text=>text.includes('Your pairing key stays on this device.'))`);
          await phone.evaluate(`document.execCommand=__execCommand`);
          await phone.evaluate(`document.querySelector('[data-act="allow"]').click(); document.querySelector('[data-act="deny"]').click()`);
          await check('Claude permission decisions retain the request ID', `__sent.some(m=>m.type==='permission'&&m.requestId==='permission-fixture'&&m.allow===true)&&__sent.some(m=>m.type==='permission'&&m.allow===false)`);
          await tap('[data-agent="more"]');
          await phone.evaluate(`[...document.querySelectorAll('.agent-option')].find(b=>b.textContent.startsWith('Permissions ·')).click()`);
          await check('the Claude permission mode is available by tap', `document.querySelector('.agent-dialog-note').textContent.includes('asks before tools')`);
          await phone.evaluate(`document.querySelector('[data-close]').click(); window.postMessage({type:'@device',device:{control:false}},'*')`); await wait(30);
          await tap('[data-agent="more"]');
          await check('watching Claude keeps Status available and hides sending', `[...document.querySelectorAll('.agent-option')].some(b=>b.textContent==='Conversation status') && ['input','attach','stop','send'].every(id=>document.getElementById(id).getBoundingClientRect().height===0)`);
          await phone.evaluate(`document.querySelector('[data-close]').click(); window.postMessage({type:'@device',device:{control:true}},'*'); window.postMessage({type:'meta',meta:{...__fixtures.claude.meta,permissionMode:'bypassPermissions'}},'*')`); await wait(30);
          await check('bypassed permissions add no phone chip', `document.getElementById('permission-warning').hidden`);
          await phone.evaluate(`window.postMessage({type:'meta',meta:{...__fixtures.claude.meta,permissionMode:'acceptEdits'}},'*')`); await wait(30);
          await check('an unusual permission mode is visible', `!document.getElementById('permission-warning').hidden && document.getElementById('permission-warning').getBoundingClientRect().height>0`);
        }
        if (!process.argv.includes('--before') && platform === 'ios' && theme === 'dark' && name === 'status') {
          await check('General starts directly with workspace stats', `!!document.querySelector('.gen-stats') && !document.querySelector('.sheet-head') && !document.querySelector('.sheet-nav')`);
          await check('three conversations and limits fit on the first screen', `document.querySelectorAll('.fleet-conversation').length===3 && document.querySelector('.gen-limits').getBoundingClientRect().bottom<document.querySelector('.tabs').getBoundingClientRect().top`);
          await phone.shot(path.join(OUT, 'status-workspace.png'));
          await check('Status lists Claude and Codex with direct conversation actions', `document.querySelectorAll('.fleet-conversation').length===3 && !!document.querySelector('.fleet-conversation .gen-prov.codex')`);
          await phone.evaluate(`document.querySelector('.status-more').open=true; document.querySelector('.status-analytics').open=true`); await wait(30);
          await phone.evaluate(`window.postMessage({type:'status',available:true,report:__fixtures.report},'*')`); await wait(30);
          await check('Status retains expanded analytics during refresh', `document.querySelector('.status-more').open && document.querySelector('.status-analytics').open`);
          await phone.evaluate(`window.__offline=true`); await wait(2200);
          await check('Status marks stale numbers without collapsing details', `!document.querySelector('.status-notice').hidden && document.querySelector('.status-more').open && document.querySelector('.status-analytics').open`);
          await phone.shot(path.join(OUT, 'status-stale.png'));
          await phone.evaluate(`window.__offline=false; window.postMessage({type:'status',available:true,report:__fixtures.report},'*')`); await wait(30);
        }
        if (!process.argv.includes('--before') && platform === 'ios' && theme === 'dark' && name === 'history') {
          await phone.evaluate(`document.querySelector('.chat-filters').open=true; document.querySelector('[data-ws="codex"]').click()`);
          await check('Earlier filters by provider', `document.querySelectorAll('.row').length===2 && [...document.querySelectorAll('.row')].every(r=>r.dataset.provider==='codex')`);
          await check('Codex Earlier links directly to its own conversation', `[...document.querySelectorAll('.row')].every(r=>r.href.includes('conversation.html?session=cx-')) && !__sent.some(m=>m.type==='instance:resume')`);
          await phone.evaluate(`document.querySelector('[data-ws="claude"]').click(); document.querySelector('.row[data-instance="past:older-claude"]').click()`);
          await check('Claude Earlier resumes by transcript ID', `__sent.some(m=>m.type==='instance:resume'&&m.sessionId==='older-claude')`);
        }
        if (!process.argv.includes('--before') && platform === 'ios' && theme === 'dark' && name === 'settings') {
          await phone.evaluate(`NikApp.setPref('appearance','light')`);
          await check('light appearance is applied and remembered', `document.documentElement.dataset.theme==='light' && NikApp.prefs().appearance==='light'`);
          await check('all seven Settings rows fit without scrolling', `document.querySelectorAll('.settings-main .row').length===7 && document.querySelector('.settings-main').getBoundingClientRect().bottom<=document.querySelector('.tabs').getBoundingClientRect().top`);
          await phone.evaluate(`NikApp.setPref('appearance','system'); [...document.querySelectorAll('.settings-main .row')].find(r=>r.dataset.settingRow==='Security').click()`);
          await wait(50);
          await phone.evaluate(`window.postMessage({type:'@device',device:{control:true}},'*')`); await wait(50);
          await check('settings retains its sheet during live updates', `document.querySelector('.settings-sheet').getBoundingClientRect().height>0 && document.querySelector('.settings-sheet h2').textContent==='Security'`);
          await phone.evaluate(`window.__back=(window.NikBack||[]).some(close=>close())`);
          await check('Settings Back restores focus to its row', `__back && document.activeElement.dataset.settingRow==='Security'`);
          await check('Slack remains reachable in Settings', `[...document.querySelectorAll('.row')].some(r=>r.textContent.includes('Slack'))`);
        }
        if (!process.argv.includes('--before') && platform === 'ios' && theme === 'dark' && name === 'terminal') {
          await check('older successful terminal output is collapsed', `!!document.querySelector('.run-output') && !document.querySelector('.run-output').open`);
          await phone.evaluate(`document.querySelector('.run-output').open=true`); await wait(30);
          await phone.evaluate(`window.postMessage({type:'term:scrollback',terminal:__fixtures.terminal,runs:[...__fixtures.runs,{id:'failed',command:'false',output:'Command failed',done:true,exit:1}]},'*')`); await wait(30);
          await check('terminal refresh retains opened output and leaves failures visible', `document.querySelector('.run-output').open && document.querySelector('.run.bad .run-out').getBoundingClientRect().height>0`);
          await phone.shot(path.join(OUT, 'terminal-failure.png'));
          await check('the terminal runner clears the tab bar', `document.getElementById('runner').getBoundingClientRect().bottom <= document.getElementById('tabs').getBoundingClientRect().top+1`);
          await phone.evaluate(`document.querySelector('.run-again').click()`);
          await check('terminal commands can be repeated by tap', `__sent.some(m=>m.type==='term:run'&&m.id==='term-fixture')`);
          await phone.evaluate(`window.postMessage({type:'term:scrollback',terminal:__fixtures.terminal,runs:[]},'*')`); await wait(30);
          await phone.evaluate(`document.querySelector('.terminal-shortcuts button').click()`);
          await check('terminal shortcuts prepare an editable command', `document.getElementById('command').value==='git status --short'`);
          await phone.shot(path.join(OUT, 'terminal-empty.png'));
        }
        if (!process.argv.includes('--before') && platform === 'ios' && theme === 'dark' && name === 'connect') {
          await phone.evaluate(`document.getElementById('type-instead').click()`); await wait(30);
          await phone.shot(path.join(OUT, 'connect-manual.png'));
          await check('manual pairing is available without leaving Connect', `!document.getElementById('form').hidden && !!document.querySelector('#host') && !!document.querySelector('#code')`);
          await check('the pairing button has a full-width touch target', `document.getElementById('go').getBoundingClientRect().width > 250 && document.getElementById('go').getBoundingClientRect().height>=48`);
          await phone.evaluate(`document.getElementById('scan-instead').click()`);
          await check('manual pairing has a way back to camera instructions', `!document.getElementById('steps').hidden && document.getElementById('form').hidden`);
        }
      }
    }
    if (!process.argv.includes('--before')) {
      await phone.asScreen(1100, 820);
      for (const theme of ['dark', 'light']) for (const provider of ['claude', 'codex']) {
        await phone.prefers({ 'prefers-color-scheme': theme });
        await phone.navigate(origin + '/editor.html');
        await phone.evaluate(`window.postMessage(__fixtures.${provider},'*')`); await wait(60);
        await phone.shot(path.join(OUT, `editor-${theme}-${provider}.png`));
        await check('shared editor layout: ' + theme + ' ' + provider, `!__errors.length && document.querySelector('.composer').getBoundingClientRect().right <= innerWidth && document.querySelector('#conversation-provider').textContent==='${provider === 'codex' ? 'Codex' : 'Claude'}'`);
      }
      await phone.prefers({ 'prefers-color-scheme': 'dark' });
      for (const [width, height, name] of [[360,740,'small-phone'], [393,500,'keyboard']]) {
        await phone.asPhone(width, height);
        await phone.navigate(origin + '/conversation.html?session=cx-mobile');
        await phone.evaluate(`document.documentElement.classList.add('plat-android'); document.documentElement.style.setProperty('--app-top','24px'); window.postMessage(__fixtures.codex,'*')`); await wait(60);
        if (name === 'keyboard') {
          await phone.evaluate(`document.documentElement.classList.add('keyboard-open'); var field=document.getElementById('input'); field.value='Please keep the provider controls easy to reach.\\nI’m checking this with the keyboard open.\\nMake sure I can still read the latest reply.'; field.dispatchEvent(new Event('input'))`);
          await wait(180);
          await check('a written prompt keeps Send available and readable above the keyboard', `!document.getElementById('send').disabled && __contrast(getComputedStyle(document.getElementById('send')).color,getComputedStyle(document.getElementById('send')).backgroundColor)>=4.5`);
        }
        await phone.shot(path.join(OUT, name + '-codex.png'));
        await check('the composer stays usable on ' + name, `document.querySelector('#send').getBoundingClientRect().bottom <= innerHeight && document.querySelector('#transcript').getBoundingClientRect().height >= 160`);
        if (name === 'small-phone') {
          await phone.evaluate(`window.postMessage({type:'voice:state',available:true},'*')`); await wait(30);
          await phone.shot(path.join(OUT, 'small-phone-codex-voice.png'));
          await check('voice and stop leave the composer inside a small phone', `['mic','send'].every(id=>{const r=document.getElementById(id).getBoundingClientRect(); return r.width>=44 && r.height>=44 && r.left>=0 && r.right<=innerWidth})`);
          await tap('[data-agent="more"]'); await phone.evaluate(`[...document.querySelectorAll('.agent-option')].find(b=>b.textContent.startsWith('Model ·')).click()`);
          await wait(220);
          await phone.shot(path.join(OUT, 'small-phone-tools.png'));
          await check('the sheet remains within the phone', `(()=>{const r=document.querySelector('.app-sheet').getBoundingClientRect();return r.top>=23&&r.bottom<=innerHeight+1})()`);
          await check('the labelled Tools control opens its model picker', `document.querySelector('.agent-dialog').open && document.getElementById('agent-dialog-title').textContent==='Choose a model'`);
          await phone.evaluate(`document.querySelector('[data-close]').click()`);
        }
      }
      await phone.asPhone(393,852);
      await phone.navigate(origin + '/conversation.html?session=cl-design');
      await phone.evaluate(`window.__longReply=Array.from({length:24},(_,i)=>'Paragraph '+(i+1)+'. Keep the full reply easy to read, even when it takes several screens.').join('\\n\\n'); window.postMessage({...__fixtures.claude,items:[{id:'long-reply',kind:'text',text:__longReply}]},'*'); window.__copied=''; document.execCommand=()=>{__copied=document.activeElement.value; return true}`); await wait(60);
      await tap('.msg-text p:nth-child(14)');
      await check('Copy stays reachable in the middle of a long reply', `(() => {const r=document.querySelector('.msg-text .copy-all').getBoundingClientRect(),v=document.getElementById('transcript').getBoundingClientRect(); return r.top>=v.top && r.bottom<=v.bottom && !!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2).closest('.copy-all')})()`);
      await tap('.msg-text .copy-all');
      await check('copying mid-reply keeps its beginning and end', `__copied.includes('Paragraph 1.') && __copied.includes('Paragraph 24.')`);
      await phone.asPhone(393,852);
      const restoreChats = async () => {
        await phone.navigate(origin + '/index.html');
        await phone.evaluate(`window.postMessage({type:'@welcome',device:{control:true}},'*'); window.postMessage(__fixtures.fleet,'*')`); await wait(80);
      };
      await restoreChats();
      await phone.evaluate(`var f=document.querySelector('.fleet-search'); f.value='release'; f.dispatchEvent(new Event('input'))`); await wait(30);
      await phone.navigate(origin + '/terminal.html'); await restoreChats();
      await check('Chats remembers search across navigation', `document.querySelector('.fleet-search').value==='release' && document.querySelectorAll('.row').length===2`);
      await phone.evaluate(`var f=document.querySelector('.fleet-search'); f.value=''; f.dispatchEvent(new Event('input')); document.querySelector('[data-scope="active"]').click(); document.querySelector('.screen').scrollTop=120`);
      await phone.navigate(origin + '/terminal.html'); await restoreChats();
      await check('Chats remembers its list position across navigation', `document.querySelector('.screen').scrollTop>=100`);
      await phone.navigate(origin + '/settings.html?update');
      await check('no update, no card and no dot', `!document.querySelector('.update-card') && !document.querySelector('.tab.has-update')`);
      await phone.evaluate(`window.postMessage({type:'app:update',available:true,build:'b2',size:4938739,path:'/app/update.apk'},'*')`); await wait(60);
      await check('an update puts a red dot on Settings', `(([r,g,b]) => r-g>60 && r-b>60)(getComputedStyle(document.querySelector('.tab.has-update .tab-icon'),'::after').backgroundColor.match(/\\d+/g).map(Number))`);
      await check('and a card at the top with an Update button', `document.querySelector('.settings-main').firstElementChild.classList.contains('update-card') && document.querySelector('.update-card .update-button').textContent==='Update' && !document.querySelector('.update-button').disabled`);
      await check('the card fits the screen', `document.querySelector('.update-card').getBoundingClientRect().right<=innerWidth && document.documentElement.scrollWidth<=innerWidth`);
      await phone.shot(path.join(OUT, 'update-available.png'));
      await phone.evaluate(`__progress({state:'downloading',done:2000000,total:4938739})`); await wait(60);
      await check('while it downloads the button shows how far, and cannot be pressed twice', `document.querySelector('.update-button').textContent==='40%' && document.querySelector('.update-button').disabled`);
      await phone.shot(path.join(OUT, 'update-downloading.png'));
      await phone.evaluate(`window.postMessage({type:'app:update',available:false},'*'); __progress({state:'installed'})`); await wait(60);
      await check('once installed, the card and the dot are gone', `!document.querySelector('.update-card') && !document.querySelector('.tab.has-update')`);
      await phone.asPhone(360,740);
      await phone.navigate(origin + '/settings.html');
      await phone.evaluate(`NikApp.setPref('textSize','large'); document.documentElement.style.setProperty('--app-top','24px'); window.postMessage({type:'@welcome',device:{control:true}},'*')`); await wait(60);
      await phone.shot(path.join(OUT, 'large-text-settings.png'));
      await check('large text fits a small phone', `document.documentElement.scrollWidth <= innerWidth && document.documentElement.style.fontSize==='18.5px'`);
      await phone.asScreen(1572,1768);
      for (const platform of ['ios', 'android']) for (const theme of ['dark', 'light']) {
        await phone.navigate(origin + '/gallery.html?platform=' + platform + '&theme=' + theme);
        await phone.shot(path.join(OUT, platform + '-' + theme + '-overview.png'));
      }
    }
    fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify(measures, null, 2));
    console.log(checks + ' interaction checks; ' + measures.length + ' phone screenshots');
  } finally { phone.close(); server.close(); }
  if (failed && !process.argv.includes('--before')) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { fixtures, conversation };
