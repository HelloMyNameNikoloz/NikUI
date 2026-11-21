# Private P1 daemon

`src/nikd.js` is the isolated development entry. It requires an absolute `--root`; it has no default root, production import, production keeper adoption or installed background job. Ordinary extension activation still uses the window engine. R19 enables negotiated v2 only after this private composition has recovered its authority and bound `127.0.0.1`; old clients independently pin v1. The port is ephemeral unless `--port` is supplied. A taken explicit port refuses. Arbitrary/partial `RemoteServer` construction remains capped at v1, including a caller-supplied `testOnlyV2` option.

All state and provider homes live below the private root. The root and its directories must be owned by the current UID with mode `0700`. Symlinks, foreign-owned entries, linked secret files, editor profiles, `globalStorage`, HOME itself and socket paths of 104 bytes or more refuse startup. The `0600` root lock is created with `O_EXCL` and contains a pid and token. Recovery requires a proved dead pid **and** an absent/refused socket, rechecked under an exclusive recovery lock. Live, unreadable or unproved endpoints are never removed. A leftover recovery lock produces a named refusal for manual fixture inspection.

The `0600` `<root>/c.sock` is protected by its containing `0700` directory, per S3; Node does not claim a peer-UID API. One newline-delimited JSON request is accepted per connection, bounded to 8 KiB and five seconds:

- `{"op":"status"}` and `{"op":"doctor"}` return mode, generation, private account, listener, owned services, tool diagnostics and blockers. They omit secret records, enrollment keys, conversation content, raw errors and request payloads.
- `{"op":"enroll","kind":"local"}` returns a generation-local LocalKey over this owner-only socket and grants no editor seat. `kind:"editor"` creates/proves a persistent synthetic development enrollment; the extension awaits SecretStorage persistence before opening its connection. Arbitrary `caps`/`from` fields grant nothing. HTTP has no enrollment endpoint. Keys never enter page JavaScript or status output.
- Authenticated `connect` switches this same private socket to a bounded streaming development bridge. Fleet/conversation application lanes negotiate independently; editor registrations and correlated requests are connection-bound. See [development-window.md](development-window.md) for opt-in, supported methods and the visible no-fallback behavior. Production enrollment/revocation/import remains P2.

Local CLI equivalents are `node src/nikd.js --root /short/private/root status`, `doctor` and `enroll`. Enrollment deliberately returns a secret to the local owner; do not save its response as a public diagnostic.

Doctor also works when startup is blocked. A dead `<root>/owner.lock.reap` produces an exact shell-quoted `manualFix` command to remove only that recovery lock, after its pid and the root owner are proved dead and the control endpoint absent. It explicitly requires all starts for the root to be stopped first. A live/unproved owner or endpoint never gets a removal command. Doctor never performs the fix. Offline JSONL diagnostics inspect existing bytes without acquiring a writer or creating/resetting an authority.

`secrets.test.json` and the private engine/workspace stores are marked `nikd-isolated-p1`, version 1, and atomically written as `0600` files. Fresh roots generate synthetic host/VAPID keys once. Existing corrupt, incomplete or newer data refuses instead of regenerating. These are separate from the [P1 JSONL authority](jsonl-authority.md), and are not production secret adapters. P2 requires the signed SecItem helper before production import. The daemon opens `state/authority.jsonl` before starting services and refuses startup on an unavailable authority. R19 status reports `networkReceipts:true` only while the composed isolated daemon is running, with protocol 2, admission/drain counts and lifecycle stages.

An explicit in-process `adapters.keeper` fixture enables daemon-owned continuity using only `<root>/keeper/k1.sock`; the CLI still cannot launch providers. The persisted `nikd.keeper.v1` manifest records exact run/instance/cwd/conversation eligibility before spawn and updates it with checkpoints. Only those restored instances can attach; unrelated orphans are not adopted. Keeper protocol stays 1, with additive metadata and opt-in atomic guards. Metadata learned on init is checkpointed before a result is needed. Another live owner, a duplicate conversation, unknown/partial metadata or an old keeper produces a named `KEEPER_*` blocker with no direct-child fallback or keeper replacement. Lost/incompatible runs report continuity loss rather than automatically respawning. Only fixture adapters are enabled in P1; source-instance transfer remains P2.

Tools resolve as configured absolute path → known directories → one cached `zsh -lic` binary lookup (`whence -p`) → missing with a fix hint. The shell has private HOME/ZDOTDIR, a minimal PATH and a timeout. A marker excludes shell startup chatter. Children receive the cached login PATH and an explicit private CODEX_HOME. Doctor explains the Claude/Codex function bypass and outstanding folder-trust checks. The CLI never launches real providers, terminal commands, exposure tools, native notifications, power assertions or voice builds. In-process fixtures inject fake providers, Slack, PR runners, terminals and voice to exercise the actual factories. Disabled features stay unavailable.

An optional owner-created `0600` `<root>/config.json` uses `{ "version": 1, "user": {}, "projects": [], "tools": {} }`. `tools` maps names to absolute executables. `user` accepts service keys without `nikui.`. Project records require `{root, approved:true, provenance:{profile,workspace,rawScope}, values}` and stay below private engine HOME. The [58-key mapping](config-mapping.md) is enforced: editor values, invalid values and unsupported project keys refuse. Scoped session, rendering, snippets, resume and CI readers preserve project boundaries. Curated writes cannot change arbitrary machine policy. This is fixture setup, not a source-profile import or network settings API.

P1 power/local notification composition uses an explicit shared generation authority and recording adapters. Codex busy is an explicit count beside Claude. Defaults remain conservative; listener-only policy never holds a closed lid. Recovery precedes assertions, and old power/watchdog/banner release finishes before another generation acquires. Clicks revalidate generation and target. Existing window power, notification and click behavior is unchanged; real acceptance is P2.

Run this smoke fixture from the repository. It starts and signals only its own child under a temporary HOME, then removes the fixture:

```sh
node <<'NODE'
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nikd-'));
const child = spawn(process.execPath, ['src/nikd.js', '--root', path.join(home, 'd')], {
  env: { HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => {
  output += chunk;
  if (output.includes('\n')) { console.log(JSON.parse(output).mode); child.kill('SIGTERM'); }
});
child.stderr.pipe(process.stderr);
const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
child.on('close', (code, signal) => {
  clearTimeout(deadline); console.log('exit', signal || code);
  fs.rmSync(home, { recursive: true, force: true });
  process.exitCode = code === 0 && !signal ? 0 : 1;
});
NODE
```

SIGTERM closes admission before drain, cancels automatic queue scheduling, closes viewers/providers, drains owned factories/connections, removes only its own socket/lock and exits 0. Exceptions/rejections emit a redacted diagnostic and exit nonzero. A failed drain records the failing stage and retains its ownership fence; CLI timeout diagnostics include the current lifecycle stage. Closing all viewers keeps the daemon alive. Private tests cover the distinction; final launchd/controller behavior remains P2 packaged acceptance. The complete evidence boundary and five-round P2 plan are in [p1-exit.md](p1-exit.md).
