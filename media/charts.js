/* Tiny SVG chart set for the /status sheet.

   Two rules shape everything here. The webview's CSP forbids inline styles, so
   marks carry class names and the palette lives in the stylesheet — which also
   means the charts follow the VS Code theme for free. And every mark that can
   be hovered carries data-tip, so one delegated listener anywhere above the
   chart can show a tooltip without the chart knowing anything about it. */
(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const round = (n, p) => Math.round(n * Math.pow(10, p || 0)) / Math.pow(10, p || 0);

  // Charts stretch to the width of their card, so the viewBox is kept close to
  // the pixel size it renders at: a 100-unit box blown up to 1100px turns every
  // rounded corner into an ellipse.
  function svg(width, height, body, extra, label) {
    return '<svg class="chart ' + (extra || '') + '" viewBox="0 0 ' + width + ' ' + height + '" ' +
      'preserveAspectRatio="none" role="img"' +
      (label ? ' aria-label="' + esc(label) + '"' : ' aria-hidden="true"') + '>' + body + '</svg>';
  }

  /** Rounded only at the data end, anchored to the baseline. */
  function bar(x, y, w, h, klass, tip, radius) {
    const r = Math.min(radius === undefined ? 4 : radius, w / 2, h);
    if (h <= 0.5) return '';
    if (h <= r * 2) {
      return '<rect class="' + klass + '" x="' + round(x, 2) + '" y="' + round(y, 2) + '" width="' + round(w, 2) +
        '" height="' + round(h, 2) + '"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '></rect>';
    }
    const d = 'M' + round(x, 2) + ' ' + round(y + h, 2) +
      'V' + round(y + r, 2) + 'q0 -' + r + ' ' + r + ' -' + r +
      'h' + round(w - r * 2, 2) + 'q' + r + ' 0 ' + r + ' ' + r +
      'V' + round(y + h, 2) + 'Z';
    return '<path class="' + klass + '" d="' + d + '"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '></path>';
  }

  /**
   * Vertical stacked columns. `series` is [{key, label, klass}] in fixed order,
   * so a column keeps its colours whatever the data does.
   */
  function stacked(rows, series, opts) {
    const o = Object.assign({ width: 1000, height: 150, gap: 3, tip: null, label: null }, opts || {});
    if (!rows.length) return empty(o.width, o.height);
    const totals = rows.map((r) => series.reduce((sum, s) => sum + (r[s.key] || 0), 0));
    const peak = Math.max(1, ...totals);
    const slot = o.width / rows.length;
    const w = Math.max(2, slot - Math.max(o.gap, slot * 0.18));
    let out = '';
    rows.forEach((row, i) => {
      const x = i * slot + (slot - w) / 2;
      let y = o.height;
      // Drawn from the baseline up, so the 2px surface gap falls between fills.
      series.forEach((s) => {
        const value = row[s.key] || 0;
        if (value <= 0) return;
        const h = (value / peak) * (o.height - 2);
        y -= h;
        out += bar(x, y, w, h - (o.gap / 2), s.klass, o.tip ? o.tip(row, s) : null, 2);
        y -= o.gap / 2;
      });
    });
    return svg(o.width, o.height, out, 'chart-cols', o.label);
  }

  /** One-series columns: magnitude only, so one hue for every bar. */
  function columns(values, opts) {
    const o = Object.assign({ width: 1000, height: 120, klass: 'm1', tip: null, gap: 3, label: null }, opts || {});
    if (!values.length) return empty(o.width, o.height);
    const peak = Math.max(1, ...values.map((v) => v.value || 0));
    const slot = o.width / values.length;
    const w = Math.max(2, slot - Math.max(o.gap, slot * 0.2));
    let out = '';
    values.forEach((v, i) => {
      const h = ((v.value || 0) / peak) * (o.height - 2);
      out += bar(i * slot + (slot - w) / 2, o.height - h, w, h, v.klass || o.klass, o.tip ? o.tip(v, i) : null, 2);
    });
    return svg(o.width, o.height, out, 'chart-cols', o.label);
  }

  /** Horizontal bars with the label and value outside the plot, in ink. */
  function rows(items, opts) {
    const o = Object.assign({ klass: 'm1', max: null, format: (v) => v }, opts || {});
    const peak = o.max || Math.max(1, ...items.map((i) => i.value || 0));
    return '<div class="hbars">' + items.map((item) => {
      const pct = Math.max(0.5, ((item.value || 0) / peak) * 100);
      return '<div class="hbar' + (item.emphasis ? ' on' : '') + '"' +
        (item.action ? ' data-action="' + esc(item.action) + '" tabindex="0" role="button"' : '') +
        (item.tip ? ' data-tip="' + esc(item.tip) + '"' : '') + '>' +
        '<span class="hbar-label">' + esc(item.label) + '</span>' +
        '<span class="hbar-track">' + svg(400, 10,
          '<rect class="track" x="0" y="2" width="400" height="6" rx="3"></rect>' +
          '<rect class="' + (item.klass || o.klass) + '" x="0" y="2" width="' + round(pct * 4, 2) + '" height="6" rx="3"></rect>',
          'chart-hbar') + '</span>' +
        '<span class="hbar-value">' + esc(o.format(item.value, item)) + '</span>' +
        // Always emitted, so every row's track starts at the same x.
        '<span class="hbar-note' + (item.noteBad ? ' bad' : '') + '">' + esc(item.note || '') + '</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  /** Single series over time: area for shape, line for the values, dots to hover. */
  function area(points, opts) {
    const o = Object.assign({ width: 1000, height: 130, klass: 'm1', tip: null, baseline: 0, label: null }, opts || {});
    if (points.length < 2) return points.length ? flat(points, o) : empty(o.width, o.height);
    const values = points.map((p) => p.value || 0);
    const peak = Math.max(...values);
    const floor = Math.min(o.baseline, ...values);
    const span = peak - floor || 1;
    const x = (i) => (i / (points.length - 1)) * o.width;
    const y = (v) => o.height - 4 - ((v - floor) / span) * (o.height - 12);

    const line = points.map((p, i) => (i ? 'L' : 'M') + round(x(i), 2) + ' ' + round(y(p.value || 0), 2)).join('');
    const fill = line + 'L' + round(o.width, 2) + ' ' + o.height + 'L0 ' + o.height + 'Z';
    // Hit targets are wider than the dots: hovering a 3px circle is a chore.
    const hits = points.map((p, i) =>
      '<rect class="hit" x="' + round(x(i) - o.width / points.length / 2, 2) + '" y="0" width="' +
      round(o.width / points.length, 2) + '" height="' + o.height + '"' +
      (o.tip ? ' data-tip="' + esc(o.tip(p, i)) + '"' : '') + '></rect>').join('');
    return svg(o.width, o.height,
      '<path class="fill ' + o.klass + '" d="' + fill + '"></path>' +
      '<path class="line ' + o.klass + '" d="' + line + '"></path>' + hits, 'chart-area', o.label);
  }

  function flat(points, o) {
    const y = o.height / 2;
    return svg(o.width, o.height, '<path class="line ' + o.klass + '" d="M0 ' + y + 'L' + o.width + ' ' + y + '"></path>', 'chart-area');
  }

  /** A ratio against a limit: one track, one fill, thresholds as status colour. */
  function meter(pct, opts) {
    const o = Object.assign({ klass: null, marks: [], label: null }, opts || {});
    const value = Math.max(0, Math.min(1, pct || 0));
    const klass = o.klass || (value >= 0.9 ? 'level-critical' : value >= 0.7 ? 'level-warn' : 'level-ok');
    const ticks = o.marks.map((m) =>
      '<rect class="tick" x="' + round(m * 1000, 2) + '" y="0" width="2" height="12"></rect>').join('');
    return svg(1000, 12,
      '<rect class="track" x="0" y="0" width="1000" height="12" rx="6"></rect>' +
      '<rect class="' + klass + '" x="0" y="0" width="' + round(Math.max(value * 1000, value > 0 ? 14 : 0), 2) +
      '" height="12" rx="6"></rect>' + ticks, 'chart-meter', o.label);
  }

  /** Part-to-whole in one horizontal bar, with a 2px surface gap between fills. */
  function share(parts, opts) {
    const o = Object.assign({ tip: null, label: null }, opts || {});
    const total = parts.reduce((sum, p) => sum + (p.value || 0), 0);
    if (!total) return empty(1000, 12);
    let x = 0;
    const body = parts.map((p) => {
      const w = ((p.value || 0) / total) * 1000;
      if (w <= 0) return '';
      const seg = '<rect class="' + p.klass + '" x="' + round(x, 2) + '" y="0" width="' +
        round(Math.max(0, w - 2), 2) + '" height="12" rx="3"' +
        (o.tip ? ' data-tip="' + esc(o.tip(p, total)) + '"' : '') + '></rect>';
      x += w;
      return seg;
    }).join('');
    return svg(1000, 12, body, 'chart-share', o.label);
  }

  /**
   * Hour-of-day rhythm. One hue, more-is-darker, with the empty cells left as
   * a hairline so the pattern reads as a shape rather than a grid.
   */
  function heat(buckets, opts) {
    const o = Object.assign({ label: (i) => i + ':00', unit: 'turns' }, opts || {});
    const peak = Math.max(...buckets, 1);
    const cells = buckets.map((v, i) => {
      const step = v === 0 ? 0 : Math.min(4, Math.ceil((v / peak) * 4));
      return '<div class="cell s' + step + '" data-tip="' + esc(o.label(i) + ' · ' + v + ' ' + o.unit) + '"></div>';
    }).join('');
    return '<div class="heat">' + cells + '</div>' +
      '<div class="heat-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>';
  }

  function empty(width, height) {
    return svg(width, height, '<rect class="track" x="0" y="' + (height / 2 - 1) + '" width="' + width + '" height="2" rx="1"></rect>', 'chart-empty');
  }

  /** Identity for a stacked/multi-series chart: never colour alone. */
  function legend(series) {
    return '<div class="legend">' + series.map((s) =>
      '<span class="key"><i class="swatch ' + s.klass + '"></i>' + esc(s.label) +
      (s.value !== undefined ? '<b>' + esc(s.value) + '</b>' : '') + '</span>').join('') + '</div>';
  }

  const charts = { svg, bar, stacked, columns, rows, area, meter, share, heat, legend, empty, esc };
  root.charts = charts;
  if (typeof module !== 'undefined' && module.exports) module.exports = charts;
})(typeof window !== 'undefined' ? window : globalThis);
