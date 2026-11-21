# Engine decisions — P0 R08 review

2026-11-20, Codex. D1–D16 retain R02; D17–D26 incorporate R03, with R05's keeper/activation clarifications and D27 below. These are design agreements, not implemented/passed behavior. [Architecture v2](architecture.md) owns composition; [protocol v2](protocol-v2.md) owns the wire; [test-plan.md](test-plan.md#decision-coverage) maps decisions to tests. Historical evidence: [R02](review-r02.md), `/tmp/nik-mac/p0/r03-claude.md` and `/tmp/nik-mac/p0/r05-claude.md`; their dispositions are recorded here.

## Agreed decisions

### D1. One opt-in engine per macOS user; keep Node and the current engine code

Build a composition root around existing sessions/hubs/services. Window mode remains default until P2 acceptance. No runtime rewrite or unrelated UI redesign during extraction.

### D2. Keep the window path working throughout extraction

Preserve scoped settings, restoration, command behavior, keeper continuity and disposal. Service mode is explicit; an unreachable nikd never starts a fallback engine. Add missing local command bridges before replacing window ownership. Every P1 PR keeps the existing `npm test` suite green.

### D3. Keep an injected host boundary shared by all transports

SessionHub and RemoteServer receive the same composed host/services and authenticated device/audit context. VS Code chrome and editor operations stay in extension adapters. D17 resolves the injection mechanism.

### D4. Retain keeper as the Claude process supervisor

Keep protocol 1 and one live owner per run. Reload continuity requires an available keeper, compatible checkpoint and reattachment within the existing three-minute orphan grace. It is not keeper-crash/reboot durability. D19 bounds adoption and resume.

### D5. Separate Codex process ownership, account identity and thread writer authority

Record canonical resolved CODEX_HOME, transport ownership and the independent owned history reader. Borrow only the app account's external daemon; close our connection without terminating it. Account labels alone are insufficient identity. D22 adds operation outcome as a separate axis.

### D6. Preserve remote security and the selected pinned identity

Keep challenge/authentication, sealing, Host/Origin guards, pairing, device grants and rekey. Import the exact selected host key with matching device/delivery records, VAPID separately. Corrupt/unavailable identity fails closed; never silently regenerate it or merge grants from different host identities.

### D7. Grant new local app/editor authority only through a private control channel

Phone HTTP pairing continues. New local enrollment uses an owned private directory/socket; credentials stay outside page JavaScript. Hello/caps/requester labels confer no authority. D24 sets the one-Mac filesystem boundary; `lsof` is not authentication.

### D8. Separate protocol version, capabilities and authorization

Negotiate application protocol after authentication; `@welcome.version` remains package version. Use capabilities for implemented features and authenticated seats for current authority. Old clients use v1; new clients on old extensions retain no-replay behavior. Exact rules: [protocol §2](protocol-v2.md#2-authentication-advertisement-hello-and-welcome).

### D9. Give mutating intents stable mids and bounded durable receipts

Operation IDs are distinct from entity/correlation IDs. Bind duplicate lookup to principal, scope and immutable request hash, before fresh dispatch. A receipt reports the stated acceptance/effect, not task completion. Pending/unknown and dispatch-before-I/O are required; D20 selects the physical store.

### D10. Bind approval, interrupt, task stop and steering to execution identity

Engine-issued run generation, issuing turn and real pending membership guard controls. Competing answers serialize independently of mid dedupe. Include `/steer`, promote-to-steer, older background tasks and terminal runs; never retarget a delayed action to a new turn. Phone “Stop” remains interrupt, not process stop/remove.

### D11. Preserve unknown provider outcomes; never silently requeue them

Persist stable provider correlation before submitting. Lost replies after possible dispatch retain full input as unknown, freeze the affected lane and reconcile only with exact positive evidence or authoritative non-acceptance. Apply to direct/follower Codex and other ambiguous external writes. Timeout/no history match does not prove rejection.

### D12. Give service-owned authoritative state one writer and awaited commits

Use a separate private root, versioned authoritative envelopes and explicit commit errors. Persist full queued text, expanded/sent text, snippets and attachments before durable acceptance. Provider stores keep their real owners; source window files keep theirs until handoff. Unknown newer/corrupt authority refuses writes; caches may be rebuilt.

### D13. Export migration data through the selected extension contexts

Do not open live VS Code SQLite databases. Export global/workspace mementos, settings with scope, secrets, source identity and relevant files through their APIs. Back up, preserve instance IDs, use import ID/hash and merge duplicate ledger copies by maxima. A repeated import cannot replace newer service work.

### D14. Route editor actions with server-derived requester context

Carry originating provider, resource URI/cwd and supported method per operation, including delayed handoff/fork. Phone navigation remains on the phone. Open URLs in the system default external browser. Machine-policy confirmation requires an attended local client with deadline/cancellation and safe expiry. D21 fixes selection/fallback policy.

### D15. Resolve executables and child environment explicitly

Configured path → known directories → one cached binary lookup; children also need a suitable PATH. Make CODEX_HOME and folder trust explicit instead of inheriting shell functions. Pin a relocatable official Node artifact. Signed minimal-environment/TCC/Keychain behavior needs actual packaged acceptance.

### D16. Test failures and both hosts before service default-on

Use existing legacy tests, simultaneous isolated engines, compatibility fixtures, real disk recovery, ambiguous replies, stale controls, headless routing, mixed keeper owners, migration/rollback and power/notification ownership. Memory-only tests cannot establish launchd or durability behavior. [Phase gates](test-plan.md#phase-gates) separate evidence levels.

### D17. Capture services at createEngine; remove core VS Code imports (resolves O1)

Use `createEngine(services)` with narrow manager/host/hub dependencies; no process-global `platform()`. Make `readConfig(config)` explicit at every caller. A zero-arg compatibility wrapper is permitted only within the extension adapter; panel code receives the reader. Preserve the legacy installed host's manager guard. Poison `vscode` resolution in a clean process while loading/starting the daemon graph, and construct two engines concurrently without global installation.

### D18. Fence the selected writer scope by generation and quiescent export (resolves O2)

In the selected extension globalStorage, `engine-owner.json` contains `{generation,mode:'window'|'service',since,by}`. Windows read before writer creation and watch changes. Cutover freezes new writer admission, awaits every live source window's `quiescent + exported` acknowledgment for the generation, imports into an inactive separate daemon root, then commits generation + 1 / service. Stop all engine-state writes, including Durable, ledger, folders, mementos and deferred flushes, before acknowledging. Old/busy/unresponsive or unaccounted sources block with a named reason; loaded builds do not update merely because the extension path is symlinked.

A source is every window loading the selected extension: initially one symlinked install and one profile. An activation racing cutover reads `engine-owner.json` under the same lock as the generation commit; a mid-commit generation waits at most 5 seconds, then starts as a client or reports a named blocker, never a writer. Initial P2 supports one selected globalStorage/profile scope; other active scopes must be closed or separately fenced. Rollback requires fresh daemon quiescence/export/import plus another generation commit with receipt/outbox restore rules. P1 has test HOME/private state only: no import or tailnet takeover.

### D19. Adopt only transferred/known instances and block duplicate Claude resume (resolves O3's policy)

Attach only runs belonging to transferred instances or the daemon's own ownership manifest. Never bulk-adopt orphans; preserve `owned/elsewhere`. Refuse resume of a Claude conversation known live under another instance ID. P1-11 adds optional keeper `meta:{conversation:claudeSessionId|null,instance:id,cwd}` on spawn and every checkpoint; `Run.describe()` echoes it. Keeper protocol stays 1 and does not parse snapshots. An old keeper or incomplete metadata cannot prove absence: refuse affected resume with a named diagnostic. This closes O11's design dispute; implementation and coverage remain P1-11 tests.

### D20. Use a small append-only JSONL authority with compaction (resolves O4)

Implement protocol-v2 receipt/outbox semantics with one serialized append-only JSONL writer and periodic atomic compaction, not a database. Commit coupled local state/receipt transitions together, fsync before the promised acknowledgment, recover torn tails conservatively and bound both live state and physical log growth. Retain principal/scope/hash, capacity refusal, reservations and unresolved payloads. This supersedes the earlier snapshot option, as recorded in protocol §5; it changes no wire guarantees and makes no external exactly-once claim.

### D21. Origin → matching workspace/resource → focused provider; explicit project union (resolves O5)

An explicitly selected/originating provider disappearing yields unavailable, not rerouting. Otherwise choose an eligible longest URI-root match, then eligible focus. Registration lasts for the connection; no lease service. No Terminal.app insertion automation. Use supported system fallback only. Service projects are the union of provider announcements plus locally saved projects; phones may create only there. P2 explicitly accepts the expanded fleet/project visibility with the selected identity/grants.

### D22. Keep transport, thread-writer and outcome axes independent; one P1 account (resolves O6)

Owned/borrowed transport does not determine engine/external/unknown writer or queued/accepted/unknown operation outcome. Quarantine ambiguous direct and follower writes; do not take writer ownership and retry. Track owned reader disposal separately. P1 selects one account through `codexAccount` and records its canonical home. Namespace session/thread/cache keys by resolved account/home before enabling more than one account.

### D23. Use thin adapters, a fixed config mapping and extracted Slack composition (resolves O7)

Preserve window config scope/provenance and shipped snippet merging. Service config uses manifest defaults and explicit user values, with only explicitly imported project overrides allowed by the [58-key mapping](config-mapping.md); local machine/security policy stays outside project control. Preserve existing curated phone actions, including permissions and previously approved power toggles; this is not a generic remote configuration API. Do not require a generic storage/schema/watcher/confirmation framework. Extract Slack service, socket, credentials/change listeners and disposal from `slackHome.js`; keep its UI in the extension. Implement only typed UI requests needed by existing features.

### D24. Local signing/private socket now; SecItem before production cutover (resolves O8)

Use owned 0700 directories, 0600 files/socket and refusal of unsafe paths. Native peer checks are optional extra verification. Local Apple Development signing suffices for this Mac's P0–P2 scope; notarization is optional distribution work. Build/sign the Swift SecItem helper with the app and prove access under the service identity before P2. P1 may use a 0600 file-backed secret store only in its private test HOME. No secrets in argv. This supersedes spikes S5's proposed `security -i` production path and S2's unverified entitlement assumptions.

### D25. Generation holder owns power and local notifications (resolves O9)

Exactly one engine writer generation acquires power assertions, lid holders and local notification delivery/click routing. Old owner releases before new owner acquires; preserve conservative defaults and watchdog cleanup of NikUI-owned settings. Last-client disconnect/Cmd-Q, crash/update, manual stop and logout have distinct policies. Codex work deliberately counts toward awake/busy in service mode; include this change in P2 release notes. Do not silently expand Codex CI/ledger/notification policy from that decision. P1 uses fakes, with real machine acceptance before P2.

### D26. Typed local management is a P2 cutover gate (resolves O10)

Before disabling the extension manager, provide typed local-authorized rename, process stop/restart/remove, folder CRUD/order and guarded history delete. Preserve all other existing local command paths (including device grant/rename, pairing/network control, scoped settings, restart-all/resume-now and clear-stopped) through adapters or equally authorized bridges. Folder order is an explicit new action; client-local instance ordering stays client-owned. Do not grant phones new administration rights; existing equivalent phone actions retain their existing grants. Define the additional request/result contracts and tests before P2 implementation, not by inventing v2 names in P1.

### D27. Defer transcript feasibility to P3-G0 (R05)

Owner: Claude + Codex. T73's native/WKWebView comparison is the first P3 gate, **P3-G0**, before any Mac transcript UI work. P0–P2 build the engine and ship no Mac transcript UI; rendering feasibility does not block those phases. This is an explicit gate deferral, not passed feasibility evidence.

### D28. File-based login Keychain, signed-helper ACL and service prefix (P2 R04)

Owner: Claude; implemented by Codex in P2 round 3. Use SecItem against the
file-based **login** Keychain, with neither `kSecUseDataProtectionKeychain` nor
`kSecAttrAccessGroup`, and no `keychain-access-groups` entitlement or provisioning
profile requirement. Every operation selects the exact service/account and the
login Keychain alone. The signed helper fixes the accepted service prefix;
tests use only `com.nikui.engine.test.<random>` and remove every attempted item
in `finally`. The default ACL trusts the creating signed helper; never replace
it with an all-apps ACL. TEST HOME does not change which login Keychain is used.

Request `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; retry only an
unsupported-attribute error with `AfterFirstUnlock`. Record the accepted write
attribute and the attributes actually returned on read. The file-based shim
may omit accessibility; this is reported explicitly and must not be described
as an iOS/Data Protection protection-class guarantee. The login Keychain's lock
and signed-helper ACL enforce access. Missing, denied, locked and corrupt reads
still refuse without cached/file/alternate-profile fallback or key regeneration.

Retain the same signing identity and bundle identifier across helper upgrades
so its designated requirement remains valid for existing ACLs. Test a separate
rebuild reading an existing test item, alongside real add/read/update/delete.
A changed designated requirement may cause macOS to prompt in an attended app;
this helper disables interaction in its own process and returns a refusal
instead. Never unlock/lock the user's Keychain or change its access settings.
Data Protection plus an access group remains an optional later distribution
enhancement when an appropriate provisioning profile/Developer ID is available.
See Apple's [Mac Keychain implementation notes](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains).

## Dispositions

O1–O10 are closed by D17–D26. No architectural policy dispute remains.

### O11. Closed — additive keeper metadata (R05)

Today's `Run.describe()` exposes only `runId,key,pid,owned,exit` (`src/keeper.js:230`); local-link checkpoints cannot prove another owner's conversation absent. D19 selects additive metadata under protocol 1, with conservative refusal for old/missing metadata. Test IDs learned after init, checkpoint updates, another owner, old keeper and unavailable metadata in P1-11/T32–T33/T54. Do not replace or stop a live old keeper to obtain this capability.
