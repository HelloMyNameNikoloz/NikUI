'use strict';

// Enough of the VS Code API to load and exercise the extension outside the host.
const Module = require('module');
const path = require('path');
const { EventEmitter } = require('events');

function makeStub(overrides) {
  const registered = { commands: {}, views: [], serializers: [] };
  const config = Object.assign({ groupByProject: 'auto' }, (overrides && overrides.config) || {});

  const stub = {
    __registered: registered,
    __config: config,
    EventEmitter: class {
      constructor() { this._e = new EventEmitter(); this.event = (fn) => { this._e.on('x', fn); return { dispose() {} }; }; }
      fire(v) { this._e.emit('x', v); }
      dispose() {}
    },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    ThemeIcon: Object.assign(
      class { constructor(id, color) { this.id = id; this.color = color; } },
      { Folder: { id: 'folder' }, File: { id: 'file' } }
    ),
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(v) { this.value = v; } },
    DataTransferItem: class { constructor(v) { this.value = v; } },
    Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1, Beside: -2 },
    Uri: {
      file: (p) => ({ fsPath: p, toString: () => 'file://' + p }),
      joinPath: (base, ...rest) => ({ fsPath: path.join(base.fsPath, ...rest), toString() { return 'file://' + path.join(base.fsPath, ...rest); } })
    },
    window: {
      createTreeView: (id) => { registered.views.push(id); return { badge: undefined, dispose() {}, onDidChangeVisibility: () => ({ dispose() {} }) }; },
      createWebviewPanel: () => ({
        webview: { html: '', cspSource: 'stub', options: {}, asWebviewUri: (u) => u, onDidReceiveMessage: () => ({ dispose() {} }), postMessage() {} },
        onDidDispose: () => ({ dispose() {} }), reveal() {}, dispose() {}
      }),
      registerWebviewPanelSerializer: (type, s) => { registered.serializers.push(type); return { dispose() {} }; },
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showInputBox: async () => undefined,
      showWarningMessage: async () => undefined,
      showTextDocument: async () => ({}),
      setStatusBarMessage: () => {}
    },
    commands: {
      registerCommand: (id, fn) => { registered.commands[id] = fn; return { dispose() {} }; },
      executeCommand: async () => {}
    },
    workspace: {
      workspaceFolders: (overrides && overrides.workspaceFolders) ||
        [{ name: 'Peuka', uri: { fsPath: '/Users/nikoloz/Codes/Peuka' } }],
      getConfiguration: () => ({ get: (key, fallback) => (key in config ? config[key] : fallback) }),
      openTextDocument: async () => ({})
    }
  };
  return stub;
}

let installed = null;

/** Route require('vscode') to the stub for the rest of the process. */
function install(overrides) {
  // Modules cache require('vscode') on first load, so every caller has to get
  // the same object or later tests mutate a stub nobody is reading.
  if (installed) {
    if (overrides && overrides.config) Object.assign(installed.__config, overrides.config);
    return installed;
  }
  const stub = makeStub(overrides);
  if (!installed) {
    const original = Module._load;
    Module._load = function (request, ...rest) {
      if (request === 'vscode') return installed;
      return original.apply(this, [request, ...rest]);
    };
  }
  installed = stub;
  return stub;
}

function memoryState() {
  const store = {};
  return {
    get: (key, fallback) => (key in store ? store[key] : fallback),
    update: (key, value) => { store[key] = value; },
    __store: store
  };
}

function fakeContext(extra) {
  return Object.assign({
    subscriptions: [],
    extensionUri: { fsPath: path.join(__dirname, '..', '..') },
    workspaceState: memoryState(),
    globalState: memoryState()
  }, extra || {});
}

module.exports = { install, fakeContext, memoryState };
