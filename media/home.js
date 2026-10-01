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

  function draw(instances, folders) {
    rows.textContent = '';
    if (!instances.length) {
      lede.textContent = 'No instances are open in the editor yet.';
      return;
    }
    lede.textContent = instances.length === 1 ? 'One instance.' : instances.length + ' instances.';

    const groups = group(instances, folders);
    // One project and nothing else is not a grouping, it is a heading nobody
    // needs — so it is only drawn when there is more than one thing to tell
    // apart.
    const headed = groups.length > 1;

    for (const set of groups) {
      if (headed) {
        const head = document.createElement('div');
        head.className = 'rows-head ' + set.kind;
        const name = document.createElement('span');
        name.className = 'rows-head-name';
        name.textContent = set.name;
        head.appendChild(name);
        const count = document.createElement('span');
        count.className = 'rows-head-count';
        count.textContent = set.instances.length
          ? String(set.instances.length)
          : 'empty';
        head.appendChild(count);
        rows.appendChild(head);
      }
      if (!set.instances.length) continue;
      const card = document.createElement('div');
      card.className = 'rows-card';
      rows.appendChild(card);
      drawRows(card, set.instances);
    }
  }

  function drawRows(into, instances) {
    for (const instance of instances) {
      const row = document.createElement('a');
      row.className = 'row';
      // A path on the laptop when it served this page; a page in the bundle
      // when an app did. The list does not need to know which.
      row.href = ((window.NIKUI_REMOTE || {}).conversation || '/s/') + encodeURIComponent(instance.id);

      const dot = document.createElement('span');
      dot.className = 'sdot ' + String(instance.status || 'idle').replace(/[^a-z]/g, '') +
        (instance.asleep ? ' asleep' : '') + (instance.unread ? ' unread' : '');
      row.appendChild(dot);
      if (instance.unread) {
        row.classList.add('unread');
        dot.title = 'Finished, not opened since';
      }

      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = instance.label || instance.id;
      row.appendChild(name);

      const where = document.createElement('span');
      where.className = 'row-cwd';
      const notes = [];
      if (instance.queued) notes.push(instance.queued + ' queued');
      if (instance.paused) notes.push('waiting for the quota');
      where.textContent = shortPath(instance.cwd) + (notes.length ? ' · ' + notes.join(' · ') : '');
      row.appendChild(where);

      const cost = document.createElement('span');
      cost.className = 'row-cost';
      cost.textContent = money(instance.cost);
      row.appendChild(cost);

      into.appendChild(row);
    }
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

  // Something to look at while the socket is still shaking hands.
  const saved = remembered();
  if (saved) {
    document.body.classList.add('stale');
    draw(saved.instances, saved.folders);
    lede.textContent = 'Last seen ' + ago(saved.at) + '. Reconnecting…';
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
