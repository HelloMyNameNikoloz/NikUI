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
      window.dispatchEvent(new MessageEvent('message', { data: message }));
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
        show('on', 'Live');
        // The hub answers `ready` with `init`, which repaints the whole
        // conversation — the same path a webview takes when VS Code throws it
        // away and brings it back. Nothing is replayed twice.
        if (wantsReady) send({ type: 'ready' });
      };
      next.onmessage = function (event) { deliver(event.data); };
      next.onerror = function () { /* onclose always follows */ };
      next.onclose = function () {
        if (next !== socket) return;
        socket = null;
        if (closing) return;
        schedule();
      };
    }

    function schedule() {
      show('off', tries ? 'Offline — retrying' : 'Offline');
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
      return !!socket && socket.readyState === 1;
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
    window.addEventListener('online', function () { tries = 0; connect(); });
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
        if (message && message.type === 'ready') wantsReady = true;
        if (!live()) return refuse(message);
        try { send(message); } catch (_) { refuse(message); }
      },
      getState: state.getState,
      setState: state.setState,
      // For the tests, and for anyone wondering in a console why nothing moves.
      __socket: function () { return socket; },
      __state: function () { return live() ? 'online' : (tries ? 'reconnecting' : 'offline'); }
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
