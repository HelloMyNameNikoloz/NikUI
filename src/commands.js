'use strict';

/**
 * What the Commands page lists, and what a change on it writes.
 *
 * Two kinds of command. NikUI's own — /status, /settings, /commands, /watch —
 * are answered by the panel itself and are described here, not edited: they are
 * code. Prompt snippets are words that append a standing instruction to what you
 * typed, and are yours: the shipped ones can be rewritten, switched off and put
 * back, and new ones added.
 *
 * Pure: it is handed what the settings hold and hands back what they should
 * hold next. Reading and writing VS Code's settings is the host's job, so this
 * can be checked without an editor.
 */

const OWN = [
  {
    name: 'status',
    usage: '/status',
    description: 'A sheet of what this instance is doing: cost, tokens, tools, a timeline, and the machine it runs on.'
  },
  {
    name: 'settings',
    usage: '/settings',
    description: 'The settings people change most, as switches, for every instance at once.'
  },
  {
    name: 'commands',
    usage: '/commands',
    description: 'This page: NikUI\'s own commands, and your prompt snippets to read, change and add to.'
  },
  {
    name: 'slack',
    usage: '/slack',
    description: 'Your Slack VIPs and @mentions: read them, and reply as yourself. Reading here never marks anything read in Slack; replying does.'
  },
  {
    name: 'watch',
    usage: '/watch [prompt]',
    description: 'Watches the CI of this branch\'s pull request and says when it goes green or fails. ' +
      'Anything after it is sent as a prompt, with permission to push.'
  }
];

const OWN_NAMES = OWN.map((c) => c.name);

// A word you type after a slash: a letter, then letters, digits, - and _.
// Lower case, because the palette and the expansion both compare that way.
const NAME = /^[a-z][\w-]*$/;
const MAX_NAME = 40;
const MAX_DESCRIPTION = 300;
const MAX_PROMPT = 20000;

const text = (v) => (typeof v === 'string' ? v : '');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

/** The same map with lower-case keys, which is how every word is compared. */
function lower(o) {
  const out = {};
  for (const k of Object.keys(o || {})) out[k.toLowerCase()] = o[k];
  return out;
}

/** The first sentence of a prompt, for a snippet nobody described. */
function summarise(prompt) {
  const flat = text(prompt).replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end >= 0 ? flat.slice(0, end + 1) : flat;
  return first.length > 160 ? first.slice(0, 157).trimEnd() + '…' : first;
}

/**
 * Every command, in the order the page shows them: NikUI's own, then the
 * shipped snippets in the order they ship, then yours by name.
 *
 * @param {object} held
 * @param {object} held.shipped       snippet name -> prompt, as package.json ships it
 * @param {object} held.mine          snippet name -> prompt, as you have set it
 * @param {object} [held.shippedSaid] snippet name -> description, shipped
 * @param {object} [held.mineSaid]    snippet name -> description, yours
 */
function list(held) {
  const h = held || {};
  const shipped = lower(h.shipped);
  const mine = lower(h.mine);
  const shippedSaid = lower(h.shippedSaid);
  const mineSaid = lower(h.mineSaid);

  const own = OWN.map((c) => ({ name: c.name, kind: 'own', usage: c.usage, description: c.description }));

  const names = Object.keys(shipped).map((n) => n.toLowerCase());
  for (const n of Object.keys(mine).sort()) {
    const lower = n.toLowerCase();
    // A key of yours that only empties a word nobody ships is nothing at all.
    if (names.includes(lower) || !text(mine[n]).trim()) continue;
    names.push(lower);
  }

  const snippets = names
    .filter((name) => !OWN_NAMES.includes(name))
    .map((name) => {
      const isShipped = has(shipped, name);
      const prompt = has(mine, name) ? text(mine[name]) : text(shipped[name]);
      const description = has(mineSaid, name) ? text(mineSaid[name]) : text(shippedSaid[name]);
      return {
        name,
        kind: 'snippet',
        prompt,
        description,
        summary: description.trim() || summarise(prompt),
        shipped: isShipped,
        // Switched off: a shipped word whose text you emptied. It stays in the
        // list so it can be put back.
        off: !prompt.trim(),
        edited: isShipped && (prompt !== text(shipped[name]) || description !== text(shippedSaid[name]))
      };
    });

  return own.concat(snippets);
}

function refuse(message) {
  const err = new Error(message);
  err.refused = true;
  throw err;
}

/** A name as somebody typed it, or a reason it cannot be one. */
function cleanName(raw) {
  const name = text(raw).trim().replace(/^\/+/, '').toLowerCase();
  if (!name) refuse('Give it a name: the word you will type after the slash.');
  if (name.length > MAX_NAME) refuse('That name is longer than ' + MAX_NAME + ' characters.');
  if (!NAME.test(name)) refuse('A name starts with a letter and has only letters, digits, - and _.');
  if (OWN_NAMES.includes(name)) refuse('/' + name + ' is one of NikUI\'s own commands.');
  return name;
}

/** What each setting holds after one change, written as little as possible. */
function settle(next, shipped, name, value) {
  if (has(shipped, name) && shipped[name] === value) delete next[name];
  else next[name] = value;
}

/**
 * A snippet saved from the page: new, rewritten, or renamed.
 *
 * @param {object} held    as for list()
 * @param {object} change  { was, name, prompt, description }; `was` is the
 *                         name it had, or empty for a new one
 * @returns {{ name: string, mine: object, mineSaid: object }}
 */
function save(held, change) {
  const h = held || {};
  const c = change || {};
  const shipped = lower(h.shipped);
  const shippedSaid = lower(h.shippedSaid);
  const mine = lower(h.mine);
  const mineSaid = lower(h.mineSaid);

  const name = cleanName(c.name);
  const was = text(c.was).trim().replace(/^\/+/, '').toLowerCase();
  const prompt = text(c.prompt).trim();
  const description = text(c.description).replace(/\s+/g, ' ').trim();
  if (!prompt) refuse('The prompt is empty. To stop using /' + name + ', switch it off instead.');
  if (prompt.length > MAX_PROMPT) refuse('That prompt is longer than ' + MAX_PROMPT + ' characters.');
  if (description.length > MAX_DESCRIPTION) refuse('Keep the description under ' + MAX_DESCRIPTION + ' characters.');

  const now = list(h).filter((e) => e.kind === 'snippet');
  const existing = now.find((e) => e.name === name);
  if (name !== was && existing && !existing.off) refuse('There is already a /' + name + '.');
  if (was && !now.some((e) => e.name === was)) refuse('/' + was + ' is not there any more.');

  if (was && was !== name) {
    // The old word goes. A shipped one cannot be deleted, only emptied, or the
    // shipped text would come straight back.
    if (has(shipped, was)) mine[was] = '';
    else delete mine[was];
    delete mineSaid[was];
  }
  settle(mine, shipped, name, prompt);
  settle(mineSaid, shippedSaid, name, description);
  // A description equal to the one it would have anyway is not worth keeping.
  if (!has(shippedSaid, name) && !description) delete mineSaid[name];
  return { name, mine, mineSaid };
}

/** A snippet removed: yours is deleted, a shipped one is switched off. */
function remove(held, rawName) {
  const h = held || {};
  const shipped = lower(h.shipped);
  const mine = lower(h.mine);
  const mineSaid = lower(h.mineSaid);
  const name = text(rawName).trim().replace(/^\/+/, '').toLowerCase();
  if (OWN_NAMES.includes(name)) refuse('/' + name + ' is one of NikUI\'s own commands.');
  if (!list(h).some((e) => e.kind === 'snippet' && e.name === name)) refuse('/' + name + ' is not there any more.');
  if (has(shipped, name)) mine[name] = '';
  else delete mine[name];
  delete mineSaid[name];
  return { name, mine, mineSaid };
}

/** A shipped snippet put back the way it ships. */
function restore(held, rawName) {
  const h = held || {};
  const mine = lower(h.mine);
  const mineSaid = lower(h.mineSaid);
  const name = text(rawName).trim().replace(/^\/+/, '').toLowerCase();
  if (!has(lower(h.shipped), name)) refuse('/' + name + ' is not one NikUI ships, so there is nothing to put back.');
  delete mine[name];
  delete mineSaid[name];
  return { name, mine, mineSaid };
}

module.exports = { OWN, OWN_NAMES, list, save, remove, restore, summarise, MAX_PROMPT, MAX_DESCRIPTION, MAX_NAME };
