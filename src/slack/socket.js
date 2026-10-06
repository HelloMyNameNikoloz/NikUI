'use strict';

/**
 * Socket Mode: a WebSocket Slack opens for us, over which it pushes events as
 * they happen rather than waiting to be asked. It is a speed-up, never a
 * requirement — whether user-scoped events even arrive this way is something
 * nobody here could confirm, so the service polls regardless and this just
 * makes a reply feel instant when it works.
 *
 * The URL is one-shot: each `apps.connections.open` hands back a fresh
 * WebSocket URL good for one connection, so a reconnect means asking again,
 * not retrying the old address.
 */

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * @param {object} deps
 * @param {{call: Function}} deps.api
 * @param {Function} [deps.WebSocket]  constructor; defaults to globalThis.WebSocket
 * @param {(event: object, authorizations: object[]) => void} deps.onEvent
 * @param {(state: {socket: string, error?: string}) => void} deps.onState
 * @param {Function} [deps.setTimeout]
 * @param {Function} [deps.clearTimeout]
 * @param {(line: string) => void} [deps.log]
 */
function createSocket(deps) {
  const api = deps.api;
  const WS = deps.WebSocket || (typeof globalThis !== 'undefined' ? globalThis.WebSocket : undefined);
  const onEvent = deps.onEvent || (() => {});
  const onState = deps.onState || (() => {});
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const log = deps.log || (() => {});

  let ws = null;
  let stopped = true;
  let backoffIndex = 0;
  let reconnectTimer = null;

  function report(state) {
    onState(Object.assign({ socket: 'off' }, state));
  }

  function start() {
    if (!WS) {
      report({ socket: 'unavailable' });
      return;
    }
    stopped = false;
    backoffIndex = 0;
    connect();
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } catch (_) { /* already gone */ }
      ws = null;
    }
  }

  async function connect() {
    if (stopped) return;
    report({ socket: 'connecting' });
    let url;
    try {
      const opened = await api.call('apps.connections.open', {}, { app: true });
      url = opened.url;
    } catch (err) {
      if (err && err.code === 'invalid_auth') {
        stopped = true;
        report({ socket: 'off', error: 'Slack refused the app-level token — connect again.' });
        return;
      }
      scheduleReconnect();
      return;
    }
    if (stopped) return;

    try {
      ws = new WS(url);
    } catch (_) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => { backoffIndex = 0; };
    ws.onmessage = (event) => handleFrame(event && event.data);
    ws.onclose = () => { if (!stopped) scheduleReconnect(); };
    ws.onerror = () => { /* onclose follows; nothing more to do here */ };
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
    backoffIndex++;
    report({ socket: 'connecting' });
    reconnectTimer = setTimer(() => { reconnectTimer = null; connect(); }, delay);
  }

  function handleFrame(raw) {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch (_) { return; }

    if (frame.type === 'hello') {
      report({ socket: 'live' });
      return;
    }

    if (frame.type === 'events_api') {
      // Ack first — Slack resends if it doesn't hear back in time, and this
      // is the only thing that counts as hearing back.
      ack(frame.envelope_id);
      const payload = frame.payload || {};
      if (payload.event) onEvent(payload.event, payload.authorizations || []);
      return;
    }

    if (frame.type === 'disconnect') {
      if (frame.reason === 'link_disabled') {
        stopped = true;
        report({ socket: 'off', error: 'Slack disabled this connection — reconnect from settings.' });
        if (ws) { try { ws.close(); } catch (_) { /* already gone */ } ws = null; }
        return;
      }
      // 'warning' or 'refresh_requested': Slack is about to drop this socket
      // on its own. Get a fresh URL before it does, rather than waiting for
      // the close to notice.
      backoffIndex = 0;
      connect();
      return;
    }
  }

  function ack(envelopeId) {
    if (!envelopeId || !ws) return;
    try { ws.send(JSON.stringify({ envelope_id: envelopeId })); } catch (_) { /* socket already gone */ }
  }

  return { start, stop };
}

module.exports = { createSocket, BACKOFF_MS };
