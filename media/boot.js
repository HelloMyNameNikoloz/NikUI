/* Paint icons into the chrome before panel.js wires up behaviour. */
(function () {
  'use strict';
  const put = (id, name, size) => {
    const el = document.getElementById(id);
    if (el) el.insertAdjacentHTML('afterbegin', window.icon(name, size || 15));
  };
  put('attach', 'paperclip', 15);
  put('stop', 'stop', 13);
  put('send', 'send', 13);
  put('lb-close', 'x', 16);
})();
