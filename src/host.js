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
  return {
    config: () => readConfig(),
    home: os.homedir(),
    knownCommands: () => (manager ? manager.knownCommands() : []),
    fleet: () => (manager ? manager.list : []),
    env: (session) => describeEnv(context, manager, session, devices),
    openFile: (req) => openFile(req),
    switchTo: (id, from) => switchTo(context, manager, id, from),
    // What arrived from a device, allowed or not. The editor's own panel has no
    // device and so is never written down: the trail is about what came from
    // somewhere else.
    audit: devices ? (entry) => devices.record(entry) : undefined
  };
}

/** What the status report can only learn from the editor and the machine. */
function describeEnv(context, manager, session, devices) {
  const cfg = readConfig();
  return {
    devices: devices ? devices.list().map((d) => ({
      name: d.name, control: !!d.control, lastSeenAt: d.lastSeenAt, pairedAt: d.pairedAt
    })) : [],
    trail: devices ? devices.recent(20) : [],
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

module.exports = { createHost, describeEnv };
