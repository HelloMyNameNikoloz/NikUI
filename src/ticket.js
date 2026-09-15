'use strict';

// Pull a PR/issue number out of a prompt so instances name themselves.
// Mirrors the rules we settled on: URLs win, then #N, then "PR N" / "issue N".
const PATTERNS = [
  /(?:pull|issues)\/(\d{1,7})/i,
  /#(\d{2,7})\b/,
  /\b(?:PR|MR|issue)[\s-]?#?(\d{2,7})\b/i
];

// A number mentioned in a read-only request must not steal a tab that is
// already working a different ticket.
const READ_ONLY = /(analy[sz]|განალიზ|explain|summari[sz]|compare|look at|take a look|what do you think|thoughts on|opinion|just read|read through)/i;

function findTicket(text) {
  if (!text) return null;
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

// current === null means the instance has no ticket yet, so anything sticks.
function nextTicket(current, prompt) {
  const found = findTicket(prompt);
  if (!found || found === current) return current;
  if (current && READ_ONLY.test(prompt)) return current;
  return found;
}

module.exports = { findTicket, nextTicket };
