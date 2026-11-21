# P2 round 5: acceptance rehearsal

R09 implementation, R10b follow-up, 2026-11-21. Claude's signed rehearsals
reached the resend check and exposed a harness readiness race; the fix below
is verified portably. **Native verification of R10b: pending Claude run**.
Codex performed no native/GUI/SecItem/SMAppService/editor/real-tool execution.
This is an evidence inventory, not P2/default-on or production-cutover sign-off.

## Run and isolation

```sh
scripts/acceptance-p2.sh                              # portable only
scripts/acceptance-p2.sh --native                      # Claude, outside sandbox
scripts/acceptance-p2.sh --native --editor --real-tools # optional native clients/tools
```

No flags means fresh private roots, actual loopback HTTP/WebSockets and Unix
control, shared web JS/P-256/AES clients with disk-backed pending intents,
synthetic providers, and a menu protocol observer. The daemon runs in a
separate Node process with the package's acceptance composition, pinned Node
selection and selected-store interface; its adapter is a private, persisted
fake. It does not build/sign,
use Keychain/SMAppService, open a GUI, or launch real tools. `--editor` and
`--real-tools` without `--native` refuse before effects. No argument can select
an existing HOME/root, source profile, engine, keeper or conversation.

The native branch reuses `test-mac-engine.js`'s final development bundle
build/sign/relocate/register/lifecycle/cleanup path. A sealed `acceptanceP2`
configuration selects synthetic provider adapters in the actual packaged
engine; there is no environment/HTTP opt-in or arbitrary plugin loader.
The same scenario clients exercise the packaged transport assets while the
actual enrolled menu remains open. The label stays `com.nikui.engine.dev`,
the selected HOME stays under `/private/tmp/nik-mac/build`, Keychain services
are dedicated random test namespaces, and inherited provider homes are
discarded. The script refuses an existing dev job both before and after the
build. It never takes over an existing dev installation.

`--editor` starts two Microsoft-signed, actual VS Code development hosts
together using `code --user-data-dir <test> --extensions-dir <test>
--new-window`, separate TEST HOMEs, this checkout's development extension,
and extension-test entries. No user profile/symlinked extension is used.
VS Code's in-memory test SecretStorage prevents touching its shared OS
credential store; editor enrollment persistence is not claimed. Each test
window closes itself through its own extension test entry; no quit-all,
process-name matching, AppleScript or live-window control exists. CLI flag
definitions are checked against [VS Code's argument schema](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/argv.ts).
`NIKUI_P2_CODE` may select a relocated real Microsoft-signed VS Code CLI;
`NIKUI_P2_TAILSCALE` may select an absolute CLI for the read-only route probe.

`--real-tools` is a separate sealed build flag. Its runner executes **one
new, tiny prompt per available provider** under the signed launchd child's
identity in a fresh test project. It uses only an existing OAuth token or
one read-only credential-file snapshot, never copies a provider home,
reads non-test provider Keychain items, logs in/out, edits live config, or
resumes/attaches a conversation. HOME/config/account paths are private;
the live refresh token is stripped so the test cannot rotate the user's login.
Claude tools/MCP and session persistence are disabled; Codex is ephemeral
with file credentials/read-only tool sandbox. An outer Seatbelt policy
protects the snapshots/live provider homes, denies Unix/loopback daemon
connections, and confines writes to the test scratch directory. A write
probe must pass before any prompt. Typed final output, not a prompt echo,
must contain the exact response. Missing login/unsupported flags are unrun;
timeout/auth/trust/permission errors are named and fail. No raw provider
output or credential is retained; snapshots are deleted and live-file hashes
are rechecked. [Upstream Seatbelt policy forms](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs)
inform the wrapper; its actual native enforcement still requires Claude's run.

Native completion includes real signed helper CRUD/rebuild, corrupting only
the selected synthetic store and restoring its exact bytes, actual menu
launch/quit, crash relaunch, intentional Stop beyond the throttle interval,
Start, unregister and exact test-item cleanup. Existing Tailscale Serve
configuration is read twice and compared by canonical digest, never changed.
Missing Tailscale/configuration remains unconfigured. Transfer-account cleanup
also checks the two private generation journals, including interrupted staging;
uncertain cleanup retains the helper bundle and reports failure.
The manifest and executable signature/hash inventory remain in the evidence
directory after the generated app is removed; real-tool results record CLI
versions without retaining raw version/help/provider output.

## R10b: resend readiness and failure diagnostics

`sealed()` reports completion of the client's cryptographic key agreement.
It can become true before the server authenticates the device and before the
application `welcome` selects protocol 2. The former resend check waited only
for `sealed()`, then ignored a `false` result from `postMessage()`. The client
correctly refuses a send while its application protocol is unready, so no
pending record or send frame can reach the seal hook. The old portable
composition shared the client's event loop and hid this scheduling difference.
Both compositions already use the same v2 advertisement and negotiation code.

The pre-fix reproduction in `/tmp/nik-mac/p2/r10b-repro-race.log` uses the
separate daemon and a delayed v2 welcome: `sealed=true`, `proto=null`,
`ready=false`, `allowed=false`, `postMessage=false`, and no new outbox record.
It reproduces the exact timeout in Claude's native evidence at
`/private/tmp/nik-mac/build/acceptance-8Tgqqm/result.json`; that native outbox
also contains only the earlier send. This is a harness defect; product
transport and protocol behavior are unchanged.

The shared scenario now holds the negotiated welcome on both portable and
signed runs. It proves that a premature send is refused without persistence
and that its readiness wait remains pending until the welcome is released.
The real action requires application readiness, protocol 2 and an allowed
send, then an allocated mid and a pending record containing the exact plaintext
held by the seal hook. Reconnecting must retain that mid/plaintext, write
nothing to the old socket, and produce exactly one provider effect.

Failures retain stage, protocol, readiness, `seat.control`, allowed status,
send result, outbox record states, advertisement, box-factory counts and
opened/sealed message types. The named cause and key fields are included in
the failure message and propagated through scenario, signed-driver and wrapper
reports. Diagnostics omit prompt text, cryptographic keys and frame contents.
A forced send refusal exercises this failure path with the actual portable
clients and verifies cleanup. Fake-store handback evidence stays labeled
portable. Claude's Development/Test activation fix was reviewed and retained;
the fixture now activates in Test mode and checks incomplete opt-ins in both
permitted modes.

R10b validation: full `npm test` **6,863/6,863**, NikCore **150 tests / 14
suites** with loopback enabled, and menu Swift **21 tests / 2 suites**.
Logs: `/tmp/nik-mac/p2/r10b-{npm,nikcore-swift,menu-swift}.log`.
Both plain Swift commands hit the documented `sandbox_apply` EPERM; the
private HOME/cache `--disable-sandbox` workaround passed. Portable evidence:
`/tmp/nik-mac/p2/r10b-acceptance.json`, **12/12** scenarios and the six
regression suites. A temporary in-memory mutation restoring the crypto-only
wait is rejected with `APPLICATION_NOT_READY`; see
`/tmp/nik-mac/p2/r10b-readiness-mutation.log`. Native R10b remains pending.

## Evidence keys

- **E**: `/tmp/nik-mac/p2/r09-acceptance.json`, the retained portable report;
  its `run` points to the original private scenario/authority/client files.
  `p2-scenarios.json` names every scenario, public effect proof and exact path.
- **R**: the `engine-{cutover,owner,import,handoff,policy-owner,doctor}.log`
  files beside E's original report; these use synthetic adapters and retain
  their named checks. They do not establish native runtime behavior.
- **N**: `/private/tmp/nik-mac/build/acceptance-<id>/result.json`, produced by
  the future native command. Its parent wrapper report records `nativeEvidence`.
  The wrapper also retains the pre-build/post-cleanup route digests.
  Scenario, editor, handoff, corrupt-store and real-tool evidence live under
  that native run/test HOME. Claude's R10 runs contain the earlier failure;
  **a native R10b result remains pending**.
- **M**: [attended checklist](p2-manual-checklist.md). Each section names an
  ID and the exact steps/expected results; save observations to the selected
  manual run's `evidence/<ID>.md` or `.json`. Pending paths are planned outputs,
  not evidence of a pass.
- **L**: `/tmp/nik-mac/p2/acceptance-latest.json`, a convenience pointer to
  the most recent wrapper report. Tests may update L; use E for this round's
  stable snapshot.

## Every A/T item

“Automated” below means only the stated subset. Every native entry in this
table is **native: pending Claude run**; every attended entry remains manual
pending or explicitly blocked/unconfigured. No row is a complete independent
release acceptance pass.

| ID | Automated evidence / scope | Native-pending or manual evidence still required |
| --- | --- | --- |
| A01 | R `engine-owner` / `engine-cutover`: admission, one writer, races/fences | N `--editor`: two actual starting VS Code hosts + same-run proof; M [A01](p2-manual-checklist.md#a01): origin/drafts/selection |
| A02 | E `same-run-menu-and-two-phones`, `closing-scenario-clients-leaves-engine-alive`: menu observer + web v2 + sealed v1 | N: actual enrolled menu + optional real editors + both protocol clients; M [A02](p2-manual-checklist.md#a02): independent native phone builds/test transport |
| A03 | E `lost-ack-reconnect-one-effect`, `disconnect-before-write-identical-mid-resend`: durable same mid, one effect, fresh channel | N repeats against signed engine/assets; M [A03](p2-manual-checklist.md#a03): independent phone connection-loss trace |
| A04 | E `pending-approval-restart-stale-control-refused`; R `engine-handoff`: run binding/refusal | N: Stop/Start of actual signed service with stale/current approval proof; M [A04](p2-manual-checklist.md#a04): actual supported keeper continuity or explicit unavailable |
| A05 | E `live-legacy-owner-named-refusal`; R `engine-owner` / `engine-handoff`: named build/meta blocker, no takeover | N exercises signed synthetic owner; M [A05](p2-manual-checklist.md#a05): old disposable build/keeper, never live user's owner |
| A06 | E `old-phone-v1-current-grants`: sealed socket sends without hello, current grants, no fabricated v2 replay | N repeats v1 protocol trace; M [A06](p2-manual-checklist.md#a06): recorded old phone binary + current binary |
| A07 | E `pins-rekey-sse-and-forget` and `fresh-current-handback-with-post-cutover-work`; R `engine-import`: selected pins/grants/records | N: actual selected test SecItem generation round trip; M [A07](p2-manual-checklist.md#a07): configured delivery after actual supported import; APNs/Web Push unconfigured/unrun |
| A08 | E `network-administration-unavailable-without-adoption`: named refusal, zero route mutations | N `routes.before/after` canonical existing-route digest; M [A08](p2-manual-checklist.md#a08): unrelated route presence/owned exposure prerequisite; unavailable adapter stays blocked |
| A09 | R `engine-owner` / `engine-import`: corrupt authority/owner, stuck lock, injected locked/denied/corrupt stores | N `p2-corrupt-selected-store.json`, helper access/fail-closed; M [A09](p2-manual-checklist.md#a09): actual locked/ACL-denied disposable-account Keychain |
| A10 | R `engine-doctor`: private HOME, explicit binary precedence/cached resolver; E default real-tool refusal | N package/minimal PATH/tool status + opt-in tool results; M [A10](p2-manual-checklist.md#a10): attended trust/TCC/resource cases |
| A11 | R `engine-policy-owner`: fake generation ownership/release; no actual session-cycle claim | M [A11](p2-manual-checklist.md#a11): sleep/wake, logout/login, reboot and declared Stop/session policy; N basic lifecycle is only a prerequisite |
| A12 | E `active-claude-and-codex-update-refusal`, fresh current handback; R `engine-handoff` / `engine-import`: owned/borrowed/unknown fences | N signed source/refusal + native SecItem data handback; M [A12](p2-manual-checklist.md#a12): real active-provider / old-new signed replacement gate remains blocked |
| T63 | Portable tests do not establish signing/relocation | N relocated signatures, binary/plist targets, official Node checksum/arch, JIT/Wasm and resources; M [T63](p2-manual-checklist.md#t63): actual minimum supported OS |
| T64 | R/Swift cover fake statuses and lifecycle contracts | N actual enabled/crash/new boot/Stop >13s/Start/unregister; M [T64](p2-manual-checklist.md#t64): approval-required/denied/disabled and mainApp/agent independence |
| T65 | R `engine-doctor`; E real-tool opt-in refusal | N minimal launchd identity/environment and optional fresh tiny real prompts; M [T65](p2-manual-checklist.md#t65), [A10](p2-manual-checklist.md#a10): TCC/trust/unsupported paths |
| T66 | R `engine-import`: memory refusal/crash vectors; npm helper framing tests | N real signed helper CRUD/arbitrary bytes/duplicate/update/rebuild/cleanup + selected corruption; M [T66](p2-manual-checklist.md#t66): actual locked/denied cases |
| T67 | Optional voice/notifier unavailable contracts; no real permission claim | N signed retained resources/voice `NO_MODEL`; M [T67](p2-manual-checklist.md#t67): notification permission/click and optional test voice model; service adapters unavailable |
| T68 | E shared engine/menu protocol/two phone protocol clients/v1/lost ack; R editor-origin fixtures | N actual menu + optional real VS Code pair; M [T68](p2-manual-checklist.md#t68): physical old/new builds, independent origins/drafts/selection and Cmd-Q/Stop UI |
| T69 | E pin/rekey/revoke/SSE and current data handback; R selected delivery records | N real test SecItem import preserves exact pins/records; M [T69](p2-manual-checklist.md#t69): actual supported import + configured APNs/Web Push; unavailable transports unrun |
| T70 | E pending approval, legacy blocker, busy refusal, current handback/post-cutover work; R full import/cutover crash matrix | N actual lifecycle/signed source/native SecItem/corrupt store/route observation; M [T70](p2-manual-checklist.md#t70): independent real replacement/refusal/handback, never process-kill workaround |
| T71 | No automated sleep/logout/reboot action | M [T71](p2-manual-checklist.md#t71), [A11](p2-manual-checklist.md#a11): actual timed session cycles with before/after durable scope, pins, unknowns and route evidence |
| T72 | R `engine-policy-owner`: default-off, fake holders/banner/current-target/release/foreign-state preservation | M [T72](p2-manual-checklist.md#t72): actual power/lid/watchdog/banner ownership; current signed `policy.fake:true` is an explicit implementation blocker |

## Fixes and validation

The rehearsal exposed a missing Claude busy check in
`plannedTransitionReadiness`: an active direct Claude turn or pending approval
could previously be declared ready while Codex was idle. It now refuses with
`CLAUDE_OWNED_BUSY`, also when accepted Claude work remains but its live session
is missing. The simultaneous-provider scenario and targeted tests cover it.
Guarded transfer eligibility and borrowed Codex lifetimes remain unchanged.

The harness validates native opt-in before effects, records unrun paths,
checks typed final real-tool responses, closes only its own test clients, and
preserves cleanup failures. Native-only additions were source-reviewed and
unit-tested where possible; they were **not executed** by Codex.

Historical R09 validation logs:

- Full non-native `npm test`: **6,844/6,844**,
  `/tmp/nik-mac/p2/r09-npm.log`; native Keychain
  explicitly pending, never counted as passed.
- NikCore: **150 tests / 14 suites**, loopback enabled,
  `/tmp/nik-mac/p2/r09-nikcore-swift.log`.
- Menu Swift: **21 tests / 2 suites**,
  `/tmp/nik-mac/p2/r09-menu-swift.log`.
- Plain SwiftPM first failed with `sandbox_apply: Operation not permitted`;
  `/tmp/nik-mac/p2/r09-{nikcore,menu}-plain.log` records that separately. The
  successful commands used `--disable-sandbox`, a private TEST HOME and
  private cache/scratch/config/security directories under
  `/tmp/nik-mac/p2/r09-swift`, following the P1 workaround.

The portable wrapper passed **12/12 scenarios**, plus cutover 112/112,
owner 47/47, import 111/111, handoff 30/30, fake policy 27/27 and resolver
20/20 checks. The acceptance-specific suite contributes 38 checks to npm,
including fake-child cancellation and no-refresh-token/no-secret-diagnostic
guards. No native result is included in these counts.

## Remaining release/build gates

Physical old/new phone builds, configured APNs/Web Push, actual locked/denied
helper access, TCC, Login Items denial, session cycles, supported-OS coverage,
actual native power/lid/watchdog and current-target notifications remain open.
The signed runtime deliberately disables network exposure and native machine
adapters, and the production import/update entrypoint still reports
`PRODUCTION_CUTOVER_DISABLED`. The selected data round trip captures current
signed-engine state but activates data receivers only; it is not a second
running replacement engine and makes no provider survival claim.

Per R08, **P3 build item**: preserve the controller's current
`/private/tmp/nik-mac/build/` gate. A production release needs a separately
specified dev/production build flavour, bundle ID/label, approved profile and
permission identity; do not loosen this test gate. **Open at Login registers
the menu mainApp only**, independently of the engine agent. The service stays
opt-in. Independent Claude/native acceptance, default-on release acceptance
and P3-G0/T73 remain separate decisions.
