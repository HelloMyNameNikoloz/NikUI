/* Lucide icons (ISC licence), inlined as SVG so no CDN is needed under the
   webview CSP. 24x24 stroke grid, currentColor. */
(function (root) {
  'use strict';

  const P = {
    send:        '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    stop:        '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    x:           '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check:       '<path d="M20 6 9 17l-5-5"/>',
    chevron:     '<path d="m9 18 6-6-6-6"/>',
    clock:       '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    hash:        '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/>',
    terminal:    '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    sparkles:    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    image:       '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    paperclip:   '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    alert:       '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    history:     '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    plus:        '<path d="M5 12h14"/><path d="M12 5v14"/>',
    folder:      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    slash:       '<path d="M22 2 2 22"/>',
    expand:      '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
    trash:       '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    coins:       '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/>',
    cpu:         '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M9 2v2"/><path d="M15 20v2"/><path d="M9 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/>'
  };

  function icon(name, size) {
    const body = P[name];
    if (!body) return '';
    const s = size || 16;
    return '<svg class="ico" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + body + '</svg>';
  }

  root.icon = icon;
  root.ICON_NAMES = Object.keys(P);
  if (typeof module !== 'undefined' && module.exports) module.exports = { icon, ICON_NAMES: Object.keys(P) };
})(typeof window !== 'undefined' ? window : globalThis);
