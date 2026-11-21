'use strict';

/**
 * The phone app's newest build, as this laptop has it.
 *
 * `npm run sync` and Gradle leave an APK in the app's build folder. A paired
 * phone asks over its socket whether that APK is newer than itself, and if so
 * downloads it by a short-lived address only that answer carries — so an
 * update reaches the phone wherever the tailnet does, with no cable and no
 * debugging switched on.
 *
 * "Newer" is a fingerprint, not a version number: the build writes one into
 * the bundle's `version.json`, the phone reads its own, and this reads the one
 * inside the APK. Two builds of the same code have the same fingerprint, so a
 * phone is never offered what it already runs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const TOKEN_MS = 10 * 60 * 1000;
const ENTRY = 'assets/public/version.json';

class AppUpdate {
  constructor(opts) {
    this.file = opts.file;
    this.log = opts.log || (() => {});
    this.cached = null;
    this.tokens = new Map();
    this.watching = null;
  }

  /** What the APK on disk is, or null when there is none to offer. */
  current() {
    let stat;
    try { stat = fs.statSync(this.file); } catch (_) { return null; }
    if (!stat.isFile()) return null;
    const key = stat.size + ':' + stat.mtimeMs;
    if (this.cached && this.cached.key === key) return this.cached.info;
    let info = null;
    try {
      const body = fs.readFileSync(this.file);
      const inside = readZipEntry(body, ENTRY);
      const version = inside ? JSON.parse(inside.toString('utf8')) : null;
      if (version && typeof version.build === 'string') {
        info = {
          build: version.build,
          version: String(version.app || ''),
          size: body.length,
          sha256: crypto.createHash('sha256').update(body).digest('hex'),
          at: stat.mtimeMs
        };
      } else {
        this.log('the app build has no fingerprint in it, so it is not offered');
      }
    } catch (err) {
      this.log('the app build could not be read: ' + (err && err.message));
    }
    this.cached = { key, info };
    return info;
  }

  /** An address good for one device, for a few minutes, for this one build. */
  issue(deviceId) {
    const info = this.current();
    if (!info) return null;
    this.sweep();
    const token = crypto.randomBytes(24).toString('base64url');
    this.tokens.set(token, { device: deviceId || null, sha256: info.sha256, until: Date.now() + TOKEN_MS });
    return token;
  }

  /**
   * The file for a token, if the token is live and the APK is still the one it
   * was issued for. A rebuild in between means the phone should ask again —
   * otherwise it would install something it was never told the checksum of.
   */
  redeem(token) {
    this.sweep();
    const held = token && this.tokens.get(String(token));
    if (!held) return null;
    const info = this.current();
    if (!info || info.sha256 !== held.sha256) return null;
    return { file: this.file, size: info.size, device: held.device };
  }

  sweep() {
    const now = Date.now();
    for (const [token, held] of this.tokens) if (held.until < now) this.tokens.delete(token);
  }

  /** Told when the APK changes, so a phone that is looking hears at once. */
  watch(changed) {
    if (this.watching) return;
    let last = this.stamp();
    this.watching = setInterval(() => {
      const now = this.stamp();
      if (now === last) return;
      last = now;
      // A build still being written changes size twice in a row; the
      // fingerprint is read when somebody asks, so this only says "ask".
      changed();
    }, 4000);
    if (this.watching.unref) this.watching.unref();
  }

  stamp() {
    try { const s = fs.statSync(this.file); return s.size + ':' + s.mtimeMs; } catch (_) { return null; }
  }

  stop() {
    if (this.watching) clearInterval(this.watching);
    this.watching = null;
  }
}

/**
 * One file out of a zip, which is what an APK is. Enough of the format for
 * that: the central directory at the end says where each entry starts and
 * whether it is stored or deflated.
 */
function readZipEntry(zip, name) {
  const min = Math.max(0, zip.length - 65557);
  let end = -1;
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count && at + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entry = zip.toString('utf8', at + 46, at + 46 + nameLength);
    if (entry === name) {
      if (zip.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + packed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** Where this checkout's Gradle leaves the app, if this is a checkout. */
function defaultApk(root) {
  return path.join(root, 'app', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
}

module.exports = { AppUpdate, readZipEntry, defaultApk };
