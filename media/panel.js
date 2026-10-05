/* NikUI webview front end. Items arrive normalised from the extension host and
   are upserted by id, so streaming deltas repaint in place. */
(function () {
  'use strict';

  // The one call that knows what is hosting this page: the VS Code API in the
  // panel, the same three methods over a socket in a browser. Nothing else in
  // this file — or any other in media/ — depends on the answer.
  const vscode = window.nikTransport();
  const $ = (id) => document.getElementById(id);

  // What has to survive VS Code throwing this webview away while the tab is
  // hidden: which instance it belongs to, what was half-typed, and where the
  // reader had scrolled to. The conversation itself comes back from the host.
  const saved = vscode.getState() || {};
  let sessionId = saved.sessionId || null;
  let rememberTimer = null;

  function saveNow() {
    if (rememberTimer) { clearTimeout(rememberTimer); rememberTimer = null; }
    vscode.setState({
      sessionId: sessionId,
      draft: input.value,
      scrollTop: scroller.scrollTop,
      follow: follow
    });
  }

  function remember() {
    if (rememberTimer) return;
    rememberTimer = setTimeout(function () { rememberTimer = null; saveNow(); }, 200);
  }

  // VS Code throws a hidden webview away without warning, so anything still
  // waiting on the debounce is written out the moment the tab goes away.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) saveNow();
    // Whether this conversation is in front of anybody: a phone looking at it
    // when it finishes has seen it, and one in a pocket has not.
    vscode.postMessage({ type: 'visible', on: !document.hidden });
  });
  window.addEventListener('pagehide', saveNow);

  const stream = $('stream');
  const scroller = $('transcript');
  const input = $('input');
  const slashBox = $('slash');
  const attachBar = $('attachments');
  const filePicker = $('file');
  const lightbox = $('lightbox');
  const lbImg = $('lb-img');
  const sheet = $('status');
  const tip = $('tip');
  const escHint = $('esc-hint');

  const nodes = new Map();
  const prompts = new window.PromptHistory();
  let dropped = 0;
  let maxNodes = 0;
  let singleEscape = false;
  let escArmedUntil = 0;
  let escTimer = null;
  let attachments = [];
  let commands = [];
  // What the palette is offering: media/palette.js works out the list and what
  // picking one writes, so this file only draws it and moves the highlight.
  let slashPlan = null;
  let slashIndex = 0;
  let commandArgs = {};
  let ownCommands = [];
  let snippetText = {};
  let meta = {};
  let showThinking = true;
  let clock = '24h';
  let suggestReplies = true;
  // What the last turn ended on, for the replies offered under it.
  let lastReply = '';
  let lastKind = '';
  let lastResult = null;
  let status = '';
  let statsBase = { elapsedMs: 0, running: false, at: Date.now(), total: 0, cost: 0, turns: 0 };
  let attachSeq = 0;
  let queued = [];
  let drainAt = null;
  let clearArmed = false;
  let clearTimer = null;

  const esc = (s) => window.escapeHtml(String(s == null ? '' : s));
  const icon = window.icon;

  // ── formatting ───────────────────────────────────────────────

  function fmtTokens(n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(1) + 'M';
  }

  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }

  // When something was said: the time alone today, with the day before that.
  function fmtClock(at) {
    const d = new Date(at);
    if (!at || isNaN(d)) return '';
    const time = d.toLocaleTimeString([], clock === '12h'
      ? { hour: 'numeric', minute: '2-digit', hour12: true }
      : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return d.toDateString() === new Date().toDateString() ? time
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
  }

  function clockTag(at, klass, label) {
    const said = fmtClock(at);
    return said ? '<time class="' + klass + '" datetime="' + new Date(at).toISOString() + '" title="' +
      esc(label + ' ' + new Date(at).toLocaleString()) + '">' + esc(said) + '</time>' : '';
  }

  // The setting changed: every time already on the page is written again.
  function setClock(next) {
    const was = clock;
    clock = next === '12h' ? '12h' : '24h';
    if (clock === was) return;
    stream.querySelectorAll('time.sent-at, time.received-at').forEach(function (t) {
      t.textContent = fmtClock(Date.parse(t.getAttribute('datetime')));
    });
  }

  let follow = true;
  const jump = $('jump');

  function atBottom(slack) {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= (slack || 24);
  }
  function scrollDown() { scroller.scrollTop = scroller.scrollHeight; }

  // Scrolling up means the reader is reading; never yank them back down.
  scroller.addEventListener('scroll', function () {
    remember();
    const bottom = atBottom(24);
    if (bottom === follow) return;
    follow = bottom;
    jump.hidden = follow;
  }, { passive: true });

  jump.addEventListener('click', function () {
    follow = true;
    jump.hidden = true;
    scrollDown();
  });

  /**
   * An absolute path, shortened from the front.
   *
   * A path is read from its end — which file, then which folder — so cutting
   * the end off leaves the half you already knew. On a narrow screen that is
   * every path: "/Users/nikoloz/Codes/NikUI/src/au…" says nothing the row
   * above it did not. Done here rather than in CSS because the CSS way of
   * doing it reverses the text direction, and a leading slash then comes out
   * at the other end.
   */
  function shortenPath(text) {
    if (!/^([/~]|[A-Za-z]:\\)/.test(text)) return text;
    const parts = text.split(/[/\\]/).filter(Boolean);
    if (parts.length <= 3) return text;
    return '…/' + parts.slice(-3).join('/');
  }

  function summarise(inputObj) {
    const i = inputObj || {};
    const path = i.file_path || i.path;
    if (path && !i.command) return shortenPath(String(path).replace(/\s+/g, ' ')).slice(0, 160);
    const first = i.command || i.url || i.query || i.pattern || i.description || i.prompt;
    if (first) return String(first).replace(/\s+/g, ' ').slice(0, 160);
    const keys = Object.keys(i);
    return keys.length ? keys.slice(0, 3).map((k) => k + '=' + short(i[k])).join(' ') : '';
  }
  function short(v) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s == null ? '' : (s.length > 40 ? s.slice(0, 40) + '…' : s);
  }
  // A tool input can carry a whole file. Painting it in full locks the panel up
  // for a second and nobody reads past the first screen anyway.
  const INPUT_MAX = 8000;

  function pretty(v) {
    let text;
    if (typeof v === 'string') text = v;
    else { try { text = JSON.stringify(v, null, 2); } catch (_) { text = String(v); } }
    if (text.length <= INPUT_MAX) return text;
    return text.slice(0, INPUT_MAX) + '\n\n… ' + fmtBytes(text.length - INPUT_MAX) + ' more';
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' characters';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ── header ───────────────────────────────────────────────────

  function paintStats() {
    const running = statsBase.running;
    const elapsed = running ? statsBase.elapsedMs + (Date.now() - statsBase.at) : statsBase.elapsedMs;
    const bits = [];
    if (elapsed > 0 || running) {
      bits.push('<span class="stat' + (running ? ' live' : '') + '">' + icon('clock', 12) +
        esc(fmtDuration(elapsed)) + '</span>');
    }
    // Agents it started can outlive the turn, and they are why a turn with
    // nobody asking may start later.
    if (statsBase.background > 0) {
      bits.push('<span class="stat live" title="Agents this instance started, still running in the background">' +
        icon('cpu', 12) + esc(statsBase.background + (statsBase.background === 1 ? ' agent' : ' agents')) + '</span>');
    }
    if (statsBase.shells > 0) {
      bits.push('<span class="stat live shells" tabindex="0" role="button" aria-haspopup="true">' +
        icon('terminal', 12) + esc(statsBase.shells + (statsBase.shells === 1 ? ' command' : ' commands')) + '</span>');
    }
    const headline = (statsBase.input || 0) + (statsBase.output || 0);
    if (statsBase.total > 0) {
      bits.push('<span class="stat" title="' + esc(tokenTitle()) + '">' + icon('hash', 12) +
        esc(fmtTokens(headline)) + '</span>');
    }
    if (statsBase.cost > 0) {
      bits.push('<span class="stat">$' + statsBase.cost.toFixed(3) + '</span>');
    }
    $('stats').innerHTML = bits.join('');
  }

  function tokenTitle() {
    const s = statsBase;
    return 'Input ' + fmtTokens(s.input || 0) +
      '\nOutput ' + fmtTokens(s.output || 0) +
      '\nCache read ' + fmtTokens(s.cacheRead || 0) +
      '\nCache write ' + fmtTokens(s.cacheCreate || 0) +
      '\nTotal tokens ' + fmtTokens(s.total || 0);
  }

  function paintContext() {
    const el = $('ctx');
    const used = statsBase.contextTokens || 0;
    const cap = statsBase.contextWindow || 0;
    if (!cap || !used) { el.hidden = true; return; }
    const pct = Math.min(100, Math.round((used / cap) * 1000) / 10);
    el.hidden = false;
    el.querySelector('i').style.width = Math.max(2, pct) + '%';
    el.classList.toggle('warn', pct >= 70);
    el.classList.toggle('hot', pct >= 90);
    el.querySelector('.ctx-label').textContent = pct.toFixed(pct < 10 ? 1 : 0) + '%';
    el.title = 'Context: ' + fmtTokens(used) + ' of ' + fmtTokens(cap) + ' tokens';
  }

  /**
   * The PR's CI, next to the context budget: how many checks are done, and
   * how long the last ten runs say is left. Green or red when it is over.
   */
  const CI_WORDS = {
    looking: 'Looking for the PR', 'no-pr': 'Waiting for a PR', push: 'waiting for the push',
    queued: 'CI starting', none: 'no CI checks', merged: 'merged', closed: 'closed'
  };
  function paintCi() {
    const el = $('ci');
    const ci = statsBase.ci;
    if (!ci) { el.hidden = true; return; }
    el.hidden = false;
    const pr = ci.pr ? 'PR #' + ci.pr.number : '';
    const elapsed = (ci.elapsedMs || 0) + (ci.finished ? 0 : Date.now() - statsBase.at);
    let words;
    let pct = 0;
    if (ci.phase === 'running' || ci.phase === 'queued') {
      const avg = ci.averageMs;
      pct = avg ? Math.min(97, (elapsed / avg) * 100) : (ci.total ? (ci.done / ci.total) * 100 : 0);
      const left = avg ? avg - elapsed : null;
      const eta = left == null ? '' : left <= 0 ? ' · any moment' : left < 60000 ? ' · <1m left' : ' · ~' + Math.ceil(left / 60000) + 'm left';
      words = pr + ' · ' + (ci.phase === 'queued' ? 'CI starting' : 'CI ' + ci.done + '/' + ci.total) + eta;
    } else if (ci.phase === 'passed') {
      pct = 100; words = pr + ' · green';
    } else if (ci.phase === 'failed') {
      pct = 100; words = pr + ' · failed: ' + (ci.failing || []).slice(0, 2).join(', ');
    } else if (ci.phase === 'error') {
      words = ci.message || 'Cannot watch CI';
    } else {
      words = (pr && ci.phase !== 'looking' && ci.phase !== 'no-pr' ? pr + ' · ' : '') + (CI_WORDS[ci.phase] || ci.phase);
    }
    el.className = 'ci ' + ci.phase + (ci.finished ? ' finished' : '');
    el.querySelector('i').style.width = Math.max(ci.finished ? 0 : 3, pct) + '%';
    el.querySelector('.ci-label').textContent = words;
    const link = (ci.phase === 'failed' && ci.url) || (ci.pr && ci.pr.url) || '';
    if (link) el.setAttribute('href', link); else el.removeAttribute('href');
    el.title = (ci.pr && ci.pr.title ? ci.pr.title + '\n' : '') +
      (ci.averageMs ? 'CI usually takes ' + fmtDuration(ci.averageMs) + ' here (average of the last runs)\n' : '') +
      (link ? 'Click to open on GitHub' : '');
  }

  setInterval(function () { if (statsBase.running) paintStats(); }, 1000);
  setInterval(function () { if (statsBase.ci && !statsBase.ci.finished) paintCi(); }, 1000);
  // Only while there is a countdown to advance. Rebuilding the queue's markup
  // every second destroyed the buttons under the reader's focus and their
  // half-finished clicks, to redraw text that had not changed.
  setInterval(function () { if (drainAt) paintQueue(); }, 1000);

  // Hovering the commands chip says which commands, for how long, and offers
  // to stop each. The card lives outside #stats, which is redrawn every second.
  const shellPop = $('shells-pop');
  let shellHide = null;
  let shellsOpen = false;
  const stopping = new Set();

  function paintShells() {
    const list = (statsBase.shellList || []);
    if (!shellsOpen) return;
    if (!list.length) { closeShells(); return; }
    const now = Date.now();
    shellPop.innerHTML = '<div class="shells-head">Running in the background</div>' + list.map(function (t) {
      const since = t.startedAt ? fmtDuration(now - t.startedAt) : '';
      const busy = t.stopping || stopping.has(t.id);
      return '<div class="shell-row">' +
        '<div class="shell-main"><code class="shell-cmd" title="' + esc(t.command) + '">' + esc(t.command || 'A command') + '</code>' +
        (since ? '<span class="shell-since">running ' + esc(since) + '</span>' : '') + '</div>' +
        '<button class="shell-stop" data-task="' + esc(t.id) + '"' + (busy ? ' disabled' : '') + '>' +
        (busy ? 'Stopping…' : 'Cancel') + '</button></div>';
    }).join('');
  }

  function openShells() {
    const chip = $('stats').querySelector('.stat.shells');
    if (!chip) return;
    if (shellHide) { clearTimeout(shellHide); shellHide = null; }
    shellsOpen = true;
    shellPop.hidden = false;
    paintShells();
    const r = chip.getBoundingClientRect();
    const width = shellPop.offsetWidth;
    shellPop.style.top = (r.bottom + 6) + 'px';
    shellPop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + 'px';
  }

  function closeShells() {
    shellsOpen = false;
    shellPop.hidden = true;
  }

  function closeShellsSoon() {
    if (shellHide) clearTimeout(shellHide);
    shellHide = setTimeout(closeShells, 250);
  }

  $('stats').addEventListener('mouseover', function (e) {
    if (e.target.closest('.stat.shells')) openShells(); else if (shellsOpen) closeShellsSoon();
  });
  $('stats').addEventListener('mouseleave', function () { if (shellsOpen) closeShellsSoon(); });
  $('stats').addEventListener('click', function (e) {
    if (!e.target.closest('.stat.shells')) return;
    if (shellsOpen && !shellHide) closeShells(); else openShells();
  });
  $('stats').addEventListener('keydown', function (e) {
    if (e.target.closest('.stat.shells') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openShells(); }
  });
  shellPop.addEventListener('mouseenter', function () { if (shellHide) { clearTimeout(shellHide); shellHide = null; } });
  shellPop.addEventListener('mouseleave', closeShellsSoon);
  shellPop.addEventListener('click', function (e) {
    const btn = e.target.closest('.shell-stop');
    if (!btn || btn.disabled) return;
    stopping.add(btn.dataset.task);
    vscode.postMessage({ type: 'stopTask', taskId: btn.dataset.task });
    paintShells();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && shellsOpen) closeShells(); });
  document.addEventListener('click', function (e) {
    if (shellsOpen && !e.target.closest('#shells-pop') && !e.target.closest('.stat.shells')) closeShells();
  });
  setInterval(paintShells, 1000);

  function setStats(s) {
    statsBase = Object.assign({}, s, { at: Date.now() });
    const live = new Set((statsBase.shellList || []).map(function (t) { return t.id; }));
    stopping.forEach(function (id) { if (!live.has(id)) stopping.delete(id); });
    paintStats();
    paintShells();
    paintContext();
    paintCi();
  }

  const PERMISSION_WORD = {
    bypassPermissions: 'tools run without asking',
    acceptEdits: 'edits auto-accepted',
    plan: 'plan mode',
    default: 'asks before tools'
  };

  /**
   * A device that may watch but not steer. Hiding the controls is courtesy —
   * the host refuses these messages whatever the client sends — but a composer
   * that takes a prompt and silently drops it would be a lie.
   */
  function setControl(device) {
    const allowed = !device || device.control !== false;
    document.body.classList.toggle('read-only', !allowed);
    const banner = $('watching');
    if (banner) {
      banner.hidden = allowed;
      if (refusalTimer) { clearTimeout(refusalTimer); refusalTimer = null; }
      banner.textContent = WATCHING;
    }
    input.disabled = !allowed;
    paintReplies();
  }

  /** A quiet note that somebody else is looking at the same instance. */
  function setPresence(clients) {
    const who = $('who');
    if (!who) return;
    const others = (clients || []).filter((c) => c.id !== window.__clientId);
    if (!others.length) { who.hidden = true; who.textContent = ''; return; }
    who.hidden = false;
    who.textContent = others
      .map((c) => c.name + (c.control ? '' : ' (watching)'))
      .join(', ');
    who.title = others.length === 1
      ? others[0].name + ' is looking at this instance too.'
      : others.length + ' others are looking at this instance.';
  }

  const WATCHING = 'Watching only — this device has not been granted control.';
  let refusalTimer = null;

  function flashRefusal(msg) {
    const banner = $('watching');
    if (!banner) return;
    banner.hidden = false;
    banner.textContent = (msg && msg.reason) || 'That is not allowed from this device.';
    // And then back to the standing explanation. Overwriting it permanently
    // meant one refused tap cost the page its only account of why.
    if (refusalTimer) clearTimeout(refusalTimer);
    refusalTimer = setTimeout(function () {
      refusalTimer = null;
      banner.textContent = WATCHING;
    }, 6000);
  }

  // In the editor the title goes to a tab already showing the PR, if there is
  // one; elsewhere it is an ordinary link.
  // VS Code opens every clicked <a href> in a new tab whatever the page does
  // with the click, so in the editor the title carries no href at all.
  const IN_EDITOR = typeof acquireVsCodeApi === 'function';
  if (IN_EDITOR) {
    const openPr = (e) => {
      if (!meta.prUrl) return;
      e.preventDefault();
      vscode.postMessage({ type: 'openPr' });
    };
    $('title').addEventListener('click', openPr);
    $('title').addEventListener('keydown', (e) => { if (e.key === 'Enter') openPr(e); });
  }

  function setMeta(next) {
    meta = next || {};
    const title = $('title');
    title.textContent = meta.label || '';
    // The title opens the PR the instance is about, when there is one.
    title.classList.toggle('linked', !!meta.prUrl);
    if (meta.prUrl) {
      if (IN_EDITOR) { title.removeAttribute('href'); title.tabIndex = 0; title.setAttribute('role', 'link'); }
      else title.href = meta.prUrl;
      title.title = 'Open ' + meta.prUrl.replace(/^https?:\/\/[^/]+\//, '');
    } else {
      title.removeAttribute('href'); title.removeAttribute('title'); title.removeAttribute('role'); title.removeAttribute('tabindex');
    }
    const bits = [];
    if (meta.ticket) bits.push('#' + meta.ticket);
    if (meta.cwd) bits.push(meta.cwd.replace(meta.home, '~'));
    if (meta.model) bits.push(meta.model);
    if (meta.effort) bits.push('effort ' + meta.effort);
    let html = bits.map((b) => '<span>' + esc(b) + '</span>').join('');
    // The permission mode decides whether anything can stop a tool call, so it
    // is stated in words, and flagged when nothing will.
    if (meta.permissionMode) {
      const bypassing = meta.permissionMode === 'bypassPermissions';
      html += '<span class="perm-chip' + (bypassing ? ' warn' : '') + '" title="' +
        esc('Permission mode: ' + meta.permissionMode) + '">' +
        (bypassing ? icon('alert', 11) : '') +
        esc(PERMISSION_WORD[meta.permissionMode] || meta.permissionMode) + '</span>';
    }
    $('crumbs').innerHTML = html;
  }

  function setStatus(next) {
    status = next;
    paintReplies();
    if (next !== 'working' && next !== 'waiting') disarmEscape();
    $('dot').className = 'dot ' + next;
    $('stop').disabled = !(next === 'working' || next === 'waiting');
    // Sending to a stopped instance revives it with --resume, so this stays
    // enabled; disabling it left the panel a dead end after a crash.
    $('send').disabled = false;
  }

  // ── items ────────────────────────────────────────────────────

  function paint(el, item) {
    switch (item.kind) {
      case 'user': {
        el.className = 'turn-user';
        let html = '<div class="said">' + esc(item.text) + '</div>';
        if (item.snippets && item.snippets.length) {
          html += '<div class="used-snippets">' + item.snippets.map(function (name) {
            return '<span class="snippet-chip" title="' +
              esc(snippetText[name] || 'A standing instruction was added to this prompt.') +
              '">+' + esc(name) + '</span>';
          }).join('') + '</div>';
        }
        if (item.images && item.images.length) {
          html += '<div class="shots">' + item.images.map(function (im) {
            return '<img src="data:' + esc(im.mediaType) + ';base64,' + im.data + '" alt="' + esc(im.name || 'image') + '">';
          }).join('') + '</div>';
        }
        html += clockTag(item.at, 'sent-at', 'Sent');
        el.innerHTML = html;
        break;
      }

      case 'text':
        el.className = 'msg-text';
        el.innerHTML = window.renderMarkdown(item.text || '');
        break;

      case 'thinking': {
        el.className = 'thinking';
        // Signature-only thinking blocks carry no text; do not show an empty disclosure.
        el.hidden = !showThinking || !(item.text || '').trim();
        const open = el.querySelector('details') && el.querySelector('details').open;
        el.innerHTML = '<details' + (open ? ' open' : '') + '><summary>' + icon('sparkles', 12) +
          'Thinking</summary><div class="body">' + esc(item.text) + '</div></details>';
        break;
      }

      case 'tool': {
        // Running means running. Anything else is finished, one way or another:
        // a result, an error, or a turn that ended without either.
        const running = item.status === 'running';
        const abandoned = item.status === 'stopped';
        el.className = 'tool' + (item.isError ? ' err' : '');
        const details = el.querySelector('details');
        const open = details ? details.open : false;
        const mark = running ? '<span class="spinner"></span>'
          : (item.isError ? '<span class="cross">' + icon('alert', 13) + '</span>'
            : abandoned ? '<span class="cross" title="This tool never reported back — the turn ended first.">' +
                icon('alert', 13) + '</span>'
              : '<span class="tick">' + icon('check', 13) + '</span>');
        let body = '<div class="label">Input</div><pre>' + esc(pretty(item.input)) + '</pre>';
        if (item.result !== undefined && item.result !== '') {
          body += '<div class="label">' + (item.isError ? 'Error' : 'Result') + '</div><pre>' + esc(item.result) + '</pre>';
          if (item.resultClipped) {
            body += '<div class="clipped">' + esc('Showing the first ' + fmtBytes(item.result.length) +
              ' of ' + fmtBytes(item.resultLength) + '. Claude was given all of it; the whole output is in the transcript.') + '</div>';
          }
        }
        el.innerHTML = '<details' + (open ? ' open' : '') + '><summary>' +
          '<span class="disc">' + icon('chevron', 12) + '</span>' +
          '<span class="state">' + mark + '</span>' +
          '<span class="name">' + esc(item.name) + '</span>' +
          '<span class="summary-text">' + esc(summarise(item.input)) + '</span></summary>' +
          '<div class="body">' + body + '</div></details>';
        break;
      }

      case 'permission': {
        el.className = 'perm';
        if (item.resolved) {
          el.innerHTML = '<h4>' + esc(item.name) + '</h4><div class="result">' +
            (item.resolved === 'allow' ? 'Allowed' : 'Denied') + '</div>';
        } else {
          el.innerHTML = '<h4>Allow ' + esc(item.name) + '?</h4><pre>' + esc(pretty(item.input)) +
            '</pre><div class="actions"><button data-act="allow">Allow</button>' +
            '<button class="ghost" data-act="deny">Deny</button></div>';
          el.querySelectorAll('button').forEach(function (b) {
            b.addEventListener('click', function () {
              vscode.postMessage({ type: 'permission', requestId: item.requestId, allow: b.dataset.act === 'allow' });
            });
          });
        }
        break;
      }

      case 'result': {
        el.className = 'result' + (item.isError ? ' err' : '');
        const bits = [];
        if (item.interrupted) bits.push('Interrupted');
        else if (item.isError) bits.push(item.text || 'Error');
        else bits.push('Done');
        if (item.durationMs) bits.push(fmtDuration(item.durationMs));
        if (item.costUsd) bits.push('$' + item.costUsd.toFixed(4));
        el.innerHTML = bits.map((b) => '<span>' + esc(b) + '</span>').join('') +
          clockTag(item.at, 'received-at', 'Received');
        break;
      }

      case 'compact': {
        el.className = 'compacted';
        const before = item.before ? fmtBytes(item.before).replace(' characters', '') : '';
        el.innerHTML = '<span class="compacted-line"></span>' +
          '<span class="compacted-text">' +
          esc(item.trigger === 'manual' ? 'Compacted here' : 'Compacted here automatically') +
          esc(item.before ? ' · the context had reached ' + Math.round(item.before / 1000) + 'k tokens' : '') +
          '</span><span class="compacted-line"></span>';
        el.title = 'Everything above this line is still here for you to read, but the model now has ' +
          'only a summary of it. Anything below is what it can actually see.';
        break;
      }

      case 'notice':
        el.className = 'notice' + (item.level === 'error' || item.level === 'stderr' ? ' error' : '');
        el.textContent = item.text;
        break;

      default:
        el.className = 'notice';
        el.textContent = JSON.stringify(item);
    }
  }

  function copyText(text, btn) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* nothing else available in a webview */ }
    ta.remove();
    btn.classList.add('ok');
    setTimeout(function () { btn.classList.remove('ok'); }, 1200);
  }

  /**
   * Any code block is worth copying, and some are worth running.
   *
   * The run button only appears where the block is shell — either because it
   * said so or because it looks like nothing else — since a run button on a
   * block of Python is a trap and one on a diff is worse. `looksRunnable` makes
   * that call in one place, shared with the laptop that would have to run it.
   *
   * What the button does depends on where the page is. In the editor it hands
   * the command to a real terminal, because there is one and you are sitting at
   * it. On a phone there is no terminal to hand it to, so it opens the one this
   * app has and runs it there.
   */
  function decorateCode(el) {
    el.querySelectorAll('pre').forEach(function (pre) {
      if (pre.querySelector('.copy')) return;
      const code = pre.querySelector('code');
      const text = (code || pre).textContent;

      if (window.looksRunnable && window.looksRunnable(pre.dataset.lang, text)) {
        const run = document.createElement('button');
        run.className = 'run-it';
        run.title = 'Run in a terminal';
        run.setAttribute('aria-label', 'Run in a terminal');
        run.innerHTML = icon('terminal', 12);
        run.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          runCommand(window.cleanCommand ? window.cleanCommand(text) : text.trim());
        });
        pre.appendChild(run);
      }

      const btn = document.createElement('button');
      btn.className = 'copy';
      btn.title = 'Copy';
      btn.innerHTML = icon('check', 12);
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        copyText(text, btn);
      });
      pre.appendChild(btn);
    });
  }

  function runCommand(command) {
    if (!command) return;
    const remote = window.NIKUI_REMOTE;
    if (remote && remote.app) {
      // The app's own terminal, opened where this instance is and handed the
      // command on arrival.
      const query = new URLSearchParams({ run: command });
      if (remote.session) query.set('session', remote.session);
      window.location.assign('terminal.html?' + query.toString());
      return;
    }
    vscode.postMessage({ type: 'runInTerminal', command: command });
  }

  /**
   * The host drops the oldest items past its own window; the DOM follows, so a
   * conversation that runs all day cannot grow a node per line forever.
   */
  function trimStream() {
    if (!maxNodes) return;
    while (nodes.size > maxNodes) {
      const first = stream.querySelector('[data-id]');
      if (!first) return;
      nodes.delete(first.dataset.id);
      first.remove();
      dropped += 1;
    }
    paintDropped();
  }

  function paintDropped() {
    let mark = stream.querySelector('.dropped');
    if (!dropped) { if (mark) mark.remove(); return; }
    if (!mark) {
      mark = document.createElement('div');
      mark.className = 'dropped';
      stream.insertBefore(mark, stream.firstChild);
    }
    mark.textContent = dropped + ' earlier message' + (dropped === 1 ? '' : 's') +
      ' are not shown here — the full conversation is in the transcript on disk.';
  }

  /** A message is worth copying whole, not one code block at a time. */
  function decorateMessage(el, item) {
    if (item.kind !== 'text' && item.kind !== 'user') return;
    if (el.querySelector(':scope > .copy-all')) return;
    const btn = document.createElement('button');
    btn.className = 'copy copy-all';
    btn.title = 'Copy this message';
    btn.innerHTML = icon('check', 12);
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      // The copy buttons inside are part of the element, not of the message.
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.copy').forEach((b) => b.remove());
      copyText(clone.textContent.trim(), btn);
    });
    el.appendChild(btn);
  }

  /**
   * The obvious answers to a turn that has just finished, as buttons under it.
   * Only under the last turn, only once it is over, and only while the box is
   * empty — a half-typed reply is the one being given.
   */
  function paintReplies() {
    let box = $('replies');
    const picks = suggestReplies && lastKind === 'result' && lastResult &&
      !lastResult.isError && !lastResult.interrupted && status !== 'working' && status !== 'waiting' &&
      !input.value.trim() && !document.body.classList.contains('read-only')
      ? window.replySuggest.replies(lastReply) : [];
    if (!picks.length) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'replies';
      box.className = 'reply-suggestions';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Suggested replies');
    }
    const html = picks.map(function (p) {
      return '<button class="reply-chip" data-reply="' + esc(p) + '" title="Send “' + esc(p) + '”">' + esc(p) + '</button>';
    }).join('');
    if (box.innerHTML !== html) box.innerHTML = html;
    if (box !== stream.lastElementChild) stream.appendChild(box);
    if (follow) scrollDown();
  }

  stream.addEventListener('click', function (e) {
    const chip = e.target.closest && e.target.closest('.reply-chip');
    if (!chip) return;
    input.value = chip.dataset.reply;
    const box = $('replies');
    if (box) box.remove();
    send();
  });

  function upsert(items) {
    const empty = stream.querySelector('.empty');
    if (empty && items.length) empty.remove();
    for (const item of items) {
      if (item.kind === 'user') { prompts.remember(item.text, item.id); lastReply = ''; }
      if (item.kind === 'text' && !item.streaming) lastReply = item.text || '';
      if (item.kind === 'result') lastResult = item;
      const existing = nodes.get(item.id);
      if (existing) {
        paint(existing, item);
        if (!item.streaming) { decorateCode(existing); decorateMessage(existing, item); linkifyPaths(existing); }
      } else {
        const el = document.createElement('div');
        el.dataset.id = item.id;
        paint(el, item);
        if (!item.streaming) { decorateCode(el); decorateMessage(el, item); linkifyPaths(el); }
        nodes.set(item.id, el);
        stream.appendChild(el);
        // Notices and the like come and go; what the turn ended on is what counts.
        if (item.kind !== 'notice') lastKind = item.kind;
      }
    }
    paintReplies();
    trimStream();
    refreshFind();
    if (follow) scrollDown();
  }

  // ── queue ────────────────────────────────────────────────────

  function disarmClear() {
    if (!clearArmed) return;
    clearArmed = false;
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    paintQueue();
  }

  function paintQueue() {
    const el = $('queue');
    if (!queued.length) {
      clearArmed = false;
      if (!el.hidden) { el.hidden = true; el.innerHTML = ''; }
      return;
    }
    const left = drainAt ? Math.max(0, Math.ceil((drainAt - Date.now()) / 1000)) : null;
    const when = left !== null
      ? (left > 0 ? 'sending in ' + left + 's' : 'sending…')
      : 'waiting for this turn to finish';
    el.hidden = false;
    el.innerHTML =
      '<div class="queue-head">' + icon('clock', 12) +
      '<span>' + queued.length + ' queued · ' + esc(when) + '</span>' +
      '<button class="link" data-clear="1">' + (clearArmed ? 'Clear ' + queued.length + '?' : 'Clear') + '</button></div>' +
      queued.map(function (q, i) {
        return '<div class="queue-row"><span class="n">' + (i + 1) + '</span>' +
          '<span class="t">' + esc(q.text || '(image only)') + '</span>' +
          (q.images ? '<span class="imgs">' + icon('image', 11) + q.images + '</span>' : '') +
          (q.lostImages ? '<span class="imgs" title="Images are not saved across a reload — the words came back, the pictures did not.">' +
            icon('image', 11) + q.lostImages + ' lost</span>' : '') +
          (i > 0 ? '<button class="drop" data-promote="' + esc(q.id) + '" title="Send this one next">' + icon('chevron', 11) + '</button>' : '') +
          '<button class="drop" data-edit="' + esc(q.id) + '" title="Take it back to the composer">' + icon('paperclip', 11) + '</button>' +
          '<button class="drop" data-unqueue="' + esc(q.id) + '" title="Remove">' + icon('x', 11) + '</button></div>';
      }).join('');
  }

  $('queue').addEventListener('click', function (e) {
    const promote = e.target.closest('[data-promote]');
    if (promote) { vscode.postMessage({ type: 'promoteQueued', id: promote.dataset.promote }); return; }

    const edit = e.target.closest('[data-edit]');
    if (edit) { vscode.postMessage({ type: 'editQueued', id: edit.dataset.edit }); return; }

    const drop = e.target.closest('[data-unqueue]');
    if (drop) { vscode.postMessage({ type: 'unqueue', id: drop.dataset.unqueue }); return; }
    if (e.target.closest('[data-clear]')) {
      // Queued prompts are typed work; one click should not be able to lose
      // them. The first click asks, and forgets the question after a moment.
      if (clearArmed) { disarmClear(); vscode.postMessage({ type: 'clearQueue' }); return; }
      clearArmed = true;
      paintQueue();
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(function () { clearTimer = null; disarmClear(); }, 4000);
      return;
    }
  });

  // ── file references ──────────────────────────────────────────

  // Require either a directory separator or a known code extension, so prose
  // like "example.com" is not turned into a link.
  const PATH_RE = new RegExp(
    '((?:[A-Za-z0-9._~-]+\\/)+[A-Za-z0-9._~-]+\\.[A-Za-z0-9]{1,8}' +
    // Longest extensions first: otherwise "js" wins inside "json".
    '|\\b[A-Za-z0-9._~-]+\\.(?:gradle|svelte|swift|scss|yaml|json|html|bash|toml|java|jsx|tsx|mjs|cjs|vue|php|sql|xml|txt|css|yml|zsh|cpp|hpp|md|py|kt|go|rs|rb|sh|js|ts|c|h))' +
    // The extension must end here, so "package.json" is not read as "package.js".
    '(?![A-Za-z0-9])' +
    '(?::(\\d+))?(?::(\\d+))?', 'g');

  function insideUrl(text, index) {
    const back = text.slice(Math.max(0, index - 12), index);
    return back.indexOf('://') >= 0 || /[\w)@]$/.test(back.slice(-1));
  }

  function linkifyPaths(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || node.nodeValue.length < 4) return NodeFilter.FILTER_REJECT;
        let el = node.parentElement;
        while (el && el !== root) {
          if (el.tagName === 'A' || el.classList.contains('fileref')) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    for (const node of nodes) {
      const text = node.nodeValue;
      PATH_RE.lastIndex = 0;
      let m, last = 0, frag = null;
      while ((m = PATH_RE.exec(text)) !== null) {
        if (insideUrl(text, m.index)) continue;
        frag = frag || document.createDocumentFragment();
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const a = document.createElement('span');
        a.className = 'fileref';
        a.dataset.path = m[1];
        if (m[2]) a.dataset.line = m[2];
        a.textContent = m[0];
        a.title = 'Open ' + m[1];
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  // ── attachments ──────────────────────────────────────────────

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  function addFiles(files) {
    for (const file of files) {
      if (!file || !/^image\//.test(file.type)) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        upsert([{ id: 'n-big-' + Date.now(), kind: 'notice', level: 'error',
          text: (file.name || 'That image') + ' is ' + Math.round(file.size / 1048576) +
                'MB; the limit is 10MB.' }]);
        continue;
      }
      const reader = new FileReader();
      reader.onload = function () {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        if (comma < 0) return;
        attachments.push({
          id: 'a' + (attachSeq++),
          name: file.name || 'pasted.png',
          mediaType: file.type,
          data: result.slice(comma + 1)
        });
        paintAttachments();
      };
      reader.readAsDataURL(file);
    }
  }

  function paintAttachments() {
    attachBar.innerHTML = attachments.map(function (a) {
      return '<div class="chip" data-id="' + a.id + '">' +
        '<img src="data:' + esc(a.mediaType) + ';base64,' + a.data + '" alt="' + esc(a.name) + '">' +
        '<button class="drop" title="Remove" data-drop="' + a.id + '">' + icon('x', 12) + '</button></div>';
    }).join('');
  }

  attachBar.addEventListener('click', function (e) {
    const drop = e.target.closest('[data-drop]');
    if (drop) {
      attachments = attachments.filter((a) => a.id !== drop.dataset.drop);
      paintAttachments();
      return;
    }
    const img = e.target.closest('.chip img');
    if (img) openLightbox(img.src);
  });

  document.addEventListener('paste', function (e) {
    const items = (e.clipboardData && e.clipboardData.files) || [];
    if (items.length) { addFiles(items); e.preventDefault(); }
  });

  // Dropping a file with no feedback is a guess. The overlay says the panel is
  // ready to take it; the counter keeps it steady as the pointer crosses
  // children, which each fire their own dragleave.
  let dragDepth = 0;
  const showDrop = (on) => document.body.classList.toggle('dropping', on);

  document.addEventListener('dragenter', function (e) {
    e.preventDefault();
    dragDepth += 1;
    showDrop(true);
  });
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showDrop(false);
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    showDrop(false);
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  $('attach').addEventListener('click', () => filePicker.click());
  filePicker.addEventListener('change', function () { addFiles(filePicker.files); filePicker.value = ''; });

  // ── lightbox ─────────────────────────────────────────────────

  function openLightbox(src) { lbImg.src = src; lightbox.hidden = false; }
  function closeLightbox() { lightbox.hidden = true; lbImg.src = ''; }

  stream.addEventListener('click', function (e) {
    const ref = e.target.closest('.fileref');
    if (ref) {
      vscode.postMessage({ type: 'openFile', path: ref.dataset.path, line: ref.dataset.line });
      return;
    }
    const img = e.target.closest('.shots img');
    if (img) openLightbox(img.src);
  });
  lightbox.addEventListener('click', closeLightbox);
  $('lb-close').addEventListener('click', closeLightbox);

  // ── slash palette ────────────────────────────────────────────

  /** Everything the palette chooses from, as it stands right now. */
  function slashSources() {
    return {
      commands: commands,
      args: commandArgs,
      own: ownCommands,
      snippets: snippetText,
      // So a list of values can say which one is already in force.
      now: { model: meta.model || '', effort: meta.effort || '' }
    };
  }

  function refreshSlash() {
    slashPlan = window.palette.plan(input.value, slashSources());
    if (!slashPlan) { slashBox.hidden = true; return; }

    slashIndex = 0;
    if (!slashPlan.matches.length) {
      slashBox.innerHTML = '<div class="none">' +
        (slashPlan.mode === 'cmd' && !commands.length
          ? 'Commands appear once the instance is running'
          : 'No match') + '</div>';
      slashBox.hidden = false;
      return;
    }
    paintSlash();
    slashBox.hidden = false;
  }

  function paintSlash() {
    const rows = slashPlan.matches.map(function (row, i) {
      return '<div class="row' + (i === slashIndex ? ' on' : '') + '" data-at="' + i + '">' +
        icon(slashPlan.mode === 'cmd' ? 'slash' : 'chevron', 12) +
        '<span class="cmd">' + esc(row.label) + '</span>' +
        (row.note ? '<span class="ns">' + esc(row.note) + '</span>' : '') + '</div>';
    }).join('');
    slashBox.innerHTML = '<div class="palette-hint"><span>' + esc(slashPlan.hint) +
      '</span><span>' + esc(slashPlan.keys) + '</span></div>' + rows;
    const on = slashBox.querySelector('.row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  // Returns 'filled' when more input is expected, 'ready' when the line is complete.
  function acceptSlash() {
    if (slashBox.hidden || !slashPlan || !slashPlan.matches.length) return null;
    const taken = window.palette.apply(slashPlan, slashIndex, slashSources());
    if (!taken) return null;
    input.value = taken.value;
    autoGrow();
    // A command that takes values shows them straight away; anything else
    // closes, leaving a trailing space so another "/" opens the palette again.
    if (taken.more) refreshSlash();
    else slashBox.hidden = true;
    return taken.more ? 'filled' : 'ready';
  }

  slashBox.addEventListener('click', function (e) {
    const row = e.target.closest('[data-at]');
    if (!row) return;
    slashIndex = Number(row.dataset.at);
    acceptSlash();
    input.focus();
  });

  // ── composing ────────────────────────────────────────────────

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 260) + 'px';
  }

  function send() {
    const text = input.value.trim();
    if (!text && !attachments.length) return;
    // /status is answered here, from what the host measured, rather than being
    // passed to the CLI — the sheet knows things the CLI cannot see.
    // Only the bare command is ours; "/status something" belongs to the CLI.
    // /settings the same way: the few settings people change, as switches.
    // /watch, alone or in front of a prompt: NikUI watches the PR's CI, and
    // the prompt goes with permission to push.
    const watch = !attachments.length && /^\/watch(?:\s+([\s\S]*))?$/i.exec(text);
    if (watch) {
      vscode.postMessage({ type: 'watch', text: (watch[1] || '').trim() });
      prompts.remember(text);
      prompts.reset();
      input.value = '';
      remember();
      slashBox.hidden = true;
      autoGrow();
      return;
    }
    const own = !attachments.length && /^\/(status|settings|commands)$/i.exec(text);
    if (own) {
      prompts.remember(text);
      prompts.reset();
      input.value = '';
      slashBox.hidden = true;
      autoGrow();
      const which = own[1].toLowerCase();
      if (which === 'status') askForStatus();
      else if (which === 'commands') askForCommands();
      else askForSettings();
      return;
    }
    // A snippet adds a standing instruction to what you typed. The panel keeps
    // showing your words; the model gets yours plus the instruction.
    const shaped = window.snippets.expand(text, snippetText);
    vscode.postMessage({
      type: 'send',
      text: shaped.text,
      sent: shaped.sent,
      snippets: shaped.used,
      attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }))
    });
    prompts.remember(text);
    prompts.reset();
    input.value = '';
    remember();
    attachments = [];
    paintAttachments();
    slashBox.hidden = true;
    autoGrow();
    follow = true;
    jump.hidden = true;
    scrollDown();
  }

  // Typing over a recalled prompt makes it the user's own text again.
  input.addEventListener('input', function () {
    if (prompts.browsing() && input.value !== prompts.current()) prompts.reset();
    autoGrow();
    refreshSlash();
    remember();
    paintReplies();
  });

  function recall(text) {
    input.value = text;
    slashBox.hidden = true; // a recalled "/command" must not steal the arrows
    autoGrow();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    input.scrollTop = input.scrollHeight;
  }

  input.addEventListener('keydown', function (e) {
    if (!slashBox.hidden && slashPlan && slashPlan.matches.length) {
      const count = slashPlan.matches.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % count; paintSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex - 1 + count) % count; paintSlash(); return; }
      if (e.key === 'Tab') { if (acceptSlash()) { e.preventDefault(); return; } }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Choosing a value finishes the line — "/model claude-opus-5-5" is the
        // whole prompt — so it goes. A command or a snippet leaves the cursor
        // where more can be typed, including another slash.
        const finished = slashPlan.mode === 'value';
        if (acceptSlash() && finished) send();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); slashBox.hidden = true; return; }
    }
    // Up from an empty box starts walking back through past prompts; once
    // walking, both arrows keep moving through them until the text is edited.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      let text = null;
      if (e.key === 'ArrowUp') {
        if (prompts.browsing() || !input.value.trim()) text = prompts.older(input.value);
      } else if (prompts.browsing()) {
        text = prompts.newer();
      }
      if (text !== null) { e.preventDefault(); recall(text); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape') {
      if (!lightbox.hidden) { closeLightbox(); return; }
      if (!sheet.hidden) { closeSheet(); return; }
      escapePressed();
    }
  });

  input.addEventListener('blur', function () {
    // Let a click on a row land before the palette disappears.
    setTimeout(function () { if (document.activeElement !== input) slashBox.hidden = true; }, 120);
  });

  $('send').addEventListener('click', send);
  $('stop').addEventListener('click', function () { vscode.postMessage({ type: 'interrupt' }); });

  /**
   * Escape is the key people press to dismiss things, and here it abandons a
   * turn that may have been running for minutes. So the first press arms it and
   * says so; the second, within two seconds, actually interrupts. Anyone who
   * wants the CLI's single press can have it back in settings.
   */
  function escapePressed() {
    if (!isBusy()) { disarmEscape(); return; }
    if (singleEscape || Date.now() < escArmedUntil) {
      disarmEscape();
      vscode.postMessage({ type: 'interrupt' });
      return;
    }
    escArmedUntil = Date.now() + 2000;
    escHint.hidden = false;
    if (escTimer) clearTimeout(escTimer);
    escTimer = setTimeout(disarmEscape, 2000);
  }

  function disarmEscape() {
    escArmedUntil = 0;
    escHint.hidden = true;
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
  }

  function isBusy() {
    const dot = $('dot').className;
    return /working|waiting/.test(dot);
  }


  // ── find in conversation ─────────────────────────────────────
  // VS Code's find widget does not reach inside a webview panel, so the panel
  // brings its own. Matches are wrapped in <mark> in place, which keeps the
  // markup we already render and survives being re-run after an update.

  const findBar = $('find');
  const findInput = $('find-input');
  const findCount = $('find-count');
  const findNote = $('find-note');
  let hits = [];
  let hitAt = -1;
  let findTimer = null;

  function clearHighlights() {
    const marks = stream.querySelectorAll('mark.hit');
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
    hits = [];
  }

  /** Every text node under the stream, skipping what we have already marked. */
  function textNodes() {
    const walker = document.createTreeWalker(stream, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest('mark.hit')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.copy, .dropped, button')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const out = [];
    let node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
  }

  function runFind(keepIndex) {
    const needle = findInput.value;
    clearHighlights();
    if (!needle) { hitAt = -1; paintFind(); return; }

    const lower = needle.toLowerCase();
    for (const node of textNodes()) {
      const text = node.nodeValue;
      const hay = text.toLowerCase();
      let from = 0;
      let at = hay.indexOf(lower, from);
      if (at < 0) continue;
      // Split the node once per match, walking left to right.
      let current = node;
      let consumed = 0;
      while (at >= 0) {
        const local = at - consumed;
        const tail = current.splitText(local);
        const rest = tail.splitText(needle.length);
        const mark = document.createElement('mark');
        mark.className = 'hit';
        mark.textContent = tail.nodeValue;
        tail.parentNode.replaceChild(mark, tail);
        hits.push(mark);
        consumed = at + needle.length;
        current = rest;
        from = consumed;
        at = hay.indexOf(lower, from);
      }
    }

    if (!hits.length) hitAt = -1;
    else if (!keepIndex || hitAt < 0) hitAt = 0;
    else hitAt = Math.min(hitAt, hits.length - 1);
    focusHit(false);
    paintFind();
  }

  function focusHit(scroll) {
    hits.forEach((m, i) => m.classList.toggle('on', i === hitAt));
    const mark = hits[hitAt];
    if (!mark) return;
    // Tool inputs and thinking blocks are collapsed by default, and find looks
    // inside them — so stepping onto a match there used to scroll to a closed
    // disclosure and highlight nothing. Whatever it is in, it opens.
    let box = mark.closest ? mark.closest('details') : null;
    while (box) {
      box.open = true;
      box = box.parentElement && box.parentElement.closest ? box.parentElement.closest('details') : null;
    }
    if (scroll !== false) mark.scrollIntoView({ block: 'center' });
  }

  function paintFind() {
    findCount.textContent = hits.length ? (hitAt + 1) + ' of ' + hits.length : (findInput.value ? 'no matches' : '0 of 0');
    // Searching what is on screen is only worth saying when that is less than
    // the whole conversation.
    findNote.hidden = !dropped;
    if (dropped) findNote.textContent = 'searching the ' + nodes.size + ' messages still in the panel';
  }

  function step(by) {
    if (!hits.length) return;
    hitAt = (hitAt + by + hits.length) % hits.length;
    focusHit(true);
    paintFind();
  }

  function openFind() {
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) runFind(true);
  }

  function closeFind() {
    findBar.hidden = true;
    clearHighlights();
    hitAt = -1;
    input.focus();
  }

  findInput.addEventListener('input', function () {
    if (findTimer) clearTimeout(findTimer);
    findTimer = setTimeout(function () { findTimer = null; runFind(false); }, 120);
  });
  findInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('find-next').addEventListener('click', () => step(1));
  $('find-prev').addEventListener('click', () => step(-1));
  $('find-close').addEventListener('click', closeFind);

  /** The transcript moved under the search; find the same word again. */
  function refreshFind() {
    if (findBar.hidden || !findInput.value) return;
    if (findTimer) clearTimeout(findTimer);
    findTimer = setTimeout(function () { findTimer = null; runFind(true); }, 300);
  }

  // ── status sheet ─────────────────────────────────────────────

  const sheetApi = window.statusSheet;
  let report = null;
  let section = 'overview';
  // One sheet on screen at a time: /status, /settings or /commands.
  let sheetKind = null;

  function askForStatus() { vscode.postMessage({ type: 'status' }); }

  function paintSheet(opening) {
    if (!report) return;
    // A redraw throws away the element that had focus, so it is put back —
    // but only if it was in the sheet to begin with.
    const refocus = sheet.contains(document.activeElement);
    sheet.innerHTML = sheetApi.renderSheet(report, section);
    sheet.hidden = false;
    const content = sheet.querySelector('.sheet-content');
    if (!content) return;
    content.scrollTop = 0;
    if (opening || refocus) content.focus();
  }

  // What had focus before the sheet took over, so it can be given back.
  let focusBeforeSheet = null;

  /** The rest of the page is inert while the sheet is up, and lit again after. */
  function setBackgroundInert(on) {
    ['header', 'transcript', 'find'].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      if (on) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
    const footer = document.querySelector('footer');
    if (footer) { if (on) footer.setAttribute('inert', ''); else footer.removeAttribute('inert'); }
  }

  function showSheet(next) {
    // A report for a sheet that has since become /settings is not wanted.
    if (!sheet.hidden && sheetKind !== 'status') return;
    const opening = sheet.hidden;
    if (opening) {
      sheetKind = 'status';
      section = sheetApi.SECTIONS[0].id; // a fresh open always starts at the top
      focusBeforeSheet = document.activeElement;
      setBackgroundInert(true);
      vscode.postMessage({ type: 'statusOpen', open: true });
    }
    report = next;
    // An update while it is open must not throw the reader back to the top.
    const content = sheet.querySelector('.sheet-content');
    const where = opening || !content ? 0 : content.scrollTop;
    paintSheet(opening);
    if (where) {
      const now = sheet.querySelector('.sheet-content');
      if (now) now.scrollTop = where;
    }
  }

  function closeSheet() {
    if (!sheet.hidden && sheetKind === 'settings') vscode.postMessage({ type: 'settingsOpen', open: false });
    else if (!sheet.hidden && sheetKind === 'commands') vscode.postMessage({ type: 'commandsOpen', open: false });
    else if (!sheet.hidden) vscode.postMessage({ type: 'statusOpen', open: false });
    sheetKind = null;
    prefsWaiting = false;
    sheet.hidden = true;
    sheet.innerHTML = '';
    tip.hidden = true;
    setBackgroundInert(false);
    const back = focusBeforeSheet;
    focusBeforeSheet = null;
    if (back && back.focus && document.contains(back)) back.focus();
    else input.focus();
  }

  /**
   * Tab stays inside the sheet while it is open. `inert` does most of this
   * already, but it cannot stop Tab from falling off the last control and
   * landing nowhere, so the ends are joined up by hand.
   */
  function trapTab(e) {
    if (sheet.hidden || e.key !== 'Tab') return;
    const stops = sheet.querySelectorAll('button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), input, textarea, a[href]');
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const on = document.activeElement;
    if (e.shiftKey && (on === first || !sheet.contains(on))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && on === last) { e.preventDefault(); first.focus(); }
  }

  function moveSection(step) {
    const ids = sheetApi.SECTIONS.map((s) => s.id);
    const at = ids.indexOf(section);
    section = ids[(at + step + ids.length) % ids.length];
    paintSheet();
  }

  // ── settings sheet ───────────────────────────────────────────

  const prefsApi = window.prefsSheet;
  let prefsNow = null;
  // Asked for and not yet drawn: the first answer opens the sheet, and an
  // answer nobody asked for — a change somewhere else — opens nothing.
  let prefsAsked = false;
  // A redraw while a picker is open would close it under somebody's thumb.
  let prefsWaiting = false;

  function askForSettings() { prefsAsked = true; vscode.postMessage({ type: 'settings' }); }

  function onSettings(message) {
    const open = !sheet.hidden && sheetKind === 'settings';
    if (!open && !prefsAsked) return;
    prefsAsked = false;
    prefsNow = message;
    if (!open) {
      sheetKind = 'settings';
      focusBeforeSheet = document.activeElement;
      setBackgroundInert(true);
    }
    paintSettings(!open);
  }

  /** Which control had focus, so the same one has it after a redraw. */
  function focusKey() {
    const on = document.activeElement;
    if (!on || !sheet.contains(on)) return null;
    for (const attr of ['data-toggle', 'data-choose', 'data-step', 'data-act', 'data-command']) {
      if (on.hasAttribute(attr)) {
        const by = on.getAttribute('data-by');
        return '[' + attr + '="' + on.getAttribute(attr) + '"]' + (by ? '[data-by="' + by + '"]' : '');
      }
    }
    return null;
  }

  function paintSettings(opening) {
    if (!prefsNow) return;
    const picking = document.activeElement && document.activeElement.tagName === 'SELECT' &&
      sheet.contains(document.activeElement);
    if (!opening && picking) { prefsWaiting = true; return; }
    prefsWaiting = false;
    const list = sheet.querySelector('.prefs');
    const where = opening || !list ? 0 : list.scrollTop;
    const keep = opening ? null : focusKey();
    sheet.innerHTML = prefsApi.render(prefsNow);
    sheet.hidden = false;
    const now = sheet.querySelector('.prefs');
    if (now) now.scrollTop = where;
    const back = keep ? sheet.querySelector(keep) : null;
    if (back && !back.disabled) back.focus();
    else if (opening && now) now.focus();
  }

  /**
   * Shown changed at once, and then shown as it really is: the answer from the
   * laptop replaces this, refused or not, so a switch that could not flip
   * flips back and says why.
   */
  function changeSetting(id, value) {
    const row = prefsApi.valueOf(prefsNow, id);
    if (!row || row.unavailable || prefsNow.mayChange === false) return;
    row.value = value;
    prefsNow.refused = null;
    paintSettings(false);
    const node = sheet.querySelector('[data-pref="' + id + '"]');
    if (node) node.classList.add('pending');
    vscode.postMessage({ type: 'setSetting', id: id, value: value });
  }

  function settingsClick(e) {
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'close') closeSheet();
      else if (act.dataset.act === 'all-settings') { closeSheet(); vscode.postMessage({ type: 'allSettings' }); }
      else if (act.dataset.act === 'commands') askForCommands();
      return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle && !toggle.disabled) {
      const row = prefsApi.valueOf(prefsNow, toggle.dataset.toggle);
      changeSetting(toggle.dataset.toggle, !(row && row.value));
      return;
    }
    const step = e.target.closest('[data-step]');
    if (step && !step.disabled) {
      const row = prefsApi.valueOf(prefsNow, step.dataset.step);
      if (row) changeSetting(step.dataset.step, Number(row.value) + Number(step.dataset.by));
    }
  }

  // ── commands sheet ───────────────────────────────────────────

  const cmdApi = window.commandsSheet;
  let cmdNow = null;
  let cmdAsked = false;
  // What this page is doing, which is nobody else's business: which entry is
  // open, the draft being typed, and a delete waiting for its second tap.
  const cmdView = { active: null, editing: null, confirm: null, refused: null, saving: false };

  function askForCommands() { cmdAsked = true; vscode.postMessage({ type: 'commands' }); }

  function onCommands(message) {
    const open = !sheet.hidden && sheetKind === 'commands';
    if (!open && !cmdAsked) return;
    cmdAsked = false;
    cmdNow = message;
    if (!open) {
      // Reached from /settings, which it replaces rather than sits on top of.
      if (!sheet.hidden && sheetKind === 'settings') vscode.postMessage({ type: 'settingsOpen', open: false });
      else if (!sheet.hidden && sheetKind === 'status') vscode.postMessage({ type: 'statusOpen', open: false });
      else { focusBeforeSheet = document.activeElement; setBackgroundInert(true); }
      sheetKind = 'commands';
      Object.assign(cmdView, { active: null, editing: null, confirm: null, refused: null, saving: false });
    }
    if (message.refused) {
      cmdView.refused = message.refused;
      cmdView.saving = false;
    } else if (message.done) {
      // Done: the form goes, and the page shows what was saved. A change made
      // somewhere else arrives without `done` and leaves a draft alone — and so
      // does the late answer to a restore or a delete, if a form was opened
      // after it was asked for.
      const ours = message.done === 'saveCommand' ? cmdView.saving : !cmdView.editing;
      if (ours) {
        Object.assign(cmdView, { editing: null, confirm: null, refused: null, saving: false });
        if (message.name) cmdView.active = message.name;
      }
    }
    paintCommands(!open);
  }

  function paintCommands(opening) {
    if (!cmdNow) return;
    const content = sheet.querySelector('.sheet-content');
    const where = opening || !content ? 0 : content.scrollTop;
    const on = document.activeElement;
    const inSheet = !opening && on && sheet.contains(on);
    const keep = inSheet ? (on.id ? '#' + on.id : focusKey()) : null;
    const caret = inSheet && on.id && typeof on.selectionStart === 'number' ? [on.selectionStart, on.selectionEnd] : null;
    sheet.innerHTML = cmdApi.render(cmdNow, cmdView);
    sheet.hidden = false;
    const now = sheet.querySelector('.sheet-content');
    if (now) now.scrollTop = where;
    const back = keep ? sheet.querySelector(keep) : null;
    if (back && !back.disabled) {
      back.focus();
      if (caret && back.setSelectionRange) back.setSelectionRange(caret[0], caret[1]);
    } else if ((opening || inSheet) && now) now.focus();
  }

  /** The entry the page has open, as the laptop last described it. */
  function cmdOpen() { return cmdApi.pick((cmdNow && cmdNow.commands) || [], cmdView.active); }

  function cmdFocus(selector) {
    const el = sheet.querySelector(selector);
    if (el) el.focus();
  }

  function cancelEdit() {
    if (cmdView.active === cmdApi.NEW) cmdView.active = null;
    Object.assign(cmdView, { editing: null, refused: null, saving: false });
    paintCommands(false);
  }

  function saveCommand() {
    const d = cmdView.editing;
    if (!d || cmdView.saving) return;
    cmdView.saving = true;
    cmdView.refused = null;
    paintCommands(false);
    vscode.postMessage({ type: 'saveCommand', was: d.was, name: d.name, description: d.description, prompt: d.prompt });
  }

  /** A change this device was not allowed to make, said where it was made. */
  function commandsRefused(msg) {
    if (sheetKind !== 'commands' || !/Command$/.test((msg && msg.what) || '')) return;
    cmdView.saving = false;
    cmdView.refused = (msg && msg.reason) || 'That is not allowed from this device.';
    paintCommands(false);
  }

  function commandsClick(e) {
    const item = e.target.closest('[data-command]');
    if (item) {
      const name = item.dataset.command;
      Object.assign(cmdView, { active: name, editing: null, confirm: null, refused: null, saving: false });
      if (name === cmdApi.NEW) cmdView.editing = { was: '', name: '', description: '', prompt: '' };
      paintCommands(false);
      const content = sheet.querySelector('.sheet-content');
      if (content) content.scrollTop = 0;
      if (name === cmdApi.NEW) cmdFocus('#cmd-name');
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act || act.disabled) return;
    const open = cmdOpen();
    switch (act.dataset.act) {
      case 'close': closeSheet(); break;
      case 'settings': closeSheet(); askForSettings(); break;
      case 'edit':
        if (!open || open.kind !== 'snippet') break;
        cmdView.editing = { was: open.name, name: open.name, description: open.description, prompt: open.prompt };
        cmdView.refused = null;
        paintCommands(false);
        cmdFocus('#cmd-prompt');
        break;
      case 'cancel': cancelEdit(); break;
      case 'save': saveCommand(); break;
      case 'ask-remove':
        if (!open) break;
        cmdView.confirm = open.name;
        paintCommands(false);
        cmdFocus('[data-act="remove"]');
        break;
      case 'keep': cmdView.confirm = null; paintCommands(false); break;
      case 'remove':
        if (!open) break;
        cmdView.confirm = null;
        vscode.postMessage({ type: 'removeCommand', name: open.name });
        break;
      case 'restore':
        if (open) vscode.postMessage({ type: 'restoreCommand', name: open.name });
        break;
    }
  }

  // The draft follows the form, so a redraw — another device saving, say —
  // cannot throw away what is being typed.
  sheet.addEventListener('input', function (e) {
    if (sheetKind !== 'commands' || !cmdView.editing) return;
    const field = e.target.dataset && e.target.dataset.field;
    if (field) cmdView.editing[field] = e.target.value;
  });

  sheet.addEventListener('change', function (e) {
    if (sheetKind !== 'settings') return;
    const pick = e.target.closest('[data-choose]');
    if (pick) changeSetting(pick.dataset.choose, pick.value);
  });
  // A picker that closed without a change still owes the redraw it held back.
  sheet.addEventListener('focusout', function (e) {
    if (sheetKind === 'settings' && prefsWaiting && e.target.tagName === 'SELECT') {
      setTimeout(function () { if (prefsWaiting) paintSettings(false); }, 0);
    }
  });

  sheet.addEventListener('click', function (e) {
    if (sheetKind === 'settings') { settingsClick(e); return; }
    if (sheetKind === 'commands') { commandsClick(e); return; }
    const nav = e.target.closest('[data-section]');
    if (nav) { section = nav.dataset.section; paintSheet(); return; }

    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'close') closeSheet();
      else if (act.dataset.act === 'refresh') askForStatus();
      else if (act.dataset.act === 'cli') {
        closeSheet();
        vscode.postMessage({ type: 'send', text: '/status', attachments: [] });
      }
      else if (act.dataset.act === 'copy' && report) copyText(sheetApi.asText(report), act);
      return;
    }

    const row = e.target.closest('[data-action]');
    if (!row) return;
    const [kind, ...rest] = row.dataset.action.split(':');
    const value = rest.join(':');
    if (kind === 'open') vscode.postMessage({ type: 'openFile', path: value, line: 1 });
    else if (kind === 'switch') { closeSheet(); vscode.postMessage({ type: 'switch', id: value }); }
  });

  // Enter on a focused row does what clicking it does.
  sheet.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('[data-action]');
    if (row) { e.preventDefault(); row.click(); }
  });

  // One tooltip for every mark in the sheet, so charts stay markup-only.
  sheet.addEventListener('mousemove', function (e) {
    const mark = e.target.closest('[data-tip]');
    if (!mark) { tip.hidden = true; return; }
    tip.textContent = mark.dataset.tip;
    tip.hidden = false;
    const box = tip.getBoundingClientRect();
    const x = Math.min(window.innerWidth - box.width - 12, Math.max(8, e.clientX + 14));
    const y = Math.max(8, e.clientY - box.height - 12);
    tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  });
  sheet.addEventListener('mouseleave', function () { tip.hidden = true; });

  // ── host messages ────────────────────────────────────────────

  window.addEventListener('message', function (event) {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        sessionId = msg.sessionId;
        window.__clientId = msg.client || null;
        remember();
        showThinking = msg.showThinking;
        clock = msg.clock === '12h' ? '12h' : '24h';
        suggestReplies = msg.replySuggestions !== false;
        lastReply = ''; lastKind = ''; lastResult = null;
        singleEscape = !!msg.singleEscape;
        disarmEscape();
        commands = msg.slashCommands || [];
        commandArgs = msg.commandArgs || {};
        ownCommands = msg.ownCommands || [];
        snippetText = msg.snippets || {};
        if (msg.font) document.documentElement.style.setProperty('--nik-font', msg.font);
        if (msg.fontSize) document.documentElement.style.setProperty('--nik-font-size', msg.fontSize + 'px');
        stream.innerHTML = msg.items.length ? '' : '<div class="empty">Ask Claude anything to start.</div>';
        nodes.clear();
        dropped = msg.dropped || 0;
        maxNodes = msg.maxItems || 0;
        upsert(msg.items);
        paintDropped();
        setMeta(msg.meta);
        setStatus(msg.status);
        setStats(msg.stats);
        queued = msg.queue || [];
        drainAt = msg.drainAt || null;
        paintQueue();
        // A panel that was hidden long enough to be thrown away comes back with
        // the draft still typed and the reader still where they left off.
        if (saved.draft && !input.value) { input.value = saved.draft; autoGrow(); }
        follow = saved.follow !== false;
        jump.hidden = follow;
        if (follow) scrollDown();
        else scroller.scrollTop = saved.scrollTop || 0;
        break;
      case 'items': upsert(msg.items); break;
      case 'queue':
        queued = msg.queue || [];
        drainAt = msg.drainAt || null;
        paintQueue();
        break;
      case 'meta':
        // Settings can change while this page is open, so they arrive here as
        // well as in `init` — and are applied the same way.
        if (typeof msg.showThinking === 'boolean') showThinking = msg.showThinking;
        if (msg.clock) setClock(msg.clock);
        if (typeof msg.replySuggestions === 'boolean') { suggestReplies = msg.replySuggestions; paintReplies(); }
        if (typeof msg.singleEscape === 'boolean') { singleEscape = msg.singleEscape; disarmEscape(); }
        if (msg.font !== undefined) {
          document.documentElement.style.setProperty('--nik-font', msg.font || '');
        }
        if (msg.fontSize) {
          document.documentElement.style.setProperty('--nik-font-size', msg.fontSize + 'px');
        }
        setMeta(msg.meta);
        if (msg.slashCommands) commands = msg.slashCommands;
        if (msg.commandArgs) commandArgs = msg.commandArgs;
        if (msg.ownCommands) ownCommands = msg.ownCommands;
        if (msg.snippets) snippetText = msg.snippets;
        break;
      case 'status': setStatus(msg.status); break;
      case 'stats': setStats(msg.stats); break;
      case 'reset':
        stream.innerHTML = '<div class="empty">Context cleared.</div>';
        nodes.clear();
        // Everything that described the conversation goes with it: a cleared
        // context has no dropped messages and no search results.
        dropped = 0;
        closeFind();
        break;
      case 'focus': input.focus(); break;

      // Whether this client may steer. In the panel neither of these arrives;
      // over a socket the welcome says what this device was granted, and
      // @device says so again whenever that changes underneath it.
      case '@welcome':
      case '@device': setControl(msg.device); break;
      case '@denied': setControl({ control: false }); break;
      case '@refused': flashRefusal(msg); commandsRefused(msg); break;

      // Who else is watching this instance. Only ever other people's presence:
      // what they are typing is theirs and is never sent anywhere.
      case 'presence': setPresence(msg.clients); break;
      case 'statusReport': showSheet(msg.report); break;
      case 'settings': onSettings(msg); break;
      case 'commands': onCommands(msg); break;
      case 'editPrompt': {
        // Nothing typed is thrown away: a draft already in the box keeps its
        // place underneath the prompt that came back out of the queue.
        const draft = input.value.trim();
        input.value = draft ? msg.text + '\n\n' + draft : msg.text;
        autoGrow();
        remember();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        break;
      }
      case 'openStatus': askForStatus(); break;
    }
  });

  window.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F') && !e.altKey) {
      e.preventDefault();
      openFind();
      return;
    }
    trapTab(e);
    if (e.key === 'Escape' && !findBar.hidden && sheet.hidden) { closeFind(); return; }
    if (e.key === 'Escape' && !lightbox.hidden) { closeLightbox(); return; }
    if (sheet.hidden) return;
    // In the form, Escape puts the draft down rather than the whole page, and
    // Cmd/Ctrl+Enter saves it.
    if (sheetKind === 'commands' && cmdView.editing) {
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveCommand(); return; }
    }
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    // Arrows and numbers move through /status's sections; /settings has none,
    // and its pickers want the arrows for themselves.
    if (sheetKind !== 'status') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); moveSection(1); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); moveSection(-1); return; }
    const pick = Number(e.key);
    if (pick >= 1 && pick <= sheetApi.SECTIONS.length) {
      e.preventDefault();
      section = sheetApi.SECTIONS[pick - 1].id;
      paintSheet();
    }
  });

  vscode.postMessage({ type: 'ready', hidden: !!document.hidden });
  input.focus();
})();
