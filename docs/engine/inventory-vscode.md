# VS Code dependency inventory — baseline and R08 delta

Snapshot: `132b3c5d5723598699e4ae09176699bfcc4f26f6`, branch `mac-engine`, 2026-11-20. Scope: every explicit `vscode.*` expression in `src/*.js` and `src/slack/*.js`; inline requires and context/returned-handle dependencies are included below. Source references are repository-relative `file:line`. Repeated expressions on one line are counted as occurrences, with one line reference. This is an inventory, not a proposed code change.

At that baseline: 314 literal `vscode.*` occurrences in executable source, including the `vscode.open` command ID; 11 modules import VS Code. `src/slack/*.js` has no direct VS Code calls. No `vscode.env.machineId`, `vscode.env.uriScheme`, SecretStorage through `vscode.*`, or `vscode.diff` call exists; secrets use `context.secrets`, and PR diffs come from `gh` (`src/prView.js:684`).

R07/R08 delta: [`src/config.js`](../../src/config.js) has no editor dependency and supplies manifest defaults; manager accepts `settings:()=>source`. P1 round 1 removes its lazy VS Code path: the zero-argument reader and VS Code source now live in [`src/editorHost.js`](../../src/editorHost.js), activation supplies the source explicitly, and panels use their host's reader. [`src/machineHost.js`](../../src/machineHost.js) and [`src/editorRoute.js`](../../src/editorRoute.js) have no VS Code import; [`src/host.js`](../../src/host.js) composes the extension adapter and keeps the legacy installed-host guard. [Machine-host tests](../../test/machineHost.test.js) exercise lazy paths with VS Code poisoned in a fresh process; P1-05/P1-10 still must prove the complete graph and engine isolation. The tables below retain baseline line anchors, not current line numbers. The [configuration mapping](config-mapping.md) defines the service disposition of every contributed key.

| Class | Current responsibility | Daemon equivalent (proposed boundary) |
| --- | --- | --- |
| CONFIG | Effective `nikui` settings, inspection, scoped writes and change events | Inject config service with source/scope/provenance; extension exports user/workspace/folder values. Preserve existing defaults and precedence in legacy mode. Keep daemon executable/security policy separate from project overrides. |
| STATE | `globalState` / `workspaceState` mementos, globalStorage files | Inject versioned single-writer metadata store; retain source profile/workspace IDs and stable instance IDs during import. See `inventory-state.md`. |
| SECRET | VS Code SecretStorage (Slack credentials) | Keychain-backed secret service; import through extension; never export into ordinary settings. Identity/VAPID are secrets currently in STATE. |
| UI-EDITOR | Workspace context, open/reveal files, actual editor terminal | Authenticated editor capability provider, selected by requester/workspace; explicit unavailable response when no editor is attached. URI authority/scheme must survive, not only `fsPath`. |
| UI-CHROME | Trees, webviews, notifications, menus/dialogs/status/output | Remain in extension/native client. Engine emits data/events and correlated UI requests; native machine notifications are a separate service. |
| LIFECYCLE | Activation, subscriptions/disposal, command and panel restoration registration | LaunchAgent owns engine start/drain/stop; extension activation owns only its client/bridge and editor commands. Preserve legacy path by default. |
| ENV | External browser/system URL opens, clipboard, editor version/app bundle location | Client/OS adapters with requester routing; explicit editor metadata rather than process-global VS Code assumptions. |

## CONFIG

| API / expression | All call-site lines |
| --- | --- |
| `vscode.ConfigurationTarget.Global` | `src/extension.js:835`, `src/extension.js:838`, `src/extension.js:879`, `src/extension.js:1597` |
| `vscode.workspace.getConfiguration` | `src/extension.js:94`, `src/extension.js:149`, `src/extension.js:170`, `src/extension.js:196`, `src/extension.js:216`, `src/extension.js:787`, `src/extension.js:826`, `src/extension.js:984`, `src/extension.js:993`, `src/extension.js:1090`, `src/extension.js:1094`, `src/extension.js:1134`, `src/extension.js:1162`, `src/extension.js:1196`, `src/extension.js:1245`, `src/extension.js:1448`, `src/extension.js:1596`, `src/extension.js:1863`, `src/extension.js:2024`, `src/extension.js:2032`, `src/extension.js:2043` |
| `vscode.workspace.onDidChangeConfiguration` | `src/extension.js:209`, `src/extension.js:761`, `src/extension.js:762`, `src/extension.js:891`, `src/extension.js:892` |
| `require('vscode').workspace.getConfiguration` | `src/host.js:171` |
| `vscode.workspace.getConfiguration` | `src/host.js:102`, `src/host.js:139`, `src/host.js:204` |
| `vscode.workspace.getConfiguration` | `src/manager.js:96` |
| `vscode.ConfigurationTarget.Global` | `src/settingsMenu.js:140` |
| `vscode.ConfigurationTarget.Workspace` | `src/settingsMenu.js:139` |
| `vscode.ConfigurationTarget.WorkspaceFolder` | `src/settingsMenu.js:138` |
| `vscode.workspace.getConfiguration` | `src/settingsMenu.js:137`, `src/settingsMenu.js:144`, `src/settingsMenu.js:161`, `src/settingsMenu.js:208`, `src/settingsMenu.js:303` |
| `vscode.workspace.getConfiguration` | `src/slackHome.js:22` |
| `vscode.workspace.onDidChangeConfiguration` | `src/slackHome.js:168` |
| `vscode.workspace.getConfiguration` | `src/tree.js:232` |

## STATE

No explicit `vscode.*` expression; context-based calls are listed below.

## SECRET

No explicit `vscode.*` expression; context-based calls are listed below.

## UI-EDITOR

| API / expression | All call-site lines |
| --- | --- |
| `vscode.workspace` | `src/extension.js:179` |
| `vscode.workspace.workspaceFile` | `src/extension.js:1992` |
| `vscode.workspace.workspaceFolders` | `src/extension.js:69`, `src/extension.js:98`, `src/extension.js:1038`, `src/extension.js:1884`, `src/extension.js:1994` |
| `vscode.workspace.workspaceFolders` | `src/historyTree.js:111` |
| `vscode.Range` | `src/host.js:255` |
| `vscode.Uri.file` | `src/host.js:232` |
| `vscode.ViewColumn.Beside` | `src/host.js:250`, `src/host.js:256` |
| `vscode.commands.executeCommand` | `src/host.js:246`, `src/host.js:250` |
| Command ID `vscode.open` | `src/host.js:250` |
| `vscode.window.createTerminal` | `src/host.js:222` |
| `vscode.window.showTextDocument` | `src/host.js:256` |
| `vscode.window.terminals.find` | `src/host.js:221` |
| `vscode.workspace.getWorkspaceFolder` | `src/host.js:245` |
| `vscode.workspace.openTextDocument` | `src/host.js:253` |
| `vscode.workspace.workspaceFolders` | `src/tree.js:64` |

## UI-CHROME

| API / expression | All call-site lines |
| --- | --- |
| `vscode.EventEmitter` | `src/devicesTree.js:16` |
| `vscode.MarkdownString` | `src/devicesTree.js:45` |
| `vscode.ThemeColor` | `src/devicesTree.js:43` |
| `vscode.ThemeIcon` | `src/devicesTree.js:41` |
| `vscode.TreeItem` | `src/devicesTree.js:37` |
| `vscode.TreeItemCollapsibleState.None` | `src/devicesTree.js:37` |
| `vscode.QuickPickItemKind` | `src/extension.js:1878` |
| `vscode.QuickPickItemKind.Separator` | `src/extension.js:1878` |
| `vscode.StatusBarAlignment.Right` | `src/extension.js:930` |
| `vscode.Uri.joinPath` | `src/extension.js:1519` |
| `vscode.commands.executeCommand` | `src/extension.js:233`, `src/extension.js:664`, `src/extension.js:1108`, `src/extension.js:1520`, `src/extension.js:1825`, `src/extension.js:1967`, `src/extension.js:2122`, `src/extension.js:2153` |
| `vscode.window` | `src/extension.js:1928`, `src/extension.js:1954`, `src/extension.js:2138` |
| `vscode.window.createOutputChannel` | `src/extension.js:932`, `src/extension.js:933` |
| `vscode.window.createStatusBarItem` | `src/extension.js:929`, `src/extension.js:930` |
| `vscode.window.createTreeView` | `src/extension.js:221`, `src/extension.js:245`, `src/extension.js:1191` |
| `vscode.window.setStatusBarMessage` | `src/extension.js:463`, `src/extension.js:476`, `src/extension.js:480`, `src/extension.js:489`, `src/extension.js:501`, `src/extension.js:549`, `src/extension.js:565`, `src/extension.js:608`, `src/extension.js:710`, `src/extension.js:881`, `src/extension.js:1271`, `src/extension.js:1543`, `src/extension.js:1549`, `src/extension.js:1598`, `src/extension.js:1629`, `src/extension.js:1642`, `src/extension.js:1720`, `src/extension.js:1747`, `src/extension.js:1787` |
| `vscode.window.showErrorMessage` | `src/extension.js:357`, `src/extension.js:712` |
| `vscode.window.showInformationMessage` | `src/extension.js:211`, `src/extension.js:446`, `src/extension.js:627`, `src/extension.js:858`, `src/extension.js:1103`, `src/extension.js:1363`, `src/extension.js:1577`, `src/extension.js:1774`, `src/extension.js:2018`, `src/extension.js:2126` |
| `vscode.window.showInputBox` | `src/extension.js:364`, `src/extension.js:534`, `src/extension.js:571`, `src/extension.js:584`, `src/extension.js:650`, `src/extension.js:675`, `src/extension.js:1764`, `src/extension.js:2235` |
| `vscode.window.showOpenDialog` | `src/extension.js:143`, `src/extension.js:341`, `src/extension.js:1914` |
| `vscode.window.showQuickPick` | `src/extension.js:311`, `src/extension.js:393`, `src/extension.js:647`, `src/extension.js:1653`, `src/extension.js:1778`, `src/extension.js:1909`, `src/extension.js:2227` |
| `vscode.window.showWarningMessage` | `src/extension.js:70`, `src/extension.js:139`, `src/extension.js:408`, `src/extension.js:448`, `src/extension.js:493`, `src/extension.js:511`, `src/extension.js:518`, `src/extension.js:558`, `src/extension.js:599`, `src/extension.js:691`, `src/extension.js:697`, `src/extension.js:702`, `src/extension.js:821`, `src/extension.js:871`, `src/extension.js:900`, `src/extension.js:1249`, `src/extension.js:1318`, `src/extension.js:1329`, `src/extension.js:1341`, `src/extension.js:1356`, `src/extension.js:1504`, `src/extension.js:1526`, `src/extension.js:1532`, `src/extension.js:1548`, `src/extension.js:1634`, `src/extension.js:1647`, `src/extension.js:1698`, `src/extension.js:1730`, `src/extension.js:1752`, `src/extension.js:2242`, `src/extension.js:2243` |
| `vscode.window.state` | `src/extension.js:2027`, `src/extension.js:2061` |
| `vscode.window.state.focused` | `src/extension.js:2027`, `src/extension.js:2061` |
| `vscode.EventEmitter` | `src/historyTree.js:11` |
| `vscode.MarkdownString` | `src/historyTree.js:80` |
| `vscode.ThemeIcon` | `src/historyTree.js:67`, `src/historyTree.js:78` |
| `vscode.TreeItem` | `src/historyTree.js:63`, `src/historyTree.js:76` |
| `vscode.TreeItemCollapsibleState.None` | `src/historyTree.js:64`, `src/historyTree.js:76` |
| `vscode.commands.executeCommand` | `src/historyTree.js:55` |
| `vscode.commands.executeCommand` | `src/host.js:93` |
| `vscode.window.setStatusBarMessage` | `src/host.js:236`, `src/host.js:262` |
| `vscode.window.showWarningMessage` | `src/host.js:54`, `src/host.js:67` |
| `vscode.Uri.joinPath` | `src/pairPanel.js:34`, `src/pairPanel.js:87`, `src/pairPanel.js:88` |
| `vscode.ViewColumn.Active` | `src/pairPanel.js:33` |
| `vscode.window.createWebviewPanel` | `src/pairPanel.js:32` |
| `vscode.Uri.joinPath` | `src/panel.js:77`, `src/panel.js:83`, `src/panel.js:136`, `src/panel.js:168` |
| `vscode.ViewColumn.Active` | `src/panel.js:73` |
| `vscode.window.createWebviewPanel` | `src/panel.js:70` |
| `vscode.window.onDidChangeWindowState` | `src/panel.js:112`, `src/panel.js:113` |
| `vscode.window.state` | `src/panel.js:122` |
| `vscode.window.state.focused` | `src/panel.js:122` |
| `vscode.QuickPickItemKind` | `src/settingsMenu.js:240` |
| `vscode.QuickPickItemKind.Separator` | `src/settingsMenu.js:240` |
| `vscode.commands.executeCommand` | `src/settingsMenu.js:411`, `src/settingsMenu.js:431` |
| `vscode.window.showInputBox` | `src/settingsMenu.js:380`, `src/settingsMenu.js:398` |
| `vscode.window.showQuickPick` | `src/settingsMenu.js:321`, `src/settingsMenu.js:365`, `src/settingsMenu.js:422` |
| `vscode.window.showWarningMessage` | `src/settingsMenu.js:189`, `src/settingsMenu.js:444` |
| `vscode.StatusBarAlignment.Right` | `src/slackHome.js:71` |
| `vscode.ThemeColor` | `src/slackHome.js:81` |
| `vscode.commands.executeCommand` | `src/slackHome.js:59`, `src/slackHome.js:61`, `src/slackHome.js:62`, `src/slackHome.js:227`, `src/slackHome.js:301` |
| `vscode.window.createStatusBarItem` | `src/slackHome.js:71` |
| `vscode.window.setStatusBarMessage` | `src/slackHome.js:160` |
| `vscode.window.showErrorMessage` | `src/slackHome.js:214`, `src/slackHome.js:292` |
| `vscode.window.showInformationMessage` | `src/slackHome.js:101`, `src/slackHome.js:223`, `src/slackHome.js:297` |
| `vscode.window.showInputBox` | `src/slackHome.js:189`, `src/slackHome.js:198`, `src/slackHome.js:271`, `src/slackHome.js:280` |
| `vscode.ThemeIcon` | `src/slackPanel.js:48` |
| `vscode.Uri.joinPath` | `src/slackPanel.js:42`, `src/slackPanel.js:85` |
| `vscode.ViewColumn.Active` | `src/slackPanel.js:45` |
| `vscode.ViewColumn.Beside` | `src/slackPanel.js:45` |
| `vscode.window.createWebviewPanel` | `src/slackPanel.js:43` |
| `vscode.DataTransferItem` | `src/tree.js:153` |
| `vscode.EventEmitter` | `src/tree.js:93` |
| `vscode.MarkdownString` | `src/tree.js:272`, `src/tree.js:308`, `src/tree.js:322`, `src/tree.js:336` |
| `vscode.ThemeColor` | `src/tree.js:269`, `src/tree.js:334` |
| `vscode.ThemeIcon` | `src/tree.js:269`, `src/tree.js:289`, `src/tree.js:305`, `src/tree.js:319`, `src/tree.js:334` |
| `vscode.TreeItem` | `src/tree.js:267`, `src/tree.js:288`, `src/tree.js:302`, `src/tree.js:313`, `src/tree.js:332` |
| `vscode.TreeItemCollapsibleState.Collapsed` | `src/tree.js:301` |
| `vscode.TreeItemCollapsibleState.Expanded` | `src/tree.js:300`, `src/tree.js:313` |
| `vscode.TreeItemCollapsibleState.None` | `src/tree.js:267`, `src/tree.js:288`, `src/tree.js:332` |
| `vscode.Uri.file` | `src/tree.js:316` |
| `vscode.window.setStatusBarMessage` | `src/tree.js:171` |

## LIFECYCLE

| API / expression | All call-site lines |
| --- | --- |
| `vscode.commands.executeCommand` | `src/extension.js:212` |
| `vscode.commands.registerCommand` | `src/extension.js:240`, `src/extension.js:241`, `src/extension.js:242`, `src/extension.js:319`, `src/extension.js:1786`, `src/extension.js:1789`, `src/extension.js:1790`, `src/extension.js:1791`, `src/extension.js:1795`, `src/extension.js:1829`, `src/extension.js:1830`, `src/extension.js:1831`, `src/extension.js:1832`, `src/extension.js:1833`, `src/extension.js:1834`, `src/extension.js:1835`, `src/extension.js:1836` |
| `vscode.window.registerWebviewPanelSerializer` | `src/extension.js:734` |
| `vscode.commands.executeCommand` | `src/settingsMenu.js:194` |
| `vscode.commands.registerCommand` | `src/slackHome.js:154`, `src/slackHome.js:155`, `src/slackHome.js:156`, `src/slackHome.js:157` |

## ENV

| API / expression | All call-site lines |
| --- | --- |
| `vscode.Uri.parse` | `src/extension.js:1325`, `src/extension.js:1556` |
| `vscode.env.appRoot` | `src/extension.js:1986` |
| `vscode.env.appRoot.slice` | `src/extension.js:1987` |
| `vscode.env.clipboard` | `src/extension.js:1368`, `src/extension.js:1718` |
| `vscode.env.clipboard.writeText` | `src/extension.js:1368`, `src/extension.js:1719` |
| `vscode.env.openExternal` | `src/extension.js:1325`, `src/extension.js:1556` |
| `vscode.Uri.parse` | `src/host.js:51`, `src/host.js:58` |
| `vscode.env.openExternal` | `src/host.js:51`, `src/host.js:58`, `src/host.js:239`, `src/host.js:242`, `src/host.js:261` |
| `vscode.version` | `src/host.js:194` |
| `vscode.Uri.parse` | `src/slackHome.js:63` |
| `vscode.env.openExternal` | `src/slackHome.js:63` |

## Context and returned-handle dependencies

These have no literal `vscode.*` prefix; omitting them would understate extraction work. Persisted keys and exact readers/writers are expanded in `inventory-state.md`.

| Class | Uses / exact source | Consequence |
| --- | --- | --- |
| STATE | `context.globalState.get/update`: `src/manager.js:140`, `src/manager.js:143`, `src/manager.js:144`, `src/manager.js:147`, `src/manager.js:199`, `src/manager.js:205`, `src/manager.js:327`, `src/manager.js:355`, `src/manager.js:373`, `src/manager.js:375`, `src/manager.js:380`, `src/manager.js:445`, `src/manager.js:563`, `src/manager.js:572` | Account-like limits/pause, names and slash-command cache actually live in editor/profile storage. |
| STATE | `context.workspaceState.get/update`: `src/manager.js:557`, `src/manager.js:582`; `src/folders.js:32`, `src/folders.js:45`, `src/folders.js:56` | Sessions/folder assignment are workspace scoped, with Durable fallback. |
| STATE | Extension mementos: `src/extension.js:232`, `src/extension.js:239`, `src/extension.js:1260`, `src/extension.js:1304`, `src/extension.js:1862`, `src/extension.js:2047`, `src/extension.js:2049`, `src/extension.js:2051`, `src/extension.js:2081`, `src/extension.js:2084`, `src/extension.js:2120` | Selected provider, serving flag, CI durations, notification reopen records. |
| STATE | Stores passed through: `src/extension.js:939`, `src/extension.js:940`, `src/extension.js:945`, `src/extension.js:959`, `src/extension.js:960`; `src/identity.js:22`, `src/identity.js:33`; `src/devices.js:44`, `src/devices.js:54`, `src/devices.js:302`, `src/devices.js:308`, `src/devices.js:318`; `src/push.js:36`, `src/push.js:47`; `src/models.js:156`, `src/models.js:174` | Identity, devices/trail, VAPID and models require injected storage even though their modules do not import VS Code. |
| SECRET | `context.secrets`/alias `secrets`: `src/slackHome.js:120`, `src/slackHome.js:121`, `src/slackHome.js:122`, `src/slackHome.js:123`, `src/slackHome.js:125`, `src/slackHome.js:158`, `src/slackHome.js:163`, `src/slackHome.js:164`, `src/slackHome.js:217`, `src/slackHome.js:218`, `src/slackHome.js:219`, `src/slackHome.js:255`, `src/slackHome.js:256`, `src/slackHome.js:257`, `src/slackHome.js:258`, `src/slackHome.js:259` | Async get/store/delete plus change listener that rebuilds Slack. |
| CONFIG | Returned configuration `get/inspect`: `src/manager.js:86`, `src/manager.js:95`; `src/settingsMenu.js:160`, `src/settingsMenu.js:303`; `src/slackHome.js:23`, `src/slackHome.js:43`, `src/slackHome.js:85`; `src/extension.js:94`, `src/extension.js:149`, `src/extension.js:196`, `src/extension.js:826`, `src/extension.js:1134`, `src/extension.js:1162`, `src/extension.js:1196`, `src/extension.js:2024`; returned `.update`: `src/settingsMenu.js:209`, `src/extension.js:1597` | Literal prefix table identifies entry points; the complete setting catalog and aliases are in state inventory. |
| UI-EDITOR | Terminal handles `.show/.sendText`: `src/host.js:223`, `src/host.js:224`; workspace folder URI conversion: `src/extension.js:1038`, `src/durable.js:15`, `src/tree.js:64` | Terminal command is inserted without Enter. `placeOf()` accepts a VS Code Workspace object; daemon needs explicit workspace identity. |
| UI-CHROME | Session panel `.reveal/.dispose/.visible/.active/.title/.iconPath`, webview `.options/.html/.postMessage/.onDidReceiveMessage/.asWebviewUri/.cspSource`, panel events: `src/panel.js:27`, `src/panel.js:42`, `src/panel.js:50`, `src/panel.js:56`, `src/panel.js:81`, `src/panel.js:85`, `src/panel.js:88`, `src/panel.js:99`, `src/panel.js:102`, `src/panel.js:105`, `src/panel.js:116`, `src/panel.js:123`, `src/panel.js:135`, `src/panel.js:137`, `src/panel.js:168`, `src/panel.js:170` | Webview lifetime/transport/chrome belongs to the client, not engine. |
| UI-CHROME | Slack panel handles/events/webview: `src/slackPanel.js:27`, `src/slackPanel.js:48`, `src/slackPanel.js:49`, `src/slackPanel.js:57`, `src/slackPanel.js:58`, `src/slackPanel.js:60`, `src/slackPanel.js:64`, `src/slackPanel.js:72`, `src/slackPanel.js:79`, `src/slackPanel.js:85`, `src/slackPanel.js:91`; pairing panel: `src/pairPanel.js:17`, `src/pairPanel.js:36`, `src/pairPanel.js:50`, `src/pairPanel.js:81`, `src/pairPanel.js:87`, `src/pairPanel.js:88`, `src/pairPanel.js:96` | Shared SlackRoom/PairingWindow are separable from editor panels. |
| UI-CHROME | Tree view title/description/badge, visibility/selection/reveal: `src/extension.js:235`, `src/extension.js:236`, `src/extension.js:249`, `src/extension.js:252`, `src/extension.js:280`, `src/extension.js:2181`, `src/extension.js:2186`; DataTransfer `.set/.get/.value`: `src/tree.js:153`, `src/tree.js:157`, `src/tree.js:160`; event emitters `.fire`: `src/tree.js:108`, `src/historyTree.js:43`, `src/devicesTree.js:22` | Presentation state and drag/drop need client adapters. |
| UI-CHROME | Injected `win.show*` aliases: `src/extension.js:1928`, `src/extension.js:1954`, `src/extension.js:2138`; status/output returned handles: `src/extension.js:1203`, `src/extension.js:1088`, `src/extension.js:1847`, `src/extension.js:1848`; Slack bar: `src/slackHome.js:71`, `src/slackHome.js:76` | Existing injection is partial; still references the editor and this window. |
| LIFECYCLE | `activate(context)`, `deactivate()`: `src/extension.js:166`, `src/extension.js:2248`; command registration wrapper and calls: `src/extension.js:318` (commands through `src/extension.js:717`); subscription setup throughout activation, final manager/hub cleanup `src/extension.js:769`; panel restoration `src/extension.js:734` | Start/restore/stop state machines must be independent of window reload. |
| LIFECYCLE | `context.subscriptions.push` holds timers, views, config listeners and services: `src/extension.js:193`, `src/extension.js:208`, `src/extension.js:209`, `src/extension.js:219`, `src/extension.js:226`, `src/extension.js:246`, `src/extension.js:261`, `src/extension.js:287`, `src/extension.js:291`, `src/extension.js:755`, `src/extension.js:762`, `src/extension.js:911`, `src/extension.js:987`, `src/extension.js:1004`, `src/extension.js:1172`, `src/extension.js:1187`, `src/extension.js:1192`, `src/extension.js:1231`, `src/extension.js:1235`, `src/extension.js:1266`, `src/extension.js:1455`, `src/extension.js:1785`, `src/extension.js:1999`, `src/extension.js:2030`, `src/extension.js:2072`; Slack `src/slackHome.js:153`, `src/slackHome.js:164`, `src/slackHome.js:168`, `src/slackHome.js:176` | Current process/server/timer disposal behavior is enumerated in `inventory-processes.md`. |
| ENV | `context.extensionUri` / `context.extension.packageJSON.version`: `src/extension.js:206`, `src/extension.js:964`, `src/extension.js:1001`, `src/extension.js:1006`, `src/host.js:201`; native notifier's editor app path `src/extension.js:1986` | Package resource root and version must be supplied outside VS Code; no assumption that JS runs in Electron. |

The explicit-prefix table intentionally classifies `Uri`/`ViewColumn` by their call-site purpose. For example, `host.js` opens editor files; `panel.js` constructs webview resources. CONFIG change subscriptions are listed in CONFIG; registering the serializer is LIFECYCLE; its webview behavior is UI-CHROME.

## Command registrations through the local wrapper

`register` at `src/extension.js:318` registers these VS Code commands. They are LIFECYCLE entry points even though calls below do not repeat the `vscode.*` prefix.

| Command ID | Source |
| --- | --- |
| `nikui.newSession` | `src/extension.js:321` |
| `nikui.newSessionInFolder` | `src/extension.js:328` |
| `nikui.newSessionHere` | `src/extension.js:340` |
| `nikui.newCodex` | `src/extension.js:349` |
| `nikui.renameCodex` | `src/extension.js:361` |
| `nikui.open` | `src/extension.js:368` |
| `nikui.nextInstance` | `src/extension.js:382` |
| `nikui.previousInstance` | `src/extension.js:383` |
| `nikui.interrupt` | `src/extension.js:385` |
| `nikui.restart` | `src/extension.js:390` |
| `nikui.restartAll` | `src/extension.js:444` |
| `nikui.status` | `src/extension.js:468` |
| `nikui.resumeNow` | `src/extension.js:474` |
| `nikui.sleep` | `src/extension.js:485` |
| `nikui.stop` | `src/extension.js:504` |
| `nikui.rename` | `src/extension.js:531` |
| `nikui.clearStopped` | `src/extension.js:542` |
| `nikui.refresh` | `src/extension.js:568` |
| `nikui.newFolder` | `src/extension.js:570` |
| `nikui.renameFolder` | `src/extension.js:580` |
| `nikui.deleteFolder` | `src/extension.js:590` |
| `nikui.linkPr` | `src/extension.js:611` |
| `nikui.unlinkPr` | `src/extension.js:616` |
| `nikui.togglePrPane` | `src/extension.js:623` |
| `nikui.moveToFolder` | `src/extension.js:637` |
| `nikui.refreshHistory` | `src/extension.js:660` |
| `nikui.showHistory` | `src/extension.js:662` |
| `nikui.historyScope` | `src/extension.js:667` |
| `nikui.historyMore` | `src/extension.js:672` |
| `nikui.historyFilter` | `src/extension.js:674` |
| `nikui.deleteHistory` | `src/extension.js:685` |
| `nikui.resumeHistory` | `src/extension.js:717` |
