/* The pairing screen.

   The code and the laptop's fingerprint arrive in the URL fragment, which the
   browser never sends to a server — so the code is not in anybody's logs, not
   even ours. The device signs that code with the key it just made, and pins the
   fingerprint it was shown: from then on it will refuse to talk to anything
   that cannot sign for the same laptop key. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const lede = $('lede');
  const note = $('note');
  const form = $('form');
  const codeField = $('code');
  const nameField = $('name');

  const fragment = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
  const offered = (fragment.get('c') || '').toUpperCase();
  const pinned = fragment.get('f') || '';
  const laptop = fragment.get('n') || 'this laptop';

  function say(text, kind) {
    note.textContent = text;
    note.className = 'note' + (kind ? ' ' + kind : '');
  }

  if (!window.nikDevice || !window.nikDevice.available()) {
    lede.textContent = 'This browser cannot keep a device key here.';
    say('A device key needs a secure connection — https, or the laptop itself. ' +
      'Over a plain http address on a network, the browser will not allow it.', 'bad');
    return;
  }

  // Making the key up front means the button does one thing, and the first
  // thing it does is not a five hundred millisecond pause.
  window.nikDevice.ensure().then(function () {
    lede.textContent = 'Type the code shown in the editor on ' + laptop + '.';
    form.hidden = false;
    if (offered) codeField.value = offered;
    nameField.value = guessName();
    (offered ? nameField : codeField).focus();
  }).catch(function (err) {
    lede.textContent = 'This device could not make a key.';
    say(String((err && err.message) || err), 'bad');
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const code = String(codeField.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) return say('That code looks too short.', 'bad');

    $('go').disabled = true;
    say('Pairing…');

    window.nikDevice.ensure().then(function (record) {
      return window.nikDevice.sign('nikui-pair:' + code).then(function (signature) {
        return fetch('/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            code: code,
            name: String(nameField.value || '').trim(),
            publicKey: record.publicKey,
            signature: signature
          })
        });
      });
    }).then(function (response) {
      return response.json().then(function (body) { return { ok: response.ok, body: body }; });
    }).then(function (result) {
      if (!result.ok) throw new Error(result.body.error || 'the laptop refused');
      // Pinning: the laptop just told us its key. If the QR said something
      // different, the thing that answered is not the thing that invited us.
      if (pinned && result.body.fingerprint !== pinned) {
        throw new Error('This is not the laptop that showed the code. Nothing was saved.');
      }
      return window.nikDevice.remember({
        id: result.body.device,
        fingerprint: result.body.fingerprint,
        // Kept so every later connection can be checked against a signature,
        // rather than against the other end agreeing with itself.
        serverKey: result.body.serverKey,
        laptop: laptop
      }).then(function () { return result.body; });
    }).then(function (body) {
      form.hidden = true;
      lede.textContent = 'Paired as ' + body.name + '.';
      say('This device can watch. Sending prompts is a separate grant — allow it ' +
        'from the Devices list in the editor. ', 'good');
      const link = document.createElement('a');
      link.href = '/';
      link.className = 'go-on';
      link.textContent = 'Open NikUI';
      note.appendChild(link);
    }).catch(function (err) {
      $('go').disabled = false;
      say(String((err && err.message) || err), 'bad');
    });
  });

  /** A name the owner will recognise in a list, without asking them to think. */
  function guessName() {
    const agent = String(navigator.userAgent || '');
    if (/iPhone/.test(agent)) return 'iPhone';
    if (/iPad/.test(agent)) return 'iPad';
    if (/Android/.test(agent)) return 'Android phone';
    if (/Macintosh/.test(agent)) return 'Mac';
    if (/Windows/.test(agent)) return 'PC';
    return '';
  }
})();
