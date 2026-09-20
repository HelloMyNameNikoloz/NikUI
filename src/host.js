'use strict';

const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { readConfig } = require('./manager');
const { transcriptPath } = require('./history');

/**
 * The parts of the picture only the editor and the machine can supply.
 *
 * A hub is shared by every client watching an instance, so these cannot belong
 * to any one of them: a file opened from the phone opens in the editor on this
 * laptop, whether or not a panel happens to be on screen. Built once per window
 * and handed to the hub; transports add only their own chrome on top.
 */
function createHost(context, manager, extras) {
  const devices = (extras && extras.devices) || null;
  const awake = (extras && extras.awake) || null;
  return {
    // Whose window this is. A host belongs to one manager, and handing a hub
    // somebody else's would give it the wrong fleet — which is exactly what a
    // process-wide "installed host" would do if it were not checked.
    manager,
    config: () => readConfig(),
    home: os.homedir(),
    knownCommands: () => (manager ? manager.knownCommands() : []),
    fleet: () => (manager ? manager.list : []),
    env: (session) => describeEnv(context, manager, session, devices, awake),
    openFile: (req) => openFile(req),
    runInTerminal: (req) => runInTerminal(req),
    switchTo: (id, from) => switchTo(context, manager, id, from),
    // What arrived from a device, allowed or not. The editor's own panel has no
    // device and so is never written down: the trail is about what came from
    // somewhere else.
    audit: devices ? (entry) => devices.record(entry) : undefined
  };
}

/** What the status report can only learn from the editor and the machine. */
/**
 * What protects a connection from here, in the two words that decide it: is
 * every device required to seal the channel, and is anything but the app
 * served at all.
 */
function reachState() {
  let cfg;
  try { cfg = require('vscode').workspace.getConfiguration('nikui'); }
  catch (_) { return { sealed: true, appOnly: false }; }
  return {
    sealed: cfg.get('remote.requireEncryption', true),
    appOnly: cfg.get('remote.appOnly', false)
  };
}

function describeEnv(context, manager, session, devices, awake) {
  const cfg = readConfig();
  return {
    awake: awake ? awake.state() : null,
    devices: devices ? devices.list().map((d) => ({
      name: d.name, control: !!d.control, lastSeenAt: d.lastSeenAt, pairedAt: d.pairedAt,
      protection: d.protection || 'software', biometric: !!d.biometric,
      reach: { push: !!d.push, apple: !!d.apns }
    })) : [],
    trail: devices ? devices.recent(20) : [],
    reach: reachState(),
    transcriptPath: transcriptPath(session.cwd, session.claudeSessionId),
    limits: (manager && manager.limits) || session.limits || null,
    pause: (manager && manager.pause) || null,
    vscode: vscode.version,
    node: process.versions.node,
    electron: process.versions.electron || null,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpus: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1073741824),
    extension: context && context.extension ? context.extension.packageJSON.version : null,
    home: os.homedir(),
    showThinking: cfg.showThinking,
    groupByProject: vscode.workspace.getConfiguration('nikui').get('groupByProject', 'auto')
  };
}

/** Open a path the model mentioned, resolved against the instance's folder. */
/**
 * Put a command into a real terminal, without running it.
 *
 * Typed in and left there, because a command somebody has not read is not a
 * command they have agreed to run — and in the editor they are right there,
 * one Return away. The phone is the other case: there is nothing to type into,
 * nobody watching it, and asking would mean a second trip.
 */
async function runInTerminal(req) {
  const command = String((req && req.command) || '').trim();
  if (!command) return false;
  const name = 'NikUI' + (req && req.label ? ' \u00b7 ' + req.label : '');
  const open = vscode.window.terminals.find((t) => t.name === name);
  const terminal = open || vscode.window.createTerminal({ name, cwd: (req && req.cwd) || undefined });
  terminal.show(true);
  terminal.sendText(command, false);
  return true;
}

async function openFile(req) {
  const raw = String((req && req.path) || '').trim();
  if (!raw) return;
  const abs = path.isAbsolute(raw) ? raw : path.join((req && req.cwd) || '', raw);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const line = Math.max(0, (Number(req && req.line) || 1) - 1);
    const at = new vscode.Range(line, 0, line, 0);
    await vscode.window.showTextDocument(doc, { selection: at, preview: true, viewColumn: vscode.ViewColumn.Beside });
  } catch (_) {
    vscode.window.setStatusBarMessage('NikUI: could not open ' + raw, 3000);
  }
}

/** Jump to another instance straight from the fleet table. */
function switchTo(context, manager, id, from) {
  if (!manager || !id) return;
  const target = manager.get(id);
  if (!target || (from && target.id === from.id)) return;
  // Required late: the panel is a client of the hub this host serves.
  const { SessionPanel } = require('./panel');
  SessionPanel.show(target, context, manager).focusInput();
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
