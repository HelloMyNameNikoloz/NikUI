/* Stable occurrences in the loaded rendered transcript. No native authority. */
(function (root) {
  'use strict';
  function matches(query, rows) {
    if (!query || query.length > 300) return [];
    const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), found = [];
    for (const row of rows) {
      expression.lastIndex = 0;
      let match;
      while ((match = expression.exec(row.text))) {
        found.push({ id: row.id + ':' + match.index, itemID: row.id, start: match.index, end: match.index + match[0].length });
        if (found.length === 10000) return found;
      }
    }
    return found;
  }
  function select(found, previous, index, delta) {
    if (!found.length) return -1;
    const retained = found.findIndex((match) => match.id === previous);
    const start = retained < 0 ? Math.max(0, Math.min(index, found.length - 1)) : retained;
    return ((start + delta) % found.length + found.length) % found.length;
  }
  const api = { matches, select };
  if (typeof module !== 'undefined') module.exports = api;
  root.NikMacFind = api;
})(typeof window === 'undefined' ? globalThis : window);
