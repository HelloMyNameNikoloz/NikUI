/* The window, as a list you can tap.

   The page arrives empty — the server sends markup and no data — and this fills
   it from the same socket the conversation uses. So the list is live, and an
   unpaired device gets an empty shell and an explanation rather than a list of
   what is running on somebody's laptop.

   What it does keep is the last list it saw, so opening the app from a home
   screen shows something immediately instead of a white rectangle. That list is
   never dressed up as current: it is dimmed, dated, and has a way to try
   again. A stale conversation shown as if it were live is worse than a blank
   screen, and the same goes for a fleet. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const rows = $('rows');
  const lede = $('lede');
  const IN_APP = document.body && document.body.classList.contains('app');

  /**
   * The same shape the editor's sidebar has: folders somebody made first, then
   * projects, then anything that belongs to neither. A flat list of nine
   * instances across three projects is a list you have to read; this is one you
   * can look at.
   */
  function group(instances, folders) {
    const groups = [];
    const find = (key, name, kind) => {
      let found = groups.find((g) => g.key === key);
      if (!found) { found = { key, name, kind, instances: [] }; groups.push(found); }
      return found;
    };

    for (const instance of instances) {
      if (instance.folder) find('f:' + instance.folder.id, instance.folder.name, 'folder').instances.push(instance);
      else if (instance.project) find('p:' + instance.project.path, instance.project.name, 'project').instances.push(instance);
      else find('loose', 'Everything else', 'loose').instances.push(instance);
    }

    // A folder somebody made and then emptied is still theirs, and saying so
    // beats it silently disappearing.
    for (const folder of folders || []) {
      if (!groups.some((g) => g.key === 'f:' + folder.id)) {
        groups.push({ key: 'f:' + folder.id, name: folder.name, kind: 'folder', instances: [] });
      }
    }

    const rank = { folder: 0, project: 1, loose: 2 };
    groups.sort((a, b) => (rank[a.kind] - rank[b.kind]) || a.name.localeCompare(b.name));
    return groups;
  }

  function attentionGroups(instances, compact) {
    const needs = (i) => i.status === 'waiting' || i.status === 'error';
    const recent = (a, b) => Number(!!b.unread) - Number(!!a.unread) || (b.activeAt || 0) - (a.activeAt || 0);
    if (compact) return [
      { key: 'attention', name: 'Needs you', kind: 'attention', instances: instances.filter(needs).sort(recent) },
      { key: 'recent', name: null, kind: 'recent', instances: instances.filter((i) => !needs(i)).sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0)) }
    ].filter((g) => g.instances.length);
    return [
      { key: 'attention', name: 'Needs you', kind: 'attention', instances: instances.filter(needs).sort(recent) },
      { key: 'working', name: 'In progress', kind: 'working', instances: instances.filter((i) => !needs(i) && i.status === 'working').sort(recent) },
      { key: 'ready', name: 'Ready to continue', kind: 'ready', instances: instances.filter((i) => !needs(i) && i.status !== 'working').sort(recent) }
    ].filter((g) => g.instances.length);
  }

  // Provider-qualified transcript identity prevents a resumed chat appearing twice.
  function mergeConversations(active, history) {
    const key = (entry) => {
      const provider = entry.provider === 'codex' || /^cx-/.test(entry.id || entry.sessionId) ? 'codex' : 'claude';
      return provider + ':' + String(entry.sessionId || entry.id).replace(/^cx-/, '');
    };
    const merged = new Map();
    for (const entry of history || []) {
      const provider = entry.provider === 'codex' || /^cx-/.test(entry.sessionId) ? 'codex' : 'claude';
      merged.set(key(entry), Object.assign({}, entry, {
        provider, id: provider === 'codex' ? 'cx-' + String(entry.sessionId).replace(/^cx-/, '') : 'past:' + entry.sessionId,
        past: true, activeAt: new Date(entry.modified).getTime() || 0
      }));
    }
    for (const entry of active || []) merged.set(key(entry), Object.assign({}, merged.get(key(entry)), entry, { past: false }));
    return [...merged.values()];
  }

  // Loaded on a page that has no list to draw — which is every page but the
  // fleet, and the test that reads the filing rule out of this file. Exported
  // either way; nothing else runs.
  if (!rows || !lede) {
    if (typeof module !== 'undefined' && module.exports) module.exports = { group, attentionGroups, mergeConversations };
    return;
  }

  const transport = window.nikTransport();
  const REMEMBERED = 'nikui:fleet';
  const VIEW_KEY = 'nikui:fleet:view';
  // Provider is a filter on the same workspace, so a waiting conversation
  // never disappears merely because the other provider was selected last.
  const WORKSPACE_KEY = 'nikui:fleet:workspace';
  const openedAt = Date.now();

  const money = (value) => '$' + (Number(value) || 0).toFixed(2);
  const shortPath = (value) => String(value || '').split('/').slice(-2).join('/');
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function ago(at) {
    const ms = Date.now() - at;
    if (ms < 45000) return 'a moment ago';
    if (ms < 3600000) return Math.round(ms / 60000) + ' minutes ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + ' hours ago';
    return Math.round(ms / 86400000) + ' days ago';
  }

  /** The compact form for a row's second line: "3m ago", not "3 minutes ago". */
  function shortAgo(at) {
    const ms = Date.now() - (at || 0);
    if (ms < 60000) return 'now';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
    return Math.round(ms / 86400000) + 'd ago';
  }

  function remember(instances, folders) {
    try {
      window.localStorage.setItem(REMEMBERED,
        JSON.stringify({ at: Date.now(), instances: instances, folders: folders || [], ...(IN_APP ? { codex: lastCodex, projects: lastProjects } : {}) }));
    } catch (_) { /* private mode, or a full disk: not worth failing over */ }
  }

  function remembered() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(REMEMBERED) || 'null');
      return saved && Array.isArray(saved.instances) ? saved : null;
    } catch (_) { return null; }
  }

  /** A row's place in its group, remembered by hand — the order a drag leaves
   * things in, since nothing on the laptop knows to keep it otherwise. */
  function orderKey(groupKey) { return 'nikui:fleet:order:' + groupKey; }
  function loadOrder(groupKey) {
    try { return JSON.parse(window.localStorage.getItem(orderKey(groupKey)) || 'null'); } catch (_) { return null; }
  }
  function saveOrder(groupKey, ids) {
    try { window.localStorage.setItem(orderKey(groupKey), JSON.stringify(ids)); } catch (_) { /* not worth failing over */ }
  }

  /** Instances already in a saved order keep it; anything new falls in after,
   * in whatever order the laptop sent it — never reshuffled just for arriving. */
  function applyOrder(groupKey, instances) {
    const saved = loadOrder(groupKey);
    if (!saved || !saved.length) return instances;
    const at = new Map(saved.map((id, i) => [id, i]));
    return instances.slice().sort((a, b) => {
      const ai = at.has(a.id) ? at.get(a.id) : Infinity;
      const bi = at.has(b.id) ? at.get(b.id) : Infinity;
      return ai - bi;
    });
  }

  /**
   * One entry per group, kept across redraws rather than rebuilt by them: the
   * head and the card are the same two nodes for as long as the group exists.
   * A fleet message every few seconds used to mean wiping `.rows` and building
   * it again from nothing — every row's node torn down and a new one put in
   * its place, which is what made a status dot blink by disappearing rather
   * than changing colour, and what threw away any transition a row was
   * mid-way through. Keyed by id, nothing is rebuilt unless it is actually new.
   */
  const groupNodes = new Map();
  // One row node per instance id, shared across every group and both views —
  // switching from Folders to Recent, or dragging a row into another folder's
  // card, moves the same element rather than tearing it down and building a
  // double. That is the one thing a reparent can do that a redraw cannot:
  // carry whatever the row was mid-animating along with it.
  const rowCache = new Map();

  /** Put `node` immediately after `anchor` (or first, if there is none). */
  function placeAfter(node, anchor, parent) {
    if (anchor) { if (anchor.nextSibling !== node) anchor.after(node); }
    else if (parent.firstChild !== node) parent.prepend(node);
  }

  /** A row (or a group's head) leaving the list fades rather than vanishing. */
  function fadeOutRemove(node) {
    if (!node) return;
    if (reduced()) { node.remove(); return; }
    node.classList.add('row-leave');
    const done = () => { if (node.parentNode) node.parentNode.removeChild(node); };
    node.addEventListener('transitionend', done, { once: true });
    // Belt and braces: reduced motion, or a transition that for whatever
    // reason never fires, must not leave a dead row on the screen forever.
    setTimeout(done, 260);
  }

  // ---- Folders vs Recent -----------------------------------------------------
  // The choice of view is the reader's, not the laptop's, and it outlives a
  // reload the same way the lock's passcode does.
  let view = ['recent', 'folders'].includes(window.localStorage.getItem(VIEW_KEY))
    ? window.localStorage.getItem(VIEW_KEY) : 'attention';
  // Up here rather than with the rest of the dragging below, because `draw`
  // reads it: a fleet arriving mid-drag would put the row back under the
  // finger, so it waits for the drop instead (see `endDrag`).
  let dragState = null;
  let drawAfterDrop = false;
  let lastInstances = [];
  let lastFolders = [];
  let lastProjects = [];
  let workspace = 'all';
  let restored = {};
  if (IN_APP) { try { restored = JSON.parse(sessionStorage.getItem('nikui.chats') || '{}'); } catch (_) {} }
  let filter = IN_APP ? restored.filter || '' : '';
  let scope = IN_APP ? new URLSearchParams(location.search).get('scope') || restored.scope || 'active' : 'active';
  let projectFilter = IN_APP ? restored.project || '' : '';
  let historyEntries = null;
  let historyTrouble = null;
  let historyAsked = false;
  let wasLive = false;
  let openingHistory = null;
  let searchInput = null;
  let scopeControl = null;
  let phoneSheet = null;
  let organizeSheet = null;
  let historyLimit = 60;
  let creationBusy = false;
  let moveTapAfter = 0;
  if (IN_APP) window.addEventListener('pagehide', () => {
    try { sessionStorage.setItem('nikui.chats', JSON.stringify({ filter, scope, project: projectFilter, top: document.querySelector('.screen').scrollTop })); } catch (_) { /* storage unavailable */ }
  });
  let createProvider = IN_APP ? localStorage.getItem('nikui.chats.provider') || 'claude' : 'claude';
  let createReturn = null;
  let lastCodex = [];
  let codexState = null;
  let codexAsked = false;
  let wsEl = null;
  let viewPicker = null;

  /** The arrangement is independent of which provider is being shown. */
  function shownView() {
    return view;
  }

  /** Recent is not a filing at all: one card, every instance, newest first. */
  function recentGroup(instances) {
    const sorted = instances.slice().sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0));
    return [{ key: 'recent', name: null, kind: 'recent', instances: sorted }];
  }

  function draw(instances, folders) {
    if (dragState) { drawAfterDrop = true; return; }
    // The skeleton shown while the first message was still in flight is not
    // one of the groups below — it was never tracked in `groupNodes` — so it
    // has to be swept out by hand, or the first real row would land next to
    // four rows shaped like one.
    const placeholder = rows.querySelector('.rows-card.skeleton');
    if (placeholder) placeholder.remove();

    if (IN_APP && (scope === 'earlier' || filter)) { drawArchive(); return; }
    const codex = workspace === 'codex';
    if (codex) instances = lastCodex;
    else if (workspace === 'all') instances = Array.from(new Map(instances.concat(lastCodex).map((i) => [i.id, i])).values());
    if (IN_APP && projectFilter) instances = instances.filter((i) => i.cwd === projectFilter);
    if (filter) instances = instances.filter((i) => [i.label, i.cwd, i.provider, /^cx-/.test(i.id) ? 'codex' : 'claude']
      .some((s) => String(s || '').toLowerCase().includes(filter)));
    if (!instances.length) {
      rows.textContent = '';
      groupNodes.clear();
      rowCache.clear();
      if (IN_APP) { showEmpty('No conversations yet', projectFilter || workspace !== 'all' ? 'Clear filters' : null, clearFilters); return; }
      lede.textContent = filter ? 'No conversations match your search.' : !codex ? 'A fresh start. Pick an agent and a folder below.'
        : codexState && codexState.error ? 'Codex could not be reached: ' + codexState.error
        : codexState && codexState.loaded ? 'No Codex conversations yet.' : 'Loading Codex conversations…';
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = filter ? 'Try a project name or another provider.' : 'Your conversations will appear here. Start with Claude or Codex to get going.';
      rows.appendChild(empty);
      return;
    }
    if (IN_APP) lede.hidden = true;
    const needs = instances.filter((i) => i.status === 'waiting' || i.status === 'error').length;
    const working = instances.filter((i) => i.status === 'working').length;
    lede.textContent = needs ? needs + ' needs you · ' + working + ' working'
      : working ? working + ' working · You’re all caught up' : instances.length + ' conversations · Ready when you are';

    // A folder with nothing in it is not worth a card on a screen this small:
    // dropped here rather than in `group()`, which still has to say a folder
    // exists — the editor's own sidebar reads that list too.
    const groups = view === 'attention' ? attentionGroups(instances, IN_APP) : view === 'recent' ? recentGroup(instances)
      : group(instances, codex ? [] : folders).filter((g) => g.instances.length > 0);
    // One project and nothing else is not a grouping, it is a heading nobody
    // needs — so it is only drawn when there is more than one thing to tell
    // apart, and never in Recent, which is one card by definition.
    const headed = view === 'attention' || (shownView() === 'folders' && groups.length > 1);
    const seenGroups = new Set();
    const seenRows = new Set();
    let anchor = null;

    for (const set of groups) {
      seenGroups.add(set.key);
      let entry = groupNodes.get(set.key);
      if (!entry) { entry = { head: null, card: null }; groupNodes.set(set.key, entry); }

      if (headed && (!IN_APP || set.name)) {
        if (!entry.head) {
          entry.head = document.createElement('div');
          const name = document.createElement('span');
          name.className = 'rows-head-name';
          entry.head.appendChild(name);
          const count = document.createElement('span');
          count.className = 'rows-head-count';
          entry.head.appendChild(count);
        }
        entry.head.className = 'rows-head ' + set.kind;
        entry.head.firstChild.textContent = set.name;
        entry.head.lastChild.textContent = String(set.instances.length);
        placeAfter(entry.head, anchor, rows);
        anchor = entry.head;
      } else if (entry.head) {
        entry.head.remove();
        entry.head = null;
      }

      if (!entry.card) {
        entry.card = document.createElement('div');
        entry.card.className = 'rows-card';
      }
      entry.card.dataset.group = set.key;
      placeAfter(entry.card, anchor, rows);
      anchor = entry.card;

      const ordered = shownView() === 'recent' ? set.instances : applyOrder(set.key, set.instances);
      for (const instance of ordered) seenRows.add(instance.id);
      drawRows(entry.card, ordered, set.key);
    }

    // A group that is simply gone this time — its folder emptied into another,
    // say — leaves the way a row does: fading rather than snapping away.
    for (const [key, entry] of groupNodes) {
      if (seenGroups.has(key)) continue;
      fadeOutRemove(entry.head);
      fadeOutRemove(entry.card);
      groupNodes.delete(key);
    }
    for (const [id, row] of rowCache) {
      if (seenRows.has(id)) continue;
      rowCache.delete(id);
      fadeOutRemove(row);
    }
  }

  /** What a row shows, written into the nodes it already has. */
  function paintRow(row, instance) {
    row.href = ((window.NIKUI_REMOTE || {}).conversation || '/s/') + encodeURIComponent(instance.id);
    row.dataset.instance = instance.id;

    row.dot.className = 'sdot ' + String(instance.status || 'idle').replace(/[^a-z]/g, '') +
      (instance.asleep ? ' asleep' : '') + (instance.unread ? ' unread' : '');
    row.classList.toggle('unread', !!instance.unread);
    if (instance.unread) row.dot.title = 'Finished, not opened since';
    else row.dot.removeAttribute('title');

    row.nameEl.textContent = instance.label || instance.id;
    row.classList.toggle('codex', /^cx-/.test(instance.id));
    const provider = instance.provider === 'codex' || /^cx-/.test(instance.id) ? 'codex' : 'claude';
    row.dataset.provider = provider;
    row.providerEl.className = 'provider-badge ' + provider;
    row.providerEl.textContent = provider === 'codex' ? 'Codex' : 'Claude';
    const words = { waiting: 'Needs permission', error: 'Needs attention', working: 'Working', done: 'Finished', stopped: 'Stopped', idle: 'Ready' };
    row.stateEl.textContent = instance.unread ? 'New reply' : instance.paused ? 'Quota paused' : words[instance.status] || 'Ready';
    row.stateEl.className = 'row-state ' + (instance.status || 'idle');
    if (IN_APP) {
      const folder = instance.folder ? instance.folder.name : instance.project ? instance.project.name : shortPath(instance.cwd);
      const state = instance.unread ? 'New reply' : instance.paused ? 'Quota paused' : instance.readOnly ? 'Open in ChatGPT' : instance.queued ? instance.queued + ' queued'
        : instance.past ? shortAgo(instance.activeAt) : words[instance.status] || (instance.activeAt ? shortAgo(instance.activeAt) : 'Ready');
      row.whereEl.textContent = [folder, state].filter(Boolean).join(' · ');
      row.providerEl.textContent = provider === 'codex' ? '◈' : '✳';
      row.providerEl.title = provider === 'codex' ? 'Codex' : 'Claude';
      row.providerEl.setAttribute('aria-label', row.providerEl.title);
      row.setAttribute('aria-label', [instance.label || instance.id, row.providerEl.title, folder, state].filter(Boolean).join(', '));
      row.dot.hidden = !!instance.past;
      return;
    }

    if (/^cx-/.test(instance.id)) {
      const where = [shortPath(instance.cwd)];
      if (instance.queued) where.push(instance.queued + ' queued');
      if (instance.readOnly) where.push('open in ChatGPT');
      if (instance.activeAt) where.push(shortAgo(instance.activeAt));
      row.whereEl.textContent = where.join(' · ');
    } else if (view === 'recent') {
      // Which folder or project it belongs to, since Recent has no heading to
      // say so otherwise, and how long ago it last did anything, which is the
      // whole reason to be looking at this view rather than Folders.
      const where = instance.folder ? instance.folder.name
        : (instance.project ? instance.project.name : 'Everything else');
      // No time at all rather than 1970 from a laptop that does not know.
      row.whereEl.textContent = instance.activeAt ? where + ' · ' + shortAgo(instance.activeAt) : where;
    } else {
      const notes = [];
      if (instance.queued) notes.push(instance.queued + ' queued');
      if (instance.paused) notes.push('waiting for the quota');
      row.whereEl.textContent = shortPath(instance.cwd) + (notes.length ? ' · ' + notes.join(' · ') : '');
    }

    row.costEl.textContent = /^cx-/.test(instance.id) ? '' : money(instance.cost);
  }

  function buildRow(instance) {
    const row = document.createElement('a');
    row.className = 'row';
    row.dot = document.createElement('span');
    row.appendChild(row.dot);
    row.nameEl = document.createElement('span');
    row.nameEl.className = 'row-name';
    row.appendChild(row.nameEl);
    row.whereEl = document.createElement('span');
    row.whereEl.className = 'row-cwd';
    row.appendChild(row.whereEl);
    row.costEl = document.createElement('span');
    row.costEl.className = 'row-cost';
    if (!IN_APP) row.appendChild(row.costEl);
    row.badgesEl = document.createElement('div');
    row.badgesEl.className = 'row-badges';
    row.providerEl = document.createElement('span');
    row.stateEl = document.createElement('span');
    row.badgesEl.appendChild(row.providerEl);
    if (!IN_APP) row.badgesEl.appendChild(row.stateEl);
    row.appendChild(row.badgesEl);
    // Only ever shown in edit mode (see app.css), but built once rather than
    // added and removed with it — a row dragged mid-edit should not lose the
    // handle it is being dragged by because a redraw happened to land first.
    row.handleEl = document.createElement('span');
    row.handleEl.className = 'row-handle';
    row.appendChild(row.handleEl);
    paintRow(row, instance);
    if (IN_APP) row.addEventListener('click', (event) => {
      if (editing) { event.preventDefault(); if (Date.now() >= moveTapAfter) openMoveSheet(row.dataset.instance); }
    });
    return row;
  }

  /**
   * Fill `into` with these instances, keeping the node for a given instance
   * id across calls — including across a reparent into a different card,
   * which is what dragging an instance into another folder is, under the
   * hood. A status that changes is a class and three lines of text changing
   * on the row that was already there, not a new row replacing it.
   */
  function drawRows(into, instances, groupKey) {
    let anchor = null;
    for (const instance of instances) {
      let row = rowCache.get(instance.id);
      if (!row) {
        row = buildRow(instance);
        rowCache.set(instance.id, row);
        row.classList.add('row-enter');
        // Added in a frame of its own: a class set and removed in the same
        // tick never triggers the transition it names.
        requestAnimationFrame(() => row.classList.remove('row-enter'));
      } else {
        paintRow(row, instance);
      }
      row.dataset.group = groupKey;
      placeAfter(row, anchor, into);
      anchor = row;
    }
  }

  /** Four rows shaped like the real thing, shimmering while nothing has
   * arrived yet — shown only when there is no cached fleet to show instead. */
  function skeletonRows(count) {
    rows.textContent = '';
    groupNodes.clear();
    rowCache.clear();
    const card = document.createElement('div');
    card.className = 'rows-card skeleton';
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'row row-skeleton';
      const dot = document.createElement('span');
      dot.className = 'sdot skeleton-chip';
      const name = document.createElement('span');
      name.className = 'row-name skeleton-chip';
      const where = document.createElement('span');
      where.className = 'row-cwd skeleton-chip';
      const cost = document.createElement('span');
      cost.className = 'row-cost skeleton-chip';
      row.append(dot, name, where);
      if (!IN_APP) row.append(cost);
      card.appendChild(row);
    }
    rows.appendChild(card);
  }

  // A pull-to-refresh that waits for a fleet message, not a guess about how
  // long one takes: whatever is pulling resolves the moment one arrives (or
  // gives up on its own — see pull.js — if one never does).
  let refreshWaiters = [];
  function settleRefreshes() {
    const waiting = refreshWaiters;
    refreshWaiters = [];
    for (const resolve of waiting) resolve();
  }

  function live(instances, folders, projects, codex, state) {
    wasLive = true;
    lastCodex = (codex || []).map((c) => Object.assign({}, c, {
      provider: 'codex',
      project: c.project || (c.cwd ? { path: c.cwd, name: String(c.cwd).split(/[\\/]/).filter(Boolean).pop() || c.cwd } : null)
    }));
    codexState = state || null;
    if (workspace !== 'claude' && !codexAsked) {
      codexAsked = true;
      transport.postMessage({ type: 'codex:watch' });
    }
    document.body.classList.remove('stale');
    lede.hidden = false;
    const retry = document.getElementById('retry');
    if (retry) retry.remove();
    lastInstances = instances;
    lastFolders = folders;
    lastProjects = projects || [];
    draw(instances, folders);
    remember(instances, folders);
    settleRefreshes();
    if (IN_APP && restored.top != null && scope === 'active' && !filter) { document.querySelector('.screen').scrollTop = restored.top; delete restored.top; }
  }

  /**
   * What there is to show when the laptop cannot be reached: the last list,
   * said to be the last list, and a way to ask again.
   */
  function stale(why) {
    codexAsked = false;
    const saved = remembered();
    document.body.classList.add('stale');
    if (!saved) {
      rows.textContent = '';
      lede.textContent = why || 'Cannot reach the laptop.';
    } else {
      draw(saved.instances, saved.folders);
      lede.textContent = (why || 'Cannot reach the laptop.') + ' Showing what it looked like ' + ago(saved.at) + '.';
    }
    lede.hidden = false;
    if (!document.getElementById('retry')) {
      const retry = document.createElement('button');
      retry.className = IN_APP ? 'new-chat reconnect' : 'go-on';
      retry.id = 'retry';
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.addEventListener('click', function () {
        lede.textContent = 'Trying again…';
        transport.retry();
      });
      // Outside the list, so the list can be dimmed without dimming the way
      // out of it.
      if (IN_APP) rows.parentNode.after(retry); else rows.parentNode.appendChild(retry);
    }
  }

  function refused(message) {
    rows.textContent = '';
    document.body.classList.remove('stale');
    lede.hidden = false;
    lede.textContent = message.reason || 'This device cannot see this window.';
    if (!message.pair) return;
    const link = document.createElement('a');
    link.className = 'go-on';
    link.href = (window.NIKUI_REMOTE || {}).app ? 'connect.html' : '/pair';
    link.textContent = 'Pair this device';
    rows.appendChild(link);
  }

  // ---- asking the laptop for things, and matching the answer back up --------
  // Every request this screen makes of its own accord (rather than the fleet
  // just arriving) carries an id it invents, so the reply — success or
  // `@refused` — can find its way back to whoever asked, rather than landing
  // on whatever happens to be on screen when it shows up.
  let reqSeq = 0;
  const pending = new Map();
  function ask(type, extra) {
    const id = 'h' + (++reqSeq) + '-' + Date.now().toString(36);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject({ reason: 'Your laptop did not answer. Check the connection and try again.' });
      }, 12000);
      pending.set(id, { resolve, reject, timer });
      const posted = transport.postMessage(Object.assign({ type: type, id: id }, extra || {}));
      if (posted === false) { clearTimeout(timer); pending.delete(id); reject({ reason: 'This action is unavailable. It was not sent.' }); }
    });
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === '@welcome' || message.type === '@device') {
      const allowed = !message.device || message.device.control !== false;
      document.body.classList.toggle('read-only', !allowed);
      for (const b of document.querySelectorAll('.start-agent, #create, #edit')) b.disabled = !allowed;
      if (IN_APP) requestHistory();
    }
    if (message.type === 'intent' && ['rejected', 'unknown'].includes(message.record?.state)) {
      const waiting = pending.get(message.record.payload.id);
      if (waiting) {
        clearTimeout(waiting.timer); pending.delete(message.record.payload.id);
        waiting.reject({ reason: message.record.state === 'unknown'
          ? 'The earlier action may have completed. Check the fleet before creating another instance.'
          : 'The action was refused: ' + (message.record.ack?.error?.code || 'unavailable') });
      }
    }
    if (IN_APP && message.type === 'history') {
      historyEntries = message.entries || [];
      historyTrouble = !message.available ? 'History is unavailable on this laptop.' : message.trouble ? 'Could not read earlier chats.' : null;
      if (scope === 'earlier' || filter) drawArchive();
    }
    if (message.type === 'fleet') {
      live(message.instances || [], message.folders || [], message.projects || [], message.codex || [], message.codexState || null);
    }
    else if (message.type === '@denied') refused(message);
    else if (message.type === 'instance:created' || message.type === 'instance:placed') {
      const waiting = pending.get(message.id);
      if (waiting) { clearTimeout(waiting.timer); pending.delete(message.id); waiting.resolve(message); }
    } else if (message.type === '@refused') {
      const waiting = pending.get(message.id);
      if (waiting) { clearTimeout(waiting.timer); pending.delete(message.id); waiting.reject(message); }
    }
  });

  // Something to look at while the socket is still shaking hands: the cached
  // fleet if there is one, or rows shaped like what is about to arrive if
  // there is not. Either beats a blank list and the word "Connecting…".
  const saved = remembered();
  if (saved) {
    if (IN_APP) { lastInstances = saved.instances; lastFolders = saved.folders || []; lastCodex = saved.codex || []; lastProjects = saved.projects || []; }
    document.body.classList.add('stale');
    draw(saved.instances, saved.folders);
    lede.hidden = false;
    lede.textContent = 'Last seen ' + ago(saved.at) + '. Reconnecting…';
  } else {
    skeletonRows(IN_APP ? 7 : 4);
  }

  // A pull at the top of the list asks the laptop again, the same way the
  // "Try again" button does — and this time waits for the fleet that answers
  // it, rather than guessing when the laptop is done.
  if (window.NikPull) {
    window.NikPull.attach(document.querySelector('.screen'), () => {
      const waited = new Promise((resolve) => refreshWaiters.push(resolve));
      transport.retry();
      if (IN_APP) requestHistory(true);
      return waited;
    });
  }

  /**
   * A list is only current while the socket is. Nothing pushes "the connection
   * died" — there is no connection to push it — so the page asks, and the
   * moment the answer stops being "online" the list says what it is.
   */
  let saidOffline = false;
  setInterval(function () {
    const live = transport.__state && transport.__state() === 'online';
    if (live) { wasLive = true; saidOffline = false; return; }
    // Keyed on having said it, not on the dimming: the page starts dimmed while
    // it reconnects, and reading that back would mean never saying anything.
    if (saidOffline) return;
    // A first connection gets a few seconds before it is called a failure; a
    // list that was live and is not any more needs no grace at all.
    if (!wasLive && Date.now() - openedAt < 6000) return;
    saidOffline = true;
    stale('Cannot reach the laptop.');
  }, 2000);

  // ---- the title bar and the segmented control, built rather than templated:
  // nothing else on this page needs an Edit button, a + button or a Folders /
  // Recent switch, so they are home.js's to add rather than every screen's to
  // carry markup for. ---------------------------------------------------------
  let editing = false;
  let editBtn = null;
  let editHome = null;
  let segEl = null;

  function enterEdit() {
    if (editing || view !== 'folders') return;
    editing = true;
    if (editBtn) { editBtn.textContent = 'Done'; if (IN_APP) document.querySelector('.bar-right').append(editBtn); }
    rows.classList.add('editing');
  }
  function exitEdit() {
    if (!editing) return;
    editing = false;
    if (editBtn) { editBtn.textContent = IN_APP ? 'Organize' : 'Edit'; if (IN_APP && editHome) editHome.append(editBtn); }
    rows.classList.remove('editing');
    cancelDrag();
  }

  function paintSegmented() {
    if (!segEl) return;
    for (const btn of segEl.querySelectorAll('.seg-btn')) {
      btn.classList.toggle('on', btn.dataset.view === view);
      btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
    }
    if (wsEl) for (const btn of wsEl.querySelectorAll('.seg-btn')) {
      btn.classList.toggle('on', btn.dataset.ws === workspace);
      btn.setAttribute('aria-pressed', String(btn.dataset.ws === workspace));
    }
    if (viewPicker) viewPicker.value = view;
    document.body.classList.toggle('codex-ws', workspace === 'codex');
    const title = document.querySelector('.bar .bar-title');
    if (title) title.textContent = IN_APP ? 'Chats' : 'NikUI';
    if (editBtn) editBtn.hidden = IN_APP ? scope === 'earlier' || !!filter : shownView() !== 'folders' || workspace === 'codex';
    if (shownView() !== 'folders') exitEdit();
    if (IN_APP && scopeControl) for (const b of scopeControl.children) { b.classList.toggle('on', b.dataset.scope === scope); b.setAttribute('aria-pressed', String(b.dataset.scope === scope)); }
  }

  function setWorkspace(next) {
    if (!['all', 'claude', 'codex'].includes(next) || next === workspace) return;
    workspace = next;
    if (next !== 'all') createProvider = next;
    try { window.localStorage.setItem(WORKSPACE_KEY, workspace); } catch (_) { /* not worth failing over */ }
    if (workspace !== 'claude') { codexAsked = true; transport.postMessage({ type: 'codex:watch' }); }
    paintSegmented();
    if (reduced()) { draw(lastInstances, lastFolders); return; }
    rows.classList.add('view-fade');
    setTimeout(() => {
      draw(lastInstances, lastFolders);
      requestAnimationFrame(() => rows.classList.remove('view-fade'));
    }, 150);
  }

  function setView(next) {
    if (!['attention', 'folders', 'recent'].includes(next) || next === view) return;
    view = next;
    try { window.localStorage.setItem(VIEW_KEY, view); } catch (_) { /* not worth failing over */ }
    paintSegmented();
    if (reduced()) { draw(lastInstances, lastFolders); return; }
    // A crossfade, not a rebuild: the rows underneath are the same elements,
    // just regrouped and resorted — only the list's own opacity moves.
    rows.classList.add('view-fade');
    setTimeout(() => {
      draw(lastInstances, lastFolders);
      requestAnimationFrame(() => rows.classList.remove('view-fade'));
    }, 150);
  }

  function buildChrome() {
    const bar = document.querySelector('.bar');
    if (!bar) return;
    if (IN_APP) { buildPhoneChrome(bar); return; }
    const title = bar.querySelector('.bar-title');

    const left = document.createElement('div');
    left.className = 'bar-left';
    editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'bar-button text';
    editBtn.id = 'edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => { if (editing) exitEdit(); else enterEdit(); });
    left.appendChild(editBtn);
    if (title) bar.insertBefore(left, title); else bar.appendChild(left);

    const right = bar.querySelector('.bar-right');
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'bar-button add';
    addBtn.id = 'create';
    addBtn.setAttribute('aria-label', 'New instance');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', openCreateSheet);
    if (right) right.insertBefore(addBtn, right.firstChild);
    else bar.appendChild(addBtn);

    const start = document.createElement('div');
    start.className = 'start-agents';
    for (const provider of ['claude', 'codex']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'start-agent ' + provider;
      button.innerHTML = '<span class="agent-mark">' + (provider === 'codex' ? '◈' : '✳') + '</span><span>New ' + (provider === 'codex' ? 'Codex' : 'Claude') + '</span><span class="start-plus">+</span>';
      button.addEventListener('click', () => { createProvider = provider; openCreateSheet(); });
      start.appendChild(button);
    }
    rows.parentNode.insertBefore(start, rows);

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'fleet-search';
    search.placeholder = 'Find a conversation or folder';
    search.setAttribute('aria-label', search.placeholder);
    search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); draw(lastInstances, lastFolders); });
    rows.parentNode.insertBefore(search, rows);

    wsEl = document.createElement('div');
    wsEl.className = 'segmented workspaces';
    wsEl.id = 'workspaceSwitch';
    wsEl.innerHTML =
      '<button type="button" class="seg-btn" data-ws="all">All agents</button>' +
      '<button type="button" class="seg-btn" data-ws="claude">Claude</button>' +
      '<button type="button" class="seg-btn codex" data-ws="codex">Codex</button>';
    wsEl.addEventListener('click', (event) => {
      const btn = event.target.closest('.seg-btn');
      if (btn) setWorkspace(btn.dataset.ws);
    });
    const controls = document.createElement('div');
    controls.className = 'fleet-controls';
    controls.appendChild(wsEl);
    viewPicker = document.createElement('select');
    viewPicker.className = 'fleet-sort';
    viewPicker.setAttribute('aria-label', 'Sort conversations');
    for (const [value, label] of [['attention', 'Priority'], ['folders', 'Folders'], ['recent', 'Recent']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label;
      viewPicker.appendChild(option);
    }
    viewPicker.addEventListener('change', () => setView(viewPicker.value));
    controls.appendChild(viewPicker);
    rows.parentNode.insertBefore(controls, rows);

    segEl = document.createElement('div');
    segEl.className = 'segmented';
    segEl.id = 'viewSwitch';
    segEl.hidden = true;
    segEl.innerHTML =
      '<button type="button" class="seg-btn" data-view="attention">Priority</button>' +
      '<button type="button" class="seg-btn" data-view="folders">Folders</button>' +
      '<button type="button" class="seg-btn" data-view="recent">Recent</button>';
    segEl.addEventListener('click', (event) => {
      const btn = event.target.closest('.seg-btn');
      if (btn) setView(btn.dataset.view);
    });
    rows.parentNode.insertBefore(segEl, rows);

    paintSegmented();
  }

  function requestHistory(force) {
    if (historyAsked && !force) return;
    historyAsked = true;
    transport.postMessage({ type: 'history', limit: 200 });
    setTimeout(() => {
      if (historyEntries !== null) return;
      historyTrouble = 'Your laptop did not send earlier chats.';
      if (scope === 'earlier' || filter) drawArchive();
    }, 12000);
  }

  function clearFilters() {
    filter = ''; projectFilter = ''; workspace = 'all';
    if (searchInput) searchInput.value = '';
    paintSegmented(); draw(lastInstances, lastFolders);
  }

  function showEmpty(title, action, tap) {
    rows.textContent = '';
    groupNodes.clear(); rowCache.clear();
    lede.hidden = true;
    const empty = document.createElement('div'); empty.className = 'empty-state';
    const h = document.createElement('h2'); h.textContent = title; empty.append(h);
    if (action) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'go-on'; b.textContent = action;
      b.addEventListener('click', tap); empty.append(b);
    }
    rows.append(empty);
  }

  function drawArchive() {
    const scroll = document.querySelector('.screen');
    const previousTop = scroll.scrollTop;
    const active = lastInstances.concat(lastCodex);
    let entries = mergeConversations(active, historyEntries);
    if (scope === 'earlier' && !filter) {
      const ids = new Set((historyEntries || []).map((e) => (e.provider || 'claude') + ':' + String(e.sessionId).replace(/^cx-/, '')));
      entries = entries.filter((e) => e.past || e.provider === 'codex' || ids.has((e.provider || 'claude') + ':' + String(e.sessionId || e.id).replace(/^cx-/, '')));
    }
    entries = entries.filter((e) => (workspace === 'all' || (e.provider || 'claude') === workspace) &&
      (!projectFilter || e.cwd === projectFilter) && (!filter || [e.label, e.autoLabel, e.title, e.cwd, e.branch, e.sessionId, e.id, e.provider || 'claude']
        .some((v) => String(v || '').toLowerCase().includes(filter)))).sort((a, b) => b.activeAt - a.activeAt);
    showEmpty(historyEntries === null ? 'Loading earlier chats…' : filter ? 'No matching conversations' : 'No earlier chats',
      historyTrouble ? 'Try again' : filter || projectFilter || workspace !== 'all' ? 'Clear filters' : null,
      historyTrouble ? () => { historyTrouble = null; historyAsked = false; requestHistory(); drawArchive(); } : clearFilters);
    if (entries.length) {
      rows.textContent = '';
      const card = document.createElement('div'); card.className = 'rows-card'; rows.append(card);
      for (const entry of entries.slice(0, historyLimit)) {
        const row = buildRow(entry);
        if (entry.past && (entry.provider || 'claude') !== 'codex') {
          row.href = '#';
          row.addEventListener('click', (event) => {
            event.preventDefault();
            if (openingHistory) return;
            openingHistory = entry.sessionId; row.classList.add('busy');
            ask('instance:resume', { sessionId: entry.sessionId }).then((made) => {
              location.href = (window.NIKUI_REMOTE.conversation || 'conversation.html?session=') + encodeURIComponent(made.instance);
            }).catch((error) => {
              openingHistory = null; row.classList.remove('busy'); lede.hidden = false;
              lede.textContent = error.reason || 'Could not open this chat. Try again.';
            });
          });
        }
        card.append(row);
      }
      if (entries.length > historyLimit) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'go-on'; more.textContent = 'Show more';
        more.addEventListener('click', () => { historyLimit += 60; drawArchive(); }); rows.append(more);
      }
    }
    if (historyTrouble) { lede.hidden = false; lede.textContent = historyTrouble; }
    scroll.scrollTop = restored.top != null && historyEntries !== null ? restored.top : previousTop;
    if (historyEntries !== null) delete restored.top;
    if (document.body.classList.contains('stale')) { lede.hidden = false; lede.textContent = 'Offline · Showing saved conversations'; }
  }

  function openMoveSheet(id) {
    const instance = lastInstances.find((i) => i.id === id);
    if (!instance) return;
    if (!organizeSheet) organizeSheet = window.NikApp.sheet({ title: 'Move conversation' });
    organizeSheet.body.textContent = '';
    const note = document.createElement('p'); note.className = 'create-note'; organizeSheet.body.append(note);
    for (const folder of [{ id: null, name: 'No group' }].concat(lastFolders)) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'agent-option'; b.textContent = folder.name;
      b.addEventListener('click', () => {
        b.disabled = true;
        ask('instance:place', { instance: id, folderId: folder.id }).then(() => organizeSheet.close())
          .catch((error) => { b.disabled = false; note.textContent = error.reason || 'Could not move this conversation.'; });
      }); organizeSheet.body.append(b);
    }
    organizeSheet.show(() => [...rows.querySelectorAll('.row')].find((r) => r.dataset.instance === id));
  }

  function buildPhoneChrome(bar) {
    const title = bar.querySelector('.bar-title');
    scopeControl = document.createElement('div'); scopeControl.className = 'chat-scope'; scopeControl.setAttribute('role', 'group'); scopeControl.setAttribute('aria-label', 'Chat scope');
    for (const [value, label] of [['active', 'Active'], ['earlier', 'Earlier']]) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.scope = value; b.textContent = label;
      b.addEventListener('click', () => { scope = value; exitEdit(); paintSegmented(); draw(lastInstances, lastFolders); requestHistory(); }); scopeControl.append(b);
    }
    const left = document.createElement('div'); left.className = 'bar-left'; left.append(title); bar.prepend(left);
    bar.insertBefore(scopeControl, bar.querySelector('.bar-right'));
    const searchBar = document.createElement('div'); searchBar.className = 'chat-search';
    searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.className = 'fleet-search'; searchInput.placeholder = 'Search all chats'; searchInput.setAttribute('aria-label', 'Search all chats'); searchInput.value = filter;
    searchInput.addEventListener('input', () => { filter = searchInput.value.trim().toLowerCase(); exitEdit(); paintSegmented(); requestHistory(); draw(lastInstances, lastFolders); });
    const filters = document.createElement('details'); filters.className = 'chat-filters';
    const summary = document.createElement('summary'); summary.textContent = 'Filter'; summary.setAttribute('aria-label', 'Filter and organize chats');
    filters.append(summary);
    const controls = document.createElement('div'); controls.className = 'chat-filter-options';
    wsEl = document.createElement('div'); wsEl.className = 'segmented workspaces'; wsEl.id = 'workspaceSwitch';
    for (const [value, label] of [['all','All'],['claude','Claude'],['codex','Codex']]) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-btn'; b.dataset.ws = value; b.textContent = label;
      b.addEventListener('click', () => setWorkspace(value)); wsEl.append(b);
    }
    controls.append(wsEl);
    viewPicker = document.createElement('select'); viewPicker.className = 'fleet-sort'; viewPicker.setAttribute('aria-label', 'Sort conversations');
    for (const [value, label] of [['attention','Priority'],['recent','Recent'],['folders','Folders']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; viewPicker.append(option);
    }
    viewPicker.addEventListener('change', () => setView(viewPicker.value)); controls.append(viewPicker);
    const project = document.createElement('select'); project.className = 'project-filter'; project.setAttribute('aria-label', 'Filter by project');
    const updateProjects = () => {
      const paths = [...new Set(lastProjects.map((p) => p.path).concat(lastInstances.concat(lastCodex).map((i) => i.cwd), (historyEntries || []).map((i) => i.cwd)).filter(Boolean))];
      project.textContent = '';
      for (const path of [''].concat(paths)) { const option = document.createElement('option'); option.value = path; option.textContent = path ? shortPath(path) : 'All projects'; project.append(option); } project.value = projectFilter;
    };
    filters.addEventListener('toggle', () => { if (filters.open) updateProjects(); });
    project.addEventListener('change', () => { projectFilter = project.value; draw(lastInstances, lastFolders); }); controls.append(project);
    editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.id = 'edit'; editBtn.className = 'bar-button text'; editBtn.textContent = 'Organize';
    editBtn.addEventListener('click', () => { if (editing) exitEdit(); else { setView('folders'); enterEdit(); } filters.open = false; }); editHome = controls; controls.append(editBtn);
    filters.append(controls); searchBar.append(searchInput, filters); rows.parentNode.before(searchBar);
    const add = document.createElement('button'); add.type = 'button'; add.id = 'create'; add.className = 'new-chat'; add.textContent = '+ New chat'; add.addEventListener('click', openCreateSheet);
    rows.parentNode.after(add);
    segEl = wsEl; paintSegmented();
  }

  // ---- rearranging, and moving a row into a different folder -----------------
  // Dragging only ever does one of two things: change where a row sits inside
  // its own card, or move it into another card entirely — a folder's, a
  // project's, or the "everything else" pile. Both are the same gesture; only
  // what happens when a finger lifts differs.
  let longPress = null;

  /** Record where every child of these containers is, run `mutate`, then
   * animate each one from where it was to where it ended up — which is what
   * makes the rows a dragged one passes over look like they slide aside
   * rather than teleport. */
  function flip(containers, exclude, mutate) {
    const before = new Map();
    for (const container of containers) {
      for (const child of container.children) {
        if (child === exclude) continue;
        before.set(child, child.getBoundingClientRect());
      }
    }
    mutate();
    if (reduced()) return;
    for (const [child, prev] of before) {
      if (!child.isConnected) continue;
      const now = child.getBoundingClientRect();
      const dy = prev.top - now.top;
      if (!dy) continue;
      child.style.transition = 'none';
      child.style.transform = 'translateY(' + dy + 'px)';
      requestAnimationFrame(() => {
        child.style.transition = 'transform 220ms ease';
        child.style.transform = '';
      });
    }
  }

  function beginDrag(row, event) {
    if (dragState || view !== 'folders') return;
    try { row.setPointerCapture(event.pointerId); } catch (_) { /* not granted */ }
    dragState = {
      row: row,
      pointerId: event.pointerId,
      startY: event.clientY,
      originParent: row.parentNode,
      originNext: row.nextSibling,
      originGroup: row.dataset.group
    };
    row.classList.add('row-dragging');
    if (window.NikHaptic) window.NikHaptic('light');
  }

  /** What's directly under the finger — another row first, so dropping lands
   * relative to it, or failing that the card itself, so an almost-empty one is
   * still somewhere to drop into. */
  function dropTarget(x, y) {
    const here = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    const row = here.find((el) => el.classList && el.classList.contains('row') &&
      el !== dragState.row && el.dataset && el.dataset.instance);
    if (row) return { parent: row.parentNode, before: row };
    const card = here.find((el) => el.classList && el.classList.contains('rows-card'));
    if (card) return { parent: card, before: null };
    return null;
  }

  function onDragMove(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    event.preventDefault();
    const row = dragState.row;
    row.style.transform = 'translateY(' + (event.clientY - dragState.startY) + 'px)';

    const target = dropTarget(event.clientX, event.clientY);
    if (!target) return;
    let before = target.before;
    if (before) {
      const rect = before.getBoundingClientRect();
      // Below the midpoint of the row it landed on counts as "after it".
      if (event.clientY > rect.top + rect.height / 2) before = before.nextSibling;
      if (before === row) return;
    }
    if (target.parent === row.parentNode && before === row.nextSibling) return;
    flip([row.parentNode, target.parent], row, () => {
      if (before) target.parent.insertBefore(row, before);
      else target.parent.appendChild(row);
    });
    row.dataset.group = target.parent.dataset.group;
  }

  function endDrag() {
    if (!dragState) return;
    if (IN_APP) moveTapAfter = Date.now() + 400;
    const { row, originParent, originNext, originGroup } = dragState;
    dragState = null;
    row.classList.remove('row-dragging');
    row.style.transform = '';
    if (window.NikHaptic) window.NikHaptic('light');

    const newGroup = row.dataset.group;
    const newParent = row.parentNode;
    saveOrder(newGroup, [...newParent.children].map((r) => r.dataset.instance).filter(Boolean));
    // A fleet held back while the row was in hand. Not after a move between
    // groups: that one still files the row where it was until the laptop's
    // answer, which comes with a fleet of its own.
    const held = drawAfterDrop;
    drawAfterDrop = false;
    if (originGroup === newGroup) { if (held) draw(lastInstances, lastFolders); return; }

    saveOrder(originGroup, [...originParent.children].map((r) => r.dataset.instance).filter(Boolean));
    const instanceId = row.dataset.instance;
    const folderId = newGroup.indexOf('f:') === 0 ? newGroup.slice(2) : null;
    ask('instance:place', { instance: instanceId, folderId: folderId }).catch((refusal) => {
      // Put it back where it came from, and say why it would not move.
      flip([newParent, originParent], row, () => {
        if (originNext && originNext.parentNode === originParent) originParent.insertBefore(row, originNext);
        else originParent.appendChild(row);
      });
      row.dataset.group = originGroup;
      saveOrder(originGroup, [...originParent.children].map((r) => r.dataset.instance).filter(Boolean));
      saveOrder(newGroup, [...newParent.children].map((r) => r.dataset.instance).filter(Boolean));
      lede.hidden = false;
      lede.textContent = (refusal && refusal.reason) || 'That could not be moved.';
      setTimeout(() => { if (lastInstances.length) draw(lastInstances, lastFolders); }, 2500);
    });
  }

  function cancelDrag() {
    if (longPress) { clearTimeout(longPress.timer); longPress = null; }
    if (!dragState) return;
    const row = dragState.row;
    row.classList.remove('row-dragging');
    row.style.transform = '';
    dragState = null;
    if (drawAfterDrop) { drawAfterDrop = false; draw(lastInstances, lastFolders); }
  }

  // One set of listeners on the list itself, since rows come and go under it
  // constantly — binding one per row would mean rebinding on every redraw.
  rows.addEventListener('click', (event) => {
    if (!editing) return;
    // Rows are not links while editing: a tap starts or continues a drag, or
    // does nothing, but it never navigates away mid-rearrange.
    if (event.target.closest('.row')) event.preventDefault();
  }, true);

  rows.addEventListener('pointerdown', (event) => {
    const row = event.target.closest('.row');
    if (!row || !row.dataset.instance || view !== 'folders' || row.dataset.provider === 'codex') return;
    if (editing) {
      if (event.target.closest('.row-handle')) beginDrag(row, event);
      return;
    }
    // Outside edit mode, a long press is "edit this row", not "edit the
    // screen": it enters edit mode with the pressed row already picked up.
    longPress = {
      row: row,
      startX: event.clientX,
      startY: event.clientY,
      lastEvent: event,
      timer: setTimeout(() => {
        if (!longPress) return;
        const pressed = longPress;
        longPress = null;
        enterEdit();
        beginDrag(pressed.row, pressed.lastEvent);
      }, 500)
    };
  });

  rows.addEventListener('pointermove', (event) => {
    if (dragState) { onDragMove(event); return; }
    if (longPress && event.pointerId === longPress.lastEvent.pointerId) {
      if (Math.abs(event.clientX - longPress.startX) > 8 || Math.abs(event.clientY - longPress.startY) > 8) {
        clearTimeout(longPress.timer);
        longPress = null;
      } else {
        longPress.lastEvent = event;
      }
    }
  });

  const stopLongPress = () => { if (longPress) { clearTimeout(longPress.timer); longPress = null; } };
  rows.addEventListener('pointerup', (event) => {
    stopLongPress();
    if (dragState && event.pointerId === dragState.pointerId) endDrag();
  });
  rows.addEventListener('pointercancel', (event) => {
    stopLongPress();
    if (dragState && event.pointerId === dragState.pointerId) cancelDrag();
  });

  // ---- the "+" sheet: start an instance in one of this window's projects ----
  let selectedFolderId = null;
  let sheetEls = null;

  function buildCreateSheet() {
    if (IN_APP) {
      phoneSheet = window.NikApp.sheet({ title: 'New chat', className: 'new-chat-sheet' });
      phoneSheet.body.innerHTML = '<div class="create-providers"><button class="chip" type="button" data-provider="claude">Claude</button><button class="chip" type="button" data-provider="codex">Codex</button></div>' +
        '<details class="create-group"><summary>Organize in a group</summary><div class="folder-chips" id="createFolders"></div></details>' +
        '<div class="create-list" id="createList"></div><p class="create-note" id="createNote" role="status" hidden></p>';
      phoneSheet.body.querySelector('.create-providers').addEventListener('click', (event) => {
        const button = event.target.closest('[data-provider]');
        if (!button || creationBusy) return;
        createProvider = button.dataset.provider; localStorage.setItem('nikui.chats.provider', createProvider); renderCreateSheet();
      });
      const folders = phoneSheet.body.querySelector('#createFolders');
      folders.addEventListener('click', (event) => {
        const chip = event.target.closest('.chip'); if (!chip || creationBusy) return;
        selectedFolderId = chip.dataset.folder || null;
        for (const c of folders.children) { c.classList.toggle('on', c === chip); c.setAttribute('aria-pressed', String(c === chip)); }
      });
      return { backdrop: phoneSheet.backdrop, sheet: phoneSheet.panel, folders, list: phoneSheet.body.querySelector('#createList'), note: phoneSheet.body.querySelector('#createNote') };
    }
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.id = 'createBackdrop';
    backdrop.hidden = true;
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeCreateSheet(); });

    const sheet = document.createElement('div');
    sheet.className = 'create-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'New conversation');
    sheet.innerHTML =
      '<div class="sheet-grab"></div>' +
      '<div class="create-heading"><h2 class="sheet-h">New conversation</h2><button class="sheet-close" type="button" aria-label="Close new conversation">×</button></div>' +
      '<p class="create-sub">Choose an agent, then a project to start.</p>' +
      '<div class="create-providers"><button class="chip" type="button" data-provider="claude">✳ Claude</button><button class="chip" type="button" data-provider="codex">◈ Codex</button></div>' +
      '<div class="folder-chips" id="createFolders" hidden></div>' +
      '<div class="create-list" id="createList"></div>' +
      '<p class="create-note" id="createNote" hidden></p>';
    backdrop.appendChild(sheet);
    document.body.appendChild(backdrop);
    (window.NikBack = window.NikBack || []).push(() => {
      if (backdrop.hidden) return false;
      closeCreateSheet();
      return true;
    });
    sheet.querySelector('.sheet-close').addEventListener('click', closeCreateSheet);
    sheet.querySelector('.create-providers').addEventListener('click', (event) => {
      const button = event.target.closest('[data-provider]');
      if (button) { createProvider = button.dataset.provider; renderCreateSheet(); }
    });
    backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeCreateSheet(); }
      if (event.key !== 'Tab') return;
      const buttons = [...sheet.querySelectorAll('button:not([disabled])')].filter((b) => b.getClientRects().length);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    const folders = sheet.querySelector('#createFolders');
    folders.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      selectedFolderId = chip.dataset.folder || null;
      for (const c of folders.querySelectorAll('.chip')) c.classList.toggle('on', c === chip);
    });

    // Swipe down on the grab handle dismisses the sheet, the same gesture
    // that closes it everywhere else on the phone.
    let grabDrag = null;
    const grab = sheet.querySelector('.sheet-grab');
    grab.addEventListener('pointerdown', (event) => {
      grabDrag = { startY: event.clientY };
      try { grab.setPointerCapture(event.pointerId); } catch (_) { /* not granted */ }
    });
    grab.addEventListener('pointermove', (event) => {
      if (!grabDrag) return;
      const dy = Math.max(0, event.clientY - grabDrag.startY);
      sheet.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
    });
    const releaseGrab = (event) => {
      if (!grabDrag) return;
      const dy = Math.max(0, (event.clientY || grabDrag.startY) - grabDrag.startY);
      grabDrag = null;
      sheet.style.transform = '';
      if (dy > 80) closeCreateSheet();
    };
    grab.addEventListener('pointerup', releaseGrab);
    grab.addEventListener('pointercancel', releaseGrab);

    return { backdrop: backdrop, sheet: sheet, folders: folders, list: sheet.querySelector('#createList'), note: sheet.querySelector('#createNote') };
  }

  function tapProject(project, rowEl) {
    if ((IN_APP && creationBusy) || rowEl.classList.contains('busy')) return;
    if (IN_APP) creationBusy = true;
    rowEl.classList.add('busy');
    sheetEls.note.hidden = true;
    const extra = createProvider === 'codex' ? { cwd: project.path, provider: 'codex' }
      : { cwd: project.path, folderId: selectedFolderId || undefined };
    ask('instance:new', extra).then((made) => {
      location.href = ((window.NIKUI_REMOTE || {}).conversation || '/s/') + encodeURIComponent(made.instance);
    }).catch((refusal) => {
      creationBusy = false;
      rowEl.classList.remove('busy');
      if (IN_APP) rowEl.querySelector('.create-name').textContent = 'Retry · ' + project.name;
      sheetEls.note.hidden = false;
      sheetEls.note.textContent = (refusal && refusal.reason) || 'That did not work.';
    });
  }

  function renderCreateSheet() {
    if (!IN_APP) selectedFolderId = null;
    sheetEls.folders.innerHTML = '';
    const heading = sheetEls.sheet.querySelector('.sheet-h');
    if (heading) heading.textContent = IN_APP ? 'New chat' : 'New conversation';
    for (const b of sheetEls.sheet.querySelectorAll('[data-provider]')) {
      b.classList.toggle('on', b.dataset.provider === createProvider);
      b.setAttribute('aria-pressed', String(b.dataset.provider === createProvider));
    }
    if (lastFolders.length && createProvider !== 'codex') {
      sheetEls.folders.hidden = false;
      const none = document.createElement('button');
      none.type = 'button';
      none.className = 'chip' + (!selectedFolderId ? ' on' : '');
      none.setAttribute('aria-pressed', String(!selectedFolderId));
      none.textContent = 'None';
      none.dataset.folder = '';
      sheetEls.folders.appendChild(none);
      for (const folder of lastFolders) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (folder.id === selectedFolderId ? ' on' : '');
        chip.setAttribute('aria-pressed', String(folder.id === selectedFolderId));
        chip.textContent = folder.name;
        chip.dataset.folder = folder.id;
        sheetEls.folders.appendChild(chip);
      }
    } else {
      sheetEls.folders.hidden = true;
    }

    sheetEls.list.innerHTML = '';
    // Codex can also start where one of its conversations already lives.
    let places = lastProjects;
    if (createProvider === 'codex') {
      const seen = new Set(lastProjects.map((p) => p.path));
      places = lastProjects.slice();
      for (const c of lastCodex) {
        if (!c.cwd || seen.has(c.cwd)) continue;
        seen.add(c.cwd);
        places.push({ path: c.cwd, name: c.cwd.split(/[\\/]/).filter(Boolean).pop() || c.cwd });
      }
    }
    if (IN_APP) {
      const recent = lastInstances.concat(lastCodex).slice().sort((a,b) => b.activeAt - a.activeAt).map((i) => i.cwd);
      places = places.slice().sort((a,b) => (recent.includes(a.path) ? recent.indexOf(a.path) : 999) - (recent.includes(b.path) ? recent.indexOf(b.path) : 999));
      sheetEls.sheet.querySelector('.create-group').hidden = !lastFolders.length || createProvider === 'codex';
    }
    for (const project of places) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'create-row';
      const name = document.createElement('span');
      name.className = 'create-name';
      name.textContent = project.name;
      const path = document.createElement('span');
      path.className = 'create-path';
      path.textContent = shortPath(project.path);
      const spin = document.createElement('span');
      spin.className = 'create-spin';
      row.append(name, path, spin);
      row.addEventListener('click', () => tapProject(project, row));
      sheetEls.list.appendChild(row);
    }
    sheetEls.note.hidden = true;
    if (!places.length) {
      sheetEls.note.hidden = false;
      sheetEls.note.textContent = 'No project folders are available yet. Open a project in VS Code on your laptop, then try again.';
    }
  }

  function openCreateSheet() {
    if (document.body.classList.contains('read-only')) return;
    if (!sheetEls) sheetEls = buildCreateSheet();
    if (!creationBusy) renderCreateSheet();
    if (IN_APP) { phoneSheet.show($('create')); return; }
    sheetEls.backdrop.hidden = false;
    createReturn = document.activeElement;
    sheetEls.sheet.querySelector('.sheet-close').focus();
    if (reduced()) { sheetEls.backdrop.classList.add('open'); return; }
    requestAnimationFrame(() => sheetEls.backdrop.classList.add('open'));
  }

  function closeCreateSheet() {
    if (!sheetEls) return;
    if (IN_APP) { phoneSheet.close(); return; }
    sheetEls.backdrop.classList.remove('open');
    if (createReturn) createReturn.focus();
    setTimeout(() => { sheetEls.backdrop.hidden = true; }, reduced() ? 0 : 260);
  }

  buildChrome();

  transport.postMessage({ type: 'ready' });

  // Exported so the rule for how a window is filed can be checked without a
  // browser: it is the one piece of this file that is a decision rather than
  // drawing.
  if (typeof module !== 'undefined' && module.exports) module.exports = { group, attentionGroups, mergeConversations };
})();
