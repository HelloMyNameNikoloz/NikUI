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
  const state = { report: null, trouble: null, section: null };

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
    screen.innerHTML = sheet.renderSheet(state.report, state.section);

    for (const button of screen.querySelectorAll('[data-section]')) {
      button.addEventListener('click', () => {
        state.section = button.dataset.section;
        draw();
        const now = screen.querySelector('[data-section="' + state.section + '"]');
        if (now && now.scrollIntoView) now.scrollIntoView({ inline: 'center', block: 'nearest' });
      });
    }

    // Two of the sheet's own buttons mean something here and two do not: there
    // is no sheet to close, and the CLI is not this phone's to talk to.
    const close = screen.querySelector('[data-act="close"]');
    if (close) close.remove();
    const cli = screen.querySelector('[data-act="cli"]');
    if (cli) cli.remove();

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

  // ---- where it comes from ---------------------------------------------------

  window.NIKUI_REMOTE = app.remote(null);
  const transport = window.nikTransport();
  let asking = null;

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === '@welcome' || message.type === '@device') {
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

  setTimeout(() => {
    if (!state.report && !state.trouble) { state.trouble = 'Cannot reach the laptop.'; draw(); }
  }, 15000);

  draw();
})();
