'use strict';

/**
 * The settings people actually change, in the words they would use.
 *
 * Not every setting. `/settings` is for the handful that get changed often
 * enough to want a switch — which model, how hard it thinks, whether the laptop
 * may sleep — and each is said the way somebody would say it rather than the
 * way the settings file spells it. Everything else is still in
 * `NikUI: Settings` in the editor, and the sheet says so.
 *
 * Also a list of what may be changed from somewhere else at all. A phone that
 * may send prompts may flip any of these; it may not reach anything that is
 * not on this list — the path to the executable, the extra arguments, whether
 * connections must be sealed — however the message is written.
 *
 * Nothing here knows about VS Code: reading and writing are handed in, so the
 * rules are checked without an editor.
 */

const GROUPS = ['Claude', 'Your laptop', 'Notifications on your laptop', 'Notifications on your phone', 'Slack', 'In the editor'];

const EFFORT = [
  ['', 'Claude Code default'], ['low', 'Low'], ['medium', 'Medium'],
  ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']
];

// Said as what each one does, because the names say what they are called —
// and short, because a picker on a phone shows about twenty letters.
const PERMISSIONS = [
  ['bypassPermissions', 'Never ask'],
  ['acceptEdits', 'Ask, except for edits'],
  ['default', 'Ask before anything'],
  ['plan', 'Plan only']
];

const PREFS = [
  { id: 'model', group: 'Claude', key: 'model', kind: 'model', label: 'Model',
    hint: 'For new and restarted instances. /model changes the one you are in.' },
  { id: 'effort', group: 'Claude', key: 'effort', kind: 'choice', label: 'Effort', choices: EFFORT,
    hint: 'How hard it thinks before it answers.' },
  { id: 'permissions', group: 'Claude', key: 'permissionMode', kind: 'choice', label: 'Permissions',
    choices: PERMISSIONS, hint: 'What it may do without asking you first.' },
  { id: 'thinking', group: 'Claude', key: 'showThinking', kind: 'toggle', label: 'Show thinking' },
  { id: 'clock', group: 'Claude', key: 'clock', kind: 'choice', label: 'Times',
    choices: [['24h', '24-hour'], ['12h', '12-hour']], fallback: '24h', hint: 'When each message was sent, and when each answer came back.' },
  { id: 'replies', group: 'Claude', key: 'replySuggestions', kind: 'toggle', fallback: true,
    label: 'Suggest replies', hint: 'One tap for the obvious answer, like "pushed" when it asks you to push.' },
  { id: 'pause', group: 'Claude', key: 'pauseWhenQuotaRuns', kind: 'toggle',
    label: 'Wait when the usage limit runs out', hint: 'Everything holds, then carries on when it resets.' },

  { id: 'ci.watch', group: 'Claude', key: 'watchCIAfterPush', kind: 'toggle',
    label: 'Watch CI after a push', hint: 'The PR\'s checks, with time left, in the header. /watch does it by hand.' },

  { id: 'awake', group: 'Your laptop', key: 'keepAwake', kind: 'toggle', label: 'Keep awake',
    hint: 'It does not sleep on its own, so your phone can always reach it.' },
  { id: 'lid', group: 'Your laptop', key: 'lidClosed', kind: 'toggle',
    label: 'Keep working with the lid closed', hint: 'While Claude works. When the work is done, it sleeps.' },

  { id: 'done.popup', group: 'Notifications on your laptop', key: 'notifyWhenDone', kind: 'toggle',
    label: 'When an instance is done', hint: 'A notification from the system, even with VS Code behind other windows.' },
  { id: 'done.sound', group: 'Notifications on your laptop', key: 'notifyWhenDoneSound', kind: 'toggle',
    label: 'With a chime', hint: 'Three soft notes rising.' },
  { id: 'ci.popup', group: 'Notifications on your laptop', key: 'notifyCI', kind: 'toggle',
    label: 'When CI is green or fails', hint: 'On a PR an instance pushed to, or one you /watch.' },

  // The same defaults the notifier applies when a key is missing: three on,
  // the one that would buzz all night off.
  { id: 'notify.needsYou', group: 'Notifications on your phone', key: 'notifyDevices', part: 'needsYou',
    kind: 'toggle', fallback: true, label: 'When something needs your answer' },
  { id: 'notify.failed', group: 'Notifications on your phone', key: 'notifyDevices', part: 'failed',
    kind: 'toggle', fallback: true, label: 'When something fails' },
  { id: 'notify.quota', group: 'Notifications on your phone', key: 'notifyDevices', part: 'quota',
    kind: 'toggle', fallback: true, label: 'When the usage limit runs out, and when it resets' },
  { id: 'notify.ci', group: 'Notifications on your phone', key: 'notifyDevices', part: 'ci',
    kind: 'toggle', fallback: true, label: 'When CI on a pull request is green or fails' },
  { id: 'notify.turnFinished', group: 'Notifications on your phone', key: 'notifyDevices', part: 'turnFinished',
    kind: 'toggle', fallback: false, label: 'When a turn finishes', hint: 'Off by default: busy nights are loud.' },

  // Off until you connect it: watching somebody's Slack is not a default.
  { id: 'slack.on', group: 'Slack', key: 'slack.enabled', kind: 'toggle', fallback: false,
    label: 'Watch Slack', hint: 'DMs from your VIPs, and messages that @mention you. /slack to connect and pick VIPs.' },
  { id: 'slack.mentions', group: 'Slack', key: 'slack.mentions', kind: 'toggle', fallback: true,
    label: 'Include @mentions', hint: 'From anybody, in any channel you are in.' },
  { id: 'slack.popup', group: 'Slack', key: 'slack.popupOnLaptop', kind: 'toggle', fallback: true,
    label: 'Pop the chat up on your laptop', hint: 'When a message is still unseen after the wait below.' },
  { id: 'slack.popupAfter', group: 'Slack', key: 'slack.popupAfterMinutes', kind: 'number', min: 1, max: 30,
    fallback: 1, label: 'Minutes before it pops up' },
  { id: 'slack.alarm', group: 'Slack', key: 'slack.alarmOnPhone', kind: 'toggle', fallback: true,
    label: 'Ring your phone', hint: 'Still unseen and unanswered after the wait below. The same alarm as a waiting instance.' },
  { id: 'slack.alarmAfter', group: 'Slack', key: 'slack.alarmAfterMinutes', kind: 'number', min: 1, max: 60,
    fallback: 3, label: 'Minutes before it rings' },
  { id: 'slack.preview', group: 'Slack', key: 'slack.previewOnPhone', kind: 'toggle', fallback: true,
    label: 'Show the message on your phone', hint: 'Off: the notification says only who wrote.' },

  { id: 'fontSize', group: 'In the editor', key: 'fontSize', kind: 'number', min: 10, max: 24,
    label: 'Text size' },
  { id: 'singleEscape', group: 'In the editor', key: 'interruptOnSingleEscape', kind: 'toggle',
    label: 'Stop a turn with one Escape', hint: 'Otherwise it takes two, so one never costs you a turn.' },
  { id: 'attention', group: 'In the editor', key: 'notifyOnAttention', kind: 'toggle',
    label: 'Tell me when an instance needs me' },
  { id: 'ticket', group: 'In the editor', key: 'autoTitleFromTicket', kind: 'toggle',
    label: 'Name instances automatically', hint: 'From the PR or issue in your prompts. A name you give it wins.' }
];

const byId = new Map(PREFS.map((p) => [p.id, p]));

// What a model identifier may look like when it arrives from somewhere else.
// Loose on purpose — the CLI is what knows which exist — and tight enough that
// nothing but an identifier gets written into a setting.
const MODEL_ID = /^[A-Za-z0-9._:/@[\]-]{1,120}$/;

/**
 * Every row, with what it says now.
 *
 * @param {(key: string) => *} get      a setting's current value, without the `nikui.`
 * @param {object} [extra]
 * @param {object} [extra.awake]        the keep-awake switch's own account of itself
 * @param {object[]} [extra.models]     the models this CLI knows, as the composer has them
 */
function read(get, extra) {
  const e = extra || {};
  const rows = PREFS.map((p) => {
    let value = get(p.key);
    if (p.part) value = value && typeof value === 'object' ? value[p.part] : undefined;
    if (value === undefined || value === null) value = p.fallback !== undefined ? p.fallback : value;
    const row = { id: p.id, group: p.group, kind: p.kind, label: p.label, hint: p.hint || '', value };
    if (p.kind === 'choice') row.choices = p.choices.map(([v, label]) => ({ value: v, label }));
    if (p.kind === 'model') row.choices = modelChoices(e.models, value);
    if (p.kind === 'number') { row.min = p.min; row.max = p.max; }
    return row;
  });

  // The two laptop switches say what is true, not only what was asked for.
  const awake = e.awake;
  if (awake) {
    const lid = awake.lid;
    const lidRow = rows.find((r) => r.id === 'lid');
    const awakeRow = rows.find((r) => r.id === 'awake');
    if (awake.supported === false) {
      awakeRow.unavailable = 'Only a Mac can be kept awake from here.';
    } else if (awake.held) {
      awakeRow.note = 'Awake now · ' + (awake.reason || 'on');
    }
    if (!lid || !lid.supported) {
      lidRow.unavailable = 'Only a MacBook can keep working with the lid closed.';
    } else if (lid.on && !lid.approved) {
      lidRow.note = 'Needs your password once, on the laptop.';
      lidRow.warn = true;
    } else if (!lid.on && !lid.approved) {
      lidRow.note = 'Asks for your password once, on the laptop.';
    } else if (lid.lowBattery) {
      lidRow.note = 'Battery low, so the lid will put it to sleep.';
      lidRow.warn = true;
    } else if (lid.held) {
      lidRow.note = 'Working with the lid closed · ' + (lid.reason || 'on');
    } else if (lid.finishing) {
      lidRow.note = 'Done. With the lid closed it sleeps in a moment.';
    }
  } else {
    rows.find((r) => r.id === 'lid').unavailable = 'Not offered by this window.';
  }
  return { groups: GROUPS.slice(), rows };
}

/** "Claude Code default", then the models this CLI knows, newest first. */
function modelChoices(models, current) {
  const out = [{ value: '', label: 'Claude Code default' }];
  const seen = new Set(['']);
  for (const m of models || []) {
    const value = typeof m === 'string' ? m : m && m.value;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    // The name, and what sets it apart: "Opus 5.5 · 1M context". The
    // identifier itself is what gets written, and nobody picks by reading it.
    const label = (m && m.label) || value;
    const detail = m && m.detail ? ' · ' + m.detail : '';
    out.push({ value, label: label + detail });
  }
  // Whatever is set now is always one of the choices, even if this CLI has
  // forgotten it: a picker that cannot show the current value lies about it.
  if (current && !seen.has(current)) out.push({ value: current, label: current });
  return out;
}

/**
 * What a change may be. Throws with something a person can read; returns the
 * value as it will be stored.
 */
function validate(id, value) {
  const p = byId.get(String(id));
  if (!p) throw new Error('That is not a setting that can be changed from here.');
  if (p.kind === 'toggle') {
    if (typeof value !== 'boolean') throw new Error(p.label + ' is on or off.');
    return value;
  }
  if (p.kind === 'choice') {
    if (!p.choices.some(([v]) => v === value)) throw new Error(p.label + ' cannot be "' + value + '".');
    return value;
  }
  if (p.kind === 'model') {
    if (value === '') return '';
    if (typeof value !== 'string' || !MODEL_ID.test(value)) throw new Error('That is not a model name.');
    return value;
  }
  if (p.kind === 'number') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < p.min || n > p.max) {
      throw new Error(p.label + ' goes from ' + p.min + ' to ' + p.max + '.');
    }
    return n;
  }
  throw new Error('That setting cannot be changed from here.');
}

/**
 * Change one. Two of them are more than a value — the laptop switches — and
 * are handed to whatever switches them, so a change here is the same change as
 * one made anywhere else.
 *
 * @param {string} id
 * @param {*} value
 * @param {object} io
 * @param {(key: string) => *} io.get
 * @param {(key: string, value: *) => Promise} io.set
 * @param {Object<string, (value: *) => Promise>} [io.special]  switches, by id
 */
async function write(id, value, io) {
  const clean = validate(id, value);
  const p = byId.get(String(id));
  if (io.special && io.special[p.id]) return io.special[p.id](clean);
  if (p.part) {
    const now = io.get(p.key);
    const merged = Object.assign({}, now && typeof now === 'object' ? now : {}, { [p.part]: clean });
    return io.set(p.key, merged);
  }
  return io.set(p.key, clean);
}

/** The settings keys this list touches, for "did anything it shows just change". */
const KEYS = [...new Set(PREFS.map((p) => 'nikui.' + p.key))];

module.exports = { PREFS, GROUPS, KEYS, read, validate, write, modelChoices };
