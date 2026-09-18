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
  const screen = $('screen');

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
    const match = /(?:https?|nikui):\/\/[^\s"']*pair#[^\s"']*/i.exec(String(text || ''));
    if (!match) return null;
    const raw = match[0];
    const hash = raw.slice(raw.indexOf('#') + 1);
    const fragment = new URLSearchParams(hash);
    const code = (fragment.get('c') || '').toUpperCase();
    if (!code) return null;

    // An https link names the laptop in its authority; a nikui: link has no
    // authority worth the name, so it carries the host in the fragment with
    // everything else.
    let host = fragment.get('h') || '';
    let scheme = fragment.get('s') === 'http' ? 'http' : fragment.get('s') === 'https' ? 'https' : null;
    if (!host && /^https?:/i.test(raw)) {
      try {
        const url = new URL(raw);
        host = url.host;
        scheme = url.protocol === 'http:' ? 'http' : 'https';
      } catch (_) { return null; }
    }
    if (!host) return null;
    if (!scheme) scheme = /^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? 'http' : 'https';

    return {
      host: host,
      scheme: scheme,
      code: code,
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

  /** Which of the three things this screen is at any moment. */
  function show(state) {
    screen.className = 'screen welcome ' + state;
    $('steps').hidden = state !== 'waiting';
    $('type-instead').hidden = state !== 'waiting';
    $('form').hidden = state !== 'typing';
    $('invited').hidden = state !== 'invited';
    if (state === 'typing') setTimeout(() => codeField.focus(), 60);
  }

  /**
   * Arrived by pointing a camera at the laptop.
   *
   * Everything is already known, so there is one thing left to decide and it is
   * the only thing worth deciding: whether this is your laptop. It is named,
   * its address is shown, and pairing is one tap — but it is still a tap,
   * because a link that pairs on sight is a link somebody else could send you.
   */
  function invited(link) {
    if (!fill(link)) return false;
    $('headline').textContent = 'Pair with this laptop?';
    $('lede').textContent = 'It invited this phone. Pairing lets it watch — nothing more until you say so.';
    $('invited-from').textContent = link.laptop || link.host;
    $('invited-where').textContent = link.laptop ? link.host : '';
    show('invited');
    buzz('medium');
    return true;
  }

  /** A small physical confirmation that something happened. */
  function buzz(style) {
    const plugins = window.NikApp && window.NikApp.native();
    const haptics = plugins && plugins.Haptics;
    if (!haptics || !haptics.impact) return;
    const call = haptics.impact({ style: (style || 'light').toUpperCase() });
    if (call && call.catch) call.catch(function () {});
  }

  /** Where this device is about to keep its key, in words rather than a term. */
  const WHERE = {
    'secure-enclave': 'This iPhone will keep its key in the Secure Enclave, where nothing can copy it.',
    'strongbox': 'This phone will keep its key in its security chip, where nothing can copy it.',
    'keystore': 'This phone will keep its key in the Android Keystore, where nothing can copy it.',
    'software': 'This device will keep its key here, and never send it anywhere.'
  };

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
      body: JSON.stringify({
        code, name, publicKey: record.publicKey, signature,
        // So the laptop's device list can say where this key is being kept.
        // It is a claim, and the laptop treats it as one.
        protection: record.protection || 'software',
        biometric: !!record.biometric
      })
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

  /**
   * The whole exchange, from whichever button asked for it. Both the typed
   * route and the scanned one end here, so there is one place where pairing
   * happens and one place where it can go wrong.
   */
  async function attempt() {
    const host = cleanHost(hostField.value);
    const code = clean(codeField.value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = clean(nameField.value) || guessName();

    if (!host) return say('Type the address shown under the code on your laptop.', 'bad');
    if (code.length < 4) return say('That code looks too short.', 'bad');

    // http is only ever loopback — a phone talking to a laptop over anything
    // else needs TLS, or the browser will not let this device hold a key.
    const scheme = /^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? 'http' : 'https';
    const where = scheme + '://' + host;

    busy(true);
    say('Pairing…', 'working');
    try {
      const body = await pair(where, code, name);
      window.NikApp.remember({
        host, scheme,
        name: laptopName || host,
        fingerprint: body.fingerprint
      });
      say('Paired as ' + body.name + '. Opening…', 'good');
      buzz('heavy');
      setTimeout(() => window.location.replace('index.html'), 600);
    } catch (err) {
      busy(false);
      say(String((err && err.message) || err), 'bad');
    }
  }

  /** One button or the other, depending on how this screen was arrived at. */
  function busy(working) {
    go.disabled = working;
    $('accept').disabled = working;
    $('accept').textContent = working ? 'Pairing…' : 'Pair';
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    attempt();
  });

  // The three ways out of the first screen.
  $('type-instead').addEventListener('click', () => show('typing'));
  $('accept').addEventListener('click', () => attempt());
  $('decline').addEventListener('click', () => {
    pinned = null;
    laptopName = null;
    codeField.value = '';
    $('headline').textContent = 'Connect to your laptop';
    $('lede').textContent = 'Two steps, and the second one is pointing this phone at a screen.';
    say('');
    show('waiting');
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

  /**
   * A link the phone's camera handed to this app — either while it was already
   * running, or as the thing that started it.
   */
  function listenForInvitations() {
    const plugins = window.NikApp && window.NikApp.native();
    const app = plugins && plugins.App;
    if (!app) return;
    if (app.addListener) {
      app.addListener('appUrlOpen', (event) => invited(readLink(event && event.url)));
    }
    if (app.getLaunchUrl) {
      app.getLaunchUrl()
        .then((launch) => { if (launch && launch.url) invited(readLink(launch.url)); })
        .catch(() => {});
    }
  }

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
    show('waiting');
    listenForInvitations();

    if (!window.nikDevice || !window.nikDevice.available()) {
      say('This device cannot make a key here. A secure connection — https — is required.', 'bad');
      go.disabled = true;
      return;
    }
    // Made up front, so the button does one thing and does it immediately.
    try {
      const record = await window.nikDevice.ensure();
      const held = $('held');
      if (held) held.textContent = WHERE[record.protection] || WHERE.software;
    } catch (err) {
      say('This device could not make a key: ' + ((err && err.message) || err), 'bad');
      busy(true);
    }
  })();
})();
