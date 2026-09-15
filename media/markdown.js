/* Minimal, dependency-free Markdown renderer.
   Everything is escaped first and only our own tags are inserted, so model
   output can never inject HTML into the webview. */
(function (root) {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    const u = String(url).trim();
    return /^(https?:|mailto:|file:|vscode:|#)/i.test(u) ? u : '#';
  }

  function renderInline(src) {
    let text = escapeHtml(src);

    // Protect code spans before any other inline rule touches them. The
    // sentinel is inert: input was already escaped, so it cannot be forged.
    const codes = [];
    text = text.replace(/(`+)([\s\S]*?)\1/g, function (_, ticks, body) {
      codes.push(body.trim());
      return '@@NIKCODE' + (codes.length - 1) + '@@';
    });

    text = text.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()]*\))+)\)/g,
      function (_, alt, url) { return '<img alt="' + alt + '" src="' + safeUrl(url) + '">'; });
    text = text.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))+)\)/g,
      function (_, label, url) { return '<a href="' + safeUrl(url) + '">' + label + '</a>'; });
    text = text.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+)/g,
      function (_, pre, url) { return pre + '<a href="' + safeUrl(url) + '">' + url + '</a>'; });

    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    return text.replace(/@@NIKCODE(\d+)@@/g, function (_, i) { return '<code>' + codes[Number(i)] + '</code>'; });
  }

  const RE_FENCE = /^\s*(```+|~~~+)\s*([\w.+-]*)\s*$/;
  const RE_HEADING = /^(#{1,6})\s+(.*)$/;
  const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const RE_QUOTE = /^\s*>\s?(.*)$/;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

  function renderMarkdown(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const fence = line.match(RE_FENCE);
      if (fence) {
        const marker = fence[1][0];
        const lang = fence[2] || '';
        const body = [];
        i++;
        while (i < lines.length && !(RE_FENCE.test(lines[i]) && lines[i].trim()[0] === marker)) {
          body.push(lines[i]); i++;
        }
        i++;
        const cls = lang ? ' class="lang-' + escapeHtml(lang) + '"' : '';
        out.push('<pre data-lang="' + escapeHtml(lang) + '"><code' + cls + '>' + escapeHtml(body.join('\n')) + '</code></pre>');
        continue;
      }

      if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

      const heading = line.match(RE_HEADING);
      if (heading) {
        const level = heading[1].length;
        out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
        i++; continue;
      }

      if (RE_QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) { body.push(lines[i].match(RE_QUOTE)[1]); i++; }
        out.push('<blockquote>' + renderMarkdown(body.join('\n')) + '</blockquote>');
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        const cols = head.length;
        out.push(
          '<div class="table-wrap"><table><thead><tr>' +
          head.map(function (c) { return '<th>' + renderInline(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            const cells = normaliseRow(r, cols);
            return '<tr>' + cells.map(function (c) { return '<td>' + renderInline(c) + '</td>'; }).join('') + '</tr>';
          }).join('') +
          '</tbody></table></div>'
        );
        continue;
      }

      if (RE_LIST.test(line)) {
        const block = [];
        while (i < lines.length && (RE_LIST.test(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i])))) {
          block.push(lines[i]); i++;
        }
        out.push(renderList(block));
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && !RE_FENCE.test(lines[i]) && !RE_HEADING.test(lines[i]) &&
             !RE_HR.test(lines[i]) && !RE_LIST.test(lines[i]) && !RE_QUOTE.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length) out.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
      else i++;
    }

    return out.join('\n');
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);

    const cells = [];
    let cur = '';
    let fence = 0; // length of the backtick run that opened the current code span
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === '\\' && s.charAt(i + 1) === '|') { cur += '|'; i++; continue; }
      if (ch === '`') {
        let run = 0;
        while (s.charAt(i + run) === '`') run++;
        if (fence === 0) fence = run;
        else if (fence === run) fence = 0;
        cur += '`'.repeat(run);
        i += run - 1;
        continue;
      }
      if (ch === '|' && fence === 0) { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  // Ragged rows are common in model output; fold any overflow into the last
  // cell and pad short rows so the grid never breaks.
  function normaliseRow(cells, cols) {
    if (cells.length > cols) {
      return cells.slice(0, cols - 1).concat(cells.slice(cols - 1).join(' | '));
    }
    const out = cells.slice();
    while (out.length < cols) out.push('');
    return out;
  }

  // Indentation-driven nesting; two spaces (or a tab) per level.
  function renderList(block) {
    const items = [];
    for (const raw of block) {
      const m = raw.match(RE_LIST);
      if (m) items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: [m[3]] });
      else if (items.length) items[items.length - 1].text.push(raw.trim());
    }
    let pos = 0;
    function build(indent) {
      const ordered = items[pos] && items[pos].ordered;
      const parts = [];
      while (pos < items.length && items[pos].indent >= indent) {
        if (items[pos].indent > indent) { parts.push(build(items[pos].indent)); continue; }
        const item = items[pos++];
        let html = renderInline(item.text.join('\n')).replace(/\n/g, '<br>');
        if (pos < items.length && items[pos].indent > indent) html += build(items[pos].indent);
        parts.push('<li>' + html + '</li>');
      }
      const tag = ordered ? 'ol' : 'ul';
      return '<' + tag + '>' + parts.join('') + '</' + tag + '>';
    }
    return items.length ? build(items[0].indent) : '';
  }

  root.renderMarkdown = renderMarkdown;
  root.escapeHtml = escapeHtml;
  if (typeof module !== 'undefined' && module.exports) module.exports = { renderMarkdown, escapeHtml };
})(typeof window !== 'undefined' ? window : globalThis);
