# Isolated development extension window

The P1 bridge is deliberately separate from ordinary window mode. It connects only to an explicit `nikd --root` private fixture. It does not import source state, start a keeper/manager, install a background job, discover a production daemon or fall back when the daemon is unavailable.

Start only the private daemon in the [smoke recipe](nikd.md). The CLI keeps real provider execution disabled; the [end-to-end fixture](../../test/fixtures/engine/end-to-end.js) supplies fake providers, a private fake Codex IPC router and synthetic credentials in process. All writable provider/project paths are beneath `<root>/home`. Announcing a file workspace outside that HOME refuses the development registration.

To open a separate extension development host manually, use a fresh editor profile/user-data directory under the same fixture area, this repository as `--extensionDevelopmentPath`, and `<root>/home` as its workspace. Set these environment variables only for that new process:

```text
NIKUI_ISOLATED_DEV_WINDOW=1
NIKUI_ISOLATED_DEV_ROOT=/absolute/private/fixture/d
```

Both variables and VS Code `ExtensionMode.Development` are required. No setting changes the default mode. Launching/controlling an existing user window is not part of this recipe. For automated proof, run `node test/run.js engine-development` and `node test/run.js engine-end-to-end`; those fixtures do not control a real editor.

The bridge reuses the owner-only `<root>/c.sock` (0700 directory, 0600 socket). A normal control request is still one bounded JSON line. `enroll(kind:editor)` creates or proves a persistent synthetic local-client ID/key; the extension awaits `context.secrets.store` before connecting, and refuses a changed engine/pin or invalid saved credential. Keys stay outside webview bootstrap, logs and diagnostics. LocalKey enrollment stays generation-local and grants no editor seat.

`connect` authenticates that enrollment and switches the private connection to bounded newline-delimited JSON application frames. Fleet and each conversation negotiate independently. Provider registration is connection state: supported methods, full workspace URIs and focus. The server derives principal/local/editor authority from the enrollment, ignores caller labels as authority, and binds per-operation origin before receipt/disk waits. Requests and replies have fresh operation IDs and bounded lifetimes. A disconnect or lost reply cannot move the action to another provider. URLs use `vscode.env.openExternal`, the system default external browser; terminal insertion never presses Enter.

The development sidebar opens shared conversation webviews and a small known-project fleet launcher. The shared transport opts in only when `NIKUI_DEV_BRIDGE` is present; ordinary `acquireVsCodeApi()` is unchanged. The development status bar and panels report daemon unavailability. Reopen a view/window to reconnect; no replacement engine is started. Closing every development viewer leaves the daemon running. Dispose closes only bridge connections/panels.

Supported provider methods are `openFile`, `openUrl`, `runInTerminal` and `switchTo`. Other local administration commands report `P2_LOCAL_MANAGEMENT_REQUIRED`; missing/disconnected provider methods return `EDITOR_UNAVAILABLE`; lost possible dispatch reports an unknown outcome. Full command, History/Devices/folder/settings/pairing/policy parity and production enrollment lifecycle are enumerated as blockers in [p1-exit.md](p1-exit.md).
