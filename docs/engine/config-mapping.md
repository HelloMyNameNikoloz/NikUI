# P1-02 configuration mapping

R08, 2026-11-20. This table covers all **58** keys in [`package.json`](../../package.json)'s `contributes.configuration.properties`, in manifest order. It specifies the service adapter's policy; it does not claim that adapter or a daemon settings API exists. [`src/config.js`](../../src/config.js) now reads the existing 21-field manager/rendering view from an injected `get/inspect` source with manifest defaults. The other keys still have their existing service/extension readers. Packaging must include the manifest as a runtime data resource for this reader. [P1-03 and P1-10](p1-breakdown.md) finish caller injection and enforce this mapping; [T06](test-plan.md#composition-and-window-regression) remains a runtime gate.

Service precedence is manifest defaults → explicit engine user values → explicitly imported, owner-approved project values **only for rows marked Yes**. A project value applies to that project, never to the whole fleet. Import records the source profile, workspace/folder URI and raw scope. Merely opening an editor workspace does not import its settings. Reject unsupported project keys rather than silently applying them. Window mode keeps its existing VS Code scope and writes throughout extraction.

“Engine user setting” means a service-owned preference, including defaults delivered to existing web clients; it grants no authority. “Editor-only” remains with the extension and is excluded from daemon policy/import. “Machine-policy local-only” requires enrolled local-owner administration for setup and unrestricted changes; projects and generic remote setters cannot write it. The existing **curated** keep-awake/lid switches are the two explicit remote exceptions described below. Capability advertisement and settings values never grant access. No contributed key contains a secret value.

| Contributed key | Service disposition | Per-project override allowed? | Service behavior / allowed change |
| --- | --- | --- | --- |
| `nikui.claudePath` | Machine-policy local-only | No | Owner-selected executable; explicit resolver, never a project or phone path. |
| `nikui.model` | Engine user setting | Yes | Default for new/restarted Claude runs; existing curated control setting remains. |
| `nikui.permissionMode` | Engine user setting | No | Owner's execution-policy default. Preserve the existing curated `permissions` control-seat switch; no project escalation or generic remote policy setter. |
| `nikui.extraArgs` | Machine-policy local-only | No | Arbitrary CLI flags can change tools, policy and filesystem reach. |
| `nikui.keepInstancesAcrossReloads` | Editor-only | No | Controls the legacy window's keeper link. Service uses D4/D19 lifecycle rules; this cannot disable its supervisor. |
| `nikui.longCommandsInBackground` | Engine user setting | Yes | Claude instruction applied at run start; not a process supervisor. |
| `nikui.autoTitleFromTicket` | Engine user setting | Yes | Naming preference; hand-given titles still win. |
| `nikui.fontFamily` | Engine user setting | Yes | Compatibility default for shared web transcript rendering; native clients retain their own appearance. |
| `nikui.fontSize` | Engine user setting | Yes | Shared web rendering default / curated setting; app shell ignores this size and uses its own preference. |
| `nikui.promptSnippets` | Engine user setting | Yes | Shipped defaults merged with explicit values; empty string disables one. Preserve prompt bytes and provenance; private content, not credential storage. |
| `nikui.promptSnippetDescriptions` | Engine user setting | Yes | Commands catalog metadata, merged with shipped descriptions in the Commands adapter. Keep aligned with snippet scope. |
| `nikui.pauseWhenQuotaRuns` | Engine user setting | No | Account-wide pause policy, not a project's independent quota switch. Existing curated control setting remains. |
| `nikui.resumePrompt` | Engine user setting | Yes | Nudge text for a cut-off instance; adapter must resolve that instance's project. |
| `nikui.notifyOnAttention` | Engine user setting | No | Existing attention/audience policy; one generation owns local presentation. |
| `nikui.notifyWhenDone` | Engine user setting | No | Local notification preference plus existing device-delivery coupling; curated control setting remains. |
| `nikui.notifyWhenDoneSound` | Engine user setting | No | Local chime preference; curated control setting remains. |
| `nikui.watchCIAfterPush` | Engine user setting | Yes | Existing Claude CI policy. Does not enable Codex CI automatically. |
| `nikui.notifyCI` | Engine user setting | No | Notification preference; existing curated control setting remains. |
| `nikui.interruptOnSingleEscape` | Engine user setting | Yes | Shared web input default / curated setting; each action still needs current control/run authority. |
| `nikui.maxTranscriptItems` | Engine user setting | Yes | In-memory display retention; never truncates authoritative outbox payloads or provider transcripts. |
| `nikui.keepHiddenPanelsWarm` | Editor-only | No | VS Code webview retention; no engine lifetime effect. |
| `nikui.clock` | Engine user setting | No | Shared web/Slack display default; native client preference remains local. |
| `nikui.replySuggestions` | Engine user setting | Yes | Shared web suggestion default; does not authorize an automatic send. |
| `nikui.showThinking` | Engine user setting | Yes | Shared web rendering default; provider execution is unchanged. |
| `nikui.statusEmoji` | Editor-only | No | VS Code panel-title decoration. The compatibility reader still supplies it to panels. |
| `nikui.effort` | Engine user setting | Yes | Claude run default; preserve existing curated control setting. |
| `nikui.outputStyle` | Engine user setting | Yes | Claude run default; empty retains provider default. |
| `nikui.groupByProject` | Editor-only | No | Legacy tree grouping. Each future client owns its own grouping/selection. |
| `nikui.remote.port` | Machine-policy local-only | No | Loopback listener policy. P1 fixture chooses a private ephemeral port explicitly. |
| `nikui.remote.autoStart` | Machine-policy local-only | No | Preserve true manifest default and explicit source opt-outs; importing a value cannot start production service before P2 commit. |
| `nikui.remote.tailnet` | Machine-policy local-only | No | P1 fake/disabled; P2 exact recorded-route ownership and explicit scope acceptance. |
| `nikui.remote.terminal` | Machine-policy local-only | No | Enables shell feature; a paired control seat may use it only after local enabling. |
| `nikui.remote.requireEncryption` | Machine-policy local-only | No | Preserve security opt-out provenance; never weaken it to negotiate v2. |
| `nikui.remote.appOnly` | Machine-policy local-only | No | Controls remote HTTP exposure; preserve local/remote route distinctions. |
| `nikui.apns.teamId` | Machine-policy local-only | No | Apple account metadata; not a signing secret. |
| `nikui.apns.keyId` | Machine-policy local-only | No | Signing-key identifier; not private key bytes. |
| `nikui.apns.keyFile` | Machine-policy local-only | No | Reference to an external **secret** `.p8`; keep reference, never copy key bytes into settings/bundle/export JSON. |
| `nikui.apns.bundleId` | Machine-policy local-only | No | Push topic tied to the installed client. |
| `nikui.apns.production` | Machine-policy local-only | No | Delivery environment tied to the token/build. |
| `nikui.voice.enabled` | Machine-policy local-only | No | Host resource/feature policy; paired control may request transcription only after enabling. P1 uses fake availability/build tools. |
| `nikui.keepAwake` | Machine-policy local-only | No | Default false. Existing curated `awake` / `awake:set` local/control toggles remain; acquisition belongs to the generation holder. |
| `nikui.lidClosed` | Machine-policy local-only | No | Default false. Existing curated `lid` / `lid:set` toggle requires prior local setup; admin authorization/install/removal remains local and attended. |
| `nikui.notifyDevices` | Engine user setting | No | Host delivery preferences, not device keys/grants. Existing curated per-kind control settings remain. |
| `nikui.slack.enabled` | Engine user setting | No | Account-wide watching; preserve existing local/control enable switch. Credentials remain separately enrolled. |
| `nikui.repoFolders` | Machine-policy local-only | No | Owner-approved repo checkout mapping; never a project's way to enroll an arbitrary execution directory. |
| `nikui.codeRoots` | Machine-policy local-only | No | Owner-approved filesystem discovery roots; not project input. |
| `nikui.slack.vips` | Engine user setting | No | Account-wide VIP policy; existing local/control Slack action remains. |
| `nikui.slack.muted` | Engine user setting | No | Account-wide NikUI mute policy; existing local/control action remains. |
| `nikui.slack.mentions` | Engine user setting | No | Account-wide attention preference; existing curated control setting remains. |
| `nikui.slack.popupOnLaptop` | Engine user setting | No | Escalation preference; UI routing still requires an eligible local provider. |
| `nikui.slack.popupAfterMinutes` | Engine user setting | No | Escalation delay; existing curated control setting remains. |
| `nikui.slack.alarmOnPhone` | Engine user setting | No | Delivery preference; existing curated control setting remains. |
| `nikui.slack.alarmAfterMinutes` | Engine user setting | No | Escalation delay; existing curated control setting remains. |
| `nikui.slack.previewOnPhone` | Engine user setting | No | Notification-content preference; existing curated control setting remains. |
| `nikui.codexPath` | Machine-policy local-only | No | Explicit executable resolution, independent of Claude. |
| `nikui.codexAccount` | Machine-policy local-only | No | One canonical resolved home in P1; no cross-project account switch or implicit second account. |
| `nikui.codexComputerUse` | Machine-policy local-only | No | Host tool/TCC reach; no project or paired enable path. |
| `nikui.codexXcode` | Machine-policy local-only | No | Host MCP/tool reach; no project or paired enable path. |

The existing curated allowlists in [`prefs.js`](../../src/prefs.js) and [`slackRoom.js`](../../src/slackRoom.js) are preserved, including model/effort/permissions and previously approved power toggles. “No project override” does not revoke an existing authenticated phone control action. Conversely, control is insufficient to set executable paths, enroll credentials, install lid authorization, change account/tool reach or expose a network route. Validate row ID/value, current grant, scope and any required local approval before committing a setting. Full settings management stays local at P2/T55.

Secret disposition is separate from contributions: host private identity, VAPID private key, four Slack SecretStorage credentials and device delivery bearers belong to the private secret/delivery stores in the [state inventory](inventory-state.md#mementos-and-secrets). Client signing keys stay on the client; provider auth stays in provider homes; APNs private key bytes stay at the owner-selected reference or an explicitly approved Keychain import. No secret is a project override or an ordinary user-setting value. P1's secret file is synthetic/test-only; the signed SecItem adapter is a P2 prerequisite.

R07/R08 added injected config/manager readers, manifest defaults/snippets, explicit window callers and isolated machine-host settings. R09 enforces this mapping in `daemonConfig.js`: the isolated daemon rejects editor imports, unknown keys, invalid contributed values and unsupported project overrides. Project records require owner approval, private paths and source provenance. Session construction/resume, shared host rendering/snippets and CI auto-watch receive scoped readers; curated writes cannot change arbitrary machine policy. Production import and full local management remain P2. See the private configuration format and limits in [nikd.md](nikd.md).
