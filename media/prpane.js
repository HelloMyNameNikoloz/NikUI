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
  const MINIMIZE_PATH = '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10 21 3"/><path d="M3 21l7-7"/>';
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
    size = size || 24;
    const style = 'width:' + size + 'px;height:' + size + 'px;--hue:' + hueOf(login) + ';font-size:' + Math.max(9, Math.round(size * 0.5)) + 'px';
    const img = url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : '';
    return '<span class="avatar" data-initial="' + esc(initialOf(login)) + '" style="' + style + '" title="' + esc(login || '') + '">' + img + '</span>';
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
    return '<span class="pr-label-chip' + (small ? ' sm' : '') + '" style="background:#' + esc(hex) + ';color:' + labelTextColor(hex) + '">' + esc(l.name) + '</span>';
  }
  function reviewerStateIcon(state) {
    const s = (state || '').toUpperCase();
    if (s === 'APPROVED') return icon('check', 12);
    if (s === 'CHANGES_REQUESTED') return icon('x', 12);
    if (s === 'COMMENTED') return BUBBLE;
    return DOT; // pending
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
   */
  function mount(opts) {
    const chip = opts.chip;
    const host = opts.host;
    const split = opts.split || host.parentElement;
    const send = opts.send || function () {};

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
      const bits = ['<span class="pr-chip-num">#' + esc(number || '?') + '</span>'];
      if (st && st.checkSummary) {
        const cs = st.checkSummary;
        const dotClass = cs.fail > 0 ? 'fail' : (cs.pending > 0 ? 'pending' : (cs.pass > 0 ? 'pass' : ''));
        if (dotClass) bits.push('<span class="pr-chip-dot ' + dotClass + '"></span>');
      }
      const unresolved = st ? (st.threads || []).filter((t) => !t.resolved).length : 0;
      if (unresolved) bits.push('<span class="pr-chip-bubble">' + BUBBLE + esc(unresolved) + '</span>');
      chip.innerHTML = bits.join('');
      chip.title = (view.open ? 'Close' : 'Open') + ' the pull request panel' +
        (st ? ' — ' + (STATE_WORD[st.state] || st.state) + (st.isDraft ? ' (draft)' : '') : '');
      chip.setAttribute('aria-expanded', String(view.open));
    }

    // ── opening / closing / switching tabs / full page ─────────

    let lastSent = null; // what we last told the host, so its echo is not mistaken for someone else's change

    function sendPane() {
      lastSent = JSON.stringify(view);
      send({ type: 'pr:pane', open: view.open, tab: view.tab, width: view.width, full: !!view.full });
    }

    function setOpen(open) {
      if (view.open === open) return;
      view.open = open;
      host.hidden = !open;
      if (open) { measure(); applyWidth(); measureWide(); if (!diff.loaded && view.tab === 'files') requestDiff(); }
      sendPane();
      paintChip();
      render();
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

    function renderCompactRow(st) {
      const reviewers = st.reviewers || [];
      const labels = st.labels || [];
      if (!reviewers.length && !labels.length) return '';
      let html = '<div class="pr-compact-row">';
      if (reviewers.length) html += '<span class="pr-compact-reviewers">' + reviewers.map((r) => avatar(r.login, r.avatar, 18)).join('') + '</span>';
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
        parts.push('<div class="pr-head-sub">' +
          '<span class="pr-state-pill ' + stateKey + '">' + (STATE_ICON[stateKey] || '') + esc(stateLabel) + '</span>' +
          '<span class="pr-merge-line"><b>' + esc(st.author || '') + '</b> ' + esc(verb) + ' ' + esc(commitWord) +
          ' into <code>' + esc(st.baseRef || '') + '</code> from <code>' + esc(st.headRef || '') + '</code></span>' +
          '</div>');
        parts.push(renderCompactRow(st));
      } else {
        parts.push('<span class="pr-title dim">' + (prState.prUrl ? 'Loading the pull request…' : 'No pull request linked') + '</span>');
      }
      parts.push('</div><div class="pr-head-actions">');
      parts.push('<button class="icon-only" data-act="full" title="' + (view.full ? 'Exit full page' : 'Full page') + '" aria-label="Full page">' +
        (view.full ? customIcon(MINIMIZE_PATH, 13) : icon('expand', 13)) + '</button>');
      parts.push('<button class="icon-only pr-refresh' + (refreshing ? ' spinning' : '') + '" data-act="refresh" ' +
        'title="Refresh" aria-label="Refresh">' + (refreshing ? '<span class="spinner"></span>' : icon('refresh', 13)) + '</button>');
      parts.push('<button class="icon-only" data-act="close" title="Close (Esc)" aria-label="Close">' + icon('x', 13) + '</button>');
      parts.push('</div></div>');
      if (st) {
        parts.push('<div class="pr-head-meta">' +
          changeBar(st.additions || 0, st.deletions || 0) +
          '<span class="pr-stat add">+' + esc(st.additions || 0) + '</span>' +
          '<span class="pr-stat del">-' + esc(st.deletions || 0) + '</span>' +
          '<span class="dim">' + esc(st.changedFiles || 0) + ' files changed</span>' +
          (st.updatedAt ? '<span class="dim">updated ' + esc(fmtAgo(st.updatedAt)) + '</span>' :
            (st.fetchedAt ? '<span class="dim">fetched ' + esc(fmtAgo(st.fetchedAt)) + '</span>' : '')) +
          '</div>');
      }
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
        return '<div class="pr-empty-tab dim">' + (prState.loading ? 'Loading…' : 'Nothing to show yet.') + '</div>';
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

    function render() {
      if (!view.open) return;
      const st = prState.state;
      // A refresh lands every few seconds while checks run: keep the reader's
      // place and the reply they are halfway through typing.
      const oldBody = host.querySelector('.pr-pane-body');
      const scrollTop = oldBody ? oldBody.scrollTop : 0;
      const typing = document.activeElement && host.contains(document.activeElement) &&
        document.activeElement.matches('textarea[data-draft]') ? document.activeElement : null;
      const caret = typing ? { key: typing.getAttribute('data-draft'), start: typing.selectionStart, end: typing.selectionEnd } : null;
      const sidebarHtml = st && view.tab === 'conversation' ? renderSidebar(st) : '';
      host.innerHTML =
        '<div class="pr-resize" data-resize tabindex="0" role="separator" aria-orientation="vertical" ' +
        'aria-label="Resize the pull request pane"></div>' +
        '<div class="pr-pane-inner">' +
        '<header class="pr-pane-head">' + renderHead(st) + '</header>' +
        (meta.prUrl ? renderTabs(st) : '') +
        '<div class="pr-pane-main">' +
        '<div class="pr-pane-body" tabindex="-1">' + renderBody() + '</div>' +
        sidebarHtml +
        '<button class="pr-scroll-bottom" data-act="scrollBottom" hidden title="Scroll to latest" aria-label="Scroll to latest">' + ARROW_DOWN + '</button>' +
        '</div>' +
        '</div>';
      const newBody = host.querySelector('.pr-pane-body');
      if (newBody && oldBody) newBody.scrollTop = scrollTop;
      if (caret) {
        const again = Array.from(host.querySelectorAll('textarea[data-draft]')).find((t) => t.getAttribute('data-draft') === caret.key);
        if (again) { again.focus(); try { again.setSelectionRange(caret.start, caret.end); } catch (_) { /* gone */ } }
      }
      const handle = host.querySelector('[data-resize]');
      if (handle) {
        handle.addEventListener('mousedown', startDrag);
        handle.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowLeft') { view.width = Math.min((view.width || DEFAULT_WIDTH) + 16, Math.round(split.clientWidth * 0.7)); applyWidth(); sendPane(); }
          if (e.key === 'ArrowRight') { view.width = Math.max(MIN_WIDTH, (view.width || DEFAULT_WIDTH) - 16); applyWidth(); sendPane(); }
        });
      }
      if (newBody) newBody.addEventListener('scroll', updateScrollBtn);
      updateScrollBtn();
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
            drafts.delete('');
            render();
            return;
          }
        }
      }

      const askThread = e.target.closest('[data-ask-thread]');
      if (askThread) { send({ type: 'pr:askThread', threadId: askThread.dataset.askThread }); return; }

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
        drafts.delete(id);
        render();
      }
    });

    host.addEventListener('input', function (e) {
      const ta = e.target.closest('[data-draft]');
      if (!ta) return;
      drafts.set(ta.dataset.draft, ta.value);
      // Only the Comment/Reply button beside this box needs to flip.
      const btn = ta.parentElement.querySelector('button');
      if (btn) btn.disabled = busy || !ta.value.trim();
    });

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
      meta = next || {};
      const incoming = meta.prPane || {};
      const theirs = JSON.stringify({ open: !!incoming.open, tab: normTab(incoming.tab), width: incoming.width || null, full: !!incoming.full });
      if (firstMeta || theirs !== lastSent) {
        view = JSON.parse(theirs);
        lastSent = theirs;
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

    return { setMeta, onState, onDiff, onDone };
  }

  const api = { mount };
  root.PrPane = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
