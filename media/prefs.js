/* The /settings sheet: the settings people change, as switches and choices.

   What is in the list, what each row says, and what a change may be are all
   decided on the laptop (src/prefs.js); this only draws what it is sent. Every
   control carries the id of its row and nothing else, so the page cannot ask
   for a setting the list does not have, and the list cannot drift from the
   page: a row added there is a row drawn here. */
(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const icon = (name, size) => (root.icon ? root.icon(name, size) : '');

  function control(row, locked) {
    const off = locked || row.unavailable ? ' disabled' : '';
    const named = ' aria-labelledby="pref-' + esc(row.id) + '"';
    if (row.kind === 'toggle') {
      return '<button type="button" class="switch" role="switch" aria-checked="' + (row.value ? 'true' : 'false') +
        '" data-toggle="' + esc(row.id) + '"' + named + off + '><span class="knob"></span></button>';
    }
    if (row.kind === 'choice' || row.kind === 'model') {
      const options = (row.choices || []).map((c) =>
        '<option value="' + esc(c.value) + '"' + (c.value === row.value ? ' selected' : '') + '>' +
        esc(c.label) + '</option>').join('');
      return '<select data-choose="' + esc(row.id) + '"' + named + off + '>' + options + '</select>';
    }
    if (row.kind === 'number') {
      const at = Number(row.value);
      return '<div class="stepper" role="group"' + named + '>' +
        '<button type="button" data-step="' + esc(row.id) + '" data-by="-1" aria-label="Smaller"' +
          (locked || at <= row.min ? ' disabled' : '') + '>−</button>' +
        '<output>' + esc(at) + '</output>' +
        '<button type="button" data-step="' + esc(row.id) + '" data-by="1" aria-label="Larger"' +
          (locked || at >= row.max ? ' disabled' : '') + '>+</button>' +
        '</div>';
    }
    return '';
  }

  function rowHtml(row, locked) {
    const said = row.unavailable || row.hint;
    return '<div class="pref' + (row.unavailable ? ' unavailable' : '') + (row.warn ? ' warn' : '') +
      '" data-pref="' + esc(row.id) + '">' +
      '<div class="pref-text">' +
      '<span class="pref-label" id="pref-' + esc(row.id) + '">' + esc(row.label) + '</span>' +
      (said ? '<span class="pref-hint">' + esc(said) + '</span>' : '') +
      (row.note ? '<span class="pref-note">' + esc(row.note) + '</span>' : '') +
      '</div>' +
      '<div class="pref-control">' + control(row, locked) + '</div>' +
      '</div>';
  }

  /** The way to /commands, as one more row: it is a setting too, only a long one. */
  function commandsRow() {
    return '<section class="card prefs-group"><h3>Commands</h3><div class="prefs-list">' +
      '<div class="pref" data-pref="commands"><div class="pref-text">' +
      '<span class="pref-label" id="pref-commands">Commands and prompt snippets</span>' +
      '<span class="pref-hint">/watch, /delegate and the rest: what each one does and sends. ' +
      'Change them, or add your own.</span></div>' +
      '<div class="pref-control"><button type="button" class="ghost" data-act="commands" ' +
      'aria-describedby="pref-commands">Open' + icon('chevron', 13) + '</button></div></div>' +
      '</div></section>';
  }

  /**
   * @param {object} message  what the laptop sent: `settings`, `mayChange`,
   *                          `local`, and — after a refused change — `refused`
   */
  function render(message) {
    const m = message || {};
    const s = m.settings;
    const locked = m.mayChange === false;

    const head = '<div class="sheet-head prefs-head">' +
      '<div class="sheet-title">' + icon('settings', 15) + '<b>Settings</b>' +
      '<span class="dim">For every instance</span></div>' +
      '<div class="sheet-actions">' +
      '<button class="icon-only" data-act="close" title="Close" aria-label="Close">' + icon('x', 15) + '</button>' +
      '</div></div>';

    let body;
    if (!s) {
      body = '<p class="prefs-lede">This window does not offer its settings here.</p>';
    } else {
      body = (m.refused ? '<p class="prefs-refused" role="alert">' + esc(m.refused) + '</p>' : '') +
        (locked ? '<p class="prefs-lede">This device can watch but not change settings. ' +
          'Grant it control in the editor.</p>' : '') +
        (s.groups || []).map((name) => {
          const rows = (s.rows || []).filter((r) => r.group === name);
          if (!rows.length) return '';
          return '<section class="card prefs-group"><h3>' + esc(name) + '</h3>' +
            '<div class="prefs-list">' + rows.map((r) => rowHtml(r, locked)).join('') + '</div></section>';
        }).join('') + commandsRow();
    }

    const foot = '<div class="sheet-foot prefs-foot">' +
      (m.local ? '<button class="ghost" data-act="all-settings">All settings…</button>' : '') +
      '<span>' + (m.local ? 'Everything else is in NikUI: Settings · Esc to close'
        : 'Everything else is in NikUI: Settings, on the laptop') + '</span></div>';

    return '<h2 class="sr-only" id="sheet-title">Settings</h2>' + head +
      '<div class="prefs" tabindex="0">' + body + '</div>' + foot;
  }

  /** What a row holds now, read back out of the sheet's own message. */
  function valueOf(message, id) {
    const rows = (message && message.settings && message.settings.rows) || [];
    const row = rows.find((r) => r.id === id);
    return row ? row : null;
  }

  const api = { render, valueOf };
  root.prefsSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
