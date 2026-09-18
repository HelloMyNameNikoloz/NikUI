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

    function url() {
      const at = new URL(config.socket || '/socket', window.location.href);
      at.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return at.toString();
    }

    function show(kind, text) {
      if (!pill) return;
      pill.className = 'link ' + kind;
      pill.textContent = text;
      pill.hidden = false;
    }

    /** Inbound frames arrive exactly as the webview's do: a message event. */
    function deliver(data) {
      let message = null;
      try { message = JSON.parse(data); } catch (_) { return; }
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
        seated = true;
        tries = 0;
        stopped = null;
        show('on', 'Live');
        if (wantsReady) send({ type: 'ready' });
        return false; // the page may want to know which device it is
      }
      if (message.type === '@navigate') {
        // Another instance, on this device only. The laptop's tabs are the
        // laptop's business.
        if (message.session) window.location.assign('/s/' + encodeURIComponent(message.session));
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

    function answer(challenge) {
      if (!window.nikDevice || !window.nikDevice.available()) {
        stopped = 'no device key';
        show('off', 'This device is not paired');
        return;
      }
      window.nikDevice.load().then(function (record) {
        if (!record || !record.id) {
          stopped = 'not paired';
          show('off', 'This device is not paired');
          window.dispatchEvent(new MessageEvent('message', {
            data: { type: '@denied', reason: 'This device is not paired.', pair: true }
          }));
          return;
        }
        // Pinning, from this side: the laptop that answers has to be the one
        // this device paired with, not merely something at the same address.
        if (record.fingerprint && challenge.fingerprint && record.fingerprint !== challenge.fingerprint) {
          stopped = 'wrong laptop';
          show('off', 'This is not the laptop this device paired with');
          window.dispatchEvent(new MessageEvent('message', {
            data: { type: '@denied', reason: 'This is not the laptop this device paired with.' }
          }));
          return;
        }
        const mine = randomNonce();
        return window.nikDevice.sign('nikui-auth:' + challenge.nonce + ':' + mine).then(function (signature) {
          send({ type: '@auth', device: record.id, nonce: mine, signature: signature });
        });
      }).catch(function () {
        stopped = 'could not sign';
        show('off', 'This device could not sign in');
      });
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
      fetch('/health', { cache: 'no-store' }).then(function (response) {
        if (!live()) show('warn', response.ok ? 'The laptop is there — reconnecting' : 'Reconnecting…');
      }).catch(function () {
        if (!live()) show('off', 'Cannot reach the laptop');
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

    function send(message) {
      socket.send(JSON.stringify(message));
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
        show('off', images ? 'Offline — not sent, images dropped' : 'Offline — not sent');
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'editPrompt', text: message.text || '' }
        }));
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
      // For the tests, and for anyone wondering in a console why nothing moves.
      __socket: function () { return socket; },
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
    module.exports = { socketTransport, BACKOFF };
  }
})();
