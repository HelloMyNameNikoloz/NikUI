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
  let slashMode = 'cmd';
  let slashCmd = '';
  let commandArgs = {};
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

  let follow = true;
  const jump = $('jump');

  function atBottom(slack) {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= (slack || 24);
  }
  function scrollDown() { scroller.scrollTop = scroller.scrollHeight; }

  // Scrolling up means the reader is reading; never yank them back down.
  scroller.addEventListener('scroll', function () {
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
      '\nTotal billed ' + fmtTokens(s.total || 0);
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

  // Any code block is worth copying; add the affordance after each render.
  function decorateCode(el) {
    el.querySelectorAll('pre').forEach(function (pre) {
      if (pre.querySelector('.copy')) return;
      const btn = document.createElement('button');
      btn.className = 'copy';
      btn.title = 'Copy';
      btn.innerHTML = icon('check', 12);
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const code = pre.querySelector('code');
        copyText((code || pre).textContent, btn);
      });
      pre.appendChild(btn);
    });
  }

  function upsert(items) {
    const empty = stream.querySelector('.empty');
    if (empty && items.length) empty.remove();
    for (const item of items) {
      const existing = nodes.get(item.id);
      if (existing) { paint(existing, item); decorateCode(existing); }
      else {
        const el = document.createElement('div');
        el.dataset.id = item.id;
        paint(el, item);
        decorateCode(el);
        nodes.set(item.id, el);
        stream.appendChild(el);
      }
    }
    if (follow) scrollDown();
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

    const cmdMatch = value.match(/^\/([\w:.-]*)$/);
    if (cmdMatch) {
      const q = cmdMatch[1].toLowerCase();
      slashMode = 'cmd';
      slashCmd = '';
      slashMatches = commands.filter((c) => c.toLowerCase().includes(q)).slice(0, 40);
    } else {
      // "/effort ma" — the command is settled, now offer its values.
      const argMatch = value.match(/^\/([\w:.-]+)[ \t]+([^\s]*)$/);
      const options = argMatch ? commandArgs[argMatch[1]] : null;
      if (!argMatch || !options) { slashBox.hidden = true; return; }
      const q = argMatch[2].toLowerCase();
      slashMode = 'arg';
      slashCmd = argMatch[1];
      slashMatches = options.filter((v) => v.toLowerCase().startsWith(q));
    }

    slashIndex = 0;
    if (!slashMatches.length) {
      slashBox.innerHTML = '<div class="none">' + (slashMode === 'cmd' && !commands.length ? 'Commands appear once the instance is running' : 'No match') + '</div>';
      slashBox.hidden = false;
      return;
    }
    paintSlash();
    slashBox.hidden = false;
  }

  function paintSlash() {
    const rows = slashMatches.map(function (c, i) {
      const parts = String(c).split(':');
      const ns = slashMode === 'cmd' && parts.length > 1 ? parts[0] : '';
      const label = slashMode === 'cmd' ? parts[parts.length - 1] : c;
      return '<div class="row' + (i === slashIndex ? ' on' : '') + '" data-val="' + esc(c) + '">' +
        icon(slashMode === 'cmd' ? 'slash' : 'chevron', 12) +
        '<span class="cmd">' + esc(label) + '</span>' +
        (ns ? '<span class="ns">' + esc(ns) + '</span>' : '') + '</div>';
    }).join('');
    const hint = slashMode === 'arg'
      ? '<div class="palette-hint"><span>/' + esc(slashCmd) + '</span><span>Tab fills · Enter runs</span></div>'
      : '<div class="palette-hint"><span>Commands</span><span>Tab or Enter selects</span></div>';
    slashBox.innerHTML = hint + rows;
    const on = slashBox.querySelector('.row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  // Returns 'filled' when more input is expected, 'ready' when the line is complete.
  function acceptSlash() {
    if (slashBox.hidden || !slashMatches.length) return null;
    const picked = slashMatches[slashIndex];
    if (slashMode === 'cmd') {
      input.value = '/' + picked + ' ';
      autoGrow();
      refreshSlash(); // a command with values shows them straight away
      return slashBox.hidden ? 'ready' : 'filled';
    }
    input.value = '/' + slashCmd + ' ' + picked;
    slashBox.hidden = true;
    autoGrow();
    return 'ready';
  }

  slashBox.addEventListener('click', function (e) {
    const row = e.target.closest('[data-val]');
    if (!row) return;
    slashIndex = slashMatches.indexOf(row.dataset.val);
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
    follow = true;
    jump.hidden = true;
    scrollDown();
  }

  input.addEventListener('input', function () { autoGrow(); refreshSlash(); });
  input.addEventListener('keydown', function (e) {
    if (!slashBox.hidden && slashMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashMatches.length; paintSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length; paintSlash(); return; }
      if (e.key === 'Tab') { if (acceptSlash()) { e.preventDefault(); return; } }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const outcome = acceptSlash();
        if (outcome === 'ready' && slashMode === 'arg') send();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); slashBox.hidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape') {
      if (!lightbox.hidden) { closeLightbox(); return; }
      vscode.postMessage({ type: 'interrupt' });
    }
  });

  input.addEventListener('blur', function () {
    // Let a click on a row land before the palette disappears.
    setTimeout(function () { if (document.activeElement !== input) slashBox.hidden = true; }, 120);
  });

  $('send').addEventListener('click', send);
  $('stop').addEventListener('click', function () { vscode.postMessage({ type: 'interrupt' }); });

  // ── host messages ────────────────────────────────────────────

  window.addEventListener('message', function (event) {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        vscode.setState({ sessionId: msg.sessionId });
        showThinking = msg.showThinking;
        commands = msg.slashCommands || [];
        commandArgs = msg.commandArgs || {};
        if (msg.font) document.documentElement.style.setProperty('--nik-font', msg.font);
        if (msg.fontSize) document.documentElement.style.setProperty('--nik-font-size', msg.fontSize + 'px');
        stream.innerHTML = msg.items.length ? '' : '<div class="empty">Ask Claude anything to start.</div>';
        nodes.clear();
        upsert(msg.items);
        setMeta(msg.meta);
        setStatus(msg.status);
        setStats(msg.stats);
        follow = true;
        jump.hidden = true;
        scrollDown();
        break;
      case 'items': upsert(msg.items); break;
      case 'meta':
        setMeta(msg.meta);
        if (msg.slashCommands) commands = msg.slashCommands;
        if (msg.commandArgs) commandArgs = msg.commandArgs;
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
