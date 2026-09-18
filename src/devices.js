'use strict';

const crypto = require('crypto');
const { verifyWith, readPublicKey } = require('./identity');

/**
 * The devices allowed to connect, and what each of them did.
 *
 * A record holds a public key and nothing secret: the phone's private key never
 * leaves the phone and cannot be exported even by the page that made it, so the
 * worst this store can leak is which devices exist.
 *
 * A device is `control: false` when it pairs. Watching is granted by pairing;
 * steering — which is arbitrary code execution on this machine, given that
 * NikUI runs Claude with permissions bypassed — is a second, deliberate act.
 */

const DEVICES = 'nikui.devices';
const TRAIL = 'nikui.deviceTrail';

// Enough to answer "what did that phone do last night" without growing forever.
const TRAIL_LIMIT = 300;

class DeviceStore {
  /** @param {{get: Function, update: Function}} memento globalState, or anything shaped like it */
  constructor(memento, options) {
    this.memento = memento;
    this.now = (options && options.now) || (() => Date.now());
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) {
      try { fn(); } catch (_) { /* a view's problem, not the store's */ }
    }
  }

  list() {
    const saved = this.memento.get(DEVICES, []);
    return Array.isArray(saved) ? saved : [];
  }

  get(id) {
    if (!id) return null;
    return this.list().find((device) => device.id === id) || null;
  }

  save(devices) {
    this.memento.update(DEVICES, devices);
    this.changed();
  }

  /**
   * Remember a device that has just proved it holds the private key for this
   * public one. Read-only until somebody says otherwise.
   */
  add({ name, publicKey, address, protection, biometric }) {
    const key = readPublicKey(publicKey);
    if (!key) return null;
    const devices = this.list();
    // The same phone pairing again keeps its name and its grant rather than
    // arriving as a stranger — it is the same key, which is the identity.
    const existing = devices.find((device) => device.publicKey === key.spki);
    const at = this.now();
    if (existing) {
      existing.name = cleanName(name) || existing.name;
      existing.pairedAt = at;
      existing.lastSeenAt = at;
      existing.lastAddress = address || existing.lastAddress || null;
      existing.protection = cleanProtection(protection);
      existing.biometric = !!biometric;
      this.save(devices);
      return existing;
    }
    const device = {
      id: crypto.randomBytes(9).toString('base64url'),
      name: cleanName(name) || 'A device',
      publicKey: key.spki,
      fingerprint: key.fingerprint,
      pairedAt: at,
      lastSeenAt: at,
      lastAddress: address || null,
      control: false,
      // How the device says it is holding the key. Reported, not proved: a
      // laptop cannot tell a Secure Enclave from a claim about one without
      // platform attestation. It is shown as what the device said, because a
      // label that looked like a guarantee would be worse than none.
      protection: cleanProtection(protection),
      biometric: !!biometric
    };
    devices.push(device);
    this.save(devices);
    return device;
  }

  /** Does this device hold the key it paired with? */
  verify(id, message, signature) {
    const device = this.get(id);
    if (!device) return false;
    return verifyWith(device.publicKey, message, signature);
  }

  /**
   * The same device, now holding a better key.
   *
   * This exists because the alternative is worse. A phone that paired with a
   * browser key and later gains a Secure Enclave would otherwise have to pair
   * again — which means being at the laptop, which is the one place you are not
   * when any of this matters.
   *
   * The authorisation is the key being replaced: the caller has already checked
   * that the old key signed for this exact new one, and that the new one signed
   * back. So the grant, the name and the id all survive — it is the same device
   * and it has proved it.
   *
   * It is recorded loudly. If an old key were stolen, this is how the thief
   * would make the theft permanent, and the honest defence against that is not
   * to forbid the move but to make sure it is never quiet.
   */
  rekey(id, { publicKey, protection, biometric }) {
    const key = readPublicKey(publicKey);
    if (!key) return null;
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device) return null;
    // One key, one device: two records sharing a key would make "which device
    // is this" unanswerable, and the trail meaningless.
    if (devices.some((d) => d.id !== id && d.publicKey === key.spki)) return null;
    if (device.publicKey === key.spki) return device;

    const at = this.now();
    device.previousFingerprint = device.fingerprint;
    device.publicKey = key.spki;
    device.fingerprint = key.fingerprint;
    device.protection = cleanProtection(protection);
    device.biometric = !!biometric;
    device.rekeyedAt = at;
    device.lastSeenAt = at;
    this.save(devices);
    this.record({
      device, allowed: true,
      action: 'replaced its key',
      detail: `now held in ${device.protection}` + (device.biometric ? ', behind a biometric check' : '')
    });
    return device;
  }

  touch(id, address) {
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device) return null;
    device.lastSeenAt = this.now();
    if (address) device.lastAddress = address;
    this.save(devices);
    return device;
  }

  /**
   * Where to reach a device when nobody is looking at it.
   *
   * The subscription lives on the device's own record, so forgetting a device
   * forgets where to reach it — there is no second list to remember to clean.
   */
  subscribe(id, subscription) {
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device) return null;
    device.push = {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      at: this.now()
    };
    this.save(devices);
    return device;
  }

  /**
   * Where to reach an iPhone that is not running.
   *
   * A different thing from a web-push subscription and kept separately: one is
   * a browser's, one is the app's, and a phone can hold both without either
   * meaning the other.
   */
  subscribeApple(id, token) {
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device) return null;
    const hex = String(token || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (hex.length < 32 || hex.length > 200) return null;
    device.apns = { token: hex, at: this.now() };
    this.save(devices);
    return device;
  }

  unsubscribeApple(id) {
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device || !device.apns) return false;
    delete device.apns;
    this.save(devices);
    return true;
  }

  /** Every iPhone that has told us where to find it. */
  appleSubscribers() {
    return this.list().filter((device) => device.apns && device.apns.token);
  }

  /** A subscription the push service says is dead is not worth keeping. */
  unsubscribe(id) {
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device || !device.push) return false;
    delete device.push;
    this.save(devices);
    return true;
  }

  /** Everyone who has asked to be told. */
  subscribers() {
    return this.list().filter((device) => device.push && device.push.endpoint);
  }

  setControl(id, allowed) {
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device) return null;
    device.control = !!allowed;
    device.controlChangedAt = this.now();
    this.save(devices);
    this.record({ device, action: allowed ? 'granted control' : 'control revoked', allowed: true });
    return device;
  }

  rename(id, name) {
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device) return null;
    device.name = cleanName(name) || device.name;
    this.save(devices);
    return device;
  }

  forget(id) {
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device) return false;
    this.save(devices.filter((d) => d.id !== id));
    this.record({ device, action: 'forgotten', allowed: true });
    return true;
  }

  // ---- what a device did ---------------------------------------------------

  /**
   * Everything that arrives from a device, kept whether it was allowed or not:
   * a refused attempt is the entry you would most want to find later.
   */
  record(entry) {
    const device = entry.device || {};
    const line = {
      at: this.now(),
      deviceId: device.id || null,
      device: device.name || 'unknown device',
      action: String(entry.action || ''),
      instance: entry.instance || null,
      allowed: entry.allowed !== false,
      detail: entry.detail ? String(entry.detail).slice(0, 120) : null
    };
    const trail = this.trail();
    trail.push(line);
    while (trail.length > TRAIL_LIMIT) trail.shift();
    this.memento.update(TRAIL, trail);
    this.changed();
    return line;
  }

  trail() {
    const saved = this.memento.get(TRAIL, []);
    return Array.isArray(saved) ? saved.slice() : [];
  }

  /** Newest first, for anything that shows it. */
  recent(count) {
    return this.trail().reverse().slice(0, count || 25);
  }

  clearTrail() {
    this.memento.update(TRAIL, []);
    this.changed();
  }
}

/**
 * Where the device says its key is. An allowlist, because it arrives from the
 * device and is shown to a person: an unknown word is `unknown`, not whatever
 * the device felt like putting on the screen.
 */
const HOLDINGS = ['secure-enclave', 'strongbox', 'keystore', 'software'];
function cleanProtection(reported) {
  const said = String(reported == null ? '' : reported).toLowerCase();
  if (HOLDINGS.includes(said)) return said;
  return said ? 'unknown' : 'software';
}

/**
 * A name a phone chose for itself, which is a string from somewhere else: no
 * control characters, no newlines, and short enough to sit in a tree row.
 */
function cleanName(name) {
  return String(name == null ? '' : name)
    .replace(/[ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

module.exports = { DeviceStore, cleanName, cleanProtection, HOLDINGS, TRAIL_LIMIT };
