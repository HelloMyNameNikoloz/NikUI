'use strict';

const vscode = require('vscode');

/**
 * The devices that can reach this window, and what each of them is allowed.
 *
 * This list is the answer to "who else can see my agents", so it says the
 * uncomfortable part out loud: a device with control can send prompts, and a
 * prompt is arbitrary code execution on this machine.
 */
class DevicesTree {
  constructor(devices, server) {
    this.devices = devices;
    this.server = server;
    this._changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._changed.event;
    this.stopWatching = devices.onChange(() => this.refresh());
  }

  refresh() {
    this._changed.fire();
  }

  dispose() {
    if (this.stopWatching) this.stopWatching();
    this._changed.dispose();
  }

  getChildren() {
    return this.devices.list()
      .slice()
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  }

  getTreeItem(device) {
    const item = new vscode.TreeItem(device.name, vscode.TreeItemCollapsibleState.None);
    item.id = 'device:' + device.id;
    item.description = (device.control ? 'can steer' : 'watching only') + ' · ' + since(device.lastSeenAt);
    item.contextValue = device.control ? 'nikui.device.control' : 'nikui.device.watching';
    item.iconPath = new vscode.ThemeIcon(
      device.control ? 'device-mobile' : 'eye',
      device.control ? new vscode.ThemeColor('charts.orange') : undefined
    );
    item.tooltip = new vscode.MarkdownString(
      `**${device.name}**\n\n` +
      `- ${device.control ? 'Can send prompts, answer permissions and interrupt.' : 'Can watch. Cannot send anything.'}\n` +
      `- Paired ${when(device.pairedAt)}\n` +
      `- Last seen ${when(device.lastSeenAt)}\n` +
      `- Key ${device.fingerprint || 'unknown'}\n\n` +
      (device.control
        ? 'A prompt from this device runs with the same permissions as one typed here.'
        : 'Grant control from the right-click menu if it should be able to steer.')
    );
    return item;
  }
}

function since(at) {
  if (!at) return 'never connected';
  const ms = Date.now() - at;
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
  return Math.round(ms / 86400000) + 'd ago';
}

function when(at) {
  return at ? new Date(at).toLocaleString() : 'never';
}

module.exports = { DevicesTree };
