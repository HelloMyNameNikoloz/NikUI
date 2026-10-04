'use strict';

/**
 * Which phone should be told.
 *
 * Broadcasting was fine when there was one phone. With two it is wrong in a way
 * that matters: you send a prompt from the phone in your hand, and the tablet on
 * the kitchen table buzzes about it. So a notification has an owner — the
 * device that asked for the work — and only the owner hears about it.
 *
 * What this no longer does is decide a phone is not worth telling because it
 * has not been used for a while. A phone nobody has touched for two hours is
 * the phone in the pocket of somebody who left the house, and anything the
 * laptop would say is exactly what they want to hear. So nothing is ever
 * dropped here: when nobody owns the news it goes to the phone held most
 * recently, and when no phone has been seen at all — the window was just
 * reloaded — it goes to every paired device.
 */

const AWAKE_MS = 60 * 60 * 1000;

class Audience {
  /**
   * @param {{now?: () => number, awakeMs?: number}} [deps]
   */
  constructor(deps) {
    const d = deps || {};
    this.now = d.now || (() => Date.now());
    this.awakeMs = d.awakeMs || AWAKE_MS;
    /** deviceId -> { lastActiveAt } */
    this.devices = new Map();
    /** instanceId -> { device, at } */
    this.owners = new Map();
    /** The last device to steer anything at all, for news that is nobody's instance. */
    this.latest = null;
  }

  seat(id) {
    let seat = this.devices.get(id);
    if (!seat) {
      seat = { lastActiveAt: 0 };
      this.devices.set(id, seat);
    }
    return seat;
  }

  /**
   * A device did something — opened a screen, asked for the status, anything.
   *
   * This is what "using the app" means: the phone most recently in a hand is
   * the one told about work nobody in particular asked for.
   */
  active(deviceId) {
    if (!deviceId) return;
    const seat = this.seat(deviceId);
    seat.lastActiveAt = this.now();
  }

  /**
   * A device sent a prompt to an instance. It now owns what comes of it.
   *
   * Ownership is last-writer-wins, deliberately: if you start something on the
   * tablet and then push it along from your phone, the phone in your hand is
   * the one that should buzz.
   */
  steered(instanceId, deviceId) {
    if (!deviceId) return;
    this.active(deviceId);
    this.latest = deviceId;
    if (instanceId) this.owners.set(String(instanceId), { device: deviceId, at: this.now() });
  }

  /** A device that is gone should not own anything. */
  forget(deviceId) {
    this.devices.delete(deviceId);
    if (this.latest === deviceId) this.latest = null;
    for (const [instance, owner] of [...this.owners]) {
      if (owner.device === deviceId) this.owners.delete(instance);
    }
  }

  awake(deviceId) {
    const seat = this.devices.get(deviceId);
    if (!seat) return false;
    return this.now() - seat.lastActiveAt <= this.awakeMs;
  }

  /**
   * Who should be told about this, if anybody.
   *
   * News about an instance goes to whoever steered that instance. News that
   * belongs to no instance — the quota running out — goes to whoever steered
   * anything most recently, which is the same rule read one level up.
   *
   * @returns {string|null} the device to tell
   */
  who(instanceId) {
    const owner = instanceId ? this.owners.get(String(instanceId)) : null;
    // Whoever steered this, else whoever steered anything last, else whoever is
    // simply holding a phone. The last of those matters more than it looks:
    // most instances are started at the laptop, and without it a phone would
    // only ever hear about work it had sent itself — which is silence for
    // nearly everything somebody would want to be told about.
    // Null means nobody has been seen since this window started: everyone.
    return (owner && owner.device) || this.latest || this.nearest();
  }

  /** The phone most recently in somebody's hand, however long ago. */
  nearest() {
    let best = null;
    for (const [id, seat] of this.devices) {
      if (!best || seat.lastActiveAt > best.at) best = { id, at: seat.lastActiveAt };
    }
    return best ? best.id : null;
  }

  /** Said: the instance's news has reached its owner, and is nobody's now. */
  delivered(deviceId, instanceId) {
    if (instanceId) this.owners.delete(String(instanceId));
    return false;
  }

  /** For the status sheet and the tests: what this thinks is going on. */
  state() {
    const out = [];
    for (const [id, seat] of this.devices) {
      out.push({
        device: id,
        lastActiveAt: seat.lastActiveAt,
        awake: this.awake(id)
      });
    }
    return { devices: out, latest: this.latest, owners: [...this.owners.entries()] };
  }
}

module.exports = { Audience, AWAKE_MS };
