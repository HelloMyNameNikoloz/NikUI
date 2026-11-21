# P2 round 1: local management and synthetic ownership

Production activation is disabled. The default window activation and the phone
wire/grants are unchanged. The round-1 ownership/import adapters require an explicit
private test root and `testOnly:true`; they cannot select editor globalStorage,
the user's HOME, keeper, Codex daemon, Keychain, routes or LaunchAgents.

## Local contract (version 1)

`src/localManagementProtocol.js` defines request and result schemas before the
handlers. Requests are `{type:'local:request',version:1,id,generation,op,args}`;
IDs are 128-bit hex and results echo the ID, operation and observed generation.
Unknown versions/fields/types refuse. Outcomes distinguish applied, refused,
unavailable and unknown. Local requests are accepted only on the authenticated
owner-only development socket, using its enrolled principal, never a claimed
seat in a payload or a network watch/control connection. A generation change or
closed admission refuses before effects. Results never reflect raw exceptions.
The published [request schema](schemas/local-request-v1.json) and
[result schema](schemas/local-result-v1.json) have operation-specific payloads
and are compared with the runtime contract by the integration suite. Mutating
local intents reserve a durable ID/hash before effects; duplicate pending work
returns unknown, and a different payload under the same ID refuses. The test
adapter bounds retained local receipts at 512 and refuses capacity exhaustion.
Read queries do not consume that mutation budget.

Commands cover instance/Claude and Codex rename, Claude process stop, restart
with context/fresh/all and current project settings, manual quota resume,
remove/clear-stopped retaining disk transcripts, client-local selection,
folder CRUD/place and an exact deliberate order permutation. History supplies
scope/filter/paging/resume and deletion by conversation identity, with complete
owner evidence and active/out-of-root/symlink refusals. Saved projects require
local approval and profile/workspace/raw-scope provenance; phone input adds no
directories. Settings expose defaults, explicit values, effective values and
source provenance for user/project/editor scopes. Machine keys cannot enter
project scope. Editor-only values stay client-owned. The development extension
uses these commands for supported session/folder/history/device actions and
restores its own selected panels. Remaining attended/settings/Slack/PR chrome
uses a typed bridge and reports unavailable until its provider is implemented.
Deletion also requires an all-owner guard held through a synchronous final
inactive check and unlink; a cached keeper listing alone refuses deletion.
The isolated direct-provider fixture supplies that guard. A keeper-backed
production history adapter still needs the real guard before cutover.

Device rename/grant/revoke/forget and pairing status/window/code/QR are local
bridges. Local enrollment records can be revoked/forgotten without changing the
host pin, VAPID or delivery records of other devices. Network and attended/editor
requests use explicit adapters; missing adapters return named unavailability.
Focus is not attendance; future confirmations must bind request, client,
generation and deadline. No automatic machine setup is implemented here.

## Ownership contract

The selected scope owns `engine-owner.json` with
`{generation,mode:'window'|'service',since,by}`. Its admission lock is also used
for participant registration and generation commit. A durable transition record
holds the coordinator token, exact source inventory/build/profile/root, source
acknowledgments and import receipt. A watcher is advisory; every writer effect
checks its generation/admission lease. A new activation waits at most five
seconds during a transition, then becomes a service client or refuses by name.
Only one selected install/profile/root is supported. Other active scopes need
explicit closed/fenced evidence. An incomplete inventory cannot prove quiescence.

The quiescent export handshake closes admission, cancels deferred work, drains
active work, flushes Durable/ledger/folders/mementos/authority, removes writer
listeners, releases declared owned resources and seals its write gate before
pushing an export through the source context APIs. It acknowledges the
transition token, generation, resource-release evidence and payload hash only
after export completes. An unresponsive drain refuses within five seconds;
late completion cannot acknowledge it. Participant activity invalidates an
earlier acknowledgment even if the participant becomes idle again.
Busy/unknown provider work refuses planned update rather than being
terminated. Old loaded builds, old keeper hello and incomplete live metadata
refuse by name; a symlink to a new install does not upgrade a running window.

Export inventories classify authoritative state and omitted provider/client
stores. Queues carry full payload hashes; accounting merges duplicate copies by
instance maxima, never sums. An inactive importer records import ID/source/hash
and returns its original receipt on repetition; conflicting bytes refuse.
Real SecItem validation and the production context/export adapters are round 2.
The round-1 target is an inert synthetic import store, not a production daemon
importer. A target lease and durable activation reservation precede its injected
activation callback; concurrent start cannot run it twice. The immutable import
evidence is separate from subsequent mutable target state.

## Crash and handback matrix

| Boundary | Recovery contract |
| --- | --- |
| Before barrier | Existing generation owns effects. |
| After barrier / during quiesce / export | No new writer; sources stay fenced until a proved abort. |
| Before/after inactive import | Imported work cannot run; old generation remains fenced. |
| Before owner commit | Revalidate inventory, acknowledgments, import hash and coordinator token. |
| After atomic owner commit / before start | Only committed target generation can recover/start. Sources become clients. |
| During target start / before barrier release | Target owns effects. A completed start is idempotent; a reserved but uncertain activation needs reconciliation and refuses automatic replay. |
| After release | Old coordinator/leases cannot commit or act. |
| Unreachable current owner | Refuse; no fallback, stale backup restore or ownership theft. |

Handback is another transition and generation increment, exporting the live
service's current sessions, queues, unknown/effected operations, IDs and ledger.
Only complete current receipt/outbox authority preserves scope; incomplete
authority changes scope and quarantines unresolved work. A pre-cutover backup is
never current handback. Keeper transfer includes only explicitly released,
compatible transferred runs; no bulk adoption, snapshot ownership inference,
keeper replacement or fallback CLI. Old policy/resources release before the new
generation acquires. Exact route records must still match before change/removal;
foreign routes and borrowed Codex processes are never owned by the transition.
Real route/power/package/controller evidence remains rounds 3–5.

## Route, policy and update ownership design

| Resource | Required ownership proof / handoff |
| --- | --- |
| Tailnet route | Persist exact selected route, destination, port, generation and configuration hash. Re-read and compare before replacement/removal; a changed or foreign route refuses. Never disable an entire port such as 443. |
| Public tunnel | Explicit local opt-in plus recorded child identity and generation; never adopt an unowned child or infer ownership from a listening port. |
| Power/lid/notifications | The old generation's adapters release their exact holders and banners before the export acknowledgment. The target acquires after owner commit. Defaults and pre-existing policy remain conservative. |
| Borrowed Codex | Own the connection only. A busy external turn blocks planned replacement; no external daemon termination or keeper-continuity claim. |
| Planned update | Close new-turn admission, inspect active dispatch/drain/observation, unknown outcomes, owned/borrowed Codex turns and terminal activity; wait boundedly or refuse with a named blocker. |

This round supplies the release-evidence contract and pure readiness/keeper
guards, using fakes only. Exact route mutation, native policy, signed helpers and
managed Stop/Start/relaunch require the later package and machine gates.

## Reproduce round-1 evidence

`node test/run.js engine-owner`, `engine-cutover`, `engine-handoff` and
`engine-management` cover T46/T48–T55. `engine-development` covers the enrolled
editor command mapping and restored panels. Owner/cutover/management fixtures
run in poisoned child processes with private files and synthetic adapters;
the management fixture also uses the actual loopback server and private socket.
The full `npm test` and NikCore `swift test` remain required regression gates.
No synthetic result satisfies real-client, SecItem, package, route or hardware
acceptance in T56–T72.

Round-1 validation: `npm test` **6,551/6,551 checks passed**; NikCore **150 tests
in 14 suites passed**, with the existing opt-in loopback test skipped. Plain
`swift test` failed with `sandbox_apply: Operation not permitted`; the documented
private-cache `swift test --disable-sandbox` workaround passed. Window
entrypoints, shared panel/transport, manifest, phone protocol and mutation-grant
files match their start-of-round SHA-256 values. Logs and the concise handoff
are under `/tmp/nik-mac/p2/r01-*`.

## Round 2: selected Keychain generation implementation

[Keychain and import](keychain-import.md) describes the helper, Node adapter,
selected context export, validation, inactive receipts, atomic owner commit and
fresh handback. The helper is built with `-target arm64-apple-macos14.0`; its
plist agrees. Secret evidence and mutable runtime secrets live in separate
generation accounts; disk manifests retain hashes and redacted payloads. Commit
revalidates the import under the owner lock, which also serializes discard.
A reserved but interrupted start refuses replay until reconciled.

Required R02 fix: the disconnect assertion sampled frame count before unrelated
receipt/operation queries finished. In 240 jittered composed runs it produced
95 false count alarms and zero held-ciphertext leaks. Sampling at the held
boundary plus checking the held ciphertext on every socket fixes the assertion
without retries or sleeps. A bounded 240-case WebCrypto stress variant remains;
the composed end-to-end test passed 20 consecutive runs at 49/49 checks.

At round 2 the real SecItem gate was **unrun** because of the then-selected
Data Protection provisioning requirement. **D28 supersedes that choice**: the
helper now uses the file-based login Keychain, exact signed service prefixes
and the default signed-helper ACL, without an access-group entitlement/profile.
The real test adds/reads/updates/deletes under a fresh random test service and
checks a rebuilt helper against the existing item, with cleanup in `finally`.
See [current Keychain behavior](keychain-import.md) and
[round-3 native-package evidence](mac-engine.md). Synthetic locked/denied/corrupt
cases and generation crash/rollback tests remain separate from native success.
Production activation and source import remain disabled.

Round-2 validation: final `npm test` **6,728/6,728 checks passed**;
`engine-import` **111/111**, `engine-secrets` **60/60**, bounded transport stress
**4/4**, and NikCore **150 tests in 14 suites passed**, with its existing opt-in
loopback test skipped. Plain SwiftPM hit `sandbox_apply: Operation not permitted`;
the documented private-cache `swift test --disable-sandbox` command passed.
The real SecItem success branch remains unrun as stated above. Protected window,
shared transport, manifest and grant files match their start-of-round hashes.
Logs, signature/minimum-OS evidence and the <=20-line handoff are in
`/tmp/nik-mac/p2/r03-*`.
