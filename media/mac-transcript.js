/* Presentation only. Authentication, composers and engine actions stay native. */
(function () {
  'use strict';
  const stream = document.getElementById('stream'), scroller = document.getElementById('scroller'), jump = document.getElementById('jump');
  const nodes = new Map();
  let current = null, follow = true, thinking = true, readingTimer;
  let search = { query: '', step: 0, selected: null, index: 0 };
  const post = (value) => window.webkit.messageHandlers.nikTranscript.postMessage(value);
  const esc = (v) => window.escapeHtml(String(v == null ? '' : v));
  const fmtBytes = (n) => n < 1024 ? n + ' characters' : Math.round(n / 1024) + ' KB';
  const painter = window.NikTranscriptRenderer.create({
    esc, icon: window.icon, inApp: false, showThinking: () => thinking, snippetText: () => ({}),
    fmtDuration: (n) => Math.floor(n / 1000) + 's', fmtBytes,
    clockTag: (at, cls) => at ? '<time class="' + cls + '">' + esc(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</time>' : '',
    pretty: (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2)) || '',
    summarise: (v) => String(v && (v.command || v.file_path || v.path || v.description) || '').slice(0, 160),
    postMessage: () => {} // No engine actions cross this page's bridge.
  });
  function reading() {
    if (!current) return;
    const top = scroller.getBoundingClientRect().top;
    const anchor = Array.from(stream.querySelectorAll('[data-id]')).find((el) => el.getBoundingClientRect().bottom >= top);
    post({ type: 'reading', conversationID: current, anchor: anchor ? anchor.dataset.id : null, offset: scroller.scrollTop, followsLatest: follow });
  }
  scroller.addEventListener('scroll', () => {
    follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
    jump.hidden = follow;
    clearTimeout(readingTimer); readingTimer = setTimeout(reading, 200);
  }, { passive: true });
  jump.addEventListener('click', () => { follow = true; jump.hidden = true; scroller.scrollTop = scroller.scrollHeight; });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault();
    if (/^(https?:|mailto:)/i.test(link.getAttribute('href') || '')) post({ type: 'externalURL', url: link.href });
  });
  function decorate(el) {
    el.querySelectorAll('.perm .actions').forEach((actions) => {
      actions.remove(); const hint = document.createElement('p'); hint.className = 'native-card-hint'; hint.textContent = 'Respond in the approval card below.'; el.appendChild(hint);
    });
    el.querySelectorAll('pre').forEach((pre) => {
      const text = pre.textContent, button = document.createElement('button');
      button.textContent = 'Copy'; button.className = 'copy-code'; button.setAttribute('aria-label', 'Copy code');
      button.addEventListener('click', () => {
        const field = document.createElement('textarea'); field.value = text; field.className = 'copy-buffer'; document.body.appendChild(field); field.select();
        document.execCommand('copy'); field.remove();
      });
      pre.appendChild(button);
    });
  }
  function find(settings, changed) {
    settings = settings || { query: '', step: 0, visible: false };
    if (!settings.visible || !settings.query) {
      if (search.selected) nodes.get(search.selected.slice(0, search.selected.lastIndexOf(':')))?.el.classList.remove('find-current');
      search = { query: settings.query, step: settings.step, selected: null, index: 0 };
      return { query: settings.query, count: 0, index: -1, selected: null, limited: false };
    }
    const rows = [], textNodes = new Map();
    for (const [id, value] of nodes) {
      value.el.classList.remove('find-current');
      if (value.el.hidden) continue;
      let text = '', parts = [];
      const walker = document.createTreeWalker(value.el, NodeFilter.SHOW_TEXT, { acceptNode: (node) =>
        node.parentElement.closest('button,time,.native-card-hint') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      let node;
      while ((node = walker.nextNode())) { parts.push({ node, start: text.length, end: text.length + node.textContent.length }); text += node.textContent; }
      rows.push({ id, text }); textNodes.set(id, parts);
    }
    const queryChanged = changed || settings.query !== search.query || !search.selected;
    const found = window.NikMacFind.matches(settings.visible ? settings.query : '', rows);
    const delta = queryChanged ? 0 : settings.step - search.step;
    const index = window.NikMacFind.select(found, queryChanged ? null : search.selected, queryChanged ? 0 : search.index, delta);
    const match = found[index];
    if (match) {
      const el = nodes.get(match.itemID).el; el.classList.add('find-current');
      if (queryChanged || delta) {
        el.querySelectorAll('details').forEach((details) => { details.open = true; });
        const parts = textNodes.get(match.itemID), first = parts.find((part) => part.end > match.start), last = parts.find((part) => part.end >= match.end);
        if (first && last) {
          const range = document.createRange(); range.setStart(first.node, match.start - first.start); range.setEnd(last.node, match.end - last.start);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }
        follow = false; el.scrollIntoView({ block: 'center' });
      }
    }
    search = { query: settings.query, step: settings.step, selected: match ? match.id : null, index: Math.max(0, index) };
    return { query: settings.query, count: found.length, index, selected: search.selected, limited: found.length === 10000 };
  }
  window.NikMacTranscript = { update(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.items)) return;
    const changed = current !== snapshot.conversationID;
    const root = document.documentElement;
    root.dataset.fontSize = String(Math.round(Math.max(13, Math.min(21, snapshot.fontSize || 15))));
    root.dataset.readingWidth = String(Math.round(Math.max(600, Math.min(1000, snapshot.readingWidth || 840)) / 20) * 20);
    root.dataset.appearance = ['light', 'dark'].includes(snapshot.appearance) ? snapshot.appearance : 'system';
    if (changed) { clearTimeout(readingTimer); stream.replaceChildren(); nodes.clear(); current = snapshot.conversationID; follow = snapshot.reading.followsLatest; }
    const oldThinking = thinking; thinking = snapshot.showThinking;
    const incoming = new Set(snapshot.items.map((item) => item.id));
    for (const [id, value] of nodes) if (!incoming.has(id)) { value.el.remove(); nodes.delete(id); }
    for (const item of snapshot.items) {
      const hash = JSON.stringify(item), existing = nodes.get(item.id);
      if (existing && existing.hash === hash && oldThinking === thinking) continue;
      const el = existing ? existing.el : document.createElement('div'); el.dataset.id = item.id;
      painter.paint(el, item); if (!item.streaming) decorate(el);
      if (!existing) stream.appendChild(el);
      nodes.set(item.id, { el, hash });
    }
    let clipped = stream.querySelector('.dropped');
    if (snapshot.dropped && !clipped) { clipped = document.createElement('p'); clipped.className = 'dropped'; stream.prepend(clipped); }
    if (clipped) { clipped.textContent = snapshot.dropped + ' earlier items are outside the loaded transcript window.'; if (!snapshot.dropped) clipped.remove(); }
    if (follow) scroller.scrollTop = scroller.scrollHeight;
    else if (changed) scroller.scrollTop = snapshot.reading.offset;
    jump.hidden = follow;
    const found = find(snapshot.find, changed);
    return { conversationID: current, itemIDs: Array.from(nodes.keys()), find: found,
      streamingIDs: snapshot.items.filter((item) => item.streaming && nodes.has(item.id)).map((item) => item.id) };
  } };
  post({ type: 'ready', version: 1 });
})();
