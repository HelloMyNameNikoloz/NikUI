/* Slack, as a page inside NikUI: the same client in a VS Code webview tab on
   the laptop and on a page of the phone app. Nothing here knows which one it
   is in — it is handed `send` to talk back and fed messages through
   `receive`; everything else is DOM and a little state.

   The laptop decides what counts as a VIP, what mayReply and mayEdit mean,
   and what the connection pill says; this file only draws what it is told
   and keeps the untrusted half of that — names, titles, last-message text —
   out of innerHTML. The one thing that *is* trusted HTML is a message body,
   because the laptop has already run it through src/slack/mrkdwn.js.

   The shape follows Slack's own app — a sidebar of direct messages and
   channels, the open conversation wide beside it — but drawn to Apple's
   Human Interface Guidelines: a large title that collapses as the sidebar
   scrolls, iMessage-style bubbles, a capsule composer. */
(function (root) {
  'use strict';

  const icon = typeof root.icon === 'function' ? root.icon : function () { return ''; };

  // Glyphs icons.js does not carry, drawn the same way everything in it is: a
  // stroke path in currentColor, so they sit beside it without looking
  // borrowed.
  const STAR = '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2.5l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.8-6.2 3.8 1.6-7-5.4-4.8 7.1-.7z"/></svg>';
  const BACK = '<svg class="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m15 18-6-6 6-6"/></svg>';
  const SEARCH = '<svg class="ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
  const LOCK = '<svg class="ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const OPEN_EXT = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>';
  const SEND_UP = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 19V6"/><path d="m6 11 6-6 6 6"/></svg>';
  const FILE_ICO = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  const BELL_SLASH = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8.7 3.3A6 6 0 0 1 18 8v5c0 .6.1 1.2.4 1.7"/>' +
    '<path d="M4 8a6 6 0 0 0-1 3.4V13c0 2.5-1 4-2 5h14"/>' +
    '<path d="M9 21a3 3 0 0 0 5.3 1.1"/><path d="M2 2l20 20"/></svg>';

  const ONE_PANE_WIDTH = 640;
  const GROUP_GAP_MS = 5 * 60 * 1000;
  const PENDING_TICK_MS = 15 * 1000;
  const LIST_SCROLL_COLLAPSE = 24; // px of list-body scroll before the large title gives way
  const REFRESH_MIN_GAP_MS = 15 * 1000;

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

  /** A list row's time: "now", then minutes, then the clock, then a weekday or date. */
  function fmtWhen(at, clock) {
    if (!at) return '';
    const diff = Date.now() - at;
    if (diff < 45 * 1000) return 'now';
    if (diff < 3600 * 1000) return Math.max(1, Math.round(diff / 60000)) + 'm';
    const d = new Date(at);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtClock(at, clock);
    const dayMs = 24 * 3600 * 1000;
    if (now - d < 6 * dayMs) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
    if (now - d < 6 * 24 * 3600 * 1000) return d.toLocaleDateString([], { weekday: 'long' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /** A deterministic hue for a name, so the same person always gets the same
      colour without a server round trip. */
  function hueOf(seed) {
    const s = String(seed || '?');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
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
    let items = [];                // flattened sidebar rows, sorted & sectioned
    let selectedId = null;
    let threadTs = null;           // the thread currently open, or null for the main channel
    let threadData = null;         // the slack:thread payload matching selectedId/threadTs
    let loadingThread = false;
    let loadingOlder = false;      // slack:older in flight — one at a time
    let scroller = null;           // the current .ns-messages (the scrolling element)
    let inner = null;              // its content wrapper — what ResizeObserver watches
    let msgResizeObserver = null;
    let fileObserver = null;       // IntersectionObserver that lazily asks for image bytes
    const fileCache = new Map();   // file id -> { ok, dataUrl }
    let menuEl = null;             // the open row context menu, or null
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
    let searchQuery = '';
    let lastRefreshAt = 0;
    const sessionDraft = { token: '', cookie: '' };
    const drafts = new Map();      // `${conv}\u0000${thread||''}` -> text

    // ── shell, built once ──────────────────────────────────────

    host.innerHTML =
      '<div class="ns-live sr-only" aria-live="polite"></div>' +
      '<div class="ns-panes">' +
        '<section class="ns-list" aria-label="Conversations">' +
          '<header class="ns-head">' +
            '<div class="ns-head-bar">' +
              '<button type="button" class="ns-back ghost icon-only" hidden aria-label="Back"></button>' +
              '<span class="ns-head-inline-title">Slack</span>' +
              '<span class="ns-pill ns-conn">Checking…</span>' +
              '<button type="button" class="ns-refresh ghost icon-only" aria-label="Refresh"></button>' +
              '<button type="button" class="ns-vipbtn ghost" aria-label="VIPs"></button>' +
              '<button type="button" class="ns-gear ghost icon-only" aria-label="Settings"></button>' +
            '</div>' +
            '<h1 class="ns-head-large">Slack</h1>' +
            '<div class="ns-search">' +
              '<span class="ns-search-ico"></span>' +
              '<input type="search" class="ns-search-input" placeholder="Search" aria-label="Search" autocomplete="off" spellcheck="false">' +
            '</div>' +
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
    const backBtn = host.querySelector('.ns-back');
    const connPill = host.querySelector('.ns-conn');
    const refreshBtn = host.querySelector('.ns-refresh');
    const vipBtn = host.querySelector('.ns-vipbtn');
    const gearBtn = host.querySelector('.ns-gear');
    const listPane = host.querySelector('.ns-list');
    const listBody = host.querySelector('.ns-list-body');
    const searchInput = host.querySelector('.ns-search-input');
    const threadPane = host.querySelector('.ns-thread');
    const vipSheet = host.querySelector('.ns-vip-sheet');
    const vipChips = host.querySelector('.ns-vip-chips');
    const vipForm = host.querySelector('.ns-vip-add');
    const vipInput = vipForm.querySelector('input');

    backBtn.innerHTML = BACK;
    vipBtn.innerHTML = STAR + '<span>VIPs</span>';
    gearBtn.innerHTML = icon('settings');
    refreshBtn.innerHTML = icon('refresh');
    host.querySelector('.ns-search-ico').innerHTML = SEARCH;
    host.querySelector('.ns-vip-close').innerHTML = icon('x');
    vipForm.querySelector('button').innerHTML = icon('plus');

    if (goBack) {
      backBtn.hidden = false;
      backBtn.addEventListener('click', goBack);
    }

    host.classList.toggle('compact', onePane);

    function say(text) { live.textContent = text; }

    // ── the page itself never scrolls ───────────────────────────
    //
    // In the real webview, scrolling a conversation has been seen to scroll
    // the whole tab — the sidebar sliding off the top. `html`/`body`/`.nik-slack`
    // are pinned in CSS, but an element with `overflow: hidden` can still be
    // scrolled *programmatically* (a stray `.focus()` without `preventScroll`,
    // a `scrollIntoView`, an anchor). This is the backstop: whatever moved one
    // of them, snap it back the same tick, every time.
    function resetAncestorScroll() {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      const docEl = document.documentElement;
      if (docEl.scrollTop || docEl.scrollLeft) { docEl.scrollTop = 0; docEl.scrollLeft = 0; }
      if (document.body.scrollTop || document.body.scrollLeft) { document.body.scrollTop = 0; document.body.scrollLeft = 0; }
      if (host.scrollTop || host.scrollLeft) { host.scrollTop = 0; host.scrollLeft = 0; }
    }
    window.addEventListener('scroll', resetAncestorScroll, true);
    document.addEventListener('scroll', resetAncestorScroll, true);
    document.documentElement.addEventListener('scroll', resetAncestorScroll);
    document.body.addEventListener('scroll', resetAncestorScroll);
    host.addEventListener('scroll', resetAncestorScroll);

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

    // ── the sidebar nav bar: large title collapses as the list scrolls ──

    listBody.addEventListener('scroll', () => {
      listPane.classList.toggle('scrolled', listBody.scrollTop > LIST_SCROLL_COLLAPSE);
      listPane.classList.toggle('hairline', listBody.scrollTop > 0);
    });

    // ── connection pill ───────────────────────────────────────

    function renderConn() {
      connPill.className = 'ns-pill ns-conn';
      if (!transportUp) { connPill.classList.add('off'); connPill.textContent = 'Offline'; return; }
      if (!state) { connPill.classList.add('warn'); connPill.textContent = 'Checking…'; return; }
      if (state.error) { connPill.classList.add('off'); connPill.textContent = state.error; return; }
      if (!state.connected) { connPill.classList.add('off'); connPill.textContent = 'Offline'; return; }
      if (state.socket === 'live' || (state.mode === 'poll' && state.connected)) {
        connPill.classList.add('on'); connPill.textContent = 'Live'; return;
      }
      if (state.socket === 'connecting') { connPill.classList.add('warn'); connPill.textContent = 'Checking every 20s'; return; }
      connPill.classList.add('off');
      connPill.textContent = state.socket === 'unavailable' ? 'Unavailable' : 'Offline';
    }

    // ── the sidebar data: the new contract, or built from the old shape ──

    /** state.sidebar.items, or — until the service sends one, or on an old
        build — a best-effort row built from state.conversations. */
    function sidebarItems() {
      if (state && state.sidebar && state.sidebar.loaded && Array.isArray(state.sidebar.items)) {
        return state.sidebar.items.slice();
      }
      const list = (state && state.conversations) || [];
      return list.map((c) => ({
        id: c.id,
        kind: c.kind === 'channel' ? 'channel' : (c.kind === 'group' ? 'group' : 'dm'),
        title: c.title,
        private: !!c.private,
        user: c.with || null,
        latestAt: c.lastAt,
        unread: c.unread || (c.pending ? 1 : 0),
        mentions: c.mentions || 0,
        last: c.last ? { text: c.last.text, from: c.last.from, mine: !!c.last.mine, at: c.lastAt } : null,
        pending: !!c.pending,
        pendingSince: c.pendingSince || null,
        vip: !!c.vip,
        muted: !!c.muted,
        mutedIn: c.mutedIn || null
      }));
    }

    function matchesSearch(item, q) {
      if (!q) return true;
      const hay = (item.title + ' ' + (item.last ? item.last.text : '')).toLowerCase();
      return hay.indexOf(q) !== -1;
    }

    // A muted row still belongs to its section — it just sorts after
    // everything in it that is not muted, the order between muted rows
    // unchanged from whatever the section's own comparator said.
    function mutedLast(cmp) {
      return (a, b) => (a.muted ? 1 : 0) - (b.muted ? 1 : 0) || cmp(a, b);
    }

    function sections() {
      const all = sidebarItems().filter((it) => matchesSearch(it, searchQuery));
      const needsYou = all.filter((it) => it.pending)
        .sort(mutedLast((a, b) => (a.pendingSince || 0) - (b.pendingSince || 0)));
      // A pending conversation lives in "Needs you" only — showing it again
      // below would say the same thing twice in two different voices.
      const dms = all.filter((it) => !it.pending && (it.kind === 'dm' || it.kind === 'group'))
        .sort(mutedLast((a, b) => (b.latestAt || 0) - (a.latestAt || 0)));
      const channels = all.filter((it) => !it.pending && it.kind === 'channel')
        .sort(mutedLast((a, b) => (b.latestAt || 0) - (a.latestAt || 0)));
      return [
        { title: 'Needs you', rows: needsYou },
        { title: 'Direct messages', rows: dms },
        { title: 'Channels', rows: channels }
      ].filter((s) => s.rows.length);
    }

    // ── the list ───────────────────────────────────────────────

    function renderList() {
      items = sidebarItems();

      if (!state) {
        listBody.innerHTML = '<div class="ns-empty">Connecting…</div>';
        return;
      }
      if (!state.hasTokens) { renderSetup(); return; }
      if (!state.enabled) { renderDisabled(); return; }

      if (!items.length) {
        listBody.innerHTML = '';
        const empty = el('div', 'ns-empty');
        empty.textContent = 'Nothing yet. Messages from your VIPs and @mentions appear here.';
        listBody.appendChild(empty);
        return;
      }

      const secs = sections();
      listBody.innerHTML = '';
      if (!secs.length) {
        const empty = el('div', 'ns-empty');
        empty.textContent = 'No matches.';
        listBody.appendChild(empty);
        return;
      }
      for (const s of secs) {
        const section = el('div', 'ns-section');
        const h = el('h2', 'ns-section-title');
        h.textContent = s.title;
        section.appendChild(h);
        const ul = el('ul', 'ns-rows', { role: 'list' });
        for (const it of s.rows) ul.appendChild(buildRow(it));
        section.appendChild(ul);
        listBody.appendChild(section);
      }
    }

    function buildAvatar(item, starred) {
      const span = el('span', 'ns-avatar ns-avatar-' + item.kind);
      if (item.kind === 'dm') {
        if (item.user && item.user.image) {
          const img = el('img');
          img.src = item.user.image;
          img.alt = '';
          span.appendChild(img);
        } else {
          span.style.background = 'hsl(' + hueOf((item.user && item.user.name) || item.title) + 'deg 52% 40%)';
          span.style.color = '#fff';
          const label = el('span');
          label.textContent = (item.user && item.user.initials) || initialsOf(item.title);
          span.appendChild(label);
        }
      } else if (item.kind === 'channel') {
        span.innerHTML = item.private ? LOCK : '#';
      } else {
        span.style.background = 'hsl(' + hueOf(item.title) + 'deg 42% 34%)';
        span.style.color = '#fff';
        const label = el('span');
        label.textContent = initialsOf(item.title);
        span.appendChild(label);
      }
      if (starred) {
        const star = el('span', 'ns-star');
        star.innerHTML = STAR;
        span.appendChild(star);
      }
      return span;
    }

    function previewText(item) {
      if (!item.last) return '';
      if (item.last.mine) return 'You: ' + item.last.text;
      if ((item.kind === 'channel' || item.kind === 'group') && item.last.from) {
        return item.last.from + ': ' + item.last.text;
      }
      return item.last.text;
    }

    function buildRow(item) {
      const li = el('li', null, { role: 'listitem' });
      const row = el('button', 'ns-row' + (item.id === selectedId ? ' on' : '') + (item.muted ? ' muted' : ''),
        { type: 'button', 'data-id': item.id });

      const gutter = el('span', 'ns-row-gutter');
      if (item.unread > 0 && !item.muted) gutter.appendChild(el('span', 'ns-dot'));
      row.appendChild(gutter);

      row.appendChild(buildAvatar(item, item.vip));

      const main = el('div', 'ns-row-main');
      const top = el('div', 'ns-row-top');
      const title = el('span', 'ns-title' + (item.unread > 0 && !item.muted ? ' unread' : ''));
      title.textContent = item.title;
      top.appendChild(title);
      if (item.muted) {
        const bell = el('span', 'ns-muted-ico', { 'aria-label': 'Muted' });
        bell.innerHTML = BELL_SLASH;
        top.appendChild(bell);
      }
      // A pending row spends its top-line slot on how long it has waited,
      // in place of the time — the preview line underneath is one thing
      // already (what it says), not a second thing fighting it for room.
      if (item.pending) {
        const pill = el('span', 'ns-pending');
        pill.textContent = fmtWaiting(item.pendingSince);
        top.appendChild(pill);
      } else {
        const time = el('span', 'ns-time');
        time.textContent = fmtWhen(item.latestAt, state.clock);
        top.appendChild(time);
      }

      const bottom = el('div', 'ns-row-bottom');
      const lastText = el('span', 'ns-last');
      lastText.textContent = previewText(item);
      bottom.appendChild(lastText);
      if (item.mentions > 0) {
        const badge = el('span', 'ns-badge' + (item.muted ? ' ns-badge-muted' : ''));
        badge.textContent = String(item.mentions);
        bottom.appendChild(badge);
      }

      main.appendChild(top);
      main.appendChild(bottom);
      row.appendChild(main);
      row.addEventListener('click', () => select(item.id));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openRowMenu(item, e.clientX, e.clientY);
      });
      let pressTimer = null;
      row.addEventListener('touchstart', () => {
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          const r = row.getBoundingClientRect();
          openRowMenu(item, r.left + r.width / 2, r.top + r.height / 2);
        }, 500);
      }, { passive: true });
      row.addEventListener('touchend', () => clearTimeout(pressTimer));
      row.addEventListener('touchmove', () => clearTimeout(pressTimer));
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        openRowMenu(item, r.left + 10, r.bottom);
      });
      li.appendChild(row);
      return li;
    }

    // ── the row context menu: Mute/Unmute, Open in Slack ───────────────

    function closeRowMenu() {
      if (!menuEl) return;
      menuEl.remove();
      menuEl = null;
      document.removeEventListener('keydown', onMenuKeydown);
      document.removeEventListener('mousedown', onMenuOutside, true);
    }
    function onMenuKeydown(e) { if (e.key === 'Escape') closeRowMenu(); }
    function onMenuOutside(e) { if (menuEl && !menuEl.contains(e.target)) closeRowMenu(); }

    function openRowMenu(item, x, y) {
      closeRowMenu();
      const watchOnly = state && state.mayReply === false;
      menuEl = el('div', 'ns-ctx-menu', { role: 'menu', 'aria-label': 'Conversation options' });

      const addItem = (label, opts) => {
        opts = opts || {};
        const btn = el('button', 'ns-ctx-item' + (opts.disabled ? ' disabled' : ''),
          { type: 'button', role: 'menuitem' });
        const lbl = el('span', 'ns-ctx-label');
        lbl.textContent = label;
        btn.appendChild(lbl);
        if (opts.subtitle) {
          const sub = el('span', 'ns-ctx-sub');
          sub.textContent = opts.subtitle;
          btn.appendChild(sub);
        }
        if (opts.disabled) {
          btn.disabled = true;
        } else {
          btn.addEventListener('click', () => { closeRowMenu(); if (opts.onClick) opts.onClick(); });
        }
        menuEl.appendChild(btn);
        return btn;
      };

      if (!watchOnly) {
        if (item.muted) {
          addItem('Unmute', {
            disabled: item.mutedIn === 'slack',
            subtitle: item.mutedIn === 'slack' ? 'Muted in Slack' : undefined,
            onClick: () => send({ type: 'slack:mute', conversation: item.id, muted: false })
          });
        } else {
          addItem('Mute', { onClick: () => send({ type: 'slack:mute', conversation: item.id, muted: true }) });
        }
        menuEl.appendChild(el('div', 'ns-ctx-sep'));
      }
      addItem('Open in Slack', { onClick: () => send({ type: 'slack:link', conversation: item.id }) });

      host.appendChild(menuEl);
      const rect = menuEl.getBoundingClientRect();
      const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
      menuEl.style.left = left + 'px';
      menuEl.style.top = top + 'px';
      document.addEventListener('keydown', onMenuKeydown);
      document.addEventListener('mousedown', onMenuOutside, true);
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

    // ── search ───────────────────────────────────────────────

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim().toLowerCase();
      renderList();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!searchInput.value) return;
      e.stopPropagation();
      searchInput.value = '';
      searchQuery = '';
      renderList();
    });

    // ── thread ───────────────────────────────────────────────

    function findConversation(id) {
      return items.find((c) => c.id === id) || (threadData && threadData.conversation);
    }

    function select(id) {
      closeRowMenu();
      selectedId = id;
      threadTs = null;
      threadData = null;
      loadingThread = true;
      loadingOlder = false;
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

    function subtitleFor(conv) {
      if (!conv) return '';
      if (conv.kind === 'channel') return conv.private ? 'Private channel' : 'Channel';
      if (conv.kind === 'group') return 'Group message';
      return 'Direct message';
    }

    function renderThread() {
      // A full rebuild — a new message pushed from the server, a banner
      // dismissed — replaces the scroller with a fresh element, whose
      // scrollTop starts at 0. Not following the bottom, that would silently
      // yank a reader who had scrolled up back to the top; remember where
      // they were and put the new scroller back there.
      const prevScrollTop = scroller ? scroller.scrollTop : 0;
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

      if (conv) head.appendChild(buildAvatar(conv, false));

      const titleWrap = el('div', 'ns-thread-title');
      const titleRow = el('div', 'ns-thread-title-row');
      const titleText = el('span');
      titleText.textContent = (conv && conv.title) || '';
      titleRow.appendChild(titleText);
      if (conv && conv.vip) {
        const star = el('span', 'ns-star');
        star.innerHTML = STAR;
        titleRow.appendChild(star);
      }
      titleWrap.appendChild(titleRow);
      const sub = el('span', 'ns-thread-sub');
      sub.textContent = subtitleFor(conv);
      titleWrap.appendChild(sub);
      head.appendChild(titleWrap);

      const openBtn = el('button', 'ghost icon-only ns-open-slack', { type: 'button', 'aria-label': 'Open in Slack' });
      openBtn.innerHTML = OPEN_EXT;
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

      scroller = el('div', 'ns-messages');
      inner = el('div', 'ns-messages-inner');
      scroller.appendChild(inner);
      scroller.addEventListener('scroll', () => {
        followScroll = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        if (scroller.scrollTop < 200) requestOlder();
      });
      threadPane.appendChild(scroller);

      if (fileObserver) fileObserver.disconnect();
      fileObserver = (typeof IntersectionObserver === 'function')
        ? new IntersectionObserver(onFileVisible, { root: scroller, rootMargin: '200px' })
        : null;

      if (loadingThread || !threadData) {
        inner.innerHTML = '<div class="ns-loading">Loading…</div>';
      } else {
        renderMessages(inner, threadData.messages || [], conv, threadData.hasMore);
      }

      threadPane.appendChild(buildComposer());

      if (followScroll) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = prevScrollTop;

      // Pinned to the bottom, the transcript should stay there as its own
      // content grows — an image finishing, a new message arriving — the
      // same way Messages does. Observing the content wrapper (not the
      // scroller, whose own box never resizes) is what notices that.
      if (msgResizeObserver) msgResizeObserver.disconnect();
      if (typeof ResizeObserver === 'function') {
        msgResizeObserver = new ResizeObserver(() => {
          if (followScroll) scroller.scrollTop = scroller.scrollHeight;
        });
        msgResizeObserver.observe(inner);
      }
    }

    // ── loading older messages, scrolled near the top ──────────────────

    function requestOlder() {
      if (loadingThread || loadingOlder || !threadData) return;
      if (threadData.hasMore === false) return;
      const messages = threadData.messages;
      if (!messages || !messages.length) return;
      loadingOlder = true;
      const spinner = el('div', 'ns-older-spinner');
      spinner.innerHTML = '<span class="ns-spinner" aria-hidden="true"></span>';
      inner.insertBefore(spinner, inner.firstChild);
      send({ type: 'slack:older', conversation: selectedId, thread: threadTs || undefined, before: messages[0].ts });
    }

    // ── images: a sized placeholder, filled in lazily ──────────────────

    function imageBoxSize(w, h) {
      const maxW = 320, maxH = 320;
      w = Number(w) > 0 ? Number(w) : 160;
      h = Number(h) > 0 ? Number(h) : 160;
      const scale = Math.min(1, maxW / w, maxH / h);
      return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
    }

    function applyFileResult(node, result) {
      if (result.ok) {
        const img = node.querySelector('img');
        if (img) img.src = result.dataUrl;
        node.classList.add('loaded');
      } else if (node.parentNode) {
        node.parentNode.replaceChild(fileChip(node._nsFile), node);
      }
    }

    function onFileVisible(entries) {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const node = entry.target;
        fileObserver.unobserve(node);
        const id = node.dataset.fileId;
        if (!id) continue;
        if (fileCache.has(id)) { applyFileResult(node, fileCache.get(id)); continue; }
        send({ type: 'slack:file', id });
      }
    }

    function fileImageNode(file) {
      const { w, h } = imageBoxSize(file.w, file.h);
      const wrap = el('div', 'ns-image', { style: 'width:' + w + 'px;height:' + h + 'px' });
      wrap._nsFile = file;
      if (file.id) wrap.dataset.fileId = file.id;
      const img = el('img');
      img.alt = (file && (file.name || file.title)) || 'Image';
      wrap.appendChild(img);
      wrap.addEventListener('click', () => { if (img.src) openLightbox(img.src, img.alt); });
      if (file.id && fileCache.has(file.id)) {
        applyFileResult(wrap, fileCache.get(file.id));
      } else if (fileObserver) {
        fileObserver.observe(wrap);
      }
      return wrap;
    }

    function openLightbox(src, alt) {
      const overlay = el('div', 'ns-lightbox', { role: 'dialog', 'aria-modal': 'true' });
      const img = el('img');
      img.src = src;
      img.alt = alt || '';
      overlay.appendChild(img);
      function onKey(e) { if (e.key === 'Escape') close(); }
      function close() {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
      overlay.addEventListener('click', close);
      document.addEventListener('keydown', onKey);
      host.appendChild(overlay);
    }

    function fileChip(file) {
      const chip = el('div', 'ns-file');
      const ico = el('span', 'ns-file-ico');
      ico.innerHTML = FILE_ICO;
      chip.appendChild(ico);
      const label = el('span', 'ns-file-name');
      label.textContent = (file && (file.name || file.title)) || 'File';
      chip.appendChild(label);
      return chip;
    }

    function reactionsRow(reactions) {
      const row = el('div', 'ns-reactions');
      for (const r of reactions) {
        const chip = el('span', 'ns-reaction' + (r.mine ? ' mine' : ''));
        chip.textContent = (r.emoji || '') + ' ' + r.count;
        row.appendChild(chip);
      }
      return row;
    }

    function renderMessages(container, messages, conv, hasMore) {
      container.innerHTML = '';
      if (hasMore === false) {
        const begin = el('div', 'ns-begin');
        begin.textContent = 'Beginning of conversation';
        container.appendChild(begin);
      }
      const named = conv && (conv.kind === 'channel' || conv.kind === 'group');
      let lastDay = null;
      let lastGroupKey = null;
      let lastAnyAt = 0;
      let group = null;
      let lastBubble = null;

      for (const m of messages) {
        const day = m.at ? dayLabel(m.at) : lastDay;
        if (day && day !== lastDay) {
          const sep = el('div', 'ns-day');
          sep.textContent = day;
          container.appendChild(sep);
          lastDay = day;
          lastGroupKey = null;
          lastAnyAt = 0;
        }

        const key = m.mine ? 'me' : m.user;
        const gap = lastAnyAt ? m.at - lastAnyAt : Infinity;
        const fresh = key !== lastGroupKey || gap > GROUP_GAP_MS;

        if (fresh && lastAnyAt && gap > GROUP_GAP_MS) {
          const timeHead = el('div', 'ns-time-cluster');
          timeHead.textContent = fmtClock(m.at, state ? state.clock : '24h');
          container.appendChild(timeHead);
        }

        if (fresh) {
          group = el('div', 'ns-group' + (m.mine ? ' mine' : ''));
          container.appendChild(group);
          lastBubble = null;
          if (named && !m.mine) {
            const nameHead = el('div', 'ns-msg-name');
            nameHead.textContent = m.name || m.user || '';
            nameHead.style.color = 'hsl(' + hueOf(m.name || m.user) + 'deg 70% 62%)';
            group.appendChild(nameHead);
          }
        }
        lastGroupKey = key;
        lastAnyAt = m.at;

        const hasText = m.html && /\S/.test(m.html.replace(/<[^>]*>/g, ''));
        // Files used to arrive as a bare count; now each is an object, and an
        // image one carries enough to draw a placeholder before any bytes
        // are asked for.
        const files = Array.isArray(m.files)
          ? m.files.map((f) => (f && typeof f === 'object') ? f : { name: 'File' })
          : [];
        const hasFiles = files.length > 0;

        const bubbleWrap = el('div', 'ns-bubble-wrap');
        if (hasText) {
          const bubble = el('div', 'ns-msg');
          bubble.innerHTML = m.html; // sanitised by the laptop (src/slack/mrkdwn.js)
          if (m.edited) {
            const edited = el('span', 'ns-edited');
            edited.textContent = ' (edited)';
            bubble.appendChild(edited);
          }
          bubbleWrap.appendChild(bubble);
          if (lastBubble) lastBubble.classList.remove('tail');
          bubble.classList.add('tail');
          lastBubble = bubble;
        } else if (hasFiles) {
          for (const f of files) bubbleWrap.appendChild(f.image ? fileImageNode(f) : fileChip(f));
        } else {
          const bubble = el('div', 'ns-msg ns-msg-empty');
          bubble.textContent = '(message)';
          bubbleWrap.appendChild(bubble);
          if (lastBubble) lastBubble.classList.remove('tail');
          bubble.classList.add('tail');
          lastBubble = bubble;
        }
        group.appendChild(bubbleWrap);

        if (Array.isArray(m.reactions) && m.reactions.length) {
          group.appendChild(reactionsRow(m.reactions));
        }

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
      sendBtn.innerHTML = SEND_UP;
      sendBtn.disabled = sending || !textarea.value.trim();

      const grow = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'; };
      textarea.addEventListener('input', () => {
        drafts.set(draftKey(), textarea.value);
        grow();
        sendBtn.disabled = sending || !textarea.value.trim();
      });
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

    vipBtn.addEventListener('click', () => { vipOpen = true; vipSheet.hidden = false; renderVips(); vipInput.focus({ preventScroll: true }); });
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

    // ── refresh: on becoming visible/focused, or asked for — never more
    //    than once every 15s, since nothing on the other end is waiting on it ──

    function maybeRefresh() {
      const now = Date.now();
      if (now - lastRefreshAt < REFRESH_MIN_GAP_MS) return;
      lastRefreshAt = now;
      send({ type: 'slack:refresh' });
    }
    refreshBtn.addEventListener('click', maybeRefresh);

    // ── keyboard ─────────────────────────────────────────────

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (vipOpen) { vipOpen = false; vipSheet.hidden = true; return; }
        if (document.activeElement === searchInput && searchInput.value) return; // handled above
        if (onePane && pane === 'thread') { showList(); return; }
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && listBody.contains(document.activeElement)) {
        e.preventDefault();
        const idx = items.findIndex((c) => c.id === selectedId);
        const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
        if (items[next]) {
          select(items[next].id);
          const row = listBody.querySelector('[data-id="' + CSS.escape(items[next].id) + '"]');
          if (row) row.focus({ preventScroll: true });
        }
      }
    });

    // ── visibility ─────────────────────────────────────────────

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (selectedId) send({ type: 'slack:open', conversation: selectedId, thread: threadTs || undefined });
      maybeRefresh();
    });
    window.addEventListener('focus', maybeRefresh);

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
          threadData.hasMore = message.hasMore !== false;
          loadingThread = false;
          loadingOlder = false;
          renderThread();
          break;
        }
        case 'slack:older': {
          if (!message.conversation || message.conversation.id !== selectedId) break;
          if ((message.thread || null) !== (threadTs || null)) break;
          loadingOlder = false;
          if (!threadData || !scroller || !inner) break;
          const spinner = inner.querySelector('.ns-older-spinner');
          if (spinner) spinner.remove();
          const prevHeight = scroller.scrollHeight;
          const prevTop = scroller.scrollTop;
          threadData.messages = (message.messages || []).concat(threadData.messages || []);
          threadData.hasMore = message.hasMore !== false;
          renderMessages(inner, threadData.messages, findConversation(selectedId), threadData.hasMore);
          // Keep whatever the reader was looking at in place: the content
          // grew above it, so the same delta has to come off the top.
          scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
          break;
        }
        case 'slack:file': {
          const ok = !!message.ok && typeof message.dataUrl === 'string' && message.dataUrl.indexOf('data:') === 0;
          const result = { ok, dataUrl: ok ? message.dataUrl : null };
          fileCache.set(message.id, result);
          if (inner) {
            const node = inner.querySelector('.ns-image[data-file-id="' + CSS.escape(message.id) + '"]');
            if (node) applyFileResult(node, result);
          }
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
          const conv = sidebarItems().find((c) => c.id === message.conversation);
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
