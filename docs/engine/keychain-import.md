# P2: Keychain and selected generation import (D28 update)

Window mode remains the default. The selected importer is explicitly gated by
`testOnly:true` and a private target root. It is not connected to a production
activation command. No source editor database, provider home, live keeper,
route, login-Keychain setting or LaunchAgent is adopted or changed.

`helpers/keychain/main.swift` is the stdin/stdout SecItem helper. Build it with
`scripts/build-keychain-helper.js` inside an owner-only directory. The compiler
argument is exactly `-target arm64-apple-macos14.0`; the generated bundle also
declares macOS 14.0. It is Apple-Development-signed with hardened runtime and a
distinct test/development bundle identifier. D28 removes the provisioning and
access-group requirement. Round 3 builds two versions into the final service
bundle to test an existing item's ACL across a helper rebuild.

The protocol is one request and one response per process: a four-byte big-endian
length followed by UTF-8 JSON, bounded at 2 MiB, with exact version/operation
fields and a correlated 128-bit request ID. Values are canonical base64 bytes,
bounded at 1 MiB. Requests and secret values never enter argv, inherited
environment variables, stderr, diagnostics or exception messages. The helper
rejects command-line arguments, truncated/extra/oversized frames and foreign
service names. Node bounds execution time and output and checks the response
ID, namespace, accessibility, exit status and framing before returning bytes.

Operations are separate `add`, `update`, `read` and `delete`. An update never
deletes or creates an item; duplicate add and missing update fail visibly.
Missing read/delete are explicit, idempotent results. Every Keychain query
specifies the exact service/account in the file-based login Keychain alone.
`SecKeychainOpen` selects that account's login Keychain independently of TEST
HOME; `kSecUseKeychain` directs adds and `kSecMatchSearchList` confines queries.
There is no Data Protection flag, access group, synchronizable flag or profile.
Adds retain the default ACL trusting the creating signed helper. Authentication
UI is disabled for the helper process, including the legacy-Keychain shim.
The helper never locks/unlocks the Keychain or changes its settings/search list.

Adds/updates request `AfterFirstUnlockThisDeviceOnly`, falling back to
`AfterFirstUnlock` only for an unsupported-attribute error. Replies record the
accepted write attribute and whether reads actually report accessibility. The
file-based shim can omit it; in that case protection comes from the login
Keychain's lock and ACL, with no Data Protection protection-class claim.
Every other failure returns a named framed error and nonzero exit status.

The signed configuration accepts only `com.nikui.engine.test.<scope>` or
`com.nikui.engine.dev.<scope>`. The scope suffix is explicit and at least
16 characters; neither account nor service permits trailing newlines. The
adapter/import receipt records `backend: "login-file-keychain"` plus service,
with no access group. There is no alternate-Keychain/profile fallback.

`src/keychainStore.js` implements the existing synchronous `keys/get/update`
and SecretStorage `store/delete/onDidChange/dispose` interface; `store/delete`
return promises and change subscriptions/disposal remain synchronous.
One SecItem holds one versioned values map, so a persisted update is atomic.
The generation's exclusive writer lock serializes read/modify/update. Reads
consult the helper each time; missing, corrupt, denied or locked storage never
returns an old in-memory value or generates replacement keys. The isolated
daemon's explicit `adapters.keychain` path replaces its file secret store and
requires previously selected host/VAPID pins. The default file adapter remains
available solely to the existing synthetic P1 fixtures.

`src/engineImport.js` exports selected contexts through their actual memento,
SecretStorage and explicit file callback APIs. An export includes source
profile/workspace/raw-scope provenance, exact host/VAPID keypairs and pins,
device IDs/public keys/grants and Web Push/APNs/listener records, APNs key
references, names, settings/project approval provenance, full queued text,
expanded input/snippets/image bytes, queue/file hashes, deliberate folder order
and conversation placement, pause/limits/override, per-instance ledger maxima,
keeper eligibility and complete/incomplete receipt/outbox authority. Omitted
client, provider and derived stores are classified. The daemon never reads a
source SQLite database or follows an APNs reference during import.

Transfers require an explicit selected source. Different profiles, installations,
host/VAPID identities or delivery inventories refuse; grants are never unioned.
Validation checks the entire bounded JSON payload, exact inventories, member and
acknowledgment provenance, keypair/pin correspondence, schemas, queue/file/body
hashes, project approval provenance, unique entity IDs, folder references,
accounting values and current authority/control/operation data. Duplicate
instance accounting merges by maxima, without summing duplicated ledger copies.
Each workspace's own settings, folder order, file data and provenance remain
available in the imported source records.

A generation import has two deterministic Keychain accounts: immutable source
secret evidence and the selected mutable runtime store. SecretStorage values,
private keys and sensitive device delivery/trail data are removed from disk
manifests and reconstructed only in memory for hash verification. A private,
fsynced generation manifest first records preparation, then the add-only secret
accounts, then the inactive receipt. A repeated import returns its original
receipt; changed bytes under that ID refuse, and started target state/current
credentials are preserved. Receipts are bounded at 512 without eviction.

Owner commit requires the importer's synchronous `verifyInactive` callback under
the owner lock. This rechecks the full immutable payload, original counts,
initial state and exact staged runtime secrets before the atomic owner rename.
Discard takes that same owner lock, so it cannot delete staged secrets between
revalidation and commit. Inactive imports cannot start or accept work. A target
lease and durable activation reservation precede the activation callback; an
interrupted reservation requires reconciliation and never automatically repeats
an uncertain effect. Completed activation is idempotent. The runtime secret
store checks its generation lease on every mutation.

Preparation can be resumed with the same envelope after a crash before/after
each SecItem add or inactive-receipt write. Precommit discard records its intent
before deleting only its two accounts, recovers after either deletion, and
retains a tombstone that prevents resurrection. A proved abort can then reopen
the source generation. After commit, only the committed target can recover;
there is no backup restore or source fallback. A reachable, explicitly
re-enrolled current owner can reconcile its new lease without replaying start.

Handback uses `exportCurrent` inside the new participant barrier and requires
explicit keeper metadata. It exports the live target's current instances,
queues, accounting, settings/folders, credentials and authority. Complete current
authority preserves scope and unknown/effected operations; incomplete authority
changes scope and quarantines unresolved outbox work. A retired target root can
receive a later generation while preserving its earlier receipts. Unreachable
owners, old keeper hello and incomplete live-run metadata refuse by name.

## Reproduce

```sh
node test/run.js engine-transport-stress
node test/run.js engine-import
node test/run.js engine-secrets
scripts/test-mac-engine.sh --regressions
npm test
cd app/iphone/NikCore && swift test
```

On arm64 macOS the secrets test builds/signs the helper and exercises framing,
argument refusal and minimum OS, followed by real add/read, duplicate-add
preservation, update/missing update, empty/UTF-8/NUL bytes, delete and a separate
rebuild reading the existing item. Every attempted account belongs to one fresh
test service and cleanup runs in `finally`. Locked/denied/corrupt cases use
injected adapters; tests never lock the login Keychain or alter its ACL/settings.

`scripts/test-mac-engine.sh --regressions` repeats the real gate through the
final signed helper from the SMAppService-launched engine. It also sets
`NIKUI_SIGNED_TEST_ROOT` for `npm test`, so the suite explicitly selects that
private signed test endpoint for the same gate. The endpoint must reside under
`/tmp/nik-mac/build` and identify itself as `com.nikui.engine.development`, test-only.
It cannot select a live editor, production service or arbitrary helper path.
No native success is inferred from framing or synthetic failure tests.

Native service registration/Keychain writes require a normal macOS user
execution context. The managed command sandbox currently returns SecItem
`100001` (UNIX EPERM) on add and `SMAppServiceErrorDomain / 57` on register.
Those are explicit failed gates, not a provisioning requirement or a passing
test. See [signed-package evidence and reproduction](mac-engine.md).

The R02 disconnect failure was a timing assumption in the test: its socket-frame
count preceded completion of unrelated receipt/operation queries. In 240
full-daemon jittered trials, 95 count failures contained only those pre-disconnect
queries and zero held-ciphertext leaks. The test now samples at the held boundary
and checks the held ciphertext against every socket. A bounded 240-case WebCrypto
stress variant remains in the suite, and the composed end-to-end gate passed
20/20 consecutive runs at 49/49 checks. Evidence is under `/tmp/nik-mac/p2/r03-*`.

Historical round-2 regression evidence: `npm test` **6,728/6,728**; selected import
**111/111**, secret/helper adapter **60/60**, bounded transport stress **4/4**.
NikCore passed **150 tests in 14 suites** using the private-cache
`swift test --disable-sandbox` workaround after the plain command hit
`sandbox_apply` EPERM; its pre-existing opt-in loopback test was skipped.
Successful real SecItem access was not included in those counts. D28 supersedes
the earlier unprovisioned diagnostic helper and its optional-profile test path.
