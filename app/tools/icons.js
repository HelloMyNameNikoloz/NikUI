#!/usr/bin/env node
'use strict';

// The app's launcher icons and splash, from the same mark as everything else.
//
//   node app/tools/icons.js
//
// `tools/icons.js` at the repo root draws the mark; this puts it in the sizes
// and the folders the two platforms insist on. Run it after changing the mark,
// and commit what comes out — a launcher icon that is generated at build time
// is a launcher icon nobody notices has broken.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');
const MEDIA = path.join(REPO, 'media', 'icons');

// Android wants its launcher at five densities, plus a foreground layer for
// the adaptive icon — which the platform masks to whatever shape the launcher
// uses, so the mark sits inside the middle 66% of it.
const ANDROID = [
  ['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]
];

// iOS takes one 1024 and slices the rest itself.
const IOS = [['AppIcon-512@2x.png', 1024]];

function sips(from, to, size) {
  execFileSync('sips', ['-z', String(size), String(size), from, '--out', to], { stdio: 'ignore' });
}

function android() {
  const res = path.join(APP, 'android', 'app', 'src', 'main', 'res');
  if (!fs.existsSync(res)) return 0;
  const source = path.join(MEDIA, 'nikui-512.png');
  const masked = path.join(MEDIA, 'nikui-maskable-512.png');
  let written = 0;
  for (const [dir, size] of ANDROID) {
    const into = path.join(res, dir);
    fs.mkdirSync(into, { recursive: true });
    sips(source, path.join(into, 'ic_launcher.png'), size);
    sips(source, path.join(into, 'ic_launcher_round.png'), size);
    // The adaptive foreground is drawn at 108dp against a 72dp safe circle,
    // which is what the maskable variant was made for.
    sips(masked, path.join(into, 'ic_launcher_foreground.png'), Math.round(size * 1.5));
    written += 3;
  }
  return written;
}

function ios() {
  const set = path.join(APP, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
  if (!fs.existsSync(set)) return 0;
  let written = 0;
  for (const [name, size] of IOS) {
    sips(path.join(MEDIA, 'apple-touch-icon-180.png'), path.join(set, name), size);
    written++;
  }
  return written;
}

/** The splash is the field colour and nothing else: a logo that flashes for
 *  200ms and vanishes is noise, and a colour that matches the first screen
 *  makes the app look like it was already open. */
function splash() {
  const android = path.join(APP, 'android', 'app', 'src', 'main', 'res');
  let written = 0;
  if (fs.existsSync(android)) {
    const values = path.join(android, 'values');
    fs.mkdirSync(values, { recursive: true });
    // The launcher background lives in its own file, put there by the Android
    // template. Declaring it here as well is a duplicate resource and fails
    // the build, so it is written where it already belongs.
    fs.writeFileSync(path.join(values, 'colors.xml'),
      `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#17171A</color>
    <color name="colorPrimaryDark">#0F0F11</color>
    <color name="colorAccent">#0A84FF</color>
</resources>
`);
    fs.writeFileSync(path.join(values, 'ic_launcher_background.xml'),
      `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#17171A</color>
</resources>
`);
    written += 2;
  }
  return written;
}

if (require.main === module) {
  const a = android();
  const i = ios();
  const s = splash();
  console.log(`icons — android ${a}, ios ${i}, colours ${s}`);
}

module.exports = { android, ios, splash };
