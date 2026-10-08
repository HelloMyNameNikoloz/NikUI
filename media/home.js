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

  // Loaded on a page that has no list to draw — which is every page but the
  // fleet, and the test that reads the filing rule out of this file. Exported
  // either way; nothing else runs.
  if (!rows || !lede) {
    if (typeof module !== 'undefined' && module.exports) module.exports = { group };
    return;
  }

  const transport = window.nikTransport();
  const REMEMBERED = 'nikui:fleet';
  const VIEW_KEY = 'nikui:fleet:view';
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
        JSON.stringify({ at: Date.now(), instances: instances, folders: folders || [] }));
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
  let view = window.localStorage.getItem(VIEW_KEY) === 'recent' ? 'recent' : 'folders';
  // Up here rather than with the rest of the dragging below, because `draw`
  // reads it: a fleet arriving mid-drag would put the row back under the
  // finger, so it waits for the drop instead (see `endDrag`).
  let dragState = null;
  let drawAfterDrop = false;
  let lastInstances = [];
  let lastFolders = [];
  let lastProjects = [];

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

    if (!instances.length) {
      rows.textContent = '';
      groupNodes.clear();
      rowCache.clear();
      lede.textContent = 'No instances are open in the editor yet.';
      return;
    }
    lede.textContent = instances.length === 1 ? 'One instance.' : instances.length + ' instances.';

    // A folder with nothing in it is not worth a card on a screen this small:
    // dropped here rather than in `group()`, which still has to say a folder
    // exists — the editor's own sidebar reads that list too.
    const groups = view === 'recent' ? recentGroup(instances)
      : group(instances, folders).filter((g) => g.instances.length > 0);
    // One project and nothing else is not a grouping, it is a heading nobody
    // needs — so it is only drawn when there is more than one thing to tell
    // apart, and never in Recent, which is one card by definition.
    const headed = view === 'folders' && groups.length > 1;
    const seenGroups = new Set();
    const seenRows = new Set();
    let anchor = null;

    for (const set of groups) {
      seenGroups.add(set.key);
      let entry = groupNodes.get(set.key);
      if (!entry) { entry = { head: null, card: null }; groupNodes.set(set.key, entry); }

      if (headed) {
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

      const ordered = view === 'recent' ? set.instances : applyOrder(set.key, set.instances);
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

    if (view === 'recent') {
      // Which folder or project it belongs to, since Recent has no heading to
      // say so otherwise, and how long ago it last did anything, which is the
      // whole reason to be looking at this view rather than Folders.
      const where = instance.folder ? instance.folder.name
        : (instance.project ? instance.project.name : 'Everything else');
      row.whereEl.textContent = where + ' · ' + shortAgo(instance.activeAt);
    } else {
      const notes = [];
      if (instance.queued) notes.push(instance.queued + ' queued');
      if (instance.paused) notes.push('waiting for the quota');
      row.whereEl.textContent = shortPath(instance.cwd) + (notes.length ? ' · ' + notes.join(' · ') : '');
    }

    row.costEl.textContent = money(instance.cost);
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
    row.appendChild(row.costEl);
    // Only ever shown in edit mode (see app.css), but built once rather than
    // added and removed with it — a row dragged mid-edit should not lose the
    // handle it is being dragged by because a redraw happened to land first.
    row.handleEl = document.createElement('span');
    row.handleEl.className = 'row-handle';
    row.appendChild(row.handleEl);
    paintRow(row, instance);
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
      row.append(dot, name, where, cost);
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

  function live(instances, folders, projects) {
    document.body.classList.remove('stale');
    const retry = document.getElementById('retry');
    if (retry) retry.remove();
    lastInstances = instances;
    lastFolders = folders;
    lastProjects = projects || [];
    draw(instances, folders);
    remember(instances, folders);
    settleRefreshes();
  }

  /**
   * What there is to show when the laptop cannot be reached: the last list,
   * said to be the last list, and a way to ask again.
   */
  function stale(why) {
    const saved = remembered();
    document.body.classList.add('stale');
    if (!saved) {
      rows.textContent = '';
      lede.textContent = why || 'Cannot reach the laptop.';
    } else {
      draw(saved.instances, saved.folders);
      lede.textContent = (why || 'Cannot reach the laptop.') + ' Showing what it looked like ' + ago(saved.at) + '.';
    }
    if (!document.getElementById('retry')) {
      const retry = document.createElement('button');
      retry.className = 'go-on';
      retry.id = 'retry';
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.addEventListener('click', function () {
        lede.textContent = 'Trying again…';
        transport.retry();
      });
      // Outside the list, so the list can be dimmed without dimming the way
      // out of it.
      rows.parentNode.appendChild(retry);
    }
  }

  function refused(message) {
    rows.textContent = '';
    document.body.classList.remove('stale');
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
      pending.set(id, { resolve, reject });
      transport.postMessage(Object.assign({ type: type, id: id }, extra || {}));
    });
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'fleet') live(message.instances || [], message.folders || [], message.projects || []);
    else if (message.type === '@denied') refused(message);
    else if (message.type === 'instance:created' || message.type === 'instance:placed') {
      const waiting = pending.get(message.id);
      if (waiting) { pending.delete(message.id); waiting.resolve(message); }
    } else if (message.type === '@refused') {
      const waiting = pending.get(message.id);
      if (waiting) { pending.delete(message.id); waiting.reject(message); }
    }
  });

  // Something to look at while the socket is still shaking hands: the cached
  // fleet if there is one, or rows shaped like what is about to arrive if
  // there is not. Either beats a blank list and the word "Connecting…".
  const saved = remembered();
  if (saved) {
    document.body.classList.add('stale');
    draw(saved.instances, saved.folders);
    lede.textContent = 'Last seen ' + ago(saved.at) + '. Reconnecting…';
  } else {
    skeletonRows(4);
  }

  // A pull at the top of the list asks the laptop again, the same way the
  // "Try again" button does — and this time waits for the fleet that answers
  // it, rather than guessing when the laptop is done.
  if (window.NikPull) {
    window.NikPull.attach(document.querySelector('.screen'), () => {
      const waited = new Promise((resolve) => refreshWaiters.push(resolve));
      transport.retry();
      return waited;
    });
  }

  /**
   * A list is only current while the socket is. Nothing pushes "the connection
   * died" — there is no connection to push it — so the page asks, and the
   * moment the answer stops being "online" the list says what it is.
   */
  let wasLive = false;
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
  let segEl = null;

  function enterEdit() {
    if (editing || view !== 'folders') return;
    editing = true;
    if (editBtn) editBtn.textContent = 'Done';
    rows.classList.add('editing');
  }
  function exitEdit() {
    if (!editing) return;
    editing = false;
    if (editBtn) editBtn.textContent = 'Edit';
    rows.classList.remove('editing');
    cancelDrag();
  }

  function paintSegmented() {
    if (!segEl) return;
    for (const btn of segEl.querySelectorAll('.seg-btn')) btn.classList.toggle('on', btn.dataset.view === view);
    if (editBtn) editBtn.hidden = view !== 'folders';
    if (view !== 'folders') exitEdit();
  }

  function setView(next) {
    if ((next !== 'folders' && next !== 'recent') || next === view) return;
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

    segEl = document.createElement('div');
    segEl.className = 'segmented';
    segEl.id = 'viewSwitch';
    segEl.innerHTML =
      '<button type="button" class="seg-btn" data-view="folders">Folders</button>' +
      '<button type="button" class="seg-btn" data-view="recent">Recent</button>';
    segEl.addEventListener('click', (event) => {
      const btn = event.target.closest('.seg-btn');
      if (btn) setView(btn.dataset.view);
    });
    rows.parentNode.insertBefore(segEl, rows);

    paintSegmented();
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
    if (!row || !row.dataset.instance || view !== 'folders') return;
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
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.id = 'createBackdrop';
    backdrop.hidden = true;
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeCreateSheet(); });

    const sheet = document.createElement('div');
    sheet.className = 'create-sheet';
    sheet.innerHTML =
      '<div class="sheet-grab"></div>' +
      '<h2 class="sheet-h">New instance</h2>' +
      '<div class="folder-chips" id="createFolders" hidden></div>' +
      '<div class="create-list" id="createList"></div>' +
      '<p class="create-note" id="createNote" hidden></p>';
    backdrop.appendChild(sheet);
    document.body.appendChild(backdrop);

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
    if (rowEl.classList.contains('busy')) return;
    rowEl.classList.add('busy');
    sheetEls.note.hidden = true;
    ask('instance:new', { cwd: project.path, folderId: selectedFolderId || undefined }).then((made) => {
      location.href = ((window.NIKUI_REMOTE || {}).conversation || '/s/') + encodeURIComponent(made.instance);
    }).catch((refusal) => {
      rowEl.classList.remove('busy');
      sheetEls.note.hidden = false;
      sheetEls.note.textContent = (refusal && refusal.reason) || 'That did not work.';
    });
  }

  function renderCreateSheet() {
    selectedFolderId = null;
    sheetEls.folders.innerHTML = '';
    if (lastFolders.length) {
      sheetEls.folders.hidden = false;
      const none = document.createElement('button');
      none.type = 'button';
      none.className = 'chip on';
      none.textContent = 'None';
      none.dataset.folder = '';
      sheetEls.folders.appendChild(none);
      for (const folder of lastFolders) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = folder.name;
        chip.dataset.folder = folder.id;
        sheetEls.folders.appendChild(chip);
      }
    } else {
      sheetEls.folders.hidden = true;
    }

    sheetEls.list.innerHTML = '';
    for (const project of lastProjects) {
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
  }

  function openCreateSheet() {
    if (!sheetEls) sheetEls = buildCreateSheet();
    renderCreateSheet();
    sheetEls.backdrop.hidden = false;
    if (reduced()) { sheetEls.backdrop.classList.add('open'); return; }
    requestAnimationFrame(() => sheetEls.backdrop.classList.add('open'));
  }

  function closeCreateSheet() {
    if (!sheetEls) return;
    sheetEls.backdrop.classList.remove('open');
    setTimeout(() => { sheetEls.backdrop.hidden = true; }, reduced() ? 0 : 260);
  }

  buildChrome();

  transport.postMessage({ type: 'ready' });

  // Exported so the rule for how a window is filed can be checked without a
  // browser: it is the one piece of this file that is a decision rather than
  // drawing.
  if (typeof module !== 'undefined' && module.exports) module.exports = { group };
})();
