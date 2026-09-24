/* What a slash in the composer offers, and what picking one writes.

   Two lists, in one box. A slash that starts the prompt offers commands: the
   CLI's, NikUI's own, and your snippets. A slash anywhere else offers only
   snippets, because that is the only kind of word that reads as an addition to
   a sentence — "/model" in the middle of a prompt is not a command, it is text.

   Picking a command that takes values leaves the palette open on its values, so
   the whole of "/model claude-opus-5-5" is arrow keys.

   String work only, no DOM: the part worth checking is which words are offered
   and what ends up in the box, and that can be checked without a browser. */
(function (root) {
  'use strict';

  // A slash that starts a word. Anchored so a URL's "https://host" and a path's
  // "src/a" never open the palette.
  const COMMAND = /(?:^|\s)\/([\w:.-]*)$/;

  // "/model claude-op" — the command is settled, so what is being typed is its
  // value. Start-anchored on purpose: a command that takes values is the whole
  // prompt, never a suffix, and matching one mid-sentence would offer values for
  // a word somebody wrote.
  const VALUE = /^\/([\w:.-]+)[ \t]+([^\s]*)$/;

  /** A value may be a bare string or a described one; both end up as the latter. */
  function option(v) {
    if (v && typeof v === 'object') {
      return { value: String(v.value), label: v.label || '', detail: v.detail || '' };
    }
    return { value: String(v), label: '', detail: '' };
  }

  /** Your snippets, lower-cased, ignoring any whose text has been emptied. */
  function snippetNames(snippets) {
    return Object.keys(snippets || {})
      .filter((k) => String(snippets[k] || '').trim())
      .map((k) => k.toLowerCase());
  }

  /**
   * Best match first: what starts with what you typed, then what merely
   * contains it. Typing "opus" has to find "claude-opus-5-5", and typing
   * "claude" has to keep the catalog in the order it arrived.
   */
  function matching(rows, query, text) {
    if (!query) return rows;
    const q = query.toLowerCase();
    const starts = [];
    const holds = [];
    for (const row of rows) {
      const hay = text(row).map((s) => String(s || '').toLowerCase());
      if (hay.some((s) => s.startsWith(q))) starts.push(row);
      else if (hay.some((s) => s.includes(q))) holds.push(row);
    }
    return starts.concat(holds);
  }

  /**
   * What the palette should show for the text in the box, or null for nothing.
   *
   * @param {string} value                 the composer's contents
   * @param {object} sources
   * @param {string[]} sources.commands    every command this instance knows
   * @param {object}  sources.args         command name -> its values
   * @param {string[]} sources.own         the ones NikUI answers itself
   * @param {object}  sources.snippets     name -> standing instruction
   * @param {object}  [sources.now]        command name -> the value in force
   */
  function plan(value, sources) {
    const s = sources || {};
    const text = String(value == null ? '' : value);
    const snippets = snippetNames(s.snippets);

    const typed = COMMAND.exec(text);
    if (typed) {
      const query = typed[1];
      const before = text.slice(0, text.length - (query.length + 1));
      // A slash that opens the prompt can be anything; one further in is an
      // addition to what has already been written, and only a snippet is that.
      const head = !before.trim();
      const names = head ? (s.commands || []) : (s.commands || []).filter((c) => snippets.includes(c.toLowerCase()));
      const rows = names.map((name) => {
        const parts = String(name).split(':');
        const snippet = snippets.includes(String(name).toLowerCase());
        return {
          value: name,
          label: parts[parts.length - 1],
          note: parts.length > 1 ? parts[0] : ((s.own || []).includes(name) ? 'NikUI' : ''),
          kind: snippet ? 'snippet' : 'command'
        };
      });
      return {
        mode: 'cmd',
        head,
        cmd: '',
        prefix: before,
        query,
        matches: matching(rows, query, (r) => [r.label, r.value]).slice(0, 40),
        hint: head ? 'Commands' : 'Add to this prompt',
        keys: head ? 'Tab or Enter selects' : 'Enter adds · type / again for another'
      };
    }

    const started = VALUE.exec(text);
    const values = started ? (s.args || {})[started[1]] : null;
    if (!started || !values || !values.length) return null;

    const cmd = started[1];
    const query = started[2];
    const current = ((s.now || {})[cmd] || '').toLowerCase();
    const rows = values.map(option).map((v) => {
      const label = v.label || v.value;
      const note = [v.label && v.label !== v.value ? v.value : '', v.detail,
        v.value.toLowerCase() === current ? 'current' : ''].filter(Boolean).join(' · ');
      return { value: v.value, label, note, kind: 'value' };
    });
    return {
      mode: 'value',
      head: true,
      cmd,
      prefix: '',
      query,
      matches: matching(rows, query, (r) => [r.value, r.label]),
      hint: '/' + cmd,
      keys: 'Tab fills · Enter runs'
    };
  }

  /**
   * The box's new contents once a row is taken.
   *
   * `more` says the palette should stay open: the command that was just picked
   * takes values, and they are the next thing to choose.
   */
  function apply(current, at, sources) {
    if (!current || !current.matches.length) return null;
    const picked = current.matches[Math.max(0, Math.min(at, current.matches.length - 1))];
    if (current.mode === 'value') {
      return { value: '/' + current.cmd + ' ' + picked.value, more: false, picked };
    }
    const args = (sources || {}).args || {};
    return {
      // The trailing space is what lets the next thing be typed straight away —
      // including another slash, which is how two snippets end up on one prompt.
      value: current.prefix + '/' + picked.value + ' ',
      more: current.head && !!(args[picked.value] && args[picked.value].length),
      picked
    };
  }

  const api = { plan, apply, option, snippetNames, COMMAND, VALUE };
  root.palette = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
