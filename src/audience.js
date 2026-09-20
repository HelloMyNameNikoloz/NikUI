'use strict';

/**
 * Which phone should be told, and when it should stop being told.
 *
 * Broadcasting was fine when there was one phone. With two it is wrong in a way
 * that matters: you send a prompt from the phone in your hand, and the tablet on
 * the kitchen table buzzes about it an hour later. So a notification has an
 * owner — the device that asked for the work — and only the owner hears about
 * it.
 *
 * The second half is about not buzzing a phone nobody is holding. A device that
 * has not been used for an hour is not somebody waiting for an answer; it is a
 * phone in a drawer. But the hour cannot simply silence it, because the whole
 * point of this feature is the job that takes ninety minutes — you sent it,
 * went away, and the answer is exactly what you wanted to know.
 *
 * So the rule is about *what it asked for* rather than only about the clock:
 *
 *   A device hears about an instance it steered, however long that took.
 *   Delivering to one that has since gone quiet is the last thing it hears:
 *   after that it is dormant, and dormant devices are told nothing at all.
 *   Using the app again wakes it, and it hears everything once more.
 *
 * Which gives the behaviour somebody actually wants. Forty minutes: a
 * notification, and the phone is still awake. Ninety: still a notification,
 * because you are the one who asked — and then silence, until you pick the
 * phone up.
 */

// Long enough that a lunch break does not count as putting the phone down, and
// short enough that a phone left overnight is not still being buzzed at nine in
// the morning by something you asked for at six.
const AWAKE_MS = 60 * 60 * 1000;

class Audience {
  /**
   * @param {{now?: () => number, awakeMs?: number}} [deps]
   */
  constructor(deps) {
    const d = deps || {};
    this.now = d.now || (() => Date.now());
    this.awakeMs = d.awakeMs || AWAKE_MS;
    /** deviceId -> { lastActiveAt, dormant } */
    this.devices = new Map();
    /** instanceId -> { device, at } */
    this.owners = new Map();
    /** The last device to steer anything at all, for news that is nobody's instance. */
    this.latest = null;
  }

  seat(id) {
    let seat = this.devices.get(id);
    if (!seat) {
      seat = { lastActiveAt: 0, dormant: false };
      this.devices.set(id, seat);
    }
    return seat;
  }

  /**
   * A device did something — opened a screen, asked for the status, anything.
   *
   * This is what "using the app" means, and it is the only thing that clears
   * dormancy: a phone that is being looked at is a phone worth telling.
   */
  active(deviceId) {
    if (!deviceId) return;
    const seat = this.seat(deviceId);
    seat.lastActiveAt = this.now();
    seat.dormant = false;
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
    if (!seat || seat.dormant) return false;
    return this.now() - seat.lastActiveAt <= this.awakeMs;
  }

  dormant(deviceId) {
    const seat = this.devices.get(deviceId);
    return !!(seat && seat.dormant);
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
    const id = (owner && owner.device) || this.latest || this.nearest();
    if (!id) return null;
    // Dormant is the end of it until somebody picks the phone up. Everything
    // else — awake, or merely owed because it asked for this — is told.
    if (this.dormant(id)) return null;
    return id;
  }

  /** The phone most recently in somebody's hand, if any of them still is. */
  nearest() {
    let best = null;
    for (const [id, seat] of this.devices) {
      if (seat.dormant || !this.awake(id)) continue;
      if (!best || seat.lastActiveAt > best.at) best = { id, at: seat.lastActiveAt };
    }
    return best ? best.id : null;
  }

  /**
   * Said, and what that costs.
   *
   * Telling a phone that has been quiet for an hour is allowed once, because it
   * asked for the thing it is being told about. It is also the last thing it
   * hears: anything after that is a phone in a drawer being buzzed about work
   * nobody is waiting for.
   */
  delivered(deviceId, instanceId) {
    if (!deviceId) return false;
    if (instanceId) this.owners.delete(String(instanceId));
    const seat = this.seat(deviceId);
    const stale = this.now() - seat.lastActiveAt > this.awakeMs;
    if (stale) seat.dormant = true;
    return stale;
  }

  /** For the status sheet and the tests: what this thinks is going on. */
  state() {
    const out = [];
    for (const [id, seat] of this.devices) {
      out.push({
        device: id,
        lastActiveAt: seat.lastActiveAt,
        dormant: seat.dormant,
        awake: this.awake(id)
      });
    }
    return { devices: out, latest: this.latest, owners: [...this.owners.entries()] };
  }
}

module.exports = { Audience, AWAKE_MS };
