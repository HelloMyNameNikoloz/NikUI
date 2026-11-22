# P3: NikUI for Mac

2026-11-21 · round 1 · macOS 14+, Apple silicon · team KBA6653B4V.

This is the implementation contract for the daily-use Mac app. It extends
[architecture](architecture.md), [protocol v2](protocol-v2.md),
[local management](menu-bar.md), and the [P2 acceptance record](p2-acceptance.md).
P2's R10 independent sign-off is recorded in `/tmp/nik-mac/p2/r10-claude.md`;
attended sleep/logout/power checks remain separate. A signed production build
is not permission to migrate this user's running installation.

## Implementation status through round 7 (historical)

One SwiftPM-built app now has a main window, MenuBarExtra, Settings, bundled
Node/nikd launcher, SecItem helper, and retained voice/notifier helpers. Both
flavours build and sign from the same sources. R03 adds the development core:
private P-256 local-device enrollment, a three-column workspace, streaming
WKWebView transcript, native multiline composer, approvals/questions and a
durable queue inspector. NikCore shares sockets across explicit window leases;
compositions and reading state stay independent of the shared menu model.
R03's native gate failed at fleet admission. R05 reproduces that exact private
enrollment → URLSession sealed v2 → both-provider fleet path against the real
development nikd composition with acceptance providers. An unsolicited devices
broadcast preceded application welcome; server seating now follows negotiation.
The headless Swift test additionally sends, streams, answers an approval,
queues and interrupts, including retry after a failed pre-write save.
Claude’s R06 run passed the repaired R05 native app/Keychain/engine E2E.
The R07 native recheck is **native: pending Claude run**.

R05 also adds native image picker/paste/drop, six bounded JPEGs with hashes and
sizes, atomic 0700/0600 draft/outbox storage, and per-window selection/draft/
reading restoration without replaying a click. File inputs are copied and
released. Cmd-F/Cmd-G/Shift-Cmd-G search stable occurrences in the loaded
rendered transcript; WebKit retains native selection/copy/context menus.
Reading appearance, size, width and thinking settings apply immediately;
engine/status/logs and project sections use real state. Editor routing and
explicit Finder/Terminal handoffs accept verified local directories; remote
handoffs refuse. R07 adds app-owned notification delivery and approval badges. Project approval
and the rest of the keyboard map remain named later-round states in Settings.

The production build contains the production identity and cutover review UI,
with engine registration off. The real source-context handshake/production
composition is still a later P3 task: the review reports
`SOURCE_SELECTION_REQUIRED` and `SOURCE_HANDSHAKE_UNAVAILABLE`, plus
`INSTALL_IN_APPLICATIONS_REQUIRED` for a build-tree copy; rollback reports
`SERVICE_OWNERSHIP_REQUIRED` and `CURRENT_STATE_EXPORT_REQUIRED`. These are
explicit unfinished integration points, not evidence that a production
migration passed. The launcher and JS entry refuse before production storage
or Keychain effects, rather than run P2's synthetic composition as production.
There is no runtime flag that enables that composition in production.

R07 repairs the reviewed navigation reload decision, opts negotiating sockets
in before seating while preserving receive-only legacy clients, validates image
attributes in the shared panel painter, removes inline-style CSP permission,
fsyncs store directories, and compacts revoked enrollment records into durable
key hashes. NikCore fences captured controls across windows and keeps unresolved
intent leases until the receipt becomes terminal; a late rejection allows a new
control attempt. ImageIO dimensions are checked before decode. File reads and
pasteboard item/representation counts are bounded; AppKit has no streaming or
byte-length preflight for a raw pasteboard representation, so its single returned
Data is size-checked immediately before decoding or handing bytes to a task.
Draft startup sweeps exact private temporary names.

R07's signed app composition publishes stable engine/source notification IDs
through its authenticated management snapshot. A bounded durable engine ledger
and one app-wide protected delivery ledger prevent replay across windows and
restarts. Settings separately enable delivery and explicitly request macOS
authorization; previews default off, lock suppresses previews, and normal
UserNotifications delivery follows Focus. Engine-wide pending approvals drive
Dock/menu badges. Clicks validate the engine and focus/reuse the issuing
conversation's window or open a new window. The engine has no second desktop
presenter. Native banners, Focus, lock and click/window behavior remain
**native: pending Claude run**.

**Production integration is still incomplete.** `productionComposition.js` is
a separate, tested construction factory for resolved real Claude/Codex tools,
explicit account/environment/project checks, an owned caffeinate assertion and
real selected push/APNs delivery. It requires committed ownership before tool
resolution; construction starts no provider or network exposure. It is not
wired to the launcher. Active-work keeper transfer, lid-guard continuity,
receipt-authority/control-service activation, the real legacy extension source
handshake/inventory/fencing/export, native attended registration/import/commit,
service-client switch and fresh-state handback/unregister remain to integrate.
The production review/launcher continue to refuse rather than run P2 adapters.
`scripts/test-mac-app.sh --native --cutover-rehearsal` runs the P2 selected import
and fresh-state handback subset against a signed DEV engine and disposable
VS Code profiles. Its evidence explicitly excludes the unimplemented production
source/app UI flow; it is **native: pending Claude run**.

The sections below define the completed P3 behavior. They are design targets
unless listed above or backed by the round report's evidence.

## Round 9 integration and remaining gates

R09 supersedes the production integration refusals described in the historical
R07 status above. First launch opens the native review and reads metadata from
compatible source contexts. It creates no engine profile, registration, local
device or notification permission. The source bridge leaves legacy provider
and storage behavior in place until the attended handshake. Its private
descriptor registry is checked against the selected editor's own
`_issues.getSystemStatus` process inventory, including every local window and
extension host; an unknown format, old/unresponsive host or another scope
blocks migration. This internal editor API is a native compatibility gate,
not a portable proof that a real editor was inventoried. The parser follows
[VS Code's process formatter](https://github.com/microsoft/vscode/blob/main/src/vs/platform/diagnostics/node/diagnosticsService.ts).

The Move button registers only the compiled agent, then joins all reviewed
source participants, installs their common generation barrier, closes legacy
network/command admission, waits for store/command promises, exports through
actual context APIs and imports into a selected inactive SecItem generation.
The existing importer verifies identity, grants, full queues, files and current
receipt authority under the owner lock. Commit and the target lease precede
`production-owner.json`; both launcher and JS entry verify committed ownership
before any production composition or Keychain access. The real composition
uses resolved providers and selected delivery, restores the receipt/outbox and
transcripts, then starts authenticated loopback/control service. Native local
enrollment and verified health precede the source windows' service-client switch.
Service clients reconnect without constructing a window engine. Reopened
compatible clients retain a source-context handback endpoint.

Handback takes another barrier and a fresh current export, including state
created after cutover, settings, current pins/credentials, snapshots and receipt
scope. Source contexts preflight and apply it before the new window generation
is released; only then does the native coordinator stop/unregister its agent.
The original source profile and selected generation evidence remain. A runtime
that never created an authority file can return its verified current inactive
import with a proved absent process; a missing health reply alone never permits
backup restoration. Unreachable/uncertain effects retain their fence and report
`CUTOVER_RECOVERY_REQUIRED`. The app serializes transitions across windows and
the source serializes control requests. Portable tests cover six app coordinator
crash boundaries, production-runtime restart/current handback, source default
writes, reopen as a service client, and inactive-start failure. They do not
cover a crash at every native/source/keeper instruction boundary.

**Requested production continuity remains incomplete:** an actively held legacy
lid policy reports `LID_CONTINUITY_UNPROVEN`; owned legacy tailnet/public exposure
reports `ROUTE_OWNER_MISMATCH`. No holder/route is adopted, killed or silently
replaced. Unsafe direct Claude, Codex, approval, terminal and voice work also
blocks. Guarded transferred keeper runs use the existing keeper directory and
exact released run manifest; the service never starts a replacement keeper for
those runs. Active keeper continuity and hardware sleep/lid behavior remain
native gates. A compatible source extension must be loaded; this round does
not replace or reload the user's live extension/profile.

`scripts/test-mac-app.sh --native --cutover-rehearsal` now builds a separate
sealed DEV app and starts a Microsoft-signed VS Code test host with a fresh
user-data/extensions directory and in-memory SecretStorage. It seeds legacy
state through the real extension, drives the same native Move model, checks
the painted imported transcript and service-client mode, creates post-cutover
state, hands back, checks restored legacy state and absent job, and cleans up
only its test registration/Keychain items. Its private driver is compiled out
of production. It no longer reruns P2 acceptance. **native: pending Claude run**,
as are production installation and the attended review/approval/handback flow.
The whole-app updater and large renderer/accessibility/IME gates remain later
work. Signed build verification is not production activation acceptance.

## One application and its processes

### R11 recovery contract (historical; superseded by R13 below)

`Restore VS Code` is available without a successful review, a connected editor,
or a running service. Before a service commit it discards only that attempt's
inactive imports, opens the original generation, and resumes/reloads the live
sources. Every retry checks PID/socket liveness again. Dead writers are retired;
a reloaded host exposes a recovery endpoint before constructing any engine.
New Moves require the recovery-capable `p3-source-v2` bridge; a still-loaded
older bridge is refused before any source joins or writer modes change.
After abort/handback the profile mode file is removed and legacy command/store
adapters stop using the ownership lock. During a Move, short cross-window lock
contention waits instead of dropping sends, and nested command/store guards are
reentrant. Private lock claims are fsynced before atomic exclusive publication;
dead ownership and interrupted recovery claims can be recovered automatically.

Handback exports current authority, metadata, transcripts, settings and secrets.
A stopped/crashed service is read only after exclusive acquisition proves its
process/endpoint absent; a sealed service export is also durably cached. Before
commit, each source workspace receives a delivery encrypted with its unchanged
source identity. Closed/reloaded windows apply that delivery through VS Code's
context APIs before starting legacy. A released window generation is never
reapplied over subsequent legacy edits. Production generation/evidence Keychain
items are removed after publication/release; only encrypted pending deliveries
remain for closed workspaces. Current secret deletions are applied, the editor
service-client credential is removed, and original workspace/folder settings
scopes and unset keys are preserved. Service-owned state is separated by owner
generation so a later Move cannot reopen a prior service's authority.
Full transcript/queue snapshots are saved before freezing so an aborted Move
can reload without losing in-memory text, snippets or queued image bytes.
Before provider admission, a durable queue-import checkpoint distinguishes
unregistered legacy prompts from work already received by the service. Offline
return keeps that pending work and projects current metadata/outbox queues over
lagging transcript checkpoints, so old snapshot queues cannot be resurrected.

Memento and SecretStorage enumeration are awaited. Known engine keys transfer;
editor/cache keys have declared dispositions; future unknown keys are named as
`preserved-in-place` and never interpreted, copied, deleted or rejected just for
being unknown. Inventory failures report area/key names without values. Native
rehearsal evidence includes those diagnostics and actual extension-host logs.

The service uses an owned keeper directory for new runs. Only exact released
run IDs may attach to an existing live source keeper. An absent source keeper
does not block a fresh owned run after logout/reboot and is never restarted at
the source directory. Active-run, lid and route continuity remain native gates.

Portable recovery tests cover 252 combinations: 10 Move and 11 handback stages,
1/3 windows, app crash/quit, window close/reload, VS Code quit and reboot. Real
minted Node-process loss additionally exercises dead PID/lease and lock recovery.
The signed native rehearsal now uses two disposable VS Code windows, reloads
one at the Move barrier, retries through Restore, then checks current handback,
both legacy windows, absent mode file and absent job. **native: pending Claude
run**; this is not a claim of native instruction-boundary crash acceptance.

### R13 release and recovery contract

The coordinator owns the shared mode file's lifecycle. A window opened between
join and the barrier joins the same owner without deleting that file. Commit
checks the file and all source acknowledgements under the ownership lock. The
`p3-source-v7` bridge is required as of R21; older loaded bridges must be reloaded.
An editor-owned Move grant and completed-generation receipt fence the registry
and engine files. Replaying even valid old mode/owner/journal records after a
completed return cannot switch a legacy window back to the released service.

Shared user settings, global state, credentials, devices, ledger and receipt
authority are applied once through an acknowledged live editor context before
release. If all editors are closed before shared restoration, Restore retains
the fence and Keychain generation and reports `SOURCE_RETURN_TARGET_REQUIRED`;
opening a compatible editor permits retry. Every completed Restore, including
a precommit abort, also requires an editor acknowledgement of its legacy receipt.
Restore never completes by leaving a future shared-state
replay on disk. A receipt in editor storage makes retries idempotent even if the
app dies after the editor's acknowledgement and before recording it.

Only workspace state can be deferred. Its data and authorization reside in the
editor's own storage; no later file in `NikUI/sources` or the engine root can
authorize a legacy import. A later change to a workspace's own memento or project
settings revokes only that workspace's permit. Shared writes and read-only commands
retain other folders' returns. Delivery also compares the original workspace state
and workspace/folder setting scopes and the released owner generation. An
untouched workspace consumes its return once; a changed or superseded workspace
retains both the saved payload and later edits and enters recovery. Old `.restore`,
`.keepers` and snapshot files in the source directory are discarded; they never
authorize workspace imports. Editor-owned undelivered payloads and snapshots
remain available on a mismatch. An unknown,
mismatched or unreadable shared ownership fence enters recovery and remains
untouched for the coordinator. Keeper handoff manifests survive repeated reloads
until their returned runs end, with new legacy runs using the ordinary legacy
keeper directory. Proof of completion removes the manifest and its `.store`.

`cutover-return-state.json` is no longer created. The service's crash export is
encrypted with a random key held only in a transition-specific Keychain account,
independent of the source identity. Successful handback deletes the ciphertext,
its key and the copied generation/evidence accounts. Legacy snapshots and
receipt metadata use editor-owned storage instead of the source registry.

The editor shows recovery/unavailable text and a Restore action. At Move it
retains a copy of the signed Keychain helper in its own storage. Local Restore
uses that helper and the extension's coordinator, including when the app has
been deleted; only the exact reviewed engine job can be retired. This native
Keychain/launchd fallback is **native: pending Claude run**.

Mac cutover subprocesses have bounded deadlines, cancellation and app-exit
cleanup, plus a parent-liveness check in Node. The review can be dismissed or
cancelled while a subprocess is busy. Enrollment waits for actual engine status;
a startup/enrollment failure keeps ownership and offers an explicit Restore
choice instead of initiating an automatic handback.

The native rehearsal installs a checkout copy and a startup observer only in a
fresh disposable extensions directory. Two ordinary folder-opening requests
share its isolated editor instance; each must register a source. Cleanup first
requests window closure, then repeatedly captures only the exact disposable
user-data argv roots and descendants, stops roots before their replaceable renderers,
and revalidates command/start time before each signal. Two empty scans verify quit.
Native harnesses bound commands and child waits,
emit one final JSON result, and exit even if a failed child retains an IPC handle.
Portable checks cover the original 252 crash/close cases, plus 24 closed-folder
cases across 12 handback stages, reopening after legacy edits or a second Move
and handback. Native execution and production installation remain Claude-only.

### R15 update identity, bounded returns and progress deadlines

Installation identity is the extension id plus the selected profile hash, so a
versioned extension directory change retains the same owner, fence and local
Restore selection. Portable checks Move on one version, reload on the next, and
restore current work through both the app coordinator and editor-local coordinator.
Owner read failures and mismatched identities never construct a legacy engine or
delete a valid fence; correcting the owner permits the ordinary handback.

Full workspace payloads live in private editor-owned files. GlobalState contains
only small hash/binding receipts. Staging validates a bound of 256 workspaces and
512 MiB before changing existing permits. As of R17, closed-folder returns block
a subsequent Move until those folders finish returning or the user confirms an
archive-and-forget action. Revoked or superseded returns enter recovery.
After 30 days an undelivered payload requires explicit editor Restore, retaining
its bytes and permit while recovery rechecks the baseline and released generation.
Tests retain moved-period conversations, transcript, queues and folder settings
after another folder writes, and reject stale Move-time queue replay.
Original legacy queue import supplies the required request timestamp, preserves
that timestamp on a partial-import retry, and honors the completed-import marker
on every restart. Consumed Move-time inputs cannot be replayed after their
receipts and terminal outbox rows pass normal retention and are pruned.

Never-moved windows publish a descriptor and watch the app's review request; the
control socket starts when review needs it (or remains idle if filesystem events
are unavailable). Completed reviews remove their wake request. Admission and memento writes perform
zero cutover filesystem operations when no permit was present at activation.
Quiescence, source RPC, Node and Swift child deadlines now measure inactivity.
Actual export/store/release steps renew them; repeated progress, a stalled source,
cancellation, app exit and parent exit remain bounded. A proved abort still returns
an extended transition to usable legacy writes.

Retained R14 evidence proves the native Stop result was followed immediately by
automatic delivery of the next queued prompt (effects: two sends, one interrupt).
The native scenario now verifies the durable queue first, removes that item through
the real native unqueue control and requires its receipt, then runs the unchanged
strict idle-plus-interrupted-result check within its original 45-second deadline.
An additional R17 native stage leaves a different queued prompt intact through
Stop and proves its original mid reaches the provider once afterwards.
The rehearsal consumes `Canceled` only for its explicitly requested reload.
All changed native scenarios are **native: pending Claude run**.

### R19 abort reloads and explicit saved-return exits

The retained R17 workspace mementos, remembered file and both full snapshots
still contain their seeded conversations. The empty native probes came from
disposed engine objects. Previously, abort advertised those objects as legacy
before the scheduled reload, allowing a fast retry to export an empty manager.
Sources now report `SOURCE_RELOADING` until actual reactivation, and teardown at
the barrier saves full snapshots before slim memento persistence. Recovery can
reconstruct a conversation from its snapshot if its memento never completed.
The native rehearsal pauses after abort and requires each newly activated window
to prove its own original conversation and seeded transcript before retrying.
Abort acknowledgements retry a brief reload race and retain per-source failures.

For changed folder settings, the editor recovery panel offers **Keep Current
Settings and Import Conversations**, with a modal confirmation. This skips only
setting comparison and setting writes; exact workspace state, released ownership,
generation, payload hash and authorization checks still apply. Later conversation
changes remain protected. **Discard Saved Return** also requires confirmation.
The Mac review lists pending returns, identifies missing folders/workspaces, and
offers **Forget This Folder’s Return** with a confirmation dialog. Both forget
paths write an authenticated encrypted archive under the selected editor profile’s
`cutover-archives` directory before removing that return’s blocker or artifacts.
Each archive is read back, decrypted and compared before removal. If the editor
identity is unavailable, this archive uses a separate private recovery key in a
0600 `.key` file beside the encrypted archive; the selected identity is never
regenerated. A failed write or read-back leaves the saved return intact. Staging
bounds and conflicting receipts are checked before shared settings/secrets change.

A local Claude process between turns is quiescent even when the keeper is off
or unavailable. Keeper metadata is required for processes held by the keeper;
an unavailable keeper with no held runs is omitted from the transfer.
Turns, approvals, catch-up/attachment and background work still block Move; only
an idle source process is closed when releasing resources. Source descriptors
bind their process start/argv proof when available; one process snapshot skips
reused PIDs before the socket wake wait. Restricted test hosts retain socket checks.

Retained R17 e2e authority proves the surviving prompt already ran once after
Stop (three sends, two interrupts, its original mid accepted). Its accepted row
remains visible until completion, so the native assertion now checks that state
and its disabled queue actions instead of requiring the row to disappear. Strict
45-second Stop checks remain. Native validation is **pending Claude run**.

### R21 retry rehearsal and conversation completeness

Abort/resume retries empty inventories during extension-host replacement and
requires acknowledgements from every currently live source. Stopping after an
abort also handles an already-unregistered job, or proves that the registered
job has no PID before returning. The retained R20 engine log also contains
`SIGNED_ENGINE_UNAVAILABLE` after retry committed both seeds. Its underlying
cause was hidden; an occupied listener port reproduces that startup failure
portably. The disposable rehearsal now explicitly exports `remote.port = 0`,
and development startup failures retain their actual error code. Native retry
records its coordinator stage and failure immediately, then requires both seed
transcripts to paint in the app before handback and both seeds in legacy afterward.

At close-admission, persisted session IDs must be present in the live managers.
Export checks that baseline again, including after later memento writes, and
records every exported conversation ID with the source workspace. Handback
independently compares the immutable original Move receipt, uses its workspace
baselines, and checks each workspace's IDs before staging or overwriting any state;
only the validated current authority's explicit deletion tombstones permit an
omission. The final editor importer independently checks the saved baseline.
A refusal before source teardown leaves that same live writer and its full
typed input/transcript intact after abort, without forcing a recovery reload.
A short list raises `EXPORT_INCOMPLETE` and retains the original work. Snapshot
hydration retains skipped entries (including path mismatches) while consuming
successfully delivered entries once. The Mac queue now hides running and
finished prompts while retaining queued and unresolved work; native e2e also
requires the completed prompt to be absent from the visible queue.

### R23 native regressions, port takeover and editor receipt propagation

The retained R21 e2e engine stdout contains the expected generation. The
failure occurs at the next controller status assertion: a swallowed control
read becomes `control: null`, rather than an engine status missing its
generation. The discarded exception prevents recovering the original errno.
The controller now shares the menu client's framed, partial-write/EINTR-safe
socket transport, retries transient reads, and returns a named `controlError`.
Portable Swift checks use that same controller reader against a real private
daemon through SIGKILL recovery, intentional stop and explicit restart, plus
the acceptance-provider daemon and Mac enrollment path. Native confirmation
of the original intermittent failure remains **pending Claude run**.

The retained engine-regression failure is inside its npm subprocess, before
the SIGKILL command. The full recovery matrix repeatedly waited five seconds
for intentionally closed fixture windows; its private source wake could also
be lost during host replacement. Fixture acknowledgements now use a bounded
500 ms wait while production retains five seconds. Review reissues a missed
filesystem wake while its endpoint is absent; idle sources still do not poll.
The native harness runs SIGKILL first, records the actual suite stage, and
launches the test runner directly so a timed-out npm wrapper cannot orphan it.
The full npm child has a finite 15-minute allowance; the other regression
children retain their 10-minute limits and the whole native CLI is bounded.

The retained handback renderer log identifies `Saved workspace retained:
ENOENT` in window 2. Independent VS Code globalState caches can retain a
receipt after another host applied its payload and removed the files. An
editor-owned bounded history of exact receipt acknowledgements survives that
deletion and later Moves. An older receipt cannot hide a newer pending payload;
Forget also refuses a receipt that no longer matches the payload. Stale
receipts neither read missing payloads nor replay imports; a newer/different
receipt remains pending. The portable two-window regression reloads through
that stale cache and verifies both seed transcripts and new app work. Waiting
unauthorized endpoints recheck editor-owned grants/completion before resuming.

Bridge `p3-source-v8` reports configured and actual listener ports. Review
probes the selected port and reports `PORT_IN_USE`, with holder PID/command
when available, unless that holder is a selected source's authenticated
listener. Move rechecks before fencing. Late bind failures retain their real
code in production and in a fresh, Move-bound startup record read by the
controller/app. Offline export retains the root lock through publication of
the window generation; both restart race orderings have portable coverage.
Each workspace exports/restores its actual fallback listener port, and a
handback port conflict names the replacement address in VS Code. Original
Move and subsequent recovery failures remain independently visible.

The native runner `/tmp/nik-mac/p3/r25-native-gates.sh` includes both the
existing port-zero rehearsal and `--cutover-rehearsal-fixed-port`. The latter
chooses a free fixed high port other than 4517 for its disposable profile,
rechecks it before opening the editor, and requires the exact legacy host to
hold it. Native evidence retains the accepted review and selected holder PIDs,
proves that only the engine owns that same port after Move, checks its health
and painted transcripts, and verifies legacy rebinds it with the job gone.
Both actual legacy ports are checked after handback. Port selection skips
pre-existing holders; 4517 is never probed or configured by this rehearsal.
Holder discovery retries once; an occupied port without a known holder stays
blocked with a Refresh message. Source review and listener exports use the
same effective `remote.port` getter as the extension, including workspace
overrides. Staging checks delivery against the current payload before allowing
a later handback to replace it. Controller status retains the first read error
with its operation and original socket errno, even after a successful retry;
the e2e evidence includes that controller result and the first status-file
read error. All fresh
native gates are **pending Claude run**; build/signature verification does not
claim native cutover acceptance or authorize production installation.

```text
NikUI.app/Contents/
  MacOS/NikUI                      SwiftUI AppKit shell, local client
  MacOS/nikd                       native launcher; execs only bundled Node
  Library/LaunchAgents/com.nikui.engine.plist
  Helpers/NikKeychain.app          bounded stdin/stdout SecItem protocol
  Helpers/NikNotifier.app          retained helper; app owns desktop banners
  Helpers/NikVoice.app             pinned FluidAudio + resources; no models
  Resources/engine/{node,src,media,package.json,mac-engine.json,build-manifest.json}
```

The UI process owns windows, local enrollment/device key, client cache,
drafts, menus, accessibility, and native adapters. It does not construct an
engine in-process. The separately managed per-user agent owns the authority,
providers, private control socket, receipt/outbox, selected identity and exact
network/power resources. Closing windows or Cmd-Q does not stop it. MenuBarExtra
is a scene in this app, not another independently installed menu app.

The keeper remains the separate small Claude runner. It is never embedded by
adopting or replacing a user's existing keeper. Codex owned app-servers and
borrowed external daemons retain their distinct ownership/lifetime rules.
P3's real production composition must replace P2's disabled provider/fake
machine adapters explicitly; selecting a production bundle ID is insufficient.
Unavailable adapters advertise named blockers, never simulated success.

Use SwiftPM and a small deterministic bundle/signing driver, without an
Xcode project or xcodegen dependency. NikCore, the menu and voice already use
SwiftPM; no storyboard, asset compiler or Xcode project feature is required
for this shell. Build with the installed command-line Swift/macOS SDK tools;
an Xcode GUI/project is unnecessary. The iPhone's existing `project.yml` and
deployment target stay unchanged. No Catalyst target or iPhone compatibility
window is introduced. If a later feature requires an Xcode-only build step,
record that dependency rather than silently changing this contract.

## Shared Swift and Mac-specific code

| Layer | Shared or Mac-specific decision |
| --- | --- |
| `app/iphone/NikCore` | Share wire models, crypto/sealing, host pins, v1/v2 negotiation, reducers, receipts/mids, pending-intent persistence, snippets, Markdown/tokenization, transcript search, provider state and queue/approval rules. Keep platform imports out. |
| iPhone view composition | Selectively extract platform-neutral status labels, statistics, Markdown presentation and approval/queue content into a small shared view module when reused. Preserve one source of behavior, without importing the whole iPhone app target. |
| iPhone app/lifecycle | Keep `NikUIApp`, `AppModel`, `RootView`, `NavigationCoordinator`, phone pairing/lock/privacy shield and APNs registration on iPhone. The Mac must not reuse their singleton navigation or phone background/suspend semantics. |
| Transcript/composer | Reuse NikCore items, formatting, find results, snippets and action semantics. Replace UIKit `UIImage`/pasteboard/scroll probes, PhotosPicker, phone sheets, touch zoom, haptics and iOS 18-only text/scroll APIs. Decide renderer through P3-G0 below. |
| Native Mac platform | AppKit pasteboard/image/drag APIs, NSOpenPanel, file reveal, desktop key storage, notification click delivery, accessibility, focus/commands, window restoration and desktop lifecycle policy. |
| `NikMacIdentity` | Foundation/Darwin-only compiled identity policy, linked into the app, launcher and SecItem helper. Swift tests run with both production and development compiler flags. |
| `NikMenuCore` | Keep the typed owner-only management client, validation, observation/backoff and menu state. App-level connection coordination shares it with the main window. |

Do not fork NikCore just to remove its phone assumptions. Today
`NikClient.selectedConversationID`, `selectionOrigin`, `visibility`, the
connection manager's selected conversation, and `ConversationState.draft` /
`reading` are singular. These need an explicit compatibility refactor before
two windows control conversations. Passing one `NikClient` to two unchanged
iPhone `ConversationView`s would close the other window's socket and overwrite
its draft/scroll. Round 1 deliberately does not do that.

## Scenes, windows and state ownership

The app owns one `MacAppSession`: enrolled local identity, one fleet connection,
management observation, shared immutable/reduced conversation data, protocol
sessions, provider capabilities and a subscription pool. Each main
`WindowGroup(id: "main")` instance owns `WindowSession(windowID:)`. Settings is
one app scene. Menu actions and notification clicks open/reuse a main window;
closing the last window leaves the menu and agent running. Dock activation
reopens a window. Production has a Dock icon (`LSUIElement` is absent).

| State | Owner / persistence key |
| --- | --- |
| Fleet, projects, history, transcript, queue, pending approvals and run identity | Shared app connection; authoritative values come from nikd. One connection per subscribed conversation, reference counted by visible windows. |
| Selection, sidebar/filter, inspector, navigation history | Per window; restoration uses stable window UUID and engine identity. Never a global selected conversation. |
| Draft text, attachments, marked text, caret, reply target, slash state | Per `(engineID, localDeviceID, windowID, conversationID)` composition. Two windows on one conversation have separate drafts. |
| Reading anchor/offset, follow-latest, expanded items, selection/find query/match | Per window + conversation. Selecting a second window does not scroll the first. |
| Pending mutation, receipt and provider outcome | Shared intent repository, immutable source draft/window/composition ID and request hash. A reply only clears its exact originating draft revision. |
| Credentials, grants, pins | App/engine selected Keychain namespaces; never window restoration/UserDefaults. |

Introduce a NikCore view-session API: acquire/release a conversation and
feature subscription with a window token; submit an explicit immutable draft
with its source/composition ID; keep a per-view origin token for preconditions.
The iPhone facade keeps one default view session and its current public API.
The pool computes the union of requested feature visibility, opens a
conversation socket on first acquisition, and closes it on last release.
Closing one window cannot mark another window's in-flight send ambiguous.
Route late create/resume/editor responses to their captured window token;
never the currently focused window. One window may ship first, but the data
model and persistence format must support two before production transcripts.

Mac lifecycle follows process lifetime, sleep/session lock and connectivity;
losing key-window status does not call phone `.background`, stop sockets or
lose an approval. Aggregate visible conversation presence across windows;
actual attendance additionally requires app active, unlocked session and a
visible current target. Screen lock suppresses private presentation and
attended confirmations, while nikd remains independent. Wake revalidates
generation/run/turn/pins before enabling controls. Restoring a window neither
resends an intent nor starts a stopped engine.

## Local enrollment and trust

After explicit engine setup, connect only to the compiled flavour's selected
0700 directory and 0600 `c.sock`. Reject symlink components, foreign owners,
changed socket inode, wrong `getpeereid`, oversized frames and mismatched
engine/generation. Production roots derive from `getpwuid(getuid())`, not
HOME, a URL, command-line option or JSON-selected root. The same-UID boundary
does not claim to defend against malware running as this user.

Retain P2's `{op: "enroll", kind: "local", protocol: 2}` management seat and
correlated local request/result schemas. Its existing `menu-client.json` is
private and sufficient for P2 dev tests. The daily-use client additionally
enrolls its own P-256 device SPKI over that private socket; the server issues
the full-control/local seat, pins and loopback endpoint. Feed those into
NikCore's existing sealed transport and protocol negotiation. **This device
enrollment extension is a P3 implementation gate**: P2's management credential
alone is not a phone-protocol device pairing. Do not impersonate a phone or
use a browser capability key as app authentication.

Keep the app device signing key/enrollment in its own exact Keychain service;
keep host identity/VAPID/other engine secrets behind the bundled helper.
Neither private key crosses to WebView JavaScript. Validate selected pins on
every reconnect. Corrupt/locked/denied/revoked identity stops admission with a
named problem; no memory/file fallback or replacement identity. A generation
change refreshes subscriptions and run controls, while preserving pending
mids. Enrollment never opens tailnet pairing or hands credentials to a page.

## Desktop experience and feature contract

Use a native three-column `NavigationSplitView`: projects/folders, conversation
list, conversation. A collapsible inspector holds details/queue. Spacious
default widths, system typography, restrained separators/material, semantic
colors and a narrow readable transcript measure provide the visual character.
Respect light/dark, Increase Contrast, Reduce Transparency/Motion, keyboard
navigation and VoiceOver. Color alone cannot convey provider or run state.

| Surface | Required behavior |
| --- | --- |
| Projects | Explicit union of owner-approved projects, announced editor workspaces and existing instance projects. Project visibility does not grant creation authority. Persist folder order and per-conversation placement; new project uses native folder selection plus an explicit approval. |
| Both providers | Claude and the single selected Codex account appear together with text/icon provider identity, busy/waiting/idle/asleep/read-only states. Creation/resume choose approved project/model/account. Sleeping catalog rows stay searchable; waking or resuming is an explicit action. Borrowed Codex lifetime stays external. |
| Transcript | Streaming text, Markdown/code, tool results, approvals, plans, errors and attachment previews use stable item IDs. Large blocks can expand/copy without forcing scroll to bottom. Show clipped history and a load-more path explicitly. |
| Composer | Native multiline text/IME, slash palette/snippets, provider/model controls and clear Send/Queue/Steer semantics. Return inserts a line; Cmd-Return sends. Steer and stop bind to their issuing run/turn, never the latest visible turn. |
| Attachments/drafts | Native file picker, paste and drag/drop; images use the existing bounded wire representation (currently up to six JPEGs). Do not pretend arbitrary PDFs/files are accepted. Unsupported files explain capability limits; file references require a negotiated provider feature. Copy selected bytes into the private client draft store, release file access, retain hashes/size/MIME and atomic metadata. Closing/relaunch restores the exact composition, including bytes. |
| Approvals | Prominent native card + sidebar/menu badge; focus the issuing conversation. Accept/deny and answering questions use captured run/turn/question IDs and fresh membership. Duplicate/stale answers refuse by name. Engine restart never auto-accepts. Project approval text says Claude's bypassPermissions is not a sandbox. |
| Queue | Inspector lists full durable payload/attachments, order, scheduled/quota state and delivery outcome. Edit/remove/reorder/promote only through advertised actions with preconditions. Unknown work stays visibly unresolved; it is not retried or silently copied into a second send. |
| Find/copy | Cmd-F searches the loaded transcript, Cmd-G/Shift-Cmd-G step stable occurrences; surface unloaded/clipped scope. Continuous cross-message selection, plain-text/code copy and accessible context menus are required. Copy is a user action; no automatic clipboard writes. |
| Terminal | Open Terminal/iTerm through explicit handoff. P3 does not claim an embedded interactive terminal; that requires the later PTY service. |
| Settings | Native sections for appearance/reading, notifications/privacy, projects, selected provider account/tools, engine/login/status/logs, exposure and cutover/rollback. Explain desired vs active settings and explicit restart. Keep credentials out of text fields/diagnostics. |

Drafts are client-owned; queues/outbox are engine-owned. Before send,
persist the immutable full payload and mid. Clear only after the matching
receipt promises acceptance, preserving receipt recovery and v1 ambiguity
behavior. Do not reuse legacy queue mementos that truncate text/drop images as
the authority. Independent windows and phone drafts never overwrite each
other. Private local caches have bounded storage and eviction excludes drafts,
pending/unknown intents and retained attachment bytes. Deleting a draft with
unresolved delivery requires review; closing a window does not delete it.

### P3-G0 / T73: renderer decision and measured acceptance

R02 decision 1 selects WKWebView, reusing `media/markdown.js`, `highlight.js`
and the extracted `transcript-renderer.js` painter from `panel.js`. No native
prototype comparison is required. R03 parity tests retain the previous painter
and compare every item kind under both thinking and app settings. Use one saved
acceptance fixture: 5,000 mixed messages, long streaming output, a 10,000-line
code block/diff, images, approvals and a transcript beyond the phone's current
400-item window. Record fixture size, hardware, OS and measurement method.

Gate: correct selection/copy across message/code boundaries; stable find under
streaming; no lost IME marked text/caret; readable VoiceOver order and controls;
keyboard-only operation; independent drafts/scroll in two windows; no UI stalls
from full-document re-layout. Target p95 visible streaming updates within
100 ms and no repeated main-thread tasks over 16 ms during the fixture run;
measure idle memory and incremental growth, not just first paint. Claude
records attended accessibility/selection/IME evidence. The measured large
fixture and attended checks remain later-round gates for the selected renderer.

The renderer loads only signed bundled resources with a narrow typed message
bridge. Keep cryptographic/network credentials in NikCore/native code; JS
receives transcript data and validated action descriptors, no engine or
Keychain authority. Navigation delegates send external links to
`NSWorkspace`/the system default external browser. Never open an in-app Codex
browser. Renderer choice does not change draft/subscription/receipt ownership.

### Keyboard map

| Shortcut | Scope/action |
| --- | --- |
| Cmd-N | New conversation sheet in the current window/project; no provider starts until submitted. |
| Shift-Cmd-N | New independent window once two-window subscription/state acceptance passes. |
| Cmd-1 / Cmd-2 / Cmd-3 | Focus projects / conversations / composer. |
| Cmd-K | Project/conversation command picker. |
| Cmd-Return / Return | Send or enqueue / newline. IME candidate confirmation always wins. |
| Escape | Dismiss palette/find/sheet first. Interrupt only through a distinct confirmed action. |
| Cmd-. | Interrupt the current captured run/turn; disable when stale. Menu Stop Engine has no conflicting Cmd-. shortcut in the completed app. |
| Cmd-F / Cmd-G / Shift-Cmd-G | Find / next / previous occurrence. |
| Cmd-C / Cmd-A | Native focused selection behavior; no global copy interception. |
| Shift-Cmd-O | Open current project/file in preferred editor through the editor route. |
| Cmd-, / Cmd-W / Cmd-Q | Settings / close window / quit UI, leaving the engine running. |

R03 binds Cmd-. to the captured conversation turn. Menu Stop Engine uses
Option-Cmd-.; the broader desktop shortcut map remains a later-round target.

### Open in editor, Finder and URLs

Every file/project action carries its immutable cwd/resource URI, line/range,
requesting window and explicit provider preference through `editorRoute.js`.
Use authenticated originating/selected provider first, longest matching
workspace URI second, eligible focused provider third. A selected provider's
disconnect returns `EDITOR_UNAVAILABLE`, rather than redirecting a late action.
Preserve remote URI scheme/authority; a remote file cannot be treated as local.

VS Code and Cursor are distinct connected editor providers, not process-name
guesses. An explicit “Open in VS Code/Cursor” may use a registered, supported
editor-launch adapter selected by the owner; no arbitrary shell commands or
Terminal typing automation. Without a compatible editor, offer “Reveal in
Finder” for a verified local resource via the router's explicit system-reveal
adapter (`NSWorkspace.activateFileViewerSelecting`). Unsupported remote reveal
refuses. P2's router currently only supplies URL fallback; Finder/editor-launch
adapters are a required P3 addition, not existing parity. All web URLs open in
the system's default external browser. Use no in-app browsing surface.

### Notifications without duplicate Mac banners

The writer generation has one machine notification owner, following
`policyOwner`: old extension releases local banners/sound before nikd acquires
them. The Mac app is a notification presenter/click client, not another source
of completion events. The extension suppresses its local notification path
while it is a service client. Choose one presentation bundle identity for the
production app/helper and retain it through updates; never request permission
from every window. Request notification authorization only from an explicit
Settings/first-run choice, independently of engine registration.

Introduce one stable event ID derived from engine identity + source event /
run/turn + kind (not boot generation), retained in bounded durable delivery
records. Engine publication, APNs/Web Push and desktop presentation use that
ID. Desktop app/helper/extension share the one local delivery claim; each
phone independently deduplicates the same event on reconnect. Do not suppress
the phone's requested notification merely because a Mac is online: deduplication
is per destination, and active-reading suppression follows explicit presence
and user preferences. Avoid double sound between the helper and app.
Existing P2 in-memory `seen` alone is not restart-proof delivery deduplication;
stable IDs/durable local claims and native ownership transfer remain P3 gates.

Click routing includes engine/conversation and exact event identity. Reuse a
window already showing that conversation or open one; refresh and show current
state, without auto-answering an old approval. Private previews respect lock
and user preferences. Codex completion/CI notification expansion requires an
explicit capability implementation; P2 busy aggregation alone did not add it.

## Compiled production and development flavours

| Identity/resource | Production | Development |
| --- | --- | --- |
| Product/app ID | `NikUI.app` / `com.nikui.app` | `NikUI Dev.app` / `com.nikui.app.dev` |
| Engine label | `com.nikui.engine` | `com.nikui.engine.development` |
| Swift compilation | `-DNIKUI_PRODUCTION` | `-DNIKUI_DEVELOPMENT`; unqualified Swift tests default safely to dev |
| JS identity | Generated literal `src/macBuildIdentity.js`, sealed before signing | Same generated source with dev literal |
| Engine root/socket | Account-home `Library/Application Support/NikUI/engine/{c.sock,…}` | Sealed 0700 test HOME under `/private/tmp/nik-mac/build/`, exact `HOME/profile/c.sock` |
| UI cache/drafts (target) | `~/Library/Application Support/NikUI/client/` + window keys | Selected test HOME's `client/` |
| Logs (target) | `~/Library/Logs/NikUI/` | Selected test HOME |
| Host Keychain service | Exact `com.nikui.engine.production.selected-store-v1` | `com.nikui.engine.test.<sha256(testHome)[0:32]>` |
| Local-device Keychain | `com.nikui.app.local-device.v1` | `com.nikui.app.test.<sha256(testHome)[0:32]>.local-device.v1` |
| Production cutover | Opt-in review; only an attended click may commit/register | Always refused: `DEVELOPMENT_PROFILE_ONLY` |
| Acceptance adapters | Never | Signed build-only `acceptanceP2` / `acceptanceRealTools`; never environment/network opt-ins |

Frozen installation invariant: never reuse an engine launchd label under a
different parent app bundle ID. Changing the parent requires a new label.
`com.nikui.engine.development` belongs only to `com.nikui.app.dev`; the old
P2 app-ID/job-label collision must not recur.

`NikBuildFlavour`, app ID and engine label in Info.plist and `mac-engine.json`
must agree with the compiled identity. They do not choose it. Defining both
Swift flags is a compile error. Changing HOME, arguments, environment, JSON
label or a copied test-root plist cannot turn one binary into the other.
Production manifests reject **any** `testHome`/`root` field or enabled test
option before private-root or SecItem operations. Dev controllers construct
only their compiled dev SMAppService label and verify it before registration.
Production CLI `register`/`unregister` refuse (`USER_CUTOVER_REQUIRED` /
`USER_ROLLBACK_REQUIRED`); the GUI owns those attended decisions.

The production launcher derives account paths from macOS account data, never
an inherited HOME. The development launcher clears inherited Node/provider
injection, sets explicit test HOME/TMPDIR/CODEX_HOME and retains only the SSH
socket allowed by P2. Preserve no production provider home in dev. Root and
socket filesystem validation remains necessary in **both** builds; a compiled
flavour replaces the old *identity decision* based on a `/private/tmp` prefix,
not the development profile's isolation checks. Refuse long Unix socket paths
by name; do not relocate the production socket into a test directory.

The SecItem helper compiles the same policy: prod admits only its exact
production service; dev admits test/dev prefixes and rejects the production
service before opening any Keychain item. A selected service is stable across
rebuilds at the same dev HOME, so builds no longer insert a random namespace.
Fresh acceptance runs still use fresh test HOMEs and disjoint services.
The second rebuilt helper is packaged only in dev for the P2 ACL test.

## Build and installation

```sh
scripts/build-mac-app.sh --flavour prod --version 0.3.0 --build-number 1
scripts/build-mac-app.sh --flavour dev --version 0.3.0 --build-number 1
# P2 compatibility entrypoint always selects dev:
scripts/build-mac-engine.sh
```

All products/caches go under `/tmp/nik-mac/build/p3`. The builder refuses to
overwrite an existing app or emit into `/Applications`/the checkout. A
production build creates no production profile, enrollment, Keychain item,
LaunchAgent registration or network configuration. Building/signing is safe
before installation; installing is Claude's final attended/native task.

Pin Node v26.7.0 darwin-arm64 to SHA-256
`7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4`, verify the
official saved checksums too, and extract fresh bytes on every build. Preserve
Node's license and SwiftPM's exact FluidAudio 0.17.5 revision/checksums. Use
fixed release targets and separate prod/dev Swift scratch directories. Inputs,
toolchain version, git revision, version/build and resource hashes are in the
sealed manifest; there is no current-time/random package identity. Signed CMS
bytes include signing time even with `--timestamp=none`; different
certificates/SDKs can also change outputs. Check input/payload reproducibility
with those fixed, separately from the signed CMS envelope.

Sign every nested executable/app inside out using Apple Development team
KBA6653B4V, hardened runtime and no app sandbox. Only Node has allow-jit and
allow-unsigned-executable-memory. Keep no debug/get-task-allow entitlement.
Verify deep/strict signatures, team/requirements, minimum OS, architecture,
resource manifest and relocation. Developer ID/notarization is optional and
does not replace the Apple Development/native gate for this Mac.

The supported production location is exactly `/Applications/NikUI.app`.
Development can run from the private build tree. Opening a second production
copy must show the installed copy/location and refuse to register/rebind a
different agent. Do not write a second production LaunchAgent plist or use
`launchctl bootstrap` as an approval workaround. The embedded `BundleProgram`
is bundle-relative, so the whole app moves/updates together. Register with
`SMAppService.agent` only from the explicit setup action, after checking the
installed path and selected ownership. “Open at Login” controls
`SMAppService.mainApp` separately and never registers the agent.

Use `CFBundleShortVersionString` for the app release and monotonically
increasing positive `CFBundleVersion` per release build; CLI overrides are
validated and recorded. Engine/protocol versions remain independently
advertised. Never infer wire compatibility from the app marketing version.

## Update in place, Stop and restart

P3 supports a local manual replacement of the whole signed app; Sparkle is
P4. Do not overwrite executable files in a running app. Stage and verify a
candidate beside the installed app on the same volume; compare identifiers,
team, version/build, minimum OS, schema and protocol compatibility first.
Downgrade requires an explicit compatible-state decision, not a stale backup.

1. User chooses “Prepare Update”; close new-turn admission and take the
   transition lease. Inspect authoritative outbox/dispatch, approvals, Claude,
   owned/borrowed Codex, terminal writes and exact resource ownership.
2. Wait a bounded 30 seconds, showing work/blockers. Keep unsafe owned Codex,
   borrowed busy work, pending approvals/unknown outcomes or unprovable keeper
   continuity blocked. Cancel reopens admission without replacing anything.
3. Flush queues/authority/receipts and release only owned policy/exposure.
   Eligible Claude checkpoints need a compatible keeper and reattachment
   inside its three-minute grace; no Codex/keeper-reboot survival promise.
4. Stop normally (SIGTERM, bounded drain, successful exit) and verify the exact
   service/socket PID has exited. Quit the old UI and unregister/rebind only
   its own agent as required by SMAppService, preserving user's prior opt-in.
5. Atomically rename the staged app into `/Applications/NikUI.app`; retain the
   previous complete app until the new one proves healthy. The updater is a
   separate short-lived installer outside either app being replaced.
6. Re-register/restart only if the engine was opted in and running before the
   update. Deliberately stopped/unregistered stays so. Validate pins, current
   authority, schema and a new generation before reopening work admission.

A failed pre-replacement drain leaves the old app installed. Failure after
replacement keeps source writers fenced and reports an explicit recovery
state. Returning the previous **binary** is only safe with compatible current
state; never restore pre-update queues/receipts or infer that a missing reply
means work did not run. Recovery must use the durable transition journal.
Keep the update/rollback coordinator and crash-at-each-boundary acceptance as
release gates; round 1 does not implement an installer/updater.

Menu “Stop Engine” is distinct from interrupt and Cmd-Q: show busy/drain
readiness, request the exact service's normal stop, and retain unresolved work.
`KeepAlive={SuccessfulExit:false}` restarts a crash, while deliberate exit 0
stays stopped until Start. Logout/reboot does not guarantee live-turn survival;
restore durable state and visibly reconcile unknowns. App/login preference and
engine registration are independent throughout.

## First-run, cutover and rollback

First launch shows the workspace/setup window, flavour, and existing service
registration status. It does not register/start the engine, enroll a device,
discover/import source databases, request notifications, change routes, adopt
a keeper or configure providers. “Review Cutover…” is available in production;
“Not Now”/closing the review is a complete no-effect path. An engine already
opted into by this user may be observed/reconnected without re-registering it.

The completed review is a native, explicit flow:

1. Select one source install/profile and enumerate every loaded participating
   window through the source-context/private-socket handshake. Display host
   fingerprint, project/device/queue counts, source version and named blockers.
   Do not scrape `state.vscdb`, choose “the latest” profile, or union identities.
2. Explain engine-at-login behavior, independent UI login preference, and
   retained old scope/backup. Offer the explicit **Move to NikUI Engine**
   button only when current preflight evidence is complete. The reviewed
   scope/hash and generation are immutable for that confirmation.
3. That attended click authorizes engine registration. If approval is required,
   show `SERVICE_REQUIRES_APPROVAL` and open Login Items Settings by user action;
   do not bypass it or quiesce sources while waiting for approval. Initially
   start only an inactive management target; it cannot create keys or drain.
4. Freeze source admission, quiesce/flush/export through actual extension
   contexts; make a private backup; import into an inactive production target
   with exact selected identity/grants/receipts and import/hash verification.
   Revalidate all participant acknowledgments under the same owner lock.
5. Commit the next service generation, activate the real production composition,
   acquire exactly released resources, enroll the app locally and verify the
   selected pins. Source windows become clients. Only then show “Engine ready”.

“Return to Editor Engine…” performs fresh current-state handback through the
same generation-fenced coordinator. Show changes/work since cutover, await
safe drain, verify the target source can import current data and receipts,
commit a new window generation, then stop/unregister only NikUI's own agent.
Preserve the source identity, pins and current data. Retire the app's copied
generation credentials after the durable handback is released. An unreachable
service can be exported offline only with exclusive process/endpoint proof;
the pre-cutover backup never substitutes for current receipt authority.

| Named blocker | User-facing remedy / required proof |
| --- | --- |
| `INSTALL_IN_APPLICATIONS_REQUIRED` | Install the verified app in the supported location. |
| `SOURCE_SELECTION_REQUIRED` | Choose the exact source install/profile. |
| `SOURCE_HANDSHAKE_UNAVAILABLE` | Use a build with the production source-context bridge; R1 cannot complete this step. |
| `SOURCE_MANIFEST_INCOMPLETE`, `SOURCE_BUILD_OLD`, `SOURCE_UNRESPONSIVE` | Account for/update/close or reload the named disposable source windows; no guessed inventory. |
| `PENDING_FOLDER_RETURNS` | Open the named folders in VS Code first to finish returning their current work, then review Move again. |
| `CLAUDE_OWNED_BUSY`, `CODEX_OWNED_BUSY`, `BORROWED_CODEX_BUSY`, `PENDING_APPROVAL` | Finish or explicitly resolve the shown work; never terminate an external daemon. |
| `KEEPER_UNAVAILABLE`, `KEEPER_METADATA_INCOMPLETE`, `UNSAFE_OPERATION_PENDING` | Establish exact compatible run ownership/outcome or keep the transition blocked. |
| `KEYCHAIN_LOCKED`, `KEYCHAIN_DENIED`, `KEYCHAIN_CORRUPT`, `IDENTITY_UNAVAILABLE` | Repair/unlock the selected store; no new identity/fallback. |
| `ROUTE_OWNER_MISMATCH`, `POLICY_RELEASE_UNPROVEN` | Reconcile that exact owned resource; leave unrelated machine state untouched. |
| `SERVICE_REQUIRES_APPROVAL`, `SERVICE_UNAVAILABLE` | Complete the system approval or inspect the exact app/job. |
| `SERVICE_OWNERSHIP_REQUIRED`, `CURRENT_STATE_EXPORT_REQUIRED`, `AUTHORITY_UNAVAILABLE` | Rollback requires the current service's generation and complete readable export. |

Preparation, inactive import, owner commit and activation/handback each write
the existing durable transition evidence. Crashes before commit keep sources
fenced until a proved abort; after commit only the new generation may recover.
Cancellation does not undo uncertain effects. Once an ownership transition
has started, the UI keeps a recoverable status view instead of treating
closing a sheet as permission to restore a backup.

Source quiescence also drains the final asynchronous VS Code memento writes
started by manager disposal. It retries follow-up writes within a bounded
five-second settling window before sealing; unresolved/rejected writes still
refuse acknowledgment. Source leases, hashes and generation checks remain
mandatory. The native reload-mid-Move rehearsal must pass through fresh review,
Move, painted transcript and current-state handback; **native: pending Claude run**.

A closed folder's pending return blocks another Move. A generation, phase,
baseline or scope mismatch retains the full payload and receipt and opens the
editor recovery panel before constructing a writer. Successful imports alone
consume their saved work. Workspace files and complete folder sets identify
the return scope; empty windows have no folder payload. Returned keeper
eligibility survives repeated reloads until a listing proves its runs ended,
then both the keeper manifest and its private store are removed.

Never-moved storage writes skip recovery comparisons before serializing values.
An idle filesystem watch wakes the private source endpoint for review, and the
review removes its wake request even on failure. If a restricted host denies
filesystem events, an idle private socket replaces polling. Disposable editor
cleanup canonicalizes `ps` start-time/argv proof, SIGTERMs the verified main PID
with the exact disposable user-data directory, and verifies two empty scans.

## R03 core contracts and the native gate

`LocalDeviceEnrollment` signs an engine/generation/SPKI-bound request on the
private control socket. The engine persists the local seat/key binding and
retains its enrollment ledger after revoke/forget. Reconnect checks selected
engine/host/device pins and reuses NikCore's P-256/AES and application v2 paths.
Keychain locked/denied/corrupt, changed pins and revoked identities refuse by
name. No Keychain, SMAppService or GUI action is exercised by portable tests.
The app uses its own exact service in the account-derived file login Keychain,
with the creating signed app's default ACL, following the existing Mac helper
policy. It neither changes the account search list nor unlocks the Keychain.

`NikClient.acquireConversation(_:forView:visibility:)` and
`releaseViewSession(_:)` compute a union of conversation/feature leases.
`DraftSubmission` freezes the window, origin, composition and mid. An in-flight
click holds a lease until its receipt resolves; closing another window cannot
cancel it. The protected outbox persists full plaintext before the first write.
Only an applied matching receipt clears its exact window composition. Views
persist separately by engine/device scope, window token and conversation;
restoration never replays a user click. The existing iPhone API remains the
default view facade.

Mac transcript resources load through an exact bundled-resource allowlist and
CSP with network disabled. The typed bridge accepts only readiness, bounded
reading state and external URLs. Engine controls stay native. Code copy is an
explicit user action and external URLs use NSWorkspace's default browser.
The local-device queue projection includes full payload/attachments, revision,
state and advertised remove/promote actions; other clients keep their existing
queue wire shape. Unknown outcomes remain visible and are never retried by the
inspector.

`scripts/test-mac-app.sh --native --e2e` builds a fresh signed development app
and engine in a private test HOME with P2 fixture providers. Its sealed
acceptance configuration and nonce-bound private request enable the native
model driver. The gate opens both providers, enrolls, sends, observes streaming
actually painted by WKWebView, answers an approval (and refuses a duplicate),
queues and interrupts. Engine control receipts/effect counts prove each step.
It then quits the exact app, verifies its engine remains alive, and removes
only its own registration/test Keychain items. Evidence:
`/tmp/nik-mac/p3/r05-native-app.json` for the repaired R05 gate (the failed R03
run is retained unchanged). It now checks private image-draft round trips and
find results from the actual WebView. Every wait samples connection/problem,
fleet/Codex IDs, last error and conversation/render state into private evidence;
outer harness timeouts retain the latest sample and fixture engine state.
**native: pending Claude run**.
This gate never installs, registers or activates production.

The large G0 performance fixture, attended selection/accessibility/IME checks,
the rest of the desktop keyboard map, provider creation controls and the remaining production integration/cutover/update
remain later rounds.

## Remaining P3 rounds and acceptance

The approximate next slices are G0/transcript + NikCore view sessions/local
device enrollment; projects/providers/composer/durable window drafts; approvals,
queue/find/editor/notification/settings parity; then production source
composition/cutover/handback, install/update and attended polish. Adjust the
slice boundaries after each Claude review; keep the gates explicit.

Every round runs full npm, NikCore and Mac Swift tests with counts. Round 1
also runs Swift identity tests compiled both ways and JS tests trapping any
selected-root/Keychain effect before a refused production configuration.
Both signed products must pass signature/target/resource inspection. Preserve
`scripts/test-mac-engine.sh --regressions --menubar` and
`scripts/acceptance-p2.sh --native --editor` on the new dev app ID and the same
dev engine label; their native runs remain Claude's task outside the sandbox.

Read-only artifact inspection is available as
`node scripts/verify-mac-app.js prod '/tmp/nik-mac/build/p3/NikUI.app'` (and the
equivalent `dev` path). `scripts/test-mac-app.sh --native` is **native: pending
Claude run**: with both built default products and no pre-existing jobs/profile,
it checks compiled identities despite a test HOME, foreign helper namespace
refusals before SecItem, production CLI registration refusal, GUI first launch
without agent registration/profile creation, then exact-app quit/cleanup.
It never installs a production app or invokes production cutover. This process
probe does not replace attended inspection of window appearance/accessibility.

Native first-run/SMAppService/SecItem, app/agent login independence, relocation,
active-work replacement, real production source import/rollback, physical phone
deduplication, G0 accessibility/IME, sleep/wake/logout and light/dark keyboard
polish require recorded Claude/attended evidence. Building/signing alone is
not a pass for those gates. No test in this round authorizes production
installation, registration or cutover.

R1 evidence is retained at `/tmp/nik-mac/p3/r01-*`: full npm **6,907/6,907**,
NikCore **150 tests / 14 suites** with loopback, and Mac **32 tests / 3 suites**
under **each** compiler flag (22 menu + 10 identity). The 44 JS flavour checks
are included in npm. Portable P2 acceptance passed **12/12** scenarios.
Both final products are **0.3.0 (1)**, team-signed with hardened runtime;
inspection verified 190 production and 193 dev manifest hashes plus all 6/7
binaries' signatures/architecture/minimum OS/entitlements. A second production
build matched 212 source inputs, 185 plain resources and all six executable
payloads after removing signatures **only from temporary comparison copies**.
CMS envelopes differed as expected. Native app/agent/Keychain checks above
remain **native: pending Claude run**, including re-running the adapted P2
native driver. No production installation/registration/cutover was performed.
