# R08 cross-review and validation evidence

2026-11-20, Codex. Repository: NikUI-mac, base `132b3c5d5723598699e4ae09176699bfcc4f26f6` plus the uncommitted R06–R08 worktree. Reviewed every engine document and `spike-app` source, the entire shared fixture corpus/schema/readers, and the P1-02 config/manager/keeper-default/runner changes. Read R07's handoff first. No live user NikUI/keeper/Claude/Codex process or installed service was controlled; no production import, Keychain write, route/power change or browser launch was performed.

Concurrent requester-plumbing changes in `src/hub.js`, `src/panel.js`, `src/codex.js` and `test/hubRequester.test.js` were preserved. The final full runner includes those seven requester checks. They add internal origin plumbing, not service enrollment/provider routing or a headless host; those full gates remain pending. R08 does not claim authorship or completion of that separate work.

## Resolved discrepancies

| Finding | Resolution / evidence |
| --- | --- |
| A plain config source lost shipped snippets/status defaults; defaults could drift from the manifest. | [`config.js`](../../src/config.js) uses manifest defaults and fresh object/array copies; missing/throwing inspect still retains shipped snippets. Explicit empty-string disabling and source-provided defaults remain. [`engineConfig.test.js`](../../test/engineConfig.test.js) covers independent/fresh injected reads with `vscode` poisoned in a clean child. |
| Runner trusted an inherited keeper root, which could name a live keeper. | [`test/run.js`](../../test/run.js) always allocates a fresh private root before requiring suites; child regression verifies an inherited sentinel is replaced and default links use that root. The production `defaultDir()` override remains intact. |
| Full Node tests aborted on asynchronous `fs.watch` EMFILE, which the synchronous try/catch did not catch. | [`watchInbox`](../../src/extension.js) handles both failure paths with a 200ms nonpersistent stat poll of only its own file; disposal removes the poll. [`inbox.test.js`](../../test/inbox.test.js) proves renamed-click delivery, consumption, other-inbox exclusion and disposal for both failure paths. No new skips or weakened assertions were introduced. |
| Successful APNs vectors supplied invalid nonhex tokens; stored images used data URLs without media types. | Success traces now use synthetic valid hex tokens and complete raw-base64 PNG descriptors. Both readers check them; malformed cases pin rejection. |
| ClearQueue reported two removals from one item; editQueued returned bytes absent from the initial queue. | Fixtures seed both removed entries and the complete original draft. Both readers check removal count and exact reclaimed fields, including attachments. |
| Swift String equality could equate changed composed/decomposed draft/result text. | Swift comparisons now use canonical UTF-8 bytes; a shared malformed Unicode-drift case must fail in both readers. Complete Unicode-key/number canonicalization remains a later runtime gate. |
| Pane results were incomplete; local Slack link invented a v1 reply; duplicate-ready snapshot evidence was implicit. | Results now retain the normalized pane shape and the actual local link destination without a new reply. The ready trace specifies two fresh inits in expected state; selected receipt replies are explicitly distinguished from complete snapshot streams. |
| Capacity/revocation, known-project/lid/terminal states were missing; legacy `@listen` incorrectly had zero effects. | Added explicit scenario state and restored v1 listener rotation/reply when negotiation pins v1. Some inputs remain descriptive scenario data; they are not an executable provider model. |
| Both schema readers silently ignored schema-valued additionalProperties; client-outbox server inputs were only generic messages. | Implemented additional-property value validation and schema checks for server ack/operation inputs in both readers. Independent positive/negative schema tests run in Node/Swift. |
| UTF-8 error/turn byte limits and credential-free results were not checked. | Both readers enforce them; the shared malformed corpus grew from 18 to **30** cases. Selected capability names are ASCII-checked too. Production schema/number/escaping boundaries remain P1-13/P1-22 gates. |
| Protocol §5 still called a journal optional after D20 selected JSONL. | Protocol/architecture/decisions now agree on serialized JSONL authority plus compaction; logical state shape is distinct from physical record format. Framing, crash recovery and physical bounds remain P1-12 work. |
| P1-02 was described as wholly future/complete in different places. | Docs distinguish the implemented seam/mapping from P1-03 caller/wrapper migration and P1-10 service/project enforcement. Manager-only import evidence does not pass the daemon graph or full T02/T06. |
| `remote.autoStart`'s contributed help said off by default while its real default is true. | Corrected only the help text in package.json; preserved the default, opt-outs and restoration behavior. |
| Blanket remote-policy refusal contradicted existing phone permissions/power settings. | [58-key mapping](config-mapping.md) preserves current curated control actions while excluding project/generic remote executable, enrollment, exposure and account-policy changes. 32 engine settings, 22 local machine policies, 4 editor-only keys; zero contributed secret values. |
| Inventories looked current after source line shifts; Mac client availability was implicit. | Inventories retain their stated baseline anchors and add R08 deltas. Capability matrix explicitly marks every Mac desktop row unavailable today. Corrected the Commands descriptions reader/writer entry. |
| Probe evidence overstated service Keychain access, relocation, tool access and minimum OS. | S2/S5 historical assumptions are removed from active guidance; [signed-probe limits](#signed-probe-review) below are recorded in spikes/test-plan/gates. R02 is explicitly historical. |

## Measured tests

Host: macOS **27.2.1 / 26B131**, arm64; Node **v26.7.0**; Apple Swift **6.4** (`swiftlang-6.4.0.34.1`, clang `2100.3.34.1`). Commands ran from the NikUI-mac root. Swift build/module caches were under `/tmp/nik-mac/p0/r08-*`; `--disable-sandbox` disables SwiftPM's nested build sandbox, not the tool's workspace restrictions.

| Command / scope | Exit / result | Evidence |
| --- | --- | --- |
| `npm test` — full runner after all code/fixture changes | **0; 3,627/3,627 checks** | [Run output](/tmp/nik-mac/p0/r08-npm-test.log), [runner](../../test/run.js) |
| `node test/run.js engine-protocol-v2` | **0; 225/225 checks** | [Run output](/tmp/nik-mac/p0/r08-node-fixtures.log), [test](../../test/engine-protocol-v2.test.js) |
| `node test/run.js engineConfig` | **0; 10/10 checks** (also in full run) | [Test](../../test/engineConfig.test.js) |
| `node test/run.js inbox` | **0; 7/7 checks** (also in full run) | [Test](../../test/inbox.test.js) |
| `NIKCORE_LOOPBACK_TESTS=1 … swift test --disable-sandbox --package-path app/iphone/NikCore --scratch-path /tmp/nik-mac/p0/r08-nikcore-build --cache-path /tmp/nik-mac/p0/r08-swift-cache` | **0; 121 tests / 12 suites**, zero skipped tests; real URLSession pairing/upgrade test explicitly ran and passed | [Run output](/tmp/nik-mac/p0/r08-nikcore-test.log), [fixture reader](../../app/iphone/NikCore/Tests/NikCoreTests/ProtocolV2FixtureTests.swift), [loopback test](../../app/iphone/NikCore/Tests/NikCoreTests/NodeIntegrationTests.swift) |
| Static mapping equality against contribution keys | **58/58**, no missing/duplicate/extra rows; every local/editor row says project No | [Mapping](config-mapping.md), [manifest](../../package.json) |

Swift's omitted environment prefix above was `CLANG_MODULE_CACHE_PATH=/tmp/nik-mac/p0/r08-clang-cache SWIFTPM_MODULECACHE_OVERRIDE=/tmp/nik-mac/p0/r08-swift-module-cache`. The complete invocation and exit are also captured in the round handoff. Temporary logs are supporting artifacts; this checked-in summary preserves the result if they expire. No v2 dispatcher/client/runtime conformance is inferred: both readers consume the same **179** traces in **8** areas, **14** hash vectors, **28** malformed cases and **54** indexed mutation branches.

The first full runs failed before a final count on native watcher EMFILE; raising/changing the file limit did not resolve it, and an isolated watch probe reproduced it. The production inbox error recovery above fixed that failure; the final full pass is not a filtered or preloaded run.

Node retains the existing voice-helper/model availability check labeled `skipped: not built here, or no model`; no real transcription acceptance is claimed. That independent resource gate remains P2/T67. NikCore's loopback test was enabled, so its 121-test result has no corresponding socket skip.

## Signed probe review

Claude's S1/S6 observations, confirmed in R05/R07, are the runtime evidence: minimal launchd environment; signed bundled Node probe; register → enabled, crash relaunch, deliberate SIGTERM/exit 0 staying stopped, unregister; signed controller SecItem add/read/delete. R08 did **not** repeat those service/Keychain operations. Source: [spikes.md](spikes.md), [controller](spike-app/main.swift), [launcher](spike-app/launch.swift), [JS probe](spike-app/main.js), [launch plist](spike-app/com.nikui.spike.engine.plist).

R08 independently read the saved `/tmp/nik-mac/spikes/app/NikSpike.app` and Node download:

- Saved official darwin-arm64 v26.7.0 tarball SHA-256 **`7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4`** matches its saved `SHASUMS256.txt` entry. This verifies consistency with that saved manifest; R08 did not reacquire upstream release/signature evidence.
- `codesign --verify --deep --strict --verbose=2` exited **0**, valid on disk and satisfying its designated requirement ([output](/tmp/nik-mac/p0/r08-spike-signature-check.log)). Both controller and Node report Apple Development / TeamIdentifier **KBA6653B4V** and hardened runtime. Node CDHash **a47dc4be6ee3277ee460759fd8442761fa1488d3**; app CDHash **e3545479707149eb6f5afe1872b8599a9c1f6399**.
- Displayed Node entitlements contain only `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`. This does not prove both are required. `otool -L` lists only system CoreFoundation, Security, libc++ and libSystem.
- Controller `LC_BUILD_VERSION` says **minos 27.2**, while [Info.plist](spike-app/Info.plist) declares **14.0**. Record the mismatch; older-OS and final-package deployment are **pending P2/T63**.
- The SecItem operations are in the signed controller, not Node's launchd path. Same-identity bundled-helper access, non-destructive update/failure handling, arbitrary UTF-8 and locked/denied access are **pending P2/T66**.
- Probe JS unlinks an existing socket and uses a fixed home path, while the CLI's `kc-set` deletes before adding and prints errors without failing the process. These sources prove feasibility only. Private exclusive startup is **pending P1-10**; production secrets/controller behavior is **pending P2/T64/T66**. No probe-source behavior is accepted as production ownership policy.

The [P0 checklist](p0-gate.md) records independent pending P1, P2 and P3-G0 gates. Existing production window mode stays v1/default.
