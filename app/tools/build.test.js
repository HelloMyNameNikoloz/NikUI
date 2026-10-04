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

// A script written into the page is a script the page's own policy will not
// run — silently, apart from a line in the WebView console. The conversation's
// app classes were lost that way for a week.
for (const page of fs.readdirSync(OUT).filter((f) => f.endsWith('.html'))) {
  const inline = (read(page).match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || []);
  equal(page + ' has no inline script its policy would refuse', inline, []);
}
check('the conversation carries the classes the app styles it by',
  /<body class="app app-conversation">/.test(read('conversation.html')));

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

// ---- three screens that are peers, and say so --------------------------------
//
// Instances, History and Settings are not inside one another, so none of them
// is reached by a chevron and none of them needs a way back: the tab bar is on
// all three, and the one you are looking at is the one that is marked.

const history = read('history.html');
check('history has somewhere to draw itself', /id="screen"/.test(history));
check('and something to search with', /id="search"/.test(history));
const status = read('status.html');
check('status has somewhere to draw itself', /id="screen"/.test(status));
check('and loads the panel\u2019s own renderer, rather than a second one',
  status.includes('media/status.js') && status.includes('media/panel.css'));
for (const page of ['index.html', 'status.html', 'history.html', 'settings.html']) {
  check(page + ' carries the tab bar', /<nav class="tabs" id="tabs"/.test(read(page)));
  check(page + ' loads the icons it draws them with', read(page).includes('media/icons.js'));
}
check('the conversation is a pushed screen, so it has a way back instead',
  /id="back"/.test(read('conversation.html')) && !/id="tabs"/.test(read('conversation.html')));

// ---- the version it reports --------------------------------------------------

const version = JSON.parse(read('version.json'));
const extension = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
equal('the bundle records which client it is', version.client, extension.version);
check('and which app', !!version.app);

// ---- a build is a clean build -------------------------------------------------

fs.writeFileSync(path.join(OUT, 'leftover.txt'), 'from a previous build');
build();
check('a rebuild clears what the last one left', !fs.existsSync(path.join(OUT, 'leftover.txt')));

// ---- being told --------------------------------------------------------------

check('the app ships its notification layer', fs.existsSync(path.join(OUT, 'notify.js')));
for (const page of ['index.html', 'settings.html', 'conversation.html']) {
  // Whichever screen is open is the one holding the socket, so every screen
  // has to be able to turn what arrives on it into a notification.
  check(page + ' can raise a notification', read(page).includes('notify.js'));
}
check('and it listens for the frame the laptop actually sends',
  /@notify/.test(fs.readFileSync(path.join(APP, 'shell', 'notify.js'), 'utf8')));
check('Android is told it may show one', /POST_NOTIFICATIONS/.test(
  fs.readFileSync(path.join(APP, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8')));
check('and that it may keep watching behind a notification of its own',
  /foregroundServiceType="remoteMessaging"/.test(fs.readFileSync(
    path.join(APP, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8')));
check('with a status icon that is not the launcher icon squashed into a square',
  fs.existsSync(path.join(APP, 'android', 'app', 'src', 'main', 'res', 'drawable-xxhdpi', 'ic_stat_nikui.png')));

// ---- one version, in every place that insists on its own copy -----------------

const { stamp, current, buildNumber } = require('./version.js');
stamp();
const said = current();
const appVersion = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
equal('Android reports the app version', said.android && said.android.version, appVersion);
equal('and so does iOS', said.ios && said.ios.version, appVersion);
equal('with the same build number on both', said.android && said.android.build, said.ios && said.ios.build);
equal('derived from the version rather than counted by hand',
  said.android && said.android.build, buildNumber(appVersion));
check('a version that cannot be a build number is refused rather than truncated', (() => {
  try { buildNumber('1.100.0'); return false; } catch (_) { return true; }
})());

// ---- a release build that is actually releasable ------------------------------

const gradle = fs.readFileSync(path.join(APP, 'android', 'app', 'build.gradle'), 'utf8');
check('release builds are shrunk', /minifyEnabled true/.test(gradle));
check('and signed, from a file that is not in this repository',
  /signingConfigs/.test(gradle) && /keystore.properties/.test(gradle));
check('which is ignored, so it cannot be committed by accident',
  /keystore\.properties/.test(fs.readFileSync(path.join(APP, '.gitignore'), 'utf8')));

// R8 removes what nothing calls, and nothing calls a plugin method — the bridge
// looks them up by name. Without these rules every plugin is missing, in
// release builds only.
const rules = fs.readFileSync(path.join(APP, 'android', 'app', 'proguard-rules.pro'), 'utf8');
check('and told to keep the methods the bridge finds by reflection',
  /CapacitorPlugin/.test(rules) && /PluginMethod/.test(rules));
check('and the service that keeps the socket open', /WatchService/.test(rules));

const androidManifest = fs.readFileSync(
  path.join(APP, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
check('cleartext is off except where it means this machine',
  /networkSecurityConfig/.test(androidManifest));
const network = fs.readFileSync(path.join(APP, 'android', 'app', 'src', 'main', 'res',
  'xml', 'network_security_config.xml'), 'utf8');
check('which is what it says', /cleartextTrafficPermitted="false"/.test(network) &&
  /127\.0\.0\.1/.test(network));
check('and nothing on the internet is in the exception',
  !/\.(com|net|org|ts\.net)</.test(network));
check('a backup cannot carry a pairing to a phone that cannot use it',
  /android:allowBackup="false"/.test(androidManifest));

const privacy = path.join(APP, 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy');
check('Apple gets the privacy manifest it requires', fs.existsSync(privacy));
const declared = fs.readFileSync(privacy, 'utf8');
check('saying this app tracks nobody', /NSPrivacyTracking<\/key>\s*<false\/>/.test(declared));
check('and collects nothing', /NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/.test(declared));
check('and it is in the bundle rather than beside it',
  fs.readFileSync(path.join(APP, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8')
    .includes('PrivacyInfo.xcprivacy in Resources'));

check('there is a runbook for making a build somebody can install',
  fs.existsSync(path.join(APP, 'RELEASE.md')));

// ---- pairing by pointing a camera --------------------------------------------
//
// The laptop draws a QR carrying nikui://pair#…; the phone's own camera offers
// to open it. That only works if both platforms have been told this app is what
// opens one — and the failure, on a phone, is the camera shrugging.

const manifest = fs.readFileSync(
  path.join(APP, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
check('Android claims the pairing scheme', /android:scheme="nikui"/.test(manifest));
check('as something a camera may hand it',
  /android.intent.category.BROWSABLE/.test(manifest));

const plist = fs.readFileSync(path.join(APP, 'ios', 'App', 'App', 'Info.plist'), 'utf8');
check('iOS claims it too', /CFBundleURLSchemes/.test(plist) && /<string>nikui<\/string>/.test(plist));

check('and the app knows what to do with one',
  /appUrlOpen/.test(fs.readFileSync(path.join(APP, 'shell', 'connect.js'), 'utf8')));
check('including when it was the thing that started it',
  /getLaunchUrl/.test(fs.readFileSync(path.join(APP, 'shell', 'connect.js'), 'utf8')));

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
