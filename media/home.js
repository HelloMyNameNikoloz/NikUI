/* The window, as a list you can tap.

   The page arrives empty — the server sends markup and no data — and this fills
   it from the same socket the conversation uses. So the list is live, and an
   unpaired device gets an empty shell and an explanation rather than a list of
   what is running on somebody's laptop. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const rows = $('rows');
  const lede = $('lede');
  const transport = window.nikTransport();

  const money = (value) => '$' + (Number(value) || 0).toFixed(2);
  const shortPath = (value) => String(value || '').split('/').slice(-2).join('/');

  function draw(instances) {
    rows.textContent = '';
    if (!instances.length) {
      lede.textContent = 'No instances are open in the editor yet.';
      return;
    }
    lede.textContent = instances.length === 1 ? 'One instance.' : instances.length + ' instances.';

    for (const instance of instances) {
      const row = document.createElement('a');
      row.className = 'row';
      row.href = '/s/' + encodeURIComponent(instance.id);

      const dot = document.createElement('span');
      dot.className = 'sdot ' + String(instance.status || 'idle').replace(/[^a-z]/g, '') +
        (instance.asleep ? ' asleep' : '');
      row.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = instance.label || instance.id;
      row.appendChild(name);

      const where = document.createElement('span');
      where.className = 'row-cwd';
      const notes = [];
      if (instance.queued) notes.push(instance.queued + ' queued');
      if (instance.paused) notes.push('waiting for the quota');
      where.textContent = shortPath(instance.cwd) + (notes.length ? ' · ' + notes.join(' · ') : '');
      row.appendChild(where);

      const cost = document.createElement('span');
      cost.className = 'row-cost';
      cost.textContent = money(instance.cost);
      row.appendChild(cost);

      rows.appendChild(row);
    }
  }

  function refused(message) {
    rows.textContent = '';
    lede.textContent = message.reason || 'This device cannot see this window.';
    if (!message.pair) return;
    const link = document.createElement('a');
    link.className = 'go-on';
    link.href = '/pair';
    link.textContent = 'Pair this device';
    rows.appendChild(link);
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'fleet') draw(message.instances || []);
    else if (message.type === '@denied') refused(message);
  });

  transport.postMessage({ type: 'ready' });
})();
