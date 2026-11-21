# P0 spikes — results

R08 cross-review: S1/S6 runtime observations are Claude's recorded probe results, accepted in R05/R07, not rerun here. R08 independently inspected the saved artifact/checksum, signature metadata, entitlements, linkage and probe source without registering/starting/stopping a service or touching Keychain. [Evidence and limitations](evidence-r08.md#signed-probe-review) and [later gates](p0-gate.md) distinguish these levels.

## S1. launchd minimal environment (done 2026-11-20, real LaunchAgent in gui/501, booted out after)

Probe: `/tmp/nik-mac/spikes/envprobe.sh` run as a RunAtLoad LaunchAgent.

- `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Only `git` and `security` resolve. `node`, `claude`, `codex`, `gh`, `tailscale`, `cloudflared` are all missing.
- Found in known dirs: `~/.local/bin/{claude,gh,tailscale,trust-dir}`, `/opt/homebrew/bin/{codex,node}`.
- A login shell (`zsh -lic`) gives the full PATH (bun, Android SDK, homebrew, VS Code bin, ~/.local/bin, …), but `claude` and `codex` are **zsh functions**:
  - `claude () { command trust-dir >/dev/null 2>&1; command claude "$@" }`
  - `codex () { local h="${CODEX_HOME:-$HOME/.codex-work}"; CODEX_HOME="$h" command trust-dir …; CODEX_HOME="$h" command codex "$@" }`
- `CODEX_HOME` is not set in the login environment; the function supplies the default.

Consequences for nikd:
1. Resolve tools explicitly: configured absolute path → known dirs → one cached `zsh -lic 'whence -p X'` (the binary, not the function) → diagnostics. Never rely on PATH.
2. Children get a PATH built from the login shell's PATH (cached at start, refreshable from the menu), because Claude's own tools (git, gh, node, bun, xcodebuild…) need it.
3. The function behaviour must be made explicit: CODEX_HOME comes from `codexAccount` (already the engine's model: `codexHome.accountHome`), and folder trust is the engine's job when it starts a run in a folder (NikUI already passes the folder; verify the CLIs don't prompt — P1 test with a fresh folder).
4. `SSH_AUTH_SOCK` is present under launchd. Its presence alone does not prove an authenticated Git/SSH operation; actual tool/trust access remains P2/T65.

## S2. Signing / service registration

Superseded by S6's measured signed-bundle evidence and D24. The approval/entitlement statements below are historical assumptions, not current acceptance claims; approval-required/denied paths remain P2 gates.

- Probe used **Apple Development** signing. `JGQ97Z9Y9C` is the certificate subject suffix, not the bundle TeamIdentifier; R08 reads **KBA6653B4V** from both saved signatures. Available signing identities beyond that probe were not enumerated in R08.
- The early assumption that registration always needs one approval was superseded by S6's immediate `enabled` observation from `/tmp`. Approval-required/denied states and final install location remain P2 tests. D24 makes Developer ID/notarization optional distribution work outside this Mac's P0–P2 gate.
- The inspected Homebrew Node depends on Homebrew dylibs and is not a self-contained runtime to copy alone. S6's official darwin-arm64 artifact links system frameworks/libraries; it is not literally fully static. Pin/check/re-sign the final artifact and test the required entitlements in P2.

## S3. Local trust without a native peer-UID API

Node's `net` exposes no `getpeereid`. The control socket's protection is therefore the filesystem: socket inside a 0700 directory owned by the user (same as keeper.js and ssh-agent). Only the same UID (or root) can connect. Peer-UID check becomes defense-in-depth done by the Mac app side (it can call `getpeereid` on its end to verify the *server* is ours) — not required for P1.

## S4. VS Code globalState is not a direct daemon export API

VS Code owns its memento databases (`state.vscdb`); filesystem readability does not make them a supported coherent export. nikd must not read live SQLite state. Import is **pushed by the extension** over the control socket during P2 cutover, with global/workspace provenance, settings, secrets and required files from the state inventory. All source engine writers quiesce before generation commit; client-local workspace picks stay client-owned.

## S5. Keychain from Node

Superseded by S6 and D24: P1 uses a private test-only 0600 file store; the signed bundled SecItem helper is required before P2 production import. The `security -i` path below is historical and is not the chosen implementation.

The historical login-keychain CLI probe used `security add-generic-password` / `find-generic-password` / `delete-generic-password`. Putting `-w <secret>` in argv exposes it; `security -i` stdin was considered but arbitrary quoting and service/locked-keychain access were not proved. Neither CLI path is selected for production. The actual sequence is P1 synthetic private file → P2 signed SecItem helper before import, not a P3 migration.

## S6. Signed app + bundled Node as an SMAppService LaunchAgent (done 2026-11-20, sources in spike-app/)

Bundle: `NikSpike.app/Contents/{MacOS/NikSpike (control CLI), MacOS/nikd (Swift launcher), Resources/engine/{node, main.js}, Library/LaunchAgents/com.nikui.spike.engine.plist}`.
- Official nodejs.org v26.7.0 darwin-arm64 tarball matches the saved SHASUMS256 entry: `7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4`. R08 confirms system-only CoreFoundation/Security/libc++/libSystem linkage. Re-signed with Apple Development + hardened runtime and **only** `cs.allow-jit` + `cs.allow-unsigned-executable-memory`. The probe's 50-million-iteration JS loop and empty WebAssembly module instantiation completed. This establishes that combination worked; it does not prove both entitlements are necessary or final-bundle relocation/resources.
- `SMAppService.agent(plistName:)` `register()` from an app in /tmp → `enabled` immediately (no approval prompt for an agent of a locally-signed app on this Mac; macOS posts a "background item" notice). `unregister()` → `notRegistered`, launchd job removed.
- Plist: `BundleProgram=Contents/MacOS/nikd`, `RunAtLoad`, `KeepAlive={SuccessfulExit=false}`, `ProcessType=Interactive`, `AssociatedBundleIdentifiers`.
- Launcher bug found: under launchd `argv[0]` is the bundle-relative `Contents/MacOS/nikd` → resolve via `Bundle.main.executablePath`, then `execv` node with absolute paths (exit 127 before the fix).
- Environment as in S1: `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `XPC_SERVICE_NAME=com.nikui.spike.engine`.
- `kill -9` → launchd restarts it (KeepAlive). `launchctl kill SIGTERM` → our handler drains and exits 0 → **not** restarted. That is the Stop-Engine semantic: exit 0 = stopped on purpose; nonzero/signal = crash → restart.
- Private socket in a 0700 Application Support dir, 0600, answered over `nc -U`.
- Keychain via SecItem from the signed **controller CLI** (secret on stdin, never argv): add 0, read back, delete 0, read → -25300 (not found). `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. The launched Node child did not call a SecItem helper in this probe. Same-service-identity access, update/error safety and arbitrary-byte cases remain P2/T66.

Probe-source limits: `main.js` uses a fixed NikSpike home directory and unconditionally unlinks its socket; it has no ownership/admission fence. `kc-set` deletes before adding and the controller prints failures without a failing exit status. These are historical feasibility code, not reusable production implementations. P1-10 must implement private paths/exclusive startup, and P2/T66 must implement nondestructive secret updates and observable failures. Do not run these probe commands as a daemon smoke recipe.

R08 inspected the arm64 probe on macOS 27.2.1. Its Info.plist says minimum 14.0 while the Swift controller was compiled for 27.2; this is a probe metadata mismatch, not evidence of older-OS compatibility. P2/T63 must align the final build target and plist and test supported deployment/relocation.

Remaining for packaging (P2): approval-required/denied path, real login after reboot, actual signed-helper Keychain access including locked/denied conditions, update-in-place, intended install location/relocation and TCC for real tools. Login Items wording and final-package acceptance remain unproved. Today's Node package has no runtime node_modules/native addons; voice/notifier native resources remain independent P2/T67 gates.
