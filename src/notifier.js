'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/**
 * The Mac's clickable banner: a small app, built here from notifier/main.swift.
 *
 * Built rather than shipped, so there is no binary in the repo nobody can read,
 * and built once — into VS Code's storage for NikUI, again only when its
 * source changes. That takes the Swift compiler from Apple's command line
 * tools; without it, or on anything but a Mac, `post` says so and the caller
 * falls back to a banner that cannot be clicked.
 *
 * Nothing here knows about VS Code: where to build and how to run things are
 * handed in.
 */

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'notifier', 'main.swift');
const ICON = path.join(ROOT, 'media', 'icons', 'nikui-512.png');
const BUNDLE_ID = 'com.nikoloz.nikui.notifier';
const EXECUTABLE = 'nikui-notify';

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>NikUI</string>
  <key>CFBundleDisplayName</key><string>NikUI</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`;

const defaultRun = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, Object.assign({ timeout: 120000 }, options), (err, stdout, stderr) => {
    resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});

class MacNotifier {
  /**
   * @param {object} deps
   * @param {string} deps.dir        where the app is built
   * @param {Function} [deps.run]    (file, args) => Promise<{ok, code, stdout, stderr}>
   * @param {string} [deps.platform]
   * @param {(line: string) => void} [deps.log]
   */
  constructor(deps) {
    this.dir = deps.dir;
    this.run = deps.run || defaultRun;
    this.platform = deps.platform || process.platform;
    this.log = deps.log || (() => {});
    this.app = this.dir ? path.join(this.dir, 'NikUI Notifier.app') : null;
    this.building = null;
    this.broken = null; // why it cannot be built, once that is known
  }

  get available() { return this.platform === 'darwin' && !!this.dir && !this.broken; }

  /** What the built app was made from, so a change to either rebuilds it. */
  stamp() {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(SOURCE));
    hash.update(PLIST);
    return hash.digest('hex').slice(0, 16);
  }

  isBuilt() {
    try {
      return fs.readFileSync(path.join(this.app, 'Contents', 'stamp'), 'utf8') === this.stamp() &&
        fs.existsSync(path.join(this.app, 'Contents', 'MacOS', EXECUTABLE));
    } catch (_) { return false; }
  }

  /** Build it if it is not built. One build at a time, however many ask. */
  ensure() {
    if (!this.available) return Promise.resolve(false);
    if (this.isBuilt()) return Promise.resolve(true);
    if (!this.building) {
      this.building = this.build().then((ok) => { this.building = null; return ok; });
    }
    return this.building;
  }

  async build() {
    const contents = path.join(this.app, 'Contents');
    const out = path.join(contents, 'MacOS', EXECUTABLE);
    fs.rmSync(this.app, { recursive: true, force: true });
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'Info.plist'), PLIST);

    const compiled = await this.run('/usr/bin/xcrun', ['swiftc', '-O', '-o', out, SOURCE,
      '-framework', 'Cocoa', '-framework', 'UserNotifications']);
    if (!compiled.ok) {
      this.broken = 'the Swift compiler is missing or failed' +
        (compiled.stderr ? ': ' + compiled.stderr.trim().split('\n').pop() : '') +
        '. Installing Apple’s command line tools (xcode-select --install) fixes it.';
      this.log('notifier: ' + this.broken);
      return false;
    }
    await this.icon(path.join(contents, 'Resources'));
    // Signed as itself, with no identity, which is what a Mac needs to let a
    // locally built app ask to send notifications.
    await this.run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', this.app]);
    await this.run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', this.app]);
    fs.writeFileSync(path.join(contents, 'stamp'), this.stamp());
    this.log('notifier: built ' + this.app);
    return true;
  }

  /** NikUI's own icon, so the banner is recognisably NikUI's. Optional. */
  async icon(resources) {
    const set = path.join(this.dir, 'AppIcon.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      await this.run('/usr/bin/sips', ['-z', String(size), String(size), ICON, '--out', path.join(set, `icon_${size}x${size}.png`)]);
      await this.run('/usr/bin/sips', ['-z', String(size * 2), String(size * 2), ICON, '--out', path.join(set, `icon_${size}x${size}@2x.png`)]);
    }
    await this.run('/usr/bin/iconutil', ['-c', 'icns', set, '-o', path.join(resources, 'AppIcon.icns')]);
    fs.rmSync(set, { recursive: true, force: true });
  }

  /**
   * Post one. Resolves with whether it was shown; `false` means use something
   * else this time.
   *
   * @param {object} n  { id, title, subtitle, body, url, app, folder }
   */
  async post(n) {
    if (!(await this.ensure())) return false;
    // Through `open`, so it runs as the app it is and macOS knows whose
    // notification this is. `-n`, because one may still be waiting on a click.
    const posted = await this.run('/usr/bin/open', ['-n', '-g', '-W', this.app, '--args', '--post',
      n.id, n.title, n.subtitle || '', n.body || '', n.url || '', n.app || '', n.folder || ''], { timeout: 60000 });
    if (!posted.ok) this.log('notifier: could not post' + (posted.stderr ? ': ' + posted.stderr.trim() : ''));
    return posted.ok;
  }
}

module.exports = { MacNotifier, BUNDLE_ID, SOURCE };
