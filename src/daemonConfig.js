'use strict';

const path = require('path');
const properties = require('../package.json').contributes.configuration.properties;
const { inside, fail } = require('./daemonPaths');

// Fixed P1-02 dispositions, in manifest key form without the nikui prefix.
const EDITOR = new Set(['keepInstancesAcrossReloads', 'keepHiddenPanelsWarm', 'statusEmoji', 'groupByProject']);
const MACHINE = new Set(['claudePath', 'extraArgs', 'remote.port', 'remote.autoStart', 'remote.tailnet', 'remote.terminal',
  'remote.requireEncryption', 'remote.appOnly', 'apns.teamId', 'apns.keyId', 'apns.keyFile', 'apns.bundleId', 'apns.production',
  'voice.enabled', 'keepAwake', 'lidClosed', 'repoFolders', 'codeRoots', 'codexPath', 'codexAccount', 'codexComputerUse', 'codexXcode']);
const PROJECT = new Set(['model', 'longCommandsInBackground', 'autoTitleFromTicket', 'fontFamily', 'fontSize', 'promptSnippets',
  'promptSnippetDescriptions', 'resumePrompt', 'watchCIAfterPush', 'interruptOnSingleEscape', 'maxTranscriptItems',
  'replySuggestions', 'showThinking', 'effort', 'outputStyle']);
const clone = (v) => v === undefined ? undefined : structuredClone(v);
function disposition(key) { return EDITOR.has(key) ? 'editor-only' : MACHINE.has(key) ? 'machine-policy-local-only' : 'engine-user'; }
function validValue(value, schema) {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type !== type || (schema.enum && !schema.enum.includes(value)) ||
      (type === 'number' && !Number.isFinite(value)) ||
      (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) return false;
  if (type === 'array' && schema.items && !value.every((entry) => validValue(entry, schema.items))) return false;
  if (type === 'object') for (const [key, entry] of Object.entries(value)) {
    const member = schema.properties && schema.properties[key];
    if ((!member && schema.additionalProperties === false) ||
        (member && !validValue(entry, member)) ||
        (!member && schema.additionalProperties && !validValue(entry, schema.additionalProperties))) return false;
  }
  return true;
}
function validateValues(values, project = false) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail('CONFIG_INVALID', 'Settings must be a key/value object');
  for (const [key, value] of Object.entries(values)) {
    const schema = properties['nikui.' + key];
    if (!schema || EDITOR.has(key) || (project && !PROJECT.has(key))) throw fail('CONFIG_SCOPE', 'Unknown or unsupported setting for this scope');
    if (!validValue(value, schema)) {
      throw fail('CONFIG_INVALID', 'A private setting has an invalid type or value');
    }
  }
}

function createDaemonConfig({ user = {}, projects = [], root, persist = () => {} } = {}) {
  validateValues(user);
  if (!Array.isArray(projects)) throw fail('CONFIG_INVALID', 'Project imports must be an array');
  let imports = projects.map((record) => {
    if (!record || record.approved !== true || !record.provenance ||
        !['profile', 'workspace', 'rawScope'].every((key) => typeof record.provenance[key] === 'string' && record.provenance[key]) ||
        !path.isAbsolute(record.root || '') || !inside(root, path.resolve(record.root))) {
      throw fail('CONFIG_PROVENANCE', 'Project settings require an explicit private root, owner approval and source provenance');
    }
    validateValues(record.values, true);
    return { ...clone(record), root: path.resolve(record.root) };
  });
  let values = clone(user);
  let writes = Promise.resolve();
  const listeners = new Set();
  function source(cwd) {
    const selected = cwd && imports.filter((p) => inside(p.root, path.resolve(cwd))).sort((a, b) => b.root.length - a.root.length)[0];
    const projectValues = selected ? selected.values : {};
    return {
      get(key, fallback) {
        if (EDITOR.has(key)) return clone(properties['nikui.' + key].default);
        if (['promptSnippets', 'promptSnippetDescriptions'].includes(key) && Object.hasOwn(projectValues, key)) {
          return { ...clone(values[key] || {}), ...clone(projectValues[key]) };
        }
        if (Object.hasOwn(projectValues, key)) return clone(projectValues[key]);
        if (Object.hasOwn(values, key)) return clone(values[key]);
        const schema = properties['nikui.' + key];
        return clone(schema ? schema.default : fallback);
      },
      inspect(key) { return { defaultValue: clone(properties['nikui.' + key] && properties['nikui.' + key].default),
        globalValue: clone(values[key]), workspaceFolderValue: clone(projectValues[key]) }; },
      async update(key, value) {
        // This reader backs existing curated controls; unrestricted machine
        // administration/import is not a remote settings API.
        if (MACHINE.has(key) && !['keepAwake', 'lidClosed'].includes(key)) throw fail('LOCAL_OWNER_REQUIRED', 'Machine policy changes require local owner administration');
        validateValues({ [key]: value });
        const changed = writes.then(async () => {
          const next = { ...values, [key]: clone(value) };
          const committed = await persist({ version: 1, user: next, projects: imports }, { key, value: clone(value) });
          values = clone(committed && committed.user || next);
          for (const fn of listeners) fn({ affectsConfiguration: (name) => name === 'nikui.' + key || ('nikui.' + key).startsWith(name + '.') });
        });
        writes = changed.catch(() => {});
        return changed;
      }
    };
  }
  const base = source();
  return Object.assign(base, { forProject: source,
    refreshAll(next) {
      // Local administration uses the complete validated snapshot. Existing
      // curated update() and refresh(userValues) retain their original scope.
      createDaemonConfig({ ...next, root });
      imports = clone(next.projects); values = clone(next.user);
      for (const fn of listeners) fn({ affectsConfiguration: (name) => name === 'nikui' || name.startsWith('nikui.') });
    },
    refresh(userValues) {
      validateValues(userValues);
      if (JSON.stringify(values) === JSON.stringify(userValues)) return;
      values = clone(userValues);
      for (const fn of listeners) fn({ affectsConfiguration: (name) => name === 'nikui' || name.startsWith('nikui.') });
    },
    onDidChangeConfiguration(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } });
}

module.exports = { createDaemonConfig, disposition, PROJECT, MACHINE, EDITOR };
