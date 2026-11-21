# Protocol v2 fixtures — consistency, not runtime conformance

P1-01 / P0 R06, cross-reviewed and corrected in R08. These are specified application traces against
[protocol v2](../../../docs/engine/protocol-v2.md), not observations of an
implemented v2 engine/client. No test here dispatches mutations, proves disk
durability, negotiates a real v2 socket or establishes provider idempotency.

`manifest.json` pins the ordered IDs, polarity counts and SHA-256 of each trace
file: **179 vectors in 8 areas, 30 malformed-vector cases, 54 mutation branches**.
The mutation index covers every application M row in protocol §8, plus send's
slash-command/handoff branches. Both readers compare that inventory in both
directions. HTTP/authentication mutations and Q/E messages retain their separate
contracts. This corpus seeds the named T-cases; it does not pass those runtime gates.

| File | Vectors | Coverage |
| --- | ---: | --- |
| negotiation.json | 21 | Both roles, old/new peers, core/optional caps, malformed hello, timeout, sealing |
| canonical-hashing.json | 14 | Exact UTF-8 preimages/digests; key/array order, Unicode, null/absence, unknown/nested fields, target/run/correlation |
| receipts.json | 20 | Applied/rejected/pending/unknown duplicates, identity, admission failures, missing/error queries |
| run-turn-binding.json | 21 | Approvals, competing answers, delayed controls, older background tasks, questions, terminal/PR targets |
| codex-unknown.json | 18 | RPC/IPC lost replies, accepted send versus unknown operation, evidence, transport/writer axes |
| seats-grants.json | 14 | Forged labels, watch/self exceptions, local/editor grants, Slack local/paired branches |
| reconnect-outbox.json | 16 | Exact-envelope recovery, changed identity/scope, downgrade, storage limits/errors, late ack, fresh snapshot |
| mutation-results.json | 55 | All 54 indexed mutation branches with original/duplicate results, plus unsupported refusal |

Each vector has a stable `id`, positive/negative `polarity`, test-plan `covers`,
authenticated `context`, `initial` state, ordered `input` and `expected` replies,
effects, state and close code. A negative protocol trace is still a valid fixture;
it specifies rejection, uncertainty, blocked replay, or a hash mismatch. `harness`
input steps describe scenario changes and never represent new wire messages.
Negotiation starts after the existing authentication/proof boundary; abbreviated
`@welcome` inputs show only the relevant advertisement fields.

`expected.replies` lists the selected receipt/semantic messages relevant to the
scenario, not a complete transcript of snapshots, presence and streaming output.
The duplicate-ready trace also requires `expected.state.freshInitCount: 2`;
fresh snapshot delivery is independently tested at P1-17/T12. Local Slack link
opening records its destination without inventing a new v1 direct reply. Pane
results contain the normalized open/tab/width/full shape.

Effects are cumulative business-effect counts for the whole trace: `engine`
counts authoritative business changes, `provider` counts external writes and
`ui` counts dispatched UI actions. Receipt persistence, reads and crypto framing
are excluded. A duplicate adds no effect. Initial/expected state is descriptive
data for future runtime harnesses, not an executable reference engine.

`schema.json` is JSON Schema 2020-12 using a deliberately small keyword subset.
Independent Node/Swift validators reject unsupported schema keywords (and validate
schema-valued `additionalProperties`), malformed fixture shapes, inconsistent
ack/result/operation data, changed terminal duplicate results, invalid successful
APNs tokens, malformed retained image descriptors, wrong clear counts/reclaimed
drafts, UTF-8 error/run byte limits, non-ASCII selected capabilities, retained
sign-in credentials, unsafe unknown expectations and wrong canonical bytes/hashes.
Swift draft/terminal-result comparisons use canonical UTF-8 bytes because Swift
String equality would otherwise equate composed/decomposed Unicode. A shared
malformed case rejects that byte drift.
Server ack/operation input frames in client-outbox scenarios are schema-checked too.
`invalid-vectors.json`
applies shared remove/replace patches to valid vectors and requires named failures;
replace may insert an object key for malformed-field tests. No copy of the corpus
is bundled into SwiftPM.

Hash input is the compact, recursively UTF-16-key-sorted JSON object
`{message: request without top-level mid/scope, target: normalized socket target}`.
Arrays and Unicode bytes stay unchanged; nested mid/scope fields remain data.
Numeric-key ordering is checked without relying on object enumeration. Current
number vectors cover safe integers and exactly representable fractions; the Swift
test serializer is not a production JSON-number canonicalizer. Provider/credential
values are synthetic; sign-in input is distinct from the credential-free retained
result.

R08 corrected success traces to use synthetic hex APNs tokens and raw base64 PNG
attachments with `name`/`mediaType`, seeded the full reclaimed queue draft and both
cleared entries, and supplied missing capacity/revocation/known-project/lid states.
Legacy `@listen` still rotates once and returns its v1 bearer when it pins v1;
negotiation does not suppress that existing effect. Inputs/expected state remain
scenario data, not a complete executable reference engine. Exhaustive field,
number/Unicode escaping, boundary and interleaving conformance belongs to
P1-12 through P1-18 and the P1-21/P1-22 clients, with final P1-24 integration.

Readers resolve this directory relative to their source files, independently of
the working directory:

```sh
node test/run.js engine-protocol-v2
swift test --package-path app/iphone/NikCore --filter ProtocolV2FixtureTests
npm test
swift test --package-path app/iphone/NikCore
```

When editing vectors, update the manifest IDs/counts/checksums and intended counts
in both reader tests, then run both suites. Do not regenerate expectations during
tests. The existing opt-in NikCore real-loopback test remains a separate gate.
