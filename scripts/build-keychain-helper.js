#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { privateDirectory, noSymlinks } = require('../src/daemonPaths');

// Tests run with HOME pointed at a throwaway profile, which hides the
// signing identity. Sign from the real account's login keychain (getpwuid,
// not $HOME) so test isolation never changes which identity signs.
function signingKeychainArgs({ userHome = () => require('os').userInfo().homedir, exists = fs.existsSync } = {}) {
  const keychain = path.join(userHome(), 'Library/Keychains/login.keychain-db');
  return exists(keychain) ? ['--keychain', keychain] : [];
}

// Builds an isolated helper bundle only. No registration, installation or
// selection of user profiles/services. Round 3 signs it again in the package.
function buildKeychainHelper({ output, identity = 'Apple Development', testOnly = true, moduleCache, version = '1' } = {}) {
  if (!path.isAbsolute(output || '') || !identity || typeof testOnly !== 'boolean') throw new Error('Explicit helper output and signing identity required');
  noSymlinks(output);
  if (fs.existsSync(output)) throw new Error('Helper output already exists');
  const contents = path.join(output, 'Contents'), executable = path.join(contents, 'MacOS/NikKeychain');
  privateDirectory(path.dirname(output), false);
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  const cache = moduleCache || path.join(path.dirname(output), 'swift-module-cache'); privateDirectory(cache);
  if (!/^[0-9]+$/.test(version)) throw new Error('Numeric helper version required');
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos14.0', '-module-cache-path', cache,
    path.resolve(__dirname, '../helpers/keychain/main.swift'), '-o', executable], { stdio: 'pipe' });
  const kind = testOnly ? 'test' : 'dev', bundle = 'com.nikui.engine.' + kind + '.keychain';
  const info = path.join(contents, 'Info.plist');
  fs.writeFileSync(info, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundle}</string>
<key>CFBundleExecutable</key><string>NikKeychain</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSBackgroundOnly</key><true/>
<key>NikKeychainServicePrefix</key><string>com.nikui.engine.${kind}.</string>
<key>NikKeychainBackend</key><string>login-file-keychain</string>
</dict></plist>\n`, { mode: 0o600 });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, ...signingKeychainArgs(), '--timestamp=none', '--options', 'runtime', output], { stdio: 'pipe' });
  const inspected = require('child_process').spawnSync('/usr/bin/codesign', ['-dvv', output], { encoding: 'utf8' });
  if (!/^TeamIdentifier=([A-Z0-9]{10})$/m.test(inspected.stderr)) throw new Error('A team-signed helper is required');
  // Replacing the inode avoids a stale kernel signature cache after swiftc's
  // ad-hoc signature and the two explicit signing passes. Bytes stay identical.
  const fresh = executable + '.fresh'; fs.copyFileSync(executable, fresh); fs.chmodSync(fresh, 0o700); fs.renameSync(fresh, executable);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', output], { stdio: 'pipe' });
  return { executable, backend: 'login-file-keychain', servicePrefix: 'com.nikui.engine.' + kind + '.', target: 'arm64-apple-macos14.0' };
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(buildKeychainHelper({ output: process.argv[2], identity: process.argv[3] || 'Apple Development' })) + '\n'); }
  catch (_) { process.stderr.write('Helper build/sign failed\n'); process.exitCode = 1; }
}
module.exports = { buildKeychainHelper, signingKeychainArgs };
