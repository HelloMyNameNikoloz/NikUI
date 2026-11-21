'use strict';

/**
 * NikUI's settings as the engine uses them, from any source with VS Code's
 * configuration shape: `get(key, fallback)` and, optionally, `inspect(key)`.
 *
 * No editor here. In a window the source is VS Code's configuration; a future
 * service adapter supplies its own settings. Same defaults either
 * way, so a setting means the same thing wherever it is read.
 */

const properties = require('../package.json').contributes.configuration.properties;

// Object defaults must be fresh: callers may merge or edit what they read.
function defaultValue(key) {
  const value = properties['nikui.' + key].default;
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function readSnippets(cfg) {
  let shipped = defaultValue('promptSnippets');
  try {
    const declared = cfg.inspect && cfg.inspect('promptSnippets');
    if (declared && declared.defaultValue !== undefined) shipped = declared.defaultValue;
  } catch (_) { /* older host, or a stub */ }
  return Object.assign({}, shipped, cfg.get('promptSnippets', {}));
}

function readConfig(cfg) {
  const get = (key) => cfg.get(key, defaultValue(key));
  return {
    claudePath: get('claudePath'),
    model: get('model'),
    permissionMode: get('permissionMode'),
    effort: get('effort'),
    outputStyle: get('outputStyle'),
    extraArgs: get('extraArgs'),
    longCommandsInBackground: get('longCommandsInBackground'),
    autoTitle: get('autoTitleFromTicket'),
    fontFamily: get('fontFamily'),
    fontSize: get('fontSize'),
    showThinking: get('showThinking'),
    clock: get('clock'),
    replySuggestions: get('replySuggestions'),
    pauseOnLimit: get('pauseWhenQuotaRuns'),
    resumePrompt: get('resumePrompt'),
    notifyOnAttention: get('notifyOnAttention'),
    promptSnippets: readSnippets(cfg),
    interruptOnSingleEscape: get('interruptOnSingleEscape'),
    maxItems: get('maxTranscriptItems'),
    keepPanelsWarm: get('keepHiddenPanelsWarm'),
    statusEmoji: get('statusEmoji')
  };
}

module.exports = { readConfig, readSnippets };
