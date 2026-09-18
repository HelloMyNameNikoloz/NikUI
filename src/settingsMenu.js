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
  ['nikui.notifyDevices', 'This window, and the phone that reaches it'],
  ['nikui.notifyOnAttention', 'This machine']
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
  'nikui.autoTitleFromTicket': 'Name instances after the ticket in the folder',
  'nikui.fontFamily': 'Font',
  'nikui.fontSize': 'Font size',
  'nikui.promptSnippets': 'Prompt snippets',
  'nikui.pauseWhenQuotaRuns': 'Pause everything when the quota runs out',
  'nikui.resumePrompt': 'What to say when an instance is resumed',
  'nikui.notifyOnAttention': 'Notify in the editor when something needs you',
  'nikui.interruptOnSingleEscape': 'One Escape interrupts, rather than two',
  'nikui.maxTranscriptItems': 'How much transcript to keep on screen',
  'nikui.keepHiddenPanelsWarm': 'Keep hidden panels loaded',
  'nikui.showThinking': 'Show thinking',
  'nikui.statusEmoji': 'Emoji per status in tab titles',
  'nikui.groupByProject': 'Group instances by project folder',
  'nikui.remote.port': 'Port for the local server',
  'nikui.remote.autoStart': 'Start the server when this window opens',
  'nikui.remote.requireEncryption': 'Require devices to encrypt end to end',
  'nikui.remote.appOnly': 'Serve the app only, no browser page',
  'nikui.keepAwake': 'Hold this machine awake while an instance needs it',
  'nikui.notifyDevices': 'What is worth sending to a paired phone',
  'nikui.apns.teamId': 'Apple team ID',
  'nikui.apns.keyId': 'APNs key ID',
  'nikui.apns.keyFile': 'Path to the .p8 key file',
  'nikui.apns.bundleId': 'App bundle identifier',
  'nikui.apns.production': 'Send to Apple’s production network'
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

const write = (key, value) =>
  vscode.workspace.getConfiguration('nikui')
    .update(key.replace(/^nikui\./, ''), value, targetFor(key));

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

/** Change one, in whichever way its type is changed. */
async function edit(row) {
  const { key, definition } = row;
  const value = read(key, definition.default);

  if (definition.type === 'boolean') {
    await write(key, !value);
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
    if (picked.row) await edit(picked.row);
  }
}

/** The extension's own contributed settings, read from where they are declared. */
function schemaFrom(extensionPath) {
  const manifest = require(path.join(extensionPath, 'package.json'));
  return ((manifest.contributes || {}).configuration || {}).properties || {};
}

module.exports = {
  openSettings, buildItems, settingRows, schemaFrom,
  nameFor, groupFor, shown, summarise, GROUPS, NAMES, OTHER
};
