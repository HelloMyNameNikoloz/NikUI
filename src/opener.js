'use strict';

// Where a file named in a transcript opens when it is clicked. Code and text
// open in the editor, at the line if one was given; pages and PDFs open in the
// browser, as they were made to be seen; pictures open in the editor's own
// viewer; anything else the editor cannot show (documents, archives, media)
// goes to whatever the system opens it with.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const BROWSER = new Set(['html', 'htm', 'xhtml', 'pdf']);
const PICTURE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
const SYSTEM = new Set([
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'key', 'pages', 'numbers', 'odt', 'ods', 'rtf',
  'zip', 'tar', 'gz', 'tgz', 'dmg', 'pkg', 'app',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv',
  'heic', 'tiff', 'tif', 'psd', 'ai', 'sketch', 'fig', 'epub'
]);

/** The absolute path a transcript means: `~/x`, `file://…`, absolute, or relative to the session's folder. */
function resolvePath(raw, cwd) {
  let p = String(raw || '').trim().replace(/^["'`]|["'`]$/g, '');
  if (!p) return '';
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch (_) { return ''; }
  }
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.resolve(cwd || os.homedir(), p);
}

/** 'browser' | 'picture' | 'system' | 'editor' | 'folder' | 'missing'. */
function howToOpen(abs) {
  let stat;
  try { stat = fs.statSync(abs); } catch (_) { return 'missing'; }
  if (stat.isDirectory()) return /\.app$/i.test(abs) ? 'system' : 'folder';
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (BROWSER.has(ext)) return 'browser';
  if (PICTURE.has(ext)) return 'picture';
  if (SYSTEM.has(ext)) return 'system';
  return 'editor';
}

/**
 * The default web browser's bundle id on macOS, or null. A PDF would
 * otherwise go to Preview; asked for by name, it opens in the browser.
 */
function defaultBrowser() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const plist = path.join(os.homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  return new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { timeout: 3000 }, (err, out) => {
      if (err) { resolve(null); return; }
      try {
        const handlers = JSON.parse(out).LSHandlers || [];
        const https = handlers.find((h) => h.LSHandlerURLScheme === 'https') || handlers.find((h) => h.LSHandlerURLScheme === 'http');
        resolve((https && https.LSHandlerRoleAll) || null);
      } catch (_) {
        resolve(null);
      }
    });
  });
}

/** Open a file in the browser: the default one by name on macOS. Resolves false if it could not. */
async function openInBrowser(abs, { requireDefault = false, beforeOpen = () => {} } = {}) {
  if (process.platform !== 'darwin') return false;
  const selected = await defaultBrowser();
  if (requireDefault && !selected) return false;
  const id = selected || 'com.apple.Safari';
  beforeOpen();
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-b', id, abs], { timeout: 10000 }, (err) => resolve(!err));
  });
}

module.exports = { resolvePath, howToOpen, defaultBrowser, openInBrowser };
