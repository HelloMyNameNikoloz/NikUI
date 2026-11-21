# NikUI remote protocol v2 — P0 proposal for P1

2026-11-20, Codex, R08 cross-review. Baseline: source 132b3c5d5723598699e4ae09176699bfcc4f26f6 and protocol-today.md. This specifies future behavior, not implemented capabilities. It extends the current two socket roles, message names and event models; it does not replace framing, authentication, provider protocols or the UI. Shared fixture consistency and outstanding runtime gates are recorded in [p0-gate.md](p0-gate.md).

R19 implementation status: the complete isolated daemon now enables v2; ordinary windows remain v1. The [P1 exit report](p1-exit.md) records runtime evidence, parallel NikCore work and remaining P2 blockers. The R08 baseline/proposal wording and source anchors below remain the historical contract, not a production release claim.

Normative words MUST/SHOULD describe the proposed P1 contract. JSON is UTF-8. Unknown additive fields may be ignored; invalid required fields/types are rejected. Times are integer Unix milliseconds. IDs are case-sensitive. Application protocol 2 is independent of WS version 13, @box/HKDF v1, keeper proto 1, checkpoint $v:1 and Codex JSON-RPC/IPC versions.

## 1. Boundary and guarantees

- Keep /socket for fleet and /socket?session=<instance-id> for conversations. The authenticated socket fixes its role/target. Existing id, requestId, taskId, sessionId, threadId and runId fields retain their existing meanings.
- A mid identifies one immutable client intent. A durable receipt prevents the engine from dispatching that intent again within its advertised scope/lifetime. It does not guarantee an external provider executed exactly once, and an acknowledgment is not task completion.
- A send acknowledgment can mean durable engine acceptance before provider dispatch. Provider progress/outcome is a separate operation record. A lost provider reply is unknown, not rejected.
- No event replay log, sequence cursor, generic JSON-RPC conversion, protocol multiplexing, new process-management catalog or distributed transaction system in P1. Reconnect uses fresh snapshots plus receipt/operation queries.
- Window mode stays proto 1 until its composition explicitly supplies all v2 services. Never advertise durable receipts backed only by globalState.update or an in-memory map. A memory store is permitted in tests with a clearly test-only host.

## 2. Authentication, advertisement, hello and welcome

The current handshake is @challenge → @auth → @welcome; paired application messages are inside @box. There is no existing wire hello to extend (src/remote.js:1828, :1843, :1905; media/transport.js:212; app/iphone/NikCore/Sources/NikCore/Transport.swift:120). Keep its cryptographic signatures, proof text and key derivation unchanged.

After successful authentication, the new engine adds an advertisement to the existing @welcome. The old device/signature/version/rekeyed fields are unchanged; existing clients ignore the additions:

    {
      "type": "@welcome",
      "device": {"id":"phone-1","name":"iPhone","kind":"device","control":true},
      "signature": "<existing host proof>",
      "version": "0.2.0",
      "proto": {"min":1,"max":2},
      "caps": ["mid-ack-v1","receipts-v1","run-precondition-v1","operation-state-v1","pr-v1"]
    }

device is the existing Seat; signature/rekeyed remain conditional exactly as in proto 1. proto and caps are the only new advertisement fields. caps here means server-supported features, not selected features or grants.

A new client which sees that advertisement sends this first application frame after verifying the host proof:

    {
      "type": "hello",
      "proto": {"min":1,"max":2},
      "caps": ["mid-ack-v1","receipts-v1","run-precondition-v1","operation-state-v1","pr-v1"],
      "client": {"id":"a2d8215b7d67433c980d81359dd02120","kind":"iphone","version":"1.0"}
    }

proto.min/max are positive integers, min <= max. caps is a unique array of at most 64 names, each at most 64 ASCII characters. client.id is a random 32-lowercase-hex installation/browser-context ID; kind is browser/android/iphone/extension/mac/test; version is informational, at most 80 characters. These fields are untrusted labels, never authentication or dedupe principals.

The engine answers:

    {
      "type": "welcome",
      "proto": 2,
      "caps": ["mid-ack-v1","receipts-v1","run-precondition-v1","operation-state-v1","pr-v1"],
      "engine": {
        "id":"ae6a9e02284843bb9868f91637382219",
        "boot":"b8be34d36b164aeb84fc417dd4304e9b",
        "version":"0.2.0",
        "mode":"service"
      },
      "seat": {"id":"phone-1","control":true,"local":false,"editor":false},
      "receipts": {
        "scope":"981aa39d3e3a4f389f0ff600657d42d9",
        "retentionMs":86400000,
        "maxEntries":10000,
        "maxBytes":134217728,
        "maxMessageBytes":16777216,
        "maxResultBytes":16777216,
        "now":1795179600000
      }
    }

engine.id is persisted for this installation; boot changes on each engine process start. mode is window/service. receipts.scope is persisted with this receipt store, distinct from host fingerprint, boot and engine.id. A reset/import/rollback which cannot preserve its entire unexpired receipt set MUST create a new scope. now supplies server time for issuing operations; clients retain a server-clock offset. seat is derived by the server from authenticated grants; paired control alone never confers local/editor authority.

Select the highest common protocol eligible on this authenticated socket. Compute its advertisement after authentication/sealing, so a paired socket lacking a required sealed channel advertises max:1. For proto 2, all four core caps above are mandatory and MUST be selected together; otherwise choose 1 only if both ranges include it. Selected caps are the supported intersection. Optional caps:

| Capability | Meaning |
| --- | --- |
| pr-v1 | Existing PR pane read/write message family is implemented. |
| slack-v1 | Existing Slack wire handlers are implemented; local-only restrictions remain. |
| terminal-v1 | Existing command/output terminal feature is enabled. |
| voice-v1 | Voice handlers exist; voice:state still reports actual build/model availability. |
| editor-route-v1 | Local editor registration/routing exists. R19 implements this on the isolated development bridge; ordinary window/network construction must not advertise a stub. |

For a negotiated proto 1 welcome, caps is [], receipts is null, and engine/seat retain the same shapes. No overlap or missing mandatory caps when min=2 yields:

    {"type":"protocol:error","code":"NO_COMMON_PROTOCOL","message":"No compatible application protocol.","supported":{"min":1,"max":2}}

code can also be BAD_HELLO, REQUIRED_CAPABILITY or NEGOTIATION_TIMEOUT. Send this then close 1002; do not execute buffered work or silently downgrade after an error. Application negotiation gets a separate 10s deadline; transport authentication retains its existing 10s deadline. hello is accepted once per socket. Changing negotiated values requires reconnecting.

Compatibility detection has no timer race:

1. No advertisement in a verified @welcome means an old extension: new client immediately selects proto 1 locally, sends existing ready, and enables no replay.
2. New engine receives any first post-auth application frame other than hello, including @apple/@listen: pin that socket to proto 1 and dispatch it unchanged. Old clients need not wait for a new welcome.
3. With an advertisement, a new client sends hello and waits for welcome before ready, subscriptions or mutations. Do not expose live mutation controls after @welcome alone.
4. In a direct VS Code webview there is no remote auth exchange. Its extension bridge either explicitly opts into the same hello/welcome dispatcher with a server-assigned local principal or remains proto 1. Do not force negotiation into existing acquireVsCodeApi() traffic.

The advertisement and negotiated messages travel through the existing sealed channel when present. Proto 2 on a paired/enrolled-client socket requires that channel; if an intentionally unsealed legacy connection is permitted by configuration, only proto 1 is eligible. The existing LocalKey loopback browser and trusted direct-webview bridge may retain their local transport boundary. Never weaken remote.requireEncryption to enable negotiation. A new local enrollment path must preserve its own trust requirements; advertised client.kind/from.local never upgrades a network caller.

## 3. Mutation envelope and identity

Every application mutation marked “yes” in §8 requires these additional top-level fields on a negotiated v2 connection:

    {
      "type":"send",
      "mid":"ad1bccaf7de84efcb4067845cad1f0ae",
      "scope":"981aa39d3e3a4f389f0ff600657d42d9",
      "issuedAt":1795179601000,
      "text":"Review the queue drain.",
      "attachments":[],
      "snippets":[]
    }

mid is exactly 128 random bits encoded as 32 lowercase hex characters, generated once per intent before the first attempted write. scope equals the negotiated receipt scope. issuedAt is server-adjusted time at creation, immutable on retries. Existing message-specific fields are unchanged except the explicit run/steer/terminal preconditions in §6.

The principal is the authenticated device ID, enrolled local-client ID, or the engine's authenticated local-browser principal; it is never hello.client.id, a socket ID or a caller-provided from field. Local browser requests in one engine share that local principal. Receipt key = (scope, principal, mid); the stored request hash also binds message type, socket role, conversation instance ID and all intent fields including issuedAt, legacy correlation id, run and PR target preconditions. Do not key receipts by client connection.

Canonical hashing: validated JSON, recursively sorted object keys, original array order, UTF-8 JSON encoding, SHA-256. Do not discard unknown intent fields before hashing; omit only mid/scope, and exclude transport encryption counters. null and absence remain distinct. Store normalized server target as "fleet" or "session:<instance-id>". Never resolve a changed session.prUrl/cwd/run afresh on a duplicate. Internal outbox keys, request references and provider correlation IDs must include the principal as well as mid; two devices deliberately choosing the same mid cannot collide there.

The shared vectors pin the preimage as `{"message":<request without top-level mid/scope>,"target":<normalized socket target>}`, with keys sorted by UTF-16 code units, compact JSON and no Unicode normalization. Use ECMAScript `JSON.stringify` string escaping and finite-number serialization for leaf values, so exponent/decimal spelling is deterministic after JSON parsing; reject ill-formed Unicode rather than replacing it during hashing. Nested fields named mid/scope remain intent data. The current 14 vectors cover safe integers and exactly representable fractions; full number/escaping boundaries and runtime dispatcher conformance remain P1-13/P1-22 gates. The Swift fixture serializer is not a production canonicalizer.

- Same principal/mid and same hash: return stored/current receipt, without handler redispatch.
- Same principal/mid and different target/type/content: reject MID_CONFLICT, admitted=false; keep the original record untouched.
- Same mid on a different authenticated device is a different key; it cannot fetch the first device's result.
- Serialize reservation before the first await that can dispatch effects. Concurrent duplicates join the reservation/result or receive pending; two independent mids still need resource-level approval/queue/turn checks.
- Validate authentication, current receipt-view authority and schema before disclosing a receipt. A hit can return the historical result even if its run has ended. Fresh-dispatch grants and preconditions are checked on a miss. Revoked result-view authority yields a refusal, never redispatch or receipt replacement.
- Existing id fields remain entity/correlation IDs. Retry MUST keep those fields as well as mid, scope, issuedAt and payload unchanged.

issuedAt may be at most 30s ahead of effective server time; new admission is allowed for at most 24h after issuedAt. Missing/invalid mid gets a structured rejection when possible, with mid:null, and no effect. Expired miss gets EXPIRED; a scope mismatch gets SCOPE_CHANGED. Neither is permission to mint a replacement mid automatically.

## 4. Ack, duplicate, rejection and lookup

All ack fields below are required; result and error may be null:

    {
      "type":"ack",
      "scope":"981aa39d3e3a4f389f0ff600657d42d9",
      "mid":"ad1bccaf7de84efcb4067845cad1f0ae",
      "what":"send",
      "target":"session:instance-7",
      "status":"applied",
      "outcome":"applied",
      "admitted":true,
      "at":1795179601010,
      "expiresAt":1795266001010,
      "result":{
        "code":"accepted",
        "data":{"instance":"instance-7","queueId":"q-29","operation":"ad1bccaf7de84efcb4067845cad1f0ae"},
        "replies":[]
      },
      "error":null
    }

scope echoes the valid request scope, including on SCOPE_CHANGED; for an uncorrelatable malformed envelope it uses the negotiated scope. mid is the request's 32-hex ID or null for an invalid/missing ID; what is its type string; target is the normalized socket target. at is an integer, expiresAt is an integer or null, and admitted is a boolean. result.replies contains only the per-family semantic replies in the result table, never authentication frames, ciphertext, nested acks or operation/output streams.

| Field/value | Exact meaning |
| --- | --- |
| status: applied/rejected/pending/unknown | First/current disposition; equal to outcome. |
| status: duplicate | Lookup/repeat of an admitted record; outcome remains applied/rejected/pending/unknown. Duplicate does not mean success. |
| outcome: applied | The result's stated engine acceptance or effect is durably recorded. It is not provider task completion. |
| outcome: rejected | Definitely not performed/accepted. A post-dispatch timeout cannot use this outcome. |
| outcome: pending | Reserved durably and still being processed in this live engine. Not permission for another dispatch. |
| outcome: unknown | Effect may have occurred and cannot yet be proved either way. Automatic dispatch is prohibited. |
| admitted | true means a durable record exists. false means this response itself is not retained as a new receipt; the identified intent must still not be changed/retried with a fresh ID automatically. |
| at/expiresAt | First reservation time and guaranteed retention end for admitted records, unchanged on a duplicate. Unadmitted rejection uses current time and expiresAt:null. |
| result | null unless applied. Otherwise {code:"accepted"/"ok"/"noop", data:<typed object>, replies:<array of recorded S→C semantic replies>}. |
| error | null for applied/pending. For rejected/unknown: {code:<enum>, message:<UTF-8 string <=2048 bytes>, retryable:<boolean>}. retryable means a definite unadmitted admission failure may be retried with this exact envelope; it never permits automatic new-mid retry. |

For example a stale approval:

    {
      "type":"ack","scope":"981aa39d3e3a4f389f0ff600657d42d9",
      "mid":"6664c4c219eb46ba838b1a7b62081d0a","what":"permission",
      "target":"session:instance-7","status":"rejected","outcome":"rejected",
      "admitted":true,"at":1795179602000,"expiresAt":1795266002000,
      "result":null,
      "error":{"code":"STALE_RUN","message":"The execution that requested this answer has changed.","retryable":false}
    }

A repeat returns the same envelope except status:"duplicate"; outcome stays rejected and result/error/at/expiresAt stay the same. A live pending record may later become a terminal disposition. A final applied/rejected result is immutable. Unknown may resolve only with evidence (§7), with that transition persisted before notification.

Error codes: BAD_MESSAGE, MID_REQUIRED, MID_CONFLICT, SCOPE_CHANGED, EXPIRED, CLOCK_SKEW, FORBIDDEN, LOCAL_REQUIRED, UNSUPPORTED, NOT_FOUND, STALE_RUN, STALE_TURN, STALE_RESOURCE, APPROVAL_RESOLVED, EDITOR_UNAVAILABLE, UI_UNAVAILABLE, CANCELLED, RECEIPT_FULL, STORAGE_UNAVAILABLE, ENGINE_RESTARTED, PROVIDER_REJECTED, OUTCOME_UNKNOWN. Only definite pre-dispatch/admission failures may say retryable:true. Store admitted business rejections; deterministic validation/auth/capacity failures may be unadmitted. Never label a generic exception after possible I/O as rejected.

Lookup works on either role, especially the fleet socket after a conversation was removed:

    {"type":"receipt:get","scope":"981aa39d3e3a4f389f0ff600657d42d9","mid":"ad1bccaf7de84efcb4067845cad1f0ae"}

It returns the same ack with status:duplicate if found. Otherwise:

    {"type":"receipt:missing","scope":"981aa39d3e3a4f389f0ff600657d42d9","mid":"ad1bccaf7de84efcb4067845cad1f0ae","reason":"not_found"}

reason is not_found/expired/scope_changed. A missing reply does not prove an external action never happened. Only a trustworthy same-scope store, an unexpired immutable request, and the absence of any reservation allow resubmitting the SAME request. Lookups join/wait for an in-flight reservation commit rather than racing it to not_found. A corrupt/unavailable store MUST refuse mutation admission and must not answer authoritative not_found. No lookup by untrusted principal parameter.

A failed/unavailable or unauthorized receipt lookup returns this query error instead of pretending the receipt is missing:

    {"type":"receipt:error","scope":"981aa39d3e3a4f389f0ff600657d42d9","mid":"ad1bccaf7de84efcb4067845cad1f0ae","code":"STORAGE_UNAVAILABLE","message":"Receipt storage is unavailable; delivery cannot be determined."}

code is BAD_MESSAGE/FORBIDDEN/STORAGE_UNAVAILABLE; malformed mid may be null. operation:get uses the same fields with type:"operation:error". Neither response authorizes a resend; preserve unresolved client state.

For v2, ack is the authoritative mutation receipt. Continue existing snapshots/events and semantic responses for UI updates. Add mid to a mutation's direct semantic reply where useful, without changing existing id fields. Store the allowlisted semantic reply inside result.replies; on duplicate return it as receipt data, not a new machine effect or a broadcast. A client applies composer/navigation results at most once per mid and only for its matching pending intent. Queries retain their existing response/correlation/lane behavior.

### What result is stored

Store the original normalized result, not a freshly generated snapshot and not merely {ok:true}. Every result has the exact common {code,data,replies} structure above. This is the data allowlist:

| Mutation family | result.data on applied; recorded replies |
| --- | --- |
| send, including provider slash commands and /codex handoff | {instance,queueId,operation}; code accepted means the full immutable intent is in the engine outbox. Subsequent provider/fork destination arrives as operation/event data; don't re-run handoff to recreate an ID. |
| ready on conversation | {instance,run}; current init is sent separately on every connection, including duplicate ready, without re-running auto-start/unread effects. |
| visible | {on}; persisted unread effect is committed once; subscription/visibility attachment is connection-local. |
| unqueue/promoteQueued/editQueued | {queueId}; editQueued records the entire editPrompt reply, including text, sent, snippets and attachments. Missing queue item rejects NOT_FOUND rather than returning a false success. |
| clearQueue | {removed:<integer>}. |
| permission | {requestId,run,allow,delivery:"submitted"} only after the adapter confirms its write boundary. This does not claim the provider executed the approved tool. |
| interrupt/stopTask | {run,taskId:<string or null>,delivery:"submitted"}; completion remains a provider event. |
| instance:new/resume | {instance}; record instance:created with the original correlation id and created instance ID. |
| instance:place | {instance,folderId:<string or null>}; record instance:placed. |
| setSetting/awake:set/lid:set | {id:<row ID or "awake"/"lid">,value:<applied value>}; do not save an entire later settings report as the result. |
| saveCommand/removeCommand/restoreCommand | {name}; record the original commands done/name response (bounded catalog if included). |
| pr:reply/resolve/comment/rerun | {prUrl,action,message,providerId:<string or null>}; record pr:done for the actual target and action. |
| pr:pane / pr:link / pr:unlink | {prUrl:<string or null>,pane:<pane object or null>}; link may return CANCELLED before any change. |
| term:open | {terminal:<Terminal descriptor>}; record term:opened, never allocate a second terminal on duplicate. |
| term:run | {terminal:<ID>,terminalRun:<run ID>}; acceptance of one specific command, including emulated cd, not its exit/output. |
| term:stop/term:close | {terminal:<ID>,terminalRun:<ID or null>}; record term:closed when applicable. |
| @apple | {registered:true}; never echo a token. |
| @listen | {}; record the original @listener {secret} so retry doesn't rotate again. Sensitive receipt readable only by that authenticated device; private on disk, never logged. |
| forget | {device:<removed ID>}; commit and enqueue ack before device reconciliation closes its sockets. Lost self-forget ack cannot be queried after authentication is revoked. |
| slack:reply | {conversation,thread:<string or null>,ts:<posted Slack ts>}; preserve slack:sent with its original id. Return the posted ts from SlackService.reply rather than dropping it. |
| slack:open | {conversation,thread:<string or null>}; fresh thread snapshot is separate. |
| slack:mute/vips/enable | {conversation:<string or null>,value:<applied bool or VIP array>}. |
| slack:connect/disconnect/signIn | {connected:<bool>,who:<object or null>}; no token/cookie in result, replies, logs or retained request payload. |
| OS/editor/local UI actions: openFile, runInTerminal, switch, allSettings, slack, openPr, pr:open, slack:settings/setup/link/openTicket | {provider:<registered provider ID or "system" or null>,destination:<path/URL/instance or null>}; store any existing direct semantic reply such as @navigate, slack:link or slack:openTicket. May report accepted UI dispatch, never that a user read it. |

Result bytes are capped before effects. Routine result/reply data is at most 16KiB; editQueued's complete draft may be up to maxResultBytes. Larger query snapshots remain separate query responses. Reserve enough space for the measured draft before removing it. Do not truncate user text/images to make a successful durable receipt fit. Unsupported optional handlers return UNSUPPORTED instead of silent success.

## 5. Receipt store, persistence and crash ordering

D20 selects one private, versioned append-only JSONL authority for receipts and the durable outbox, with one serialized writer and periodic compaction. Each validated commit record couples the local state transition and receipt; compaction uses temp-file + fsync(file) + atomic rename + fsync(directory). P1-12 must define framing, commit validation, torn-tail recovery and physical log bounds, and prove them on real disk. A whole-file JSON snapshot was an earlier permitted option, superseded by R03/D20. Source mementos and keeper RAM are not this store. Existing UI/session mementos can be mirrors after commit; never acknowledge them as the authoritative commit (baseline src/manager.js:557).

An admitted entry contains:

    {
      "v":1,
      "principal":"device:phone-1",
      "mid":"ad1bccaf7de84efcb4067845cad1f0ae",
      "target":"session:instance-7",
      "what":"send",
      "issuedAt":1795179601000,
      "at":1795179601010,
      "expiresAt":1795266001010,
      "hash":"<64 lowercase hex SHA-256>",
      "phase":"completed",
      "outcome":"applied",
      "result":{"code":"accepted","data":{"instance":"instance-7","queueId":"q-29","operation":"ad1bccaf7de84efcb4067845cad1f0ae"},"replies":[]},
      "error":null,
      "reservedResultBytes":0,
      "requestRef":"outbox:device:phone-1:ad1bccaf7de84efcb4067845cad1f0ae"
    }

Logical store state: {v:1,engineId:<32 hex>,scope:<32 hex>,clockHighWater:<ms>,entries:[...],outbox:[...]}; this is not a required JSONL record layout. phase is prepared/dispatching/completed; outcome is pending while prepared/dispatching. reservedResultBytes is the persisted completion-space reservation (zero once replaced by its final result). requestRef is a principal-qualified outbox record reference or null. The outbox stores the full validated payload and derived provider correlation/settings/preconditions before dispatch; sensitive credential inputs are excluded and cannot be resumed unattended. Keep the original result/error, generated entity IDs and reclaimed draft/notification bearer when those are needed to answer duplicates. Do not retain full transcripts, reports, terminal output or arbitrary raw RPC responses in receipts.

Bounds and retention:

- Retain every admitted receipt for at least 24h from first reservation, including rejected/unknown records. Expiration removes it only after both expiresAt and issuedAt + 24h + 30s have passed. Never refresh TTL on a duplicate.
- Hard maximum 10,000 receipt entries and 128MiB serialized live store, including referenced pending/unknown payloads. Max 1,024 active outbox intents. An incoming durable prompt payload is at most 15MiB so an enclosing reclaimed-draft result stays under the 16MiB application limit. The existing v1 24MiB wire limit remains unchanged; v2 clear JSON max 16MiB also leaves room for @box base64 expansion.
- Prune only expired entries. If unexpired entries/payloads or reserved result space fill a bound, reject RECEIPT_FULL before effects; do not evict a live receipt to accept more work. Space for a bounded result is reserved at admission; completion must not fail merely because another operation filled the store.
- Retain unresolved operation payloads beyond receipt expiry until explicitly resolved/discarded, still within the hard bounds; they are never returned to the runnable queue by pruning. If this blocks admission, show that concrete state.
- Paths/directories are owned/private, files 0600 and directories 0700. Refuse symlink/foreign-owned authoritative paths. Unknown newer schema or corruption means read-only diagnostic state; do not reset to an empty receipt map under the same scope.
- Persist clockHighWater with commits. Use effective time = max(wall time, persisted high-water); clock rollback cannot make expired operations fresh. A serious skew rejects new admission until corrected and clients refresh server time. No silent clock-driven scope reset.
- Backups/restores/imports preserve the entire unexpired set with the scope or install a new scope. A copied old backup cannot keep pretending to know later receipts. No guarantee survives storage rollback that bypasses this rule.

Changing scope after an old backup restore also quarantines its nonterminal outbox entries: a record which was queued at backup time may already have executed afterward. Do not relabel those entries into the new scope and drain them as fresh work. Only a current, quiesced handoff which proves an intent remains undispatched can preserve automatic queued delivery. Other restored uncertainty needs evidence or an explicit new user intent.

Dispatch algorithm:

Recovery runs before accepting clients, starting provider work, restoring queue timers or permitting any drain. Rebuild the in-flight/unknown barriers first.

1. Authenticate; parse/validate envelope and current result-view authority. Find a same-key record and compare the immutable hash before resolving live target/run prerequisites. Return duplicate/current state on a hit.
2. On a miss, validate scope/time/capabilities/current grants/target and preconditions. Atomically reserve the key and capacity, persist prepared, and hold an in-flight entry before any effect. Persist any admitted rejection as completed/rejected.
3. For send, allocate a stable queue/operation ID and persist the complete outbox input AND its applied/accepted receipt together. Only then ack and drain. This queue entry is authoritative; a lossy manager memento must not become its recovery source.
4. For a local authoritative state transition, commit the change and receipt together, or use a deterministic recorded update whose replay is safe and ordered. Do not pretend independent per-key file writes form one transaction. External config/Keychain/editor writes use the dispatch rule below when atomic co-commit isn't available.
5. Before crossing an external boundary (provider RPC/IPC/stdin, gh/Slack, terminal spawn, editor/UI action), persist dispatching plus the stable provider/entity correlation and frozen target. Then dispatch once. A definite pre-write failure or explicit provider non-acceptance can reject. Once writing may have begun, timeout/disconnect/uncertain write is unknown.
6. Persist completed/applied or completed/rejected before emitting its final ack. On failure to persist after possible effect, keep/quarantine dispatching, refuse further unsafe work and report unknown; never turn it into not_found/requeue.
7. On restart, a prepared entry without a committed durable acceptance has not crossed the external boundary: it may be completed/rejected ENGINE_RESTARTED, retaining the draft. A dispatching entry becomes unknown, then reconciles. An already committed queued intent can drain once only after normal run/target checks; an unknown one cannot. Restore applied/rejected receipts unchanged.

There is an unavoidable crash gap between “dispatching persisted” and “provider call happened.” Conservatively reporting unknown in that gap is intentional. Receipt-first ordering alone does not remove the gap.

## 6. Run/turn identity, approvals, stop and steer

RunRef has exactly:

    {"id":"a81ec16e4ac74040a9107dbe669380b5","turn":"turn-9"}

id is an opaque 128-bit 32-hex execution/control generation, never a session/thread ID, PID or client-chosen value. turn is a nonempty string token (at most 256 bytes), or null when no applicable active control target exists. Claude uses an engine-generated turn token, minted before dispatching a new foreground input and when an observed unsolicited foreground turn begins; Codex uses the provider turn ID when known. For Claude's background-only interrupt target, advertise a separate "bg:<32 hex>" turn token bound to the current stoppable background set, changing it whenever that set changes. Do not use a mutable turn count without a generation.

Mint/rotate id at provider process/control incarnation change or whenever continuity cannot be proved. P1 may conservatively rotate it on engine restart/reattachment, expiring old controls; a later implementation may preserve it only after restoring the exact same kept execution, pending set and turn identity. Socket reconnect alone within one healthy engine does not rotate it. Codex lost RPC connection invalidates pending approval authority even if the thread ID is unchanged.

Expose top-level init.run, meta.run and conversation status.run in v2 (run is beside the existing meta/status payload, not inside the report). Stamp each permission item with its immutable issuing run and pending request ID, and each stoppable background task/shell with its own issuing run. Codex requestUserInput text items get an answerTo:{requestId,run} marker so an old composer reply cannot answer a replacement question. These are additive fields ignored by old clients.

Exact v2 controls, in addition to the common mutation envelope:

    {"type":"permission","mid":"6664c4c219eb46ba838b1a7b62081d0a","scope":"981aa39d3e3a4f389f0ff600657d42d9","issuedAt":1795179602000,"requestId":"approval-11","allow":true,"run":{"id":"a81ec16e4ac74040a9107dbe669380b5","turn":"turn-9"}}
    {"type":"interrupt","mid":"c4800f62c42b465b8277ec6027ec7588","scope":"981aa39d3e3a4f389f0ff600657d42d9","issuedAt":1795179603000,"run":{"id":"a81ec16e4ac74040a9107dbe669380b5","turn":"turn-9"}}
    {"type":"stopTask","mid":"8065110b90e848a1b7af2b44ce53088f","scope":"981aa39d3e3a4f389f0ff600657d42d9","issuedAt":1795179604000,"taskId":"task-4","run":{"id":"a81ec16e4ac74040a9107dbe669380b5","turn":"turn-8"}}
    {"type":"send","mid":"dedfe5aeac9342d7a2f4f4ae7f466477","scope":"981aa39d3e3a4f389f0ff600657d42d9","issuedAt":1795179605000,"text":"/steer Focus on the receipt race.","run":{"id":"a81ec16e4ac74040a9107dbe669380b5","turn":"turn-9"}}
    {"type":"promoteQueued","mid":"5af8b6ce725c474db745d1d057e68b48","scope":"981aa39d3e3a4f389f0ff600657d42d9","issuedAt":1795179606000,"id":"q-29","mode":"steer","run":{"id":"a81ec16e4ac74040a9107dbe669380b5","turn":"turn-9"}}

There is no new steer wire type. send('/steer ...') and Codex promoteQueued are the existing paths (src/codex.js:1039, :1133). For v2 promoteQueued, mode is required: reorder or steer. reorder never becomes steer just because a turn started meanwhile; steer requires a matching active Codex turn and must not fall back to queueing when stale. A normal send has no run precondition unless it answers a provider question or invokes a run-bound command. A question-answering send must include answerTo:{requestId,run}, matching the pending question; it cannot implicitly answer whatever question is current at dispatch. If a pending question would intercept an ordinary send lacking answerTo, reject that dispatch with BAD_MESSAGE and retain its draft rather than calling the current implicit _answer path.

Validation:

- permission requires a strict boolean allow and an unresolved pending record keyed by (instance,run.id,run.turn,requestId), not merely a matching transcript item or running process. Atomically reserve/consume that record for the winning mid; competing mids reject APPROVAL_RESOLVED. A failed/unknown delivery remains uncertain, not silently reopened for another answer.
- interrupt matches the current active turn, or the exact advertised background-work control token when the provider supports idle/background interruption. No token means reject; don't interrupt a later turn. Bind the captured expected turn through asynchronous owner discovery (src/codex.js:1113).
- stopTask matches an existing active task in the same run incarnation AND the task's issuing turn. It may outlive that turn; do not compare only with the newest foreground turn. Codex stopTask returns UNSUPPORTED instead of acknowledging its current no-op.
- steer/promote-steer compare the same expected turn again immediately before provider dispatch and pass expectedTurnId to Codex. No promotion/removal until known acceptance; ambiguity quarantines the queued input rather than leaving it runnable.
- Persist the pending/control precondition before I/O; validate anew after any async UI/owner lookup. On run change, do not copy pending authority from transcript history. A fresh snapshot obtains fresh tokens.
- Duplicate receipt lookup happens before fresh run checks. An already-applied answer to an ended turn returns that historical receipt; it never answers a different turn.

These are preconditions against the engine's observed provider state. Use a provider-side expectedTurnId wherever offered. Claude's current control_request interrupt has no provider-side compare-and-swap token (src/session.js:772), so even an immediate final engine check cannot promise atomicity against an unobserved CLI turn transition. P1 must state that limit and reject when local state is uncertain, rather than claim the wire alone adds a provider guarantee.

Queue entity IDs in v2 must survive restart and must never be reassigned to another prompt; use persisted random IDs or principal-qualified operation-derived IDs, not a reset _seq counter. Current constructors reset counters while accepting restored queue IDs (src/session.js:209, :214; src/codex.js:525), so simply adding a mid wrapper does not establish this invariant.

Terminal control has a different existing run ID namespace. Keep term:out.run as a string. V2 Terminal descriptors also carry activeRun:<TerminalRun.id or null>, so a list-only client can capture its stop target. Add terminalRun to v2 stop/close; it is the exact TerminalRun.id from the descriptor/term:began/scrollback, never “whatever is running now”:

    {"type":"term:stop","mid":"d48c85d65920422b9e63d6857cb5c6af","scope":"981aa39d3e3a4f389f0ff600657d42d9","issuedAt":1795179607000,"id":"terminal-2","terminalRun":"terminal-run-12"}

term:close also requires terminalRun, equal to the observed running run ID or null if idle. A different current run rejects STALE_RESOURCE; it cannot close a new command. term:run generates one stable run ID before spawn and returns it in the receipt. A terminal ID must not be reused across restart.

PR mutations additionally carry prUrl equal to the URL observed by the client; capture that URL on admission and reject STALE_RESOURCE if the instance was relinked. Do not let a queued PR reply target the session's newer PR.

Proto 1 has no client execution token. Preserve its framing and ordinary actions, but the new engine must at least match a real pending approval/task and avoid cross-run ID reuse. If continuity/pending identity is ambiguous after a run change, refuse the old control with the existing @refused/term:no explanation to refresh/update rather than inventing a token from current state. Proto 1 cannot receive the full v2 stale-input guarantee; legacy window mode retains its existing behavior.

## 7. Provider operation state and Codex unknown outcome

A durable accepted send has a separate operation record. New engines emit it to v2 viewers/its originating principal when it changes, and include applicable active/unknown operations in a v2 init.operations array. A missing event is recovered by querying on either role:

    {"type":"operation:get","scope":"981aa39d3e3a4f389f0ff600657d42d9","mid":"ad1bccaf7de84efcb4067845cad1f0ae"}

Response/event (all fields required, nullable as shown):

    {
      "type":"operation",
      "scope":"981aa39d3e3a4f389f0ff600657d42d9",
      "mid":"ad1bccaf7de84efcb4067845cad1f0ae",
      "target":"session:instance-7",
      "revision":3,
      "state":"unknown",
      "provider":{
        "kind":"codex",
        "account":"<opaque resolved-home account ID>",
        "threadId":"thread-3",
        "clientUserMessageId":"nikui-ae6a9e02284843bb9868f91637382219-c47a61de298b16cc-ad1bccaf7de84efcb4067845cad1f0ae",
        "turnId":null,
        "ownership":"borrowed",
        "writer":"external"
      },
      "error":{"code":"OUTCOME_UNKNOWN","message":"Codex may have accepted the prompt; checking its history.","retryable":false},
      "at":1795179631000
    }

state is queued/dispatching/accepted/completed/rejected/unknown. revision is a persisted increasing integer for this operation, not a global event cursor. provider is null before provider assignment; otherwise kind is claude/codex, ownership is owned/borrowed, writer is engine/external/unknown; threadId/clientUserMessageId/turnId may be null where not applicable. account identifies the resolved provider home without using a user-visible account label as the key. The example provider message ID contains engine ID, a stable principal-hash prefix and mid; persist the full mapping and reject any internal collision instead of reusing another intent's correlation. error is null unless rejected/unknown. No stored operation yields operation:missing with {type,scope,mid,reason}, using the same reason enum as receipt:missing.

Only send has a final immutable receipt at engine-outbox acceptance while provider work continues. Thus ack(outcome:applied,result.code:accepted) and operation(state:unknown) can correctly coexist. For a direct control/PR/Slack/editor mutation whose actual dispatch result is itself the receipt, uncertain I/O makes ack outcome unknown; later positive evidence may settle it. Never rewrite an accepted send receipt into “not accepted” merely because provider dispatch failed.

Codex rules:

1. Persist the same stable clientUserMessageId, resolved home, thread, frozen input/settings, mid and dispatch phase before turn/start, turn/steer or thread-follower-start-turn. Use the same correlation for a possible accepted echo and reconciliation; never generate a new one inside a retry (current src/codex.js:1073, :1204).
2. Ownership is about the connection/child, not turn writer authority. A borrowed daemon may permit our writer; an owned app-server may be a follower of an externally owned thread. IPC writer discovery failure is not evidence the prompt wasn't sent.
3. A definite failure before writing, or a provider error that explicitly guarantees non-acceptance, is rejected. Timeout, socket loss, crash after dispatching, or an uncertain stdin write is unknown on BOTH direct RPC and follower IPC.
4. Remove/quarantine the ambiguous item from the runnable queue, retaining its full input and correlation. Block automatic drain/retry/steer for that thread while a potentially active unknown turn remains. Reads and a stop against a positively identified current turn may remain available. Do not call queue.unshift(next), _retryWriter(), _takeWriter() then replay this item (current src/codex.js:1214).
5. Reconnect using the correct account; read actual thread/turn state and reconcile an exact provider client-message ID/turn ID. The current history reader uses thread/turns/list (src/codex.js:746); do not invent a provider lookup RPC. An observed matching user-message echo with clientId can establish acceptance (test/codexCommands.test.js:328). If a provider version omits that correlation in history, remain unknown.
6. Positive exact evidence gives accepted/completed with provider turn ID. Explicit authoritative non-acceptance evidence can give rejected. A history page without a match, “no turn seen for 20s,” matching text/timestamps or a dead socket is insufficient. Polling can stop with a visible unknown state.
7. The UI offers review/reconcile and an explicit new send only after explaining that the earlier outcome is unknown. A user-authorized new intent receives a new mid and, if derived from the old one, retryOf:<old mid>; retain the old unknown record. P1 may use existing retained draft + explicit send UI; it must not automatically restore an unknown item as a ready-to-send queued prompt.

Apply the same uncertainty distinction to borrowed approval responses, owned app-server calls, gh/Slack writes, terminal spawn and editor requests where a reply can be lost. This protocol does not claim the external services deduplicate by clientUserMessageId; correlation is evidence, not an idempotency promise.

## 8. Full inventory of today's messages and mid requirements

This is the complete current remote JSON vocabulary from protocol-today.md, checked against src/remote.js, src/hub.js and src/slackRoom.js. Classification is by direction AND socket role, not just a type string.

- M = mutation of provider, persisted engine state, OS/editor/UI action, or shared attention state. In negotiated v2, every application M below needs mid/scope/issuedAt, including “just UI” actions.
- Q = query or connection-local declaration/subscription; repeatable after reconnect, no durable receipt. Cache refresh, download tokens and transcription jobs are query implementation work, not prompt acceptance.
- E = server event/reply or transport envelope; no newly generated client mid. A direct mutation reply may echo its originating mid.
- Authentication/rekey and HTTP mutations are explicitly outside the application-mid envelope in P1. Their existing proof/one-use/absolute-upsert rules remain; no hidden exactly-once claim for those surfaces.
- A mid is not permission. Preserve every local/control/watch exception below. Unsupported capability/provider operation is an explicit refusal, not a successful no-op.

### Authentication and transport, either role

| Direction/type | Class | C→S needs mid? | Current effect / v2 boundary; source |
| --- | --- | --- | --- |
| S→C @challenge | E | — | Transport authentication challenge; src/auth.js:112. |
| C→S @auth | M (transport) | No | lastSeen and optional key replacement have their own nonce/signature protocol; no application mid during authentication; src/auth.js:142, :163. |
| S→C @welcome | E | — | Host proof/seat; additive advertisement only; src/remote.js:1843. |
| S→C @denied | E | — | Authentication refusal and close; src/remote.js:1857. |
| Both @box | E (framing) | No | Sealed envelope; n is a connection crypto counter, not an operation ID; src/secure.js:108. |
| C→S @apple | M | Yes | Paired device's APNs registration; self metadata, control not required; src/remote.js:301, :1953. |
| C→S @listen | M | Yes | Rotates its background bearer; paired self only; src/remote.js:239, :1954. |
| S→C @listener | E | — | Secret result of @listen; store original for duplicate; src/remote.js:244. |
| C→S app:update | Q | No | APK metadata/temporary download grant; src/remote.js:1222, :1956. |
| S→C app:update, app:update:changed | E | — | Availability/recheck events; src/remote.js:138, :1222. |
| S→C @device, @navigate, @notify | E | — | Seat change, requester navigation, device notification; src/remote.js:213, :1863; src/hub.js:664. |

### Fleet requests

| C→S type | Class | mid? | Current fields/effect and authority; source |
| --- | --- | --- | --- |
| ready | Q | No | Fleet snapshot; src/remote.js:1011. |
| history | Q | No | limit?, cwd?; history read; src/remote.js:1298. |
| status | Q | No | Report/quota read; src/remote.js:1259. |
| devices | Q | No | Device list; src/remote.js:1323. |
| forget | M | Yes | id=device ID; self allowed watch-only, another needs control; current LocalKey route refused; src/remote.js:1359. New local-management grants require a separate implemented command. |
| awake | Q | No | Power state; src/remote.js:1399. |
| awake:set | M | Yes | on; local/control; forced machine-global preference; src/remote.js:1469. |
| lid:set | M | Yes | on; local/control, prior laptop approval required; src/remote.js:1503. |
| codex:watch | Q | No | Connection's interest/list refresh, may enable workspace polling; src/remote.js:1022. |
| instance:new | M | Yes | id=legacy correlation, cwd, provider?, folderId?; control, known project only; src/remote.js:1154. |
| instance:resume | M | Yes | id=legacy correlation, sessionId; control, own Claude history lookup; src/remote.js:1275. |
| instance:place | M | Yes | id=legacy correlation, instance, folderId?; control; src/remote.js:1188. |

### Conversation requests

| C→S type | Class | mid? | Current fields/effect; additional v2 requirement / authority; source |
| --- | --- | --- | --- |
| ready | M | Yes | hidden?; may start CLI and clear unread, unlike fleet ready; control required only for start. Always send fresh init even on duplicate without redoing these effects; src/hub.js:691. |
| visible | M | Yes | on; affects persisted unread as well as presence; readable/watch seat retains existing visibility behavior; src/hub.js:199, :388. |
| send | M | Yes | text, attachments?, sent?, snippets?; all provider/local slash commands pass through this intent. Control; run for /steer; answerTo for question replies; src/hub.js:497. |
| interrupt | M | Yes | run required; control; current-turn/background interrupt, not process stop/remove; src/hub.js:514. |
| stopTask | M | Yes | taskId + task's issuing run; control; Claude active task only, Codex unsupported; src/hub.js:518. |
| unqueue | M | Yes | id=queue item; control; src/hub.js:522. |
| promoteQueued | M | Yes | id=queue item; control; v2 mode required, run for steer; src/hub.js:526; src/codex.js:1133. |
| editQueued | M | Yes | id=queue item; removal/reclaim, not a read; control; src/hub.js:530. |
| clearQueue | M | Yes | Control; src/hub.js:538. |
| permission | M | Yes | requestId, allow + run; real pending request, control; src/hub.js:542. |
| status | Q | No | One report; src/hub.js:556. |
| statusOpen | Q | No | open; connection-local report subscription; src/hub.js:560. |
| settings | Q | No | Catalog + mark subscription open; src/hub.js:572. |
| settingsOpen | Q | No | open; connection subscription; src/hub.js:584. |
| setSetting | M | Yes | id=row ID, value; curated allowlist, control; src/hub.js:588. |
| commands | Q | No | Snippet catalog + subscription; src/hub.js:603. |
| commandsOpen | Q | No | open; connection subscription; src/hub.js:608. |
| saveCommand | M | Yes | was?, name, prompt, description; control; src/hub.js:612. |
| removeCommand | M | Yes | name; control; src/hub.js:613. |
| restoreCommand | M | Yes | name; control; src/hub.js:614. |
| allSettings | M | Yes | Opens editor settings UI; local only; src/hub.js:631. |
| slack | M | Yes | Opens local editor Slack tab; local only, not slack:* relay; src/hub.js:579. |
| openPr | M | Yes | Opens session PR in laptop browser; local only; src/hub.js:638. |
| openFile | M | Yes | path, line?; server supplies session.cwd and authenticated requester; control; src/hub.js:644. |
| runInTerminal | M | Yes | command; insert without Enter in selected editor, control; src/hub.js:654. |
| switch | M | Yes | id=target instance; control; paired device gets navigation only; registered editor targets its own provider; src/hub.js:660. |
| pr:pane | M | Yes | open, tab?, width?, full?; shared persisted presentation. Existing watch seats allowed; not in STEERING today; src/hub.js:394. |
| pr:watch | Q | No | on; per-client subscription; src/hub.js:413. |
| pr:refresh | Q | No | Refresh cached PR read; src/hub.js:418. |
| pr:diff | Q | No | Diff read; src/hub.js:422. |
| pr:mentions | Q | No | query?; mention lookup; src/hub.js:431. |
| pr:reply | M | Yes | threadId, body + prUrl; control, gh write; src/hub.js:439. |
| pr:resolve | M | Yes | threadId, resolved? + prUrl; control; src/hub.js:440. |
| pr:comment | M | Yes | body + prUrl; control; src/hub.js:441. |
| pr:rerun | M | Yes | prUrl; control, check rerun; src/hub.js:442. |
| pr:askThread | Q | No | threadId; returns composer draft only; src/hub.js:457. |
| pr:askCheck | Q | No | runId, name?; read failed log and return draft; src/hub.js:458. |
| pr:askConflicts | Q | No | Returns draft, no provider send; src/hub.js:459. |
| pr:link | M | Yes | Local chooser can change pinned PR; local only; src/hub.js:481. |
| pr:unlink | M | Yes | Unpin/possibly redetect; control; src/hub.js:485. |
| pr:open | M | Yes | url; local + existing GitHub URL restriction; src/hub.js:489. |

Q composer results (pr:ask*) remain read results and are not automatically submitted. A client should not replay them into a different/edited composition. The classification of M does not add a control grant to shared view actions which already work for readers.

### Terminal, fleet only

All operations, including Q reads, require control for paired seats; a terminal capability is not itself that grant (src/remote.js:1635). Preserve command/output blocks; no PTY, stdin-stream or resize protocol.

| C→S type | Class | mid? | Fields/effect; source |
| --- | --- | --- | --- |
| term:list | Q | No | List memory terminals; src/remote.js:1652. |
| term:open | M | Yes | session?; cwd comes from server instance or home; src/remote.js:1656. |
| term:attach | Q | No | id=terminal; subscribe + scrollback; src/remote.js:1679. |
| term:detach | Q | No | id; connection subscription only; src/remote.js:1683. |
| term:run | M | Yes | id=terminal, command; stable generated terminalRun; src/remote.js:1695. |
| term:stop | M | Yes | id + terminalRun required in v2; src/remote.js:1690. |
| term:close | M | Yes | id + terminalRun (observed ID/null) required in v2; src/remote.js:1684. |

### Voice, either role

| C→S type | Class | mid? | Fields/effect; source |
| --- | --- | --- | --- |
| voice:state | Q | No | Availability, may ensure/build shared helper; existing local/control restriction; src/remote.js:1569. |
| voice | Q (resource job) | No | id=correlation, audio=WAV; temporary transcription returns text for review, never sends to a provider. Keep existing control/rate/size limits and don't automatically repeat a resource job after ambiguous loss; src/remote.js:1594. |

### Slack, fleet or trusted local Slack bridge

| C→S type | Class | mid? | Fields/effect/authority; source |
| --- | --- | --- | --- |
| slack:ready | Q | No | State read; src/slackRoom.js:169. |
| slack:open | M | Yes | conversation, thread?; changes view AND shared NikUI seen/escalation state; existing readers allowed; src/slackRoom.js:172. |
| slack:refresh | Q | No | Read/refresh sidebar; src/slackRoom.js:212. |
| slack:older | Q | No | conversation, thread?, before; read history; src/slackRoom.js:220. |
| slack:file | Q | No | id=Slack file; read image; src/slackRoom.js:238. |
| slack:reply | M | Yes | id=legacy correlation, conversation, text, thread?; control; posts then marks Slack read; src/slackRoom.js:184; src/slack/service.js:1016. |
| slack:mute | M | Yes | conversation, muted; control; NikUI settings, no unmute of Slack-owned mute; src/slackRoom.js:248. |
| slack:vips | M | Yes | vips; control; src/slackRoom.js:267. |
| slack:enable | M | Yes | Enable config; control; src/slackRoom.js:281. |
| slack:connect | M | Yes | Local-only credential dialog/store; src/slackRoom.js:286. |
| slack:disconnect | M | Yes | Local-only secret deletion; src/slackRoom.js:287. |
| slack:settings | M | Yes | Local-only editor settings open; src/slackRoom.js:288. |
| slack:signIn | M | Yes | token, cookie; local-only, don't retain secret input; src/slackRoom.js:302. |
| slack:setup | M local / Q paired | Yes local / No paired | Local opens setup URL, paired only receives URL; server derives branch from authority; src/slackRoom.js:313. |
| slack:openTicket | M | Yes | url; local only, may create/resume instance; src/slackRoom.js:321. |
| slack:link | M local / Q paired | Yes local / No paired | conversation, ts?; local opens URL, paired returns permalink only; src/slackRoom.js:332. |

### All current server-to-client application types

Every row is E (reply/event). None creates a client mutation ID; a mutation's correlated response can echo its mid and the exact original legacy id. Shapes remain those enumerated in protocol-today.md; additions are defined above. Repeated type names with different roles stay distinct.

| Socket/family | Complete type list | Existing source |
| --- | --- | --- |
| Transport | @challenge, @welcome, @denied, @box, @listener, @device, @navigate, @notify, app:update, app:update:changed | src/remote.js:213, :239, :1222, :1828 |
| Fleet | fleet, history, status, devices, awake, instance:created, instance:placed, @refused | src/remote.js:1036, :1057, :1176, :1202, :1259, :1298, :1323, :1399 |
| Conversation | init, items, meta, status, stats, queue, reset, presence, settings, commands, statusReport, openStatus, focus, draft, editPrompt, @refused, @device, @navigate | src/hub.js:86, :180, :267, :530, :755, :846, :882, :947 |
| PR | pr:state, pr:diff, pr:mentions, pr:done | src/hub.js:115, :425, :435, :451 |
| Terminal | term:list, term:opened, term:scrollback, term:began, term:out, term:done, term:closed, term:no | src/remote.js:1637, :1652, :1672, :1681, :1688; src/terminal.js:199, :217, :226 |
| Voice | voice:state, voice:text, voice:no | src/remote.js:1572, :1620 |
| Slack | slack:state, slack:thread, slack:older, slack:sent, slack:file, slack:refused, slack:signedIn, slack:openTicket, slack:link, slack:focus | src/slackRoom.js:107, :139, :165, :187, :227, :245, :307, :329, :344, :352 |

New v2 C→S hello, receipt:get and operation:get are Q/control and need no mid beyond the lookup's target mid. New S→C welcome, protocol:error, ack, receipt:missing, receipt:error, operation, operation:missing and operation:error are E. ack/operation carry a correlation mid, never a new ID. Unknown v2 application mutation types with a valid envelope reject UNSUPPORTED; malformed or unauthenticated frames follow transport error/close rules.

### HTTP vocabulary outside the application envelope

| Method/path | Class | mid in P1? | Rule |
| --- | --- | --- | --- |
| GET/HEAD /health | Q | No | Existing public liveness only, not identity or receipt authority; src/remote.js:610. |
| POST /pair | M | No | Existing short-lived one-use code + key proof. Do not blindly resend after an ambiguous claim; establish pairing status/restart explicit pairing. Control-socket local enrollment is a separate surface; src/remote.js:795. |
| GET/HEAD /push/key | Q | No | Public VAPID key; src/remote.js:615. |
| POST /push/subscribe | M | No | Existing signed, timestamped absolute device-subscription upsert. Not covered by v2 receipts; preserve current authentication and do not treat it as prompt delivery; src/remote.js:716. |
| GET /notify/listen | Q (subscription) | No | SSE, no command replay or backlog cursor; src/remote.js:257. |
| GET/HEAD /app/update.apk | Q | No | Device-bound expiring token; src/remote.js:1242. |
| GET /, /s/<id>, /pair, /media/*, /sw.js, /manifest.webmanifest | Q | No | Existing shells/assets; app-only restrictions remain; src/remote.js:559. |

Raw WebSocket ping/pong/close are transport frames, not JSON messages. Extension-only command IDs are not invented remote messages; missing rename/sleep/restart/remove/folder-CRUD/device-grant/history-delete/admin contracts remain a separate P2 parity task (capabilities.md:86).

## 9. Reconnect, client outbox and compatibility

For v2, persist a pending intent BEFORE its first socket write: {hostFingerprint,engineId,scope,principal,target,mid,issuedAt,payload,state}. Serialize immutable JSON once; reseal with the new connection's crypto counters on retry. Do not replay saved ciphertext. Recover the operation's draft/attachments without losing its pending mid.

P1 client persistence can use IndexedDB for browser/shell and the existing protected FileStore abstraction in NikCore, scoped to the pairing. Bound the client outbox to 128 pending intents and 32MiB; if persistence/capacity fails, preserve the composer and refuse to claim send acceptance. Ordinary memory reconnect is allowed when browser persistence is unavailable, but do not claim recovery across a page/process reload.

After authentication/negotiation:

1. Compare pinned host, engine ID and receipt scope. A new boot with the same scope is normal. Scope/host/engine change or downgrade to proto 1 quarantines unresolved operations; it does not clear them or authorize replay to the new owner.
2. Restore ready and current subscriptions (using mids for the M declarations in §8). For a pending conversation ready, reuse its mid and still receive fresh init; fresh unrelated view/subscription intent gets a fresh mid. Do not drain run-bound controls before a fresh snapshot.
3. Query receipts for unresolved mids. Resolve duplicate/applied/rejected from the original result; continue polling pending; show unknown without automatic resend. For a trustworthy, unexpired same-scope not_found, resend only the exact original envelope. One outstanding resend per mid.
4. Accepted sends query operation state; receipt:missing after expiry is not permission to resubmit. Snapshot items/user echoes may aid display, but matching text is never the v2 acceptance receipt.
5. Keep user drafts until accepted/refused/unknown is explicitly represented. A draft edit after sending creates a different composition; a late old acknowledgment must not erase it. Process recorded editPrompt/navigation replies only once for the matching pending intent.
6. Do not automatically issue a fresh mid after timeout, rejection, store full, expired receipt, revoked device, stale run or unknown. A definite transient unadmitted admission failure can retry the identical mid/envelope while still valid. An explicit new user intent gets a new mid.

| Client ↔ server | Negotiation and behavior | Replay/durability/run safety |
| --- | --- | --- |
| Old phone/browser ↔ new service engine | Existing challenge/auth/@welcome accepted; additions ignored. First ready/@apple/@listen pins proto 1. Existing message fields/responses preserved; no mid required. Existing local/control restrictions remain. | No durable retry guarantee for v1 intents and no automatic server replay. Match real pending approvals/tasks; refuse unsafe ambiguous controls. Unknown provider sends still must not be silently requeued inside the engine; show a legacy notice if the client lacks operation-state UI. |
| New phone ↔ old extension | Verified @welcome lacks proto advertisement; use existing ready/requests immediately. Do not send hello and wait on a timer. Keep native uncorrelated receipt lanes/heuristics where still needed. | No mids/receipts/caps assumed; no mutation replay on reconnect. Preserve ambiguous draft state. Never send an unresolved v2 mutation into this v1 connection, even if its old id/mid would be ignored. |
| New phone ↔ new service engine | hello/welcome chooses 2 plus all core caps; feature UI gated on optional caps and current grants. Negotiate independently on fleet/conversation sockets. | Same-scope exact-mid replay only; durable receipt + operation reconciliation; strict run/turn checks. |
| Old phone ↔ new extension in default window mode | Proto 1 behavior remains the existing default; no forced platform/negotiation installation. | Existing guarantees only; service extraction must not regress it. |
| New extension/phone ↔ v2-enabled window host | Allowed only when that host really implements the v2 receipt/outbox/run services. Engine.mode is window and its receipt scope is distinct from nikd's. | Same v2 rules; changing modes/scopes does not silently replay pending intents. P1 need not enable this production path. |
| No common version / required caps missing | protocol:error then close, visible incompatibility. | Execute nothing; no automatic downgrade/resend. |

## 10. P1 implementation map and acceptance

Keep a small dispatcher/receipt helper shared by the existing entry points. These are localized changes, not a replacement transport:

| Location | Required change |
| --- | --- |
| src/remote.js RemoteClient.welcome/deliver (1843/1895) | Add advertisement and per-connection negotiation state after decrypt/auth. Wrap @apple/@listen before their current early returns (1953). Put one shared receipt authority ahead of fleet/hub/terminal/Slack dispatch; derive principal/role, serialize reservations and standardize errors. Lookup must work on fleet after conversation removal. Preserve proto 1 fast path. |
| src/remote.js seat/fleet/terminal handlers (972/1011/1635) | Pass negotiated protocol, receipt service and trusted requester context to the hub. Return typed outcomes rather than infer success from client.post. Defer self-forget reconciliation until receipt/ack is committed/enqueued; add observed terminalRun checks. |
| src/hub.js receive/hello/init/meta (351/691/882/755) | Apply the same wrapper for remote and opted-in direct webviews. Split fresh snapshot production from ready's start/unread effect. Validate run/pending/resource preconditions, carry per-operation origin through handoff/fork, return concrete result data and stamp new fields on v2 events. Leave default legacy behavior available. |
| src/slackRoom.js, host/editor adapters | Return normalized results/posted ts, preserve local/control restrictions and requester identity. No receipt inference from broadcast state or from “handler returned undefined.” UI/secret operations get bounded, explicit outcomes. |
| media/transport.js seat/live/send/postMessage (266/471/517) | Negotiate before live/ready; generate/persist mids at the action boundary, serialize exact resend, handle ack/lookup/operation events and preserve attachments on refusal. Update the direct webview path only when its bridge opts in. Expose v2 outcomes to the existing UI rather than treating socket.send as acceptance. |
| app/iphone/NikCore Protocol.swift / Transport.swift / ClientOperations.swift / Persistence.swift | Add typed negotiation/ack/operation/run models; send hello before ready when advertised (currently Transport.swift:142), add envelopes around ClientAction.json (currently Protocol.swift:134 lacks mid), persist unresolved intents, make v2 ack authoritative, retain v1 receipt lanes, and resubscribe without replaying ambiguous writes. Expose unknown to callers/views via existing operation result state. |
| Small engine receipt/outbox module and provider hooks | Inject through host/composition. Atomic private state as §5; adapters return acceptance/rejection/unknown. Manager must not slim authoritative queued payloads. Carry stable operation IDs into session.js/codex.js and distinguish pre-write failure from possible dispatch in codexIpc.js/CodexClient. No honest durable-send or unknown-outcome implementation is possible by editing four transport files alone. |

Required checks, using provider fakes and temp state, not live production processes:

1. Old phone ↔ new engine and new NikCore/shared-JS ↔ old extension fixtures; prove no added wait before legacy ready, and no live mutation control before negotiated v2 welcome.
2. Disconnect before reservation, after reservation, after dispatch and after commit-before-ack; same mid never dispatches twice, including simultaneous duplicate frames and reconnect from a different socket.
3. Same mid/different payload or target; different device/same mid; revoked grants; deleted conversation with receipt lookup via fleet.
4. Duplicate rejected and unknown records; 10k/byte bounds; no unexpired eviction; expiry/clock rollback; changed scope after restore; corrupt/newer/read-only store.
5. Full >8k text, expanded prompt/snippets and images across engine restart; reclaim returns original full draft and stable IDs; no queue-ID reuse or durability claim from old slimQueued; an old-backup restore never auto-drains potentially executed work.
6. Two devices answer the same approval using different mids; stale approval/request-ID reuse; delayed interrupt across a new turn; background task from an older turn; Codex promote-steer; terminal stop after a new command begins.
7. Direct and follower Codex request accepted then reply lost: retained unknown payload, no queue reinsertion/automatic writer retry, exact-correlation reconciliation; no-match/timeout remains unknown; borrowed daemon is never terminated.
8. Pending client draft edited before a late ack, persistence unavailable/full, page/phone restart, scope/mode downgrade and encrypted reconnect counter reset. No silent new-mid retry.
9. Receipt success is emitted only after the promised commit; provider completion/event snapshots never masquerade as a mutation receipt. Test real disk reopen, not only a memory-store adapter.

This contract deliberately permits a conservative unknown result and explicit user recovery when the engine cannot prove an outcome. That is the implementable P1 boundary.
