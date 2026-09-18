#!/usr/bin/env node
'use strict';

// The bundle, checked against the thing it is a copy of.
//
//   npm test
//
// What matters here is not that the app works — that is the browser check's
// job — but that it is still the *same client*. Every one of these fails the
// day somebody adds a file to the panel and forgets the app, or edits a copy in
// www/ instead of the original in media/.

const fs = require('fs');
const path = require('path');
const { build, OUT } = require('./build.js');

const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');
const MEDIA = path.join(REPO, 'media');

const results = [];
const check = (name, ok) => results.push({ name, ok: !!ok });
const equal = (name, a, b) => results.push({
  name, ok: JSON.stringify(a) === JSON.stringify(b), a, b
});

const read = (file) => fs.readFileSync(path.join(OUT, file), 'utf8');

build();

// ---- it is a copy, not a fork ---------------------------------------------

const { SCRIPTS } = require(path.join(REPO, 'src', 'page.js'));
for (const name of SCRIPTS) {
  check('the app ships the client\'s ' + name, fs.existsSync(path.join(OUT, 'media', name)));
  equal('and it is byte for byte the original: ' + name,
    fs.readFileSync(path.join(OUT, 'media', name)).toString('base64'),
    fs.readFileSync(path.join(MEDIA, name)).toString('base64'));
}

// ---- the conversation is the panel's own page ------------------------------

const conversation = read('conversation.html');
check('the conversation screen has the client\'s transcript', /id="transcript"/.test(conversation));
check('its composer', /id="input"/.test(conversation));
check('its dashboard', /id="status"/.test(conversation));
check('and loads every client script', SCRIPTS.every((s) => conversation.includes('media/' + s)));
check('the app is told where it is before the client starts',
  conversation.indexOf('src="app.js"') < conversation.indexOf('media/transport.js'));
check('nothing in the bundle asks for a nonce it cannot have', !/nonce=/.test(conversation));
// The policy names schemes and hosts by design; what must not name them is
// anything the page actually loads.
const loads = [...conversation.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
check('everything the page loads comes from the bundle',
  loads.every((url) => !/^[a-z]+:\/\//i.test(url)));
check('and there is something to load', loads.length > 5);

// ---- every screen is sealed the same way ------------------------------------

for (const page of ['index.html', 'connect.html', 'settings.html', 'conversation.html']) {
  const html = read(page);
  check(page + ' carries a policy', /Content-Security-Policy/.test(html));
  check(page + ' allows scripts only from itself', /script-src 'self'/.test(html));
  check(page + ' forbids everything not asked for', /default-src 'none'/.test(html));
  check(page + ' cannot be framed', /frame-ancestors 'none'/.test(html));
  check(page + ' fits a phone', /viewport-fit=cover/.test(html));
}

// ---- the screens a browser never needed ------------------------------------

const connect = read('connect.html');
check('the way in asks for an address', /id="host"/.test(connect));
check('and a code', /id="code"/.test(connect));
check('and names the device for you', /id="name"/.test(connect));
check('it says what pairing grants', /watch/i.test(connect));
check('and that the key stays here', /never leaves it/i.test(connect));

const settings = read('settings.html');
check('settings has somewhere to draw itself', /id="screen"/.test(settings));
check('and a way back', /id="back"/.test(settings));

// ---- the version it reports --------------------------------------------------

const version = JSON.parse(read('version.json'));
const extension = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
equal('the bundle records which client it is', version.client, extension.version);
check('and which app', !!version.app);

// ---- a build is a clean build -------------------------------------------------

fs.writeFileSync(path.join(OUT, 'leftover.txt'), 'from a previous build');
build();
check('a rebuild clears what the last one left', !fs.existsSync(path.join(OUT, 'leftover.txt')));

// ---- the native code Xcode would otherwise never compile ---------------------
//
// Android finds sources by looking in a folder; Xcode only compiles what is
// listed in project.pbxproj. A plugin that is present, correct and unlisted is
// a plugin that silently does not exist on the phone, and the only symptom is
// the app deciding the device has no secure hardware.

const { sync } = require('./xcode.js');
sync();
const pbxproj = path.join(APP, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
if (fs.existsSync(pbxproj)) {
  const project = fs.readFileSync(pbxproj, 'utf8');
  const natives = fs.readdirSync(path.join(APP, 'ios', 'App', 'App', 'SecureKey'))
    .filter((f) => f.endsWith('.swift'));
  check('there is native code for the key in the chip', natives.length > 0);
  for (const file of natives) {
    check('Xcode is told to compile ' + file, project.includes(file + ' in Sources'));
  }
  const listed = sync();
  equal('and listing it twice changes nothing', listed.added, 0);
}

const androidPlugin = path.join(APP, 'android', 'app', 'src', 'main', 'java',
  'com', 'nikoloz', 'nikui', 'securekey', 'SecureKeyPlugin.java');
check('Android has its half too', fs.existsSync(androidPlugin));
check('and registers it before the bridge starts',
  /registerPlugin\(SecureKeyPlugin\.class\);[\s\S]*super\.onCreate/.test(
    fs.readFileSync(path.join(APP, 'android', 'app', 'src', 'main', 'java',
      'com', 'nikoloz', 'nikui', 'MainActivity.java'), 'utf8')));

let failed = 0;
for (const r of results) {
  if (!r.ok) {
    failed++;
    console.log('FAIL  ' + r.name);
    if ('a' in r) console.log('      got ' + JSON.stringify(r.a) + ' want ' + JSON.stringify(r.b));
  } else {
    console.log('ok    ' + r.name);
  }
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' bundle checks passed');
process.exit(failed ? 1 : 0);
