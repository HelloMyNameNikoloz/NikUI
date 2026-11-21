'use strict';

// P1's ownership contract. No native power/notification implementation is
// imported here; window policy and its existing watchdog remain in extension.js.
function createPolicyAuthority() {
  let holder = null;
  return {
    acquire(generation) {
      if (holder) throw Object.assign(new Error('Power/notification generation already owned'), { code: 'POLICY_OWNED' });
      const lease = Object.freeze({ generation });
      holder = lease;
      return { current: () => holder === lease, release() { if (holder === lease) holder = null; } };
    },
    get generation() { return holder && holder.generation; }
  };
}

/** One generation owns both power and local presentation. codexBusy is an
 * explicit count reader: service aggregation deliberately includes Codex, but
 * does not add Codex CI, ledger or completion notifications. The adapters must
 * release only this generation's assertions, lid/watchdog and banners.
 */
function createPolicyOwner({ authority, generation, power, notifications, settings,
  claudeBusy, codexBusy, serving = () => false, attended = () => false,
  isLookingAt = () => false, isCurrent = () => false, open = () => {} } = {}) {
  if (!authority || !generation || !power || !notifications || !settings ||
      typeof claudeBusy !== 'function' || typeof codexBusy !== 'function') {
    throw new Error('Explicit policy authority, generation, adapters, settings and Claude/Codex busy readers are required');
  }
  let lease = null, disposed = false, ready = null, recovered = false, closing = null, draining = null;
  const seen = new Set();
  const get = (key, fallback) => (typeof settings === 'function' ? settings() : settings).get(key, fallback);
  const current = () => !disposed && !!lease && lease.current();
  const count = (reader) => { const n = reader(); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Busy input must be a nonnegative count'); return n; };
  function reconsider() {
    if (!current() || !recovered) return;
    const busy = count(claudeBusy) + count(codexBusy);
    const enabled = !!get('keepAwake', false);
    power.awake(generation, enabled && (busy > 0 || !!serving()), busy ? 'work' : 'listener');
    // A listener alone never holds a closed laptop awake. Setup/authorization
    // is a separate attended-local operation; this interface cannot install it.
    power.lid(generation, !!get('lidClosed', false) && busy > 0);
  }
  function release() {
    if (!closing) closing = (async () => {
      if (!lease) return;
      await notifications.release(generation);
      await power.release(generation);
      lease.release();
      seen.clear();
    })();
    return closing;
  }
  return {
    generation,
    start() {
      if (disposed) throw new Error('Policy owner is closed');
      if (lease) return ready;
      lease = authority.acquire(generation);
      ready = Promise.resolve().then(() => power.recover(generation)).then(() => {
        recovered = true;
        if (current()) reconsider();
      }).catch(async (err) => { disposed = true; await release(); throw err; });
      return ready;
    },
    reconsider,
    // Call only for a policy event already selected by the caller (e.g. a
    // Claude completion). A repeated event cannot produce a second local banner.
    notify({ id, kind = 'done', target, title, body }) {
      if (!current() || !recovered || !id || seen.has(id)) return false;
      seen.add(id);
      if (!get(kind === 'ci' ? 'notifyCI' : 'notifyWhenDone', kind === 'ci')) return false;
      const captured = target && Object.freeze(structuredClone(target));
      if (get('notifyWhenDoneSound', true)) notifications.chime(generation);
      if (isLookingAt(captured)) return false;
      notifications.post(generation, { id, target: captured, title, body }, () => {
        if (current() && isCurrent(captured)) return open(captured);
        return false;
      });
      return true;
    },
    maySetUpLid(requester) { return current() && !!requester && requester.local === true && !!attended(requester); },
    state() { return { generation, owned: current(), codexBusy: count(codexBusy), claudeBusy: count(claudeBusy), fake: power.fake === true }; },
    dispose() {
      if (draining) return draining;
      disposed = true;
      // Keep the lease until BOTH adapters have released. A failed release
      // conservatively fences the next generation instead of overlapping it.
      draining = (async () => { if (ready) await ready.catch(() => {}); return release(); })();
      return draining;
    }
  };
}

// Recording fakes are also nikd's only P1 machine adapters. Preexisting machine
// state belongs to nobody here and is never changed or 'recovered'.
function createFakePolicyAdapters() {
  const events = [], owners = new Map(), banners = [];
  return {
    events, owners, banners,
    power: {
      fake: true,
      recover(generation) { events.push(['recover', generation]); },
      awake(generation, held, reason) { const state = owners.get(generation) || {}; owners.set(generation, { ...state, awake: held }); events.push(['awake', generation, held, reason]); },
      lid(generation, held) { const state = owners.get(generation) || {}; owners.set(generation, { ...state, lid: held }); events.push(['lid', generation, held]); },
      release(generation) { owners.delete(generation); events.push(['power-release', generation]); }
    },
    notifications: {
      chime(generation) { events.push(['chime', generation]); },
      post(generation, message, click) { banners.push({ generation, message, click, active: true }); events.push(['banner', generation]); },
      release(generation) { for (const banner of banners) if (banner.generation === generation) banner.active = false; events.push(['notifications-release', generation]); }
    }
  };
}

module.exports = { createPolicyAuthority, createPolicyOwner, createFakePolicyAdapters };
