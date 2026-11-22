# P2 round 4 — menu bar controller

**P3 R1:** the menu is now a scene of `NikUI.app` / `NikUI Dev.app`, alongside
a native main-window setup/activity shell. App identity is separate from the
engine label. See [the P3 design and implementation boundary](p3-design.md).
The P2 protocol/state/cleanup behavior below remains the dev acceptance
contract; original bundle/executable names are historical.

The signed **com.nikui.engine.development** bundle now launches a SwiftUI
`MenuBarExtra`. It remains an explicit, isolated TEST profile; production
cutover/import is disabled with **PRODUCTION_CUTOVER_DISABLED**. There is no
production identifier, source-profile discovery, keeper adoption, provider
launch, or P3 transcript/composer in this change.

The bundle's `NikEngine` executable retains the round-3 CLI commands when
invoked with an action. With no action it launches the menu. SwiftPM builds
`app/mac/NikMenuBar` and links the existing `NikCore` models for fleet rows,
providers and conversation status. Both packages compile with a macOS 14.0
floor; the final executable and Info.plist use that same floor. LSUIElement
keeps the menu app out of the Dock. System fonts, semantic styles, native
menus/forms, accessibility labels and keyboard shortcuts follow light/dark
appearance and system accessibility settings.

## Lifecycle and login

The glyph distinguishes running, starting, stopped and attention. A broken
connection after an observed running generation shows unavailable/attention;
it does not assert that the engine was intentionally stopped. Unknown
operations and authority failures remain visible. Menu details include
version/generation, selected Codex account directory, loopback listener,
editor availability, ownership and import/update blockers.

Start registers the exact bundled agent if necessary and uses the existing
controller's `launchctl kickstart` without `-k`. Stop uses its checked
socket-PID/launchd-PID match, SIGTERM, bounded drain and exit-0 semantics.
There is no broad kill or alternate bootstrap. Quit closes only the menu's
subscriptions; it never sends Stop, unregisters the engine or changes its
settings.

**Open at Login** controls `SMAppService.mainApp`, independently of the
engine's `SMAppService.agent`. Its checkmark comes from the actual status,
including a pending approval; the menu also shows the agent's actual status.
An approval-required item provides Apple's Login Items settings deep link.
The signed bundle explicitly selects a TEST HOME before creating GUI client
state, including when SMAppService launches it without a shell environment.
It never selects the real account's provider homes. Register/unregister,
approval and actual login behavior require Claude's native verification.

## Local protocol

The existing private 0700 root / 0600 Unix socket remains the only management
transport. The Swift client validates every path component, entry ownership
and modes, socket inode before/after connection and `getpeereid`. Blocking
I/O stays off the UI actor; reads/writes and frame sizes are bounded,
fragmented frames and partial writes are supported, and cancellation shuts
down the subscription socket.

`{op:"enroll",kind:"local",protocol:2}` creates/resumes a non-editor local
seat. The enrollment and host/engine pins are saved and verified in a 0600
`menu-client.json` before connecting. Publishing the credential is atomic;
corruption, permission failure, revocation or changed pins refuses without a
memory fallback or fresh enrollment over the old selection. The server's
record stays in its existing selected secret backend. Credentials are never
shown in the UI, diagnostics or native evidence file.

`{op:"local",id,key,request}` carries the existing version-1 local request
and operation-specific result schemas. Authorization and generation checks
remain in the local dispatcher; phone/HTTP seats do not gain these commands:

| Command | Behavior |
| --- | --- |
| `menu.snapshot` | Typed status, shared fleet, local browser capability, staged settings and named blockers. |
| `tools.refresh` | Explicitly refreshes the cached resolver and returns a snapshot. It neither starts tools nor applies staged paths. |
| `engine.settings.get` | Returns desired settings/revision and whether a restart is required. |
| `engine.settings.update` | Atomically validates/commits all settings under a revision precondition and durable local request receipt. |

`{op:"menu-observe",id,key,generation}` creates a receive-only subscription
with versioned `menu:snapshot` frames. Relevant fleet changes are coalesced
for 250 ms; duplicate snapshots are suppressed. A 25-second heartbeat covers
availability/editor/ownership changes and bounds stale state. The client
reconnects after 1, 2, 4, 8, 16, then at most 30 seconds, resetting on a valid
snapshot. Reconnection resumes the same enrollment and pins, checks the new
generation, and never automatically starts the engine. A missing settings
save reply is **LOCAL_OUTCOME_UNKNOWN**; the UI requires an explicit reload
before another save and never automatically replays that action.

## Settings, fleet and diagnostics

Settings expose Claude/Codex/gh executable overrides, the pinned Node path,
Codex account home and listener port/bind. Blank overrides select automatic
resolution. Nonblank paths must be absolute executable files. The bundled
Node cannot be replaced (**BUNDLED_NODE_PINNED**). Codex home must be a
non-symlink directory within this profile's private engine HOME
(**CODEX_HOME_OUTSIDE_TEST_PROFILE**). No credentials are read or displayed.
The bind boundary remains 127.0.0.1 (**BIND_LOOPBACK_REQUIRED**); port 0 selects
an available port, with integer validation through 65535. Network exposure
still requires its separate generation-owned route contract.

Changes are staged in the authority, with **STALE_SETTINGS** refusing lost
updates. Existing runs/listener/account do not change until an explicit
Stop/Start. A configured tool removed after saving reports missing on the
next boot, allowing the menu to repair it rather than preventing engine
startup. Refresh resolves the active configuration only. Cutover/import and
unsafe update paths remain blocked.

The shared fleet is the union of Claude instances and the **single selected
Codex account**, never multiple provider homes. Fleet projects union locally
saved/approved projects, connected editor announcements and existing
instance projects, deduplicated by exact path. Visibility of an instance
project does not grant new-project creation authority: that still requires
local approval/announcement. Empty saved folders remain in the fleet.

The menu lists Claude processes that actually exist and Codex conversations
that are awake; a working/waiting Codex conversation is retained even if its
catalog flag lags. Catalog-only sleeping rows are omitted. Both working and
waiting count as busy for update/power aggregation; Codex is not counted as a
Claude process and an awake idle conversation alone is not busy. Browser
actions retain the engine's local capability and exact instance ID. The
shell route accepts service generation-prefixed IDs. `NSWorkspace` opens
links in the system's default external browser.

Tool Diagnostics shows the resolved claude/codex/node/gh paths and Refresh
Tools. Logs open the selected TEST HOME's output/error files. Copy
Diagnostics uses an explicit allowlist: no browser/enrollment key, prompt,
instance title, project path, provider account identifier, raw error or
environment. User home/profile/bundle paths are redacted. About and Quit use
native application behavior.

## Verification and pending gate

Non-native suites cover schema/auth/generation/revision refusals, atomic
staging/restart, pinned Node, account/symlink and listener validation,
resolver refresh, socket pushes, the real service-instance browser shell
and disconnect-with-engine-alive. Swift fake socket tests cover framing,
peer/filesystem checks, persistence/pins, cancellation, changed generation,
reply correlation, unknown writes, reconnect backoff, status/view models,
login approval, settings validation and diagnostics redaction. NikCore's
existing suite also runs with its macOS 14 target.

Claude runs the native gate outside the managed sandbox:

```sh
scripts/test-mac-engine.sh --regressions --menubar
```

`--menubar` uses `open -n --env HOME=<fresh-test-home>` (plus explicit
USERPROFILE/ZDOTDIR/CODEX_HOME), requires an enrolled menu observer over the
control socket and a live exact-bundle GUI PID, then requests normal app
termination through NSRunningApplication. It proves the same engine
PID/generation is still running with no menu observer. Its `finally` quits
only that exact test app, stops/unregisters only the test agent, deletes only
its test Keychain item and removes the generated bundle. The private
`menu-state.json` contains only native gate evidence, never credentials.
Real SecItem/SMAppService, GUI appearance, accessibility/shortcuts, login,
light/dark and supported-OS acceptance are **native: pending Claude run**.
