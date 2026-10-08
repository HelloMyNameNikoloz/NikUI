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
  const openedAt = Date.now();

  const money = (value) => '$' + (Number(value) || 0).toFixed(2);
  const shortPath = (value) => String(value || '').split('/').slice(-2).join('/');

  function ago(at) {
    const ms = Date.now() - at;
    if (ms < 45000) return 'a moment ago';
    if (ms < 3600000) return Math.round(ms / 60000) + ' minutes ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + ' hours ago';
    return Math.round(ms / 86400000) + ' days ago';
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

  /**
   * One entry per group, kept across redraws rather than rebuilt by them: the
   * head and the card are the same two nodes for as long as the group exists,
   * and each group remembers the row nodes inside it the same way. A fleet
   * message every few seconds used to mean wiping `.rows` and building it
   * again from nothing — every row's node torn down and a new one put in its
   * place, which is what made a status dot blink by disappearing rather than
   * changing colour, and what threw away any transition a row was mid-way
   * through. Keyed by id, nothing is rebuilt unless it is actually new.
   */
  const groupNodes = new Map();

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

  function draw(instances, folders) {
    // The skeleton shown while the first message was still in flight is not
    // one of the groups below — it was never tracked in `groupNodes` — so it
    // has to be swept out by hand, or the first real row would land next to
    // four rows shaped like one.
    const placeholder = rows.querySelector('.rows-card.skeleton');
    if (placeholder) placeholder.remove();

    if (!instances.length) {
      rows.textContent = '';
      groupNodes.clear();
      lede.textContent = 'No instances are open in the editor yet.';
      return;
    }
    lede.textContent = instances.length === 1 ? 'One instance.' : instances.length + ' instances.';

    const groups = group(instances, folders);
    // One project and nothing else is not a grouping, it is a heading nobody
    // needs — so it is only drawn when there is more than one thing to tell
    // apart.
    const headed = groups.length > 1;
    const seen = new Set();
    let anchor = null;

    for (const set of groups) {
      seen.add(set.key);
      let entry = groupNodes.get(set.key);
      if (!entry) {
        entry = { head: null, card: null, rowNodes: new Map() };
        groupNodes.set(set.key, entry);
      }

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
        entry.head.lastChild.textContent = set.instances.length ? String(set.instances.length) : 'empty';
        placeAfter(entry.head, anchor, rows);
        anchor = entry.head;
      } else if (entry.head) {
        entry.head.remove();
        entry.head = null;
      }

      if (!set.instances.length) {
        if (entry.card) { entry.card.remove(); entry.card = null; entry.rowNodes.clear(); }
        continue;
      }
      if (!entry.card) {
        entry.card = document.createElement('div');
        entry.card.className = 'rows-card';
      }
      placeAfter(entry.card, anchor, rows);
      anchor = entry.card;
      drawRows(entry.card, entry.rowNodes, set.instances);
    }

    // A group that is simply gone this time — its folder emptied into another,
    // say — leaves the way a row does: fading rather than snapping away.
    for (const [key, entry] of groupNodes) {
      if (seen.has(key)) continue;
      fadeOutRemove(entry.head);
      fadeOutRemove(entry.card);
      groupNodes.delete(key);
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

    const notes = [];
    if (instance.queued) notes.push(instance.queued + ' queued');
    if (instance.paused) notes.push('waiting for the quota');
    row.whereEl.textContent = shortPath(instance.cwd) + (notes.length ? ' · ' + notes.join(' · ') : '');

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
    paintRow(row, instance);
    return row;
  }

  /**
   * Fill `into` with these instances, keeping the node for a given instance
   * id across calls: a status that changes is a class and three lines of text
   * changing on the row that was already there, not a new row replacing it —
   * which is what made the fleet's own identity (which `<a>` is "that
   * instance") survive a redraw, rather than resetting with every one.
   */
  function drawRows(into, rowNodes, instances) {
    const seen = new Set();
    let anchor = null;
    for (const instance of instances) {
      seen.add(instance.id);
      let row = rowNodes.get(instance.id);
      if (!row) {
        row = buildRow(instance);
        rowNodes.set(instance.id, row);
        row.classList.add('row-enter');
        // Added in a frame of its own: a class set and removed in the same
        // tick never triggers the transition it names.
        requestAnimationFrame(() => row.classList.remove('row-enter'));
      } else {
        paintRow(row, instance);
      }
      placeAfter(row, anchor, into);
      anchor = row;
    }
    for (const [id, row] of rowNodes) {
      if (seen.has(id)) continue;
      rowNodes.delete(id);
      fadeOutRemove(row);
    }
  }

  /** Four rows shaped like the real thing, shimmering while nothing has
   * arrived yet — shown only when there is no cached fleet to show instead. */
  function skeletonRows(count) {
    rows.textContent = '';
    groupNodes.clear();
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

  function live(instances, folders) {
    document.body.classList.remove('stale');
    const retry = document.getElementById('retry');
    if (retry) retry.remove();
    draw(instances, folders);
    remember(instances, folders);
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

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'fleet') live(message.instances || [], message.folders || []);
    else if (message.type === '@denied') refused(message);
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
  // "Try again" button does.
  if (window.NikPull) {
    window.NikPull.attach(document.querySelector('.screen'), () => transport.retry());
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

  transport.postMessage({ type: 'ready' });

  // Exported so the rule for how a window is filed can be checked without a
  // browser: it is the one piece of this file that is a decision rather than
  // drawing.
  if (typeof module !== 'undefined' && module.exports) module.exports = { group };
})();
