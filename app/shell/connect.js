/* The way in.

   One screen, one button, and as few things to understand as the exchange
   allows. What has to happen is: this device makes a key it cannot give away,
   proves it knows the code on the laptop's screen, and remembers the laptop it
   was invited by. What somebody has to *do* is type a code.

   Everything else is filled in for them where it can be — the address and the
   laptop's fingerprint come from the pairing link when there is one, and the
   device names itself. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const note = $('note');
  const hostField = $('host');
  const codeField = $('code');
  const nameField = $('name');
  const go = $('go');

  // Carried in from a pairing link, if one was pasted: the laptop's key
  // fingerprint, which is what makes "is this really my laptop" answerable.
  let pinned = null;
  let laptopName = null;

  function say(text, kind) {
    note.textContent = text;
    note.className = 'note' + (kind ? ' ' + kind : '');
  }

  const clean = (value) => String(value || '').trim();
  const cleanHost = (value) => clean(value)
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\s/g, '');

  /**
   * A pairing link, taken apart.
   *
   * `https://laptop.tailnet.ts.net/pair#c=CODE&f=FINGERPRINT&n=NAME` — the
   * fragment never reached the laptop's logs, and it does not need to reach
   * ours either; it is read here and turned into three filled-in fields.
   */
  function readLink(text) {
    const match = /https?:\/\/[^\s"']+\/pair#[^\s"']*/i.exec(String(text || ''));
    if (!match) return null;
    let url;
    try { url = new URL(match[0]); } catch (_) { return null; }
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
    return {
      host: url.host,
      scheme: url.protocol === 'http:' ? 'http' : 'https',
      code: (fragment.get('c') || '').toUpperCase(),
      fingerprint: fragment.get('f') || null,
      laptop: fragment.get('n') || null
    };
  }

  function fill(link) {
    if (!link) return false;
    hostField.value = link.host;
    if (link.code) codeField.value = link.code;
    pinned = link.fingerprint;
    laptopName = link.laptop;
    say('Ready. Check the code matches the one on screen, then tap Pair.', 'good');
    return true;
  }

  /** A name the owner will recognise in a list, without being asked to think. */
  function guessName() {
    const agent = String(navigator.userAgent || '');
    if (/iPhone/i.test(agent)) return 'iPhone';
    if (/iPad/i.test(agent)) return 'iPad';
    if (/Android/i.test(agent)) return 'Android phone';
    return 'My phone';
  }

  // ---- the exchange --------------------------------------------------------

  async function pair(where, code, name) {
    const record = await window.nikDevice.ensure();
    const signature = await window.nikDevice.sign('nikui-pair:' + code);
    const response = await fetch(where + '/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name, publicKey: record.publicKey, signature })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'the laptop refused');

    // Pinning: the laptop just told us its key. If the link said something
    // different, whatever answered is not what invited us.
    if (pinned && body.fingerprint !== pinned) {
      throw new Error('That is not the laptop that showed the code. Nothing was saved.');
    }
    await window.nikDevice.remember({
      id: body.device,
      fingerprint: body.fingerprint,
      serverKey: body.serverKey,
      laptop: laptopName || where
    });
    return body;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const host = cleanHost(hostField.value);
    const code = clean(codeField.value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = clean(nameField.value) || guessName();

    if (!host) return say('Type the address shown under the code on your laptop.', 'bad');
    if (code.length < 4) return say('That code looks too short.', 'bad');

    // http is only ever loopback — a phone talking to a laptop over anything
    // else needs TLS, or the browser will not let this device hold a key.
    const scheme = /^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? 'http' : 'https';
    const where = scheme + '://' + host;

    go.disabled = true;
    say('Pairing…', 'working');
    try {
      const body = await pair(where, code, name);
      window.NikApp.remember({
        host, scheme,
        name: laptopName || host,
        fingerprint: body.fingerprint
      });
      say('Paired as ' + body.name + '. Opening…', 'good');
      setTimeout(() => window.location.replace('index.html'), 600);
    } catch (err) {
      go.disabled = false;
      say(String((err && err.message) || err), 'bad');
    }
  });

  $('paste').addEventListener('click', async () => {
    try {
      const plugins = window.NikApp.native();
      const text = plugins && plugins.Clipboard
        ? (await plugins.Clipboard.read()).value
        : await navigator.clipboard.readText();
      if (!fill(readLink(text))) say('There was no pairing link on the clipboard.', 'bad');
    } catch (_) {
      say('This device would not share the clipboard. Type the address instead.', 'bad');
    }
  });

  // Somebody who is already paired does not need this screen; somebody who is
  // half way through gets their fields back.
  (async function start() {
    if (window.NikApp.laptop()) {
      $('headline').textContent = 'Pair again';
      $('lede').textContent = 'This device is already paired. Pairing again replaces the laptop it talks to.';
      const where = window.NikApp.laptop();
      hostField.value = where.host;
    }
    nameField.value = guessName();

    if (!window.nikDevice || !window.nikDevice.available()) {
      say('This device cannot make a key here. A secure connection — https — is required.', 'bad');
      go.disabled = true;
      return;
    }
    // Made up front, so the button does one thing and does it immediately.
    try {
      await window.nikDevice.ensure();
    } catch (err) {
      say('This device could not make a key: ' + ((err && err.message) || err), 'bad');
      go.disabled = true;
    }
  })();
})();
