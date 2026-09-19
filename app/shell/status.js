/* What /status shows, on the phone.

   Not a summary of it and not a second opinion about it: the laptop builds the
   same report with the same `buildReport`, and this draws it with the same
   `media/status.js` the editor's panel uses. A screen that says almost what
   another screen says is two screens to keep in step. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = window.NikApp;
  const where = app.requireLaptop();
  if (!where) return;

  const screen = $('screen');
  const state = { report: null, trouble: null, section: null, connected: false };

  function draw() {
    if (!state.report) {
      screen.innerHTML = '';
      const said = document.createElement('p');
      said.className = 'lede';
      said.textContent = state.trouble || 'Looking…';
      screen.appendChild(said);
      return;
    }

    const sheet = window.statusSheet;
    const sections = sheet.SECTIONS || [];
    if (!state.section && sections.length) state.section = sections[0].id;

    // The panel's own markup, whole. It already contains its rail and its body;
    // wrapping it in a second set of those was drawing the sheet twice.
    // `compact` is what makes it a phone screen rather than a panel squeezed
    // into one: same report, same sections, a head that fits.
    screen.innerHTML = sheet.renderSheet(state.report, state.section, { compact: true });

    for (const button of screen.querySelectorAll('[data-section]')) {
      button.addEventListener('click', () => {
        state.section = button.dataset.section;
        draw();
        const now = screen.querySelector('[data-section="' + state.section + '"]');
        if (now && now.scrollIntoView) now.scrollIntoView({ inline: 'center', block: 'nearest' });
      });
    }

    // Neither of the sheet's other two buttons is drawn in compact: there is no
    // sheet to close and the CLI is not this phone's to talk to.
    capLongTables();

    const refresh = screen.querySelector('[data-act="refresh"]');
    if (refresh) refresh.addEventListener('click', () => transport.postMessage({ type: 'status' }));

    const copy = screen.querySelector('[data-act="copy"]');
    if (copy) copy.addEventListener('click', () => {
      const text = sheet.asText ? sheet.asText(state.report) : '';
      const plugins = app.native();
      const done = plugins && plugins.Clipboard
        ? plugins.Clipboard.write({ string: text })
        : navigator.clipboard.writeText(text);
      Promise.resolve(done).then(() => { copy.textContent = 'Copied'; })
        .catch(() => { copy.textContent = 'Could not copy'; });
    });
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
    for (const table of screen.querySelectorAll('table.grid')) {
      const rows = table.tBodies[0] ? [...table.tBodies[0].rows] : [];
      if (rows.length <= SHOWN + 1) continue;

      const hidden = rows.length - SHOWN;
      table.classList.add('capped');
      rows.forEach((row, i) => { if (i >= SHOWN) row.hidden = true; });

      const more = document.createElement('button');
      more.className = 'show-all';
      more.type = 'button';
      more.textContent = 'Show all ' + rows.length;
      more.addEventListener('click', () => {
        rows.forEach((row) => { row.hidden = false; });
        table.classList.remove('capped');
        more.remove();
      });
      more.setAttribute('aria-label', 'Show ' + hidden + ' more of ' + rows.length);
      table.parentNode.insertBefore(more, table.nextSibling);
    }
  }

  // ---- where it comes from ---------------------------------------------------

  window.NIKUI_REMOTE = app.remote(null);
  const transport = window.nikTransport();
  let asking = null;

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === '@welcome' || message.type === '@device') {
      state.connected = true;
      transport.postMessage({ type: 'status' });
      // Numbers that stop moving are numbers nobody trusts.
      if (!asking) asking = setInterval(() => transport.postMessage({ type: 'status' }), 5000);
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
