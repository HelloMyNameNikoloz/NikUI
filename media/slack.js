/* Slack, as a page inside NikUI: the same client in a VS Code webview tab on
   the laptop and on a page of the phone app. Nothing here knows which one it
   is in — it is handed `send` to talk back and fed messages through
   `receive`; everything else is DOM and a little state.

   The laptop decides what counts as a VIP, what mayReply and mayEdit mean,
   and what the connection pill says; this file only draws what it is told
   and keeps the untrusted half of that — names, titles, last-message text —
   out of innerHTML. The one thing that *is* trusted HTML is a message body,
   because the laptop has already run it through src/slack/mrkdwn.js. */
(function (root) {
  'use strict';

  const icon = typeof root.icon === 'function' ? root.icon : function () { return ''; };

  // A star for VIPs and a left arrow for "back" — two glyphs icons.js does
  // not carry, drawn the same way everything in icons.js is: a 24x24 stroke
  // path in currentColor, so they sit beside it without looking borrowed.
  const STAR = '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2.5l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.8-6.2 3.8 1.6-7-5.4-4.8 7.1-.7z"/></svg>';
  const BACK = '<svg class="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m15 18-6-6 6-6"/></svg>';

  const ONE_PANE_WIDTH = 640;
  const GROUP_GAP_MS = 5 * 60 * 1000;
  const PENDING_TICK_MS = 15 * 1000;

  function esc(s) { return root.escapeHtml ? root.escapeHtml(s) : String(s == null ? '' : s); }

  /** When something was said: the time alone today, the day before that. */
  function fmtClock(at, clock) {
    const d = new Date(at);
    if (!at || isNaN(d)) return '';
    const time = d.toLocaleTimeString([], clock === '12h'
      ? { hour: 'numeric', minute: '2-digit', hour12: true }
      : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return d.toDateString() === new Date().toDateString() ? time
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
  }

  /** A list row's time: "now", then minutes, then the clock, then a date. */
  function fmtWhen(at, clock) {
    if (!at) return '';
    const diff = Date.now() - at;
    if (diff < 45 * 1000) return 'now';
    if (diff < 3600 * 1000) return Math.max(1, Math.round(diff / 60000)) + 'm';
    return fmtClock(at, clock);
  }

  /** "waiting 2m", "waiting 1h 12m". */
  function fmtWaiting(since) {
    if (!since) return 'waiting';
    const mins = Math.max(0, Math.floor((Date.now() - since) / 60000));
    if (mins < 60) return 'waiting ' + Math.max(1, mins) + 'm';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return 'waiting ' + h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  function dayLabel(at) {
    const d = new Date(at);
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  /**
   * One Slack page, mounted into `root`.
   *
   * @param {object} options
   * @param {HTMLElement} options.root
   * @param {(msg: object) => void} options.send   post a message to the laptop
   * @param {() => void} [options.back]            shows a back button in the list header
   * @param {(url: string) => void} [options.openUrl]
   * @param {boolean} [options.compact]             force the one-pane layout
   */
  function mount(options) {
    const host = options.root;
    const send = options.send || function () {};
    const goBack = options.back || null;
    const openUrl = options.openUrl || function (u) { window.open(u, '_blank', 'noopener'); };
    const forceCompact = !!options.compact;

    host.classList.add('nik-slack');

    let state = null;              // last slack:state
    let transportUp = true;        // setConnected()
    let conversations = [];        // state.conversations, sorted
    let selectedId = null;
    let threadTs = null;           // the thread currently open, or null for the main channel
    let threadData = null;         // the slack:thread payload matching selectedId/threadTs
    let loadingThread = false;
    let pane = 'list';             // one-pane: 'list' | 'thread'
    let onePane = forceCompact || host.clientWidth < ONE_PANE_WIDTH || window.innerWidth < ONE_PANE_WIDTH;
    let followScroll = true;
    let sending = false;
    let sendError = null;
    let banner = null;             // { conversation, text } from slack:focus
    let vipOpen = false;
    let errorToast = null;
    let setupTab = 'app';          // the setup card's chosen method: 'app' | 'session'
    let signInBusy = false;
    let signInError = null;
    const sessionDraft = { token: '', cookie: '' };
    const drafts = new Map();      // `${conv}\u0000${thread||''}` -> text

    // ── shell, built once ──────────────────────────────────────

    host.innerHTML =
      '<div class="ns-live sr-only" aria-live="polite"></div>' +
      '<div class="ns-panes">' +
        '<section class="ns-list" aria-label="Conversations">' +
          '<header class="ns-head">' +
            '<button type="button" class="ns-back ghost icon-only" hidden aria-label="Back"></button>' +
            '<h1>Slack</h1>' +
            '<span class="ns-pill ns-conn">Checking…</span>' +
            '<button type="button" class="ns-vipbtn ghost" aria-label="VIPs"></button>' +
            '<button type="button" class="ns-gear ghost icon-only" aria-label="Settings"></button>' +
          '</header>' +
          '<div class="ns-list-body"></div>' +
        '</section>' +
        '<section class="ns-thread" aria-label="Conversation">' +
          '<div class="ns-thread-empty">Pick a conversation</div>' +
        '</section>' +
      '</div>' +
      '<div class="ns-vip-sheet" hidden>' +
        '<div class="ns-vip-card" role="dialog" aria-label="VIPs" aria-modal="true">' +
          '<header><h2>VIPs</h2><button type="button" class="ns-vip-close ghost icon-only" aria-label="Close"></button></header>' +
          '<p class="ns-vip-note">Messages from these people (or their handle, or email) jump the queue.</p>' +
          '<div class="ns-vip-chips" role="list"></div>' +
          '<form class="ns-vip-add"><input type="text" placeholder="Name, @handle or email" autocomplete="off">' +
            '<button type="submit" class="ghost icon-only" aria-label="Add"></button></form>' +
        '</div>' +
      '</div>';

    const live = host.querySelector('.ns-live');
    const listHead = host.querySelector('.ns-list .ns-head');
    const backBtn = host.querySelector('.ns-back');
    const connPill = host.querySelector('.ns-conn');
    const vipBtn = host.querySelector('.ns-vipbtn');
    const gearBtn = host.querySelector('.ns-gear');
    const listBody = host.querySelector('.ns-list-body');
    const threadPane = host.querySelector('.ns-thread');
    const vipSheet = host.querySelector('.ns-vip-sheet');
    const vipChips = host.querySelector('.ns-vip-chips');
    const vipForm = host.querySelector('.ns-vip-add');
    const vipInput = vipForm.querySelector('input');

    backBtn.innerHTML = BACK;
    vipBtn.innerHTML = STAR + '<span>VIPs</span>';
    gearBtn.innerHTML = icon('settings');
    host.querySelector('.ns-vip-close').innerHTML = icon('x');
    vipForm.querySelector('button').innerHTML = icon('plus');

    if (goBack) {
      backBtn.hidden = false;
      backBtn.addEventListener('click', goBack);
    }

    host.classList.toggle('compact', onePane);

    function say(text) { live.textContent = text; }

    // ── layout ───────────────────────────────────────────────

    function applyLayout() {
      host.classList.toggle('compact', onePane);
      host.classList.toggle('show-thread', onePane && pane === 'thread');
    }

    if (!forceCompact) {
      const measure = () => {
        const narrow = host.clientWidth < ONE_PANE_WIDTH;
        if (narrow !== onePane) { onePane = narrow; applyLayout(); }
      };
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(measure).observe(host);
      } else {
        window.addEventListener('resize', measure);
      }
    }
    applyLayout();

    // ── connection pill ───────────────────────────────────────

    function renderConn() {
      connPill.className = 'ns-pill ns-conn';
      if (!transportUp) { connPill.classList.add('off'); connPill.textContent = 'Offline'; return; }
      if (!state) { connPill.classList.add('warn'); connPill.textContent = 'Checking…'; return; }
      if (state.error) { connPill.classList.add('off'); connPill.textContent = state.error; return; }
      if (!state.connected) { connPill.classList.add('off'); connPill.textContent = 'Offline'; return; }
      if (state.socket === 'live') { connPill.classList.add('on'); connPill.textContent = 'Live'; return; }
      if (state.socket === 'connecting') { connPill.classList.add('warn'); connPill.textContent = 'Checking every 20s'; return; }
      connPill.classList.add('off');
      connPill.textContent = state.socket === 'unavailable' ? 'Unavailable' : 'Offline';
    }

    // ── the list ───────────────────────────────────────────────

    function sortedConversations() {
      const list = (state && state.conversations || []).slice();
      list.sort((a, b) => {
        if (!!a.pending !== !!b.pending) return a.pending ? -1 : 1;
        return (b.lastAt || 0) - (a.lastAt || 0);
      });
      return list;
    }

    function renderList() {
      conversations = sortedConversations();

      if (!state) {
        listBody.innerHTML = '<div class="ns-empty">Connecting…</div>';
        return;
      }
      if (!state.hasTokens) { renderSetup(); return; }
      if (!state.enabled) { renderDisabled(); return; }

      if (!conversations.length) {
        listBody.innerHTML = '';
        const empty = el('div', 'ns-empty');
        empty.textContent = 'Nothing yet. Messages from your VIPs and @mentions appear here.';
        listBody.appendChild(empty);
        return;
      }

      listBody.innerHTML = '';
      const ul = el('ul', 'ns-rows', { role: 'list' });
      for (const c of conversations) {
        ul.appendChild(buildRow(c));
      }
      listBody.appendChild(ul);
    }

    function buildRow(c) {
      const li = el('li', null, { role: 'listitem' });
      const row = el('button', 'ns-row' + (c.id === selectedId ? ' on' : ''), { type: 'button', 'data-id': c.id });

      const avatar = el('span', 'ns-avatar');
      avatar.textContent = (c.with && c.with.initials) || initialsOf(c.title);
      if (c.vip) {
        const star = el('span', 'ns-star');
        star.innerHTML = STAR;
        avatar.appendChild(star);
      }
      row.appendChild(avatar);

      const main = el('div', 'ns-row-main');
      const top = el('div', 'ns-row-top');
      const title = el('span', 'ns-title');
      title.textContent = c.title;
      const time = el('span', 'ns-time');
      time.textContent = fmtWhen(c.lastAt, state.clock);
      top.appendChild(title);
      top.appendChild(time);

      const bottom = el('div', 'ns-row-bottom');
      const lastText = el('span', 'ns-last');
      lastText.textContent = c.last ? c.last.text : '';
      bottom.appendChild(lastText);
      if (c.pending) {
        const pill = el('span', 'ns-pending');
        pill.textContent = fmtWaiting(c.pendingSince);
        bottom.appendChild(pill);
      }

      main.appendChild(top);
      main.appendChild(bottom);
      row.appendChild(main);
      row.addEventListener('click', () => select(c.id));
      li.appendChild(row);
      return li;
    }

    function renderSetup() {
      listBody.innerHTML = '';
      const local = !!(state && state.local);
      const card = el('div', 'ns-card ns-setup');
      card.innerHTML =
        '<h2>Connect Slack</h2>' +
        '<p>NikUI watches DMs from your VIPs and messages that @mention you. ' +
        'If one goes unseen for a minute it pops up here; after three minutes your phone rings.</p>' +
        '<div class="ns-seg" role="tablist">' +
          '<button type="button" class="ns-seg-opt" role="tab" data-tab="app">Create an app</button>' +
          '<button type="button" class="ns-seg-opt" role="tab" data-tab="session">Paste session</button>' +
          '<span class="ns-seg-glider" aria-hidden="true"></span>' +
        '</div>' +
        '<div class="ns-setup-body"></div>';

      const seg = card.querySelector('.ns-seg');
      const body = card.querySelector('.ns-setup-body');
      seg.querySelectorAll('.ns-seg-opt').forEach((opt) => {
        opt.setAttribute('aria-selected', String(opt.dataset.tab === setupTab));
        opt.addEventListener('click', () => {
          if (setupTab === opt.dataset.tab) return;
          setupTab = opt.dataset.tab;
          renderSetup();
        });
      });
      seg.classList.toggle('on-session', setupTab === 'session');

      if (setupTab === 'app') body.appendChild(buildAppSetup(local));
      else body.appendChild(buildSessionSetup(local));
      listBody.appendChild(card);
    }

    // The proper way, recommended for a workspace that will approve an app.
    function buildAppSetup(local) {
      const wrap = el('div', 'ns-setup-pane');
      wrap.innerHTML =
        '<ol class="ns-steps">' +
          '<li><button type="button" class="ns-step-app ghost">Create the Slack app</button></li>' +
          '<li>Install it to your workspace and copy the two tokens.' +
            '<div class="ns-note">If your workspace needs an admin to approve apps, this step will ask one.</div></li>' +
          '<li></li>' +
        '</ol>';
      wrap.querySelector('.ns-step-app').addEventListener('click', () => send({ type: 'slack:setup' }));
      const lastStep = wrap.querySelectorAll('.ns-steps li')[2];
      if (local) {
        const btn = el('button', 'ns-connect', { type: 'button' });
        btn.textContent = 'Connect Slack';
        btn.addEventListener('click', () => send({ type: 'slack:connect' }));
        lastStep.appendChild(btn);
      } else {
        lastStep.textContent = 'Finish this on your laptop.';
      }
      return wrap;
    }

    // The quick way: the session Slack's own web client already holds. No app,
    // nothing to approve — two values a browser keeps, pasted once.
    function buildSessionSetup(local) {
      const wrap = el('div', 'ns-setup-pane');
      if (!local) {
        wrap.innerHTML = '<p class="ns-note">Paste your Slack session on the laptop — these two values never leave this machine.</p>';
        return wrap;
      }
      wrap.innerHTML =
        '<p class="ns-session-lede">Already signed in to Slack in a browser? Paste what it holds — no app to create.</p>' +
        '<form class="ns-session-form" novalidate>' +
          '<label class="ns-field"><span>Session token</span>' +
            '<input type="password" class="ns-in-token" placeholder="xoxc-…" autocomplete="off" spellcheck="false"></label>' +
          '<label class="ns-field"><span>d cookie</span>' +
            '<input type="password" class="ns-in-cookie" placeholder="xoxd-…" autocomplete="off" spellcheck="false"></label>' +
          '<details class="ns-help"><summary>Where do I find these?</summary>' +
            '<ol>' +
              '<li>Open <b>app.slack.com</b> in a browser and your workspace.</li>' +
              '<li>Open the developer tools (⌥⌘I), then the <b>Console</b>.</li>' +
              '<li>Paste <code>JSON.parse(localStorage.localConfig_v2).teams[Object.keys(JSON.parse(localStorage.localConfig_v2).teams)[0]].token</code> — that is the <b>xoxc-</b> token.</li>' +
              '<li>In <b>Application → Cookies → app.slack.com</b>, copy the value of the <b>d</b> cookie — the <b>xoxd-</b> one.</li>' +
            '</ol>' +
            '<p class="ns-note">The session lasts until you sign out of that browser. Close the tab instead.</p>' +
          '</details>' +
          '<div class="ns-session-err" hidden></div>' +
          '<button type="submit" class="ns-session-go">Sign in</button>' +
        '</form>';

      const form = wrap.querySelector('.ns-session-form');
      const tokenIn = wrap.querySelector('.ns-in-token');
      const cookieIn = wrap.querySelector('.ns-in-cookie');
      const go = wrap.querySelector('.ns-session-go');
      const err = wrap.querySelector('.ns-session-err');
      tokenIn.value = sessionDraft.token;
      cookieIn.value = sessionDraft.cookie;
      tokenIn.addEventListener('input', () => { sessionDraft.token = tokenIn.value; });
      cookieIn.addEventListener('input', () => { sessionDraft.cookie = cookieIn.value; });
      if (signInError) { err.hidden = false; err.textContent = signInError; }
      go.disabled = signInBusy;
      go.textContent = signInBusy ? 'Checking…' : 'Sign in';
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (signInBusy) return;
        const token = tokenIn.value.trim();
        const cookie = cookieIn.value.trim();
        if (!/^(['"`]*)xoxc-/.test(token)) { signInError = 'The session token starts with xoxc-.'; return void renderSetup(); }
        if (!/^(['"`]*)(d=)?xoxd-/.test(cookie)) { signInError = 'The d cookie starts with xoxd-.'; return void renderSetup(); }
        signInBusy = true;
        signInError = null;
        renderSetup();
        send({ type: 'slack:signIn', token, cookie });
      });
      return wrap;
    }

    function renderDisabled() {
      listBody.innerHTML = '';
      const card = el('div', 'ns-card');
      card.innerHTML = '<h2>Slack watching is off</h2><p>Turn it back on to see VIP messages and @mentions here.</p>';
      const btn = el('button', null, { type: 'button' });
      btn.textContent = 'Turn on';
      btn.addEventListener('click', () => send({ type: 'slack:enable' }));
      card.appendChild(btn);
      listBody.appendChild(card);
    }

    // ── thread ───────────────────────────────────────────────

    function findConversation(id) {
      return conversations.find((c) => c.id === id) || (threadData && threadData.conversation);
    }

    function select(id) {
      selectedId = id;
      threadTs = null;
      threadData = null;
      loadingThread = true;
      followScroll = true;
      sendError = null;
      if (banner && banner.conversation === id) banner = null;
      pane = 'thread';
      applyLayout();
      renderList();
      renderThread();
      send({ type: 'slack:open', conversation: id });
    }

    function selectThread(ts) {
      threadTs = ts;
      threadData = null;
      loadingThread = true;
      followScroll = true;
      renderThread();
      send({ type: 'slack:open', conversation: selectedId, thread: ts });
    }

    function showList() {
      pane = 'list';
      applyLayout();
    }

    function draftKey() { return selectedId + '\u0000' + (threadTs || ''); }

    function renderThread() {
      threadPane.innerHTML = '';

      if (!selectedId) {
        const empty = el('div', 'ns-thread-empty');
        empty.textContent = 'Pick a conversation';
        threadPane.appendChild(empty);
        return;
      }

      const conv = findConversation(selectedId);
      const head = el('header', 'ns-thread-head');
      const backHere = el('button', 'ghost icon-only ns-thread-back', { type: 'button', 'aria-label': 'Back' });
      backHere.innerHTML = BACK;
      backHere.addEventListener('click', showList);
      head.appendChild(backHere);

      const avatar = el('span', 'ns-avatar');
      avatar.textContent = (conv && conv.with && conv.with.initials) || initialsOf(conv && conv.title);
      head.appendChild(avatar);

      const titleWrap = el('div', 'ns-thread-title');
      const titleText = el('span');
      titleText.textContent = (conv && conv.title) || '';
      titleWrap.appendChild(titleText);
      if (conv && conv.vip) {
        const star = el('span', 'ns-star');
        star.innerHTML = STAR;
        titleWrap.appendChild(star);
      }
      head.appendChild(titleWrap);

      const openBtn = el('button', 'ghost ns-open-slack', { type: 'button' });
      openBtn.textContent = 'Open in Slack';
      openBtn.addEventListener('click', () => send({
        type: 'slack:link', conversation: selectedId,
        ts: (threadData && threadData.messages && threadData.messages.length)
          ? threadData.messages[threadData.messages.length - 1].ts : undefined
      }));
      head.appendChild(openBtn);
      threadPane.appendChild(head);

      if (banner && banner.conversation === selectedId) {
        const bar = el('div', 'ns-banner');
        const text = el('span');
        text.textContent = banner.text;
        const dismiss = el('button', 'ghost icon-only', { type: 'button', 'aria-label': 'Dismiss' });
        dismiss.innerHTML = icon('x');
        dismiss.addEventListener('click', () => { banner = null; renderThread(); });
        bar.appendChild(text);
        bar.appendChild(dismiss);
        threadPane.appendChild(bar);
      }

      if (errorToast) {
        const toast = el('div', 'ns-toast');
        toast.textContent = errorToast;
        threadPane.appendChild(toast);
      }

      const scroller = el('div', 'ns-messages');
      scroller.addEventListener('scroll', () => {
        followScroll = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
      });
      threadPane.appendChild(scroller);

      if (loadingThread || !threadData) {
        scroller.innerHTML = '<div class="ns-loading">Loading…</div>';
      } else {
        renderMessages(scroller, threadData.messages || []);
      }

      threadPane.appendChild(buildComposer());

      if (followScroll) scroller.scrollTop = scroller.scrollHeight;
    }

    function renderMessages(scroller, messages) {
      scroller.innerHTML = '';
      let lastDay = null;
      let lastGroupKey = null;
      let lastGroupAt = 0;
      let group = null;

      for (const m of messages) {
        const day = m.at ? dayLabel(m.at) : lastDay;
        if (day && day !== lastDay) {
          const sep = el('div', 'ns-day');
          sep.textContent = day;
          scroller.appendChild(sep);
          lastDay = day;
          lastGroupKey = null;
        }

        const key = m.mine ? 'me' : m.user;
        const fresh = key !== lastGroupKey || (m.at - lastGroupAt) > GROUP_GAP_MS;
        if (fresh) {
          group = el('div', 'ns-group' + (m.mine ? ' mine' : ''));
          scroller.appendChild(group);
          const headRow = el('div', 'ns-msg-head');
          const name = el('span', 'ns-msg-name');
          name.textContent = m.mine ? 'You' : (m.name || m.user || '');
          const time = el('span', 'ns-msg-time');
          time.textContent = fmtClock(m.at, state ? state.clock : '24h');
          headRow.appendChild(name);
          headRow.appendChild(time);
          group.appendChild(headRow);
        }
        lastGroupKey = key;
        lastGroupAt = m.at;

        const bubble = el('div', 'ns-msg');
        bubble.innerHTML = m.html; // sanitised by the laptop (src/slack/mrkdwn.js)
        group.appendChild(bubble);

        if (m.replyCount) {
          const replies = el('button', 'ns-replies', { type: 'button' });
          replies.textContent = m.replyCount + (m.replyCount === 1 ? ' reply' : ' replies');
          replies.addEventListener('click', () => selectThread(m.threadTs || m.ts));
          group.appendChild(replies);
        }
      }
    }

    function buildComposer() {
      if (state && state.mayReply === false) {
        const locked = el('div', 'ns-composer ns-locked');
        locked.textContent = 'This phone can only watch. Let it send prompts on the laptop to reply.';
        return locked;
      }

      const wrap = el('div', 'ns-composer');

      if (threadTs) {
        const chip = el('div', 'ns-thread-chip');
        const label = el('span');
        label.textContent = 'Replying in thread';
        const clear = el('button', 'ghost icon-only', { type: 'button', 'aria-label': 'Reply to channel instead' });
        clear.innerHTML = icon('x');
        clear.addEventListener('click', () => { threadTs = null; threadData = null; loadingThread = true; renderThread(); send({ type: 'slack:open', conversation: selectedId }); });
        chip.appendChild(label);
        chip.appendChild(clear);
        wrap.appendChild(chip);
      }

      const row = el('div', 'ns-composer-row');
      const textarea = el('textarea', 'ns-input', {
        rows: '1', placeholder: 'Message…', 'aria-label': 'Message'
      });
      textarea.value = drafts.get(draftKey()) || '';
      const sendBtn = el('button', 'ns-send icon-only', { type: 'button', 'aria-label': 'Send' });
      sendBtn.innerHTML = icon('send');
      sendBtn.disabled = sending;

      const grow = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px'; };
      textarea.addEventListener('input', () => { drafts.set(draftKey(), textarea.value); grow(); });
      textarea.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        // On the phone Enter is a newline; a Send button does the sending.
        if (host.classList.contains('compact')) return;
        e.preventDefault();
        doSend(textarea);
      });
      sendBtn.addEventListener('click', () => doSend(textarea));

      row.appendChild(textarea);
      row.appendChild(sendBtn);
      wrap.appendChild(row);

      const hint = el('div', 'ns-hint');
      hint.textContent = 'Sending marks this read in Slack. Reading here doesn’t.';
      wrap.appendChild(hint);

      if (sendError) {
        const err = el('div', 'ns-send-error');
        err.textContent = sendError;
        wrap.appendChild(err);
      }

      setTimeout(grow, 0);
      return wrap;
    }

    const pendingSends = new Map(); // id -> { conversation, thread, text }

    function doSend(textarea) {
      const text = textarea.value.trim();
      if (!text || sending) return;
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      sending = true;
      sendError = null;
      const msg = { type: 'slack:reply', id, conversation: selectedId, text };
      if (threadTs) msg.thread = threadTs;
      pendingSends.set(id, { conversation: selectedId, thread: threadTs, text });
      send(msg);
      // Optimistic lock: the button is disabled until slack:sent answers, but
      // the words stay in the box until it is a success.
      const btn = threadPane.querySelector('.ns-send');
      if (btn) btn.disabled = true;
    }

    // ── VIP sheet ──────────────────────────────────────────────

    function renderVips() {
      vipChips.innerHTML = '';
      const list = (state && state.vipList) || [];
      const resolved = (state && state.vips) || [];
      const unresolved = (state && state.unresolved) || [];
      const editable = !state || state.mayEdit !== false;
      for (const entry of list) {
        const isUnresolved = unresolved.includes(entry);
        const found = !isUnresolved && resolved.find((v) => v.name === entry || v.id === entry);
        const chip = el('span', 'ns-vip-chip' + (isUnresolved ? ' unresolved' : ''));
        const label = el('span');
        label.textContent = found ? found.name : entry;
        chip.appendChild(label);
        if (isUnresolved) {
          const warn = el('span', 'ns-vip-warn');
          warn.textContent = 'Not found in Slack';
          chip.appendChild(warn);
        }
        if (editable) {
          const x = el('button', 'ghost icon-only', { type: 'button', 'aria-label': 'Remove ' + entry });
          x.innerHTML = icon('x');
          x.addEventListener('click', () => {
            const next = list.filter((e) => e !== entry);
            send({ type: 'slack:vips', vips: next });
          });
          chip.appendChild(x);
        }
        vipChips.appendChild(chip);
      }
      vipForm.hidden = !editable;
    }

    vipBtn.addEventListener('click', () => { vipOpen = true; vipSheet.hidden = false; renderVips(); vipInput.focus(); });
    host.querySelector('.ns-vip-close').addEventListener('click', () => { vipOpen = false; vipSheet.hidden = true; });
    vipSheet.addEventListener('click', (e) => { if (e.target === vipSheet) { vipOpen = false; vipSheet.hidden = true; } });
    vipForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = vipInput.value.trim();
      if (!value) return;
      const list = ((state && state.vipList) || []).concat([value]);
      send({ type: 'slack:vips', vips: list });
      vipInput.value = '';
    });

    gearBtn.addEventListener('click', () => send({ type: 'slack:settings' }));

    // ── keyboard ─────────────────────────────────────────────

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (vipOpen) { vipOpen = false; vipSheet.hidden = true; return; }
        if (onePane && pane === 'thread') { showList(); return; }
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && listBody.contains(document.activeElement)) {
        e.preventDefault();
        const idx = conversations.findIndex((c) => c.id === selectedId);
        const next = e.key === 'ArrowDown' ? Math.min(conversations.length - 1, idx + 1) : Math.max(0, idx - 1);
        if (conversations[next]) {
          select(conversations[next].id);
          const row = listBody.querySelector('[data-id="' + CSS.escape(conversations[next].id) + '"]');
          if (row) row.focus();
        }
      }
    });

    // ── visibility ─────────────────────────────────────────────

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && selectedId) send({ type: 'slack:open', conversation: selectedId, thread: threadTs || undefined });
    });

    // ── the live "waiting Xm" pills and relative times ──────────

    setInterval(() => {
      if (!document.hidden) { renderList(); if (threadPane.querySelector('.ns-thread-head')) renderThread(); }
    }, PENDING_TICK_MS);

    // ── receiving from the laptop ────────────────────────────

    function receive(message) {
      if (!message || typeof message.type !== 'string') return;
      switch (message.type) {
        case 'slack:state': {
          state = message.state;
          renderConn();
          renderList();
          if (selectedId) renderThread();
          break;
        }
        case 'slack:signedIn': {
          signInBusy = false;
          if (message.ok) {
            // The state that follows will leave the setup card behind; clear
            // the pasted values so they do not linger in the page.
            signInError = null;
            sessionDraft.token = '';
            sessionDraft.cookie = '';
          } else {
            signInError = message.message || 'Slack did not accept that session.';
            if (state && !state.hasTokens) renderSetup();
          }
          break;
        }
        case 'slack:thread': {
          if (!message.conversation || message.conversation.id !== selectedId) break;
          if ((message.thread || null) !== (threadTs || null)) break;
          threadData = message;
          loadingThread = false;
          renderThread();
          break;
        }
        case 'slack:sent': {
          sending = false;
          const pending = pendingSends.get(message.id);
          pendingSends.delete(message.id);
          if (message.ok) {
            drafts.delete(draftKey());
            sendError = null;
          } else {
            sendError = message.reason || 'Could not send.';
            if (pending) drafts.set(pending.conversation + '\u0000' + (pending.thread || ''), pending.text);
          }
          renderThread();
          break;
        }
        case 'slack:focus': {
          const conv = (state && state.conversations || []).find((c) => c.id === message.conversation);
          const waited = conv ? fmtWaiting(conv.pendingSince) : 'waiting';
          select(message.conversation);
          banner = {
            conversation: message.conversation,
            text: (conv ? conv.title : 'Someone') + ' has been ' + waited
          };
          renderThread();
          break;
        }
        case 'slack:link': {
          if (message.url) openUrl(message.url);
          break;
        }
        case 'slack:refused': {
          errorToast = message.reason || 'Refused.';
          renderThread();
          say(errorToast);
          break;
        }
        default: break;
      }
    }

    renderConn();
    renderList();
    renderThread();
    renderVips();

    return {
      receive,
      select,
      setConnected(on) { transportUp = !!on; renderConn(); }
    };
  }

  const api = { mount };
  root.NikSlack = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // Auto-mount for the editor webview: media/icons.js then this file are
  // loaded by a page that has already put `<div id="slack-root"></div>` in
  // its body, so this runs after that element exists.
  if (typeof root.acquireVsCodeApi === 'function') {
    const mountNode = document.getElementById('slack-root');
    if (mountNode) {
      const vscode = root.acquireVsCodeApi();
      const instance = mount({
        root: mountNode,
        send: (msg) => vscode.postMessage(msg)
      });
      root.addEventListener('message', (event) => {
        const data = event.data;
        if (data && typeof data.type === 'string' && data.type.indexOf('slack:') === 0) instance.receive(data);
      });
      vscode.postMessage({ type: 'slack:ready' });
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
