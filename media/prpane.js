/* The GitHub pane: a per-instance drawer showing the pull request this
   instance is about. A header chip (built here, drawn beside the title)
   toggles it open; the drawer itself lives in the `#pr-pane` aside that
   src/page.js already puts beside the transcript.

   Everything GitHub sends is untrusted. Free text goes through
   window.renderMarkdown (which escapes first) or window.escapeHtml; a link
   only ever opens by asking the host for `pr:open`, and only when it points
   at https://github.com/ — nothing here ever sets `location` or an `href`
   that the page would follow on its own. */
(function (root) {
  'use strict';

  const esc = root.escapeHtml || ((s) => String(s == null ? '' : s));
  const md = root.renderMarkdown || esc;
  const icon = typeof root.icon === 'function' ? root.icon : function () { return ''; };

  // Two glyphs icons.js does not carry, drawn the same way: a 24x24 stroke
  // path in currentColor.
  const BUBBLE = '<svg class="ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  const EXTERNAL = '<svg class="ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>';

  const DEFAULT_WIDTH = 420;
  const MIN_WIDTH = 320;
  const OVERLAY_BELOW = 760;
  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'comments', label: 'Comments' },
    { id: 'checks', label: 'Checks' },
    { id: 'files', label: 'Files' }
  ];
  const STATE_WORD = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' };
  const CHECK_ICON = { pass: 'check', fail: 'alert', pending: 'clock', skipped: 'x', neutral: 'x' };

  function isGithubUrl(url) { return /^https:\/\/github\.com\//i.test(String(url || '')); }

  function fmtAgo(at) {
    if (!at) return '';
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
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
    let view = { open: false, tab: 'overview', width: null }; // mirrors meta.prPane
    let prState = { prUrl: null, loading: false, error: null, state: null };
    let diff = { loaded: false, loading: false, text: '', truncated: false, forUrl: null };
    let busy = false;
    let done = null; // { message } shown briefly after an action
    let doneTimer = null;
    let overlay = false;
    const drafts = new Map(); // thread id (or '' for the top-level box) -> text

    // ── layout: split vs. overlay ─────────────────────────────

    function measure() {
      const narrow = split.clientWidth < OVERLAY_BELOW;
      if (narrow !== overlay) { overlay = narrow; host.classList.toggle('overlay', overlay); }
    }
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(split);
    else window.addEventListener('resize', measure);

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

    // ── opening / closing / switching tabs ─────────────────────

    let lastSent = null; // what we last told the host, so its echo is not mistaken for someone else's change

    function sendPane() {
      lastSent = JSON.stringify(view);
      send({ type: 'pr:pane', open: view.open, tab: view.tab, width: view.width });
    }

    function setOpen(open) {
      if (view.open === open) return;
      view.open = open;
      host.hidden = !open;
      if (open) { measure(); applyWidth(); if (!diff.loaded && view.tab === 'files') requestDiff(); }
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

    // ── rendering ────────────────────────────────────────────

    function checkDot(summary) {
      if (!summary) return '';
      if (summary.fail > 0) return 'fail';
      if (summary.pending > 0) return 'pending';
      if (summary.pass > 0) return 'pass';
      return '';
    }

    function renderHead(st) {
      const refreshing = prState.loading;
      const parts = [];
      parts.push('<div class="pr-head-row">');
      if (st) {
        parts.push('<a class="pr-title" href="' + esc(st.url) + '">' + md(st.title || '') + '</a>');
      } else {
        parts.push('<span class="pr-title dim">' + (prState.prUrl ? 'Loading the pull request…' : 'No pull request linked') + '</span>');
      }
      parts.push('<button class="icon-only pr-refresh' + (refreshing ? ' spinning' : '') + '" data-act="refresh" ' +
        'title="Refresh" aria-label="Refresh">' + (refreshing ? '<span class="spinner"></span>' : icon('refresh', 13)) + '</button>');
      parts.push('<button class="icon-only" data-act="close" title="Close (Esc)" aria-label="Close">' + icon('x', 13) + '</button>');
      parts.push('</div>');
      if (st) {
        const badge = (STATE_WORD[st.state] || st.state) + (st.isDraft ? ' · Draft' : '');
        parts.push('<div class="pr-head-sub">' +
          '<span class="pr-badge ' + esc((st.state || '').toLowerCase()) + (st.isDraft ? ' draft' : '') + '">' + esc(badge) + '</span>' +
          '<span class="pr-refs">#' + esc(st.number) + ' · ' + esc(st.headRef) + ' → ' + esc(st.baseRef) + '</span>' +
          (st.reviewDecision ? '<span class="pr-review-decision">' + esc(st.reviewDecision.replace(/_/g, ' ').toLowerCase()) + '</span>' : '') +
          (st.mergeable ? '<span class="pr-mergeable ' + (st.mergeable === 'CONFLICTING' ? 'warn' : '') + '">' +
            esc(st.mergeable.toLowerCase()) + '</span>' : '') +
          '</div>');
        parts.push('<div class="pr-head-meta">' +
          '<span>+' + esc(st.additions || 0) + ' -' + esc(st.deletions || 0) + '</span>' +
          '<span>' + esc(st.changedFiles || 0) + ' files</span>' +
          (st.fetchedAt ? '<span class="pr-fetched" data-fetched-at="' + esc(st.fetchedAt) + '">fetched ' + esc(fmtAgo(st.fetchedAt)) + '</span>' : '') +
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
      const files = st ? (st.files || []).length : 0;
      const counts = { overview: 0, comments: unresolved, checks: failing, files: files };
      return '<nav class="pr-tabs" role="tablist">' + TABS.map((t) => {
        const n = counts[t.id];
        return '<button class="pr-tab' + (view.tab === t.id ? ' on' : '') + '" role="tab" aria-selected="' +
          (view.tab === t.id) + '" data-tab="' + t.id + '">' + esc(t.label) +
          (n ? '<span class="pr-tab-badge' + (t.id === 'checks' && n ? ' fail' : '') + '">' + esc(n) + '</span>' : '') +
          '</button>';
      }).join('') + '</nav>';
    }

    function renderOverview(st) {
      const draft = drafts.get('') || '';
      let html = '<div class="pr-overview">';
      html += '<div class="pr-body">' + (st.body ? md(st.body) : '<span class="dim">No description.</span>') + '</div>';
      if ((st.reviewers || []).length) {
        html += '<h4>Reviewers</h4><ul class="pr-reviewers">' + st.reviewers.map((r) =>
          '<li><span>' + esc(r.login) + '</span><span class="pr-review-state ' + esc((r.state || '').toLowerCase()) + '">' +
          esc((r.state || '').replace(/_/g, ' ').toLowerCase()) + '</span></li>').join('') + '</ul>';
      }
      if ((st.reviews || []).length) {
        html += '<h4>Reviews</h4>' + st.reviews.map((r) =>
          '<div class="pr-review"><div class="pr-review-head"><b>' + esc(r.author) + '</b><span class="pr-review-state ' +
          esc((r.state || '').toLowerCase()) + '">' + esc((r.state || '').replace(/_/g, ' ').toLowerCase()) + '</span></div>' +
          (r.body ? '<div class="pr-review-body">' + md(r.body) + '</div>' : '') + '</div>').join('');
      }
      if ((st.comments || []).length) {
        html += '<h4>Conversation</h4>' + st.comments.map((c) =>
          '<div class="pr-comment"><div class="pr-comment-head"><b>' + esc(c.author) + '</b><span class="dim">' +
          esc(fmtAgo(c.at)) + '</span></div><div class="pr-comment-body">' + md(c.body) + '</div></div>').join('');
      }
      html += '<div class="pr-new-comment">' +
        '<textarea data-draft="" placeholder="Comment on this pull request…">' + esc(draft) + '</textarea>' +
        '<button data-act="comment"' + (busy || !draft.trim() ? ' disabled' : '') + '>Comment</button></div>';
      html += '</div>';
      return html;
    }

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
          '<div class="pr-comment"><div class="pr-comment-head"><b>' + esc(c.author) + '</b><span class="dim">' +
          esc(fmtAgo(c.at)) + '</span>' + (c.url ? '<a href="' + esc(c.url) + '">' + EXTERNAL + '</a>' : '') + '</div>' +
          '<div class="pr-comment-body">' + md(c.body) + '</div></div>').join('') +
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
        const dur = c.startedAt && c.completedAt ? fmtDur(c.completedAt - c.startedAt) : '';
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
      if (view.tab === 'overview') return renderOverview(st);
      if (view.tab === 'comments') return renderComments(st);
      if (view.tab === 'checks') return renderChecks(st);
      if (view.tab === 'files') return renderFiles(st);
      return '';
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
      host.innerHTML =
        '<div class="pr-resize" data-resize tabindex="0" role="separator" aria-orientation="vertical" ' +
        'aria-label="Resize the pull request pane"></div>' +
        '<div class="pr-pane-inner">' +
        '<header class="pr-pane-head">' + renderHead(st) + '</header>' +
        (meta.prUrl ? renderTabs(st) : '') +
        '<div class="pr-pane-body" tabindex="-1">' + renderBody() + '</div>' +
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
      const theirs = JSON.stringify({ open: !!incoming.open, tab: incoming.tab || 'overview', width: incoming.width || null });
      if (firstMeta || theirs !== lastSent) {
        view = JSON.parse(theirs);
        lastSent = theirs;
        host.hidden = !view.open;
      }
      firstMeta = false;
      paintChip();
      if (view.open) { measure(); applyWidth(); render(); }
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
