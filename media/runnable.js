/* Which code blocks are worth offering to run, and what to run from them.

   A guess, deliberately a shy one. Being wrong costs little in one direction —
   a button that should not have been there — and rather more in the other: a
   run button on a block of Python is a trap, and one on a diff is worse. So a
   block only qualifies if it says it is shell, or if it looks like nothing
   else.

   Shared between the laptop and the client rather than written twice, because
   two copies of a guess drift into two different guesses, and then the button
   is on a block the other end refuses. */
(function (root) {
  'use strict';

  const SHELLY = /^(sh|bash|zsh|fish|ksh|shell|console|terminal|command|commandline|cmd)$/i;

  // Things that mark a line as belonging to some other language, and so mark
  // the whole block as not a command.
  const NOT_A_COMMAND = /^(function|class|const|let|var|import|from|def|public|private|package|return|if|for|while|else|#include|using|<)\b/;

  function looksRunnable(lang, body) {
    const said = String(lang || '').trim().toLowerCase();
    if (said) return SHELLY.test(said);

    const lines = String(body || '').split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 12) return false;
    if (lines.some((line) => line.length > 400)) return false;

    return lines.every((line) => {
      const bare = line.replace(/^[$#>]\s+/, '');
      if (!bare) return false;
      if (NOT_A_COMMAND.test(bare)) return false;
      // A line ending in a brace or a semicolon is code being quoted, not a
      // command somebody types.
      if (/[{};]$/.test(bare)) return false;
      return /^[a-zA-Z0-9_./~-]+(\s|$)/.test(bare);
    });
  }

  /** The prompt characters people paste along with the command are not part of it. */
  function cleanCommand(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line.replace(/^\s*[$#]\s+/, ''))
      .join('\n')
      .trim();
  }

  root.looksRunnable = looksRunnable;
  root.cleanCommand = cleanCommand;
  if (typeof module !== 'undefined' && module.exports) module.exports = { looksRunnable, cleanCommand };
})(typeof window !== 'undefined' ? window : globalThis);
