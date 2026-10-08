/* What /status shows, on the phone.

   Not a summary of it and not a second opinion about it: the laptop builds the
   same report with the same `buildReport`, and this draws it with the same
   `media/status.js` the editor's panel uses. A screen that says almost what
   another screen says is two screens to keep in step.

   The one thing this does not do is redraw. The report arrives every five
   seconds and the renderer hands back the whole sheet as a string, so the
   obvious thing — put it in `innerHTML` — rebuilds every node on the screen
   twelve times a minute. That reads as the screen flashing, loses where you had
   scrolled to, and folds back up any table you had opened. So what comes back is
   compared against what is already there, and only the parts that actually say
   something different are replaced. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = window.NikApp;
  const where = app.requireLaptop();
  if (!where) return;

  const screen = $('screen');
  const state = { report: null, trouble: null, section: null, connected: false };

  // Tables the reader has opened in full, by section and position. Kept out
  // here because a table is replaced whenever its numbers move, and a list that
  // folded itself back up every five seconds would be unusable.
  const opened = new Set();
  let copiedUntil = 0;
  let copiedSaid = '';

  // ---- drawing ---------------------------------------------------------------

  /**
   * The sheet, before the laptop has said anything: three tiles and two cards
   * shaped like the ones that are about to replace them, shimmering rather
   * than a bare "Looking…" — which told you something was expected without
   * any idea what.
   */
  function skeleton() {
    const wrap = document.createElement('div');
    wrap.className = 'skeleton-status';
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    for (let i = 0; i < 3; i++) {
      const tile = document.createElement('div');
      tile.className = 'tile skeleton';
      const value = document.createElement('div');
      value.className = 'tile-value skeleton-chip';
      const label = document.createElement('div');
      label.className = 'tile-label skeleton-chip';
      tile.append(value, label);
      tiles.appendChild(tile);
    }
    wrap.appendChild(tiles);
    for (let i = 0; i < 2; i++) {
      const card = document.createElement('div');
      card.className = 'card skeleton';
      const heading = document.createElement('div');
      heading.className = 'skeleton-chip skeleton-line';
      const body = document.createElement('div');
      body.className = 'skeleton-chip skeleton-block';
      card.append(heading, body);
      wrap.appendChild(card);
    }
    withSpinnerKept(() => screen.replaceChildren(wrap));
  }

  /**
   * Do `fn`, which is free to clear or replace `screen` wholesale, without
   * losing the pull-to-refresh spinner that lives at its top: lifted out
   * before and put back after, rather than taught to every place that redraws
   * this screen.
   */
  function withSpinnerKept(fn) {
    const spinner = screen.querySelector(':scope > .pull-spinner');
    if (spinner) spinner.remove();
    fn();
    if (spinner) screen.insertBefore(spinner, screen.firstChild);
  }

  function draw() {
    if (!state.report) {
      if (state.trouble) {
        const said = document.createElement('p');
        said.className = 'lede';
        said.textContent = state.trouble;
        withSpinnerKept(() => screen.replaceChildren(said));
      } else {
        skeleton();
      }
      return;
    }

    const sheet = window.statusSheet;
    const sections = sheet.SECTIONS || [];
    if (!state.section && sections.length) state.section = sections[0].id;

    // The panel's own markup, whole. It already contains its rail and its body;
    // wrapping it in a second set of those was drawing the sheet twice.
    // `compact` is what makes it a phone screen rather than a panel squeezed
    // into one: same report, same sections, a head that fits.
    paint(sheet.renderSheet(state.report, state.section, { compact: true }));
    capLongTables();

    // A button that said "Copied" gets a moment to be read before the next
    // report puts its own label back.
    if (Date.now() < copiedUntil) {
      const copy = screen.querySelector('[data-act="copy"]');
      if (copy) copy.textContent = copiedSaid;
    }
  }

  function paint(html) {
    const next = document.createElement('div');
    next.innerHTML = html;
    withSpinnerKept(() => {
      if (!screen.firstElementChild) {
        screen.replaceChildren.apply(screen, Array.prototype.slice.call(next.childNodes));
        return;
      }
      morph(screen, next);
    });
  }

  /**
   * Make `live` say what `next` says, touching as little as possible.
   *
   * Walks the two trees together. A node whose markup already matches is left
   * alone — with whatever the reader has done to it and wherever the browser has
   * scrolled it — and a node that differs is descended into rather than
   * replaced, so a card whose one number moved does not take the other nine
   * cards down with it. Only leaves and mismatched shapes are really swapped.
   *
   * Nothing is re-wired afterwards because there is nothing to re-wire: every
   * tap on this screen is handled by one listener on the screen itself, which is
   * the only arrangement that survives its own children being replaced
   * underneath it.
   */
  function morph(live, next) {
    // Snapshots, not the live collections. Moving a node out of `next` into
    // `live` takes it out of `next.children` as it goes, so every index after
    // it shifts by one and the walk reads past the end — which throws, halfway
    // through, leaving the screen holding half of one report and half of
    // another.
    const here = Array.prototype.slice.call(live.children);
    const there = Array.prototype.slice.call(next.children);
    if (here.length !== there.length) {
      live.replaceChildren.apply(live, Array.prototype.slice.call(next.childNodes));
      return;
    }
    for (let i = 0; i < here.length; i++) {
      const a = here[i];
      const b = there[i];
      if (a.outerHTML === b.outerHTML) continue;
      if (a.tagName !== b.tagName || a.className !== b.className || !a.children.length) {
        a.replaceWith(b);
        continue;
      }
      morph(a, b);
      // Attributes can differ with no child differing at all: which section is
      // open is a class on a button whose words never change.
      for (const at of Array.prototype.slice.call(b.attributes)) {
        if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
      }
      for (const at of Array.prototype.slice.call(a.attributes)) {
        if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
      }
    }
  }

  /**
   * Long tables show their first few rows and offer the rest.
   *
   * A table cannot stay a table at this width, so each row becomes a stack of
   * labelled lines — which is readable, and roughly seven times taller. Recent
   * turns is fourteen rows: nineteen hundred points of scrolling, more than two
   * phone screens, for one card. Nobody reaches the end of that, and everything
   * under it might as well not be on the screen.
   *
   * So the rest is behind a tap. Nothing is dropped — the laptop's whole report
   * is here, and the button says exactly how much of it is folded away — but the
   * screen is a screen again. This lives here rather than in the shared renderer
   * because it is only true of a phone: on a panel the same table is six lines
   * tall and hiding half of it would be silly.
   */
  const SHOWN = 5;

  function capLongTables() {
    const tables = screen.querySelectorAll('.sheet-content table.grid');
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const rows = table.tBodies[0] ? Array.prototype.slice.call(table.tBodies[0].rows) : [];
      const key = state.section + ':' + i;
      const button = table.nextElementSibling &&
        table.nextElementSibling.classList.contains('show-all')
        ? table.nextElementSibling : null;

      if (rows.length <= SHOWN + 1 || opened.has(key)) {
        for (const row of rows) row.hidden = false;
        table.classList.remove('capped');
        if (button) button.remove();
        continue;
      }

      table.classList.add('capped');
      table.dataset.cap = key;
      rows.forEach((row, at) => { row.hidden = at >= SHOWN; });

      const said = 'Show all ' + rows.length;
      if (button) {
        if (button.textContent !== said) button.textContent = said;
        continue;
      }
      const more = document.createElement('button');
      more.className = 'show-all';
      more.type = 'button';
      more.textContent = said;
      more.setAttribute('aria-label', 'Show ' + (rows.length - SHOWN) + ' more of ' + rows.length);
      table.parentNode.insertBefore(more, table.nextSibling);
    }
  }

  /**
   * Bring a section's name to the middle of the strip.
   *
   * Done by hand rather than with `scrollIntoView`, which has no idea the bar
   * floats above the content: asked to make a name fully visible it scrolls the
   * *page* until the name clears the top of the viewport, which on iOS puts it —
   * and a hundred and sixty points of what was under it — beneath the bar. Only
   * the strip should move, and only sideways.
   */
  function centre(id) {
    const rail = screen.querySelector('.sheet-nav');
    const now = rail && rail.querySelector('[data-section="' + id + '"]');
    if (!rail || !now) return;
    const to = now.offsetLeft - (rail.clientWidth - now.offsetWidth) / 2;
    const most = rail.scrollWidth - rail.clientWidth;
    rail.scrollTo({ left: Math.max(0, Math.min(most, to)), behavior: 'smooth' });
  }

  // ---- one listener, because the nodes under it come and go -------------------

  screen.addEventListener('click', (event) => {
    const section = event.target.closest('[data-section]');
    if (section) {
      state.section = section.dataset.section;
      draw();
      // A different section starts at its own beginning, not wherever the last
      // one had been scrolled to.
      screen.scrollTop = 0;
      centre(state.section);
      return;
    }

    const more = event.target.closest('.show-all');
    if (more) {
      const table = more.previousElementSibling;
      if (table && table.dataset.cap) opened.add(table.dataset.cap);
      capLongTables();
      return;
    }

    // Neither of the sheet's other two buttons is drawn in compact: there is no
    // sheet to close and the CLI is not this phone's to talk to.
    const act = event.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'refresh') return ask();
    if (act.dataset.act !== 'copy') return;

    const sheet = window.statusSheet;
    const text = sheet.asText ? sheet.asText(state.report) : '';
    const plugins = app.native();
    const done = plugins && plugins.Clipboard
      ? plugins.Clipboard.write({ string: text })
      : navigator.clipboard.writeText(text);
    const say = (word) => {
      copiedSaid = word;
      copiedUntil = Date.now() + 2500;
      act.textContent = word;
    };
    Promise.resolve(done).then(() => say('Copied')).catch(() => say('Could not copy'));
  });

  // ---- where it comes from ---------------------------------------------------

  window.NIKUI_REMOTE = app.remote(null);
  const transport = window.nikTransport();
  let asking = null;

  const ask = () => transport.postMessage({ type: 'status' });

  // A pull at the top of the sheet asks again, the same question the refresh
  // button already does. The spinner is given a moment to be seen even when
  // the answer comes back at once — a refresh that is over before the finger
  // has lifted does not read as having happened.
  if (window.NikPull) {
    window.NikPull.attach(screen, () => new Promise((resolve) => {
      ask();
      setTimeout(resolve, 500);
    }));
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === '@welcome' || message.type === '@device') {
      state.connected = true;
      ask();
      // Numbers that stop moving are numbers nobody trusts — but a screen
      // nobody is looking at does not need them.
      if (!asking) asking = setInterval(() => { if (!document.hidden) ask(); }, 5000);
      return;
    }
    if (message.type !== 'status') return;
    if (!message.available) {
      state.trouble = 'This laptop is too old to send its status.';
    } else if (!message.report) {
      state.trouble = message.trouble
        ? 'The status could not be built on the laptop.'
        : 'Nothing is open in the editor yet.';
    } else {
      state.report = message.report;
      state.trouble = null;
    }
    draw();
  });

  // Coming back to the app should not mean waiting five seconds to find out
  // what happened while it was away.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.connected) ask();
  });

  // Two different silences, and telling them apart is the whole difference
  // between looking at your network and reloading a window. A laptop that never
  // answered anything cannot be reached; one that answered the handshake and
  // then ignored this is running a client that does not know the question.
  setTimeout(() => {
    if (state.report || state.trouble) return;
    state.trouble = state.connected
      ? 'Your laptop is connected but did not send its status. It is running an older NikUI — reload its VS Code window.'
      : 'Cannot reach the laptop.';
    draw();
  }, 8000);

  draw();
})();
