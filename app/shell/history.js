/* What this machine has talked about before.

   The same list the editor's History view shows, read over the socket the app
   is already holding. Tapping one brings it back as an instance — the live
   one if it is still open — and opens it, as the editor's History view does.

   The list is long on any machine that has been used, so it is searchable and
   grouped by day — a flat two hundred rows of "3h ago" is a list nobody
   scrolls to the end of. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = window.NikApp;
  const where = app.requireLaptop();
  if (!where) return;

  const screen = $('screen');
  const search = $('search');

  const state = { entries: null, trouble: null, filter: '', limit: 60, connected: false, opening: null, refused: null };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const ago = (at) => {
    const ms = Date.now() - new Date(at).getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
    if (ms < 7 * 86400000) return Math.round(ms / 86400000) + 'd ago';
    return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  /** Today, Yesterday, then the date — which is how anybody thinks about this. */
  function dayOf(at) {
    const then = new Date(at);
    const today = new Date();
    const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((midnight(today) - midnight(then)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return then.toLocaleDateString(undefined, { weekday: 'long' });
    return then.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  }

  const shortPath = (value) => String(value || '').split('/').slice(-2).join('/');

  function matches(entry) {
    if (!state.filter) return true;
    const needle = state.filter.toLowerCase();
    return [entry.label, entry.title, entry.cwd, entry.branch, entry.sessionId]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().indexOf(needle) >= 0);
  }

  /** A handful of rows shaped like past conversations, shimmering while the
   * real ones are still on their way over the socket. */
  function skeleton() {
    const card = el('div', 'rows-card skeleton');
    screen.appendChild(card);
    for (let i = 0; i < 6; i++) {
      const row = el('div', 'hrow hrow-skeleton');
      const top = el('div', 'hrow-top');
      top.appendChild(el('span', 'hrow-name skeleton-chip'));
      top.appendChild(el('span', 'hrow-when skeleton-chip'));
      row.appendChild(top);
      const feet = el('div', 'hrow-feet');
      feet.appendChild(el('span', 'hrow-where skeleton-chip'));
      row.appendChild(feet);
      card.appendChild(row);
    }
  }

  function draw() {
    // The pull-to-refresh spinner lives in this same element, so a redraw
    // keeps it rather than clearing it out along with everything else.
    const spinner = screen.querySelector(':scope > .pull-spinner');
    screen.textContent = '';
    if (spinner) screen.appendChild(spinner);

    if (state.entries === null) {
      if (state.trouble) screen.appendChild(el('p', 'lede', state.trouble));
      else skeleton();
      return;
    }
    if (state.trouble) {
      screen.appendChild(el('p', 'lede', state.trouble));
      return;
    }

    if (state.refused) screen.appendChild(el('p', 'lede hrow-refused', state.refused));

    const shown = state.entries.filter(matches).slice(0, state.limit);
    if (!shown.length) {
      screen.appendChild(el('p', 'lede', state.filter
        ? 'Nothing here matches “' + state.filter + '”.'
        : 'This machine has no past conversations yet.'));
      return;
    }

    let day = null;
    let card = null;
    for (const entry of shown) {
      const which = dayOf(entry.modified);
      if (which !== day) {
        day = which;
        const head = el('div', 'rows-head');
        head.appendChild(el('span', 'rows-head-name', day));
        screen.appendChild(head);
        card = el('div', 'rows-card');
        screen.appendChild(card);
      }

      const row = el('button', 'hrow' + (state.opening === entry.sessionId ? ' busy' : ''));
      row.type = 'button';
      row.addEventListener('click', () => open(entry));
      const top = el('div', 'hrow-top');
      top.appendChild(el('span', 'hrow-name', entry.label || entry.sessionId));
      top.appendChild(el('span', 'hrow-when', ago(entry.modified)));
      row.appendChild(top);

      // The name is made out of the opening prompt, so on most conversations
      // the title is the same sentence again with more of it. Showing both is
      // showing one thing twice; showing neither loses the only description
      // there is. So the title appears when it says something the name did not.
      const name = String(entry.label || '').replace(/[.…]+$/, '').trim().toLowerCase();
      const title = String(entry.title || '').trim();
      const repeats = name && title.toLowerCase().indexOf(name) === 0;
      if (title && !repeats) row.appendChild(el('p', 'hrow-title', title));
      else if (title && title.length > name.length + 12) {
        // The same sentence, but there is more of it than the name showed.
        row.appendChild(el('p', 'hrow-title', title));
      }

      const feet = el('div', 'hrow-feet');
      if (entry.cwd) feet.appendChild(el('span', 'hrow-where', shortPath(entry.cwd)));
      if (entry.branch) feet.appendChild(el('span', 'hrow-branch', entry.branch));
      if (feet.childNodes.length) row.appendChild(feet);

      card.appendChild(row);
    }

    if (state.entries.filter(matches).length > shown.length) {
      const more = el('button', 'more', 'Show more');
      more.addEventListener('click', () => { state.limit += 60; draw(); });
      screen.appendChild(more);
    }
  }

  // ---- opening one -----------------------------------------------------------

  let seq = 0;
  /** Ask the laptop to bring it back, then go to it. The laptop looks the
   * conversation up in its own history, so only the id goes over. */
  function open(entry) {
    if (state.opening || !entry.sessionId) return;
    state.opening = entry.sessionId;
    state.refused = null;
    state.asked = 'r' + (++seq) + '-' + Date.now().toString(36);
    transport.postMessage({ type: 'instance:resume', id: state.asked, sessionId: entry.sessionId });
    draw();
  }

  // ---- where it comes from ---------------------------------------------------

  window.NIKUI_REMOTE = app.remote(null);
  const transport = window.nikTransport();

  const requestHistory = () => transport.postMessage({ type: 'history', limit: 200 });

  // A pull at the top of the list asks the laptop again. Given a moment
  // before it lets go, so a reply that is already in flight still reads as
  // the refresh that just happened rather than one that was already done.
  if (window.NikPull) {
    window.NikPull.attach(screen, () => new Promise((resolve) => {
      requestHistory();
      setTimeout(resolve, 500);
    }));
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === '@welcome' || message.type === '@device') {
      state.connected = true;
      requestHistory();
      return;
    }
    if ((message.type === 'instance:created' || message.type === '@refused') && message.id && message.id === state.asked) {
      state.opening = null;
      state.asked = null;
      if (message.type === 'instance:created') {
        window.location.href = (window.NIKUI_REMOTE.conversation || 'conversation.html?session=') + encodeURIComponent(message.instance);
        return;
      }
      state.refused = message.reason || 'That did not open.';
      draw();
      window.scrollTo(0, 0);
      return;
    }
    if (message.type !== 'history') return;
    if (!message.available) {
      state.trouble = 'This laptop is too old to send its history.';
      state.entries = [];
    } else {
      state.entries = message.entries || [];
      state.trouble = message.trouble
        ? 'The history could not be read on the laptop.'
        : null;
    }
    draw();
  });

  // Nothing arrives until the socket is seated, and if it never is, say so
  // rather than showing "Looking…" for ever.
  // As on the status screen: a laptop that answered the handshake and then said
  // nothing is a laptop running an older client, not an unreachable one.
  setTimeout(() => {
    if (state.entries !== null) return;
    state.trouble = state.connected
      ? 'Your laptop is connected but did not send its history. It is running an older NikUI — reload its VS Code window.'
      : 'Cannot reach the laptop.';
    draw();
  }, 8000);

  search.addEventListener('input', () => {
    state.filter = search.value.trim();
    state.limit = 60;
    draw();
  });

  const back = $('back');
  if (back) back.addEventListener('click', () => {
    if (window.history.length > 1) window.history.back();
    else window.location.replace('index.html');
  });

  draw();
})();
