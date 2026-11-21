# Remote protocol — as implemented today

Snapshot: `132b3c5d5723598699e4ae09176699bfcc4f26f6`, branch `mac-engine`, 2026-11-20. Scope: HTTP bootstrap/delivery and JSON WebSocket messages between `src/remote.js` / `src/hub.js` / `src/slackRoom.js` and current browser, Capacitor and native iPhone clients. This is **not** a proposed nikd contract. Fields below exclude the ubiquitous `type`; `?` means optional/conditional, not necessarily validated. `C→S` client to server; `S→C` server to client. Mutation flags: **M** provider/persisted/machine change; **V** view/subscription state; **R** read; side effects called out explicitly. Entity IDs are distinguished from correlation IDs.

R08 cross-review: the injected config seam and notification inbox recovery do not change this v1 vocabulary. Source line anchors below remain tied to the baseline. The shared v2 corpus specifies future behavior; its reader passes do not upgrade any current client/server. See [p0-gate.md](p0-gate.md) for measured evidence and later gates.

## Endpoints, framing and authority

| Surface | Contract / source |
| --- | --- |
| Listener | HTTP bound explicitly to `127.0.0.1`, one server per VS Code window (`src/remote.js:365`, `src/remote.js:395`). Preferred port4517; EADDRINUSE can choose random port (`src/remote.js:352`). Tailscale/cloudflared provide remote TLS/proxy ingress. |
| Guards | Peer socket must be loopback; Host in loopback names or configured public host; Origin same host or named app origin (`https://localhost`, `capacitor://localhost`, `ionic://localhost`); absent Origin allowed; local development origins only for unforwarded loopback (`src/remote.js:433`, `src/remote.js:456`, `src/remote.js:467`, `src/remote.js:485`). These are not device grants. |
| HTTP local bootstrap | `?key=<LocalKey>` / `Authorization: Bearer …` / `nikui` cookie (`src/auth.js:241`); accepted only loopback Host + no proxy headers (`src/auth.js:40`). Query bootstrap302 strips key and sets HttpOnly SameSite=Strict cookie (`src/remote.js:593`). Key is random256-bit, per server object/window activation (`src/auth.js:29`). |
| WebSocket endpoint | Upgrade `/socket` for fleet, `/socket?session=<instance-id>` for one conversation (`src/remote.js:926`, `src/remote.js:953`). RFC6455 version13, UTF-8 JSON text; own framer, masked client frames, no extension/compression (`src/wire.js:15`, `src/wire.js:171`). Max24MiB message (`src/wire.js:32`), max32 sockets (`src/remote.js:46`). |
| Liveness/backpressure | Ping30s; close after two previous pings unanswered (`src/remote.js:1818`). Output backlog >8MiB tracked for20s, hard cap96MiB (`src/remote.js:52`, `src/remote.js:1872`). Not a replay log. |
| Fleet binding | After auth, no session query → fleet dispatcher (`src/remote.js:998`, `src/remote.js:1011`). |
| Conversation binding | Session query resolved from live manager or Codex workspace; attaches SessionHub (`src/remote.js:972`, `src/extension.js:1020`). Normal messages to hub except voice intercepted first (`src/remote.js:979`). |
| Local seat | Authenticated LocalKey → `{id:'local',name:'This machine',kind:'local',control:true}` (`src/auth.js:58`). VS Code webview bypasses remote auth and attaches without device (`src/panel.js:88`). |
| Device seat | Paired signing key → `{id,name,kind:'device',control}`; new device control=false (`src/auth.js:209`, `src/devices.js:80`). Grants updated on live sockets; forgotten devices closed immediately (`src/remote.js:1758`). |
| App-only mode | Remote HTML/assets/workers hidden; only method-specific pair/push/listen/health/APK endpoints retained, WebSocket upgrade separately guarded (`src/remote.js:581`, `src/remote.js:2057`). Default false. |

## Handshake and sealing

**There is no `@seal` message.** Current messages are `@challenge`, `@auth`, then optional `@box`; the first encrypted payload is `@welcome`. All sockets, including LocalKey browsers, are challenged (`src/remote.js:967`).

| Direction / type | Fields | Checks / mutation / source |
| --- | --- | --- |
| S→C `@challenge` | `nonce,epk,serverKey,fingerprint` | `nonce`32 random bytes base64url, ephemeral P-256 SPKI DER, host long-term SPKI/fingerprint. Challenge10s (`src/auth.js:112`, `src/auth.js:120`, `src/remote.js:1828`). |
| C→S `@auth` (paired) | `device,nonce,signature,epk?,rekey?` | Device ID; client nonce≥16 chars; P-256 ECDSA signature (SHA-256, IEEE-P1363 64-byte r+s, base64url). `rekey={publicKey,signature,protection?,biometric?}` proves both old and new keys (`src/auth.js:142`, `src/auth.js:163`, `src/identity.js:71`). Authentication touches persisted lastSeen/address; rekey mutates key record. |
| C→S `@auth` (LocalKey) | `nonce`, no `device` | HTTP key already accepted; no device signature or sealing required. If a paired-auth verdict fails **and allowLocal is true**, server falls back to LocalKey welcome (`src/remote.js:1909`, `src/remote.js:1915`). |
| S→C `@welcome` | `device,signature,version?,rekeyed?` | Host proof, seat, extension/package version; `rekeyed={fingerprint,protection}` confirms replacement. Box installed before welcome sent (`src/auth.js:217`, `src/auth.js:227`, `src/remote.js:1843`). No protocol/capability-negotiation fields. |
| S→C `@denied` | `reason,pair?` | `pair:true` for unpaired caller without usable LocalKey; closes1008 (`src/remote.js:1857`, `src/remote.js:1912`). |
| Both `@box` | `n,c` | `n` integer counter0…2^48−1; `c` base64url(ciphertext followed by16-byte AES-GCM tag). Strict increasing receive counter, distinct directional AES-256 keys/nonces. Crypto version is HKDF context `nikui-e2e:v1` (`src/secure.js:29`, `src/secure.js:77`, `src/secure.js:108`). |

Normal auth signature text: `nikui-auth:<serverNonce>:<clientNonce>[:<binding>]`; rekey text: `nikui-rekey:<serverNonce>:<clientNonce>:<newKeyFingerprint>[:<binding>]`; host text: `nikui-host:<clientNonce>:<serverNonce>[:<binding>]`. `binding=base64url(SHA256(serverEphemeralDER || clientEphemeralDER))` (`src/auth.js:178`, `src/auth.js:183`, `src/auth.js:221`, `src/secure.js:66`). ECDH shared secret → HKDF-SHA256, salt SHA256(serverNonce + ':' + clientNonce),88 bytes of directional32-byte keys +12-byte bases; counter XOR into low6 nonce bytes (`src/secure.js:77`, `src/secure.js:90`).

Paired sealing required by default; can be disabled for old clients (`src/auth.js:179`, `src/extension.js:1090`). Once a box exists, plaintext application frames close1008; invalid/replayed ciphertext closes1008 (`src/remote.js:1939`). Before authentication, every message except `@auth` is dropped, not queued (`src/remote.js:1905`). Transport counters prevent replay **on that connection only**, not duplicate mutations across reconnects.

## Transport messages after authentication (either socket)

| Direction / type | Fields | Mutation / receipt / source |
| --- | --- | --- |
| C→S `@apple` | `token` | **M** register APNs token on authenticated paired-device record; hex sanitized, length32…200 (`src/remote.js:301`, `src/devices.js:189`). No ack; LocalKey seat not registered. |
| C→S `@listen` | — | **M** rotate background-notification bearer; paired devices only (`src/remote.js:239`, `src/remote.js:1954`). |
| S→C `@listener` | `secret` | Random32-byte base64url bearer; server saves only SHA-256 on device. Reply has no request ID (`src/remote.js:242`). |
| C→S `app:update` | `build?` | **R** check Android APK; issues temporary download token if different (`src/remote.js:1222`, `src/remote.js:1956`). |
| S→C `app:update` | `available`; if same build `build`; if available `build,version,size,sha256,at,path` | `path='/app/update.apk?t=…'`,10min token; no request ID (`src/remote.js:1222`, `src/appUpdate.js:66`). |
| S→C `app:update:changed` | — | APK file changed; client should check again (`src/remote.js:138`). |
| S→C `@device` | `device` seat | Live name/control change; conversation hub also emits its own device update (`src/remote.js:1863`, `src/hub.js:180`). |
| S→C `@navigate` | `session` | Navigate requesting device to instance; does not itself subscribe (`src/hub.js:107`, `src/hub.js:660`). |
| S→C `@notify` | `kind,at,title,body,tag`, optional `to,session,url,renotify,conversation,alarm` | Notification delivery, no ID/ack/replay cursor. `kind`: `needs-you`, `failed`, `turn-finished`, `ci`, `quota`, `slack`. Shapes composed in `src/notify.js:76`, `src/notify.js:170`, `src/notify.js:229`, Slack `src/slackHome.js:106`; delivered `src/remote.js:213`. |

Unknown `@…` messages are discarded after special transport cases (`src/remote.js:1958`). Unknown normal types are ignored by binding. Malformed JSON is logged/dropped, not a standard error response (`src/remote.js:1895`).

## Fleet requests and replies

| C→S type | Fields | Effect / authority | S→C response and correlation | Source |
| --- | --- | --- | --- | --- |
| `ready` | — (`hidden` ignored on fleet) | **R** current fleet | `fleet`; no ID | `src/remote.js:1011` |
| `history` | `limit?` default40 clamp1…200, `cwd?` | **R** Claude History read | `history {entries,available,trouble?}`; no ID | `src/remote.js:1298`, `src/extension.js:1059` |
| `status` | — | **R** report; can lazily refresh quota | `status {report,available,trouble?}`; no ID | `src/remote.js:1259` |
| `devices` | — | **R** paired-device list | `devices`; no ID | `src/remote.js:1323` |
| `forget` | `id` **device entity ID** | **M** self permitted watch-only; another needs control. LocalKey seat refused | Changed `devices` broadcast; self socket closes1008. Failure `devices.refused`; no explicit success ack or request ID | `src/remote.js:1359` |
| `awake` | — | **R** power state | `awake`; no ID | `src/remote.js:1399` |
| `awake:set` | `on` coerced bool | **M** local/control seat, global keepAwake config | `awake`, optional `refused`; no ID | `src/remote.js:1469` |
| `lid:set` | `on` coerced bool | **M** local/control seat; existing laptop approval required | `awake`, optional `refused`; no ID | `src/remote.js:1503` |
| `codex:watch` | — | **V/R** start60s workspace poll, refresh list | Later `fleet`; no direct ack | `src/remote.js:1022` |
| `instance:new` | `id` **correlation**, `cwd,provider?,folderId?` | **M** control/local. `provider==='codex'` uses X; otherwise C. Cwd must be offered project (+existing X cwd for X); folder only used by C creator | `instance:created {id,instance}` or `@refused {id,what:'instance:new',reason}`; fleet broadcast | `src/remote.js:1154`, `src/extension.js:1043` |
| `instance:resume` | `id` **correlation**, `sessionId` provider conversation ID | **M** control/local. Looks up in own latest200 history; no device-supplied cwd/title | `instance:created {id,instance}` or `@refused {id,what:'instance:resume',reason}` | `src/remote.js:1275` |
| `instance:place` | `id` **correlation**, `instance` entity ID, `folderId?` | **M** control/local. Store place in existing folder, invalid/null folder removes assignment. No C/X rejection in handler; X fleet row lacks folder field | `instance:placed {id}` or `@refused {id,what:'instance:place',reason}` | `src/remote.js:1188` |

Correlated fleet handlers echo `message.id` without a common ID/schema validation or dedupe lookup. Handler exceptions produce `@refused {id:message.id,what:message.type,reason}` (`src/remote.js:1036`). Reply construction does **not** await a transactional durable-store commit.

| S→C type | Complete envelope fields (besides type) | Source |
| --- | --- | --- |
| `fleet` | `instances,codex,codexState,folders,projects,at` | `src/remote.js:1057`, `src/remote.js:1123` |
| `history` | `entries,available,trouble?`; entry `{mtimeMs,sessionId,file,size,modified,title,label,cwd,branch}` plus named history `customTitle?,autoLabel?` | `src/remote.js:1298`, `src/history.js:96`, `src/history.js:27` |
| `status` (fleet) | `report,available,trouble?` | `src/remote.js:1259` |
| `devices` | `devices:[{id,name,control,protection,biometric,pairedAt,lastSeenAt,here,me}],mayManage,me,refused?`; some failures return only `refused` | `src/remote.js:1323`, `src/remote.js:1365` |
| `awake` | `available`; when present `on,held,since,reason,supported,mayChange,lid`; optional `refused`. `lid={on,supported,approved,held,reason,finishing,lowBattery,battery}` or null | `src/remote.js:1399` |
| `instance:created`, `instance:placed` | `created:{id,instance}`; `placed:{id}` | `src/remote.js:1176`, `src/remote.js:1202` |
| `@refused` (fleet) | `id?,what,reason` | `src/remote.js:1036`, `src/remote.js:1156` |

`fleet.instances[]`: `{id,sessionId,label,status,cwd,cost,queued,paused,asleep,unread,activeAt,order,folder,project}`, folder `{id,name}` or null, project `{path,name}` or null (`src/remote.js:1060`). `fleet.codex[]`: `{id,label,status,cwd,queued,asleep,unread,activeAt,model,readOnly}`; Codex ID=`cx-<threadId>`, no folder/order/provider sessionId fields (`src/remote.js:1111`, `src/codex.js:41`). `codexState={loaded,error}`; `folders=[{id,name}]`; `projects=[{path,name}]` (`src/extension.js:1026`, `src/remote.js:1097`).

## Conversation requests

Remote conversation dispatch shares SessionHub with VS Code's webview. The **actual control allowlist** `STEERING` is at `src/hub.js:32`; it is not identical to “all state-changing cases.” Unauthorized entries receive `@refused {what,reason}` with **no echoed request ID** (`src/hub.js:365`).

| C→S type | Fields | Effect / authority / response today | Source |
| --- | --- | --- | --- |
| `ready` | `hidden?` bool | **R with side effects**: replay transcript; control seat may start stopped CLI, mark unread false for visible remote reader; replies `init`, then presence/known PR. No ID | `src/hub.js:382`, `src/hub.js:691` |
| `visible` | `on` (`false` means hidden) | **V/M** reader visibility; can clear persisted unread; refresh PR watcher, no ack | `src/hub.js:388` |
| `send` | `text,attachments?,sent?,snippets?` | **M**, control. Session.submit (queue/start/send/command); no client mutation ID or ack. Local paused send may invoke editor modal. `/codex …` hands off instead | `src/hub.js:497` |
| `interrupt` | — | **M**, control; session interrupt, no ack | `src/hub.js:514` |
| `stopTask` | `taskId` | **M**, control; provider task ID; X no-op; no ack | `src/hub.js:518`, `src/codex.js:1125` |
| `unqueue` | `id` **queue entity** | **M**, control; remove, later `queue` event | `src/hub.js:522` |
| `promoteQueued` | `id` **queue entity** | **M**, control; reorder or X steer live turn; later queue/items, no request ack | `src/hub.js:526`, `src/codex.js:1133` |
| `editQueued` | `id` **queue entity** | **M**, control; reclaim/remove, requester `editPrompt {text}`, queue broadcast | `src/hub.js:530` |
| `clearQueue` | — | **M**, control; queue broadcast, no ack | `src/hub.js:538` |
| `permission` | `requestId` **provider approval ID**, `allow` | **M**, control; forwards answer; on delivered=true broadcasts matching permission item with resolved allow/deny. No run identity/mutation ID/ack | `src/hub.js:542`, `src/session.js:779`, `src/codex.js:1350` |
| `status` | — | **R** `statusReport {report}` (different from fleet status shape) | `src/hub.js:556` |
| `statusOpen` | `open` | **V** start/stop coalesced report pushes; no direct snapshot/ack | `src/hub.js:560` |
| `settings` | — | **R/V** mark open, reply `settings` | `src/hub.js:572` |
| `settingsOpen` | `open` | **V** future broadcast subscription, no ack | `src/hub.js:584` |
| `setSetting` | `id` **preference row ID**, `value` | **M**, control; allowlist prefs.write; reply fresh `settings` (success has no id; failure `refused,id`). Not generic setting-path API | `src/hub.js:588`, `src/prefs.js:190` |
| `commands` | — | **R/V** mark open, reply `commands` | `src/hub.js:603` |
| `commandsOpen` | `open` | **V** broadcast subscription, no ack | `src/hub.js:608` |
| `saveCommand` | `was?,name,prompt,description` | **M**, control; reply `commands {done:'saveCommand',name,…}` or `{refused,name,…}` | `src/hub.js:612` |
| `removeCommand` / `restoreCommand` | `name` **snippet name** | **M**, control; same commands receipt with done/type/name, no mutation ID | `src/hub.js:613` |
| `allSettings` | — | **V** local-only launches editor settings; paired seats silently ignored | `src/hub.js:631` |
| `slack` | — | **V** local opens editor Slack tab; remote `@refused {what:'slack',reason}`. Actual fleet Slack API below | `src/hub.js:579` |
| `openPr` | — | **V** local-only, opens session PR URL in laptop browser; no ack | `src/hub.js:638` |
| `openFile` | `path,line?` | **M/OS**, control; opens/reveals on this window's host, **requester not passed**; no ack | `src/hub.js:644`, `src/host.js:228` |
| `runInTerminal` | `command` | **M/OS**, control; inserts command without Enter into VS Code terminal; no ack | `src/hub.js:654`, `src/host.js:217` |
| `switch` | `id` **target instance** | **V**, control allowlist; device receives `@navigate {session:id}`, webview invokes host.switchTo | `src/hub.js:660` |
| `pr:pane` | `open,tab?,width?,full?` | **M/V**, **not STEERING-gated**: writes shared persisted `session.prPane`; tabs normalized, width280…2000; emits meta | `src/hub.js:394` |
| `pr:watch` | `on` | **V** per-client PR watcher; no direct ack | `src/hub.js:413` |
| `pr:refresh` | — | **R** refresh existing PR; state updates | `src/hub.js:418` |
| `pr:diff` | — | **R** `pr:diff {diff,truncated}` or `pr:done {action:'diff',ok:false,message}` | `src/hub.js:422` |
| `pr:mentions` | `query?` ≤60 chars | **R** `pr:mentions {query,url,ok,users,teams,viewer,complete,message?}` | `src/hub.js:431`, `src/prView.js:607` |
| `pr:reply` | `threadId,body` | **M**, control; laptop `gh` write; `pr:done {action:'reply',ok,message}`, no correlation ID | `src/hub.js:439` |
| `pr:resolve` | `threadId,resolved?` default true | **M**, control; same uncorrelated `pr:done`, action resolve | `src/hub.js:440` |
| `pr:comment` | `body` | **M**, control; same uncorrelated done, action comment | `src/hub.js:441` |
| `pr:rerun` | — | **M**, control; rerun failed checks; same done, action rerun | `src/hub.js:442` |
| `pr:askThread` | `threadId` | **R/V** draft thread prompt into requester composer, `editPrompt`; no auto-send | `src/hub.js:457` |
| `pr:askCheck` | `runId,name?` | **R/V** fetch failed log, draft requester `editPrompt` | `src/hub.js:458` |
| `pr:askConflicts` | — | **R/V** draft conflict prompt if conflicting | `src/hub.js:459` |
| `pr:link` | — | **M/V** local-only editor chooser; no remote URL setter and no receipt | `src/hub.js:481` |
| `pr:unlink` | — | **M**, control; unpin, may redetect; meta event | `src/hub.js:485` |
| `pr:open` | `url` | **V** local-only + `https://github.com/` prefix; no ack | `src/hub.js:489` |

`attachments[]` are `{name,mediaType,data}` base64 images; `sent` is expanded prompt different from displayed `text`; `snippets[]` names selected expansions (`src/session.js:540`, `src/session.js:569`). IDs on queue/permission/setting/switch are resource selectors, not mutation IDs. Arbitrary additional fields are usually ignored. There is no envelope schema validator or negotiated provider action list.

Approval matching differs by provider: Claude checks that the process is running, then forwards the supplied requestId without a pending-request/run check (`src/session.js:779`); Codex requires and removes a matching `_pendingRpc` entry (`src/codex.js:1350`). Neither remote envelope binds the answer to an engine generation.

## Conversation events and shared value schemas

| S→C type | Fields besides type | Source |
| --- | --- | --- |
| `init` | `sessionId,client,items,dropped,maxItems,meta,status,stats,queue,drainAt,slashCommands,commandArgs,ownCommands,snippets,showThinking,clock,replySuggestions,singleEscape,font,fontSize` | `src/hub.js:882` |
| `items` | `items` array of full changed/upsertable items; not JSON Patch | `src/hub.js:86` |
| `meta` | `meta,slashCommands,commandArgs,ownCommands,snippets,showThinking,clock,replySuggestions,singleEscape,font,fontSize` | `src/hub.js:861` |
| `status` (conversation) | `status` string | `src/hub.js:91` |
| `stats` | `stats` | `src/hub.js:311` |
| `queue` | `queue:[{id,text,images,lostImages}],drainAt` | `src/hub.js:846`, `src/hub.js:857` |
| `reset` | — | `src/hub.js:128` |
| `presence` | `clients:[{id,name,kind,control,since}]` | `src/hub.js:267` |
| `settings` | `settings,mayChange,local,refused?,id?` | `src/hub.js:213`, `src/hub.js:596` |
| `commands` | `commands,mayChange,done?,name?,refused?` | `src/hub.js:228`, `src/hub.js:626` |
| `statusReport` | `report` | `src/hub.js:556`, `src/hub.js:931` |
| `openStatus`, `focus` | — | `src/hub.js:947`, `src/hub.js:957` |
| `draft`, `editPrompt` | `text` | `src/hub.js:742`, `src/hub.js:964`, `src/hub.js:530` |
| `pr:state` | `state,loading,error,prUrl` | `src/hub.js:115`, `src/prView.js:529` |
| `pr:diff` | `diff,truncated` | `src/hub.js:425` |
| `pr:mentions` | `query,url,ok,users,teams,viewer,complete,message?` | `src/hub.js:435`, `src/prView.js:646` |
| `pr:done` | `action,ok,message` | `src/hub.js:451` |
| `@refused` (hub) | `what,reason`; **no id** | `src/hub.js:365` |
| `@device`, `@navigate` | `device` / `session` | `src/hub.js:180`, `src/hub.js:664` |

| Value | Fields / source |
| --- | --- |
| `meta` | `label,cwd,home,model,cost,ticket,prUrl,prPinned,prPane,effort,permissionMode,provider,mode,goal,usingMac`; `src/hub.js:755`. `prPane={open,tab,width,full}`. |
| `stats` | `input,output,cacheRead,cacheCreate,total,cost,turns,elapsedMs,running,background,shells,shellList,contextTokens,contextWindow,ci`; C `src/session.js:723`, X `src/codex.js:1483` (cost0, no CI/background). |
| `status` values | `idle,working,waiting,done,error,stopped`; `src/session.js:13`. Resource lifetime/running/asleep/paused are separate state. |
| `items[]` common / text | Common `id,kind`; optional `text,at,streaming,agent`. Kinds `user,text,thinking,tool,permission,result,notice,compact`. `text` can include Markdown data-URL images (`src/session.js:1333`, `src/session.js:1413`, `src/codex.js:334`). No formal item-schema version. |
| Item kind fields | `user`: `images:[{mediaType,data,name}],snippets?` (`src/session.js:569`); `tool`: `name,input,status,result,isError,resultLength?,resultClipped?,rawInput?,agent?` (`src/session.js:1338`, `src/session.js:1396`); `permission`: `requestId,name,input,resolved` (`src/session.js:1564`); `result`: `isError,interrupted,subtype?,text,durationMs,numTurns?,costUsd?,at` (`src/session.js:1506`, `src/codex.js:826`); `notice`: `level` (`src/session.js:1626`); `compact`: `trigger,before?,at?` (`src/session.js:1000`, `src/codex.js:443`). X strips private picture-fetch fields before wire (`src/codex.js:326`). |
| Settings catalog | `{groups,rows}`; row `{id,group,kind,label,hint,value,choices?,min?,max?,note?,warn?,unavailable?}`; `choices=[{value,label}]`, `src/prefs.js:121`. IDs differ from configuration keys (`permissions`→permissionMode, `awake`→keepAwake). |
| Command catalog | Own `{name,kind:'own',usage,description}`; snippet `{name,kind:'snippet',prompt,description,summary,shipped,off,edited}` (`src/commands.js:77`, `src/commands.js:100`). No mutation ID. |
| PR state | `{url,number,repo,title,state,isDraft,author,authorAvatar,createdAt,headRef,baseRef,headSha,mergeable,reviewDecision,additions,deletions,changedFiles,updatedAt,body,commitCount,labels,assignees,checks,checkSummary,reviewers,reviews,threads,comments,files,commits,avatars,timeline,timelineTotal,fetchedAt}` (`src/prView.js:362`). Thread `{id,resolved,outdated,path,line,diffHunk,comments}`; comment `{id,databaseId,author,avatar,body,at,url,reviewId}` (`src/prView.js:307`). Diff string capped400Ki characters (`src/prView.js:684`). |
| Report | Top-level `{generatedAt,window,instance,config,totals,turns,lastTurn,tools,files,commands,hourly,runway,records,queue,git,transcript,fleet,fleetTotals,projects,lifetime,limits,codexLimits,pause,env}`; computed nested values and exact field definitions `src/report.js:302`. `env` includes editor/runtime/device/trail/power metadata (`src/host.js:179`). No schema version; report includes paths/CLI config even for watchers. |

## Remote terminal (fleet socket only)

All terminal operations, including list/read/attach, reject paired watch-only seats (`src/remote.js:1635`). Optional feature `remote.terminal` is evaluated when extension constructs Terminals (`src/extension.js:984`). It is **command/output blocks, no PTY** (`src/terminal.js:144`).

| C→S type | Fields | Mutation / reply | Source |
| --- | --- | --- | --- |
| `term:list` | — | **R** → `term:list {terminals}` | `src/remote.js:1652` |
| `term:open` | `session?` **instance entity ID** | **M** memory session → `term:opened {terminal}`; cwd from server session or home, never raw cwd field | `src/remote.js:1656` |
| `term:attach` | `id` **terminal entity ID** | **V/R** → `term:scrollback {terminal,runs}` | `src/remote.js:1679` |
| `term:detach` | `id` terminal | **V** remove subscription; no reply | `src/remote.js:1683` |
| `term:run` | `id` terminal, `command` ≤8000 chars | **M** → streamed began/out/done, or term:no; no request ID | `src/remote.js:1695`, `src/terminal.js:104` |
| `term:stop` | `id` terminal | **M** signal running child; eventual term:done, no ack | `src/remote.js:1690` |
| `term:close` | `id` terminal | **M** stops/removes memory session → `term:closed {id}` | `src/remote.js:1684` |

| S→C type | Fields / meaning | Source |
| --- | --- | --- |
| `term:list` / `term:opened` | `terminals:[Terminal]` / `terminal:Terminal`; `Terminal={id,name,cwd,busy,command}` | `src/terminal.js:77`, `src/remote.js:1652` |
| `term:scrollback` | `terminal:Terminal,runs:[Run]` | `src/terminal.js:256` |
| `term:began` / `term:done` | `terminal:Terminal,run:Run`; `Run={id,terminal,command,cwd,at,exit,note,done,tookMs,output}` | `src/terminal.js:199`, `src/terminal.js:226`, `src/terminal.js:240` |
| `term:out` | `run` **run entity ID**, `terminal` **terminal ID**, `stream:'out'/'err',text` | `src/terminal.js:217` |
| `term:closed` | `id` terminal | `src/remote.js:1688` |
| `term:no` | `reason,id?`; fleet exception path may add `what` | `src/remote.js:1637`, `src/remote.js:1036` |

Subscriptions held in `client.terminals`; events delivered only on fleet sockets watching that terminal (`src/remote.js:1714`). Terminal IDs and run IDs are **not** request correlation IDs. Shell commands use a fresh login shell; only emulated bare `cd` persists cwd; output capped~200Ki characters/run,60 runs,15min process limit (`src/terminal.js:34`, `src/terminal.js:38`, `src/terminal.js:118`, `src/terminal.js:212`).

## Voice (fleet or conversation)

| Direction / type | Fields | Mutation / result / source |
| --- | --- | --- |
| C→S `voice:state` | — | **R** control/local only, may trigger async build; `src/remote.js:1569` |
| S→C `voice:state` | `available`, optional `code,reason,building,needsBuild,model` | Feature/build/model availability; `src/voice.js:232`, `src/remote.js:1572` |
| C→S `voice` | `id` **correlation string truncated64 chars**, `audio` base64 WAV | Resource job; temporary recording, no transcript/provider send; control/local required. ≤300s/9,600,044 bytes; `src/remote.js:1594`, `src/voice.js:34` |
| S→C `voice:text` | `id,text,seconds,ms` | Correlated success; composer text for user review, not durable prompt acceptance (`src/remote.js:1620`) |
| S→C `voice:no` | `id,code,reason` | Correlated failure. Codes may include `OFF,WATCH_ONLY,NO_AUDIO,TOO_LONG,BAD_AUDIO,BUILDING,BROKEN,UNSUPPORTED,NO_MODEL,FAILED,TIMEOUT` (`src/remote.js:1594`, `src/voice.js:265`). |

## Slack (fleet socket or local Slack webview)

`RemoteServer.slackFor` joins SlackRoom with local/control/device seat (`src/remote.js:1446`). Conversation socket `slack` just opens local editor tab; it is not a relay for `slack:*`. Local-only below means trusted webview/LocalKey seat, **not** merely paired-control device.

| C→S type | Fields | Effect / authority / response | Source |
| --- | --- | --- | --- |
| `slack:ready` | — | **R** → `slack:state` | `src/slackRoom.js:169` |
| `slack:open` | `conversation` ≤40 chars, `thread?` ≤40 | **V/M** changes selected thread, marks *seen in NikUI* (suppresses escalation), does **not** write Slack read marker → `slack:thread` | `src/slackRoom.js:172` |
| `slack:refresh` | — | **R** refresh sidebar → broadcast state | `src/slackRoom.js:212` |
| `slack:older` | `conversation,thread?,before` ≤40 each | **R** page older messages → `slack:older` | `src/slackRoom.js:220` |
| `slack:file` | `id` **Slack file ID**, ≤100 | **R** lazy image fetch → `slack:file {id,ok,dataUrl?,reason?}` | `src/slackRoom.js:238` |
| `slack:reply` | `id` **correlation**, `conversation,text,thread?`; text≤12000 chars | **M**, control/local; sends as laptop user and marks Slack read → `slack:sent {id,ok,reason?}`, thread refresh to watchers | `src/slackRoom.js:184`, `src/slack/service.js:1016` |
| `slack:mute` | `conversation,muted` | **M**, control/local; updates NikUI mute settings, cannot unmute Slack-owned mute → state/refused | `src/slackRoom.js:248` |
| `slack:vips` | `vips` array | **M**, control/local; clean≤50 unique entries, each≤100 chars → state | `src/slackRoom.js:267` |
| `slack:enable` | — | **M**, control/local; writes enabled=true → state | `src/slackRoom.js:281` |
| `slack:connect` | — | **M/V**, local-only; editor credential dialogs → state | `src/slackRoom.js:286` |
| `slack:disconnect` | — | **M**, local-only; delete four stored secrets → state | `src/slackRoom.js:287`, `src/slackHome.js:158` |
| `slack:settings` | — | **V**, local-only; opens editor settings → state | `src/slackRoom.js:288` |
| `slack:signIn` | `token,cookie` | **M**, local-only; verifies and stores session credentials → `slack:signedIn {ok,message?,who?}` + state | `src/slackRoom.js:302`, `src/slackHome.js:244` |
| `slack:setup` | — | **V/R** local opens setup URL; remote gets `slack:link {url}` | `src/slackRoom.js:313` |
| `slack:openTicket` | `url` ≤400 | **M/V**, local-only; allowlisted GitHub PR/issue URL focuses/resumes/creates instance → `slack:openTicket {url,ok,how?,reason?}` | `src/slackRoom.js:321` |
| `slack:link` | `conversation,ts?` | **R/V** permalink or fallback slack://; local opens URL, remote receives `slack:link {url}` | `src/slackRoom.js:332` |

| S→C type | Fields (besides type) | Source |
| --- | --- | --- |
| `slack:state` | `state` (schema below) | `src/slackRoom.js:107`, `src/slackRoom.js:128` |
| `slack:thread` / `slack:older` | `conversation,thread,messages,hasMore`; thread conversation is object, older echoes requested conversation ID | `src/slackRoom.js:220`, `src/slackRoom.js:352` |
| `slack:sent` | `id,ok,reason?` | `src/slackRoom.js:187` |
| `slack:file` | `id,ok,dataUrl?,reason?` | `src/slackRoom.js:238`, `src/slack/service.js:973` |
| `slack:refused` | `what,reason`; no correlation ID | `src/slackRoom.js:165`, `src/remote.js:1449` |
| `slack:signedIn` | `ok,message?,who?` | `src/slackRoom.js:303` |
| `slack:openTicket` | `url,ok,how?,reason?` | `src/slackRoom.js:321` |
| `slack:link` | `url` | `src/slackRoom.js:315`, `src/slackRoom.js:344` |
| `slack:focus` | `conversation,reason` | Only local seats receive popup focus (`src/slackRoom.js:139`, `src/slackPanel.js:79`) |

Slack `state`: `{connected,socket,mode,error,me,unresolved,vips,conversations,sidebar,enabled,hasTokens,vipList,mutedList,clock,mayReply,mayEdit,local,setupUrl,signedOut?}` (`src/slackRoom.js:107`, `src/slack/service.js:1048`). `sidebar={loaded,at,items}`; sidebar item `{id,kind,title,private,user,latestAt,unread,mentions,last,pending,pendingSince,vip,muted,mutedIn}` (`src/slack/service.js:754`). Conversation `{id,kind,title,with,vip,pending,lastAt,last,pendingSince?}`, with flattened `last={text,from,ts}` in state (`src/slack/service.js:459`, `src/slack/service.js:1069`). Message `{ts,user,name,initials,mine,html,edited,files,reactions,at,threadTs,replyCount}`; file `{id,name,title,mimetype,image,w,h,permalink}`; reaction `{name,emoji,count,mine}` (`src/slack/service.js:912`, `src/slack/service.js:938`). Credentials are excluded from state responses.

## HTTP messages outside WebSocket

| Endpoint / direction | Request / response fields | Mutation / authentication / source |
| --- | --- | --- |
| GET/HEAD `/health` | Response `{ok:true}` | **R**, public after ingress guard; proves only HTTP liveness, not host identity (`src/remote.js:610`). |
| POST `/pair` | Request `{code,name,publicKey,signature,protection?,biometric?}`; response `{device,name,control,serverKey,fingerprint}`; error `{error}` | **M** claim60s one-use code; wrong guess closes window; signature over `nikui-pair:<trimmed-uppercase-code>` using offered P-256 key. Claim consumed before key proof; rate limits,8KiB body. `src/remote.js:795`, `src/pairing.js:25`, `src/pairing.js:149`. |
| GET/HEAD `/push/key` | `{key}` raw P-256 VAPID point base64url or null | **R**, public key, `src/remote.js:615`. |
| POST `/push/subscribe` | `{device,endpoint,keys:{p256dh,auth},at,signature}` → `{ok:true}` or `{error}` | **M** subscription; signature `nikui-push:<at>:<endpoint>`, time within60s; endpoint HTTPS allowlisted push domains; no separate request ID/dedupe. Signature covers endpoint/time, **not keys** (`src/remote.js:716`, `src/remote.js:742`, `src/remote.js:2085`). |
| GET `/notify/listen` | `Authorization: Bearer <43-char listener secret>` → SSE `: listening`, periodic `: ping`, `event: notify\ndata: <JSON @notify>` | **R/V** persistent notification stream, no command channel; bearer hash matches current device; rekeyed listener/forgotten record closes on next write (`src/remote.js:257`, `src/remote.js:285`). No SSE id/backlog/replay. Ping30s (`src/remote.js:2067`). |
| GET/HEAD `/app/update.apk?t=<token>` | APK bytes; response410 when invalid/build changed/device gone | **R**, possession of current short-lived device-bound download URL; no standard mutation ack (`src/remote.js:1242`, `src/appUpdate.js:80`). |
| GET `/`, `/s/<id>`, `/pair`, `/media/*`, `/sw.js`, `/manifest.webmanifest` | Static shells/assets, no session data until authenticated socket | Asset/UI surfaces (`src/remote.js:559`); app-only can suppress remote pages. Pairing links carry code/fingerprint in fragment (`src/pairing.js:107`), not request path. |

## IDs, receipts, compatibility and missing contracts

| Area | What exists now | What does **not** exist |
| --- | --- | --- |
| Correlated mutations | `instance:new/resume/place` echo `id`; Slack reply echoes `id`; voice echoes bounded `id` | Global mutation envelope, durable receipt lookup/commit, bounded cross-reconnect dedupe. Repeating same ID currently repeats handler. |
| Uncorrelated writes | PR `pr:done` names action; settings sends snapshot; commands done/type/name; terminal emits entity/run events; permission resolved item | No way to match two simultaneous identical actions reliably across clients/reconnect; entity IDs are not operation IDs. |
| Prompt delivery | `send` creates user item/queue/provider write; native tracks local pending operation and recognizes later evidence (`app/iphone/NikCore/Sources/NikCore/ClientOperations.swift:21`, `app/iphone/NikCore/Sources/NikCore/ClientOperations.swift:93`, `app/iphone/NikCore/Sources/NikCore/ClientOperations.swift:248`) | No client-supplied send ID, `accepted` ack, durable queue receipt, provider-run receipt or engine dedupe. Local generated native operation UUID is **not added** to send JSON (`app/iphone/NikCore/Sources/NikCore/Protocol.swift:134` in same directory). |
| Provider IDs | Codex generates `clientUserMessageId` when forwarding (`src/codex.js:1087`, `src/codex.js:1204`); approval requestId exists; keeper dedupes control_response in RAM (`src/keeper.js:158`) | Stable remote operation→provider execution identity across restart. Codex IPC start failure requeues even after possibly accepted request (`src/codex.js:1214`). |
| Client reconnect | Browser resends `ready` only and preserves offline send text via `editPrompt` (`media/transport.js:492`, `media/transport.js:517`); native restores subscriptions, **not** ambiguous writes (`app/iphone/NikCore/Sources/NikCore/Transport.swift:287`) | Server event replay cursor/sequence, immutable revision, durable receipt reconciliation. `@box.n` is only transport encryption counter. |
| Versioning | `@welcome.version` = extension package version (`src/remote.js:150`, `src/remote.js:1852`); crypto HKDF `nikui-e2e:v1`; WS13; APK build/version | Independent remote protocol version/min-max compatibility, negotiated capabilities, typed error/feature availability contract for every action. UI `mayChange/mayReply` fields are grants, not capability negotiation. |
| Other private protocols (do not confuse with remote version) | Keeper `proto:1` / newline JSON (`src/keeperLink.js:27`, `src/keeperLink.js:247`); Session checkpoint `$v:1` (`src/session.js:63`); Codex JSON-RPC2.0 + initialize clientInfo.version1 (`src/codex.js:143`, `src/codex.js:207`); app IPC method versions0/1/2/4 (`src/codexIpc.js:20`) | These do not version this fleet/conversation API and cannot stand in for nikd client compatibility. |
| Management/editor capability gaps | See `capabilities.md`: local command registry and host singleton | No rename/stop-process/restart/remove/folder CRUD/order/history-delete API; no editor enrollment/registration/routing/lease; no nikd health/stop/update contract. |
