'use strict';

const path = require('path');
const os = require('os');
const realFs = require('fs');

/**
 * Which folder on disk is the checkout of a given GitHub repo — for opening a
 * ticket's ticket in NikUI rather than only in the browser.
 *
 * Nothing here is VS Code or Slack specific, and nothing here runs a shell:
 * the remote is read straight out of `.git/config`, so every call here can be
 * driven by a fake filesystem in a test.
 */

const CACHE_MS = 5 * 60000;
let cache = new Map(); // "owner/repo" (lowercase) -> { at, dir }

/** Only a test ever needs this — the 5 minute cache otherwise outlives it. */
function clearCache() {
  cache = new Map();
}

/** The `url = ` line of `[remote "origin"]`, or null. */
function parseOriginUrl(text) {
  const m = /\[remote\s+"origin"\][^[]*/.exec(String(text || ''));
  if (!m) return null;
  const line = /url\s*=\s*(\S+)/.exec(m[0]);
  return line ? line[1].trim() : null;
}

/** A remote URL, https or ssh, → {owner, repo} with any ".git" stripped. */
function repoFromRemote(url) {
  if (!url) return null;
  let m = /^git@[^:]+:([^/]+)\/(.+?)$/.exec(url);
  if (!m) m = /^(?:https?|ssh):\/\/[^/]+\/([^/]+)\/(.+?)$/.exec(url);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '').replace(/\/$/, '') };
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function listDirs(dir, fsImpl) {
  let entries;
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  return entries.filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
}

/**
 * The remote this checkout points at — null if it is not a git checkout, or
 * has no origin. A worktree (`.git` is a file, not a directory) is read via
 * its `commondir`, and flagged, so a caller can prefer the real checkout.
 */
function originOf(dir, fsImpl) {
  const gitPath = path.join(dir, '.git');
  let stat;
  try { stat = fsImpl.statSync(gitPath); } catch (_) { return null; }

  let configPath;
  let worktree = false;
  if (stat.isDirectory && stat.isDirectory()) {
    configPath = path.join(gitPath, 'config');
  } else {
    worktree = true;
    let pointer;
    try { pointer = fsImpl.readFileSync(gitPath, 'utf8'); } catch (_) { return null; }
    const m = /gitdir:\s*(.+)/.exec(String(pointer || ''));
    if (!m) return null;
    const gitdir = path.resolve(dir, m[1].trim());
    let common = null;
    try { common = String(fsImpl.readFileSync(path.join(gitdir, 'commondir'), 'utf8') || '').trim(); } catch (_) { /* older git */ }
    configPath = common ? path.join(gitdir, common, 'config') : path.join(gitdir, 'config');
  }

  let text;
  try { text = fsImpl.readFileSync(configPath, 'utf8'); } catch (_) { return null; }
  const repo = repoFromRemote(parseOriginUrl(text));
  return repo ? Object.assign({ worktree }, repo) : null;
}

/** The sibling folders of each of `dirs` — the parent's other children. */
function siblingsOf(dirs, fsImpl) {
  const out = [];
  const seenParents = new Set();
  for (const dir of dirs) {
    const parent = path.dirname(dir);
    if (!parent || seenParents.has(parent)) continue;
    seenParents.add(parent);
    out.push(...listDirs(parent, fsImpl));
  }
  return out;
}

/** Each root's children, and their children — two levels, no deeper. */
function scanCodeRoots(roots, fsImpl) {
  const out = [];
  for (const root of roots || []) {
    const top = listDirs(expandHome(String(root || '')), fsImpl);
    out.push(...top);
    for (const dir of top) out.push(...listDirs(dir, fsImpl));
  }
  return out;
}

/**
 * The local checkout of `{owner, repo}`, or null if none is found.
 *
 * @param {{owner: string, repo: string}} repo
 * @param {object} [options]
 * @param {object} [options.override]      the `nikui.repoFolders` setting: {"owner/name": "/abs/path"}
 * @param {string[]} [options.candidateDirs]  cwds already known to be instances or history — plus their siblings
 * @param {string[]} [options.codeRoots]   the `nikui.codeRoots` setting, scanned two levels deep
 * @param {object} [options.fsImpl]        for tests: a fake with statSync/readFileSync/readdirSync
 * @param {() => number} [options.now]     for tests
 */
function resolveRepoFolder(repo, options = {}) {
  const owner = String((repo && repo.owner) || '').toLowerCase();
  const name = String((repo && repo.repo) || '').toLowerCase();
  if (!owner || !name) return null;
  const key = owner + '/' + name;
  const fsImpl = options.fsImpl || realFs;

  const override = options.override || {};
  const overrideKey = Object.keys(override).find((k) => String(k).toLowerCase() === key);
  if (overrideKey) {
    const dir = override[overrideKey];
    try { if (dir && fsImpl.statSync(dir).isDirectory()) return dir; } catch (_) { /* gone; fall through */ }
  }

  const now = options.now ? options.now() : Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_MS) return cached.dir;

  const candidateDirs = options.candidateDirs || [];
  const all = [];
  const seen = new Set();
  const add = (d) => { if (d && !seen.has(d)) { seen.add(d); all.push(d); } };
  for (const d of candidateDirs) add(d);
  for (const d of siblingsOf(candidateDirs, fsImpl)) add(d);
  for (const d of scanCodeRoots(options.codeRoots, fsImpl)) add(d);

  let found = null;
  let foundWorktree = null;
  for (const dir of all) {
    const info = originOf(dir, fsImpl);
    if (!info || info.owner.toLowerCase() !== owner || info.repo.toLowerCase() !== name) continue;
    if (!info.worktree) { found = dir; break; }
    else if (!foundWorktree) foundWorktree = dir;
  }
  const result = found || foundWorktree || null;
  cache.set(key, { at: now, dir: result });
  return result;
}

module.exports = { resolveRepoFolder, originOf, repoFromRemote, parseOriginUrl, clearCache };
