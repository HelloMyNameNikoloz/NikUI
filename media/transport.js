/* The one thing that differs between a webview and a browser tab.

   media/panel.js asks for a transport instead of asking VS Code for an API. In
   the panel it gets exactly what it always got. In a browser it gets the same
   three methods over a WebSocket, so every other file in media/ has no idea
   which host it is running in — which is the only way the phone client and the
   panel can stay the same client. */
(function () {
  'use strict';

  // Long enough to ride out a lift or a tunnel, short enough that picking the
  // phone back up feels instant.
  const BACKOFF = [400, 800, 1600, 3200, 6400, 12000];

  /**
   * Where a conversation lives, for whoever is hosting this client: a path on
   * the laptop when it served the page, a page in the bundle when an app did.
   */
  function conversationUrl(id) {
    const remote = window.NIKUI_REMOTE || {};
    return (remote.conversation || '/s/') + encodeURIComponent(id);
  }

  /** What VS Code keeps for a hidden webview, kept in localStorage instead. */
  function browserState(key) {
    return {
      getState: function () {
        try { return JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (_) { return null; }
      },
      setState: function (value) {
        try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
        return value;
      }
    };
  }

  /**
   * A socket that behaves like the VS Code API: post a message, get messages
   * back as `message` events on window, keep a little state across reloads.
   */
  function socketTransport(config) {
    const state = browserState('nikui:' + (config.session || 'unknown'));
    const pill = document.getElementById('link');
    let socket = null;
    let tries = 0;
    let retry = null;
    let wantsReady = false;   // the client has said `ready` at least once
    let closing = false;
    let seated = false;       // the handshake is done and this socket may talk
    let stopped = null;       // a refusal worth showing instead of retrying
    let expecting = null;     // the nonces this device is waiting to see signed
    let said = 0;             // how many times the pill has been written to
    let holdUntil = 0;        // a message that has to be read before it is replaced
    let paired = false;       // this device has an identity, so it must verify
    let opening = null;       // the sealed channel for this socket, once agreed
    let box = null;           // the same thing, once it has been built
    let outgoing = null;      // sealing is asynchronous; order is not optional
    let incoming = null;      // and neither is the order things are opened in

    function url() {
      // An app carries the client in a bundle, so there is no page address to
      // infer the laptop from: it is told one, absolutely, and that address
      // keeps its own scheme. A served page still works out where it came from.
      if (/^wss?:\/\//i.test(config.socket || '')) return config.socket;
      const at = new URL(config.socket || '/socket', window.location.href);
      at.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return at.toString();
    }

    /** Somewhere on the laptop, from wherever this client happens to be. */
    function at(route) {
      return config.origin ? config.origin.replace(/\/$/, '') + route : route;
    }

    /**
     * The state of the connection, in a word.
     *
     * `hold` keeps a message up for a moment against the background chatter of
     * reconnecting. "Your prompt was not sent" is the one line here that is
     * about something the reader did, and a retry notice a tenth of a second
     * later would take it away before it had been read.
     */
    function show(kind, text, hold) {
      if (holdUntil > Date.now() && kind !== 'on' && !hold) return;
      holdUntil = hold ? Date.now() + hold : 0;
      said++;
      if (!pill) return;
      pill.className = 'link ' + kind;
      pill.textContent = text;
      pill.hidden = false;
    }

    /** Try again now, rather than when the backoff says so. */
    function retryNow() {
      if (live()) return;
      tries = 0;
      stopped = null;
      connect();
    }

    /**
     * Start the connection over, including one that is working.
     *
     * Only one thing needs this: the handshake is where a device presents a
     * replacement key, so moving a key into the chip means doing the handshake
     * again. Doing it while somebody is looking at the button they pressed is
     * the whole point — the alternative is a face check arriving at a random
     * moment hours later.
     */
    function reconnect() {
      tries = 0;
      stopped = null;
      const open = socket;
      socket = null;
      seated = false;
      expecting = null;
      opening = null;
      box = null;
      if (open) { try { open.close(1000, 'reconnecting'); } catch (_) { /* already gone */ } }
      connect();
    }

    // The state of the connection is also the button for doing something about
    // it: on a phone, the thing you want when it says offline is to try again.
    if (pill) pill.addEventListener('click', retryNow);

    // Two moments when waiting out a backoff is obviously wrong: the phone has
    // just been picked up, and the network has just come back. A page that sits
    // there saying "reconnecting" for eight more seconds while somebody stares
    // at it is a page that looks broken.
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) retryNow();
      });
    }
    if (window.addEventListener) window.addEventListener('online', retryNow);

    /**
     * Anything this transport makes up for its own page.
     *
     * Always on a later turn of the loop, never inside the call that caused it.
     * A real message from the host arrives asynchronously, and a synthetic one
     * that does not is a reentrant call: `postMessage` refusing a prompt used to
     * hand the text back *during* the client's send, which then cleared the
     * composer on the line after — so the refusal erased exactly what it was
     * trying to save.
     */
    function tell(message) {
      setTimeout(function () {
        window.dispatchEvent(new MessageEvent('message', { data: message }));
      }, 0);
    }

    /**
     * In. Sealed frames are opened before anything looks at them, one at a
     * time and in order — the counter inside each one is only meaningful in
     * sequence, and a reordered stream would look like a replay.
     */
    function deliver(data) {
      let message = null;
      try { message = JSON.parse(data); } catch (_) { return; }
      if (message && message.type === '@box') {
        if (!opening) return; // nothing was agreed; there is nothing to open it with
        const on = socket;
        incoming = (incoming || Promise.resolve())
          .then(function () { return opening; })
          .then(function (sealed) {
            if (!sealed || on !== socket) return null;
            return sealed.open(message);
          })
          .then(function (inside) {
            if (inside === null || inside === undefined) {
              if (on !== socket) return;
              // A frame that will not open is not a glitch to skip past: either
              // the key is wrong or somebody is editing the stream.
              stopped = 'could not open what the laptop sent';
              show('off', 'Could not read the laptop’s reply');
              try { on.close(1008, 'unsealed'); } catch (_) { /* gone */ }
              return;
            }
            handle(inside);
          })
          .catch(function () { /* the socket will say so */ });
        return;
      }
      handle(data, message);
    }

    /** One message, already out of its envelope if it was in one. */
    function handle(data, parsed) {
      let message = parsed;
      if (message === undefined) {
        try { message = JSON.parse(data); } catch (_) { return; }
      }
      if (message && typeof message.type === 'string' && message.type.charAt(0) === '@') {
        if (handshake(message)) return;
      }
      window.dispatchEvent(new MessageEvent('message', { data: message }));
    }

    /**
     * Before this socket carries anything, it has to say who is holding it.
     *
     * On the laptop the key in the cookie has already settled that and the
     * welcome arrives unprompted. Anywhere else the server sends a nonce, this
     * device signs it with the key it cannot export, and the server signs back
     * with the key whose fingerprint was pinned at pairing — so neither end is
     * taking the other's word for it.
     *
     * @returns {boolean} whether the message was the transport's own business
     */
    function handshake(message) {
      if (message.type === '@challenge') {
        answer(message);
        return true;
      }
      if (message.type === '@welcome') {
        // A welcome that nobody was asked for is somebody skipping the question.
        // The only client allowed to accept one is a browser with no identity to
        // prove — which cannot be lied to about a laptop it never pinned.
        if (!expecting) {
          if (!paired) return seat(message);
          stopped = 'unproven laptop';
          show('off', 'This is not the laptop this device paired with');
          return true;
        }
        const awaited = expecting;
        expecting = null;
        window.nikDevice.load().then(function (record) {
          return window.nikDevice.verifyLaptop(
            record, message.serverKey || awaited.serverKey,
            'nikui-host:' + awaited.mine + ':' + awaited.theirs + (awaited.suffix || ''),
            message.signature
          );
        }).then(function (ok) {
          if (ok) {
            settleUpgrade(message);
            return seat(message);
          }
          stopped = 'unproven laptop';
          show('off', 'This is not the laptop this device paired with');
          tell({ type: '@denied', reason: 'This is not the laptop this device paired with.' });
          if (socket) try { socket.close(1008, 'unproven'); } catch (_) { /* gone */ }
        }).catch(function () {
          stopped = 'unproven laptop';
          show('off', 'Could not check the laptop');
        });
        return true;
      }
      if (message.type === '@navigate') {
        // Another instance, on this device only. The laptop's tabs are the
        // laptop's business.
        if (message.session) window.location.assign(conversationUrl(message.session));
        return true;
      }
      if (message.type === '@denied') {
        seated = false;
        stopped = message.reason || 'refused';
        show('off', reasonText(stopped));
        return false;
      }
      return false;
    }

    /** Let the page talk: everything above this line is about who is listening. */
    function seat(message) {
      seated = true;
      tries = 0;
      stopped = null;
      show('on', 'Live');
      if (wantsReady) send({ type: 'ready' });
      window.dispatchEvent(new MessageEvent('message', { data: message }));
      return true;
    }

    function answer(challenge) {
      if (!window.nikDevice || !window.nikDevice.available()) {
        // No Web Crypto here at all, so no identity is possible: the only way
        // in is the key this page arrived with, and the server decides.
        paired = false;
        send({ type: '@auth', device: null, nonce: randomNonce() });
        return;
      }
      window.nikDevice.load().then(function (record) {
        if (!record || !record.id) {
          // Nothing to prove: say so, and let the server decide whether the key
          // this page arrived with is enough.
          // A nonce even so, so the laptop signs this welcome like any other.
          paired = false;
          send({ type: '@auth', device: null, nonce: randomNonce() });
          return;
        }
        paired = true;
        // Pinning, from this side: the laptop that answers has to be the one
        // this device paired with, not merely something at the same address.
        if (record.fingerprint && challenge.fingerprint && record.fingerprint !== challenge.fingerprint) {
          stopped = 'wrong laptop';
          show('off', 'This is not the laptop this device paired with');
          tell({ type: '@denied', reason: 'This is not the laptop this device paired with.' });
          return;
        }
        const mine = randomNonce();
        // A throwaway key for this one connection, when the laptop offered one.
        // Both keys go into what this device signs, so an impostor cannot swap
        // either for its own, and cannot strip the offer to force a connection
        // it could read.
        return agreeKey(challenge).then(function (seal) {
          const suffix = seal ? ':' + seal.binding : '';
          // Remembered so the welcome can be checked against what was asked, not
          // against whatever the answer happens to contain.
          expecting = {
            mine: mine, theirs: challenge.nonce, serverKey: challenge.serverKey, suffix: suffix
          };
          // Which may also be a request to start using a better key — see
          // media/device.js. The transport does not need to know which; it sends
          // what the identity says to send.
          return window.nikDevice.authMessage(record, challenge.nonce, mine, suffix)
            .then(function (message) {
              if (seal) message.epk = seal.mine.spki;
              // Started before the answer goes out, so a laptop that replies
              // the instant it reads it is never replying to a client with
              // nothing to open the reply with. `send` still sends the answer
              // itself in the clear: it is what agrees the key.
              if (seal) {
                opening = window.nikSecure.clientBox(seal.mine, challenge.epk, challenge.nonce, mine);
                opening.then(function (sealed) { box = sealed; });
              }
              send(message);
            });
        });
      }).catch(function () {
        stopped = 'could not sign';
        show('off', 'This device could not sign in');
      });
    }

    /**
     * A key that was waiting to replace the current one, now that the laptop
     * has answered.
     *
     * The old key stops being this device's identity at exactly one moment: the
     * laptop saying it has taken the new one, in a welcome this device has
     * already proved came from the laptop it paired with. A welcome without
     * that means the request did not land — an older laptop, a refusal — and
     * the replacement is thrown away rather than tried forever.
     */
    function settleUpgrade(message) {
      const identity = window.nikDevice;
      if (!identity || !identity.load) return;
      identity.load().then(function (record) {
        if (!record || !record.staged) return null;
        return message.rekeyed ? identity.commitUpgrade() : identity.discardUpgrade();
      }).then(function (settled) {
        if (settled === null || settled === undefined) return;
        window.dispatchEvent(new CustomEvent('nikui-key-moved', {
          detail: { taken: !!message.rekeyed, protection: message.rekeyed && message.rekeyed.protection }
        }));
      }).catch(function () { /* the next connection asks again */ });
    }

    /**
     * The throwaway key half of the handshake, when both ends can do it.
     *
     * A client with no identity to prove does not seal: there would be nothing
     * binding the agreement to anybody, which is encryption that proves nothing
     * and hides the fact. That client is the laptop's own browser, on loopback,
     * holding the key — the one case where there is no network to hide from.
     */
    function agreeKey(challenge) {
      if (!challenge.epk || !window.nikSecure || !window.nikSecure.available()) {
        return Promise.resolve(null);
      }
      return window.nikSecure.ephemeral().then(function (mine) {
        return window.nikSecure.binding(challenge.epk, mine.spki).then(function (binding) {
          return { mine: mine, binding: binding };
        });
      }).catch(function () { return null; });
    }

    function randomNonce() {
      const bytes = new Uint8Array(24);
      (window.crypto || {}).getRandomValues(bytes);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function reasonText(reason) {
      if (/not paired/i.test(reason)) return 'This device is not paired';
      if (/removed/i.test(reason)) return 'This device was removed';
      if (/laptop|unproven/i.test(reason)) return 'This is not the laptop this device paired with';
      return 'Refused';
    }

    function connect() {
      if (closing || (socket && (socket.readyState === 0 || socket.readyState === 1))) return;
      if (retry) { clearTimeout(retry); retry = null; }
      show(tries ? 'warn' : 'on', tries ? 'Reconnecting…' : 'Connecting…');

      let next;
      try { next = new WebSocket(url()); } catch (_) { return schedule(); }
      socket = next;

      next.onopen = function () {
        tries = 0;
        seated = false;
        expecting = null;
        // Every connection agrees its own key, so nothing survives a reconnect.
        opening = null;
        box = null;
        outgoing = null;
        incoming = null;
        // Not live yet: the socket is open, but nothing may be said on it until
        // the server has decided who is holding it. `ready` waits for @welcome.
        show('warn', 'Signing in…');
      };
      next.onmessage = function (event) { deliver(event.data); };
      next.onerror = function () { /* onclose always follows */ };
      next.onclose = function () {
        if (next !== socket) return;
        socket = null;
        seated = false;
        if (closing) return;
        // A refusal is not a network problem. Retrying every second would only
        // fill a log; the state stays on screen until something changes.
        if (stopped) { show('off', reasonText(stopped)); return; }
        schedule();
      };
    }

    /**
     * Why it is not connected, told apart rather than guessed at.
     *
     * "The tunnel is down" and "the laptop is awake but would not have me" look
     * identical from a dead socket, and on a phone that difference is the whole
     * question. The page itself came from the same origin, so asking it one
     * cheap question settles it.
     */
    function diagnose() {
      if (typeof fetch !== 'function') return;
      // Whatever the pill says when the answer comes back, it is more recent
      // than this question — and "your prompt was not sent" is the one message
      // that must not be quietly replaced by a weather report.
      const asked = said;
      const stale = () => live() || said !== asked;
      fetch(at('/health'), { cache: 'no-store' }).then(function (response) {
        if (!stale()) show('warn', response.ok ? 'The laptop is there — reconnecting' : 'Reconnecting…');
      }).catch(function () {
        if (!stale()) show('off', 'Cannot reach the laptop');
      });
    }

    function schedule() {
      show('off', tries ? 'Offline — retrying' : 'Offline');
      diagnose();
      const wait = BACKOFF[Math.min(tries, BACKOFF.length - 1)];
      tries++;
      if (retry) clearTimeout(retry);
      // A little jitter so a laptop waking up does not reconnect every tab at
      // exactly the same millisecond.
      retry = setTimeout(connect, wait + Math.floor(Math.random() * 250));
    }

    /**
     * Out. Handshake frames go in the clear — there is nothing agreed to seal
     * them with yet, and nothing in them worth hiding. Everything after is
     * sealed, in the order it was said: sealing is asynchronous, and a queue
     * that let two messages race would deliver them with counters that no
     * longer match the order the other end reads them in.
     */
    function send(message) {
      if (!box) return socket.send(JSON.stringify(message));
      const on = socket;
      outgoing = (outgoing || Promise.resolve())
        .then(function () { return box.seal(JSON.stringify(message)); })
        .then(function (frame) {
          if (on.readyState === 1) on.send(JSON.stringify(frame));
        })
        .catch(function () { /* a dead socket is not a message to retry */ });
    }

    function live() {
      return !!socket && socket.readyState === 1 && seated;
    }

    /**
     * A prompt that vanishes is worse than a prompt that was refused, so an
     * offline `send` comes straight back to the composer as an `editPrompt` —
     * the same message the host uses to hand back a queued prompt. The client
     * needs no branch for it, and the words are still there when the signal is.
     */
    function refuse(message) {
      if (message && message.type === 'send') {
        const images = (message.attachments || []).length;
        show('off', images ? 'Offline — not sent, images dropped' : 'Offline — not sent', 8000);
        // After the client has finished sending, not during it.
        tell({ type: 'editPrompt', text: message.text || '' });
      } else {
        show('off', 'Offline');
      }
    }

    // A phone closes sockets when the screen locks and a laptop closes them when
    // it sleeps; both come back through one of these.
    window.addEventListener('online', function () { tries = 0; stopped = null; connect(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !live()) { tries = 0; connect(); }
    });
    window.addEventListener('pagehide', function () {
      closing = true;
      if (socket) { try { socket.close(1001, 'leaving'); } catch (_) { /* gone */ } }
    });

    connect();

    return {
      postMessage: function (message) {
        if (message && message.type === 'ready') {
          // Asked for once, sent on every socket that gets a seat. Saying it
          // into a socket that is still signing in would only be dropped.
          wantsReady = true;
          if (!live()) return;
        }
        if (!live()) return refuse(message);
        try { send(message); } catch (_) { refuse(message); }
      },
      getState: state.getState,
      setState: state.setState,
      // Shown as a state, offered as an action: anything on the page that wants
      // a retry button can call this rather than reloading.
      retry: retryNow,
      reconnect: reconnect,
      // For the tests, and for anyone wondering in a console why nothing moves.
      __socket: function () { return socket; },
      /** Whether this connection is sealed, for anything that wants to say so. */
      sealed: function () { return !!box; },
      __state: function () { return live() ? 'online' : (stopped ? 'refused' : (tries ? 'reconnecting' : 'offline')); }
    };
  }

  /**
   * The seam. In the panel this is `acquireVsCodeApi()` and nothing else
   * happens; in a browser it is a socket wearing the same three methods.
   */
  window.nikTransport = function () {
    if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
    return socketTransport(window.NIKUI_REMOTE || {});
  };

  // Exported so the offline suite can drive it with a fake socket.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { socketTransport, conversationUrl, BACKOFF };
  }
})();
