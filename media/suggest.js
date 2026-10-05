/* Reply suggestions: the answers a finished turn is plainly waiting for.

   "Tell me once it's pushed" is answered "pushed" every time, so it is offered
   as a button under the turn. Read off the end of the last reply, by rules
   rather than a model — it costs nothing, and offering nothing is always
   better than offering something odd. */
(function (root) {
  'use strict';

  const MAX = 3;

  // Something only you can do, and the word that says you did it.
  const DID = {
    push: 'pushed', merge: 'merged', reload: 'reloaded', restart: 'restarted', deploy: 'deployed',
    install: 'installed', run: 'ran it', approve: 'approved', review: 'reviewed', update: 'updated',
    commit: 'committed', rebase: 'rebased', publish: 'published', release: 'released', upload: 'uploaded',
    login: 'logged in', 'log in': 'logged in', 'sign in': 'signed in', test: 'tested', try: 'tried it',
    check: 'checked', fix: 'fixed', add: 'added', set: 'set', save: 'saved', connect: 'connected'
  };
  const PAST = new Set(Object.values(DID).concat(['done', 'ready', 'finished', 'in', 'up', 'back', 'live', 'green']));

  /** The last few sentences, as prose: no code, no markdown marks. */
  function tail(text) {
    const prose = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/[*_#>]/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    return prose.slice(-900);
  }

  /** "the signed release, the automatic workflow, or just the debug APK" -> three. */
  function options(question) {
    const m = /\b(?:do you want|would you like|would you prefer|do you prefer|should i do|which(?: one)?(?: do you want)?|prefer)\b(?: me to)?\s+([^?]+)\?/i.exec(question);
    if (!m) return null;
    let body = m[1].replace(/\s+(?:for now|first|here|instead)\s*$/i, '');
    if (!/\bor\b/i.test(body)) return null;
    const parts = body.split(/\s*,\s*(?:or\s+)?|\s+or\s+/i)
      .map((p) => p.replace(/^(?:just|only|maybe)\s+/i, '').replace(/[.,;:]+$/, '').trim())
      .filter(Boolean);
    if (parts.length < 2 || parts.length > MAX) return null;
    if (parts.some((p) => p.length > 60 || p.split(/\s+/).length > 9)) return null;
    return parts;
  }

  /**
   * What you would most likely type back, shortest first.
   *
   * @param {string} text  the last reply
   * @returns {string[]}   at most three; empty when nothing is obvious
   */
  function replies(text) {
    const end = tail(text);
    if (!end.trim()) return [];
    const out = [];
    const add = (s) => { if (s && !out.includes(s) && out.length < MAX) out.push(s); };

    // Waiting on you: "tell me once it's pushed", "let me know when you've merged it",
    // "after you push", "once you've reloaded".
    const told = /\b(?:tell|let) me(?: know)? (?:once|when|after|as soon as) (?:it(?:'s| is| has been| was)|you(?:'ve| have)?|they(?:'re| are| have been)|that(?:'s| is)) ?(?:been )?([a-z]+(?: in| up)?)/i.exec(end);
    if (told) {
      const w = told[1].toLowerCase();
      if (PAST.has(w)) add(w);
      else if (DID[w]) add(DID[w]);
    }
    const after = /\b(?:after|once|when) you(?:'ve| have)? (push|merge|reload|restart|deploy|install|approve|commit|rebase|publish|release|upload|log in|sign in|pushed|merged|reloaded|restarted|deployed|installed|approved)\b/i.exec(end);
    if (after) {
      const w = after[1].toLowerCase();
      add(DID[w] || w);
    }
    if (/\breload (?:the |your )?(?:vs ?code )?window\b/i.test(end)) add('reloaded');

    // The last question asked, if the reply ends on one.
    // A sentence ends at punctuation and a space, so "v0.2.10" stays whole.
    const sentences = end.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
    const last = sentences.slice(-2).reverse().find((x) => x.endsWith('?')) || '';
    if (last) {
      const picks = options(last);
      if (picks) picks.forEach(add);
      else if (/^(?:shall|should|can|may) i\b|^(?:do you )?want me to\b|^(?:would|do) you (?:like|want) me to\b|^ok(?:ay)? (?:to|if)\b|^is (?:that|this) (?:ok|okay|fine|right)\b|^go ahead\b|^ready\b/i.test(last)) {
        add('yes');
        add('no');
      }
    }
    if (/\b(?:your go-ahead|go-ahead|say the word|say go)\b/i.test(end)) add('go ahead');
    return out;
  }

  const api = { replies };
  root.replySuggest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
