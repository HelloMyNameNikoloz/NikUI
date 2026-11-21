# NikUI engine architecture v2

P0 R08 review, 2026-11-20, Codex. Design contract; nikd and the service bridge are not implemented by this document. Incorporates [D1–D27](decisions.md) and R05's dispositions. [Protocol v2](protocol-v2.md) owns wire shapes, receipts, run preconditions and compatibility; this document owns composition, resource ownership and phase boundaries. The inventories label their baseline and R08 deltas; [R02](review-r02.md) is historical and [spikes](spikes.md) records limited feasibility evidence. The [P0 gate](p0-gate.md) separates passed evidence from later acceptance.

## 1. Scope and phases

One opt-in Node engine per macOS user owns NikUI services; editor, browser, phone and eventual Mac app are clients. Reuse the existing sessions, hubs, keeper and transports. Window mode remains the default through P1 and until P2 acceptance passes.

| Phase | Deliverable / boundary |
| --- | --- |
| P0 | Contracts, shared conformance fixtures and recorded feasibility evidence. No production migration. |
| P1 | `createEngine(services)`, daemon adapters, current remote surface plus v2 reliability, headless diagnostics and a development extension client/editor bridge. One resolved `codexAccount`; private test HOME, state, keeper, port and synthetic credentials. No production import, tailnet takeover or real power/notification side effects. |
| P2 | Signed local package, Keychain, local-command parity, generation-fenced import/handback, exact network ownership, menu-bar status/start/stop/logs and tested update/rollback. Service remains opt-in until these gates pass. |
| P3+ | Daily-use desktop UI, later multi-window polish/PTY/updater delivery. D27 defers transcript feasibility/T73 to P3-G0, owned by Claude + Codex, before any Mac transcript UI work. |

P1 is ordered in [p1-breakdown.md](p1-breakdown.md); acceptance and phase gates are in [test-plan.md](test-plan.md). Extraction does not add a generic RPC framework, event replay, a database or a new runtime.

## 2. Composition and host boundary

`createEngine(services)` captures dependencies for its lifetime. Manager, host and hub receive narrow subsets; there is no installed global `platform()`. Two engines with different roots/configuration must coexist in one process without replacing globals. Mutable registries, caches and disposables belong to their engine.

Proposed entry points (names are implementation targets): `src/engine.js`, `src/nikd.js`, `src/platform/vscode.js`, `src/platform/daemon.js`. Keep VS Code imports out of the daemon's entire loaded graph, including transitive imports. A clean child-process import test poisons `vscode` resolution; the cached test stub cannot establish this property.

| Boundary | Window adapter | Daemon adapter |
| --- | --- | --- |
| Configuration | Existing `get/inspect/update` and scope selection, shipped snippet merging, change events | [Fixed mapping of all 58 contributions](config-mapping.md); defaults → explicit user values → explicitly imported allowed project overrides. Executable, secret, network and machine policy remain owner-controlled; existing curated phone switches retain their grants. No generic schema interpreter/file watcher prerequisite. |
| Stores | Separate global/workspace mementos and Durable/ledger provenance, retaining today's behavior | Private versioned authoritative engine state; distinguish source workspace/place identity. Rebuild incompatible derived caches. |
| Secrets | SecretStorage `get/store/delete/onDidChange`, with disposal | P1 private 0600 file in test HOME only; before P2 use the bundled Swift SecItem helper. No credentials in argv, logs or ordinary settings. |
| Machine services | Existing implementations injected into the host | Same implementations with explicit paths, executables and owned lifetimes |
| Editor/UI | This extension's registered provider and chrome | Provider router, system URL opener, and bounded typed local requests; unavailable is explicit |

Change `readConfig()` to `readConfig(config)` and update all callers. P1 round 1 moves the zero-argument wrapper into `editorHost.js`; activation injects the manager's source, and panels receive their host's reader. `machineHost.js` accepts settings, services, UI and environment facts without an editor import; `editorRoute.js` selects a provider from trusted origin, longest URI-root coverage, then focus. A directly injected legacy window provider stays explicitly bound to that window. Registries are connection snapshots; their network registration remains P1-23. The fresh-process machine-host/manager poison check does not pass the full daemon graph gate. Keep `installHost/theHost/forgetHost` only as the legacy extension convenience, including the manager-identity guard; core engine construction never depends on installation.

The composition root starts/stops engine services currently assembled in `extension.js` and `slackHome.js`: manager, Codex workspace/reader, history, folders, ledger, devices/identity, push/APNs, Slack service/socket/secret listeners, PR/CI, remote server, terminal blocks, voice, power and notifications. Tree/panel/settings/pairing chrome and command registration stay in the extension. Move Slack service construction out of its webview module. Optional services advertise capabilities only after their real handlers exist.

## 3. Process and resource ownership

In the packaged service, launchd manages bundled Node running nikd. A private control socket arbitrates the engine root; a second manual instance refuses to start. An existing or unresponsive endpoint is not permission to unlink a live socket or take its resources. P1 uses isolated roots and no installed LaunchAgent.

| Resource | Owner / rule |
| --- | --- |
| NikUI authoritative files, receipt/outbox writer, server, service timers | Current engine generation; one writer in service mode |
| Claude children | Existing per-user keeper, protocol 1. nikd owns only its links and transferred/new instance runs. |
| Codex app-server and independent history reader started by nikd | Owned resources, recorded separately; bounded drain policy |
| External app-account Codex daemon/IPC | Borrowed; closing our connections never terminates the external process |
| Claude transcripts, Codex homes/credentials | Provider-owned, left in place; never cloned into engine state |
| Tailscale route | External daemon owns configuration; NikUI records the exact route it is authorized to change |
| Client drafts, selection, scroll, lock and private signing key | Client-owned; not one shared engine draft |

Keeper attaches only eligible instances listed in a current handoff or this daemon's saved ownership. Never bulk-adopt orphans, steal an `owned/elsewhere` run or spawn after an uncertain ownership lookup. D19/O11 select optional `meta:{conversation:claudeSessionId|null,instance:id,cwd}` sent on spawn/every checkpoint and echoed by `Run.describe()`, still keeper protocol 1, without snapshot parsing. A known live conversation rejects resume under any instance ID; old/missing/incomplete metadata refuses affected resume with a named diagnostic. Preserve the legacy fallback separately.

Keeper continuity requires a compatible checkpoint, available keeper and reattachment inside its three-minute orphan grace. Keeper RAM does not survive keeper loss/reboot. Codex has independent transport ownership, thread writer authority and operation outcome; one axis cannot stand in for another. P1 uses one resolved home; account/home namespacing is required before enabling multiple accounts.

## 4. Trust, clients and editor routing

Keep existing Host/Origin checks, pairing, sealing, grants, rekey and pinned host proof. Existing phone pairing stays on HTTP; new local app/extension enrollment occurs only through the owned 0700 control directory and 0600 socket. Refuse symlink/foreign-owned authoritative paths. This is the one-Mac same-UID boundary; native peer checks are optional additional verification, and `lsof` is never authentication. Store extension credentials in its host, outside page JavaScript. Derive principal/local/editor authority from authenticated enrollment, never hello labels, capabilities or supplied requester fields.

Providers register connection-bound IDs, supported methods, workspace URIs and focus state. Routing uses trusted per-operation origin, preserving scheme/authority, cwd and line selection:

1. Exact originating/explicitly selected provider, if eligible. Its disconnection returns unavailable; do not redirect an already selected action.
2. Otherwise the eligible provider with the longest matching workspace/resource URI root.
3. Otherwise the focused eligible provider.
4. Otherwise an equivalent supported system fallback: system default external browser for URLs, or explicit Finder/system reveal. Terminal insertion requires a provider and returns `EDITOR_UNAVAILABLE` without one; no Terminal.app typing automation or hard-coded editor application.

Phone `switch` navigates that phone. Carry origin through delayed forks/handoffs; do not use a mutable `lastSender`. Focus alone does not establish attendance. Machine-policy confirmations require an attended enrolled local client, a correlated response, deadline/cancellation and revalidation before effect. Without one, quota work stays queued and lid setup is refused. A phone request must not raise an unsolicited laptop modal.

Service projects are the explicit union of provider announcements and projects saved by the local owner. Phone creation is limited to that set. Fleet/project aggregation expands visibility compared with separate windows and requires the P2 scope choice with the selected identity/grants; do not union unrelated profiles' grants.

## 5. State, durability and secrets

Use a separate root, eventually `~/Library/Application Support/NikUI/engine/`; never use a source window's live Durable/ledger files as daemon backing stores. P1 requires an explicit `--root` and private temporary HOME, synthetic provider homes and keeper socket. Entry is `src/nikd.js`; `nikctl` comes in P2. Version authoritative metadata, queues, receipt/outbox and import receipts; newer/corrupt/unreadable authority refuses admission without resetting identity or dedupe state.

R03/D20 selects one append-only JSONL receipt/outbox log with periodic compaction, also recorded in [protocol §5](protocol-v2.md#5-receipt-store-persistence-and-crash-ordering). Keep one serialized writer; co-commit each authoritative transition and its receipt in a validated commit record. Acknowledgment follows the promised fsync boundary; compaction uses fsync + atomic rename + directory fsync and preserves all live receipts, reservations and unresolved payloads. Define torn-tail recovery and physical log bounds in P1-12; an invalid interior record fails closed. Those remain implementation gates, not evidence supplied by fixture parsing.

Full text, expanded/sent text, snippets and attachment bytes enter the authoritative outbox before durable send acceptance. Existing slim mementos are mirrors only. Restore recovery barriers before timers, providers or queue drain start. Persist dispatch state before external I/O; uncertainty retains its payload/correlation and blocks automatic redispatch. Wire limits, hashes, receipt outcomes, expiry, scope changes and run/turn controls are defined only in [protocol v2](protocol-v2.md).

Before production cutover import the exact chosen host identity with matching device keys/grants/delivery records, and VAPID separately. Preserve APNs key references without bundling private keys. Keychain locked/denied/corrupt reads do not generate replacement identities; expose the unavailable state and refuse affected remote service. Secret changes rebuild dependent services and dispose old listeners.

## 6. Writer generation, cutover and handback

`engine-owner.json` in the selected extension globalStorage root is `{generation, mode:'window'|'service', since, by}`. In window mode the generation describes legacy ownership of that scope; it does not retroactively fix today's concurrent window-file writes. In service mode nikd holds the writer generation. A mode preference requests a transition; it is not independent authority to write.

All upgraded windows read the record before constructing a writer and watch it thereafter. Production transition uses a control-socket admission barrier: freeze writer starts, quiesce every source, await all deferred writes/timers/listeners, and collect `quiescent + exported` acknowledgments for the generation. Sources are every window loading this extension (initially one symlinked install, one profile). A racing activation reads under the same lock as the cutover commit; if mid-commit it waits at most 5 seconds, then starts as a client or reports a named blocker. Watching alone is insufficient. An old, busy, unknown or disconnected source blocks cutover; a shared symlink does not upgrade loaded code.

Initial P2 cutover supports one explicitly selected globalStorage/profile scope and all its live windows. Other live engine scopes must be closed or separately fenced before joining the service; one root's owner file cannot fence another profile. Require a complete source manifest before proceeding; if completeness cannot be established, use a controlled all-source-windows reload/closure procedure. Do not claim cross-profile atomic migration.

Transition sequence:

1. Verify source manifest/builds/generation, quiesce and flush, then make a private backup and extension-pushed export through the actual contexts. Never read live `state.vscdb` directly.
2. Export settings and scope provenance, global/workspace values, full queues, IDs, folders/order/by-conversation assignments, names, pause/limits/override, ledger and matching secrets/delivery data. Validate conflicts; merge duplicate ledger copies by instance maxima, never sums.
3. Idempotently import into an inactive daemon root with source/import ID and hash. Verify identity, counts, payload hashes and keeper eligibility. No imported work drains before commit. Repeating import cannot overwrite newer service work.
4. Atomically commit generation + 1 / service only after all acknowledgments remain valid; windows become clients and stop every engine-state writer. Start service effects under that generation, then release the admission barrier.
5. Rollback requires the live daemon to quiesce and export current state back, source import verification, and another generation commit to window. Preserve receipts/outbox or change scope and quarantine unresolved work under protocol restore rules. A stale backup cannot establish which work already executed.

Crashes before commit leave imports inactive and sources quiescent until the coordinator proves abort is safe. Crashes after commit recover service ownership; windows stay clients. Unreachable nikd never triggers a second engine or stale-backup fallback. [The migration tests](test-plan.md#cutover-and-service-ownership) must prove startup races and recovery at each boundary before P2.

## 7. Lifecycle, machine policy and exposure

| Event | Required behavior |
| --- | --- |
| Last client disconnects / Mac app Cmd-Q | Engine continues; no engine drain. Client UI cleanup does not dispose engine services. |
| Planned restart/update | Reject new turns, wait a bounded interval for owned Codex/terminal/external writes to settle; refuse planned replacement if they remain unsafe. Release eligible Claude checkpoints only when timely reattachment is possible. No keeper-survival claim for Codex. |
| Engine crash | Recover receipts/barriers first, quarantine ambiguous dispatch, then reattach only eligible keeper runs and reconcile providers. No blind resend. |
| Manual Stop Engine | Bounded drain releases only owned exposure/power resources and reports unpreserved work. S6 proved that `KeepAlive={SuccessfulExit:false}` plus deliberate exit 0 stays stopped; the P2 controller must preserve that policy and provide explicit Start. |
| Sleep/wake/reconnect | Revalidate connections, provider state, tools/quota and owned route before effects; stale controls stay stale. |
| Logout/reboot | Best-effort bounded shutdown; no promise of keeper/live-turn survival. Restore durable work and show unresolved outcomes on next start. |

Exactly one power and local notification owner follows the engine writer generation. During handoff the old owner releases before the new acquires. Keep awake/lid defaults conservative, preserve prior machine-policy ownership and watchdog removal, and route notification clicks through current instance/provider identities rather than an old window inbox. A closed client does not revoke explicitly configured service power policy. Codex busy work deliberately joins awake/busy aggregation in service mode; document this behavior in P2 release notes. Codex CI/ledger/notification expansion is not implied by that change; preserve existing policy/audiences unless explicitly added and tested.

P1 uses fake power/notification/network adapters. P2 records the exact Tailscale route and checks it still matches before replacement/removal; unrelated routes are untouched. Public cloudflared exposure remains explicit opt-in with recorded child ownership. Preserve source exposure opt-outs during import.

## 8. Packaging and gates

For this Mac use local Apple Development signing. Developer ID distribution/notarization are optional beyond P0–P2. Bundle a pinned official darwin Node artifact with version/architecture/checksum and actual resources/dependencies; prove relocation and required entitlements with the signed bundle, rather than infer them from Homebrew Node. `SMAppService` registration, approval-required/disabled states, login, crash restart and intentional stop need recorded evidence.

Tool resolution is configured absolute executable → known directories → one cached binary lookup. Build a suitable child PATH; make resolved CODEX_HOME and folder trust explicit, including a fresh-project diagnostic. Launchd does not inherit editor TCC permissions. SecItem helper is built/signed with the app, communicates secrets through private stdin/stdout, and must pass same-identity and locked/denied access checks before P2.

Typed local commands for rename, process stop/restart/remove, folder CRUD/order and history delete are a P2 gate, alongside existing device/pairing/network/settings command parity. Server-held local authority gates these; adding a bridge does not grant phones new administration rights. Folder order is a deliberate addition to today's capability matrix. Menu UI, production handoff and packaged machine behavior must pass their own gates; green unit tests alone do not authorize default-on.
