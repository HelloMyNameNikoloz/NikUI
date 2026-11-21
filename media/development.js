/* The explicitly isolated development window's small fleet client. Conversation
   panels use the full shared panel.js; this page starts no local engine. */
(function () {
  'use strict';
  const transport = window.nikTransport();
  const rows = document.getElementById('rows'), lede = document.getElementById('lede');
  function open(id) { transport.postMessage({ type: 'bridge:open', session: id }); }
  window.addEventListener('message', function (event) {
    const m = event.data;
    if (m.type === 'bridge:offline' || m.type === 'intent:error') { lede.textContent = m.message || 'Isolated daemon unavailable. Reopen this view to reconnect.'; return; }
    if (m.type === 'instance:created') { open(m.instance); return; }
    if (m.type !== 'fleet') return;
    lede.textContent = 'Isolated development daemon · local management parity remains a P2 blocker.';
    rows.replaceChildren();
    for (const item of (m.instances || []).concat(m.codex || [])) {
      const button = document.createElement('button'); button.textContent = item.label + ' · ' + item.status;
      button.addEventListener('click', () => open(item.id)); rows.appendChild(button);
    }
    for (const project of m.projects || []) {
      for (const provider of ['claude', 'codex']) {
        const button = document.createElement('button'); button.textContent = 'New ' + (provider === 'claude' ? 'Claude' : 'Codex') + ' instance in ' + project.name;
        button.addEventListener('click', () => transport.postMessage({ type: 'instance:new', cwd: project.path, provider })); rows.appendChild(button);
      }
    }
  });
  transport.postMessage({ type: 'ready' });
})();
