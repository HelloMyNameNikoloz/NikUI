# Signed development engine — P2 rounds 3–4

**P3 R1 packaging update:** [p3-design.md](p3-design.md) now specifies the
compiled dev/production split. `build-mac-engine.sh` remains a dev-only
compatibility entry; its product is `build/p3/NikUI Dev.app`, app ID
`com.nikui.app.dev`, engine label still `com.nikui.engine.development`, executable
`Contents/MacOS/NikUI`. `build-mac-app.sh --flavour prod|dev` builds the new
products. The historical P2 commands/paths below describe their original
evidence. Real production cutover/source composition remains a separate P3
implementation/native gate; the new package never selects P2 fakes as prod.

The package contains the actual isolated engine, media and configuration
manifest, not the S6 JavaScript probe. It remains test-only, with bundle ID and
LaunchAgent label **`com.nikui.engine.development`**. Window mode remains the default;
there is no production activation or import command. All profiles, caches,
logs and build products live under `/tmp/nik-mac/build`. Nothing installs a
plist in the user's LaunchAgents directory or adopts an existing job.

```sh
scripts/build-mac-engine.sh
scripts/test-mac-engine.sh --regressions --menubar # native gate: Claude only
```

The build defaults to `/tmp/nik-mac/build/NikEngine Dev.app` and a separate
0700 `test-home/profile`. `--output`, `--test-home` and `--identity` select
explicit alternatives under that build directory. Existing bundles refuse
overwrite. The acceptance script creates a fresh run directory, refuses an
existing development job, relocates its app before registration, and removes
its app/job/test Keychain items in `finally`. Its final JSON points to
`acceptance-*/result.json`; detailed regression logs stay beside that report.
Claude runs the native acceptance command outside the managed sandbox. Codex
builds and runs non-native tests only; native gates are not attempted by Codex.

The shell drivers use the absolute bootstrap Node
`${NIKUI_BUILD_NODE:-/opt/homebrew/bin/node}`. This is only a build/test driver.
The service uses the bundled runtime exclusively. No shell startup file from
the user's live HOME is read, and no real Claude/Codex/provider is launched.

| Component | Reproducible input and signing |
| --- | --- |
| Node | Official `nodejs.org/dist/v26.7.0/node-v26.7.0-darwin-arm64.tar.gz`; SHA-256 `7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4`, checked against both the saved official `SHASUMS256.txt` entry and the pinned digest on every build. Reuse S6's cached tarball when present; extract a fresh runtime from the verified archive. Retain its license. |
| Native code | Controller, launcher, SecItem helpers, notifier and voice compile for `arm64-apple-macos14.0`; all app plists declare 14.0. Voice uses an explicit macOS 14 triple, deployment target and Swift target. Upstream Node declares minimum 13.5, compatible with the app's 14.0 floor; it is not rebuilt or relabeled. |
| Signatures | Apple Development + hardened runtime on every executable and app. Node receives exactly `allow-jit` and `allow-unsigned-executable-memory`. Other helpers receive no restricted Keychain or runtime-exception entitlement. Sign inside out; verify the whole relocated app with `codesign --verify --deep --strict`. |
| Resources | Complete `src/`, `media/`, `package.json` and a sealed build manifest with resource hashes. There are no runtime npm dependencies/native Node addons. The main executable is bound by the outer code signature rather than hashed into its own resource manifest. |
| Keychain | D28 file-based login Keychain; a random signed test service. Package two separately compiled helper versions with the same identifier/identity, different signed bytes and the same designated requirement. Default ACL; no profile/access-group entitlement. |
| Voice/notifier | Actual signed notifier app and FluidAudio **0.17.5**, revision `0b1f46289fe27d95b5e66ad8be46e64f5ee02ae7`, voice executable plus its resource bundle/license. SwiftPM verifies the pinned binary dependency checksum. No model or live VoiceInk data is copied. The isolated engine keeps these machine features disabled. Voice's explicit test-profile check reports `NO_MODEL`; no transcription/TCC/notification permission success is claimed. |

The Swift launcher resolves `Bundle.main.executablePath`, constructs absolute
paths inside that bundle and `execv`s its Node and `src/macEngine.js`. It
clears inherited environment variables, supplies explicit TEST HOME/profile,
minimal PATH, temporary directory and CODEX_HOME, and preserves only the
launchd-provided SSH socket when present. The engine resolves configured
absolute tools, then known directories, then one cached `zsh -lic whence -p`
lookup against its private home. Configured executable directories precede
the cached login PATH for children; the bundled Node is the configured node.
Shell functions are bypassed. Provider/trust, route and power changes remain
disabled; resolution does not authorize a provider launch.

`SMAppService.agent(plistName:)` performs registration/unregistration. The
signed plist sets `RunAtLoad` and `KeepAlive={SuccessfulExit:false}`. The CLI is:

```sh
app='/tmp/nik-mac/build/NikEngine Dev.app/Contents/MacOS/NikEngine'
"$app" register
"$app" status
"$app" intentional-stop
"$app" start
"$app" crash-relaunch
"$app" unregister
```

Status includes SMAppService authorization and the actual private control
socket response. The Swift client verifies socket/directory owner and modes
and server peer UID. Start uses `launchctl kickstart` for the exact development
job without `-k`; signal operations first require the control PID to match that
job. Intentional stop sends SIGTERM, invoking the real daemon drain/exit 0.
Crash-relaunch sends SIGKILL (signal 9) and waits for a different generation.
Approval-required/not-registered states refuse; no alternate bootstrap,
approval bypass, broad process kill or production label is available.
See Apple's [SMAppService API](https://developer.apple.com/documentation/servicemanagement/smappservice).

Only a fresh signed test package may initialize synthetic host/VAPID keys.
A 0600 marker reserves that initialization before SecItem add and records the
selected public pins after it. Later starts require the same pins and existing
Keychain store; an interrupted initialization or missing/locked/denied/corrupt
item refuses without regeneration or file fallback. This is not production
import. A local test-only control action runs the full SecItem probe under a
second fresh service, with all attempted accounts deleted in `finally`.
The regression script additionally runs the standalone helper test, which
rebuilds after creating its item, then runs full `npm test` against the signed
service and NikCore with its opt-in loopback fixture enabled.

The native script requires: register/enabled; actual engine/control status and
relocated HTTP media; real SecItem CRUD, nondestructive duplicate add and helper
upgrade/read; SIGKILL/new PID/boot with the same engine identity; SIGTERM/exit 0
remaining stopped beyond launchd's normal throttle interval; explicit Start;
unregister/notRegistered and absent job; test item and bundle removal. It
retains named failures and cleanup evidence, never a fabricated success.

Current managed-session evidence: the relocated package passed signature,
target, entitlement, system-library, JIT/WebAssembly and signed voice checks.
A separate packaged-source preflight passed real engine startup, control
status, HTTP media, resource hashes and SIGTERM drain using P1's synthetic
file adapter; that preflight does not establish native Keychain/launchd access.
Actual SecItem add returned `100001` (UNIX EPERM); actual SMAppService register
returned `SMAppServiceErrorDomain / 57`. The failed native attempt confirmed
its job absent and removed its app, with no test Keychain items remaining.
The required native PASS and full npm count remain pending execution outside
that sandbox. NikCore passed **150 tests / 14 suites**, loopback enabled, using
the documented private-cache `swift test --disable-sandbox` workaround after
plain SwiftPM hit `sandbox_apply` EPERM. Import passed **111/111**, daemon
**52/52**, and tool-resolution **20/20**. The other JavaScript suites passed
**6,668/6,668**; the secrets suite passed **68/68** checks before its unavailable
native-service gate. Final helper framing passed another **13** direct checks,
and all **186** resource-manifest hashes matched. These subsets do not replace
the failed full npm/native gate. Evidence: `/tmp/nik-mac/p2/r05-*`
and `/tmp/nik-mac/build/acceptance-*/result.json`.

Approval-denied/locked real items, actual tool trust/TCC, attended notification
clicks, power/lid ownership, routes, login/reboot and supported-OS acceptance
remain separate P2 gates. No live editor profile, keeper/provider/Codex daemon,
globalStorage, credential, tailnet route or unrelated LaunchAgent was changed.


Round-3 native evidence was independently accepted in `/tmp/nik-mac/p2/r06-claude.md`:
`acceptance-6UGEwh/result.json` passed all 12 checks, including real Keychain
helper rebuild/read, crash relaunch, intentional stop remaining stopped,
explicit Start and unregister cleanup. It supersedes the earlier sandbox
failures described above. The real signing login-keychain selection remains
explicit and now has a dependency-injected unit test.

Round 4 adds the [SwiftUI menu bar controller](menu-bar.md). Build/signing
still use this same bundle and dev label. Its additional native launch/quit
proof is opt-in through `--menubar`; **native: pending Claude run**. Plain
`npm test` now runs all non-native checks and reports the native Keychain gate
separately without counting an unrun gate as a pass. Claude's native script
opts into native tests with `NIKUI_NATIVE_TESTS=1` and an explicit TEST HOME.

Round 5 adds [`scripts/acceptance-p2.sh`](../../scripts/acceptance-p2.sh).
Its default is a portable rehearsal; Claude runs
`--native [--editor] [--real-tools]` for the final signed test package. The
[acceptance inventory](p2-acceptance.md) maps every A01–A12/T63–T72 item to
evidence and the [attended checklist](p2-manual-checklist.md) keeps unrun
machine gates explicit. The signed rehearsal configuration enables synthetic
provider failures; real tiny CLI prompts require a separate sealed opt-in and
fresh read-only-login sandbox. Production activation remains disabled.
