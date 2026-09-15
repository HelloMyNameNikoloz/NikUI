'use strict';
const { icon, ICON_NAMES } = require('../media/icons.js');

// Walk an SVG path properly: relative commands are deltas, so comparing raw
// numbers against the viewBox reports nonsense. This tracks the pen instead.
function bounds(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let x = 0, y = 0, startX = 0, startY = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = () => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };

  let i = 0, cmd = null;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) { cmd = tokens[i++]; if (cmd === 'Z' || cmd === 'z') { x = startX; y = startY; see(); continue; } }
    const rel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();
    if (upper === 'M' || upper === 'L' || upper === 'T') {
      const nx = num(), ny = num();
      x = rel ? x + nx : nx; y = rel ? y + ny : ny;
      if (upper === 'M') { startX = x; startY = y; cmd = rel ? 'l' : 'L'; }
    } else if (upper === 'H') { const nx = num(); x = rel ? x + nx : nx; }
    else if (upper === 'V') { const ny = num(); y = rel ? y + ny : ny; }
    else if (upper === 'C') { num(); num(); num(); num(); const nx = num(), ny = num(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; }
    else if (upper === 'S' || upper === 'Q') { num(); num(); const nx = num(), ny = num(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; }
    else if (upper === 'A') { num(); num(); num(); num(); num(); const nx = num(), ny = num(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; }
    else { i++; continue; }
    see();
  }
  return { minX, minY, maxX, maxY };
}

module.exports = function () {
  suite('icons');

  const clipped = [];
  for (const name of ICON_NAMES) {
    const svg = icon(name, 16);
    const paths = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    const circles = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)];
    const rects = [...svg.matchAll(/<rect[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"/g)];

    let min = Infinity, max = -Infinity;
    for (const d of paths) {
      const b = bounds(d);
      min = Math.min(min, b.minX, b.minY);
      max = Math.max(max, b.maxX, b.maxY);
    }
    for (const c of circles) {
      min = Math.min(min, Number(c[1]) - Number(c[3]), Number(c[2]) - Number(c[3]));
      max = Math.max(max, Number(c[1]) + Number(c[3]), Number(c[2]) + Number(c[3]));
    }
    for (const r of rects) {
      min = Math.min(min, Number(r[3]), Number(r[4]));
      max = Math.max(max, Number(r[3]) + Number(r[1]), Number(r[4]) + Number(r[2]));
    }
    if (min < -0.5 || max > 24.5) clipped.push(`${name} (${min.toFixed(2)}..${max.toFixed(2)})`);
  }

  checkEqual('no icon is drawn outside its 24x24 viewBox', clipped, []);
  check('every icon renders an svg', ICON_NAMES.every((n) => icon(n, 16).startsWith('<svg')));
  checkEqual('an unknown icon is empty rather than broken markup', icon('nope', 16), '');
};
