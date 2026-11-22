# P2 acceptance: attended machine checklist

Status for every native/attended row below: **native: pending Claude run**.
These are instructions, not executed evidence. Window mode stays the default.
Passing the scripted subset does not authorize production cutover or default-on.

## Scope, setup and evidence

Use only this checkout, a fresh HOME under `/private/tmp/nik-mac/build`, the
signed `com.nikui.engine.development` bundle/agent, and its random
`com.nikui.engine.test.*` service. Never stop/adopt/import/reconfigure the live
NikUI checkout, editor, keeper, Claude, Codex, or borrowed Codex daemon. Never
read editor SQLite or copy provider homes. Any website opened from the menu
or development extension must use the system's default external browser.

First let Claude run, outside Codex's managed sandbox:

```sh
scripts/acceptance-p2.sh --native --editor --real-tools
```

The optional flags may be omitted. The script removes its app, agent and
minted Keychain items in `finally`; the JSON/logs remain. Its output names a
private `rehearsal-*/result.json`, which points to the native
`build/acceptance-*/result.json` and scenario evidence. A missing tool, login,
route or delivery configuration is **unconfigured/unrun**, never a pass.
`--real-tools` may use an existing `CLAUDE_CODE_OAUTH_TOKEN`, or the existing
Claude credential file, and the selected existing `CODEX_HOME/auth.json`.
It stages only those credentials in the test HOME, forbids refresh writes,
strips the live refresh token to prevent login rotation, and deletes the
snapshots. It never runs login/logout, changes live config,
reads the provider's non-test Keychain items, or resumes/attaches a thread.
If the existing login is only available through such a Keychain item, leave
that provider unrun. Do not log in again to make the test pass.

For attended checks needing a surviving bundle, create a **separate** manual
package after the scripted agent is gone. Build/run this only as Claude's
native work. If `launchctl print gui/$(id -u)/com.nikui.engine.development` succeeds,
stop here and ask that test job's owner to finish; do not unregister it.

```sh
"${NIKUI_BUILD_NODE:-/opt/homebrew/bin/node}" - <<'JS'
const fs = require('fs'), path = require('path');
require('./src/daemonPaths').privateDirectory('/private/tmp/nik-mac/build');
const run = fs.mkdtempSync('/private/tmp/nik-mac/build/manual-p2-');
const built = require('./scripts/build-mac-engine').build({
  output: path.join(run, 'NikEngine Dev.app'),
  testHome: path.join(run, 'test-home'), acceptanceP2: true
});
fs.writeFileSync(path.join(run, 'selection.json'), JSON.stringify(built, null, 2), { mode: 0o600 });
console.log(run);
JS
```

Set `manual_run` to that printed directory. These variables must never name
an existing profile or the live user's provider home:

```sh
manual_run='/private/tmp/nik-mac/build/manual-p2-REPLACE_WITH_PRINTED_ID'
manual_app="$manual_run/NikEngine Dev.app"
manual_ctl="$manual_app/Contents/MacOS/NikEngine"
manual_home="$manual_run/test-home"
manual_root="$manual_home/profile"
"$manual_ctl" register
/usr/bin/open -n --env "HOME=$manual_home" --env "USERPROFILE=$manual_home" \
  --env "ZDOTDIR=$manual_home" --env "CODEX_HOME=$manual_root/home/.codex-work" "$manual_app"
node src/nikd.js --root "$manual_root" status
```

For a reproducible synthetic conversation/pending approval, this owner-only
request uses no real CLI. Repeat with action `pending`, `state`, or `finish`
as the specific checklist requires; print only the public result:

```sh
node - "$manual_root" seed <<'JS'
const { privateRoot } = require('./src/daemonPaths');
const { controlRequest } = require('./src/daemonControl');
controlRequest(privateRoot(process.argv[2], { create: false }), {
  op: 'acceptance-p2', action: process.argv[3]
}).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.code); process.exitCode = 1; });
JS
```

Create `<manual_run>/evidence/` (0700). For each ID save `<ID>.md` or
`<ID>.json`: timestamp, macOS/hardware and client versions, test root, bundle
manifest/signature, engine ID/boot/generation, configured/unconfigured paths,
steps, observations, effect counts, and pass/fail/blocked. Keep prompt bytes,
credentials, listener secrets and enrollment keys out of the report. Session
cycles, permission dialogs, notification clicks and lid actions require the
person's chosen time. No script here performs them.

## A01

Run `--native --editor`. Confirm `editor-1/ready.json` and
`editor-2/ready.json` name actual Visual Studio Code, this development
extension, separate user-data/extensions/HOME directories, and the same test
engine. In the two **test** windows select different panels/drafts, then open
a harmless file inside the test project from each conversation panel.
Expected: both windows started together, one engine PID/writer, independent
drafts/selection, and each origin opens its own editor. The script uses
in-memory test SecretStorage to avoid the user's shared OS credential store;
editor credential persistence across a fresh VS Code process is not proved.
Save the two build/version records and the origin observations.

## A02

During the scripted same-run phase, confirm the actual menu and both test
VS Code windows show the same generation as the two phone protocol clients.
The script's `same-run-menu-and-two-phones` trace covers web v2 and sealed v1.
For independent old/new **phone build** acceptance, use a disposable simulator
or explicitly approved test-only reachable endpoint. This package binds
loopback and refuses network administration (`NETWORK_ADMIN_UNAVAILABLE`);
without a test transport, mark physical-device acceptance **blocked**, not
passed. Do not expose the user's real service to get around it. Close only
the test clients. Expected: the engine remains running; phone navigation and
selection stay on that phone and do not switch an editor.

## A03

Read `lost-ack-reconnect-one-effect` and
`disconnect-before-write-identical-mid-resend` in the native scenario report.
For an independently configured phone, send one clearly synthetic prompt,
interrupt only that test client's connection before its acknowledgment, and
reconnect/reopen it. Never disable the Mac's network or kill a real provider.
Expected: one provider effect, original mid/receipt recovery, exact saved
plaintext on a safe resend, new encrypted channel/counters, no duplicate
turn. Record mid, boot and effect count, excluding ciphertext/key material.

## A04

Seed the manual test engine, run action `pending`, and record its public run
and request ID. Use `"$manual_ctl" intentional-stop` then
`"$manual_ctl" start`. Refresh the test client before answering. The scripted
stale-control scenario also replaces a synthetic execution using the same
provider request ID. Expected: old approval authority cannot apply to a new
execution; `STALE_RUN`/precise unavailable state, no replayed answer; only the
new snapshot's current approval can be answered once. Real keeper continuity
requires its exact released metadata proof; no live keeper may be selected.

## A05

Inspect `live-legacy-owner-named-refusal` and `engine-owner.log`: connected
`p2-legacy-window`, build `legacy-without-meta`, blocks with
`KEEPER_META_UNSUPPORTED`, generation remains zero. For independent old-build
evidence use an old **disposable test** window/keeper, never the live user's
one. Attempt only the test coordinator handoff. Expected: named owner/build
blocker, no adoption, resume, forced detach or second process. The synthetic
participant does not establish an actual old keeper's native behavior.

## A06

With the A02 test transport, install/launch the explicitly recorded old phone
build and current build against the same test host pin. Open the same test
conversation, send once from the old build, revoke its control grant locally,
and attempt another send. Reconnect it. Expected: old socket remains v1,
current socket negotiates v2 independently; current grants apply immediately;
no v2 outbox replay is fabricated for the old build. Record build numbers and
provider effects. A v1 protocol client alone is not the old binary gate.

## A07

Use only synthetic paired devices. Record host/VAPID public pins and delivery
record digests before the selected test import/handback. Inspect
`pins-rekey-sse-and-forget`, `fresh-current-handback-with-post-cutover-work`
and `acceptance-handoff.json`. Expected: identical host/VAPID pins, selected
device grants/records preserved, valid dual-signed rekey, old key refused,
forgotten sockets/SSE closed and old listener rejected. For configured APNs
and Web Push send one synthetic notification after an actual supported test
import; record receipt and one delivery. Those transports are disabled here:
record **unconfigured/unrun** until test credentials and a supported runtime
adapter exist. Never copy live APNs keys or claim SSE proves APNs/Web Push.

## A08

If Tailscale is already installed/configured, take read-only
`tailscale serve status --json` snapshots before/after the test engine's
Stop/Start, update refusal and handback; compare canonical JSON digests.
The native script does exactly that, including final cleanup. Expected:
unrelated configuration identical; zero route mutation/adoption commands.
No existing route means the unrelated-route case is unconfigured. Native
test-owned exposure/handoff remains blocked by the absent network adapter;
do not run `serve reset`, disable all Serve/Funnel, or edit existing routes.

## A09

The native script corrupts **only its own selected test service's store**,
proves `KEYCHAIN_CORRUPT`, unchanged selection marker/no file fallback, then
restores the exact bytes before starting. Synthetic locked/denied/corrupt
and ownership-lock tests are in `engine-import.log` / `engine-owner.log`.

For actual lock/deny behavior use a **disposable macOS login account with no
user work**, build the same signed dev package there, and create only its
dedicated synthetic items. In Keychain Access, lock that disposable account's
login keychain, then Start the test engine. Expected: `KEYCHAIN_LOCKED`, no
listener/new keys/file fallback. Unlock it using that account's normal UI;
Start recovers the same public pins. To test denial, edit Access Control of
only the dedicated test service/item in that disposable account to exclude
the helper, then read/start with UI disabled. Expected: `KEYCHAIN_DENIED`,
unchanged item and no fallback. Restore only that test ACL and remove the
item afterward. Never lock the live user's login keychain or change its
search/default list; if a disposable account is unavailable, keep pending.

## A10

Read native `first.package`, `first.tools` and the relocated manifest.
Expected: bundled official Node, arm64, declared macOS 14 target, explicit
TEST HOME/CODEX_HOME, minimal launchd PATH, explicit child resolution; no
Homebrew-linked runtime or shell-function invocation. Run `--real-tools` only
when its existing read-only logins are available. Expected: one new tiny
prompt per available provider in `home/p2-real-tools/project`, typed final
`NIK_P2_OK`, zero resume/attach/login/logout/config writes; source login file
digests unchanged, credential snapshots removed. Unsupported flags, expired
auth, trust or permissions must remain named failures/unrun paths.

For TCC, in a disposable test account exercise each configured supported
feature under this signed identity and choose Allow, then the isolated Deny
case on a fresh test permission state. Expected: explicit denial/unavailable,
no hidden retry or assumption that editor grants apply to launchd. Do not
click prompts automatically, reset all TCC permissions, or run trust setup
against a real project. Disabled features stay unrun.

## A11

At the person's chosen time, record pins, engine ID/boot/generation, test
receipt/outbox states and the read-only route digest. With an unresolved
test operation and one queued input, use the Apple menu to Sleep, wake, and
refresh test clients. Expected: reconnect plus fresh snapshot, pins and
durable input retained, unresolved effects remain unknown, no duplicate send.
Do not assume a live provider turn survives.

Then use the actual UI to log out/in, and separately reboot/log in. Record
agent approval/enabled status first. Expected: only approved/enabled jobs
return, a new boot with the same durable engine identity/pins, safe unknown
operations. This plist has RunAtLoad and no persistent cross-login Stop
preference: Stop must remain stopped in the current login session; an enabled
agent is eligible to launch at the next login. Verify this observed session
policy explicitly. The menu's Open at Login setting controls **mainApp only**;
the independently registered engine agent can run without the menu.

## A12

Inspect scripted active Claude + owned Codex readiness/menu refusal, borrowed
Codex vectors, and the selected current handback. Expected: named
`CLAUDE_OWNED_BUSY` / `CODEX_OWNED_BUSY` / `CODEX_EXTERNAL_BUSY` or unknown-work
barrier; unchanged PID/boot on refusal; no termination of borrowed work.
Handback must use a fresh generation, retain service-created IDs/full queues,
accounting, current credentials/pins/receipt scope, reject the pre-cutover
backup, fence the old writer, and start zero providers during data activation.

Independent **real active-provider / signed replacement** acceptance needs
old/new signed TEST bundles and a supported guarded replacement path. This
package exposes no production update/import path
(`PRODUCTION_CUTOVER_DISABLED`); do not force a process-kill replacement or
turn the data-only importer into a provider resume. `--real-tools` proves
fresh minimal-environment CLI operation separately, not live-turn transfer.
Keep this independent gate blocked until that test path exists.

## T63

Read relocatedSignature/signaturesTargetAndNodeEntitlements/hardenedJitAndWasm
and the bundle manifest in native `result.json`. Expected: official archive
version/arch/checksum, signed sealed engine/media/helpers, minimal permitted
entitlements, macOS 14 binaries/plists, relocation without shell/runtime
dependencies. On a separately available minimum supported OS, repeat the
native command and record OS/build; a newer OS pass does not prove 14.0.

## T64

Read native crash/new-boot, intentional Stop >13 seconds, explicit Start and
unregister/cleanup evidence. For approval denial, use the disposable account:
open System Settings → General → Login Items & Extensions; deny/disable only
NikEngine Dev, inspect the menu's actual agent/login statuses and press Start.
Expected: requiresApproval/disabled diagnostic and no bootstrap/kickstart
bypass. Re-enable only that entry, then Start succeeds. Test the **Open at
Login** toggle separately: main app registration never implies engine-agent
approval. Restore that toggle to off before deleting the bundle.

## T65

Execute A10; retain tool executable versions and explicit missing/unrun
features. One cached private-home resolver lookup is not real tool trust or
TCC acceptance. No login/config/trust change is an acceptable test repair.

## T66

Read realKeychainAndRebuild, the signed service probe's UTF-8/empty/update/
duplicate/missing/delete checks, designated-requirement comparison and cleanup.
Execute A09's disposable-account locked/denied cases. Expected: exact signed
helper access, no secrets in argv/error/diagnostic logs, no new selected keys
after a refusal. No unlocked-machine pass substitutes for a lock test.

## T67

The native command verifies retained signed notifier/voice resources and
voice `check` returns `NO_MODEL` using TEST HOME. Do not download/copy the
user's VoiceInk model automatically. Actual microphone/transcription remains
unrun without an explicitly provisioned test model/audio and attended TCC.

For the retained notifier helper's permission/click test, use only the manual
test bundle and inbox; the click target below is the **test menu app**, not a
default VS Code profile:

```sh
HOME="$manual_home" "$manual_app/Contents/Helpers/NikNotifier.app/Contents/MacOS/nikui-notify" \
  --post p2-manual-notification 'P2 synthetic test' '' 'Test notification only' \
  "$manual_run/test-notification-inbox" p2-claude "$manual_app" ''
```

Choose Deny in an isolated permission state: expected visible denial/exit 2,
no duplicate. In an explicitly allowed test state post once, click once, and
verify that inbox contains `p2-claude` and only the test menu opens. This is
helper evidence only. The service's notifier/voice adapters are disabled;
current-engine/provider click routing remains blocked, not passed.

## T68

Complete A01–A06 with independently recorded native editor/old/new phone
builds. Keep the scripted protocol-client evidence separate. Confirm menu
Quit/Cmd-Q leaves engine PID/boot alive; Stop changes engine state; Start
resumes. Do not close or use the real user's editor windows.

## T69

Complete A07. Record SSE, iPhone APNs and Web Push separately as configured /
unconfigured / failed / passed; actual delivery after an actual supported
test import is required. Pins and preserved stored delivery records alone
do not prove delivery through an unconfigured adapter.

## T70

Complete A03–A05, A08 and A12. Record old/new package hashes, busy/unknown
refusal, fresh approval behavior, current handback and unrelated-route digest.
The scripted signed source + synthetic owner/data receiver is not an actual
production switch or a running replacement service. Retain that limitation.

## T71

Complete A11's sleep/wake, logout/login and reboot with timestamps and before/
after boot/scope/pin/operation evidence. Do not issue scripted `pmset sleepnow`,
`shutdown`, logout AppleScript, or session-wide process kills.

## T72

Before a human-approved test, inspect `pmset -g assertions` and
`pmset -g custom` read-only. Confirm default-off policy creates no holder.
The current signed runtime reports `policy.fake: true`; actual assertion,
lid/watchdog recovery and generation-owned notification tests are **blocked
by unavailable native adapters**. After such an adapter exists, on a suitable
disposable test machine with previously approved lid setup: start synthetic
Claude/Codex work, verify one generation-owned holder/banner, close clients,
Stop/logout and verify release; exercise only that adapter's owned-residue
recovery. All unrelated assertions/sleep policy must survive. Do not install
sudoers, change `pmset`, or replace a live watchdog to get a green result.

## Manual cleanup

Turn **Open at Login off** for this test menu app before quitting it. If
approval was denied, remove/disable only its test main-app entry through the
same Login Items UI. Quit the exact test app (`"$manual_ctl" quit-app`),
intentionally stop the running test engine, then
`"$manual_ctl" unregister`. Verify the exact dev job is absent. Do not stop
anything if socket PID/root and selected job do not agree.

Delete only the selected synthetic store and minted transfer accounts:

```sh
node - "$manual_app" <<'JS'
const fs = require('fs'), path = require('path');
const app = process.argv[2], c = JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/engine/mac-engine.json')));
const adapter = require('./src/keychainStore').createSecItemAdapter({
  helper: path.join(app, 'Contents/Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
  home: c.testHome, service: c.keychainService
});
require('./src/acceptanceTransfer').cleanupTransferAccounts(c.root, adapter);
adapter.delete('store.v1');
if (adapter.read('store.v1') !== null) throw Error('TEST_ITEM_REMAINS');
console.log(JSON.stringify({ cleanup: true, service: c.keychainService }));
JS
```

Retain `selection.json` and evidence. Remove only this generated `.app` after
job/main-app registration and item cleanup are proved. Leave uncertain
cleanup as a failed/pending result with the exact test path, rather than
removing the helper needed to finish it.
