'use strict';

const vscode = require('vscode');
const path = require('path');

/**
 * Everything NikUI can be told, in one list.
 *
 * Built from the extension's own `contributes.configuration` rather than from a
 * second list written by hand, so a setting added to package.json appears here
 * without anybody remembering to add it — and one removed cannot linger as a
 * row that writes a key nothing reads.
 *
 * A quick pick rather than a webview: this is a list of things to change, it is
 * keyboard-driven, it filters as you type, and it reopens after each change so
 * three toggles are three keystrokes rather than three trips.
 */

// Where each key belongs. Matched longest-prefix-first, so `remote.` wins over
// the fallback without either needing to know about the other.
const GROUPS = [
  ['nikui.remote.', 'This window, and the phone that reaches it'],
  ['nikui.apns.', 'Telling an iPhone while the app is closed'],
  ['nikui.claudePath', 'Instances'],
  ['nikui.model', 'Instances'],
  ['nikui.permissionMode', 'Instances'],
  ['nikui.effort', 'Instances'],
  ['nikui.outputStyle', 'Instances'],
  ['nikui.extraArgs', 'Instances'],
  ['nikui.pauseWhenQuotaRuns', 'Instances'],
  ['nikui.resumePrompt', 'Instances'],
  ['nikui.autoTitleFromTicket', 'Instances'],
  ['nikui.keepAwake', 'This machine'],
  ['nikui.lidClosed', 'This machine'],
  ['nikui.notifyDevices', 'This window, and the phone that reaches it'],
  ['nikui.notifyOnAttention', 'This machine'],
  ['nikui.notifyWhenDone', 'This machine'],
  ['nikui.notifyCI', 'This machine'],
  ['nikui.watchCIAfterPush', 'Instances'],
  ['nikui.slack.', 'Slack']
];
const OTHER = 'The panel';

/** Where the derived name would be poor, or plain wrong. */
const NAMES = {
  'nikui.claudePath': 'Path to the claude command',
  'nikui.model': 'Model',
  'nikui.permissionMode': 'Permission mode',
  'nikui.effort': 'Reasoning effort',
  'nikui.outputStyle': 'Output style',
  'nikui.extraArgs': 'Extra arguments to claude',
  'nikui.autoTitleFromTicket': 'Name instances automatically',
  'nikui.fontFamily': 'Font',
  'nikui.fontSize': 'Font size',
  'nikui.promptSnippets': 'Prompt snippets',
  'nikui.promptSnippetDescriptions': 'What each prompt snippet is for',
  'nikui.pauseWhenQuotaRuns': 'Pause everything when the quota runs out',
  'nikui.resumePrompt': 'What to say when an instance is resumed',
  'nikui.notifyOnAttention': 'Notify in the editor when something needs you',
  'nikui.notifyWhenDone': 'Notify on this laptop when an instance is done',
  'nikui.notifyWhenDoneSound': 'Play a chime with that notification',
  'nikui.notifyCI': 'Notify on this laptop when a PR\'s CI is green or fails',
  'nikui.watchCIAfterPush': 'Watch a PR\'s CI after an instance pushes to it',
  'nikui.interruptOnSingleEscape': 'One Escape interrupts, rather than two',
  'nikui.maxTranscriptItems': 'How much transcript to keep on screen',
  'nikui.keepHiddenPanelsWarm': 'Keep hidden panels loaded',
  'nikui.showThinking': 'Show thinking',
  'nikui.clock': 'Times: 24-hour or 12-hour',
  'nikui.replySuggestions': 'Suggest replies',
  'nikui.statusEmoji': 'Emoji per status in tab titles',
  'nikui.groupByProject': 'Group instances by project folder',
  'nikui.remote.port': 'Port for the local server',
  'nikui.remote.autoStart': 'Start the server when this window opens',
  'nikui.remote.requireEncryption': 'Require devices to encrypt end to end',
  'nikui.remote.appOnly': 'Serve the app only, no browser page',
  'nikui.keepAwake': 'Keep this laptop awake, so your phone can always reach it',
  'nikui.lidClosed': 'Keep working with the lid closed, then sleep',
  'nikui.notifyDevices': 'What is worth sending to a paired phone',
  'nikui.apns.teamId': 'Apple team ID',
  'nikui.apns.keyId': 'APNs key ID',
  'nikui.apns.keyFile': 'Path to the .p8 key file',
  'nikui.apns.bundleId': 'App bundle identifier',
  'nikui.apns.production': 'Send to Apple’s production network',
  'nikui.slack.enabled': 'Watch Slack for your VIPs and @mentions',
  'nikui.slack.vips': 'Your Slack VIPs',
  'nikui.slack.mentions': 'Include messages that @mention you',
  'nikui.slack.popupOnLaptop': 'Pop the chat up in the editor',
  'nikui.slack.popupAfterMinutes': 'Minutes before it pops up',
  'nikui.slack.alarmOnPhone': 'Ring the phone',
  'nikui.slack.alarmAfterMinutes': 'Minutes before the phone rings',
  'nikui.slack.previewOnPhone': 'Show the message on the phone'
};

function groupFor(key) {
  let best = null;
  for (const [prefix, name] of GROUPS) {
    if (!key.startsWith(prefix)) continue;
    if (!best || prefix.length > best[0].length) best = [prefix, name];
  }
  return best ? best[1] : OTHER;
}

/** A name for a key nobody wrote one for: `remote.appOnly` → "App only". */
function nameFor(key) {
  if (NAMES[key]) return NAMES[key];
  const last = key.split('.').pop();
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** What a setting is worth showing as, on one line. */
function shown(value, schema) {
  if (schema.type === 'boolean') return value ? 'On' : 'Off';
  if (value === '' || value === null || value === undefined) return 'not set';
  if (Array.isArray(value)) return value.length ? value.length + ' item' + (value.length === 1 ? '' : 's') : 'none';
  if (typeof value === 'object') return Object.keys(value).length + ' entries';
  const text = String(value);
  return text.length > 44 ? text.slice(0, 43) + '…' : text;
}

/** The first sentence of the description, which is the part that fits. */
function summarise(schema) {
  const said = schema.markdownDescription || schema.description || '';
  const first = String(said).replace(/`/g, '').split(/(?<=\.)\s/)[0];
  return first.length > 150 ? first.slice(0, 149) + '…' : first;
}

/**
 * Where to write a change.
 *
 * If a workspace has already said something about this key, that is what is in
 * force — writing the global one would appear to do nothing, which is the
 * worst way for a settings screen to behave.
 */
function targetFor(key) {
  const name = key.replace(/^nikui\./, '');
  const held = vscode.workspace.getConfiguration('nikui').inspect(name) || {};
  if (held.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (held.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

const read = (key, fallback) =>
  vscode.workspace.getConfiguration('nikui').get(key.replace(/^nikui\./, ''), fallback);

/**
 * Whether VS Code has loaded this setting yet.
 *
 * It learns an extension's settings from its package.json when a window
 * starts — and an extension installed as a link to its own source can start
 * from a copy VS Code kept of an older one, noticing the difference only a
 * moment later. A setting added since then cannot be written until the window
 * reloads once more, and VS Code's own words for that, "is not a registered
 * configuration", do not say so. This happened to `nikui.lidClosed` the
 * morning after it was added.
 *
 * Every setting NikUI declares has a default, so a setting with none is one
 * VS Code has not heard of. A host with no way to ask is taken at its word.
 */
function registered(key) {
  const cfg = vscode.workspace.getConfiguration('nikui');
  if (typeof cfg.inspect !== 'function') return true;
  try {
    const seen = cfg.inspect(key.replace(/^nikui\./, ''));
    return !!seen && seen.defaultValue !== undefined;
  } catch (_) { return true; }
}

/** Declared in package.json and not loaded by this window: it started from an old copy. */
function unloaded(schema) {
  return Object.keys(schema || {}).filter((key) => !registered(key));
}

function notLoaded(key) {
  const err = new Error('VS Code on the laptop has not loaded this setting yet. Reload its window once and it will work.');
  err.code = 'NOT_LOADED';
  err.key = key;
  return err;
}

/**
 * Said once, with the one thing that fixes it as the button. From a phone this
 * is what whoever is at the laptop sees; the phone is told in words of its own.
 */
let offering = false;
function offerReload() {
  if (offering) return;
  offering = true;
  Promise.resolve(vscode.window.showWarningMessage(
    'NikUI was updated, and VS Code is still using its old list of NikUI\u2019s settings. Reload the window to finish.',
    'Reload Window'
  )).then((choice) => {
    offering = false;
    if (choice) vscode.commands.executeCommand('workbench.action.reloadWindow');
  }, () => { offering = false; });
}

/**
 * Write one. Refused before VS Code is asked, when VS Code would refuse it: a
 * change that cannot land should say why, and should not be preceded by a
 * password dialog for nothing.
 */
const write = (key, value, target) => {
  if (!registered(key)) {
    offerReload();
    return Promise.reject(notLoaded(key));
  }
  return vscode.workspace.getConfiguration('nikui')
    .update(key.replace(/^nikui\./, ''), value, target || targetFor(key));
};

/** Every setting this extension contributes, as the rows of a list. */
function settingRows(schema) {
  const properties = schema || {};
  const rows = [];
  for (const [key, definition] of Object.entries(properties)) {
    const value = read(key, definition.default);
    rows.push({
      key,
      definition,
      group: groupFor(key),
      label: nameFor(key),
      description: shown(value, definition),
      detail: summarise(definition),
      changed: JSON.stringify(value) !== JSON.stringify(definition.default)
    });
  }
  return rows;
}

/**
 * The menu itself.
 *
 * @param {object} deps
 * @param {object} deps.schema   contributes.configuration.properties
 * @param {Array}  [deps.actions] things to do rather than settings to change
 */
async function buildItems(deps) {
  const separator = (label) => {
    const kind = vscode.QuickPickItemKind && vscode.QuickPickItemKind.Separator;
    return kind === undefined ? null : { label, kind };
  };

  const items = [];
  const actions = deps.actions || [];
  if (actions.length) {
    const first = separator('Do');
    if (first) items.push(first);
    for (const action of actions) {
      items.push({ label: action.label, description: action.description, detail: action.detail, action });
    }
  }

  const rows = settingRows(deps.schema);
  const groups = [];
  for (const row of rows) if (!groups.includes(row.group)) groups.push(row.group);

  for (const group of groups) {
    const head = separator(group);
    if (head) items.push(head);
    for (const row of rows.filter((r) => r.group === group)) {
      items.push({
        // A dot for anything no longer at its default, so what has been changed
        // is visible without reading every line.
        label: (row.changed ? '$(circle-filled) ' : '$(blank) ') + row.label,
        description: row.description,
        detail: row.detail,
        row
      });
    }
  }

  const last = separator('Everything at once');
  if (last) items.push(last);
  items.push({
    label: '$(gear) Open these in the Settings editor',
    detail: 'The same settings, with their full descriptions, where they can be searched',
    openEditor: true
  });
  return items;
}

/**
 * Somewhere to keep the model list between openings.
 *
 * Reading two hundred megabytes is quick but not free, and the answer only
 * changes when the CLI does — so it is kept, keyed on the binary itself. The
 * window hands this in; without one the list is simply rebuilt each time, which
 * is correct and slower.
 */
let remembered = null;
const rememberModelsIn = (store) => { remembered = store || null; };

/**
 * The models this CLI knows, newest first, with a way out at the top.
 *
 * "Your Claude Code default" is first because it is the right answer for most
 * people most of the time: it follows whatever they have set globally, and it
 * never goes stale.
 */
async function pickModel(current) {
  const { discover } = require('./models');
  const cfg = vscode.workspace.getConfiguration('nikui');
  const found = await discover({
    claudePath: cfg.get('claudePath', 'claude'),
    cache: remembered
  });

  const rows = [{
    label: 'Your Claude Code default',
    description: current === '' ? 'current' : '',
    detail: 'Whatever `claude` would use on its own',
    option: ''
  }].concat(found.models.map((model) => ({
    label: model.label,
    description: model.id === current ? 'current' : model.id,
    detail: model.detail,
    option: model.id
  })));

  const picked = await vscode.window.showQuickPick(rows, {
    placeHolder: 'Model for every instance',
    title: found.from === 'aliases'
      ? 'Model — the CLI could not be read, so these are the aliases'
      : 'Model'
  });
  return picked ? picked.option : undefined;
}

/**
 * Settings that are more than a value. Turning the lid switch on needs an
 * approval before it means anything, so it is switched the way the rest of the
 * window switches it rather than written straight into the file.
 */
const switchers = new Map();
const useSwitch = (key, fn) => { if (fn) switchers.set(key, fn); else switchers.delete(key); };

/** Change one, in whichever way its type is changed. */
async function edit(row) {
  const { key, definition } = row;
  const value = read(key, definition.default);

  if (switchers.has(key)) {
    await switchers.get(key)(!value);
    return true;
  }

  if (definition.type === 'boolean') {
    await write(key, !value);
    return true;
  }

  // The model is a list, but not one that can be written down: it comes from
  // whichever CLI is installed, so updating Claude Code is what adds a model
  // here. A fixed enum in package.json would be wrong the day one ships, which
  // is exactly how this setting came to be free text in the first place.
  if (key === 'nikui.model') {
    const picked = await pickModel(value);
    if (picked === undefined) return false;
    await write(key, picked);
    return true;
  }

  if (Array.isArray(definition.enum)) {
    const picked = await vscode.window.showQuickPick(
      definition.enum.map((option, at) => ({
        label: String(option),
        description: option === value ? 'current' : '',
        detail: (definition.enumDescriptions || [])[at] || '',
        option
      })),
      { placeHolder: nameFor(key), title: nameFor(key) }
    );
    if (!picked) return false;
    await write(key, picked.option);
    return true;
  }

  if (definition.type === 'number') {
    const typed = await vscode.window.showInputBox({
      title: nameFor(key),
      value: String(value),
      prompt: summarise(definition),
      validateInput: (text) => {
        const n = Number(text);
        if (!Number.isFinite(n)) return 'A number, please.';
        if (definition.minimum !== undefined && n < definition.minimum) return 'At least ' + definition.minimum + '.';
        if (definition.maximum !== undefined && n > definition.maximum) return 'At most ' + definition.maximum + '.';
        return null;
      }
    });
    if (typed === undefined) return false;
    await write(key, Number(typed));
    return true;
  }

  if (definition.type === 'string') {
    const typed = await vscode.window.showInputBox({
      title: nameFor(key),
      value: value === undefined || value === null ? '' : String(value),
      prompt: summarise(definition),
      placeHolder: definition.default ? String(definition.default) : ''
    });
    if (typed === undefined) return false;
    await write(key, typed);
    return true;
  }

  // Objects and arrays are edited as JSON, which is what they are — the
  // Settings editor does that properly and this would only do it worse.
  await vscode.commands.executeCommand('workbench.action.openSettings', key);
  return false;
}

/**
 * Open the menu, and keep it open: changing a setting reopens the list with the
 * new value showing, because settings are rarely changed one at a time.
 */
async function openSettings(deps) {
  for (;;) {
    const items = await buildItems(deps);
    const picked = await vscode.window.showQuickPick(items, {
      title: 'NikUI',
      placeHolder: 'Search every setting, or pick something to do',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) return;

    if (picked.openEditor) {
      return void vscode.commands.executeCommand('workbench.action.openSettings', 'nikui');
    }
    if (picked.action) {
      await picked.action.run();
      if (!picked.action.stayOpen) return;
      continue;
    }
    if (picked.row) {
      try {
        await edit(picked.row);
      } catch (err) {
        // Not loaded yet has already said so, with its button.
        if (!err || err.code !== 'NOT_LOADED') {
          vscode.window.showWarningMessage('NikUI could not change that: ' + ((err && err.message) || 'unknown error'));
        }
      }
    }
  }
}

/** The extension's own contributed settings, read from where they are declared. */
function schemaFrom(extensionPath) {
  const manifest = require(path.join(extensionPath, 'package.json'));
  return ((manifest.contributes || {}).configuration || {}).properties || {};
}

module.exports = {
  openSettings, buildItems, settingRows, schemaFrom, pickModel, rememberModelsIn, useSwitch, write,
  registered, unloaded, offerReload, notLoaded,
  nameFor, groupFor, shown, summarise, GROUPS, NAMES, OTHER
};
