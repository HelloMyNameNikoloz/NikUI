#!/usr/bin/env node
'use strict';

// One version, written into every place that insists on its own copy.
//
//   node app/tools/version.js
//
// Four files used to hold four different numbers: app/package.json said 0.1.0,
// Android said 1.0 / 1, and the Xcode project said 1.0 / 1 twice. None of them
// was wrong, because none of them was the answer — and a build number nobody
// can trace back to a commit is a build number that tells a support question
// nothing at all.
//
// So `app/package.json` is the version, and this writes it everywhere. Run from
// `npm run sync`, so drifting requires editing a generated line on purpose.

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const GRADLE = path.join(APP, 'android', 'app', 'build.gradle');
const PBXPROJ = path.join(APP, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

/**
 * The build number, derived rather than counted.
 *
 * Both stores want an integer that only ever goes up, and keeping one by hand
 * means one day shipping 1.2.0 as build 7 and having no way back to which
 * commit that was. `major * 10000 + minor * 100 + patch` goes up whenever the
 * version does, is the same on both platforms, and can be read backwards.
 *
 * It allows 99 minors and 99 patches, which is more than this will ever need
 * and is checked rather than assumed.
 */
function buildNumber(version) {
  const parts = String(version).split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`the app version must be major.minor.patch, not "${version}"`);
  }
  const [major, minor, patch] = parts;
  if (minor > 99 || patch > 99) {
    throw new Error(`"${version}" cannot be a build number: minor and patch must stay under 100`);
  }
  return major * 10000 + minor * 100 + patch;
}

/** The marketing version, which is the one a person reads. */
function appVersion() {
  return JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
}

function stampAndroid(version, code) {
  if (!fs.existsSync(GRADLE)) return false;
  const before = fs.readFileSync(GRADLE, 'utf8');
  const after = before
    .replace(/versionCode\s+\d+/, 'versionCode ' + code)
    .replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
  if (after !== before) fs.writeFileSync(GRADLE, after);
  return true;
}

function stampIos(version, code) {
  if (!fs.existsSync(PBXPROJ)) return false;
  const before = fs.readFileSync(PBXPROJ, 'utf8');
  // Both configurations, debug and release: a debug build that reports a
  // different version from the release one is a debug build you cannot trust
  // a bug report from.
  const after = before
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${code};`)
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
  if (after !== before) fs.writeFileSync(PBXPROJ, after);
  return true;
}

/** @returns {{version: string, build: number, android: boolean, ios: boolean}} */
function stamp() {
  const version = appVersion();
  const build = buildNumber(version);
  return { version, build, android: stampAndroid(version, build), ios: stampIos(version, build) };
}

/** What each platform currently says, for anything that wants to check. */
function current() {
  const out = { android: null, ios: null };
  if (fs.existsSync(GRADLE)) {
    const gradle = fs.readFileSync(GRADLE, 'utf8');
    out.android = {
      version: (/versionName\s+"([^"]*)"/.exec(gradle) || [])[1] || null,
      build: Number((/versionCode\s+(\d+)/.exec(gradle) || [])[1]) || null
    };
  }
  if (fs.existsSync(PBXPROJ)) {
    const project = fs.readFileSync(PBXPROJ, 'utf8');
    out.ios = {
      version: (/MARKETING_VERSION = ([^;]+);/.exec(project) || [])[1] || null,
      build: Number((/CURRENT_PROJECT_VERSION = ([^;]+);/.exec(project) || [])[1]) || null
    };
  }
  return out;
}

if (require.main === module) {
  const { version, build, android, ios } = stamp();
  console.log(`version — ${version} (build ${build})` +
    `${android ? ', android' : ''}${ios ? ', ios' : ''}`);
}

module.exports = { stamp, current, buildNumber, appVersion };
