#!/usr/bin/env node
'use strict';

// The app's own native sources, put into the Xcode project.
//
//   node app/tools/xcode.js
//
// Android finds source files by looking in a folder. Xcode does not: a .swift
// file that is not listed in project.pbxproj is a file Xcode will happily let
// you edit and will never compile, and the symptom on the phone is a plugin
// that silently does not exist. `npx cap sync` does not add it either — it
// manages pods, not sources.
//
// So this does, idempotently, with identifiers derived from the path rather
// than invented, so running it twice changes nothing and a checkout on another
// machine produces the same file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP = path.join(__dirname, '..');
const PROJECT = path.join(APP, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

/**
 * Folders under ios/App/App/ holding this app's own native code.
 *
 * Found rather than listed. A list is a thing to forget, and forgetting it here
 * does not fail loudly: the plugin compiles nowhere, is registered nowhere, and
 * the JavaScript falls back to its browser path as though the phone simply had
 * no such feature. That is the failure this whole file exists to prevent, so it
 * should not have a hand-written list at the top of it.
 */
function folders(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const dir = path.join(root, name);
      return fs.readdirSync(dir).some((file) => file.endsWith('.swift'));
    })
    .sort();
}

// Sources that sit directly in ios/App/App/ rather than in a folder of their
// own. MainViewController is the one place this app's plugins are handed to the
// bridge, and an unlisted one means they are not registered at all.
const LOOSE = ['MainViewController.swift'];

// Files that have to be *in the bundle* rather than compiled. The privacy
// manifest is the one that matters: a submission without it is rejected, and
// a manifest sitting in the folder unlisted is exactly as absent as no manifest
// at all.
const RESOURCES = ['PrivacyInfo.xcprivacy'];

/** A pbxproj identifier: 24 hex characters, and the same ones every time. */
const idFor = (what) => crypto.createHash('sha256').update('nikui:' + what)
  .digest('hex').slice(0, 24).toUpperCase();

function ensure(text, folder, file) {
  const relative = folder ? folder + '/' + file : file;
  const fileId = idFor('file:' + relative);
  const buildId = idFor('build:' + relative);
  const groupId = idFor('group:' + folder);
  let out = text;

  if (out.includes(fileId)) return { text: out, added: false };

  out = out.replace('/* Begin PBXBuildFile section */',
    '/* Begin PBXBuildFile section */\n' +
    `\t\t${buildId} /* ${file} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileId} /* ${file} */; };`);

  out = out.replace('/* Begin PBXFileReference section */',
    '/* Begin PBXFileReference section */\n' +
    `\t\t${fileId} /* ${file} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${file}; sourceTree = "<group>"; };`);

  // No folder: it belongs to the App group directly.
  if (!folder) {
    out = out.replace(/(504EC3061FED79650016851F \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)/,
      `$1\t\t\t\t${fileId} /* ${file} */,\n`);
    out = out.replace(/(isa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = \d+;\n\t\t\tfiles = \(\n)/,
      `$1\t\t\t\t${buildId} /* ${file} in Sources */,\n`);
    return { text: out, added: true };
  }

  // The group, made once and then filled.
  if (!out.includes(`${groupId} /* ${folder} */ = {`)) {
    out = out.replace('/* Begin PBXGroup section */',
      '/* Begin PBXGroup section */\n' +
      `\t\t${groupId} /* ${folder} */ = {\n` +
      '\t\t\tisa = PBXGroup;\n' +
      '\t\t\tchildren = (\n' +
      '\t\t\t);\n' +
      `\t\t\tpath = ${folder};\n` +
      '\t\t\tsourceTree = "<group>";\n' +
      '\t\t};');
    // Hung off the App group, which is the one with `path = App;`.
    out = out.replace(/(504EC3061FED79650016851F \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)/,
      `$1\t\t\t\t${groupId} /* ${folder} */,\n`);
  }

  out = out.replace(new RegExp(`(${groupId} /\\* ${folder} \\*/ = \\{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \\(\n)`),
    `$1\t\t\t\t${fileId} /* ${file} */,\n`);

  out = out.replace(/(isa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = \d+;\n\t\t\tfiles = \(\n)/,
    `$1\t\t\t\t${buildId} /* ${file} in Sources */,\n`);

  return { text: out, added: true };
}

/** A file that ships inside the app rather than being compiled into it. */
function ensureResource(text, file) {
  const fileId = idFor('file:' + file);
  const buildId = idFor('resource:' + file);
  if (text.includes(fileId)) return { text, added: false };

  let out = text.replace('/* Begin PBXBuildFile section */',
    '/* Begin PBXBuildFile section */\n' +
    `\t\t${buildId} /* ${file} in Resources */ = {isa = PBXBuildFile; fileRef = ${fileId} /* ${file} */; };`);

  out = out.replace('/* Begin PBXFileReference section */',
    '/* Begin PBXFileReference section */\n' +
    `\t\t${fileId} /* ${file} */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = ${file}; sourceTree = "<group>"; };`);

  out = out.replace(/(504EC3061FED79650016851F \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)/,
    `$1\t\t\t\t${fileId} /* ${file} */,\n`);

  out = out.replace(/(isa = PBXResourcesBuildPhase;\n\t\t\tbuildActionMask = \d+;\n\t\t\tfiles = \(\n)/,
    `$1\t\t\t\t${buildId} /* ${file} in Resources */,\n`);

  return { text: out, added: true };
}

function sync() {
  if (!fs.existsSync(PROJECT)) return { added: 0, present: 0 };
  let text = fs.readFileSync(PROJECT, 'utf8');
  let added = 0;
  let present = 0;
  for (const file of LOOSE) {
    if (!fs.existsSync(path.join(APP, 'ios', 'App', 'App', file))) continue;
    present++;
    const result = ensure(text, '', file);
    text = result.text;
    if (result.added) added++;
  }

  for (const folder of folders(path.join(APP, 'ios', 'App', 'App'))) {
    const dir = path.join(APP, 'ios', 'App', 'App', folder);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.swift')).sort()) {
      present++;
      const result = ensure(text, folder, file);
      text = result.text;
      if (result.added) added++;
    }
  }
  for (const file of RESOURCES) {
    if (!fs.existsSync(path.join(APP, 'ios', 'App', 'App', file))) continue;
    present++;
    const result = ensureResource(text, file);
    text = result.text;
    if (result.added) added++;
  }
  if (added) fs.writeFileSync(PROJECT, text);
  return { added, present };
}

if (require.main === module) {
  const { added, present } = sync();
  console.log(`xcode — ${present} native source${present === 1 ? '' : 's'}, ${added} newly listed`);
}

module.exports = { sync, idFor, PROJECT };
