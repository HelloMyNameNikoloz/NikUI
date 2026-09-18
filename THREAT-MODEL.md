# NikUI: what it is exposed to, and what it is not

NikUI runs Claude Code with `--permission-mode bypassPermissions` by default.
Every tool call — `Bash`, `Write`, `Edit` — runs without asking. That single
fact decides everything below, so it is worth stating in the bluntest available
terms:

> **Anything that can send a prompt to a NikUI instance can run any command on
> this laptop, as you, without a prompt appearing on the screen.**

Not "can read your code". Not "can see your conversations". Can run
`curl … | sh`. The rest of this document is an account of what stands between
that and each kind of attacker, and — as importantly — where it does not stand.

Last reviewed: 2026-09-18, against the surface at `src/remote.js`, `src/auth.js`,
`src/devices.js`, `src/pairing.js`, `src/identity.js`, `src/push.js`,
`src/wire.js`, `src/hub.js` and the client files in `media/`.

---

## What there is to take

| Asset | Why it matters |
| --- | --- |
| **Prompt submission to an instance** | Arbitrary code execution as you, on this machine. The crown jewel; everything else is a way to reach it. |
| **The conversation** | Source code, file paths, credentials that happened to be on screen, what you are building and when. |
| **The device's private key** | Being that phone, from now on. In the app it is generated inside the Secure Enclave or the Android Keystore and has no software representation at all; in a browser it is a non-extractable WebCrypto key, which a copy of the profile does copy. |
| **The laptop's identity key** | Being this laptop to a paired phone. |
| **The local key** | A seat with control, from this machine. |
| **The fleet list** | Which projects exist, what they cost, what is running. Less severe, still yours. |

## Who might want it

| # | Attacker | What they can do before we start |
| --- | --- | --- |
| 1 | **A process on this machine** | Connect to `127.0.0.1:<port>`. Cannot read the extension host's memory. |
| 2 | **A website you visit** | Make cross-origin requests and open WebSockets — neither is stopped by the same-origin policy. |
| 3 | **Someone on your WiFi or your tailnet** | Reach the `tailscale serve` endpoint; see TLS-encrypted traffic only. |
| 4 | **Someone holding a photo of the pairing QR** | Read the code, the fingerprint and the address, at any later time. |
| 5 | **A paired device that may only watch** | Hold an authenticated socket and send anything it likes down it. |
| 6 | **A holder of a stolen local key** | Present it on any request. |
| 7 | **A compromised paired phone with control** | Everything. See below. |

---

## What each of them gets

### 1. A process on this machine

**Can:** fetch `/`, `/s/<id>`, `/pair`, `/media/*`, `/health`, `/manifest.webmanifest`,
`/sw.js`. All of them are an empty shell — markup, stylesheet, script. No
conversation, no fleet, no instance id.

**Cannot:** open a socket. The upgrade needs either the local key or a signature
from a paired device. It cannot pair either: that needs a code that is only on
screen for sixty seconds, dies on first use, and closes on the first wrong guess.

**Caveat, stated plainly:** a local process that can read your files can read
`~/Library/Application Support/Code/User/globalStorage/…` and take the local key
out of the extension's stored state. At that point it has a seat with control —
but a process that can read your home directory can already run commands as you,
so this is not a step up in privilege. The loopback bind is not a defence
against this attacker; it is a defence against attackers 2 and 3.

### 2. A website you visit

**Can:** try. Nothing else.

- `fetch('http://127.0.0.1:4517/…')` sends an `Origin`. Any `Origin` that is not
  this server's own is refused — `src/remote.js`, `guard()`.
- A WebSocket from a page always sends `Origin` too, and the same check applies.
  This is the reason that check exists: there is no same-origin policy for
  WebSockets, and without it any page could open one.
- DNS rebinding — pointing `evil.com` at `127.0.0.1` so the browser believes it
  is same-origin — is refused by the `Host` allowlist.
- The `nikui` cookie is `SameSite=Strict`, so it is not attached to anything a
  third-party page initiates, and `HttpOnly`, so script cannot read it.
- A top-level navigation to `/s/<something>` sends no `Origin` and is allowed —
  by design, it is how you open the app. It gets the empty shell. Session ids are
  validated against `[A-Za-z0-9_-]{1,64}` and everything placed into a script
  element is escaped for that context, so the path cannot become markup.

### 3. Someone on your WiFi, or on your tailnet

**Can:** see that `laptop.tailnet.ts.net:443` exists and is serving something.
Fetch the same empty shell anyone else can. On plain WiFi, without the tailnet,
reach nothing at all: the server binds to `127.0.0.1` and there is no
configuration that changes it. This is checked by a test that enumerates every
interface on the machine and tries to connect on each.

**Cannot:** open a socket, for the same reason as attacker 1 — and the local key
is explicitly refused through the tunnel, twice over: once because anything
carrying forwarding headers is refused, and once because a request addressed to
anything but a loopback name is refused. Everything `tailscale serve` forwards
arrives from `127.0.0.1`, so neither check could be the only one.

**Residual:** they learn a NikUI exists at that address, and roughly when it is
up. A tailnet peer is already a device you authorised onto your network.

### 4. Someone holding a photo of the QR

**Can:** read a code, a fingerprint, and an address. If they take the photo, get
to a browser, and complete a pairing exchange **within the same sixty seconds,
before you do**, they are paired — as a read-only device, which still means
reading every conversation.

**Cannot:** do anything with that photo afterwards. The code works once, expires
in sixty seconds, and the window closes on the first wrong guess. A photo taken
of a screen after pairing is worthless.

**Residual, and it is real:** the pairing window is the one minute in which a
bystander with a camera is a threat. The mitigation is the same as for a bank
card PIN — do not pair with a camera pointed at your screen — and the window is
deliberately short.

### 5. A paired device that may only watch

**Can:** read everything. Pairing grants watching, and watching means the full
transcript of every instance in the window, live, including anything on screen.

**Cannot:** steer. `send`, `interrupt`, `permission`, `unqueue`, `promoteQueued`,
`editQueued`, `clearQueue`, `openFile` and `switch` are refused **by the host**,
whatever the client sends — the client hiding the composer is courtesy, not the
rule. Every refusal is recorded against the device's name and shown in `/status`.

It also cannot **start** an instance: opening a stopped instance spawns a CLI
process, so that is gated on the same grant.

### 6. A holder of a stolen local key

**Can:** open a socket from this machine, with control. That is a full
compromise, and the key is deliberately short-lived against exactly that: it is
256 bits, minted fresh every time the server starts, and it is traded for an
`HttpOnly; SameSite=Strict` cookie on first load so it leaves the address bar
rather than sitting in history, in a screenshot, or in a shared URL.

**Cannot:** use it through the tunnel. See attacker 3.

### 7. A compromised phone that has been granted control

**Gets everything.** It can send prompts, and a prompt is arbitrary code
execution on this laptop. There is no mitigation inside NikUI for this and it
would be dishonest to imply one: granting control to a device is trusting that
device exactly as much as you trust your own keyboard.

What NikUI does give you is the ability to **take it back instantly**: revoking
control or forgetting the device closes the socket it is holding within
milliseconds, and the audit trail in `/status` shows what arrived from it and
when.

---

## The pairing exchange, examined

```
laptop                                        phone
  |  QR / typed code: code, fingerprint, host   |
  |-------------------------------------------->|   (out of band: a screen)
  |                                             |
  |  POST /pair { code, publicKey, signature }  |
  |<--------------------------------------------|   signature over
  |                                             |   "nikui-pair:<CODE>"
  |  { device, serverKey, fingerprint }         |
  |-------------------------------------------->|   phone checks
  |                                             |   sha256(serverKey) == pinned
```

**Replay.** The code is single-use: claiming it closes the window. A captured
`/pair` body cannot be replayed because the code it names no longer exists.

**Brute force.** Eight characters from a 31-symbol alphabet is about 40 bits,
but the number that matters is **one** — a wrong code closes the window, so
there is exactly one guess per window, and the window is sixty seconds. Repeated
requests are additionally rate-limited per address.

**Downgrade.** There is nothing to downgrade to. There is one exchange, one
signature scheme (ECDSA P-256 over SHA-256), and no negotiation of anything.

**Man in the middle.** This is where the fingerprint earns its place, and where
its limits need stating exactly:

- The phone pins `sha256(serverKey)[0..16]` from the QR — read off a screen, not
  off the network — and checks the key the laptop offers against it.
- On **every connection afterwards**, the laptop signs
  `nikui-host:<phone nonce>:<laptop nonce>` and the phone verifies that
  signature against the pinned key before it says a word. An endpoint that
  cannot sign for that key is refused and the socket is closed.
- **What this stops:** an impostor that answers at the laptop's address but does
  not hold its key. A hostile DNS answer, a captive portal, a machine that takes
  the address after the laptop leaves the network, a stale bookmark pointing
  somewhere else.
- **What this does not stop:** a full relay — something that forwards both
  directions verbatim to the real laptop. That attacker never needs to forge a
  signature because it never produces one. Nothing short of binding the
  signature to the TLS channel would catch it, and what actually prevents it
  here is the tunnel's TLS and the tailnet's own device authentication.

So: **the fingerprint pin is not a substitute for TLS.** It is the check that
survives the case where TLS is trusted but pointed at the wrong machine, and it
is the reason a phone will not silently start talking to a different laptop.

### The connection handshake, examined

```
laptop                                        phone
  |  @challenge { nonce, serverKey, fp }        |
  |-------------------------------------------->|
  |  @auth { device, nonce, signature }         |   over "nikui-auth:<theirs>:<mine>"
  |<--------------------------------------------|
  |  @welcome { device, signature }             |   over "nikui-host:<mine>:<theirs>"
  |-------------------------------------------->|   phone verifies before seating
```

- The laptop's nonce is minted per socket, so a captured `@auth` replayed on a
  new connection is refused — verified by a test.
- The phone's nonce goes into the laptop's signature, so a captured `@welcome`
  cannot be replayed at a different connection either.
- Nothing is delivered to the session until both directions have checked out.
  Anything sent before that is dropped, not queued.

### Replacing a device's own key, examined

A phone that gains secure hardware after it paired may hand the laptop a new key
in the same exchange. The `@auth` carries `rekey`, and what is signed changes to
say so:

```
  |  @auth { device, nonce, signature, rekey: { publicKey, signature } }
  |<--------------------------------------------|
     both signatures cover "nikui-rekey:<theirs>:<mine>:<fingerprint of the new key>"
     the outer one by the key being replaced   — the authorisation
     the inner one by the key replacing it     — proof somebody holds it
```

- **Replay**: both signatures cover the laptop's per-socket nonce, so a captured
  move is worth nothing on the next connection.
- **Redirection**: the fingerprint of the new key is inside what the old key
  signed, so swapping the offered key in flight invalidates the authorisation.
- **Downgrade by stripping**: a `rekey` removed in flight leaves a signature over
  `nikui-rekey:…` being checked as `nikui-auth:…`, which fails. The reverse —
  attaching a `rekey` to a plain answer — fails for the same reason.
- **Lockout**: the new key must sign too, so a device cannot be rekeyed to a key
  nobody holds.
- **Collision**: a key already belonging to another device is refused, so two
  records can never share one identity.

All seven are tests in `test/hardware.test.js`.

**What this does not defend against, stated plainly.** Someone holding a stolen
*device* key can use this to make the theft permanent and lock the owner out —
they authorise a key only they hold. That is not a new capability (they already
had everything the stolen key grants) and forbidding the move would not remove
it, so the design choice is that a move is never quiet: a notification in the
window, a line in the audit trail, the previous fingerprint kept on the record,
and both shown in the device's tooltip. The recovery is the same as for any
compromised device — forget it, and pair again.

**What a device says about where its key is kept is a claim, not a measurement.**
Nothing on the laptop can tell a Secure Enclave from a phone that says "Secure
Enclave"; that would take Android Key Attestation or Apple's equivalent, which
is not implemented. So the word is shown as what the device reported and nothing
is decided by it — `cleanProtection()` in `src/devices.js` allowlists it purely
so an arbitrary string cannot reach a screen.

---

## Boundaries that are code, not intention

| Rule | Where |
| --- | --- |
| Binds `127.0.0.1` only, no setting changes it | `src/remote.js` `start()` |
| Only `media/` is servable, by extension, path resolved twice — lexically and on disk | `serveAsset()` |
| `Host` must be a name we serve | `guard()` |
| `Origin`, when present, must be ours | `guard()` |
| Session ids in a URL must look like ids we made | `handle()` |
| Anything interpolated into a script element is escaped for that context | `src/page.js` `jsonForScript()` |
| The script nonce is from the cryptographic generator | `src/page.js` `randomNonce()` |
| The local key is refused when forwarded or when the Host is not loopback | `src/auth.js` `LocalKey.check()` |
| A replacement device key must be authorised by the key it replaces, and prove itself | `src/auth.js` `Gate.answer()` |
| Two devices can never share one key | `src/devices.js` `rekey()` |
| Steering needs a grant, checked on the host | `src/hub.js` `STEERING` |
| Starting an instance needs that grant too | `src/hub.js` `hello()` |
| Push endpoints must be a known push service | `src/remote.js` `isPushEndpoint()` |
| A push subscription body expires after a minute | `subscribe()` |
| Every frame rule in RFC 6455 is enforced before a message exists | `src/wire.js` |

## What was found in review, and what happened to it

A security review of this surface was run on 2026-09-18. Five findings; all five
are fixed in the same change as this document:

1. **HTML injection through `/s/<id>`** (high). The path was placed into a script
   element with `JSON.stringify`, which does not escape `</script>`. CSP made it
   hard to exploit rather than impossible. *Fixed:* ids are validated and
   script-context JSON is escaped.
2. **The CSP nonce came from `Math.random()`** (high). The nonce was the only
   thing stopping injected markup from executing, and V8's PRNG state is
   recoverable from output that anyone could fetch. *Fixed:* `crypto.randomBytes`.
3. **The phone never verified the laptop's signature** (medium). The laptop
   signed, but no client read it, and the "pin" compared a fingerprint against
   one the other end claimed. *Fixed:* the phone stores the laptop's key, checks
   the fingerprint against a hash of it, and verifies the signature before
   seating the socket.
4. **A watch-only device could spawn a CLI process** by opening a stopped
   instance (low). *Fixed:* gated on the control grant.
5. **`/push/subscribe` accepted any HTTPS endpoint, and its signature never
   expired** (low). A watch-only device could make the laptop POST to hosts only
   the laptop can reach. *Fixed:* an allowlist of push services and a
   one-minute signature window.

Checked and found sound, with no change needed: path traversal, DNS rebinding,
the `Origin` check, the local key through the tunnel, pairing replay and brute
force, handshake replay, read-only enforcement, revocation reaching live
sockets, the WebSocket framing under 300,000 randomised inputs, and escaping in
every client-side sink that renders a device name, a label or a path.

## What would change this analysis

- **Opening a public tunnel.** Everything above assumes the only way in from
  outside is a tailnet whose peers you authorised. A public hostname puts
  attacker 3 on the internet. See the acknowledgement the command makes you read.
- **Turning off `bypassPermissions`.** It would demote the top row of the asset
  table from "runs commands" to "asks first". It is the single biggest thing you
  could change.
- **Granting control to more than one device**, or to a device you share.
- **A dependency.** There are none at runtime, and every byte of the crypto and
  the framing here is in this repository where it can be read.
