#!/usr/bin/env node
'use strict';

// Drives media/slack.js the way the editor webview drives it: a fake
// acquireVsCodeApi, icons.js and slack.js loaded for real, messages posted in
// and read back out. The offline suite has nothing like a DOM to check this
// against; only a real browser can say whether the sidebar renders its
// sections, the transcript groups bubbles, and a hostile conversation title
// stays text.
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
// browser.css is what gives --vscode-editor-background (and friends) a real
// light/dark value outside the editor — the same file the phone app loads
// beside slack.css, so a "light theme" screenshot here is not just the iOS
// palette flipping on top of a background that never does.
const BROWSER_CSS = 'file://' + path.join(ROOT, 'media', 'browser.css');

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html, body { height: 100%; margin: 0; } #slack-root { height: 100%; }</style>
<link rel="stylesheet" href="${BROWSER_CSS}">
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
const MIN = 60000;
const HOUR = 3600000;

// ---- the sidebar: 2+ DMs (one unread+mentioned, one with no image), a
// group, and 3 channels (one private, one pending) ---------------------------
const SIDEBAR_ITEMS = [
  {
    id: 'c-anna', kind: 'dm', title: 'Anna', private: false,
    // A tiny data: URI stands in for a real avatar image — file:// pages
    // cannot reach secure.gravatar.com, and a broken-image glyph is not what
    // a screenshot should show for "a DM with a photo".
    user: {
      id: 'U_ANNA', name: 'Anna', initials: 'A',
      image: 'data:image/svg+xml;base64,' + Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
        '<rect width="64" height="64" fill="#d9534f"/>' +
        '<text x="32" y="40" font-size="28" fill="#fff" text-anchor="middle" font-family="sans-serif">A</text></svg>'
      ).toString('base64')
    },
    latestAt: NOW - 1 * MIN, unread: 2, mentions: 1,
    last: { text: 'are you around?', from: 'Anna', mine: false, at: NOW - 1 * MIN },
    pending: true, pendingSince: NOW - 2 * MIN, vip: true
  },
  {
    id: 'c-theo', kind: 'dm', title: 'Theo', private: false,
    user: { id: 'U_THEO', name: 'Theo', initials: 'T', image: null },
    latestAt: NOW - 2 * HOUR, unread: 0, mentions: 0,
    last: { text: 'sounds good', from: 'Theo', mine: false, at: NOW - 2 * HOUR },
    pending: false, pendingSince: null, vip: false
  },
  {
    id: 'c-xss', kind: 'dm', title: '<img src=x onerror=alert(1)>', private: false, user: null,
    latestAt: NOW - 5 * HOUR, unread: 0, mentions: 0,
    last: { text: 'hello <script>', from: 'X', mine: false, at: NOW - 5 * HOUR },
    pending: false, pendingSince: null, vip: false
  },
  {
    id: 'c-design', kind: 'group', title: 'Design squad', private: false, user: null,
    latestAt: NOW - 30 * MIN, unread: 0, mentions: 0,
    last: { text: 'merged', from: 'Yuki', mine: false, at: NOW - 30 * MIN },
    pending: false, pendingSince: null, vip: false
  },
  {
    id: 'c-team', kind: 'channel', title: 'team-chat', private: false, user: null,
    latestAt: NOW - 20 * MIN, unread: 0, mentions: 0,
    last: { text: 'ship it', from: 'Yuki', mine: false, at: NOW - 20 * MIN },
    pending: false, pendingSince: null, vip: false
  },
  {
    id: 'c-priv', kind: 'channel', title: 'secret-ops', private: true, user: null,
    latestAt: NOW - 45 * MIN, unread: 0, mentions: 0,
    last: { text: 'eyes only', from: 'Mo', mine: false, at: NOW - 45 * MIN },
    pending: false, pendingSince: null, vip: false
  },
  {
    id: 'c-wait', kind: 'channel', title: 'launch', private: false, user: null,
    latestAt: NOW - 90 * MIN, unread: 1, mentions: 0,
    last: { text: 'go/no-go?', from: 'Priya', mine: false, at: NOW - 90 * MIN },
    pending: true, pendingSince: NOW - 10 * MIN, vip: false
  },
  // Two muted rows: one mutable here, one muted in Slack itself (so Unmute
  // has to be disabled) — both should sort after every other channel.
  {
    id: 'c-muted', kind: 'channel', title: 'random', private: false, user: null,
    latestAt: NOW - 1 * MIN, unread: 3, mentions: 2,
    last: { text: 'lol', from: 'Jin', mine: false, at: NOW - 1 * MIN },
    pending: false, pendingSince: null, vip: false, muted: true, mutedIn: null
  },
  {
    id: 'c-muted-slack', kind: 'channel', title: 'announcements', private: false, user: null,
    latestAt: NOW - 2 * MIN, unread: 0, mentions: 0,
    last: { text: 'read only', from: 'Bot', mine: false, at: NOW - 2 * MIN },
    pending: false, pendingSince: null, vip: false, muted: true, mutedIn: 'slack'
  }
];

const BASE_STATE = {
  enabled: true, hasTokens: true, connected: true, socket: 'live', mode: 'socket', error: null,
  me: { id: 'U_ME', name: 'Me' },
  unresolved: ['nobody@nowhere.test'],
  vips: [{ id: 'U_ANNA', name: 'Anna', initials: 'A' }],
  vipList: ['Anna', 'nobody@nowhere.test'],
  sidebar: { loaded: true, at: NOW, items: SIDEBAR_ITEMS },
  conversations: [],
  mayReply: true, mayEdit: true, local: true, clock: '24h',
  setupUrl: 'https://slack.com/apps/new'
};

const CONV_ANNA = { id: 'c-anna', kind: 'dm', title: 'Anna', vip: true, user: { initials: 'A' } };
const CONV_TEAM = { id: 'c-team', kind: 'channel', title: 'team-chat', private: false };

// Reactions, a file-only message and three consecutive messages from the
// same sender, all in one thread.
const THREAD_ANNA = {
  conversation: CONV_ANNA,
  thread: null,
  messages: [
    { ts: '1', user: 'U_ANNA', name: 'Anna', initials: 'A', mine: false,
      html: 'Hey, are you <strong>around</strong>?', at: NOW - 6 * MIN },
    { ts: '2', user: 'U_ANNA', name: 'Anna', initials: 'A', mine: false,
      html: 'got a minute?', at: NOW - 5 * MIN,
      reactions: [{ name: '+1', emoji: '👍', count: 2, mine: true }] },
    { ts: '3', user: 'U_ANNA', name: 'Anna', initials: 'A', mine: false,
      html: '', files: [{ name: 'design.png' }], at: NOW - 4 * MIN },
    { ts: '4', user: 'U_ME', name: 'Me', initials: 'M', mine: true,
      html: 'sure, give me a sec', at: NOW - 1 * MIN }
  ]
};

// A channel thread: two named senders, a reaction, an edited message.
const THREAD_TEAM = {
  conversation: CONV_TEAM,
  thread: null,
  messages: [
    { ts: '10', user: 'U_YUKI', name: 'Yuki', initials: 'Y', mine: false,
      html: 'ship it', at: NOW - 20 * MIN,
      reactions: [{ name: 'rocket', emoji: '🚀', count: 3, mine: false }] },
    { ts: '11', user: 'U_MO', name: 'Mo', initials: 'M', mine: false,
      html: 'already tagged <code>v2.3.0</code>', edited: true, at: NOW - 19 * MIN },
    { ts: '12', user: 'U_ME', name: 'Me', initials: 'M', mine: true,
      html: 'nice work', at: NOW - 18 * MIN, replyCount: 3, threadTs: '12' }
  ]
};

function longThread(n) {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({
      ts: String(100 + i), user: 'U_ANNA', name: 'Anna', initials: 'A', mine: i % 2 === 0,
      html: 'message number ' + i, at: NOW - (n - i) * MIN
    });
  }
  return { conversation: CONV_ANNA, thread: null, messages, hasMore: true };
}

// A real, valid 1x1 PNG — tiny enough to be a literal, real enough that an
// <img> actually decodes it and the lightbox has something to show.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// Two image messages — one whose bytes arrive, one the laptop refuses — and
// hasMore: false, so the quiet "Beginning of conversation" line gets a turn.
const THREAD_IMAGE = {
  conversation: CONV_ANNA,
  thread: null,
  hasMore: false,
  messages: [
    { ts: '20', user: 'U_ANNA', name: 'Anna', initials: 'A', mine: false, html: '',
      files: [{ id: 'F1', name: 'shot.png', title: 'shot.png', mimetype: 'image/png', image: true, w: 800, h: 400, permalink: 'https://slack.test/f1' }],
      at: NOW - 3 * MIN },
    { ts: '21', user: 'U_ANNA', name: 'Anna', initials: 'A', mine: false, html: '',
      files: [{ id: 'F2', name: 'broken.png', title: 'broken.png', mimetype: 'image/png', image: true, w: 200, h: 200, permalink: 'https://slack.test/f2' }],
      at: NOW - 2 * MIN }
  ]
};

// A page of history older than anything already loaded, oldest-first.
const OLDER_ANNA = [
  { ts: '90', user: 'U_ANNA', name: 'Anna', initials: 'A', mine: false, html: 'older message one', at: NOW - 20 * MIN },
  { ts: '95', user: 'U_ANNA', name: 'Anna', initials: 'A', mine: false, html: 'older message two', at: NOW - 15 * MIN }
];

(async () => {
  const out = {};
  const browser = await launch(chrome);
  try {
    await browser.asScreen(1100, 720);
    // Headless Chrome defaults prefers-color-scheme to light with nothing to
    // tell it otherwise; the editor webview would set it from the VS Code
    // theme, so a dark run here has to ask for dark explicitly.
    await browser.prefers({ 'prefers-color-scheme': 'dark' });
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
    const allText = async (selector) => browser.evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(function(e){ return e.textContent; })`
    );

    // ---- ready --------------------------------------------------------
    const firstPosted = await posted();
    out.sentReady = firstPosted.some((m) => m.type === 'slack:ready');

    // ---- setup card (no tokens yet) ------------------------------------
    await post({ type: 'slack:state', state: Object.assign({}, BASE_STATE, { hasTokens: false }) });
    out.setupCardShown = /Connect Slack/.test(await text('.ns-card h2') || '');
    out.setupExplains = /@mention you/.test(await text('.ns-card p') || '');
    // A webview may not open a window itself, so the button asks the laptop to.
    await click('.ns-step-app');
    out.setupAsksLaptop = (await posted()).some((m) => m.type === 'slack:setup');

    // ---- the two ways in, and the session paste ------------------------
    out.setupTwoOptions = (await count('.ns-seg-opt')) === 2;
    out.setupAppFirst = /Create an app/.test(await text('.ns-seg-opt') || '');
    await click('.ns-seg-opt[data-tab="session"]');
    out.sessionFieldsShown = await exists('.ns-in-token') && await exists('.ns-in-cookie');
    out.sessionHasHelp = /app\.slack\.com/.test(await text('.ns-help') || '');
    await click('.ns-help summary');
    await new Promise((r) => setTimeout(r, 320));
    await browser.shot('/tmp/slack-session-setup.png');
    await browser.evaluate("window.__posted.length = 0; true");
    // A malformed paste is caught in the page, before anything is sent.
    await browser.evaluate("(function(){ var t=document.querySelector('.ns-in-token'); t.value='nope'; t.dispatchEvent(new Event('input',{bubbles:true})); var c=document.querySelector('.ns-in-cookie'); c.value='xoxd-abc'; c.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.ns-session-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true; })()");
    out.sessionBadCaught = !(await posted()).some((m) => m.type === 'slack:signIn') && /xoxc-/.test(await text('.ns-session-err') || '');
    // A well-formed pair is sent with both values.
    await browser.evaluate("(function(){ var t=document.querySelector('.ns-in-token'); t.value='xoxc-good'; t.dispatchEvent(new Event('input',{bubbles:true})); var c=document.querySelector('.ns-in-cookie'); c.value='xoxd-good'; c.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.ns-session-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true; })()");
    const afterSignIn = await posted();
    out.sessionSent = afterSignIn.some((m) => m.type === 'slack:signIn' && m.token === 'xoxc-good' && m.cookie === 'xoxd-good');
    out.sessionBusy = /Checking/.test(await text('.ns-session-go') || '');
    // Slack refusing it says so in the form, keeping the setup card up.
    await post({ type: 'slack:signedIn', ok: false, message: 'Slack did not accept that session: invalid_auth' });
    out.sessionRejectShown = /did not accept/.test(await text('.ns-session-err') || '');
    // A phone (not local) is told to do it on the laptop.
    await post({ type: 'slack:state', state: Object.assign({}, BASE_STATE, { hasTokens: false, local: false }) });
    await click('.ns-seg-opt[data-tab="session"]');
    out.sessionPhoneDeferred = /laptop/.test(await text('.ns-setup-pane') || '') && !(await exists('.ns-in-token'));

    // ---- disabled card --------------------------------------------------
    await post({ type: 'slack:state', state: Object.assign({}, BASE_STATE, { enabled: false }) });
    out.disabledCardShown = /off/.test(await text('.ns-card h2') || '');

    // ---- the real sidebar: sections, in order ----------------------------
    await post({ type: 'slack:state', state: BASE_STATE });
    out.sectionOrder = await allText('.ns-section-title');
    out.rowCount = await count('.ns-row');
    out.dmRowsExist = (await count('.ns-avatar-dm')) >= 2;
    out.groupRowExists = (await count('.ns-avatar-group')) >= 1;
    out.channelRowsExist = (await count('.ns-avatar-channel')) >= 3;
    // Every row shares one grid: the separator between rows must be drawn
    // without taking layout space, or each row after the first drifts
    // right as its avatar inherits a stray margin from the one above it.
    out.avatarGridAligned = await browser.evaluate(
      `(function(){
        var lefts = Array.from(document.querySelectorAll('.ns-rows .ns-avatar'))
          .map(function(a){ return a.getBoundingClientRect().left; });
        return lefts.length > 1 && lefts.every(function(l){ return Math.abs(l - lefts[0]) < 0.5; });
      })()`
    );
    out.pendingFirst = (await browser.evaluate(
      "document.querySelector('.ns-row').closest('li').querySelector('.ns-title').textContent"
    ));
    out.pendingPill = await text('.ns-row .ns-pending');
    out.xssTitleIsText = await text('.ns-row[data-id="c-xss"] .ns-title');
    // A real avatar image (Anna's) is fine elsewhere in the list; the point
    // is that the hostile title itself never became markup.
    out.xssNoImgTag = !(await exists('.ns-row[data-id="c-xss"] img'));

    // ---- unread row: bold title, a badge with the mention count ---------
    out.unreadTitleBold = await browser.evaluate(
      "document.querySelector('.ns-row[data-id=\"c-anna\"] .ns-title').classList.contains('unread')"
    );
    out.unreadBadgeCount = await text('.ns-row[data-id="c-anna"] .ns-badge');

    // ---- search: filters locally, Esc clears -----------------------------
    await browser.evaluate(
      `(function(){ var i = document.querySelector('.ns-search-input'); i.value = 'anna';
        i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
    );
    out.searchFiltered = (await count('.ns-row')) < out.rowCount && (await count('.ns-row')) > 0;
    out.searchExcludesOthers = !(await exists('.ns-row[data-id="c-team"]'));
    await browser.evaluate(
      `(function(){ var i = document.querySelector('.ns-search-input');
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`
    );
    out.searchEscCleared = (await count('.ns-row')) === out.rowCount;

    // ---- opening a conversation ------------------------------------------
    await browser.evaluate("window.__posted.length = 0; true");
    await click('.ns-row[data-id="c-anna"]');
    const afterOpen = await posted();
    const openMsg = afterOpen.find((m) => m.type === 'slack:open');
    out.openSentConversation = openMsg && openMsg.conversation;

    // ---- thread: loading, then rendered with grouping, reactions, files --
    out.loadingShown = /Loading/.test(await text('.ns-messages') || '');
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true });
    out.groupCount = await count('.ns-group');
    // A DM never names the sender above a group — there are only two people
    // in it, and the thread header already says who.
    out.dmGroupHasNoName = await browser.evaluate(
      "document.querySelectorAll('.ns-group')[0].querySelectorAll('.ns-msg-name').length"
    );
    out.consecutiveBubblesGrouped = await browser.evaluate(
      "document.querySelectorAll('.ns-group')[0].querySelectorAll('.ns-msg, .ns-file').length"
    );
    out.boldRendered = await exists('.ns-msg strong');
    out.mineAlignedRight = await exists('.ns-group.mine');
    out.reactionShown = /👍/.test(await text('.ns-reaction') || '');
    out.fileShown = /design\.png/.test(await text('.ns-file-name') || '');
    out.noEmptyBubble = await browser.evaluate(
      "Array.from(document.querySelectorAll('.ns-msg')).every(function(b){ return b.textContent.trim().length > 0; })"
    );
    // A short bubble ("got a minute?") sizes to its content, not to the 75%
    // cap every bubble shares — only a long one should ever get that wide.
    out.shortBubbleNarrow = await browser.evaluate(
      `(function(){
        var col = document.querySelector('.ns-messages').getBoundingClientRect().width;
        var bubble = Array.from(document.querySelectorAll('.ns-msg'))
          .find(function(b){ return b.textContent.trim() === 'got a minute?'; });
        return !!bubble && bubble.getBoundingClientRect().width < col * 0.4;
      })()`
    );

    // ---- a channel thread: named senders, a reaction, edited -------------
    await browser.evaluate("window.__posted.length = 0; true");
    await click('.ns-row[data-id="c-team"]');
    await post({ type: 'slack:thread', conversation: THREAD_TEAM.conversation, thread: null, messages: THREAD_TEAM.messages, hasMore: true });
    out.channelShowsNames = (await count('.ns-msg-name')) >= 2;
    out.channelHasReaction = await exists('.ns-reaction');
    out.repliesLinkShown = /3 replies/.test(await text('.ns-replies') || '');
    await new Promise((r) => setTimeout(r, 350));
    await browser.shot('/tmp/slack-ios-wide-channel.png');

    // ---- back to Anna for the composer / reply checks --------------------
    await click('.ns-row[data-id="c-anna"]');
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true });

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
    await post({ type: 'slack:thread', conversation: THREAD_TEAM.conversation, thread: null, messages: THREAD_TEAM.messages, hasMore: true });
    await post({ type: 'slack:focus', conversation: 'c-anna', reason: 'popup' });
    out.focusSelected = (await posted()).some((m) => m.type === 'slack:open' && m.conversation === 'c-anna');
    out.bannerShowsWaiting = /waiting/i.test(await text('.ns-banner') || '');
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true });

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
    await click('.ns-vip-close');

    // ---- "Live" pill in poll mode (a pasted browser session, no socket) ---
    await post({ type: 'slack:state', state: Object.assign({}, BASE_STATE, { socket: undefined, mode: 'poll', connected: true }) });
    out.pollShowsLive = (await text('.ns-conn')) === 'Live';
    await post({ type: 'slack:state', state: BASE_STATE });

    // ---- slack:refresh: sent once when the tab becomes visible, throttled -
    await browser.evaluate("window.__posted.length = 0; true");
    await browser.evaluate("document.dispatchEvent(new Event('visibilitychange')); true");
    out.refreshSentOnFocus = (await posted()).some((m) => m.type === 'slack:refresh');
    await browser.evaluate("window.__posted.length = 0; true");
    await browser.evaluate("document.dispatchEvent(new Event('visibilitychange')); true");
    out.refreshThrottled = !(await posted()).some((m) => m.type === 'slack:refresh');

    // ---- only the two panes scroll: a long thread never grows the page ----
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: longThread(80).messages, hasMore: true });
    await new Promise((r) => setTimeout(r, 350));
    out.onlyPanesScroll = await browser.evaluate('document.scrollingElement.scrollHeight <= window.innerHeight');

    // ---- the page itself never scrolls: focusing the composer, typing, and
    //      wheeling the transcript all stay inside the two panes -----------
    const sidebarTopBefore = await browser.evaluate("document.querySelector('.ns-row').getBoundingClientRect().top");
    await browser.evaluate(
      `(function(){
        var ta = document.querySelector('.ns-input');
        ta.focus({ preventScroll: true });
        ta.value = 'checking the scroll';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        var s = document.querySelector('.ns-messages');
        s.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        return true;
      })()`
    );
    await new Promise((r) => setTimeout(r, 60));
    out.pageUnmovedAfterFocusType = await browser.evaluate('window.scrollY === 0');
    out.sidebarRowUnmoved = (await browser.evaluate("document.querySelector('.ns-row').getBoundingClientRect().top")) === sidebarTopBefore;
    // Directly exercising the guard: whatever scrolled an ancestor, it snaps
    // back the same tick.
    await browser.evaluate(
      `(function(){
        document.documentElement.scrollTop = 500; document.documentElement.dispatchEvent(new Event('scroll'));
        document.body.scrollTop = 500; document.body.dispatchEvent(new Event('scroll'));
        document.querySelector('.nik-slack').scrollTop = 500; document.querySelector('.nik-slack').dispatchEvent(new Event('scroll'));
        window.scrollTo(0, 400); window.dispatchEvent(new Event('scroll'));
        return true;
      })()`
    );
    await new Promise((r) => setTimeout(r, 30));
    out.scrollGuardResets = await browser.evaluate(
      `(function(){
        return window.scrollY === 0 && document.documentElement.scrollTop === 0 &&
          document.body.scrollTop === 0 && document.querySelector('.nik-slack').scrollTop === 0;
      })()`
    );
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true });

    // ---- opens pinned to the bottom, and stays there as content grows,
    //      but never yanks a reader who scrolled up -------------------------
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: longThread(40).messages, hasMore: true });
    await new Promise((r) => setTimeout(r, 80));
    out.opensAtBottom = await browser.evaluate(
      "(function(){ var s = document.querySelector('.ns-messages'); return s.scrollHeight - s.scrollTop - s.clientHeight < 2; })()"
    );
    // Scrolled well clear of the top (so this does not also trigger a
    // slack:older request) and of the bottom.
    const scrollTopScrolledUp = await browser.evaluate(
      `(function(){
        var s = document.querySelector('.ns-messages');
        s.scrollTop = Math.round(s.scrollHeight / 2);
        s.dispatchEvent(new Event('scroll'));
        return s.scrollTop;
      })()`
    );
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: longThread(41).messages, hasMore: true });
    await new Promise((r) => setTimeout(r, 60));
    out.scrolledUpNotYanked = (await browser.evaluate("document.querySelector('.ns-messages').scrollTop")) === scrollTopScrolledUp;
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true });

    // ---- loading older messages, scrolled near the top --------------------
    await browser.evaluate("window.__posted.length = 0; true");
    await browser.evaluate(
      "(function(){ var s = document.querySelector('.ns-messages'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); return true; })()"
    );
    await new Promise((r) => setTimeout(r, 30));
    const olderMsg = (await posted()).find((m) => m.type === 'slack:older');
    out.olderRequested = !!olderMsg && olderMsg.conversation === 'c-anna' && olderMsg.before === THREAD_ANNA.messages[0].ts;
    out.olderSpinnerShown = await exists('.ns-older-spinner');
    // In flight already — scrolling near the top again must not ask twice.
    await browser.evaluate("window.__posted.length = 0; true");
    await browser.evaluate(
      "(function(){ var s = document.querySelector('.ns-messages'); s.dispatchEvent(new Event('scroll')); return true; })()"
    );
    out.olderNotDoubleRequested = !(await posted()).some((m) => m.type === 'slack:older');
    const heightBeforeOlder = await browser.evaluate("document.querySelector('.ns-messages-inner').scrollHeight");
    await post({ type: 'slack:older', conversation: THREAD_ANNA.conversation, thread: null, messages: OLDER_ANNA, hasMore: false });
    await new Promise((r) => setTimeout(r, 30));
    out.olderPrepended = await text('.ns-messages');
    out.olderSpinnerGone = !(await exists('.ns-older-spinner'));
    out.beginningShown = /Beginning of conversation/.test(await text('.ns-messages') || '');
    out.olderAnchorKept = (await browser.evaluate("document.querySelector('.ns-messages-inner').scrollHeight")) > heightBeforeOlder;
    await click('.ns-row[data-id="c-anna"]');
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true });

    // ---- images: a sized placeholder, lazily filled in, a lightbox --------
    await browser.evaluate("window.__posted.length = 0; true");
    await post({ type: 'slack:thread', conversation: THREAD_IMAGE.conversation, thread: null, messages: THREAD_IMAGE.messages, hasMore: THREAD_IMAGE.hasMore });
    await new Promise((r) => setTimeout(r, 60));
    out.imagePlaceholderSized = await browser.evaluate(
      "(function(){ var i = document.querySelector('.ns-image'); return !!i && i.style.width !== '' && i.getBoundingClientRect().width <= 320; })()"
    );
    const fileReqs = (await posted()).filter((m) => m.type === 'slack:file').map((m) => m.id);
    out.imageAskedLazily = fileReqs.includes('F1') && fileReqs.includes('F2');
    await post({ type: 'slack:file', id: 'F1', ok: true, dataUrl: TINY_PNG });
    await post({ type: 'slack:file', id: 'F2', ok: false });
    await new Promise((r) => setTimeout(r, 60));
    out.imageLoadedShowsSrc = (await browser.evaluate(
      "(function(){ var i = document.querySelector('.ns-image.loaded img'); return i ? i.src.indexOf('data:') === 0 : false; })()"
    ));
    out.imageRefusedFallsBackToChip = (await count('.ns-file')) >= 1;
    await click('.ns-image');
    out.lightboxOpens = await exists('.ns-lightbox');
    await browser.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
    out.lightboxEscCloses = !(await exists('.ns-lightbox'));
    await new Promise((r) => setTimeout(r, 350));
    await browser.shot('/tmp/slack-ios-image.png');
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true });

    // ---- mute: dimmed, grey badge, bell glyph, sorted last, a context menu -
    out.mutedRowDimmed = await browser.evaluate("document.querySelector('.ns-row[data-id=\"c-muted\"]').classList.contains('muted')");
    out.mutedNoUnreadDot = !(await exists('.ns-row[data-id="c-muted"] .ns-dot'));
    out.mutedBadgeGrey = await exists('.ns-row[data-id="c-muted"] .ns-badge-muted');
    out.mutedBellShown = await exists('.ns-row[data-id="c-muted"] .ns-muted-ico');
    out.mutedSortsLast = (await browser.evaluate(
      "Array.from(document.querySelectorAll('.ns-section:last-child .ns-row')).pop().dataset.id"
    )) === 'c-muted-slack';
    await browser.evaluate(
      `(function(){
        var row = document.querySelector('.ns-row[data-id="c-theo"]');
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
        return true;
      })()`
    );
    out.contextMenuOpens = await exists('.ns-ctx-menu');
    out.contextMenuOffersMute = /Mute/.test(await text('.ns-ctx-menu') || '');
    await new Promise((r) => setTimeout(r, 350));
    await browser.shot('/tmp/slack-ios-menu.png');
    await browser.evaluate("window.__posted.length = 0; true");
    await click('.ns-ctx-item');
    const muteMsg = (await posted()).find((m) => m.type === 'slack:mute');
    out.muteSent = muteMsg && muteMsg.conversation === 'c-theo' && muteMsg.muted === true;
    out.contextMenuClosedAfterClick = !(await exists('.ns-ctx-menu'));
    // Muted in Slack itself: Unmute is offered, but disabled, and says why.
    await browser.evaluate(
      `(function(){
        var row = document.querySelector('.ns-row[data-id="c-muted-slack"]');
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
        return true;
      })()`
    );
    out.unmuteDisabledWhenMutedInSlack = await browser.evaluate(
      "(function(){ var b = document.querySelector('.ns-ctx-item.disabled'); return !!b && /Unmute/.test(b.textContent) && /Muted in Slack/.test(b.textContent); })()"
    );
    await browser.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
    out.contextMenuEscCloses = !(await exists('.ns-ctx-menu'));

    // ---- mayReply: false hides the composer, and the context menu's Mute --
    await post({ type: 'slack:state', state: Object.assign({}, BASE_STATE, { mayReply: false }) });
    out.composerHiddenWhenLocked = !(await exists('.ns-input'));
    out.lockedMessageShown = /watch/.test(await text('.ns-locked') || '');
    await browser.evaluate(
      `(function(){
        var row = document.querySelector('.ns-row[data-id="c-muted"]');
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
        return true;
      })()`
    );
    out.watchOnlyHasNoMute = !/Mute/.test(await text('.ns-ctx-menu') || '') && /Open in Slack/.test(await text('.ns-ctx-menu') || '');
    await browser.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
    await post({ type: 'slack:state', state: BASE_STATE });
    await post({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true });

    out.errorsWide = (await browser.evaluate('window.__errors')).length;
    await new Promise((r) => setTimeout(r, 350));
    await browser.shot('/tmp/slack-ios-wide.png');
  } finally {
    browser.close();
  }

  // ---- light theme ----------------------------------------------------------
  const lightBrowser = await launch(chrome);
  try {
    await lightBrowser.asScreen(1100, 720);
    await lightBrowser.prefers({ 'prefers-color-scheme': 'light' });
    await lightBrowser.navigate('file://' + page);
    await lightBrowser.until('window.__posted.length > 0', 4000);
    await lightBrowser.evaluate(
      `(function(){ window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify({ type: 'slack:state', state: BASE_STATE })} })); return true; })()`
    );
    await lightBrowser.evaluate(
      `(function(){ var e = document.querySelector('.ns-row[data-id="c-anna"]'); if (e) e.click(); return true; })()`
    );
    await lightBrowser.evaluate(
      `(function(){ window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true })} })); return true; })()`
    );
    await new Promise((r) => setTimeout(r, 350));
    await lightBrowser.shot('/tmp/slack-ios-light.png');
  } finally {
    lightBrowser.close();
  }

  // ---- narrow: one pane, navigation, push/back ------------------------------
  // The viewport override only reliably takes effect set before the page
  // loads, so a phone width gets a browser of its own — the same approach
  // test/remote.check.js takes for its own phone-width pass.
  const phone = await launch(chrome);
  try {
    await phone.asPhone(390, 844);
    await phone.prefers({ 'prefers-color-scheme': 'dark' });
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
    await phone.shot('/tmp/slack-ios-narrow-list.png');

    await pclick('.ns-row[data-id="c-anna"]');
    out.narrowOpensThread = await phone.evaluate("document.querySelector('.nik-slack').classList.contains('show-thread')");
    await ppost({ type: 'slack:thread', conversation: THREAD_ANNA.conversation, thread: null, messages: THREAD_ANNA.messages, hasMore: true });
    out.narrowThreadNoOverflow = await noOverflow();
    // The slide-in is a 350ms CSS transition — wait for it to settle so the
    // screenshot shows the thread in place, not mid-slide.
    await phone.until("document.querySelector('.ns-thread').getBoundingClientRect().left === 0", 1000);
    await new Promise((r) => setTimeout(r, 350));
    await phone.shot('/tmp/slack-ios-narrow-thread.png');

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
    ['and Create the Slack app asks the laptop to open the page', out.setupAsksLaptop === true],
    ['the setup card offers two ways in', out.setupTwoOptions === true],
    ['with Create an app first', out.setupAppFirst === true],
    ['the session tab shows both fields', out.sessionFieldsShown === true],
    ['and says where to find them', out.sessionHasHelp === true],
    ['a malformed session is caught before anything is sent', out.sessionBadCaught === true],
    ['a well-formed session is sent with both values', out.sessionSent === true],
    ['and the button shows it is checking', out.sessionBusy === true],
    ['Slack refusing it is shown in the form', out.sessionRejectShown === true],
    ['a phone is told to sign in on the laptop', out.sessionPhoneDeferred === true],
    ['disabled-but-connected shows its own card', out.disabledCardShown === true],
    ['sections appear in order: Needs you, Direct messages, Channels',
      JSON.stringify(out.sectionOrder) === JSON.stringify(['Needs you', 'Direct messages', 'Channels'])],
    // 7 items, not 9: a pending conversation (c-anna, c-wait) is drawn once,
    // in "Needs you" — not a second time in Direct messages/Channels too.
    ['every sidebar row is drawn once, pending or not', out.rowCount === 9],
    ['direct-message rows exist', out.dmRowsExist === true],
    ['a group row exists', out.groupRowExists === true],
    ['channel rows exist', out.channelRowsExist === true],
    ["every row's avatar lines up on the same grid", out.avatarGridAligned === true],
    ['the longest-waiting conversation sorts first', out.pendingFirst === 'launch'],
    ['it carries a waiting pill', /waiting/.test(out.pendingPill || '')],
    ['a hostile title renders as text', out.xssTitleIsText === '<img src=x onerror=alert(1)>'],
    ['and never becomes an element', out.xssNoImgTag === true],
    ['an unread row bolds its title', out.unreadTitleBold === true],
    ['and carries a mention badge', out.unreadBadgeCount === '1'],
    ['search filters the rows', out.searchFiltered === true],
    ['excluding what does not match', out.searchExcludesOthers === true],
    ['Esc clears the search', out.searchEscCleared === true],
    ['opening a conversation tells the laptop', out.openSentConversation === 'c-anna'],
    ['the thread shows a loading state first', out.loadingShown === true],
    ['messages arrive grouped', out.groupCount === 2],
    ['a DM does not name the sender above a group', out.dmGroupHasNoName === 0],
    ['three consecutive bubbles from Anna stay in one group', out.consecutiveBubblesGrouped === 3],
    ['message html is trusted and rendered', out.boldRendered === true],
    ['your own messages are told apart', out.mineAlignedRight === true],
    ['a reaction is shown as a chip', out.reactionShown === true],
    ['a file-only message shows the file, not an empty bubble', out.fileShown === true],
    ['no bubble is ever empty', out.noEmptyBubble === true],
    ['a short bubble sizes to its content, not the 75% cap', out.shortBubbleNarrow === true],
    ['a channel names more than one sender', out.channelShowsNames === true],
    ['and shows a reaction', out.channelHasReaction === true],
    ['"N replies" links to the thread', out.repliesLinkShown === true],
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
    ['a pasted-session (poll) connection shows Live', out.pollShowsLive === true],
    ['becoming visible sends slack:refresh', out.refreshSentOnFocus === true],
    ['but not twice within 15s', out.refreshThrottled === true],
    ['only the list and thread panes scroll, never the page', out.onlyPanesScroll === true],
    ['the page does not move when the composer is focused and typed into', out.pageUnmovedAfterFocusType === true],
    ['nor does the sidebar', out.sidebarRowUnmoved === true],
    ['scrolling an ancestor directly is snapped back', out.scrollGuardResets === true],
    ['a conversation opens scrolled to the newest message', out.opensAtBottom === true],
    ['scrolled up, a new message does not yank the reader down', out.scrolledUpNotYanked === true],
    ['scrolling near the top asks for older messages', out.olderRequested === true],
    ['showing a loading row while it waits', out.olderSpinnerShown === true],
    ['and not asking again while one is in flight', out.olderNotDoubleRequested === true],
    ['the older page is prepended', /older message one/.test(out.olderPrepended || '')],
    ['its spinner is gone', out.olderSpinnerGone === true],
    ['hasMore: false shows the quiet end of history', out.beginningShown === true],
    ['prepending keeps the reader anchored, not reset to the top', out.olderAnchorKept === true],
    ['an image file shows a sized placeholder', out.imagePlaceholderSized === true],
    ['asked for lazily, by id', out.imageAskedLazily === true],
    ['a loaded image gets its data: src', out.imageLoadedShowsSrc === true],
    ['a refused one falls back to the file chip', out.imageRefusedFallsBackToChip === true],
    ['clicking an image opens a lightbox', out.lightboxOpens === true],
    ['Esc closes it', out.lightboxEscCloses === true],
    ['a muted row is dimmed', out.mutedRowDimmed === true],
    ['with no unread dot', out.mutedNoUnreadDot === true],
    ['a grey mention badge', out.mutedBadgeGrey === true],
    ['and a bell-slash glyph', out.mutedBellShown === true],
    ['muted rows sort to the end of their section', out.mutedSortsLast === true],
    ['right-click opens a context menu', out.contextMenuOpens === true],
    ['offering Mute', out.contextMenuOffersMute === true],
    ['choosing it sends slack:mute', out.muteSent === true],
    ['and closes the menu', out.contextMenuClosedAfterClick === true],
    ['muted in Slack itself, Unmute is disabled and says so', out.unmuteDisabledWhenMutedInSlack === true],
    ['Esc closes the context menu', out.contextMenuEscCloses === true],
    ['a watch-only seat gets no Mute item', out.watchOnlyHasNoMute === true],
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
  console.log('\nScreenshots: /tmp/slack-ios-wide.png, /tmp/slack-ios-wide-channel.png, ' +
    '/tmp/slack-ios-narrow-list.png, /tmp/slack-ios-narrow-thread.png, /tmp/slack-ios-light.png, ' +
    '/tmp/slack-ios-menu.png, /tmp/slack-ios-image.png');
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' Slack checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
