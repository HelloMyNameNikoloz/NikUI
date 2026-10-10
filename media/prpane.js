/* The GitHub pane: a per-instance drawer showing the pull request this
   instance is about. A header chip (built here, drawn beside the title)
   toggles it open; the drawer itself lives in the `#pr-pane` aside that
   src/page.js already puts beside the transcript.

   Everything GitHub sends is untrusted. Free text goes through
   window.renderMarkdown (which escapes first) or window.escapeHtml; a link
   only ever opens by asking the host for `pr:open`, and only when it points
   at https://github.com/ — nothing here ever sets `location` or an `href`
   that the page would follow on its own. Avatars are rendered as <img>, never
   as a link; a broken one falls back to an initial letter, set by an `error`
   listener (image errors do not bubble, so it is attached with capture). */
(function (root) {
  'use strict';

  const esc = root.escapeHtml || ((s) => String(s == null ? '' : s));
  const md = root.renderMarkdown || esc;
  const icon = typeof root.icon === 'function' ? root.icon : function () { return ''; };

  // Glyphs icons.js does not carry, drawn the same way: a 24x24 stroke path
  // in currentColor (or, for the tiny status dot, a filled 8x8 one).
  function customIcon(paths, size) {
    size = size || 13;
    return '<svg class="ico" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + paths + '</svg>';
  }
  const BUBBLE = customIcon('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>', 12);
  const EXTERNAL = customIcon('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>', 12);
  const GIT_OPEN = customIcon('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>', 13);
  const GIT_MERGE = customIcon('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>', 13);
  const GIT_CLOSED = customIcon('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="M11 6h5"/><path d="m16 4 4 4"/><path d="m20 4-4 4"/>', 13);
  const GIT_COMMIT = customIcon('<path d="M3 12h3"/><circle cx="12" cy="12" r="4"/><path d="M18 12h3"/>', 13);
  const ARROW_DOWN = customIcon('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>', 18);
  const GITHUB_MARK = '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>';
  const MINIMIZE_PATH = '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10 21 3"/><path d="M3 21l7-7"/>';
  const ALERT = customIcon('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 14);
  const ALERT_SMALL = customIcon('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 12);
  const DOT = '<svg class="ico pr-dot-ico" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>';
  const STATE_ICON = { open: GIT_OPEN, merged: GIT_MERGE, closed: GIT_CLOSED, draft: GIT_OPEN };

  const DEFAULT_WIDTH = 420;
  const MIN_WIDTH = 320;
  const OVERLAY_BELOW = 760;
  const WIDE_ABOVE = 900; // the pane's own width above which the sidebar shows
  const TABS = [
    { id: 'conversation', label: 'Conversation' },
    { id: 'threads', label: 'Threads' },
    { id: 'commits', label: 'Commits' },
    { id: 'checks', label: 'Checks' },
    { id: 'files', label: 'Files changed' }
  ];
  const RENAME_TAB = { overview: 'conversation', comments: 'threads' };
  const STATE_WORD = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' };
  const CHECK_ICON = { pass: 'check', fail: 'alert', pending: 'clock', skipped: 'x', neutral: 'x' };
  const REVIEW_LABEL = {
    APPROVED: 'approved these changes', CHANGES_REQUESTED: 'requested changes',
    COMMENTED: 'reviewed', DISMISSED: 'review dismissed'
  };

  function isGithubUrl(url) { return /^https:\/\/github\.com\//i.test(String(url || '')); }
  function normTab(t) { return RENAME_TAB[t] || t || 'conversation'; }

  // `at` fields travel as either a millisecond number or (per the snapshot
  // contract) an ISO string — accept either and never let a bad one surface
  // as "NaNd ago".
  function toMs(at) {
    if (at == null) return null;
    if (typeof at === 'number') return Number.isFinite(at) ? at : null;
    const t = Date.parse(at);
    return Number.isNaN(t) ? null : t;
  }

  function fmtAgo(at) {
    const t = toMs(at);
    if (t == null) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function fmtDur(ms) {
    if (!ms || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  }

  function dayLabel(ms) {
    if (ms == null) return '';
    try {
      return 'Commits on ' + new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) { return ''; }
  }

  // ── avatars: an <img>, with an initial-letter circle behind it that shows
  // through once the image is missing or fails to load. ────────────────────

  function initialOf(login) {
    const s = String(login || '').trim();
    return s ? s[0].toUpperCase() : '?';
  }
  function hueOf(login) {
    const s = String(login || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function avatar(login, url, size) {
    // Sizes are classes and the colour is set after rendering: the editor's
    // content-security policy drops every style="" attribute, which left the
    // circles sized by whatever flexbox gave them.
    size = [18, 20, 24, 32, 40].includes(size) ? size : 24;
    const img = url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : '';
    return '<span class="avatar s' + size + '" data-initial="' + esc(initialOf(login)) + '" data-hue="' + hueOf(login) + '" title="' + esc(login || '') + '">' + img + '</span>';
  }

  /** Colours set through the DOM, which the CSP allows, rather than in markup. */
  function paintStyles(root) {
    root.querySelectorAll('[data-hue]').forEach((el) => el.style.setProperty('--hue', el.getAttribute('data-hue')));
    root.querySelectorAll('[data-bg]').forEach((el) => {
      const bg = el.getAttribute('data-bg');
      if (bg) { el.style.background = bg; el.style.color = el.getAttribute('data-fg') || ''; }
    });
  }

  function labelTextColor(hex) {
    const h = String(hex || '').replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return '#fff';
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#1b1f24' : '#fff';
  }
  function labelChip(l, small) {
    const hex = String(l.color || '888888').replace(/^#/, '');
    return '<span class="pr-label-chip' + (small ? ' sm' : '') + '" data-bg="' + esc(/^[0-9a-fA-F]{6}$/.test(String(hex)) ? '#' + hex : '') + '" data-fg="' + labelTextColor(hex) + '">' + esc(l.name) + '</span>';
  }
  function reviewerStateIcon(state) {
    const s = (state || '').toUpperCase();
    if (s === 'APPROVED') return icon('check', 12);
    if (s === 'CHANGES_REQUESTED') return icon('x', 12);
    if (s === 'COMMENTED') return BUBBLE;
    return DOT; // pending
  }

  const REVIEW_ORDER = { CHANGES_REQUESTED: 0, APPROVED: 1, COMMENTED: 2, DISMISSED: 3, PENDING: 4 };
  const REVIEW_WORD = {
    CHANGES_REQUESTED: 'Changes requested', APPROVED: 'Approved', COMMENTED: 'Commented',
    DISMISSED: 'Dismissed', PENDING: 'Awaiting review'
  };

  /** Where each reviewer stands, the way GitHub's Reviewers box says it: one
   *  line each, what blocks the merge first. Stale and re-requested say so. */
  function reviewSummary(reviewers) {
    if (!reviewers || !reviewers.length) return '';
    const sorted = reviewers.slice().sort((a, b) =>
      (REVIEW_ORDER[a.state] == null ? 5 : REVIEW_ORDER[a.state]) - (REVIEW_ORDER[b.state] == null ? 5 : REVIEW_ORDER[b.state]));
    return '<ul class="pr-head-reviews" aria-label="Reviewers">' + sorted.map((r) => {
      const state = (r.state || 'PENDING').toUpperCase();
      const word = REVIEW_WORD[state] || state.toLowerCase().replace(/_/g, ' ');
      const why = r.stale
        ? (state === 'APPROVED' ? 'New commits since this approval' : 'The pull request has moved on since: new commits or replies after it')
        : '';
      const when = r.at ? ' · ' + fmtAgo(r.at) : '';
      return '<li class="pr-rv ' + esc(state.toLowerCase()) + (r.stale ? ' stale' : '') + '" title="' + esc(r.login + ': ' + word + when + (why ? ' — ' + why : '')) + '">' +
        avatar(r.login, r.avatar, 20) +
        '<span class="pr-rv-login">' + esc(r.login) + '</span>' +
        (r.rerequested ? '<span class="pr-rv-again" title="Asked to review again">' + icon('refresh', 11) + '</span>' : '') +
        '<span class="pr-rv-state">' + reviewerStateIcon(state) + esc(word) + '</span>' +
        (r.stale ? '<span class="pr-rv-stale">stale</span>' : '') +
        '</li>';
    }).join('') + '</ul>';
  }

  function changeBar(adds, dels) {
    const total = (adds || 0) + (dels || 0);
    const blocks = [];
    if (!total) { for (let i = 0; i < 5; i++) blocks.push('grey'); }
    else {
      const addBlocks = Math.max(0, Math.min(5, Math.round((adds / total) * 5)));
      for (let i = 0; i < 5; i++) blocks.push(i < addBlocks ? 'add' : 'del');
    }
    return '<span class="pr-changebar">' + blocks.map((c) => '<i class="' + c + '"></i>').join('') + '</span>';
  }

  /** A unified diff, split into per-file hunks for the Files tab. */
  function parseDiff(text) {
    const files = [];
    let current = null;
    for (const line of String(text || '').split('\n')) {
      if (/^diff --git /.test(line)) {
        current = { path: '', lines: [] };
        files.push(current);
        continue;
      }
      if (!current) { current = { path: '', lines: [] }; files.push(current); }
      if (/^\+\+\+ /.test(line)) {
        const m = line.match(/^\+\+\+ [ab]?\/?(.*)$/);
        if (m && m[1] && m[1] !== '/dev/null') current.path = m[1];
        continue;
      }
      if (/^--- /.test(line) || /^index /.test(line)) continue;
      current.lines.push(line);
    }
    return files;
  }

  function diffLineClass(line) {
    if (/^@@/.test(line)) return 'hunk';
    if (/^\+/.test(line)) return 'add';
    if (/^-/.test(line)) return 'del';
    return '';
  }

  /** Older snapshots have no `timeline`: fold comments and reviews into one,
      oldest first, so the Conversation tab still has something to show. */
  function buildTimeline(st) {
    if (Array.isArray(st.timeline)) return st.timeline;
    const items = [];
    (st.comments || []).forEach((c) => items.push({
      kind: 'comment', id: c.id, author: c.author, avatar: c.avatar || null,
      body: c.body, at: c.at, url: c.url, edited: c.edited
    }));
    (st.reviews || []).forEach((r) => items.push({
      kind: 'review', id: r.id || (r.author + '-' + r.at), author: r.author, avatar: r.avatar || null,
      state: r.state, body: r.body, at: r.at, url: r.url
    }));
    items.sort((a, b) => (toMs(a.at) || 0) - (toMs(b.at) || 0));
    return items;
  }

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.chip   the header chip, already in the DOM
   * @param {HTMLElement} opts.host  the `<aside>` drawer, already in the DOM
   * @param {HTMLElement} [opts.split] the row splitting chat from the drawer,
   *   measured to decide overlay vs. side-by-side
   * @param {(msg: object) => void} opts.send
   * @param {boolean} [opts.phone] a phone: the pane is the whole screen, and
   *   whether it is open is this device's business, not the instance's
   */
  function mount(opts) {
    const chip = opts.chip;
    const host = opts.host;
    const split = opts.split || host.parentElement;
    const send = opts.send || function () {};
    // On a phone, opening GitHub there must not open it on the laptop (nor the
    // laptop's pane open itself on the phone), so the view lives here, per PR,
    // and the host is only told that someone is looking — which keeps it fresh.
    const phone = !!opts.phone;
    const PHONE_KEY = 'nikui.prpane.';
    if (phone) host.classList.add('phone', 'full');

    let meta = {};
    let view = { open: false, tab: 'conversation', width: null, full: false }; // mirrors meta.prPane
    let prState = { prUrl: null, loading: false, error: null, state: null };
    let diff = { loaded: false, loading: false, text: '', truncated: false, forUrl: null };
    let busy = false;
    let done = null; // { message } shown briefly after an action
    let doneTimer = null;
    let overlay = false;
    const drafts = new Map(); // thread id (or '' for the top-level box) -> text

    // ── layout: split vs. overlay, wide vs. narrow ────────────

    function measure() {
      const narrow = split.clientWidth < OVERLAY_BELOW;
      if (narrow !== overlay) { overlay = narrow; host.classList.toggle('overlay', overlay); }
    }
    function measureWide() {
      host.classList.toggle('wide', host.clientWidth >= WIDE_ABOVE);
    }
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(measure).observe(split);
      new ResizeObserver(measureWide).observe(host);
    } else {
      window.addEventListener('resize', measure);
      window.addEventListener('resize', measureWide);
    }

    function applyWidth() {
      const w = Math.max(MIN_WIDTH, Math.min(view.width || DEFAULT_WIDTH, Math.round(split.clientWidth * 0.7)));
      host.style.width = w + 'px';
    }

    // ── talking to the chip ────────────────────────────────────

    function paintChip() {
      if (!meta.prUrl) { chip.hidden = true; return; }
      chip.hidden = false;
      const st = prState.state;
      const number = (st && st.number) || (String(meta.prUrl).match(/\/(\d+)$/) || [])[1];
      const bits = [(phone ? customIcon(GITHUB_MARK, 14) : '') + '<span class="pr-chip-num">#' + esc(number || '?') + '</span>'];
      if (st && st.checkSummary) {
        const cs = st.checkSummary;
        const dotClass = cs.fail > 0 ? 'fail' : (cs.pending > 0 ? 'pending' : (cs.pass > 0 ? 'pass' : ''));
        if (dotClass) bits.push('<span class="pr-chip-dot ' + dotClass + '"></span>');
      }
      if (conflicted(st)) bits.push('<span class="pr-chip-conflict" aria-label="Merge conflicts">' + ALERT_SMALL + '</span>');
      const unresolved = st ? (st.threads || []).filter((t) => !t.resolved).length : 0;
      if (unresolved) bits.push('<span class="pr-chip-bubble">' + BUBBLE + esc(unresolved) + '</span>');
      chip.innerHTML = bits.join('');
      paintStyles(chip);
      chip.title = (view.open ? 'Close' : 'Open') + ' the pull request panel' +
        (st ? ' — ' + (STATE_WORD[st.state] || st.state) + (st.isDraft ? ' (draft)' : '') : '') +
        (conflicted(st) ? ', with merge conflicts' : '');
      chip.setAttribute('aria-expanded', String(view.open));
    }

    // ── opening / closing / switching tabs / full page ─────────

    let lastSent = null; // what we last told the host, so its echo is not mistaken for someone else's change

    function sendPane() {
      if (phone) {
        try { localStorage.setItem(PHONE_KEY + meta.prUrl, JSON.stringify({ open: view.open, tab: view.tab })); } catch (_) { /* private mode */ }
        send({ type: 'pr:watch', on: view.open });
        return;
      }
      lastSent = JSON.stringify(view);
      send({ type: 'pr:pane', open: view.open, tab: view.tab, width: view.width, full: !!view.full });
    }

    // ── moving in and out, the way iOS pushes a page ──────────
    // On a phone or as a full page the PR slides in from the right on Apple's
    // spring curve while what was there slides a quarter left and dims; as a
    // drawer it slides in while the chat makes room. Closing runs it backwards.
    // `pr-pushed` on <body> exists only while something moves: a transform
    // left on the chat would trap its fixed-position pieces.

    const OPEN_MS = 480;
    const CLOSE_MS = 380;
    let moveTimer = null;
    const still = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const covers = () => host.classList.contains('full') || phone;

    function settle() {
      clearTimeout(moveTimer);
      moveTimer = null;
      host.classList.remove('moving', 'entering', 'leaving', 'dragging');
      host.style.transform = '';
      document.body.classList.remove('pr-moving', 'pr-pushed', 'pr-dragging');
      document.body.style.removeProperty('--pr-drag');
    }

    function slideIn() {
      settle();
      host.hidden = false;
      if (still()) return;
      host.style.setProperty('--pr-w', host.offsetWidth + 'px');
      host.classList.add('entering');
      void host.offsetWidth; // the start has to be drawn before the move
      host.classList.add('moving');
      if (covers()) document.body.classList.add('pr-moving', 'pr-pushed');
      host.classList.remove('entering');
      moveTimer = setTimeout(settle, OPEN_MS + 40);
    }

    function slideOut(from) {
      if (host.hidden || still()) { settle(); host.hidden = true; return; }
      clearTimeout(moveTimer);
      host.style.setProperty('--pr-w', host.offsetWidth + 'px');
      if (covers()) {
        // Start from where the page under it would be, then let it come back.
        if (!from) { document.body.classList.add('pr-pushed'); void document.body.offsetWidth; }
        document.body.classList.add('pr-moving');
        document.body.classList.remove('pr-pushed', 'pr-dragging');
        document.body.style.removeProperty('--pr-drag');
      }
      host.classList.remove('dragging');
      host.style.transform = '';
      host.classList.add('moving', 'leaving');
      moveTimer = setTimeout(function () { settle(); if (!view.open) host.hidden = true; }, CLOSE_MS + 40);
    }

    function setOpen(open, how) {
      if (view.open === open) return;
      view.open = open;
      if (!open) closePicker();
      if (open) {
        // Laid out and filled before it moves, so what slides in is the page.
        host.hidden = false;
        measure(); applyWidth(); measureWide();
        if (!diff.loaded && view.tab === 'files') requestDiff();
        render();
        slideIn();
      } else {
        slideOut(how);
      }
      sendPane();
      paintChip();
    }

    function toggle() { setOpen(!view.open); }

    function setTab(tab) {
      if (!TABS.some((t) => t.id === tab) || view.tab === tab) return;
      view.tab = tab;
      sendPane();
      if (tab === 'files' && !diff.loaded && !diff.loading) requestDiff();
      const body = host.querySelector('.pr-pane-body');
      if (body) body.scrollTop = 0; // a new tab starts at its top
      render();
      // On a phone the tab row is wider than the screen; keep the one you
      // swiped to in sight.
      const on = phone && host.querySelector('.pr-tab.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'center', block: 'nearest' });
    }

    function setFull(full) {
      full = !!full;
      if (view.full === full) return;
      view.full = full;
      host.classList.toggle('full', full);
      sendPane();
      measureWide();
      render();
    }

    function requestDiff() {
      const key = prState.state ? prState.state.headSha || prState.state.url : null;
      if (diff.loading || (diff.loaded && diff.forUrl === key)) return;
      diff.loading = true;
      send({ type: 'pr:diff' });
    }

    // ── chip & global wiring ────────────────────────────────────

    chip.addEventListener('click', toggle);

    // A phone swipes between tabs, left for the next and right for the one
    // before. Not from inside anything that scrolls sideways itself (code, a
    // table, the tab row) or while typing, and only when the finger
    // moved clearly more across than down, so reading never flips a tab.
    if (phone) {
      // Android's back button closes the PR before it leaves the conversation.
      (window.NikBack = window.NikBack || []).push(function () {
        if (!view.open) return false;
        setOpen(false);
        return true;
      });

      // From the left edge the page follows the finger, and lets go the way
      // iOS does: past a third of the way, or flicked, it closes; otherwise
      // it springs back.
      let edge = null;
      host.addEventListener('touchstart', function (e) {
        const t = e.touches[0];
        edge = (e.touches.length === 1 && t.clientX <= 24 && !still()) ? { x: t.clientX, y: t.clientY, at: Date.now(), dx: 0, live: false } : null;
      }, { passive: true });
      host.addEventListener('touchmove', function (e) {
        if (!edge) return;
        const t = e.touches[0];
        const dx = Math.max(0, t.clientX - edge.x);
        if (!edge.live) {
          if (Math.abs(t.clientY - edge.y) > 12 && Math.abs(t.clientY - edge.y) > dx) { edge = null; return; }
          if (dx < 8) return;
          edge.live = true;
          settle();
          host.classList.add('dragging');
          document.body.classList.add('pr-dragging');
        }
        edge.dx = dx;
        edge.lastAt = Date.now();
        host.style.transform = 'translateX(' + dx + 'px)';
        document.body.style.setProperty('--pr-drag', String(Math.min(1, dx / host.offsetWidth)));
      }, { passive: true });
      host.addEventListener('touchend', function () {
        if (!edge || !edge.live) { edge = null; return; }
        const speed = edge.dx / Math.max(1, Date.now() - edge.at);
        const away = edge.dx > host.offsetWidth / 3 || (speed > 0.6 && edge.dx > 40);
        edge = null;
        if (away) { setOpen(false, 'drag'); return; }
        // Spring back to where it was.
        host.classList.remove('dragging');
        host.classList.add('moving');
        host.style.transform = '';
        document.body.classList.remove('pr-dragging');
        document.body.style.removeProperty('--pr-drag');
        clearTimeout(moveTimer);
        moveTimer = setTimeout(settle, OPEN_MS);
      }, { passive: true });

      let start = null;
      host.addEventListener('touchstart', function (e) {
        const t = e.touches[0];
        if (t.clientX <= 24) { start = null; return; } // the edge is for going back
        const own = e.target.closest('pre, table, textarea, input, .pr-tabs');
        start = (e.touches.length === 1 && !own) ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
      }, { passive: true });
      host.addEventListener('touchend', function (e) {
        if (!start) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        const quick = Date.now() - start.at < 700;
        start = null;
        if (!quick || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        const i = TABS.findIndex((tab) => tab.id === view.tab);
        const next = TABS[i + (dx < 0 ? 1 : -1)];
        if (next) setTab(next.id);
      }, { passive: true });
    }
    chip.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    window.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
        e.preventDefault();
        toggle();
      }
    });

    host.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); chip.focus(); }
    });

    // image errors do not bubble, but a capturing listener on an ancestor
    // still sees them — this is the one place a broken avatar is noticed.
    host.addEventListener('error', function (e) {
      const img = e.target;
      if (img && img.tagName === 'IMG' && img.closest('.avatar')) img.classList.add('broken');
    }, true);

    // ── resizing ─────────────────────────────────────────────

    let dragging = null;
    function startDrag(e) {
      e.preventDefault();
      dragging = { x: e.clientX, w: host.getBoundingClientRect().width };
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', stopDrag);
    }
    function onDrag(e) {
      if (!dragging) return;
      const next = dragging.w + (dragging.x - e.clientX);
      view.width = Math.max(MIN_WIDTH, Math.min(next, Math.round(split.clientWidth * 0.7)));
      applyWidth();
    }
    function stopDrag() {
      if (!dragging) return;
      dragging = null;
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', stopDrag);
      sendPane();
    }

    // ── rendering: head ──────────────────────────────────────

    // The header and body's shape before anything has arrived: the shimmer
    // tells the reader something is coming, rather than a single dim line.
    function renderHeadSkeleton() {
      return '<div class="pr-skel pr-skel-head" aria-hidden="true">' +
        '<div class="pr-skel-line pr-skel-title"></div>' +
        '<div class="pr-skel-row"><div class="pr-skel-pill"></div><div class="pr-skel-line pr-skel-sub"></div></div>' +
        '<div class="pr-skel-avatars"><span class="pr-skel-avatar"></span><span class="pr-skel-avatar"></span><span class="pr-skel-avatar"></span></div>' +
        '<div class="pr-skel-line pr-skel-meta"></div>' +
        '</div>';
    }

    function renderBodySkeleton() {
      let html = '<div class="pr-skel pr-skel-body" aria-hidden="true">';
      for (let i = 0; i < 4; i++) {
        html += '<div class="pr-skel-block"><span class="pr-skel-avatar"></span>' +
          '<div class="pr-skel-card"><div class="pr-skel-line w60"></div><div class="pr-skel-line w90"></div><div class="pr-skel-line w40"></div></div></div>';
      }
      return html + '</div>';
    }

    /** Open and in conflict with its base: GitHub says CONFLICTING; UNKNOWN is still being worked out. */
    function conflicted(st) {
      return !!st && st.state === 'OPEN' && st.mergeable === 'CONFLICTING';
    }

    /** Next to the reviews, because it blocks the merge just as a review can. */
    function renderConflict(st) {
      if (!conflicted(st)) return '';
      return '<div class="pr-conflict" role="status">' +
        '<span class="pr-conflict-icon">' + ALERT + '</span>' +
        '<div class="pr-conflict-text"><b>Merge conflicts</b>' +
          '<span>This branch conflicts with <code>' + esc(st.baseRef || 'its base') + '</code>. They must be resolved before it can merge.</span></div>' +
        '<div class="pr-conflict-actions">' +
          '<button type="button" data-ask-conflicts>Ask Claude to resolve</button>' +
          (st.url ? '<a class="pr-conflict-web" href="' + esc(st.url + '/conflicts') + '">Resolve on GitHub ' + EXTERNAL + '</a>' : '') +
        '</div></div>';
    }

    function renderCompactRow(st) {
      // The reviewers are in the header now; this row is what is left.
      const labels = st.labels || [];
      if (!labels.length) return '';
      let html = '<div class="pr-compact-row">';
      if (labels.length) html += '<span class="pr-compact-labels">' + labels.map((l) => labelChip(l, true)).join('') + '</span>';
      html += '</div>';
      return html;
    }

    function renderHead(st) {
      const refreshing = prState.loading;
      const parts = ['<div class="pr-head-top"><div class="pr-head-titleblock">'];
      if (st) {
        const merged = st.state === 'MERGED';
        const closed = st.state === 'CLOSED';
        const stateKey = merged ? 'merged' : (closed ? 'closed' : (st.isDraft ? 'draft' : 'open'));
        const stateLabel = merged ? 'Merged' : (closed ? 'Closed' : (st.isDraft ? 'Draft' : 'Open'));
        const n = Number.isFinite(st.commitCount) ? st.commitCount : ((st.commits || []).length || null);
        const commitWord = n != null ? (n + ' commit' + (n === 1 ? '' : 's')) : 'commits';
        const verb = merged ? 'merged' : 'wants to merge';
        parts.push('<h1 class="pr-title"><a href="' + esc(st.url) + '">' + esc(st.title || '') + '</a> <span class="pr-number">#' + esc(st.number) + '</span></h1>');
        parts.push('<div class="pr-head-more"><div class="pr-head-row"><div class="pr-head-sub">' +
          '<span class="pr-state-pill ' + stateKey + '">' + (STATE_ICON[stateKey] || '') + esc(stateLabel) + '</span>' +
          '<span class="pr-merge-line"><b>' + esc(st.author || '') + '</b> ' + esc(verb) + ' ' + esc(commitWord) +
          ' into <code>' + esc(st.baseRef || '') + '</code> from <code>' + esc(st.headRef || '') + '</code></span>' +
          '</div>' + reviewSummary(st.reviewers) + '</div>');
        parts.push(renderConflict(st));
        parts.push(renderCompactRow(st));
        parts.push('<div class="pr-head-meta">' +
          changeBar(st.additions || 0, st.deletions || 0) +
          '<span class="pr-stat add">+' + esc(st.additions || 0) + '</span>' +
          '<span class="pr-stat del">-' + esc(st.deletions || 0) + '</span>' +
          '<span class="dim">' + esc(st.changedFiles || 0) + ' files changed</span>' +
          (st.updatedAt ? '<span class="dim">updated ' + esc(fmtAgo(st.updatedAt)) + '</span>' :
            (st.fetchedAt ? '<span class="dim">fetched ' + esc(fmtAgo(st.fetchedAt)) + '</span>' : '')) +
          '</div></div>');
      } else if (prState.prUrl && !prState.error) {
        parts.push(renderHeadSkeleton());
      } else {
        parts.push('<span class="pr-title dim">' + (prState.prUrl ? 'Loading the pull request…' : 'No pull request linked') + '</span>');
      }
      parts.push('</div><div class="pr-head-actions">');
      if (!phone) parts.push('<button class="icon-only" data-act="full" title="' + (view.full ? 'Exit full page' : 'Full page') + '" aria-label="Full page">' +
        (view.full ? customIcon(MINIMIZE_PATH, 13) : icon('expand', 13)) + '</button>');
      parts.push('<button class="icon-only pr-refresh' + (refreshing ? ' spinning' : '') + '" data-act="refresh" ' +
        'title="Refresh" aria-label="Refresh">' + (refreshing ? '<span class="spinner"></span>' : icon('refresh', 13)) + '</button>');
      parts.push('<button class="icon-only" data-act="close" title="Close (Esc)" aria-label="Close">' + icon('x', 13) + '</button>');
      parts.push('</div></div>');
      if (prState.error) {
        parts.push('<div class="pr-error-banner">' + icon('alert', 13) + '<span>' + esc(prState.error) + '</span></div>');
      }
      if (done) {
        parts.push('<div class="pr-done-banner' + (done.ok === false ? ' err' : '') + '">' + esc(done.message || (done.ok ? 'Done' : 'Could not do that')) + '</div>');
      }
      return parts.join('');
    }

    function renderTabs(st) {
      const unresolved = st ? (st.threads || []).filter((t) => !t.resolved).length : 0;
      const failing = st && st.checkSummary ? st.checkSummary.fail : 0;
      const files = st ? (Number.isFinite(st.changedFiles) ? st.changedFiles : (st.files || []).length) : 0;
      const commits = st ? (Number.isFinite(st.commitCount) ? st.commitCount : (st.commits || []).length) : 0;
      const timeline = st ? buildTimeline(st).length : 0;
      const counts = { conversation: timeline, threads: unresolved, commits: commits, checks: failing, files: files };
      return '<nav class="pr-tabs" role="tablist">' + TABS.map((t) => {
        const n = counts[t.id];
        return '<button class="pr-tab' + (view.tab === t.id ? ' on' : '') + '" role="tab" aria-selected="' +
          (view.tab === t.id) + '" data-tab="' + t.id + '">' + esc(t.label) +
          (n ? '<span class="pr-tab-badge' + (t.id === 'checks' && n ? ' fail' : '') + '">' + esc(n) + '</span>' : '') +
          '</button>';
      }).join('') + '</nav>';
    }

    // ── rendering: Conversation (GitHub's timeline) ────────────

    function tlRow(cls, gutterHtml, contentHtml) {
      return '<div class="pr-tl-row ' + cls + '"><div class="pr-tl-gutter">' + gutterHtml + '</div>' +
        '<div class="pr-tl-content">' + contentHtml + '</div></div>';
    }

    function renderCommentItem(c) {
      return tlRow('pr-tl-comment', avatar(c.author, c.avatar, 40),
        '<div class="pr-tl-card">' +
          '<div class="pr-tl-card-head"><b>' + esc(c.author || '') + '</b> commented ' +
          '<time>' + esc(fmtAgo(c.at)) + '</time>' + (c.edited ? '<span class="dim pr-edited"> • edited</span>' : '') +
          (c.url ? '<a class="pr-tl-ext" href="' + esc(c.url) + '">' + EXTERNAL + '</a>' : '') + '</div>' +
          '<div class="pr-tl-card-body pr-md">' + md(c.body || '') + '</div>' +
        '</div>');
    }

    function renderReviewItem(r, threads) {
      const state = (r.state || '').toUpperCase();
      const iconHtml = state === 'APPROVED' ? icon('check', 14) : state === 'CHANGES_REQUESTED' ? icon('x', 14) : BUBBLE;
      const inline = (threads || []).filter((t) => t.comments && t.comments[0] && t.comments[0].reviewId === r.id);
      return tlRow('pr-tl-review', avatar(r.author, r.avatar, 40),
        '<div class="pr-tl-card pr-review-card ' + esc(state.toLowerCase()) + '">' +
          '<div class="pr-tl-card-head"><span class="pr-review-icon">' + iconHtml + '</span>' +
          '<b>' + esc(r.author || '') + '</b> ' + esc(REVIEW_LABEL[state] || 'reviewed') +
          ' <time>' + esc(fmtAgo(r.at)) + '</time></div>' +
          (r.body ? '<div class="pr-tl-card-body pr-md">' + md(r.body) + '</div>' : '') +
          (inline.length ? '<div class="pr-review-threads">' + inline.map(renderThread).join('') + '</div>' : '') +
        '</div>');
    }

    function renderCommitsItem(item) {
      const commits = item.commits || [];
      return tlRow('pr-tl-commits', GIT_COMMIT,
        '<ul class="pr-commit-list">' + commits.map((c) =>
          '<li>' + avatar(c.author, c.avatar, 20) +
          '<span class="pr-commit-headline">' + esc(c.headline || '') + '</span>' +
          '<span class="pr-commit-sha">' + esc(c.short || '') + '</span></li>').join('') + '</ul>');
    }

    function renderEventItem(e) {
      return tlRow('pr-tl-event', DOT,
        '<div class="pr-tl-event-line">' + avatar(e.actor, e.avatar, 20) +
          '<span><b>' + esc(e.actor || '') + '</b> ' + esc(e.text || '') + ' · ' + esc(fmtAgo(e.at)) + '</span></div>');
    }

    function renderTimelineItem(item, threads) {
      switch (item.kind) {
        case 'comment': return renderCommentItem(item);
        case 'review': return renderReviewItem(item, threads);
        case 'commits': return renderCommitsItem(item);
        case 'event': return renderEventItem(item);
        default: return '';
      }
    }

    function renderConversation(st) {
      const timeline = buildTimeline(st);
      const total = Number.isFinite(st.timelineTotal) ? st.timelineTotal : timeline.length;
      const threads = st.threads || [];
      let html = '<div class="pr-timeline">';
      if (total > timeline.length) {
        html += '<div class="pr-tl-earlier"><a href="' + esc(st.url) + '">' + esc(total - timeline.length) +
          ' earlier items aren’t shown — open on GitHub</a></div>';
      }
      html += tlRow('pr-tl-comment pr-tl-description', avatar(st.author, st.authorAvatar, 40),
        '<div class="pr-tl-card">' +
          '<div class="pr-tl-card-head"><b>' + esc(st.author || '') + '</b> commented' +
          (st.createdAt ? ' <time>' + esc(fmtAgo(st.createdAt)) + '</time>' : '') + '</div>' +
          '<div class="pr-tl-card-body pr-md">' + (st.body ? md(st.body) : '<span class="dim">No description.</span>') + '</div>' +
        '</div>');
      html += timeline.map((item) => renderTimelineItem(item, threads)).join('');
      html += '</div>';
      const draft = drafts.get('') || '';
      html += '<div class="pr-new-comment">' +
        '<textarea data-draft="" placeholder="Comment on this pull request…">' + esc(draft) + '</textarea>' +
        '<button data-act="comment"' + (busy || !draft.trim() ? ' disabled' : '') + '>Comment</button></div>';
      return html;
    }

    // ── rendering: Threads tab ─────────────────────────────────

    function renderThread(t) {
      const draft = drafts.get(t.id) || '';
      const tail = (t.diffHunk || '').split('\n').slice(-6).join('\n');
      return '<div class="pr-thread' + (t.resolved ? ' resolved' : '') + '">' +
        '<div class="pr-thread-head">' +
        '<span class="pr-thread-path">' + esc(t.path || '') + (t.line ? ':' + esc(t.line) : '') + '</span>' +
        (t.outdated ? '<span class="pr-thread-outdated">outdated</span>' : '') +
        '<button class="link" data-ask-thread="' + esc(t.id) + '">Ask Claude</button>' +
        '<button class="link" data-resolve="' + esc(t.id) + '" data-resolved="' + (!t.resolved) + '"' +
        (busy ? ' disabled' : '') + '>' + (t.resolved ? 'Unresolve' : 'Resolve') + '</button>' +
        '</div>' +
        (tail ? '<pre class="pr-diff-hunk">' + esc(tail) + '</pre>' : '') +
        (t.comments || []).map((c) =>
          '<div class="pr-comment"><div class="pr-comment-head">' + avatar(c.author, c.avatar, 20) + '<b>' + esc(c.author) + '</b><span class="dim">' +
          esc(fmtAgo(c.at)) + '</span>' + (c.url ? '<a href="' + esc(c.url) + '">' + EXTERNAL + '</a>' : '') + '</div>' +
          '<div class="pr-comment-body pr-md">' + md(c.body) + '</div></div>').join('') +
        '<div class="pr-reply">' +
        '<textarea data-draft="' + esc(t.id) + '" placeholder="Reply…">' + esc(draft) + '</textarea>' +
        '<button data-reply="' + esc(t.id) + '"' + (busy || !draft.trim() ? ' disabled' : '') + '>Reply</button>' +
        '</div></div>';
    }

    function renderComments(st) {
      const threads = (st.threads || []).slice();
      const open = threads.filter((t) => !t.resolved);
      const resolved = threads.filter((t) => t.resolved);
      if (!threads.length) return '<div class="pr-empty-tab dim">No review comments.</div>';
      let html = open.map(renderThread).join('');
      if (resolved.length) {
        html += '<details class="pr-resolved-group"><summary>' + resolved.length + ' resolved</summary>' +
          resolved.map(renderThread).join('') + '</details>';
      }
      return html;
    }

    // ── rendering: Commits tab ─────────────────────────────────

    function renderCommitsTab(st) {
      const commits = st.commits || [];
      if (!commits.length) return '<div class="pr-empty-tab dim">No commits.</div>';
      const groups = [];
      let curKey = null, cur = null;
      commits.forEach((c) => {
        const ms = toMs(c.at);
        const key = ms != null ? new Date(ms).toDateString() : '';
        if (key !== curKey) { cur = { ms: ms, commits: [] }; groups.push(cur); curKey = key; }
        cur.commits.push(c);
      });
      return groups.map((g) =>
        '<div class="pr-commit-group"><h5>' + esc(dayLabel(g.ms)) + '</h5><ul class="pr-commit-list">' +
        g.commits.map((c) =>
          '<li>' + avatar(c.author, c.avatar, 24) +
          '<span class="pr-commit-headline">' + esc(c.headline || '') + '</span>' +
          '<span class="pr-commit-sha">' + esc(c.short || '') + '</span>' +
          '<span class="pr-commit-time dim">' + esc(fmtAgo(c.at)) + '</span></li>').join('') +
        '</ul></div>').join('');
    }

    // ── rendering: Checks & Files (unchanged in substance) ──────

    function renderChecks(st) {
      const checks = (st.checks || []).slice().sort((a, b) => {
        const rank = { fail: 0, pending: 1, neutral: 2, skipped: 3, pass: 4 };
        // `fail` ranks 0, which `||` treats as missing — only `in` tells the
        // difference between "ranked first" and "not ranked at all".
        const ra = a.status in rank ? rank[a.status] : 9;
        const rb = b.status in rank ? rank[b.status] : 9;
        return ra - rb;
      });
      if (!checks.length) return '<div class="pr-empty-tab dim">No checks reported.</div>';
      let html = '';
      if (st.checkSummary && st.checkSummary.fail > 0) {
        html += '<div class="pr-checks-actions"><button data-act="rerun"' + (busy ? ' disabled' : '') + '>Re-run failed</button></div>';
      }
      html += '<ul class="pr-checks">' + checks.map((c) => {
        const dur = c.startedAt && c.completedAt ? fmtDur(toMs(c.completedAt) - toMs(c.startedAt)) : '';
        return '<li class="pr-check ' + esc(c.status) + '">' +
          '<span class="pr-check-icon">' + icon(CHECK_ICON[c.status] || 'clock', 13) + '</span>' +
          '<span class="pr-check-name">' + esc(c.name) + (c.workflow ? '<span class="dim"> · ' + esc(c.workflow) + '</span>' : '') + '</span>' +
          (dur ? '<span class="pr-check-dur dim">' + esc(dur) + '</span>' : '') +
          (c.status === 'fail' && c.runId ? '<button class="link" data-ask-check="' + esc(c.runId) + '" data-name="' + esc(c.name) + '">Ask Claude to fix</button>' : '') +
          (c.url ? '<a class="pr-check-open" href="' + esc(c.url) + '">' + EXTERNAL + '</a>' : '') +
          '</li>';
      }).join('') + '</ul>';
      return html;
    }

    function renderFiles(st) {
      const files = st.files || [];
      if (!files.length) return '<div class="pr-empty-tab dim">No files changed.</div>';
      const parsed = diff.loaded ? parseDiff(diff.text) : [];
      const byPath = new Map(parsed.map((f) => [f.path, f]));
      let html = diff.truncated ? '<div class="pr-diff-note dim">The diff was too large to show in full.</div>' : '';
      html += files.map((f) => {
        const d = byPath.get(f.path);
        const body = diff.loading ? '<div class="pr-diff-loading dim">Loading diff…</div>' :
          d ? '<pre class="pr-diff">' + d.lines.map((l) => '<span class="' + diffLineClass(l) + '">' + esc(l) + '</span>').join('\n') + '</pre>' :
          diff.loaded ? '<div class="dim">No diff for this file.</div>' : '<div class="dim">Open this tab to load the diff.</div>';
        return '<details class="pr-file"><summary><span class="pr-file-path">' + esc(f.path) + '</span>' +
          '<span class="pr-file-stat add">+' + esc(f.additions || 0) + '</span>' +
          '<span class="pr-file-stat del">-' + esc(f.deletions || 0) + '</span></summary>' + body + '</details>';
      }).join('');
      return html;
    }

    // ── rendering: sidebar (GitHub's right column) ──────────────

    function renderSidebar(st) {
      const reviewers = st.reviewers || [];
      const assignees = st.assignees || [];
      const labels = st.labels || [];
      if (!reviewers.length && !assignees.length && !labels.length) return '';
      let html = '<aside class="pr-sidebar">';
      if (reviewers.length) {
        html += '<div class="pr-side-section"><h5>Reviewers</h5><ul class="pr-side-list">' +
          reviewers.map((r) => '<li>' + avatar(r.login, r.avatar, 20) + '<span class="pr-side-login">' + esc(r.login) + '</span>' +
            (r.stale ? '<span class="pr-rv-stale" title="The pull request has moved on since this review">stale</span>' : '') +
            '<span class="pr-review-state-icon ' + esc((r.state || '').toLowerCase()) + '">' + reviewerStateIcon(r.state) + '</span></li>').join('') +
          '</ul></div>';
      }
      if (assignees.length) {
        html += '<div class="pr-side-section"><h5>Assignees</h5><ul class="pr-side-list">' +
          assignees.map((a) => '<li>' + avatar(a.login, a.avatar, 20) + '<span class="pr-side-login">' + esc(a.login) + '</span></li>').join('') +
          '</ul></div>';
      }
      if (labels.length) {
        html += '<div class="pr-side-section"><h5>Labels</h5><div class="pr-labels">' +
          labels.map((l) => labelChip(l, false)).join('') + '</div></div>';
      }
      html += '</aside>';
      return html;
    }

    // ── render ───────────────────────────────────────────────

    function renderBody() {
      const st = prState.state;
      if (!meta.prUrl) {
        return '<div class="pr-empty-state">' +
          '<p>No pull request is linked to this instance.</p>' +
          '<button data-act="link">Link a PR…</button></div>';
      }
      if (!st) {
        if (prState.loading) return renderBodySkeleton();
        return '<div class="pr-empty-tab dim">Nothing to show yet.</div>';
      }
      if (view.tab === 'conversation') return renderConversation(st);
      if (view.tab === 'threads') return renderComments(st);
      if (view.tab === 'commits') return renderCommitsTab(st);
      if (view.tab === 'checks') return renderChecks(st);
      if (view.tab === 'files') return renderFiles(st);
      return '';
    }

    function updateScrollBtn() {
      const body = host.querySelector('.pr-pane-body');
      const btn = host.querySelector('.pr-scroll-bottom');
      if (!body || !btn) return;
      if (view.tab !== 'conversation') { btn.hidden = true; return; }
      const remaining = body.scrollHeight - body.scrollTop - body.clientHeight;
      btn.hidden = !(remaining > body.clientHeight);
    }

    // ── render: the pane is rebuilt once, then patched region by region ────
    // Data lands every few seconds while checks run; replacing the whole
    // pane on every one of those flashed every avatar and lost the reader's
    // place. Instead the static shell (resize handle, header, tabs, body,
    // sidebar, scroll button) is built exactly once, and each region's
    // markup is only written back when its own string actually changed —
    // nothing touches a region whose data didn't move, so its nodes (an
    // avatar <img>, say) stay exactly what they were.
    let shellBuilt = false;
    let lastHead, lastTabs, lastBody, lastSidebar; // last markup string written to each region
    let contentShown = false; // real content drawn since the last skeleton, so the fade-in runs once

    function ensureShell() {
      if (shellBuilt && host.querySelector('.pr-pane-inner')) return;
      // The tab nav and the sidebar come and go (no PR linked, a narrow pane,
      // a tab with nothing to show beside it) and are inserted or removed as
      // whole elements below; the header and body never do, so they are the
      // only two built here and kept for the life of the pane.
      host.innerHTML =
        '<div class="pr-resize" data-resize tabindex="0" role="separator" aria-orientation="vertical" ' +
        'aria-label="Resize the pull request pane"></div>' +
        '<div class="pr-pane-inner">' +
        '<header class="pr-pane-head"></header>' +
        '<div class="pr-pane-main">' +
        '<div class="pr-pane-body" tabindex="-1"></div>' +
        '<button class="pr-scroll-bottom" data-act="scrollBottom" hidden title="Scroll to latest" aria-label="Scroll to latest">' + ARROW_DOWN + '</button>' +
        '</div>' +
        '</div>';
      shellBuilt = true;
      lastHead = lastTabs = lastBody = lastSidebar = undefined; // force every region to fill once
      contentShown = false;
      const handle = host.querySelector('[data-resize]');
      handle.addEventListener('mousedown', startDrag);
      handle.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { view.width = Math.min((view.width || DEFAULT_WIDTH) + 16, Math.round(split.clientWidth * 0.7)); applyWidth(); sendPane(); }
        if (e.key === 'ArrowRight') { view.width = Math.max(MIN_WIDTH, (view.width || DEFAULT_WIDTH) - 16); applyWidth(); sendPane(); }
      });
      // The body element now survives every update; its scroll listeners
      // are only ever attached this once, not on every patch.
      const body = host.querySelector('.pr-pane-body');
      body.addEventListener('scroll', updateScrollBtn);
      body.addEventListener('scroll', followHead);
      headLastTop = body.scrollTop;
    }

    function render() {
      if (!view.open) return;
      const st = prState.state;
      ensureShell();

      const header = host.querySelector('.pr-pane-head');
      const body = host.querySelector('.pr-pane-body');
      const scrollBtn = host.querySelector('.pr-scroll-bottom');
      const loading = !st && prState.loading && !!prState.prUrl && !prState.error;

      // A refresh lands every few seconds while checks run: keep the reader's
      // place and the reply they are halfway through typing — only ever at
      // risk from the body region, which is the only one a draft lives in.
      const scrollTop = body.scrollTop;
      const typing = document.activeElement && host.contains(document.activeElement) &&
        document.activeElement.matches('textarea[data-draft]') ? document.activeElement : null;
      const caret = typing ? { key: typing.getAttribute('data-draft'), start: typing.selectionStart, end: typing.selectionEnd } : null;

      if (loading) contentShown = false;
      const revealing = !!st && !contentShown; // the first render where real content replaces the skeleton
      if (st) contentShown = true;

      const headHtml = renderHead(st);
      if (headHtml !== lastHead) {
        header.innerHTML = headHtml;
        lastHead = headHtml;
        paintStyles(header);
      }
      header.setAttribute('aria-busy', String(loading));

      const tabsHtml = meta.prUrl ? renderTabs(st) : '';
      if (tabsHtml !== lastTabs) {
        let nav = host.querySelector('.pr-tabs');
        if (tabsHtml) {
          if (nav) nav.outerHTML = tabsHtml;
          else header.insertAdjacentHTML('afterend', tabsHtml);
          paintStyles(host.querySelector('.pr-tabs'));
        } else if (nav) {
          nav.remove();
        }
        lastTabs = tabsHtml;
      }

      const bodyHtml = renderBody();
      if (bodyHtml !== lastBody) {
        body.innerHTML = bodyHtml;
        lastBody = bodyHtml;
        paintStyles(body);
        body.scrollTop = scrollTop;
        if (caret) {
          const again = Array.from(body.querySelectorAll('textarea[data-draft]')).find((t) => t.getAttribute('data-draft') === caret.key);
          if (again) { again.focus(); try { again.setSelectionRange(caret.start, caret.end); } catch (_) { /* gone */ } }
        }
      }
      rebindPicker();
      body.setAttribute('aria-busy', String(loading));

      const sidebarHtml = st && view.tab === 'conversation' ? renderSidebar(st) : '';
      if (sidebarHtml !== lastSidebar) {
        let aside = host.querySelector('.pr-sidebar');
        if (sidebarHtml) {
          if (aside) aside.outerHTML = sidebarHtml;
          else scrollBtn.insertAdjacentHTML('beforebegin', sidebarHtml);
          paintStyles(host.querySelector('.pr-sidebar'));
        } else if (aside) {
          aside.remove();
        }
        lastSidebar = sidebarHtml;
      }

      if (revealing && !still()) {
        header.classList.add('pr-content-reveal');
        body.classList.add('pr-content-reveal');
      }

      applyHead();
      updateScrollBtn();
    }

    // ── the header gives way to what is being read ───────────
    // Everything between the title and the tabs (state, merge line,
    // reviewers, labels, size) folds away as the body scrolls down, pixel for
    // pixel, and comes back the same way on the way up — the way a phone
    // browser's address bar does. At the top of the page it is always open.

    let headHidden = 0; // px of .pr-head-more currently folded away
    let headLastTop = 0;
    let headSettling = false;

    function headFull() {
      const more = host.querySelector('.pr-head-more');
      if (!more) return 0;
      const was = more.style.height;
      more.style.height = '';
      const h = more.scrollHeight;
      more.style.height = was;
      return h;
    }

    function applyHead() {
      const more = host.querySelector('.pr-head-more');
      if (!more) return;
      const full = headFull();
      headHidden = Math.max(0, Math.min(full, headHidden));
      more.style.height = headHidden ? (full - headHidden) + 'px' : '';
      more.style.opacity = full && headHidden ? String(Math.max(0, 1 - (headHidden / full) * 1.4)) : '';
      host.classList.toggle('head-folded', headHidden >= full && full > 0);
    }

    function followHead(e) {
      const body = e.currentTarget;
      const top = body.scrollTop;
      const delta = top - headLastTop;
      headLastTop = top;
      // A fold changes the body's height, and the browser may move scrollTop
      // to fit; that move is not the reader scrolling.
      if (headSettling) return;
      const before = headHidden;
      if (top <= 0) headHidden = 0;
      else if (delta) headHidden += delta;
      // Pulled against the bottom the browser bounces scrollTop back; do not
      // read that as scrolling up.
      if (delta < 0 && top + body.clientHeight >= body.scrollHeight - 2) headHidden = before;
      if (headHidden === before) return;
      applyHead();
      headSettling = true;
      requestAnimationFrame(function () { headSettling = false; headLastTop = body.scrollTop; });
    }

    // ── events inside the pane ───────────────────────────────

    host.addEventListener('click', function (e) {
      const link = e.target.closest('a[href]');
      if (link) {
        e.preventDefault();
        const url = link.getAttribute('href');
        if (isGithubUrl(url)) send({ type: 'pr:open', url: url });
        return;
      }
      const tab = e.target.closest('[data-tab]');
      if (tab) { setTab(tab.dataset.tab); return; }

      const act = e.target.closest('[data-act]');
      if (act && !act.disabled) {
        switch (act.dataset.act) {
          case 'close': setOpen(false); return;
          case 'refresh': send({ type: 'pr:refresh' }); return;
          case 'link': send({ type: 'pr:link' }); return;
          case 'unlink': send({ type: 'pr:unlink' }); return;
          case 'full': setFull(!view.full); return;
          case 'scrollBottom': {
            const body = host.querySelector('.pr-pane-body');
            if (body) body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
            return;
          }
          case 'rerun': busy = true; send({ type: 'pr:rerun' }); render(); return;
          case 'comment': {
            const body = (drafts.get('') || '').trim();
            if (!body) return;
            busy = true;
            send({ type: 'pr:comment', body: body });
            rememberMentions(body);
            drafts.delete('');
            render();
            return;
          }
        }
      }

      const askThread = e.target.closest('[data-ask-thread]');
      if (askThread) { send({ type: 'pr:askThread', threadId: askThread.dataset.askThread }); return; }

      if (e.target.closest('[data-ask-conflicts]')) { send({ type: 'pr:askConflicts' }); return; }

      const askCheck = e.target.closest('[data-ask-check]');
      if (askCheck) { send({ type: 'pr:askCheck', runId: askCheck.dataset.askCheck, name: askCheck.dataset.name }); return; }

      const resolve = e.target.closest('[data-resolve]');
      if (resolve && !resolve.disabled) {
        busy = true;
        send({ type: 'pr:resolve', threadId: resolve.dataset.resolve, resolved: resolve.dataset.resolved === 'true' });
        render();
        return;
      }

      const reply = e.target.closest('[data-reply]');
      if (reply && !reply.disabled) {
        const id = reply.dataset.reply;
        const body = (drafts.get(id) || '').trim();
        if (!body) return;
        busy = true;
        send({ type: 'pr:reply', threadId: id, body: body });
        rememberMentions(body);
        drafts.delete(id);
        render();
      }
    });

    host.addEventListener('input', function (e) {
      const ta = e.target.closest('[data-draft]');
      if (!ta) return;
      drafts.set(ta.dataset.draft, ta.value);
      updatePicker(ta);
      // Only the Comment/Reply button beside this box needs to flip.
      const btn = ta.parentElement.querySelector('button');
      if (btn) btn.disabled = busy || !ta.value.trim();
    });

    // ── @mentions ────────────────────────────────────────────
    //
    // Typing @ in any comment box opens a list straight away — everybody,
    // with who you mention most on top and a word on why each person is where
    // they are — and every key after it narrows it. ↑↓ move, Enter or Tab puts
    // the name in, Esc puts the list away without closing the pane. The list
    // lives outside the pane body, because a refresh replaces the body every
    // few seconds while checks run; it finds its box again by draft key.

    const M = root.NikMentions;
    let people = { url: null, loaded: false, asked: false, viewer: null, users: [], teams: [], complete: false, error: null, byQuery: new Map() };
    let picker = null; // { key, start, query, items, index }
    let pickerEl = null;
    let queryTimer = null;

    function storage() { try { return window.localStorage; } catch (_) { return null; } }

    function draftBox(key) {
      return Array.from(host.querySelectorAll('textarea[data-draft]')).find((t) => t.getAttribute('data-draft') === key) || null;
    }

    function askPeople(query) {
      if (!meta.prUrl) return;
      if (people.url !== meta.prUrl) people = { url: meta.prUrl, loaded: false, asked: false, viewer: null, users: [], teams: [], complete: false, error: null, byQuery: new Map() };
      if (!query) {
        if (people.asked) return;
        people.asked = true;
        send({ type: 'pr:mentions', query: '' });
        return;
      }
      // Everyone already came with the first answer: nothing to ask GitHub.
      if (people.complete || !people.loaded || people.byQuery.has(query.toLowerCase())) return;
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(function () {
        queryTimer = null;
        people.byQuery.set(query.toLowerCase(), null); // asked, not answered
        send({ type: 'pr:mentions', query: query });
      }, 150);
    }

    function rankFor(query) {
      const st = prState.state;
      const repo = st && st.repo;
      const extra = people.byQuery.get(String(query).toLowerCase());
      const all = (repo && storage() ? M.loadHistory(storage())[repo] : null) || {};
      return M.rank({
        query: query,
        everyone: people.users.concat(extra ? extra.users : [], people.teams, extra ? extra.teams : []),
        parts: M.participants(st, Date.now()),
        avatars: (st && st.avatars) || {},
        history: all,
        viewer: people.viewer,
        now: Date.now(),
        limit: query ? 20 : 50
      });
    }

    function closePicker() {
      picker = null;
      if (pickerEl) { pickerEl.remove(); pickerEl = null; }
      const ta = host.querySelector('textarea[aria-controls="pr-mention-list"]');
      if (ta) { ta.removeAttribute('aria-controls'); ta.removeAttribute('aria-activedescendant'); ta.removeAttribute('aria-expanded'); }
    }

    function updatePicker(ta) {
      if (!M || !ta || ta.selectionStart !== ta.selectionEnd) { closePicker(); return; }
      const hit = M.trigger(ta.value, ta.selectionStart);
      if (!hit) { closePicker(); return; }
      const key = ta.getAttribute('data-draft');
      const same = picker && picker.key === key && picker.start === hit.start;
      const keep = same && picker.items[picker.index] ? picker.items[picker.index].login : null;
      askPeople('');
      askPeople(hit.query);
      const items = rankFor(hit.query);
      // The same person stays selected while the list narrows around them;
      // a new query that drops them starts again from the best match.
      let index = keep ? items.findIndex((p) => p.login === keep) : -1;
      if (index < 0 || (same && hit.query !== picker.query)) index = 0;
      picker = { key: key, start: hit.start, query: hit.query, items: items, index: index };
      drawPicker(ta);
    }

    function marked(text, hits) {
      if (!hits || !hits.length) return esc(text);
      const set = new Set(hits);
      let out = '';
      for (let i = 0; i < text.length; i++) out += set.has(i) ? '<mark>' + esc(text[i]) + '</mark>' : esc(text[i]);
      return out.replace(/<\/mark><mark>/g, '');
    }

    const SECTION = { recent: 'You mention', pr: 'In this pull request', everyone: 'Everyone' };

    function drawPicker(ta) {
      if (!picker) return;
      if (!pickerEl) {
        pickerEl = document.createElement('div');
        pickerEl.className = 'pr-mention' + (phone ? ' phone' : '');
        pickerEl.id = 'pr-mention-list';
        pickerEl.setAttribute('role', 'listbox');
        pickerEl.setAttribute('aria-label', 'People to mention');
        // Keep focus (and the caret) in the box: a click in the list must not blur it.
        pickerEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
        pickerEl.addEventListener('mousemove', function (e) {
          const row = e.target.closest('[data-mention]');
          if (!row || !picker) return;
          const i = Number(row.dataset.mention);
          if (i !== picker.index) { picker.index = i; paintSelection(); }
        });
        pickerEl.addEventListener('click', function (e) {
          const row = e.target.closest('[data-mention]');
          if (row && picker) pick(Number(row.dataset.mention));
        });
        document.body.appendChild(pickerEl);
      }
      const items = picker.items;
      let html = '';
      if (!items.length) {
        const waiting = !people.loaded || people.byQuery.get(picker.query.toLowerCase()) === null;
        html = '<div class="pr-mention-empty">' + (waiting ? '<span class="pr-mention-spin"></span>Looking for people…'
          : people.error ? esc(people.error) : 'Nobody called “' + esc(picker.query) + '” can be mentioned here') + '</div>';
      } else {
        let section = null;
        html = '<div class="pr-mention-list">';
        items.forEach(function (p, i) {
          if (!picker.query && p.section !== section) {
            section = p.section;
            html += '<div class="pr-mention-section" role="presentation">' + esc(SECTION[section]) + '</div>';
          }
          html += '<div class="pr-mention-row" role="option" id="pr-mention-' + i + '" data-mention="' + i + '" aria-selected="' + (i === picker.index) + '">' +
            avatar(p.login, p.avatar, 20) +
            '<span class="pr-mention-who"><span class="pr-mention-login">' + marked(p.login, p.hits.login) + '</span>' +
            (p.name ? '<span class="pr-mention-name">' + marked(p.name, p.hits.name) + '</span>' : '') + '</span>' +
            (p.reason ? '<span class="pr-mention-why">' + esc(p.reason) + '</span>' : '') +
            '</div>';
        });
        html += '</div>';
      }
      html += '<div class="pr-mention-foot">' + (phone ? 'Tap a name to mention them'
        : '<span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> or <kbd>Tab</kbd> mention</span><span><kbd>Esc</kbd> dismiss</span>') + '</div>';
      pickerEl.innerHTML = html;
      paintStyles(pickerEl);
      ta.setAttribute('aria-controls', 'pr-mention-list');
      ta.setAttribute('aria-expanded', 'true');
      paintSelection();
      placePicker(ta);
    }

    function paintSelection() {
      if (!pickerEl || !picker) return;
      pickerEl.querySelectorAll('[data-mention]').forEach((row) => row.setAttribute('aria-selected', String(Number(row.dataset.mention) === picker.index)));
      const row = pickerEl.querySelector('[data-mention="' + picker.index + '"]');
      const ta = draftBox(picker.key);
      if (ta) ta.setAttribute('aria-activedescendant', row ? row.id : '');
      if (row) row.scrollIntoView({ block: 'nearest' });
    }

    // Where the caret is on screen: a hidden copy of the box with the same
    // text up to the caret, and a marker where it ends.
    function caretPoint(ta, pos) {
      const cs = getComputedStyle(ta);
      const mirror = document.createElement('div');
      ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
        'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize']
        .forEach((p) => { mirror.style[p] = cs[p]; });
      mirror.style.position = 'fixed';
      mirror.style.visibility = 'hidden';
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.overflowWrap = 'break-word';
      mirror.style.left = '-9999px';
      mirror.style.top = '0';
      mirror.textContent = ta.value.slice(0, pos);
      const mark = document.createElement('span');
      mark.textContent = '​';
      mirror.appendChild(mark);
      document.body.appendChild(mirror);
      const box = ta.getBoundingClientRect();
      const x = box.left + mark.offsetLeft - ta.scrollLeft;
      const top = box.top + mark.offsetTop - ta.scrollTop;
      const height = mark.offsetHeight || parseFloat(cs.lineHeight) || 16;
      mirror.remove();
      return { x: x, top: top, bottom: top + height, box: box };
    }

    function placePicker(ta) {
      if (!pickerEl || !picker) return;
      const at = caretPoint(ta, picker.start);
      const vv = window.visualViewport;
      const viewH = vv ? vv.height : window.innerHeight;
      const viewW = window.innerWidth;
      const width = phone ? Math.min(viewW - 16, at.box.width) : Math.min(360, viewW - 16);
      pickerEl.style.width = width + 'px';
      const left = phone ? Math.max(8, at.box.left) : Math.max(8, Math.min(at.x - 12, viewW - width - 8));
      pickerEl.style.left = left + 'px';
      const below = viewH - at.bottom - 8;
      const above = at.top - 8;
      const want = Math.min(pickerEl.scrollHeight, 340);
      // Below the caret, as GitHub does — unless it fits better above, which on
      // a phone (keyboard up, box at the bottom) it nearly always does.
      const up = below < want && above > below;
      const room = Math.max(120, (up ? above : below) - 4);
      pickerEl.style.maxHeight = Math.min(340, room) + 'px';
      pickerEl.classList.toggle('up', up);
      if (up) { pickerEl.style.top = ''; pickerEl.style.bottom = (window.innerHeight - at.top + 4) + 'px'; }
      else { pickerEl.style.bottom = ''; pickerEl.style.top = (at.bottom + 4) + 'px'; }
    }

    function pick(i) {
      if (!picker) return;
      const p = picker.items[i];
      const ta = draftBox(picker.key);
      if (!p || !ta) { closePicker(); return; }
      const end = picker.start + 1 + picker.query.length;
      const after = ta.value.slice(end);
      const glue = /^\s/.test(after) ? '' : ' ';
      ta.value = ta.value.slice(0, picker.start) + '@' + p.login + glue + after;
      const caret = picker.start + 1 + p.login.length + 1;
      closePicker();
      ta.focus();
      ta.setSelectionRange(caret, caret);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function rememberMentions(text) {
      const st = prState.state;
      if (!M || !st || !st.repo) return;
      M.remember(storage(), st.repo, M.mentioned(text), Date.now());
    }

    // Capturing, so the pane's own Escape (close the pane) never sees an Escape
    // that was only meant for the list.
    host.addEventListener('keydown', function (e) {
      if (!picker || !e.target.matches || !e.target.matches('textarea[data-draft]')) return;
      const n = picker.items.length;
      const step = (d) => { picker.index = (picker.index + d + n) % n; paintSelection(); };
      let handled = true;
      if (e.key === 'Escape') closePicker();
      else if (!n || e.altKey || e.metaKey) handled = false;
      else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) step(1);
      else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) step(-1);
      else if (e.key === 'PageDown') step(Math.min(5, n - 1 - picker.index) || 0);
      else if (e.key === 'PageUp') step(-Math.min(5, picker.index) || 0);
      else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.ctrlKey && !e.isComposing) pick(picker.index);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // Enter sends, Shift+Enter is a new line — as in the composer. (An open
    // mention list has already taken its Enter above.)
    host.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
      if (!e.target.matches || !e.target.matches('textarea[data-draft]')) return;
      e.preventDefault();
      const btn = e.target.parentElement.querySelector('button');
      if (btn && !btn.disabled) btn.click();
    });

    host.addEventListener('focusin', function (e) {
      if (e.target.matches && e.target.matches('textarea[data-draft]')) askPeople('');
    });
    host.addEventListener('focusout', function (e) {
      if (!picker || !e.target.matches || !e.target.matches('textarea[data-draft]')) return;
      // A tap in the list blurs the box on a phone before its click arrives.
      setTimeout(function () {
        const ta = picker && draftBox(picker.key);
        if (picker && document.activeElement !== ta) closePicker();
      }, 250);
    });
    ['click', 'keyup'].forEach(function (type) {
      host.addEventListener(type, function (e) {
        if (!e.target.matches || !e.target.matches('textarea[data-draft]')) return;
        if (type === 'keyup' && !/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) return;
        updatePicker(e.target);
      });
    });
    host.addEventListener('scroll', function () {
      const ta = picker && draftBox(picker.key);
      if (ta) placePicker(ta);
    }, true);
    window.addEventListener('resize', function () {
      const ta = picker && draftBox(picker.key);
      if (ta) placePicker(ta);
    });

    // After a re-render the box is a new element: point at it again, or let go.
    function rebindPicker() {
      if (!picker) return;
      const ta = draftBox(picker.key);
      if (!ta || document.activeElement !== ta) { closePicker(); return; }
      ta.setAttribute('aria-controls', 'pr-mention-list');
      ta.setAttribute('aria-expanded', 'true');
      placePicker(ta);
    }

    function onMentions(msg) {
      if (!msg || msg.url !== people.url) return;
      const q = String(msg.query || '').toLowerCase();
      const got = { users: msg.users || [], teams: msg.teams || [] };
      if (!q) {
        people.loaded = true;
        people.error = msg.ok === false ? (msg.message || 'Could not ask GitHub who is here') : null;
        if (msg.ok !== false) {
          people.users = got.users;
          people.teams = got.teams;
          people.viewer = msg.viewer || people.viewer;
          people.complete = !!msg.complete;
        }
      } else {
        people.byQuery.set(q, got);
      }
      const ta = picker && draftBox(picker.key);
      if (ta) updatePicker(ta);
    }

    // ── messages from the host ───────────────────────────────

    function flashDone(msg) {
      done = { ok: msg.ok, message: msg.message };
      busy = false;
      render();
      if (doneTimer) clearTimeout(doneTimer);
      doneTimer = setTimeout(function () { done = null; if (view.open) render(); }, 4000);
    }

    let firstMeta = true;

    /**
     * `meta.prPane` is this instance's own memory of the drawer, so it is
     * where a freshly opened tab (or a reload) gets its starting state. Once
     * this pane is live, the same field keeps arriving on every unrelated
     * `meta` update (a setting changed, say) — adopting it blindly would snap
     * the drawer back every time, undoing whatever was clicked since. It only
     * moves the drawer when the value is not the one this pane itself just
     * sent, which means it came from somewhere else: another device, or the
     * instance's saved state on first load.
     */
    function setMeta(next) {
      const was = meta.prUrl;
      meta = next || {};
      if (phone) {
        if (firstMeta || meta.prUrl !== was) {
          let mine = {};
          try { mine = JSON.parse(localStorage.getItem(PHONE_KEY + meta.prUrl) || '{}') || {}; } catch (_) { /* nothing saved */ }
          view = { open: !!(meta.prUrl && mine.open), tab: TABS.some((t) => t.id === normTab(mine.tab)) ? normTab(mine.tab) : 'conversation', width: null, full: true };
          host.hidden = !view.open;
          send({ type: 'pr:watch', on: view.open });
        }
        firstMeta = false;
        paintChip();
        if (view.open) render();
        return;
      }
      const incoming = meta.prPane || {};
      const theirs = JSON.stringify({ open: !!incoming.open, tab: normTab(incoming.tab), width: incoming.width || null, full: !!incoming.full });
      if (firstMeta || theirs !== lastSent) {
        view = JSON.parse(theirs);
        lastSent = theirs;
        if (host.hidden === view.open) settle(); // another window moved it: no half-finished slide
        host.hidden = !view.open;
        host.classList.toggle('full', view.full);
      }
      firstMeta = false;
      paintChip();
      if (view.open) { measure(); applyWidth(); measureWide(); render(); }
    }

    function onState(msg) {
      prState = { prUrl: msg.prUrl, loading: !!msg.loading, error: msg.error || null, state: msg.state || null };
      const key = msg.state ? (msg.state.headSha || msg.state.url) : null;
      if (diff.forUrl !== key) diff = { loaded: false, loading: false, text: '', truncated: false, forUrl: key };
      paintChip();
      if (view.open) {
        if (view.tab === 'files' && !diff.loaded && !diff.loading && msg.state) requestDiff();
        render();
      }
    }

    function onDiff(msg) {
      diff.loaded = true;
      diff.loading = false;
      diff.text = msg.diff || '';
      diff.truncated = !!msg.truncated;
      if (view.open && view.tab === 'files') render();
    }

    function onDone(msg) { flashDone(msg || {}); }

    host.hidden = true;
    paintChip();

    return { setMeta, onState, onDiff, onDone, onMentions };
  }

  const api = { mount };
  root.PrPane = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
