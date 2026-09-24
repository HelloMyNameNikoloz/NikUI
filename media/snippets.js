/* Prompt snippets: a word like /table that adds a standing instruction to the
   prompt you just typed. The command never reaches the CLI — what reaches it is
   your text with the instruction appended — so this is only ever string work,
   and lives on its own to be checked without a browser. */
(function (root) {
  'use strict';

  // A snippet is invoked at the start or the end of the prompt, on its own:
  // "/table fix the rollback" and "fix the rollback /table" both read naturally,
  // and people type both. As many as you like at either end.
  const TOKEN = /^\/([a-z][\w-]*)$/i;

  const nameOf = (word) => {
    const m = TOKEN.exec(String(word || ''));
    return m ? m[1].toLowerCase() : null;
  };

  /** Snippet names, lower-cased, ignoring any whose text has been emptied. */
  function names(snippets) {
    return Object.keys(snippets || {})
      .filter((k) => String(snippets[k] || '').trim())
      .map((k) => k.toLowerCase());
  }

  /**
   * Take the typed prompt apart: what the panel should show, what the CLI
   * should receive, and which snippets were used.
   *
   * Nothing matches → the text is handed back untouched, so this is safe to run
   * over every prompt.
   */
  function expand(text, snippets) {
    const raw = String(text == null ? '' : text).trim();
    const table = {};
    for (const key of Object.keys(snippets || {})) {
      const body = String(snippets[key] || '').trim();
      if (body) table[key.toLowerCase()] = body;
    }

    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length) return { text: raw, sent: raw, used: [] };

    const known = (word) => {
      const name = nameOf(word);
      return name && table[name] ? name : null;
    };

    // A run, not a single word: "fix the refund path /decisions /table" names
    // both, and both apply. They stack because the instructions do — one says
    // how to answer, another what to include — and stopping at one would mean
    // choosing between them for no reason anybody could see.
    const lead = [];
    while (words.length && known(words[0])) lead.push(known(words.shift()));
    const tail = [];
    while (words.length && known(words[words.length - 1])) tail.unshift(known(words.pop()));

    // In the order they were written, which is the order they are read in.
    // Naming the same one twice still only adds its instruction once.
    const used = [];
    for (const name of lead.concat(tail)) if (used.indexOf(name) < 0) used.push(name);
    if (!used.length) return { text: raw, sent: raw, used: [] };

    const rest = words.join(' ').trim();
    const bodies = used.map((name) => table[name]);
    return {
      text: rest,                                   // what you typed, minus the word
      sent: [rest].concat(bodies).filter(Boolean).join('\n\n'),
      used
    };
  }

  const api = { expand, names, nameOf };
  root.snippets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
