/* The browser's colour scheme, in the terms panel.css already understands.

   VS Code puts `vscode-light` on the body and the stylesheet keys its light
   palette off it. A browser does not, so the same signal is derived from the OS
   and kept in sync — the alternative being a second copy of that palette here,
   which would drift the first time either changed. */
(function () {
  'use strict';
  const light = window.matchMedia('(prefers-color-scheme: light)');
  const apply = () => document.body.classList.toggle('vscode-light', light.matches);
  if (light.addEventListener) light.addEventListener('change', apply);
  if (document.body) apply();
  else document.addEventListener('DOMContentLoaded', apply);
})();
