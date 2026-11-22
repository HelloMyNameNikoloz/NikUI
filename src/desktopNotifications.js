'use strict';
const crypto = require('crypto');
const { fail } = require('./daemonPaths');
const KEY = 'engine.desktopNotifications.v1';
const eventID = (engineID, conversation, kind, source) => crypto.createHash('sha256')
  .update(JSON.stringify([engineID, conversation, kind, source])).digest('hex');

// The engine publishes facts; only the app presents desktop notifications.
// No helper invocation or notification authorization belongs to this module.
function createDesktopNotifications({ engine, engineID, authority, changed = () => {}, now = Date.now }) {
  let lane = Promise.resolve(), disposed = false, issue = null;
  const sessions = () => [...engine.manager.list, ...engine.codex.list];
  const pending = () => sessions().flatMap((session) => (session.items || [])
    .filter((item) => item.kind === 'permission' && !item.resolved)
    .map((item) => ({ conversationID: session.id, requestID: item.requestId, id: item.id })));
  function event(session, kind, item) {
    if (typeof item?.id !== 'string' || !item.id) return null;
    const provider = session.provider === 'codex' ? 'Codex' : 'Claude';
    const source = [item.id, item.requestId || null, item.at || null, item.run?.id || null, item.run?.turn || null,
      session.claudeSessionId || session.threadId || null];
    return { id: eventID(engineID, session.id, kind, source), engineID, conversationID: session.id, kind,
      title: provider + (kind === 'needs-you' ? ' needs an answer' : kind === 'failed' ? ' encountered an error' : ' finished'),
      body: String(kind === 'needs-you' ? 'Allow ' + (item.name || 'this action') + '?' : item.text || 'Open the conversation to view.').slice(0, 160),
      createdAt: Number.isSafeInteger(item.at) ? item.at : now() };
  }
  function candidates() {
    return sessions().flatMap((session) => {
      const items = session.items || [];
      const approvals = items.filter((item) => item.kind === 'permission' && !item.resolved).map((item) => event(session, 'needs-you', item));
      const last = items.findLast((item) => item.kind === 'result' || item.kind === 'notice' && item.level === 'error');
      if (last && !last.interrupted) approvals.push(event(session, last.isError || last.level === 'error' ? 'failed' : 'turn-finished', last));
      return approvals.filter(Boolean);
    });
  }
  const initial = new Set(candidates().filter((item) => item.kind !== 'needs-you').map((item) => item.id));
  function scan() {
    if (disposed) return lane;
    const captured = candidates();
    lane = lane.then(async () => {
      const existing = authority.snapshot().values[KEY];
      if (existing && Array.isArray(existing.seen) && captured.every((event) => existing.seen.includes(event.id))) {
        initial.clear(); issue = null; changed(); return;
      }
      await authority.commit((state) => {
        const saved = state.values[KEY] ||= { seen: [], events: [] };
        if (!Array.isArray(saved.seen) || !Array.isArray(saved.events)) throw fail('NOTIFICATION_STORE_CORRUPT', 'Notification publication ledger is corrupt');
        const known = new Set(saved.seen);
        for (const item of captured) {
          if (known.has(item.id)) continue;
          known.add(item.id);
          if (!initial.has(item.id)) saved.events.push(item);
        }
        // Keep current candidates at the newest end of the bounded window.
        // Quiet, still-pending approvals must not fall out as turns finish.
        for (const item of captured) { known.delete(item.id); known.add(item.id); }
        saved.seen = [...known].slice(-4096); saved.events = saved.events.slice(-128);
      });
      initial.clear(); issue = null; changed();
    }).catch((error) => { issue = error.code || 'NOTIFICATION_STORE_UNAVAILABLE'; changed(); });
    return lane;
  }
  engine.manager.on('changed', scan); engine.codex.on('changed', scan);
  scan();
  return {
    snapshot: () => ({ engineID, events: structuredClone(authority.snapshot().values[KEY]?.events || []),
      pendingApprovals: pending(), issue }),
    identity(kind, message) {
      const session = sessions().find((s) => s.id === message.session);
      const item = candidates().findLast((e) => e.conversationID === session?.id && e.kind === kind);
      return item?.id || null;
    },
    scan, flush: () => lane,
    async dispose() { disposed = true; engine.manager.off('changed', scan); engine.codex.off('changed', scan); await lane; }
  };
}
module.exports = { KEY, eventID, createDesktopNotifications };
