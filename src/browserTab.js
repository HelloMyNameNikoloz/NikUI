'use strict';

// Opening a PR you already have open should take you to that tab, not add a
// second one. Browsers do not offer that to a URL, so on a Mac the default
// browser is asked over AppleScript for a tab already showing it. Anything
// that cannot be asked, or has no such tab, opens the URL the ordinary way.
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

// Chromium browsers share Chrome's scripting terms; Safari has its own.
const CHROMIUM = new Set(['com.google.chrome', 'com.google.chrome.beta', 'com.brave.browser',
  'com.brave.browser.beta', 'com.microsoft.edgemac', 'com.vivaldi.vivaldi', 'company.thebrowser.browser']);
const SAFARI = new Set(['com.apple.safari']);

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout || '').trim()));
});

/** The bundle id of the browser that opens https links; null when it cannot be told. */
async function defaultBrowser() {
  const plist = path.join(os.homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  const out = await run('plutil', ['-convert', 'json', '-o', '-', plist]);
  if (!out) return null;
  try {
    const handler = (JSON.parse(out).LSHandlers || []).find((h) => h.LSHandlerURLScheme === 'https');
    return handler && handler.LSHandlerRoleAll ? String(handler.LSHandlerRoleAll).toLowerCase() : null;
  } catch (e) { return null; }
}

// The URL arrives as an argument, never inside the script text.
const MATCHES = 'u is target or u starts with (target & "/") or u starts with (target & "?") or u starts with (target & "#")';

function script(bundle) {
  const tabs = CHROMIUM.has(bundle)
    ? 'set active tab index of w to i'
    : 'set current tab of w to tab i of w';
  return `on run argv
  set target to item 1 of argv
  if application id "${bundle}" is not running then return "none"
  tell application id "${bundle}"
    repeat with w in windows
      set us to URL of tabs of w
      repeat with i from 1 to count of us
        set u to item i of us
        if u is not missing value and (${MATCHES}) then
          ${tabs}
          set index of w to 1
          activate
          return "found"
        end if
      end repeat
    end repeat
  end tell
  return "none"
end run`;
}

/**
 * Brings forward a tab already showing `url` (or a page under it, like its
 * files). Resolves true if it did; false means nothing was touched.
 */
async function focusOpenTab(url, opts) {
  opts = opts || {};
  if ((opts.platform || process.platform) !== 'darwin') return false;
  const bundle = await (opts.defaultBrowser || defaultBrowser)();
  if (!bundle || !(CHROMIUM.has(bundle) || SAFARI.has(bundle))) return false;
  const out = await (opts.run || run)('osascript', ['-e', script(bundle), String(url).replace(/\/+$/, '')]);
  return out === 'found';
}

module.exports = { focusOpenTab, defaultBrowser, script, CHROMIUM, SAFARI };
