'use strict';
const { EventEmitter } = require('events');
const { PrLinks, prUrlIn } = require('../src/prlink.js');
const { focusOpenTab, script } = require('../src/browserTab.js');

function fakeSession(fields) {
  return Object.assign(new EventEmitter(), { cwd: '/repo', ticket: null, prUrl: null, ci: null }, fields);
}

module.exports = async function () {
  suite('the title opens the PR');
  checkEqual('a pull URL in the prompt is the one', prUrlIn('fix https://github.com/o/r/pull/1046/files please', '1046'), 'https://github.com/o/r/pull/1046');
  checkEqual('not one for another ticket', prUrlIn('like https://github.com/o/r/pull/9', '1046'), null);

  {
    const calls = [];
    const links = new PrLinks({ run: async (file, args, opts) => {
      calls.push([file, ...args, opts.cwd]);
      return args[2] === '1046' ? { ok: true, stdout: '{"url":"https://github.com/o/r/pull/1046"}' } : { ok: false, stdout: '' };
    } });
    const s = fakeSession({ ticket: '1046' });
    let metas = 0;
    s.on('meta', () => metas++);
    await links.link(s);
    checkEqual('asks GitHub for the ticket’s PR, in its folder', calls[0], ['gh', 'pr', 'view', '1046', '--json', 'url', '/repo']);
    checkEqual('and links it', [s.prUrl, metas], ['https://github.com/o/r/pull/1046', 1]);
    const t = fakeSession({ ticket: '1046' });
    links.link(t);
    checkEqual('another instance on it does not ask again', [calls.length, t.prUrl], [1, 'https://github.com/o/r/pull/1046']);

    s.ticket = '77';
    await links.link(s);
    checkEqual('a ticket with no PR has no link', s.prUrl, null);
    await links.link(s);
    checkEqual('and is not asked about again right away', calls.length, 2);

    const c = fakeSession({ ci: { pr: { url: 'https://github.com/o/r/pull/5' } } });
    links.link(c);
    checkEqual('the CI watch’s PR needs no asking', [c.prUrl, calls.length], ['https://github.com/o/r/pull/5', 2]);
  }

  {
    const manager = new EventEmitter();
    manager.list = [];
    const calls = [];
    const links = new PrLinks({ run: async (f, args) => { calls.push(args); return { ok: true, stdout: '{"url":"https://github.com/o/r/pull/3"}' }; } });
    const detach = links.attach(manager);
    const s = fakeSession({});
    manager.emit('session-changed', s);
    await new Promise((r) => setTimeout(r, 5));
    checkEqual('with no ticket, the branch’s PR', [calls[0], s.prUrl], [['pr', 'view', '--json', 'url'], 'https://github.com/o/r/pull/3']);
    detach();
  }


  suite('a PR already open in the browser');
  {
    const asked = [];
    const run = async (file, args) => { asked.push(args); return args[2].endsWith('/1210') ? 'found' : 'none'; };
    const brave = async () => 'com.brave.browser';
    check('its tab is brought forward', await focusOpenTab('https://github.com/o/r/pull/1210/', { platform: 'darwin', defaultBrowser: brave, run }));
    checkEqual('asked about the URL as an argument, not inside the script', [asked[0][2], asked[0][1].includes('github')], ['https://github.com/o/r/pull/1210', false]);
    check('no tab: the caller opens one', !(await focusOpenTab('https://github.com/o/r/pull/9', { platform: 'darwin', defaultBrowser: brave, run })));
    check('a browser it cannot ask is not asked', !(await focusOpenTab('https://x/pull/1', { platform: 'darwin', defaultBrowser: async () => 'org.mozilla.firefox', run })) && asked.length === 2);
    check('nor off a Mac', !(await focusOpenTab('https://x/pull/1', { platform: 'linux', defaultBrowser: brave, run })));
    check('Chromium switches tabs its way', script('com.brave.browser').includes('active tab index'));
    check('Safari its own', script('com.apple.safari').includes('current tab of w'));
  }

};
