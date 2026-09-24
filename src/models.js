'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Which models this copy of the CLI knows about.
 *
 * A hardcoded list is wrong the day a model ships, and this project has already
 * been through that: the setting was free text, so picking a new model meant
 * knowing its exact identifier and typing it correctly, and nothing anywhere
 * would have told you it existed.
 *
 * So the list comes from the CLI itself. It carries its own catalog — ask it to
 * run something it does not know and it says so, in those words — and the
 * identifiers in that catalog are in the binary. Reading them is not elegant,
 * but it has the property that matters: update the CLI, and the new models are
 * simply there, without anybody editing this file.
 *
 * When that fails there are still the aliases. `opus`, `sonnet`, `haiku` and
 * `fable` each mean "the newest one of those", which cannot go stale — a worse
 * list, and never a wrong one.
 */

// What a model identifier looks like. Families are named rather than matched
// loosely so a stray string in the binary cannot become a menu entry.
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const ID = new RegExp(
  'claude-(' + FAMILIES.join('|') + ')-[0-9][0-9a-z-]*(?:\\[1m\\])?', 'g');

// Dated builds — claude-opus-4-1-20250805 — and the -v1 provider ids beside
// them. Both real, neither what anybody wants in a menu: the plain name always
// points at the newest of them, and "Opus 4.6.v1" is not a thing to choose.
const DATED = /(-\d{8}(-v\d+)?|-v\d+)(\[1m\])?$/;

/** The aliases, which never go stale because the CLI resolves them itself. */
const ALIASES = FAMILIES.map((family) => ({
  id: family,
  family,
  alias: true,
  wide: false,
  label: family[0].toUpperCase() + family.slice(1),
  detail: 'Whatever the newest ' + family + ' is'
}));

/**
 * Read the identifiers out of a file, without reading the file into memory.
 *
 * Two hundred megabytes, so it is streamed — and the chunks overlap by enough
 * to hold the longest identifier, because a match that straddles a boundary is
 * a model that silently never appears.
 */
function scan(file, onDone) {
  const found = new Set();
  const OVERLAP = 64;
  let tail = '';
  const stream = fs.createReadStream(file, { encoding: 'latin1', highWaterMark: 1 << 20 });

  stream.on('data', (chunk) => {
    const text = tail + chunk;
    let match;
    ID.lastIndex = 0;
    while ((match = ID.exec(text))) found.add(match[0]);
    tail = text.slice(-OVERLAP);
  });
  stream.on('error', () => onDone(null));
  stream.on('end', () => onDone(found));
}

/** Newest first, which is the order somebody reads a list of models in. */
function rank(id) {
  const bare = id.replace(/\[1m\]$/, '');
  const parts = bare.replace(/^claude-/, '').split('-');
  const family = parts.shift();
  const numbers = parts.filter((p) => /^\d+$/.test(p)).map(Number);
  return { family: FAMILIES.indexOf(family), numbers };
}

function newestFirst(a, b) {
  const one = rank(a.id);
  const two = rank(b.id);
  if (one.family !== two.family) return one.family - two.family;
  const most = Math.max(one.numbers.length, two.numbers.length);
  for (let i = 0; i < most; i++) {
    const x = one.numbers[i] === undefined ? -1 : one.numbers[i];
    const y = two.numbers[i] === undefined ? -1 : two.numbers[i];
    if (x !== y) return y - x;
  }
  // The wide one after the ordinary one, so the default reading is the short
  // name and 1M is the deliberate choice under it.
  return (a.wide ? 1 : 0) - (b.wide ? 1 : 0);
}

function describe(id) {
  const wide = id.endsWith('[1m]');
  const bare = id.replace(/\[1m\]$/, '');
  const family = bare.replace(/^claude-/, '').split('-')[0];
  const version = bare.replace(new RegExp('^claude-' + family + '-?'), '').replace(/-/g, '.');
  return {
    id,
    family,
    wide,
    alias: false,
    label: family[0].toUpperCase() + family.slice(1) + (version ? ' ' + version : ''),
    detail: wide ? '1M context' : ''
  };
}

/**
 * Where the CLI actually is, following the symlink installers leave behind.
 *
 * `claudePath` is whatever the setting says, which is usually just `claude` —
 * a name on PATH rather than a file to read.
 */
function resolve(claudePath, deps) {
  const d = deps || {};
  const exists = d.exists || ((f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
  const real = d.realpath || ((f) => { try { return fs.realpathSync(f); } catch (_) { return f; } });

  const named = String(claudePath || 'claude');
  const candidates = named.includes(path.sep) ? [named] : (d.places || [
    path.join(process.env.HOME || '', '.local', 'bin', named),
    path.join('/opt/homebrew/bin', named),
    path.join('/usr/local/bin', named)
  ]);
  for (const one of candidates) {
    if (exists(one)) return real(one);
  }
  return null;
}

/** So a list is not rebuilt for a binary that has not changed. */
function fingerprint(file, deps) {
  const stat = (deps && deps.stat) || ((f) => fs.statSync(f));
  try {
    const s = stat(file);
    return file + ':' + s.size + ':' + Number(s.mtimeMs || 0);
  } catch (_) { return null; }
}

/**
 * The models to offer, newest first.
 *
 * @param {object} [opts]
 * @param {string} [opts.claudePath]  what the setting says the CLI is called
 * @param {{get: Function, update: Function}} [opts.cache] somewhere to keep the answer
 * @returns {Promise<{models: object[], from: string, cli: string|null}>}
 */
function discover(opts) {
  const o = opts || {};
  const file = resolve(o.claudePath, o);
  const cache = o.cache || null;
  const mark = file ? fingerprint(file, o) : null;

  if (cache && mark) {
    const kept = cache.get('nikui.models', null);
    if (kept && kept.mark === mark && Array.isArray(kept.models) && kept.models.length) {
      return Promise.resolve({ models: kept.models, from: 'remembered', cli: file });
    }
  }
  if (!file) return Promise.resolve({ models: ALIASES.slice(), from: 'aliases', cli: null });

  return new Promise((resolve_) => {
    const reader = o.scan || scan;
    reader(file, (found) => {
      if (!found || !found.size) {
        return resolve_({ models: ALIASES.slice(), from: 'aliases', cli: file });
      }
      const models = [...found]
        .filter((id) => !DATED.test(id))
        .map(describe)
        .sort(newestFirst)
        .concat(ALIASES);
      if (cache && mark) cache.update('nikui.models', { mark, models });
      resolve_({ models, from: 'catalog', cli: file });
    });
  });
}

module.exports = { discover, scan, resolve, describe, newestFirst, ALIASES, FAMILIES, DATED };
