'use strict';

// Enough of the VS Code API to load and exercise the extension outside the host.
const Module = require('module');
const path = require('path');
const { EventEmitter } = require('events');

function makeStub(overrides) {
  const registered = {
    commands: {}, views: [], serializers: [], treeViews: {}, panels: [],
    statusBars: [], opened: [], copied: [], warnings: [], executed: [], writes: []
  };
  // Settings VS Code "has not loaded": declared in package.json, missing from
  // the window's registry, the way a window started from a stale copy is.
  const unloadedKeys = new Set();
  const config = Object.assign({ groupByProject: 'auto' }, (overrides && overrides.config) || {});

  const stub = {
    __registered: registered,
    version: '1.100.0',
    __config: config,
    __answers: [],
    __unloaded: unloadedKeys,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
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
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ViewColumn: { Active: -1, Beside: -2 },
    Uri: {
      file: (p) => ({ fsPath: p, toString: () => 'file://' + p }),
      parse: (u) => ({ fsPath: u, toString: () => String(u) }),
      joinPath: (base, ...rest) => ({ fsPath: path.join(base.fsPath, ...rest), toString() { return 'file://' + path.join(base.fsPath, ...rest); } })
    },
    window: {
      createTreeView: (id, options) => {
        const view = {
          // Kept so a test can reach the provider — and through it the manager —
          // the same way the extension does.
          provider: options && options.treeDataProvider,
          badge: undefined, visible: true, revealed: [],
          reveal(element, options) { this.revealed.push({ element, options }); return Promise.resolve(); },
          dispose() {}, onDidChangeVisibility: () => ({ dispose() {} })
        };
        registered.views.push(id);
        registered.treeViews[id] = view;
        return view;
      },
      createWebviewPanel: (type, title, column, options) => {
        const panel = {
          __options: options || {},
          active: true, visible: true, viewColumn: 1, title: '', iconPath: null,
          webview: {
            html: '', cspSource: 'stub', options: {}, asWebviewUri: (u) => u,
            onDidReceiveMessage: (fn) => { panel.__onMessage = fn; return { dispose() {} }; },
            posted: [], postMessage(m) { this.posted.push(m); }
          },
          onDidDispose: () => ({ dispose() {} }),
          // Captured so a test can bring the tab forward the way VS Code does.
          onDidChangeViewState: (fn) => { panel.__onViewState = fn; return { dispose() {} }; },
          // The editor makes a revealed panel active, which is what tells the
          // rest of the extension that the selection moved.
          reveal() {
            panel.active = true;
            panel.visible = true;
            if (panel.__onViewState) panel.__onViewState({ webviewPanel: panel });
          },
          dispose() {}
        };
        registered.panels.push(panel);
        return panel;
      },
      registerWebviewPanelSerializer: (type, s) => { registered.serializers.push(type); return { dispose() {} }; },
      // Answerable, so a command that asks something can be driven to the end
      // of what it does rather than only to the question. `__answer` is a queue:
      // each dialog takes the next reply, and an empty queue is somebody
      // pressing Escape, which is the default a test should get for free.
      showQuickPick: async (items) => {
        const want = stub.__answers.shift();
        if (want === undefined) return undefined;
        const list = Array.isArray(items) ? items : await items;
        if (typeof want === 'number') return list[want];
        return list.find((i) => (i && i.label ? i.label : i) === want) || want;
      },
      showOpenDialog: async () => undefined,
      showInputBox: async () => undefined,
      showWarningMessage: async (text) => { registered.warnings.push(String(text)); return stub.__answers.shift(); },
      showTextDocument: async () => ({}),
      showInformationMessage: async () => undefined,
      setStatusBarMessage: () => {},
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => {
        const item = { text: '', tooltip: '', command: null, shown: false,
          show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
        registered.statusBars.push(item);
        return item;
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    env: {
      openExternal: async (uri) => { registered.opened.push(String(uri && uri.toString ? uri.toString() : uri)); return true; },
      clipboard: { writeText: async (text) => { registered.copied.push(text); } }
    },
    commands: {
      registerCommand: (id, fn) => { registered.commands[id] = fn; return { dispose() {} }; },
      executeCommand: async (id) => { registered.executed.push(id); }
    },
    workspace: {
      workspaceFolders: (overrides && overrides.workspaceFolders) ||
        [{ name: 'Peuka', uri: { fsPath: '/Users/nikoloz/Codes/Peuka' } }],
      getConfiguration: () => ({
        get: (key, fallback) => (key in config ? config[key] : fallback),
        inspect: (key) => ({ key, defaultValue: unloadedKeys.has(key) ? undefined : (key in config ? config[key] : null) }),
        update: async (key, value) => {
          if (unloadedKeys.has(key)) {
            throw new Error('Unable to write to User Settings because nikui.' + key + ' is not a registered configuration.');
          }
          registered.writes.push([key, value]);
          config[key] = value;
        }
      }),
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
