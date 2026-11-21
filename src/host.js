'use strict';

// Legacy extension facade: both transports get the same composed window host.
// The machine host and provider router never import this module.
const { createMachineHost } = require('./machineHost');
const { createEditorHost, editorSettings } = require('./editorHost');
const { codexLimits } = require('./codexLimits');

function createHost(context, manager, extras) {
  const services = extras || {};
  const editor = createEditorHost(context, manager, services);
  const limits = codexLimits();
  return createMachineHost({
    manager,
    settings: editorSettings,
    writeSetting: (key, value) => require('./settingsMenu').write(key, value),
    ledger: services.ledger,
    devices: services.devices,
    awake: services.awake,
    codex: services.codex,
    prFeed: services.prFeed,
    pickPr: services.pickPr,
    setPr: services.setPr,
    editor,
    ui: editor.ui,
    env: () => Object.assign(editor.environment(), {
      extension: context && context.extension ? context.extension.packageJSON.version : null,
      codexLimits: limits
    })
  });
}

/** Kept for extension callers; reporting itself belongs to the machine host. */
function describeEnv(context, manager, session, devices, awake) {
  return theHost(context, manager, { devices, awake }).env(session);
}

/**
 * The window's host, made once.
 *
 * A hub keeps the host of whichever client opened it, so two transports each
 * building their own meant the panel's — which knows nothing about devices —
 * could win the race and quietly turn the audit trail off. There is one now,
 * installed at activation, and both transports ask for it.
 */
let installed = null;

function installHost(host) {
  installed = host;
  return host;
}

function theHost(context, manager, extras) {
  if (installed && installed.manager === manager) return installed;
  // A test, or a window that somehow never activated: build one rather than
  // handing back nothing, but do not install it — activation owns that.
  return createHost(context, manager, extras);
}

function forgetHost() {
  installed = null;
}

module.exports = { createHost, installHost, theHost, forgetHost, describeEnv };
