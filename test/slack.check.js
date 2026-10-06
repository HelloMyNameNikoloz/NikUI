#!/usr/bin/env node
'use strict';

// Drives media/slack.js the way the editor webview drives it: a fake
// acquireVsCodeApi, icons.js and slack.js loaded for real, messages posted in
// and read back out. The offline suite has nothing like a DOM to check this
// against; only a real browser can say whether the list renders, the thread
// groups, and a hostile conversation title stays text.
//
//   node test/slack.check.js
//
// Needs a Chrome binary. Skips (exit 0) when there is none, so it never turns
// a clean checkout red — set CHROME=/path/to/chrome.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { findChrome, launch } = require('./helpers/chrome.js');
const { skipped } = require('./helpers/skip.js');

const ROOT = path.join(__dirname, '..');

const chrome = findChrome();
if (!chrome) {
  skipped('No Chrome found — the Slack check did not run. Set CHROME=/path/to/chrome.');
}

const ICONS = 'file://' + path.join(ROOT, 'media', 'icons.js');
const SLACK_JS = 'file://' + path.join(ROOT, 'media', 'slack.js');
const SLACK_CSS = 'file://' + path.join(ROOT, 'media', 'slack.css');

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html, body { height: 100%; margin: 0; } #slack-root { height: 100%; }</style>
<link rel="stylesheet" href="${SLACK_CSS}">
</head>
<body>
<div id="slack-root"></div>
<script>
  window.__posted = [];
  window.__errors = [];
  window.onerror = function (m) { window.__errors.push(String(m)); };
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) { window.__posted.push(m); },
      setState: function () {},
      getState: function () { return null; }
    };
  };
</script>
<script src="${ICONS}"></script>
<script src="${SLACK_JS}"></script>
</body></html>`;

const page = path.join(os.tmpdir(), 'nikui-slack-check.html');
fs.writeFileSync(page, html);

const NOW = Date.now();

const BASE_STATE = {
  enabled: true, hasTokens: true, connected: true, socket: 'live', error: null,
  me: { id: 'U_ME', name: 'Me' },
  unresolved: ['nobody@nowhere.test'],
  vips: [{ id: 'U_ANNA', name: 'Anna', initials: 'A' }],
  vipList: ['Anna', 'nobody@nowhere.test'],
  conversations: [
    {
      id: 'c-anna', kind: 'dm', title: 'Anna', with: { id: 'U_ANNA', name: 'Anna', initials: 'A' },
      vip: true, pending: true, pendingSince: NOW - 2 * 60000, lastAt: NOW - 60000,
      last: { text: 'are you around?', from: 'U_ANNA', ts: '1' }
    },
    {
      id: 'c-xss', kind: 'dm', title: '<img src=x onerror=alert(1)>', with: null,
      vip: false, pending: false, pendingSince: null, lastAt: NOW - 5 * 3600000,
      last: { text: 'hello <script>', from: 'U_X', ts: '2' }
    },
    {
      id: 'c-team', kind: 'channel', title: 'team-chat', with: null,
      vip: false, pending: false, pendingSince: null, lastAt: NOW - 30 * 60000,
      last: { text: 'ship it', from: 'U_Y', ts: '3' }
    }
  ],
  mayReply: true, mayEdit: true, local: true, clock: '24h',
  setupUrl: 'https://slack.com/apps/new'
};

const THREAD_ANNA = {
  conversation: BASE_STATE.conversations[0],
  thread: null,
  messages: [
    { ts: '1', user: 'U_ANNA', name: 'Anna', initials: 'A', mine: false,
      html: 'Hey, are you <strong>around</strong>?', at: NOW - 4 * 60000 },
    { ts: '2', user: 'U_ANNA', name: 'Anna', initials: 'A', mine: false,
      html: 'got a minute?', at: NOW - 3 * 60000 },
    { ts: '3', user: 'U_ME', name: 'Me', initials: 'M', mine: true,
      html: 'sure, give me a sec', at: NOW - 60000 }
  ]
};

(async () => {
  const out = {};
  const browser = await launch(chrome);
  try {
    await browser.asScreen(1100, 720);
    await browser.navigate('file://' + page);
    await browser.until('window.__posted.length > 0', 4000);

    const posted = async () => browser.evaluate('window.__posted');
    const post = async (message) => browser.evaluate(
      `(function(){ window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} })); return true; })()`
    );
    const click = async (selector) => browser.evaluate(
      `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`
    );
    const text = async (selector) => browser.evaluate(
      `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); return e ? e.textContent : null; })()`
    );
    const exists = async (selector) => browser.evaluate(
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    const count = async (selector) => browser.evaluate(
      `document.querySelectorAll(${JSON.stringify(selector)}).length`
    );

    // ---- ready --------------------------------------------------------
    const firstPosted = await posted();
    out.sentReady = firstPosted.some((m) => m.type === 'slack:ready');

    // ---- setup card (no tokens yet) ------------------------------------
    await post({ type: 'slack:state', state: Object.assign({}, BASE_STATE, { hasTokens: false }) });
    out.setupCardShown = /Connect Slack/.test(await text('.ns-card h2') || '');
    out.setupExplains = /@mention you/.test(await text('.ns-card p') || '');

    // ---- disabled card --------------------------------------------------
    await post({ type: 'slack:state', state: Object.assign({}, BASE_STATE, { enabled: false }) });
    out.disabledCardShown = /off/.test(await text('.ns-card h2') || '');

    // ---- the real list ---------------------------------------------------
    await post({ type: 'slack:state', state: BASE_STATE });
    out.rowCount = await count('.ns-row');
    out.pendingFirst = (await browser.evaluate(
      "document.querySelector('.ns-row').closest('li').querySelector('.ns-title').textContent"
    ));
    out.pendingPill = await text('.ns-row .ns-pending');
    out.xssTitleIsText = await text('.ns-row[data-id="c-xss"] .ns-title');
    out.xssNoImgTag = !(await exists('.ns-rows img'));

    // ---- opening a conversation ------------------------------------------
    await browser.evaluate("window.__posted.length = 0; true");
    await click('.ns-row[data-id="c-anna"]');
    const afterOpen = await posted();
    const openMsg = afterOpen.find((m) => m.type === 'slack:open');
    out.openSentConversation = openMsg && openMsg.conversation;

    // ---- thread: loading, then rendered with grouping --------------------
    out.loadingShown = /Loading/.test(await text('.ns-messages') || '');
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages });
    out.groupCount = await count('.ns-group');
    out.firstGroupHasOneName = await browser.evaluate(
      "document.querySelectorAll('.ns-group')[0].querySelectorAll('.ns-msg-head').length"
    );
    out.messagesInFirstGroup = await browser.evaluate(
      "document.querySelectorAll('.ns-group')[0].querySelectorAll('.ns-msg').length"
    );
    out.boldRendered = await exists('.ns-msg strong');
    out.mineAlignedRight = await exists('.ns-group.mine');

    // ---- reply: Enter sends, ok clears -----------------------------------
    await browser.evaluate(
      `(function(){
        var ta = document.querySelector('.ns-input');
        ta.value = 'on my way';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      })()`
    );
    const afterReply = await posted();
    const replyMsg = afterReply.slice().reverse().find((m) => m.type === 'slack:reply');
    out.replySent = replyMsg && replyMsg.text;
    out.replyConversation = replyMsg && replyMsg.conversation;
    await post({ type: 'slack:sent', id: replyMsg.id, ok: true });
    out.inputClearedOnOk = (await browser.evaluate("document.querySelector('.ns-input').value")) === '';

    // ---- reply: failure keeps the text ------------------------------------
    await browser.evaluate(
      `(function(){
        var ta = document.querySelector('.ns-input');
        ta.value = 'retry this';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      })()`
    );
    const afterReply2 = await posted();
    const replyMsg2 = afterReply2.slice().reverse().find((m) => m.type === 'slack:reply');
    await post({ type: 'slack:sent', id: replyMsg2.id, ok: false, reason: 'rate limited' });
    out.inputKeptOnFailure = (await browser.evaluate("document.querySelector('.ns-input').value")) === 'retry this';
    out.failureReasonShown = /rate limited/.test(await text('.ns-send-error') || '');

    // ---- focus banner -----------------------------------------------------
    await browser.evaluate("window.__posted.length = 0; true");
    await click('.ns-row[data-id="c-team"]');
    await post({
      type: 'slack:thread',
      conversation: BASE_STATE.conversations[2], thread: null,
      messages: [{ ts: '9', user: 'U_Y', name: 'Yuki', initials: 'Y', mine: false, html: 'ship it', at: NOW - 30 * 60000 }]
    });
    await post({ type: 'slack:focus', conversation: 'c-anna', reason: 'popup' });
    out.focusSelected = (await posted()).some((m) => m.type === 'slack:open' && m.conversation === 'c-anna');
    out.bannerShowsWaiting = /waiting/i.test(await text('.ns-banner') || '');
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages });

    // ---- VIP sheet: add and remove -----------------------------------------
    await click('.ns-vipbtn');
    out.vipSheetOpen = !(await browser.evaluate("document.querySelector('.ns-vip-sheet').hidden"));
    out.vipUnresolvedWarned = /Not found in Slack/.test(await text('.ns-vip-chip.unresolved') || '');
    await browser.evaluate("window.__posted.length = 0; true");
    await browser.evaluate(
      `(function(){
        var input = document.querySelector('.ns-vip-add input');
        input.value = 'Theo';
        document.querySelector('.ns-vip-add').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()`
    );
    const afterAdd = await posted();
    const addMsg = afterAdd.slice().reverse().find((m) => m.type === 'slack:vips');
    out.vipAdded = addMsg && addMsg.vips.includes('Theo');
    await post({ type: 'slack:state', state: Object.assign({}, BASE_STATE, { vipList: BASE_STATE.vipList.concat(['Theo']) }) });
    await browser.evaluate("window.__posted.length = 0; true");
    await click('.ns-vip-chip:first-child button');
    const afterRemove = await posted();
    const removeMsg = afterRemove.slice().reverse().find((m) => m.type === 'slack:vips');
    out.vipRemoved = removeMsg && !removeMsg.vips.includes('Anna');

    // ---- mayReply: false hides the composer --------------------------------
    await post({ type: 'slack:state', state: Object.assign({}, BASE_STATE, { mayReply: false }) });
    out.composerHiddenWhenLocked = !(await exists('.ns-input'));
    out.lockedMessageShown = /watch/.test(await text('.ns-locked') || '');
    await post({ type: 'slack:state', state: BASE_STATE });

    out.errorsWide = (await browser.evaluate('window.__errors')).length;
    await browser.shot('/tmp/slack-wide.png');

    // A second shot with the VIP sheet closed, so the thread itself is judged
    // on its own rather than behind an overlay.
    await click('.ns-vip-close');
    await browser.shot('/tmp/slack-wide-thread.png');
  } finally {
    browser.close();
  }

  // ---- narrow: one pane, navigation ---------------------------------------
  // The viewport override only reliably takes effect set before the page
  // loads, so a phone width gets a browser of its own — the same approach
  // test/remote.check.js takes for its own phone-width pass.
  const phone = await launch(chrome);
  try {
    await phone.asPhone(390, 844);
    await phone.navigate('file://' + page);
    await phone.until('window.__posted.length > 0', 4000);

    const ppost = async (message) => phone.evaluate(
      `(function(){ window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} })); return true; })()`
    );
    const pclick = async (selector) => phone.evaluate(
      `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`
    );

    const noOverflow = () => phone.evaluate(
      'document.scrollingElement.scrollWidth <= window.innerWidth'
    );

    await ppost({ type: 'slack:state', state: BASE_STATE });
    out.narrowIsCompact = await phone.evaluate("document.querySelector('.nik-slack').classList.contains('compact')");
    out.narrowStartsOnList = !(await phone.evaluate("document.querySelector('.nik-slack').classList.contains('show-thread')"));
    out.narrowListNoOverflow = await noOverflow();
    await phone.shot('/tmp/slack-narrow-list.png');

    await pclick('.ns-row[data-id="c-anna"]');
    out.narrowOpensThread = await phone.evaluate("document.querySelector('.nik-slack').classList.contains('show-thread')");
    await ppost({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages });
    out.narrowThreadNoOverflow = await noOverflow();
    // The slide-in is a 0.18s CSS transition — wait for it to settle so the
    // screenshot shows the thread in place, not mid-slide.
    await phone.until("document.querySelector('.ns-thread').getBoundingClientRect().left === 0", 1000);
    await phone.shot('/tmp/slack-narrow-thread.png');

    await pclick('.ns-thread-back');
    out.narrowBackReturnsToList = !(await phone.evaluate("document.querySelector('.nik-slack').classList.contains('show-thread')"));
    out.errorsNarrow = (await phone.evaluate('window.__errors')).length;
  } finally {
    phone.close();
  }

  const checks = [
    ['slack:ready is posted once mounted', out.sentReady === true],
    ['no tokens shows the setup card', out.setupCardShown === true],
    ['which explains what this does', out.setupExplains === true],
    ['disabled-but-connected shows its own card', out.disabledCardShown === true],
    ['every conversation gets a row', out.rowCount === 3],
    ['a pending conversation sorts first', out.pendingFirst === 'Anna'],
    ['it carries a waiting pill', /waiting/.test(out.pendingPill || '')],
    ['a hostile title renders as text', out.xssTitleIsText === '<img src=x onerror=alert(1)>'],
    ['and never becomes an element', out.xssNoImgTag === true],
    ['opening a conversation tells the laptop', out.openSentConversation === 'c-anna'],
    ['the thread shows a loading state first', out.loadingShown === true],
    ['messages arrive grouped', out.groupCount === 2],
    ['one name heads the first group', out.firstGroupHasOneName === 1],
    ['both of that sender’s messages are under it', out.messagesInFirstGroup === 2],
    ['message html is trusted and rendered', out.boldRendered === true],
    ['your own messages are told apart', out.mineAlignedRight === true],
    ['Enter sends the reply', out.replySent === 'on my way'],
    ['to the open conversation', out.replyConversation === 'c-anna'],
    ['a successful send clears the composer', out.inputClearedOnOk === true],
    ['a failed send keeps the words', out.inputKeptOnFailure === true],
    ['and says why', out.failureReasonShown === true],
    ['a focus message selects the conversation', out.focusSelected === true],
    ['and shows a banner naming the wait', out.bannerShowsWaiting === true],
    ['the VIP sheet opens', out.vipSheetOpen === true],
    ['an unresolved entry is flagged', out.vipUnresolvedWarned === true],
    ['adding one sends the whole list', out.vipAdded === true],
    ['removing one does too, without it', out.vipRemoved === true],
    ['a watch-only phone has no composer', out.composerHiddenWhenLocked === true],
    ['and says why', out.lockedMessageShown === true],
    ['no script errors at desktop width', out.errorsWide === 0],
    ['a phone width collapses to one pane', out.narrowIsCompact === true],
    ['starting on the list', out.narrowStartsOnList === true],
    ['which fits with no horizontal overflow', out.narrowListNoOverflow === true],
    ['tapping a row shows the thread', out.narrowOpensThread === true],
    ['which also fits with no horizontal overflow', out.narrowThreadNoOverflow === true],
    ['and back returns to the list', out.narrowBackReturnsToList === true],
    ['no script errors at phone width', out.errorsNarrow === 0]
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
    if (!ok) failed++;
  }
  console.log('\nScreenshots: /tmp/slack-wide.png, /tmp/slack-wide-thread.png, ' +
    '/tmp/slack-narrow-list.png, /tmp/slack-narrow-thread.png');
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' Slack checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
