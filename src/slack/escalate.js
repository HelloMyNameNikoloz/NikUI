'use strict';

/**
 * The waiting clock: a pure state machine with no timer of its own. Given
 * when something arrived and asked, at any later moment, what is now due.
 * Keeping the clock out of it is what makes this testable without a real
 * minute ever passing, and keeps the service free to use one timer for
 * everything instead of one per message.
 *
 * "Original arrival time" is the point: a second message in a conversation
 * someone is already waiting on does not buy the sender three more minutes —
 * the person has been waiting since the first one.
 */

/**
 * @param {object} opts
 * @param {number} opts.popupAfterMs
 * @param {number} opts.alarmAfterMs
 */
function createEscalator({ popupAfterMs, alarmAfterMs }) {
  // key -> { arrivedAt, item, firedPopup, firedAlarm }
  const entries = new Map();

  /**
   * A message that might need an answer. If its conversation (and thread, for
   * a threaded mention) is already pending, only the text/ts are refreshed —
   * the deadlines do not move.
   *
   * @param {{key: string, conversationId: string, ts: string, threadTs?: string,
   *   from: string, kind: 'vip'|'mention', text: string}} item
   * @param {number} now
   */
  function arrive(item, now) {
    const existing = entries.get(item.key);
    if (existing) {
      existing.item = Object.assign({}, existing.item, item);
      return;
    }
    entries.set(item.key, { arrivedAt: now, item: Object.assign({}, item), firedPopup: false, firedAlarm: false });
  }

  /**
   * Stop waiting on something — because it was seen, answered, or looked at
   * in NikUI. Matches by the item's own key or by its conversation, so a
   * reply in a conversation clears whatever in it was pending.
   */
  function resolve(keyOrConversationId) {
    for (const [key, entry] of entries) {
      if (key === keyOrConversationId || entry.item.conversationId === keyOrConversationId) {
        entries.delete(key);
      }
    }
  }

  /** What has newly crossed a deadline, each action firing at most once per item. */
  function due(now) {
    const fired = [];
    for (const entry of entries.values()) {
      if (!entry.firedPopup && now >= entry.arrivedAt + popupAfterMs) {
        entry.firedPopup = true;
        fired.push({ action: 'popup', item: entry.item });
      }
      if (!entry.firedAlarm && now >= entry.arrivedAt + alarmAfterMs) {
        entry.firedAlarm = true;
        fired.push({ action: 'alarm', item: entry.item });
      }
    }
    return fired;
  }

  /** Everything still waiting on an answer, newest arrival state included. */
  function pending() {
    return [...entries.values()].map((entry) => ({
      item: entry.item, arrivedAt: entry.arrivedAt, firedPopup: entry.firedPopup, firedAlarm: entry.firedAlarm
    }));
  }

  /** The earliest moment anything still becomes due, or null if nothing is waiting. */
  function nextAt() {
    let earliest = null;
    for (const entry of entries.values()) {
      const next = !entry.firedPopup ? entry.arrivedAt + popupAfterMs
        : !entry.firedAlarm ? entry.arrivedAt + alarmAfterMs
        : null;
      if (next !== null && (earliest === null || next < earliest)) earliest = next;
    }
    return earliest;
  }

  return { arrive, resolve, due, pending, nextAt };
}

module.exports = { createEscalator };
