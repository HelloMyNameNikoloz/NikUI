/* NikUI webview front end. Items arrive normalised from the extension host and
   are upserted by id, so streaming deltas repaint in place. */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const stream = $('stream');
  const scroller = $('transcript');
  const input = $('input');
  const slashBox = $('slash');
  const attachBar = $('attachments');
  const filePicker = $('file');
  const lightbox = $('lightbox');
  const lbImg = $('lb-img');

  const nodes = new Map();
  let attachments = [];
  let commands = [];
  let slashMatches = [];
  let slashIndex = 0;
  let showThinking = true;
  let statsBase = { elapsedMs: 0, running: false, at: Date.now(), total: 0, cost: 0, turns: 0 };
  let attachSeq = 0;

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

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  }
  function scrollDown() { scroller.scrollTop = scroller.scrollHeight; }

  function summarise(inputObj) {
    const i = inputObj || {};
    const first = i.command || i.file_path || i.path || i.url || i.query || i.pattern || i.description || i.prompt;
    if (first) return String(first).replace(/\s+/g, ' ').slice(0, 160);
    const keys = Object.keys(i);
    return keys.length ? keys.slice(0, 3).map((k) => k + '=' + short(i[k])).join(' ') : '';
  }
  function short(v) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s == null ? '' : (s.length > 40 ? s.slice(0, 40) + '…' : s);
  }
  function pretty(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
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
    if (statsBase.total > 0) {
      bits.push('<span class="stat" title="' + esc(tokenTitle()) + '">' + icon('hash', 12) +
        esc(fmtTokens(statsBase.total)) + '</span>');
    }
    if (statsBase.cost > 0) {
      bits.push('<span class="stat">$' + statsBase.cost.toFixed(3) + '</span>');
    }
    $('stats').innerHTML = bits.join('');
  }

  function tokenTitle() {
    const s = statsBase;
    return 'in ' + fmtTokens(s.input || 0) + ' · out ' + fmtTokens(s.output || 0) +
      ' · cache read ' + fmtTokens(s.cacheRead || 0) + ' · cache write ' + fmtTokens(s.cacheCreate || 0);
  }

  setInterval(function () { if (statsBase.running) paintStats(); }, 1000);

  function setStats(s) {
    statsBase = Object.assign({}, s, { at: Date.now() });
    paintStats();
  }

  function setMeta(meta) {
    $('title').textContent = meta.label;
    const bits = [];
    if (meta.ticket) bits.push('#' + meta.ticket);
    if (meta.cwd) bits.push(meta.cwd.replace(meta.home, '~'));
    if (meta.model) bits.push(meta.model);
    if (meta.effort) bits.push('effort ' + meta.effort);
    $('crumbs').innerHTML = bits.map((b) => '<span>' + esc(b) + '</span>').join('');
  }

  function setStatus(next) {
    $('dot').className = 'dot ' + next;
    $('stop').disabled = !(next === 'working' || next === 'waiting');
    $('send').disabled = next === 'stopped';
  }

  // ── items ────────────────────────────────────────────────────

  function paint(el, item) {
    switch (item.kind) {
      case 'user': {
        el.className = 'turn-user';
        let html = '<div class="said">' + esc(item.text) + '</div>';
        if (item.images && item.images.length) {
          html += '<div class="shots">' + item.images.map(function (im) {
            return '<img src="data:' + esc(im.mediaType) + ';base64,' + im.data + '" alt="' + esc(im.name || 'image') + '">';
          }).join('') + '</div>';
        }
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
        const running = item.status !== 'done';
        el.className = 'tool' + (item.isError ? ' err' : '');
        const details = el.querySelector('details');
        const open = details ? details.open : false;
        const mark = running ? '<span class="spinner"></span>'
          : (item.isError ? '<span class="cross">' + icon('alert', 13) + '</span>'
                          : '<span class="tick">' + icon('check', 13) + '</span>');
        let body = '<div class="label">Input</div><pre>' + esc(pretty(item.input)) + '</pre>';
        if (item.result !== undefined && item.result !== '') {
          body += '<div class="label">' + (item.isError ? 'Error' : 'Result') + '</div><pre>' + esc(item.result) + '</pre>';
        }
        el.innerHTML = '<details' + (open ? ' open' : '') + '><summary>' + mark +
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
        el.innerHTML = bits.map((b) => '<span>' + esc(b) + '</span>').join('');
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

  function upsert(items) {
    const stick = nearBottom();
    const empty = stream.querySelector('.empty');
    if (empty && items.length) empty.remove();
    for (const item of items) {
      const existing = nodes.get(item.id);
      if (existing) paint(existing, item);
      else {
        const el = document.createElement('div');
        el.dataset.id = item.id;
        paint(el, item);
        nodes.set(item.id, el);
        stream.appendChild(el);
      }
    }
    if (stick) scrollDown();
  }

  // ── attachments ──────────────────────────────────────────────

  function addFiles(files) {
    for (const file of files) {
      if (!file || !/^image\//.test(file.type)) continue;
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

  ['dragover', 'drop'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      e.preventDefault();
      if (type === 'drop' && e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
  });

  $('attach').addEventListener('click', () => filePicker.click());
  filePicker.addEventListener('change', function () { addFiles(filePicker.files); filePicker.value = ''; });

  // ── lightbox ─────────────────────────────────────────────────

  function openLightbox(src) { lbImg.src = src; lightbox.hidden = false; }
  function closeLightbox() { lightbox.hidden = true; lbImg.src = ''; }

  stream.addEventListener('click', function (e) {
    const img = e.target.closest('.shots img');
    if (img) openLightbox(img.src);
  });
  lightbox.addEventListener('click', closeLightbox);
  $('lb-close').addEventListener('click', closeLightbox);

  // ── slash palette ────────────────────────────────────────────

  function refreshSlash() {
    const value = input.value;
    const m = value.match(/^\/([\w:.-]*)$/); // only while the whole line is one token
    if (!m) { slashBox.hidden = true; return; }
    const q = m[1].toLowerCase();
    slashMatches = commands.filter((c) => c.toLowerCase().includes(q)).slice(0, 40);
    slashIndex = 0;
    if (!slashMatches.length) {
      slashBox.innerHTML = '<div class="none">No matching command</div>';
      slashBox.hidden = false;
      return;
    }
    paintSlash();
    slashBox.hidden = false;
  }

  function paintSlash() {
    slashBox.innerHTML = slashMatches.map(function (c, i) {
      const parts = c.split(':');
      const ns = parts.length > 1 ? parts[0] : '';
      return '<div class="row' + (i === slashIndex ? ' on' : '') + '" data-cmd="' + esc(c) + '">' +
        icon('slash', 12) + '<span class="cmd">' + esc(parts[parts.length - 1]) + '</span>' +
        (ns ? '<span class="ns">' + esc(ns) + '</span>' : '') + '</div>';
    }).join('');
    const on = slashBox.querySelector('.row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function acceptSlash() {
    if (slashBox.hidden || !slashMatches.length) return false;
    input.value = '/' + slashMatches[slashIndex] + ' ';
    slashBox.hidden = true;
    autoGrow();
    return true;
  }

  slashBox.addEventListener('click', function (e) {
    const row = e.target.closest('[data-cmd]');
    if (!row) return;
    slashIndex = slashMatches.indexOf(row.dataset.cmd);
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
    vscode.postMessage({
      type: 'send',
      text: text,
      attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }))
    });
    input.value = '';
    attachments = [];
    paintAttachments();
    slashBox.hidden = true;
    autoGrow();
    scrollDown();
  }

  input.addEventListener('input', function () { autoGrow(); refreshSlash(); });
  input.addEventListener('keydown', function (e) {
    if (!slashBox.hidden && slashMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashMatches.length; paintSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length; paintSlash(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { if (acceptSlash()) { e.preventDefault(); return; } }
      if (e.key === 'Escape') { e.preventDefault(); slashBox.hidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape') {
      if (!lightbox.hidden) { closeLightbox(); return; }
      vscode.postMessage({ type: 'interrupt' });
    }
  });

  $('send').addEventListener('click', send);
  $('stop').addEventListener('click', function () { vscode.postMessage({ type: 'interrupt' }); });

  // ── host messages ────────────────────────────────────────────

  window.addEventListener('message', function (event) {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        showThinking = msg.showThinking;
        commands = msg.slashCommands || [];
        if (msg.font) document.documentElement.style.setProperty('--nik-font', msg.font);
        if (msg.fontSize) document.documentElement.style.setProperty('--nik-font-size', msg.fontSize + 'px');
        stream.innerHTML = msg.items.length ? '' : '<div class="empty">Ask Claude anything to start.</div>';
        nodes.clear();
        upsert(msg.items);
        setMeta(msg.meta);
        setStatus(msg.status);
        setStats(msg.stats);
        scrollDown();
        break;
      case 'items': upsert(msg.items); break;
      case 'meta':
        setMeta(msg.meta);
        if (msg.slashCommands) commands = msg.slashCommands;
        break;
      case 'status': setStatus(msg.status); break;
      case 'stats': setStats(msg.stats); break;
      case 'reset':
        stream.innerHTML = '<div class="empty">Context cleared.</div>';
        nodes.clear();
        break;
      case 'focus': input.focus(); break;
    }
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
  });

  vscode.postMessage({ type: 'ready' });
  input.focus();
})();
