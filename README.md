# NikUI

A multi-instance Claude Code client for VS Code: the official CLI underneath,
your own HTML/CSS on top, and a sidebar that shows every instance at a glance.

## Why it exists

The built-in terminal renders Claude Code on a character grid — no proportional
text, no real tables, and a tab label that VS Code freezes permanently the moment
you rename it. The official extension renders beautifully but its webview cannot
be styled or listed by a third party. NikUI runs the same `claude` binary and
owns the whole surface.

## What you get

- **Many instances.** Each one is its own `claude` process in its own folder,
  with its own editor tab. Two instances that end up with the same name are told
  apart by their folder, and then by number, wherever the name is shown. Once
  eight are running NikUI says so, once, since each one is a real process.
- **Real coloured status icons** on the editor tab and in the sidebar — orange
  while working, green when done, red when it needs you. Not an emoji in a
  string: an actual coloured icon, which a terminal tab cannot do. Green means
  *just* finished — five minutes on, a finished instance reads as idle again,
  because a dot that is always green tells you nothing.
- **Automatic naming.** Paste a GitHub PR or issue link and the instance names
  itself `1338`. A number mentioned in a read-only request ("analyse #1339")
  does not steal a tab that is already working a different ticket. When a tab
  does change its name, it says so in the conversation — renaming yourself pins
  it — because a tab that renames itself behind your back is startling. History rows
  are named by the same rule (`src/label.js`), so a transcript and the instance
  it reopens as are recognisably the same conversation — a prompt with no number
  shows its opening line, and one that is nothing but a link shows the host and
  the tail of its path rather than 80 characters of URL.
- **Rendered markdown** — tables with borders, fenced code with a language tag,
  nested lists, blockquotes.
- **Collapsible tool calls** showing the command, the input and the result.
- **Interrupt** mid-turn over the CLI's control channel — the Stop button, or
  Escape twice. Escape is the key people press to dismiss things, so the first
  press arms it and says so, and the second within two seconds abandons the
  turn; `nikui.interruptOnSingleEscape` restores the CLI's single press.
- **Trouble finds you.** An instance that starts waiting for an answer while you
  are looking at something else says so, once, with a button that takes you to
  it — and an instance that could not start at all reports the reason where you
  can see it, names the executable it tried, and offers to open the setting that
  points at it. Errors used to be written only into a panel that, if the CLI
  never started, never opened. `nikui.notifyOnAttention` turns it off.
- **Two-stage command palette.** `/` lists the session's own commands; pick one
  that takes a fixed set of values and its options appear immediately, arrow
  navigable, with the one already in force marked *current*. Options are seeded
  for `/effort` and learned at runtime out of the CLI's own replies, in both
  shapes it writes them: `Usage: /cmd <a|b|c>`, and the prose list `/model`
  answers with.

  `/model` gets one more thing, because its reply names the aliases and then
  says "or a full model ID" — true, and not a list. The identifiers themselves
  are read out of the installed CLI (the same catalog the settings picker uses),
  so `/model ` offers **Opus 5.5** and its 1M variant by name, above the
  aliases, the day Claude Code ships them. Typing matches anywhere in an
  identifier, since every one of them starts `claude-`.
- **`/settings`.** The settings people actually change, as switches and pickers
  in one sheet, said the way you would say them: the model (from this CLI's own
  list), effort, permissions, thinking, waiting out the usage limit; keeping
  the laptop awake and working with the lid closed; which things buzz your
  phone; text size and the Escape rule. Four groups, one column, nothing to
  look up. It works the same on the phone — a phone that may send prompts may
  flip any of them, a watching one sees them locked and is told why, and
  neither can reach anything that is not on the list. Everything else is one
  click away under *All settings…* in the editor. `/settings anything` still
  goes to the CLI.
- **A real `/status`.** It is offered as soon as you type `/` (tagged NikUI, so
  you can tell it from the CLI's own), and NikUI answers it itself with a
  full-screen sheet in six sections you can click or key through (`1`–`6`,
  arrows, Esc).

  It opens on **Fleet**, because the first question in a window full of
  instances is which one: the whole window's cost, instances by state, cost and
  token mix per instance, a context-pressure meter for each, a breakdown by
  project, a table of every instance (turns, tokens, cache rate, context, average
  turn, how long since its last one, cost, and a spend sparkline) — every row
  clickable to jump straight there — and the records across the window.

  Fleet also carries **Plan usage**: how much of your five-hour session window
  and your weekly window is left, when each resets, and overage if you are on
  it. The CLI reports these whenever they move — they come straight off the
  `anthropic-ratelimit-unified-*` headers — so NikUI reads the event it was
  already being sent and throwing away. They belong to the account rather than
  to one instance, so whichever instance hears about them, every instance knows,
  and the figures outlive a window reload. Getting close is said in the
  conversation too, once, and running out is said as an error.

  Then: **This instance** with its cost, context meter and cost-per-turn trend
  (and the same two windows, in short);
  **Usage** with tokens per turn stacked by type, cumulative spend and output
  speed; **Tools** with what you have run, the files they touched most (click one
  to open it) and the shell commands; **Timeline** with turn durations, an
  hour-of-day rhythm and context growth; and **System**, down to the branch, the
  pid and the size of the transcript on disk. Things the CLI's own `/status` cannot tell you: what share
  of everything read came back from cache, how many turns of context you have
  left before compaction at the current rate, cost per hour of actual work,
  output tokens per second, and how this instance compares to the others. Every
  figure traces back to what the CLI reported — NikUI never multiplies tokens by
  a price. An open sheet keeps up with the instance it describes (throttled to
  once a second and a half, holding your place in the page) rather than quietly
  going stale, and the turn history behind the charts survives a window reload,
  so a real cost never sits above an empty chart. There is a Copy report button for pasting the summary elsewhere.
  The sheet is built out of liquid glass: the conversation stays visible
  underneath, defocused, and every pane is a translucent material with a
  specular top edge and a gradient lens rim. The blur happens once, on the
  sheet — a pane that blurs its own backdrop becomes a backdrop root and ends up
  refracting a flat wash — so the panes lift and saturate what is behind them
  instead. Light and dark have their own steps, high-contrast themes fall back
  to flat opaque surfaces, and the entrance animation respects
  `prefers-reduced-motion`. It behaves as a dialog too: the rest of the panel
  goes `inert`, Tab stays inside, focus returns where it came from, every chart
  carries a spoken summary, and a **CLI** button hands `/status` to the Claude
  Code CLI itself if you wanted its answer instead — as does typing
  `/status` with any argument.
- **Prompt snippets.** A word like `/table` adds a standing instruction to the
  prompt you just wrote: `/table fix the rollback` and `fix the rollback /table`
  both send your text with the instruction appended, and the word itself never
  reaches the CLI. As many as you like at either end — `fix the rollback
  /decisions /table` applies both, in the order written, once each — and after
  one is picked the palette is ready for the next. The panel keeps showing your words, with a `+table` chip you
  can hover to read what was added, so a long standing instruction is not
  reprinted on every turn. They appear in the `/` palette tagged *NikUI*, and
  they are yours to write: `nikui.promptSnippets` maps a word to its text, your
  entries merged over the built-in ones, and an empty string switches one off.
  `/table` asks for the current plan as a table — 🟢 done, 🟡 in progress,
  🔴 not started — scoped to the task in hand rather than the project. `/lean`
  asks for the task in few, wide steps: one batched look, small edits, one
  verification pass, and a subagent only for a big sweep or web research. Every
  step re-reads the whole conversation, so fewer steps is fewer tokens; the
  checks stay the same. `/delegate` splits a task with independent parts and
  hands each to the cheapest agent that will do it well — Haiku to run checks
  or make an exactly specified change, Sonnet to find code, research or build a
  contained piece, Opus at high effort for one hard, isolated problem — running
  them in parallel and keeping the plan, the decisions and the review in the
  conversation. A small or tightly coupled task it just does. The agents it
  names live in `~/.claude/agents`; without them it uses general-purpose with
  the model named.
- **Prompt recall.** Up from an empty composer brings back the last prompt, and
  again the one before it; Down walks forward and, past the newest, hands back
  whatever was half-typed before recall started. Editing a recalled prompt ends
  recall and gives the arrows back to the cursor. The ring is fed from the
  transcript, so it survives closing and reopening a panel.
- **Find in the conversation.** `⌘F` / `Ctrl+F` opens a find bar over the
  transcript: matches are highlighted in place, `Enter` and `Shift+Enter` walk
  through them, the count says where you are, and Esc closes it and leaves the
  transcript exactly as it was. VS Code's own find widget does not reach inside
  a webview panel, so the panel brings its own.
- **Copy buttons** on every code block, including tool input and output — and
  on every message, which copies the prose without the code-block buttons in it.
- **Running out of quota does not cost you the night.** When the account's
  usage limit is spent — the five-hour window or the weekly one — every instance
  stops talking to the CLI instead of failing turn after turn, and each says so
  in its own conversation. A minute after the limit resets they all start again:
  an instance that was cut off mid-turn is nudged to carry on with what it was
  doing, and one that was only holding a queue simply starts draining it.
  **The queue is never touched** — not cleared, not reordered, and the nudge is
  sent rather than queued, so the interrupted work comes first and everything
  waiting follows in the order you left it. Anything you type while it is
  paused joins the queue rather than failing. The pause outlives a window
  reload, `nikui.pauseWhenQuotaRuns` turns the whole thing off, and
  `nikui.resumePrompt` is the wording of the nudge. *NikUI: Resume Everything
  Now* does not wait.
- **Queued prompts.** Send while an instance is busy and the prompt stacks
  instead of being dropped — and the sidebar row says so (`working · 2 queued`),
  so a queue is not something you can only see from inside the panel. Clearing
  the queue takes two clicks: queued prompts are typed work, and the first click
  only asks. Any queued prompt can jump the line (send it next, or immediately
  if nothing is running) or come back to the composer to be edited — with
  whatever you had half-typed kept underneath it. The queue drains in order, five seconds after a turn
  is genuinely finished — the gate also waits on any tool still running — and
  every queued item can be removed or the whole queue cleared.
- **Drag a file in and the panel says so** — the whole surface becomes a drop
  target while you are dragging, instead of leaving you to guess.
- **Clickable file references.** `src/session.js:214` in prose or tool output
  opens that file at that line, beside the conversation. URLs and email
  addresses are left alone.
- **Context budget meter** in the title bar: what the last turn had to read
  against the model's context window, turning amber at 70% and red at 90%.
- **Compaction is visible.** The CLI decides when the context is full and
  summarises it; NikUI never triggers that, and the meter falls back on its own
  because it reads the context of the last model call. What NikUI adds is the
  line in the conversation where it happened — *Compacted here automatically ·
  the context had reached 181k tokens* — because the panel keeps every message
  while the model, from that line on, has only a summary of them. `/status`
  counts how many times it has happened and says that the meter measures the
  window since the last one.
- **Your own folders.** Create named folders from the + on the Instances title
  bar and drag instances into them (multi-select works). Each folder row has its
  own + to start an instance straight into it. Drag onto empty space to take one
  back out, or use Move to Folder... from its context menu. Dropping onto a
  *project* group does nothing and says why — a project comes from the folder on
  disk, so there is nothing there to move into, and that gesture used to quietly
  unfile the instance instead. Folders and their contents persist across
  reloads; deleting a folder never touches the instances in it.
- **The sidebar follows the tab.** Switching instances from the editor tabs
  selects the same row in the sidebar, not just the other way round; a collapsed
  project or folder expands to show it, and a hidden sidebar is left alone.
- **Grouped by project.** Instances nest under their project folder — a git
  worktree groups with the repo it belongs to — with a per-group count, working
  count and summed cost. `nikui.groupByProject` is `auto` (nest only once more
  than one project is open), `always` or `never`.
- **Close, or just stop.** The × on a row closes the instance: the process is
  killed (SIGTERM, then SIGKILL if it lingers) and the row disappears, while the
  conversation stays in History to reopen later. Anything with a conversation
  behind it asks first and says exactly where that conversation goes; an
  instance with nothing in it closes without a dialog. **Stop Process (keep the
  instance)** is the middle option the × is not: it kills the process to free
  the memory and leaves the row alone, and opening it again picks the
  conversation back up.
- **A reload gives you back what you had.** Instances come back wearing the
  state their conversation ended in — green if the last turn finished, red if it
  failed — because that is a fact about the work, and it survived the restart.
  Whether a *process* is running is a different fact, and the icon carries it: a
  restored instance wears a paused icon until you open it, and the fleet shows
  it as a hollow dot in the same colour. A turn that was still running when the
  window closed comes back stopped rather than pretending it is still working.
  The distinction is derived from "has never been started", not added as a
  seventh value to the status machine the CLI drives.
- **Every row reads the same way**: *state · folder · cost*, in that order, for
  every instance. The folder only appears when it is not the project the row
  already sits under — a worktree, say. The old rule showed the folder *or* the
  state depending on whether the instance happened to have a ticket number, so
  the same column meant two different things one row apart.
- **An empty view explains itself.** The Instances view offers a Start an
  instance button instead of a blank panel, and an empty History says whether it
  searched this workspace or the whole machine, with a button to switch.
- **Asleep is not stopped.** Instances restored from your last window have no
  process until you open one, so they are asleep — *Remove Instances Whose
  Process Has Exited* leaves them alone, names the ones it would take, and asks
  before taking them. It used to treat "no process" as "dead" and wipe the
  sidebar after every reload.
- **Permissions are stated, not assumed.** The mode each instance runs under is
  a chip in its header and a line in its sidebar tooltip — amber, in words
  ("tools run without asking"), whenever nothing will stop a tool call. That is
  the default here, so silence would have been the wrong signal.
- **History is always reachable.** Both views are pinned visible, the provider
  never throws, and `NikUI: Show History` (also a button on the Instances title
  bar) focuses it if it ever gets dismissed. The header says what the list is
  showing — *this workspace* or *all folders*, plus any filter — so a short list
  is never a mystery. Filter by name, opening prompt, folder or branch; **Show
  N more** pages through the rest; and a transcript can be deleted from its
  context menu, which asks first, refuses anything that is not a transcript, and
  refuses one an open instance is still using.
- **One question per prompt.** Starting an instance asks which folder, grouped
  into this workspace, folders you have used before, and Browse — and nothing
  else. It used to mix "run here" with "resume that conversation" in one flat
  list; reopening a conversation is what History is for.
- **Keyboard.** `cmd/ctrl+alt+N` new instance, `cmd/ctrl+alt+H` History,
  `cmd/ctrl+alt+]` and `[` to move between instances, and `cmd/ctrl+alt+I` for
  the status sheet while a panel is focused.
- **Resume** — instances remember their Claude session id across reloads, and
  the number remembered is the number brought back (20 either way; it used to
  remember twenty and restore eight, losing the rest without a word).
- **Instances survive a window reload.** They come back in the sidebar, VS Code
  restores their editor tabs, and opening one replays its saved transcript and
  reattaches the process with `--resume`. The transcript is found by its session
  id rather than by guessing at the folder: the CLI files a conversation under
  the project it considers it to belong to, which for a folder opened inside
  another project is the outer one, so deriving the path from the instance's own
  folder found nothing and the panel came up empty on a conversation that was
  right there on disk. If one really cannot be read back, the panel says which
  session it is and where it looked, rather than looking like a new instance. Processes are not respawned at
  activation, so a reload never fires off a pile of CLI processes on its own.
- **Bounded by design.** A conversation that runs all day stays light: one tool
  result keeps the first 20 KB and says how much was cut (Claude was given all
  of it, and the whole thing is in the transcript), an instance keeps its last
  400 items and says how many scrolled out, and the panel's DOM follows the same
  window. `nikui.maxTranscriptItems` moves the line; 0 turns it off. Anything
  still in flight — a running tool, an unanswered permission — is never dropped.
- **Hidden panels cost nothing.** A tab you are not looking at is rebuilt from
  its instance when you come back, so its webview is not held in memory; the
  draft you were typing and the place you had scrolled to come back with it.
  `nikui.keepHiddenPanelsWarm` restores the old behaviour if you would rather
  spend the memory.
- **Reading beats following.** Auto-scroll sticks to the bottom only while you
  are at the bottom; scroll up and it stops, with a Jump to latest pill to
  re-arm it.

## Shortcuts

### Anywhere in VS Code

| Keys | Does |
| --- | --- |
| `⌘⌥N` / `Ctrl+Alt+N` | New instance — asks which folder to run in |
| `⌘⌥H` / `Ctrl+Alt+H` | Show History |
| `⌘⌥]` / `Ctrl+Alt+]` | Next instance |
| `⌘⌥[` / `Ctrl+Alt+[` | Previous instance |
| `⌘⌥I` / `Ctrl+Alt+I` | Status sheet (while a NikUI tab is focused) |

### In a conversation

| Keys | Does |
| --- | --- |
| `Enter` | Send — or queue it, if the instance is busy |
| `Shift`+`Enter` | Newline |
| `↑` | Previous prompt, from an empty composer; `↑` again goes further back |
| `↓` | Forward again, and past the newest one, back to what you were typing |
| `/` | Command palette — the CLI's commands plus NikUI's own, tagged *NikUI* |
| `/table` | Append the standing "plan as a table" instruction — and `/decisions` after it, as many as you want |
| `Tab` | Fill in the highlighted command; again for its values |
| `⌘F` / `Ctrl+F` | Find in this conversation |
| `Enter` / `Shift`+`Enter` *(in find)* | Next / previous match |
| `Esc` `Esc` | Interrupt the running turn — the first press asks, the second does it |
| `Esc` | Close the find bar, the status sheet or an opened image |

`nikui.interruptOnSingleEscape` puts interrupt back on a single `Esc`, the way the
CLI does it.

### In the status sheet

| Keys | Does |
| --- | --- |
| `/status` | Open it (or `⌘⌥I`) |
| `1`–`6` | Jump to a section — `1` is the fleet |
| `↑` `↓` `←` `→` | Move through the sections |
| `Tab` | Move through the sheet; focus stays inside it |
| `Esc` | Close, and give focus back to where it was |

### Mouse

| Where | Does |
| --- | --- |
| Sidebar row | Open that instance |
| Drag a row onto a folder | File it there; onto empty space takes it back out |
| `+` on a folder row | Start an instance straight into that folder |
| A file in the transcript (`src/session.js:214`) | Open it beside the conversation |
| A row in the fleet or a file in Tools | Jump to that instance / open that file |
| Hover any chart | The figures behind that mark |
| Paste or drop an image | Attach it to the next prompt |

## Running it

Open this folder in VS Code and press **F5** ("Run NikUI"). A second window opens
with the extension loaded. Click the **NikUI** icon in the Activity Bar, then
**+** to start an instance.

To use it permanently without F5, symlink it into your extensions folder:

    ln -s ~/Codes/NikUI ~/.vscode/extensions/nikui

and reload the window.

Installed this way, a change to `package.json` — a new setting or command —
can take **two** reloads: VS Code starts the first from its cached copy of the
old manifest and only notices the new one a moment later. Code changes need
one. NikUI checks for exactly this when it starts, and if VS Code has not loaded
one of its settings it says so with a **Reload Window** button, rather than
leaving you to meet VS Code's "is not a registered configuration" at the first
switch you flip.

## Design

Apple HIG, adapted to a webview: SF Pro throughout, an 8pt spacing rhythm, a
single 780px measure so prose stays readable, hairline (0.5px) separators rather
than boxes, and translucent materials on the title bar, composer and popovers
(`backdrop-filter: saturate(180%) blur(20px)`). Colour is reserved for status and
links. Icons are Lucide, inlined as SVG because the webview CSP allows no CDN.
`prefers-reduced-motion` disables every animation.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `nikui.claudePath` | `claude` | Path to the executable |
| `nikui.model` | *(empty)* | Passed to `--model`; empty uses your default. Picked from a list read out of your installed CLI, so a new model appears the day you update Claude Code. Changing it applies to new instances, and to existing ones when they are restarted |
| `nikui.permissionMode` | `bypassPermissions` | Passed to `--permission-mode` |
| `nikui.effort` | *(empty)* | Passed to `--effort` (low/medium/high/xhigh/max); empty passes nothing, so your Claude Code default applies |
| `nikui.outputStyle` | `Concise` | Passed inline via `--settings` |
| `nikui.extraArgs` | `[]` | Extra CLI arguments |
| `nikui.autoTitleFromTicket` | `true` | Name instances from PR/issue numbers |
| `nikui.fontFamily` | *(empty)* | Conversation font; empty uses the UI font |
| `nikui.fontSize` | `13` | Conversation font size |
| `nikui.showThinking` | `true` | Show thinking blocks, collapsed |
| `nikui.groupByProject` | `auto` | Nest instances under their project folder |
| `nikui.promptSnippets` | `/table`, `/decisions`, `/lean`, `/delegate` | Words that append a standing instruction to your prompt |
| `nikui.pauseWhenQuotaRuns` | `true` | Hold every instance when the usage limit is spent, and start them again when it resets |
| `nikui.resumePrompt` | see below | What to send an instance that was cut off mid-turn, once the quota is back |
| `nikui.maxTranscriptItems` | `400` | Messages an instance keeps in memory; 0 keeps everything |
| `nikui.keepHiddenPanelsWarm` | `false` | Hold a hidden panel's webview in memory for instant switching |
| `nikui.notifyOnAttention` | `true` | Tell you when an instance you cannot see is blocked or failed to start |
| `nikui.notifyWhenDone` | `false` | A system notification on this laptop when an instance finishes its turn |
| `nikui.notifyWhenDoneSound` | `true` | With it, a soft chime (`sounds/done.wav`, made by `tools/sound.js`) |
| `nikui.interruptOnSingleEscape` | `false` | Interrupt on the first Escape, the way the CLI does |
| `nikui.statusEmoji` | see below | Emoji per status in tab titles |
| `nikui.remote.port` | `4517` | Port for the local server, on `127.0.0.1` only; `0` picks a free one. A second window takes the next free port rather than refusing |
| `nikui.remote.autoStart` | `true` | Start that server when the window opens, so a phone that tries to connect can |
| `nikui.remote.terminal` | `true` | Let a device that may send prompts run commands on this machine |
| `nikui.remote.tailnet` | `true` | Put this window on your tailnet when it starts serving. Needs Tailscale with HTTPS certificates; does nothing without it, and only one window at a time holds the address |
| `nikui.remote.requireEncryption` | `true` | Refuse a device that will not seal the channel end to end |
| `nikui.remote.appOnly` | `false` | Serve the app and nothing else outside this machine |
| `nikui.apns.*` | empty | Apple team ID, key ID, `.p8` path and topic, for telling an iPhone something while the app is closed |
| `nikui.keepAwake` | `false` | Keep this laptop awake while NikUI listens for your phone — also switchable from the phone |
| `nikui.lidClosed` | `false` | Keep working with the lid closed while Claude works, then sleep — needs your password once |
| `nikui.notifyDevices` | needs-you, quota, failed | Which things are worth sending to a paired phone |

### One place for all of it

`NikUI: Settings` — from the palette, or the `…` on any of the three views —
opens every setting NikUI contributes in one searchable list, grouped, each
showing what it is set to now and what it is for, with a dot beside anything no
longer at its default. Booleans toggle in place and the list stays open;
enums open a picker; objects open the Settings editor, which does JSON
properly. The list is built from `contributes.configuration`, so it cannot fall
behind the settings it shows.

The same list also carries the handful of things that are *actions* rather than
settings — start or stop the server, be reachable or stop being, pair a device —
because "where do I turn this on" and "where do I do this" are the same question.

### What a paired device is paired with

**The extension, not one window.** The laptop's key and the list of paired
devices live in `globalState`, which every VS Code window shares — so a phone
pairs once and is known to all of them, and forgetting it forgets it everywhere.

What a device *sees* is one window at a time. Each window runs its own server on
its own port and serves only its own instances, and `Reach this window from my
phone` puts the tailnet in front of the port of the window you ran it in. Open
two windows and run it in the second, and the phone follows to the second.

### Commands for the server and devices

| Command | Does |
| --- | --- |
| `NikUI: Start the local server` | Serves this window on `127.0.0.1` |
| `NikUI: Open NikUI in a browser` | Starts it if needed and opens the link |
| `NikUI: Pair a device` | A QR and a code, good for one minute and one device |
| `NikUI: Let this device send prompts` | Grants control, with a dialog that says what that means |
| `NikUI: Make this device watch only` | Takes it back, on the socket it is holding now |
| `NikUI: Forget this device` | Deletes its key and closes its connection |
| `NikUI: Settings` | Everything above, and every setting below, in one list |
| `NikUI: Reach this window from my phone` | Puts the tailnet in front of the server |
| `NikUI: Stop being reachable from my phone` | Takes it back off |
| `NikUI: Open a public address for this window` | A public tunnel, after a dialog that says what that means |

Default emoji: idle ⚪, working 🟠, waiting 🔴, done 🟢, error 🔴, stopped ⚫.

An instance whose turn has ended while agents it started are still running in
the background stays working, with the machine held awake for them, until they
have reported back and the turn the CLI starts to hand that over has finished.
The header counts the agents still out. A prompt sent meanwhile goes straight
to the CLI, which answers it while they work; Stop ends them. A command left
running in the background — a dev server, a watcher — is not counted, since it
may never end.

### Models, and never having to type one

`NikUI: Settings → Model` lists what your installed CLI actually knows, newest
first, with "Your Claude Code default" at the top. The list is read out of the
CLI itself rather than written down here, because a list written down here is
wrong the day a model ships — which is how this setting came to be free text,
where picking a new model meant knowing its exact identifier and typing it
correctly. Update Claude Code and the new model is simply there.

It is read once per CLI version and remembered, and when the binary cannot be
read at all the aliases — `opus`, `sonnet`, `haiku`, `fable` — are offered
instead. Those each mean "the newest of that family", so they cannot go stale:
a worse list, and never a wrong one.

Cost is not in that list, and there is no price table anywhere in this project.
Every figure comes from the CLI's own `total_cost_usd`, which Anthropic has
already priced per token type — cache reads at a tenth of input, cache writes
above it. `test/pricing.test.js` fails the build if a rate ever appears in the
source, because a table here would be wrong the same day and would do it
silently.

### Which phone gets told

A notification has an owner: the device that sent the prompt. Only the owner
hears about what came of it, and last writer wins — start something on the
tablet, push it along from your phone, and the phone in your hand is the one
that buzzes. Work nobody steered from a phone goes to whichever phone was most
recently in a hand, because most instances are started at the laptop and the
alternative is silence for nearly everything.

The hour is not a mute. The case this exists for is the ninety-minute job: you
sent it, went away, and the answer is what you left to wait for. So the rule is
about what a phone asked for rather than only about the clock:

- It hears about work it steered, **however long that took**.
- Delivering to one that has since gone quiet is **the last thing it hears** —
  after that it is dormant and is told nothing at all.
- Using the app wakes it, and it hears everything again.

Forty minutes: a notification, phone still awake. Ninety: still a notification,
and then silence until you pick it up. `src/audience.js` is the whole rule, and
`test/audience.test.js` walks every case above with the clock in its hand.

### A command on this machine, from the phone

Claude says "run `npm run build`". The block it says it in has a run button on
it, and that is the whole feature: in the editor the command goes into a real
terminal, typed but **not** sent, because a command you have not read is not a
command you have agreed to run. On a phone there is no terminal to type into, so
the app has one of its own and runs it there.

It is not a terminal emulator and does not pretend to be. There is no PTY — this
project has no dependencies and will not grow one for this — so there is no job
control, nothing interactive, and `vim` has nothing to draw on. What there is
instead is the thing a terminal is usually a clumsy way of getting: a command,
its output, and whether it worked. Each run is a block with an exit code on it,
which is what makes it readable on a phone at all; scrolling back to "which one
broke" is looking rather than reading.

`cd` persists, because that is what a person means by "where I am". Everything
else is its own process, so one command falling over cannot take the session
with it, and nothing runs for more than fifteen minutes.

Which blocks get the button is decided in `media/runnable.js`, shared by the
laptop and the client so the two cannot come to different conclusions. It errs
towards not offering: a run button on a block of Python is a trap.

It is behind `control`, the same grant as sending a prompt. That is not a new
power — NikUI runs Claude with permissions bypassed, so a prompt can already do
anything a command can — but a watching device is for reading, and reading is
what it should stay. Every command and every refusal goes in the device trail.
`nikui.remote.terminal` turns the whole thing off.

### More than one device, and taking one off from the other

Any number of devices can be paired, and any number connected at once: each one
has a key of its own, gets its own seat, and is named and granted separately.
Pairing is one device per code — the window closes on the first claim — so two
phones are two codes, not a code that two phones share.

The list is also on the phone, under Settings → Devices, with what each one is,
where it keeps its key and whether it is connected now. From there:

- **Its own** may always be removed. That is the honest end of "this phone is
  not mine any more", and it takes the phone's key with it so nothing is left
  pointing at a record the laptop no longer has.
- **Anybody else's** needs the same grant as sending a prompt. A watching-only
  device that could unpair the others would be a way to lock somebody out of
  their own machine from a seat that is supposed to be read-only. The refusal is
  written into the trail like any other.

A removal reaches a socket that is already open: the device loses its connection
at once rather than at its next one, and every other device watching the list
sees it go without reloading anything. The same is true the other way — a device
forgotten on the laptop disappears from the phone's list as it happens.

## One instance, many clients

A session does not know what is looking at it. `src/hub.js` owns that
relationship: one hub per instance, however many clients, where a client is
anything with an `id` and a `post(message)`. Everything that happens to the
session — items, status, stats, meta, queue, reset — is broadcast to every client
that has said `ready`. Everything a client asks for goes through one `receive`,
and the few answers that belong to the asker alone — a status report, a prompt
pulled back out of the queue — go back to that client only. The status sheet's
open/closed state is per client too, so a phone with the sheet open does not make
the panel redraw one it never opened.

`src/panel.js` is now just the VS Code client of that hub: it builds the webview,
attaches, forwards messages, and supplies the handful of things only the editor
can do (opening a file at a line, bringing another instance to the front) as host
functions. Nothing in `src/hub.js` requires `vscode`, which is what makes a second
transport possible without a second copy of the rules.

`test/protocol.test.js` holds the protocol as lists — what a client may send,
what the host may send, and the `@`-named control frames the transport uses to
settle who is holding a socket — and reads every side out of the source to
compare against them. A message added to the webview and forgotten in the hub, or sent by
the hub and never drawn, fails there. The same suite drives a plain in-memory
client through every message in both directions, so a new transport has a
conformance suite waiting for it rather than a reading exercise.

## The same client, in a browser

`NikUI: Start the local server` serves the client over HTTP on this machine, and
`NikUI: Open NikUI in a browser` opens it. A paired device — see below — reaches
the same pages without the key. A status bar item appears while it is
listening — clicking it offers the link, the clipboard and the off switch. The
port is `nikui.remote.port`.

It starts with the window, and puts itself on the tailnet while it is at it, so
a phone that tries to reach this laptop from somewhere else can. Both are
settings (`nikui.remote.autoStart`, `nikui.remote.tailnet`) and both default to
on, because a phone that only works when somebody remembered to arm the laptop
is a phone that works at the desk it was not needed at. Nothing new listens for
either: the server binds to `127.0.0.1` and nowhere else, `tailscale serve`
takes the connection on the mesh and forwards to it, and a device still has to
be paired before it may say a word.

`tailscale serve` is one setting for the whole machine, so exactly one window
can hold the tailnet address. A second window checks before it claims: if the
address already forwards to a port where a NikUI is still answering, it leaves
it alone and serves on loopback. If it forwards to a port where nothing answers
— a window that was closed, a laptop that restarted — it picks it up. Without
that, opening a second window would silently move every phone to it.

The browser runs the same `media/*.js` as the panel. The one call that knew what
was hosting the page — `acquireVsCodeApi()` — is now `window.nikTransport()`,
which hands back the editor's API in the panel and the same three methods over a
WebSocket in a browser. Nothing else in `media/` knows the difference, which is
the only way the two clients stay one client.

Over a socket, the client also has to survive the network going away. The
transport reconnects with a growing backoff, and immediately when the device
comes back online or the tab becomes visible again; on every reconnect it sends
`ready` and the hub replies `init`, which is the same path a webview takes when
VS Code throws it away and brings it back — so the transcript is rebuilt rather
than appended to. A prompt sent while the socket is down is not swallowed: it
comes straight back to the composer as an `editPrompt`, with the reason on
screen. The connection state is always visible, because a dead socket on a phone
looks exactly like an agent that is thinking.

### Pairing a phone, and what pairing grants

`NikUI: Pair a device` opens a window with a QR code, the same code in type you
can read across a desk, and a one-minute countdown. The device opens the link,
generates a key pair in the browser with the private half marked
**non-extractable**, signs the code with it, and is remembered by its public key.
From then on it proves itself on **every connection** by signing a fresh
challenge — there is no token to steal, and a screenshot of the QR after the
minute is over is worth nothing.

The laptop proves itself too. The QR carries a fingerprint of this window's own
key, the device pins it, and every challenge is answered with a signature over
the device's nonce. A machine that answers on this address later, without the
key, is refused by the phone rather than trusted by it.

- A code lasts **60 seconds**, works **once**, and a wrong guess **closes the
  window** rather than costing an attempt — so there is no guessing game to play.
- The code rides in the URL **fragment**, which browsers never send to a server,
  so it is not in anybody's logs, including ours.
- Eight characters from an alphabet with no `I`, `O`, `0`, `1` or `U`: readable
  across a room and typable on a phone when the camera will not focus.

#### What pairing a phone actually grants

Say it plainly, because the rest of this section is easier to read once it is
said:

- **Pairing grants watching**, and watching is the whole of it: every
  conversation in the window, live, including whatever happens to be on screen —
  source, paths, a token somebody pasted.
- **Granting control grants everything.** NikUI runs Claude with
  `bypassPermissions`, so a prompt from a phone is *any command on this laptop,
  as you, with nothing appearing on the screen first.* A phone with control is
  your keyboard. If the phone is stolen or compromised, so is the laptop.
- **What you keep** is the ability to end it instantly: revoking control or
  forgetting a device closes the socket it is holding within milliseconds, and
  `/status` shows what arrived from it and when.

[`THREAT-MODEL.md`](THREAT-MODEL.md) is the long version: what a website, a
neighbour, a photograph of the QR and a compromised phone each get, where the
fingerprint pin helps and where it does not, and the findings from the review of
this surface.

**A paired device can watch. It cannot steer.** Sending a prompt, answering a
permission, interrupting, touching the queue — all of it is a second grant, made
deliberately per device from the Devices list in the sidebar, and revocable on
its own. The client hides those controls when it has no grant; that is courtesy.
The **host refuses them whatever the client sends**, and writes the attempt down.

Why that line matters: NikUI runs Claude with `bypassPermissions` by default, so
**a prompt from a phone is arbitrary code execution on this laptop**. Granting
control says exactly that, in a dialog, before it happens.

Everything that arrives from a device — allowed or refused — is recorded with the
device's name and shown in `/status` under **System**. Revoking a grant, or
forgetting a device, takes effect on the socket it is holding right now, not on
its next connection.

### Why it is safe to run, and where it stops

NikUI runs Claude with `bypassPermissions` by default, so **anything that can
reach this server can run code on this machine**. Everything about it follows
from that:

- It binds to `127.0.0.1`, and there is no setting that changes that. Reaching
  the laptop from elsewhere is a tunnel's job, not a listening socket's.
- The pages are an **empty shell** — markup, stylesheet, script, no data. The
  fleet, the conversations and the dashboard all arrive over the socket, which is
  where the authority check lives. An unpaired device gets HTML and an
  explanation.
- A socket is either **this machine**, holding the key this window minted, or a
  **paired device** proving it holds its private key. The local key is refused
  the moment a request carries forwarding headers, so it cannot quietly become a
  remote credential when the tunnel lands.
- The `Host` header must be a name we serve, so a hostile site cannot point DNS
  at `127.0.0.1` and have the browser treat this as its own origin.
- A browser sends `Origin` on a WebSocket handshake and has no same-origin policy
  to stop it opening one, so an `Origin` that is not ours is refused.
- Only `media/` is servable, only by extension, and only after the resolved path
  is confirmed to be inside it.

Reaching the laptop from elsewhere is the next section: the tailnet goes in
front, and the local key stops working through it.

### Reaching the laptop from a phone that is elsewhere

`NikUI: Reach this window from my phone` asks **Tailscale** to put itself in
front of the local server. Nothing new listens: `tailscale serve` takes the
connection on the mesh and forwards it to `127.0.0.1`, so the thing exposed is
theirs — already encrypted, already device-authenticated, and wearing a real
certificate — and ours stays exactly where it was.

The certificate is not a nicety. **Web Crypto only exists in a secure context**,
so over a plain `http://192.168.x.x` a phone cannot hold a device key at all and
pairing is impossible. That is why the mesh comes first and a tunnel second,
rather than opening a port on the LAN.

Setup, once:

1. Install Tailscale on the laptop and on the phone, and sign both into the same
   tailnet.
2. In the Tailscale admin console, enable **HTTPS Certificates** for the tailnet
   (Settings → Features). Without it, `tailscale serve` has no certificate to
   use and NikUI will say so rather than half-working.
3. Run `NikUI: Reach this window from my phone`. It reports the address —
   `https://<laptop>.<tailnet>.ts.net` — and offers to pair a device.
4. Pair the phone from that address. The QR now carries the tailnet name, so the
   phone can scan it from anywhere it can reach the mesh.

`NikUI: Stop being reachable from my phone` undoes it, and so does stopping the
server. Only the forwarding this window set up is removed — a `tailscale serve`
you configured for something else is left alone.

While the tailnet is in front of the server, **the local key stops working over
it**: it is refused for any request that arrives forwarded or addressed to
anything but a loopback name. The only way in from the tailnet is a paired
device, which is the point.

The phone tells the three states apart rather than showing one dead socket:
*Live*, *reconnecting* (the laptop answered `/health` but the socket is not up),
and *cannot reach the laptop* (nothing answered at all).

**Verified against a live tailnet** on 2026-09-18: `tailscale serve` forwarding
to a real server, the app and the pairing page fetched over
`https://<laptop>.<tailnet>.ts.net`, the local key refused out there, the QR
carrying the tailnet name, and the forward torn back down leaving nothing
behind. The one thing that surprised: the **first** request to a new name mints
its certificate and can take longer than a client will wait — measured at over
fifteen seconds cold against twenty-one milliseconds warm — so `expose()` knocks
on the door itself before reporting success.

### Two views of one instance

With a phone attached there are two live views of the same conversation, and
they must not fight:

- **Shared** is broadcast: items, status, stats, queue, cost. A prompt sent from
  the phone appears in the laptop panel immediately, through the same `items`
  message, and the other way round.
- **Per client** never leaves the client: the draft you are halfway through,
  where you have scrolled, whether your status sheet is open. A draft is not in
  the protocol in either direction, which is the only way to be sure one cannot
  clobber another.
- **Presence** is a name, not an activity. The header says who else is attached
  and whether they can steer.
- Choosing another instance from a phone moves **the phone**. It does not reach
  across and rearrange the tabs on the laptop.

### On a phone-sized screen

One layer on top of the same client, in `media/browser.css` — which the editor
never loads, so the desktop panel cannot be affected by any of it.

- The fleet is the home screen; a conversation has a way back to it.
- The composer sits above the keyboard, because `media/mobile.js` tracks the
  **visual viewport** rather than the window — the thing phone web apps most
  often get wrong.
- Tap targets are 44 points: send, stop, the queue's controls, Allow and Deny,
  the dashboard's sections.
- The dashboard is full screen and its six sections are **swipeable**, pressing
  the same arrow keys the keyboard would rather than growing a second way
  through.
- The composer's text is 16px, below which iOS zooms the whole page on focus.
- Nothing scrolls sideways except the deliberately wide fleet table.

### Installing it to a home screen

The served pages are a progressive web app: a manifest, icons, a theme colour,
and a service worker that keeps the shell — the script, the stylesheet, the
icons — so opening it from a home screen draws immediately instead of waiting
for a socket.

The worker **never caches a conversation**, and there is nothing to: every byte
of an instance's state arrives over the WebSocket and the pages the server sends
are empty. That was not an accident of the caching work — it is why the pages
were made empty in the first place.

What it does keep is the last fleet it saw, so the app opens with something in
it. That list is never dressed up as current: it is dimmed, dated — *"showing
what it looked like 20 minutes ago"* — untappable, and sits above a **Try
again**. The connection pill is a button too.

Add to Home Screen on iOS, Install on Android. The icons are generated by
`node tools/icons.js` rather than dragged in from somewhere, so they can be
edited and regenerated.

### Being told, instead of checking

A paired device can subscribe to Web Push. Three things are worth it, and by
default nothing else:

| What | When |
| --- | --- |
| **An instance needs you** | It is waiting for a permission answer and cannot go on |
| **The quota ran out** | Everything paused — and again when it resets on its own |
| **An instance failed** | It stopped without finishing |

A turn finishing is available and **off**: four agents finishing overnight is a
phone buzzing all night, and a notification you learn to ignore is worse than no
notification. `nikui.notifyDevices` turns each of them on or off.

The payload is encrypted to the subscription's own key (RFC 8291) and the sender
is proved with a short-lived signed token (RFC 8292), so the push service that
carries it — Apple's, Google's — knows only that a message exists. A subscription
belongs to the device that signed for it and is kept on that device's record, so
**forgetting a device forgets where to reach it** with nothing else to clean up.
A push service that says a subscription is gone gets no more.

Tapping a notification opens that instance.

**Not verified end to end from this machine.** The encryption round-trips, the
token verifies, and the rules about what is worth sending have 50 offline
checks — but a delivery through Apple's or Google's push service needs a real
device, and headless Chrome here refuses notification permission whatever the
DevTools protocol is told, so a notification actually appearing is unproven.

### Working with the lid closed

**Keep working with the lid closed** does what the name says: while an instance
is working — or waiting on your answer — closing the lid does not put the Mac
to sleep. Two minutes after the last job is done it sleeps, the way a closed
laptop should; the two minutes are for the reply you send from the
notification, and a queue draining between turns.

A closed MacBook sleeps whatever a process asks, so this is the one thing in
NikUI that needs your admin password — once, in macOS's own dialog, the first
time you switch it on at the laptop. What that installs is a single sudo rule,
`/etc/sudoers.d/nikui-lid`, allowing exactly three commands without a password:
`pmset -a disablesleep 1`, `pmset -a disablesleep 0` and `pmset sleepnow`.
Nothing else. It is checked by `visudo` before it is moved into place. Undo it
from the NikUI status bar item, or delete the file.

Turning sleep off is a machine-wide flag that outlives any process, so every
way out puts it back: the work finishing; the switch turned off (from anywhere);
the battery reaching 20% on battery power, with your phone told first ("Your
laptop is going to sleep"); the window closing or crashing — a small watchdog
outside the extension waits for it to go and puts the flag back itself; and
the next start, which clears anything a crash of the whole machine left. Two
windows share it properly: the flag goes back when the last one lets go. And
it only ever clears what it set — a Mac you told never to sleep yourself is
left that way.

From a phone it is the same switch (Settings → *Your laptop*, or `/settings`),
with one thing it will not do: raise the password dialog, because that would
put it on a screen nobody is looking at. Before the one-time approval, the phone
says where to give it. Keep the laptop out of a bag while it works.

### Keeping the laptop awake

A laptop that sleeps takes every instance with it, and the phone finds a dead
socket at three in the morning. **Keep awake** stops that: while it is on, the
laptop does not go to sleep on its own for as long as NikUI is listening for a
phone — including when nothing is running, which is exactly when you want to
wake a stopped instance or run a command from far away — and while any instance
is working.

It is one switch with three places to flip it, all of them the same setting:

- **On the phone:** Settings → *Your laptop* → **Keep awake**. On is one tap.
  Off is two, and the second says why: once the laptop sleeps, a phone in
  another country cannot wake it. Needs the same grant as sending prompts; a
  watching-only device can see it and not change it. Every switch is written
  into the trail with the device that did it.
- **In the editor:** the NikUI status bar item → *Keep this laptop awake* /
  *Let this laptop sleep again*, or `NikUI: Settings` → *This machine*.
- **Anywhere:** `nikui.keepAwake`, which is a machine-wide setting — a phone
  turning it off does not leave another window holding it on.

Whichever end changes it, every connected phone is told at once, and the status
bar shows a ☕ while the laptop is being held.

On its own it cannot stop the lid: a closed MacBook sleeps whatever any process
asks, unless it is plugged in with a display attached. That is the other
switch, *Keep working with the lid closed*, above. The display is never kept
on, the assertion is released the moment nothing needs it, and the `caffeinate`
it spawns exits with the extension host, so a crash cannot leave a machine
awake forever. Off by default: keeping somebody's laptop awake is not a
decision to make for them.

### Going public, and why it is the second choice

`NikUI: Open a public address for this window` runs a Cloudflare quick tunnel:
a `trycloudflare.com` hostname, TLS to the edge, forwarding to `127.0.0.1`.
Nothing new listens, and an unpaired visitor still gets nothing but the empty
shell.

It asks first, in a dialog that says what changes, and offers to open the threat
model instead of proceeding. The difference from the tailnet is not technical
subtlety: **a tailnet is devices you authorised, and a public hostname is the
internet.** Use Tailscale if you can. The public tunnel exists for the case where
you cannot install anything on the phone you are holding.

The address lasts until you close it or the window goes away, and closing the
server closes it.

### The wire

`src/wire.js` is the server half of RFC 6455 with no dependencies: the handshake,
a frame reader and a frame writer. Fragmentation, ping/pong, 16- and 64-bit
lengths and the close handshake are all there; masked server frames, extensions
and compression are deliberately not, because each would be a path that is never
exercised and never right. Every rule a client can break closes the socket with
the code the spec asks for, rather than throwing.

One warning, paid for in full: **do not check a protocol constant against a
constant you wrote yourself.** The handshake GUID here was wrong, and the test
that "verified" it hashed the same wrong constant and agreed. What caught it was
connecting Node's own `WebSocket` — an implementation nobody here wrote — to the
server. That check is now permanent, in `test/remote.test.js`.

### The QR code

`src/qr.js` is a QR encoder, byte mode, error correction level M, versions 1 to
10, no dependencies. The same warning applies twice over — it is a specification
written from memory — so it is not trusted on its own word: `npm run test:qr`
renders every version and every mask to a PNG and reads them back through
**Apple's CoreImage detector**, which is a decoder nobody here wrote. The golden
vectors in `test/qr.test.js` were produced that way, and the Reed–Solomon
generator was wrong until that loop said so.

## How it talks to Claude

Each instance spawns:

    claude --output-format stream-json --input-format stream-json --verbose \
           --include-partial-messages --permission-mode <mode> \
           --effort <level> --settings {"outputStyle":"..."} [--model M] [--resume ID]

Prompts go in as `{"type":"user","message":{...}}` lines. Interrupts go in as
`{"type":"control_request","request":{"subtype":"interrupt"}}`. Output is JSONL
which `src/session.js` normalises into flat render items.

Five protocol details worth knowing before you edit that file:

1. **Partial deltas and final messages overlap.** `stream_event` deltas paint
   text as it generates; the CLI then re-emits each block as its own `assistant`
   event. Those events carry a *single-block* `content` array, so the block index
   is always 0 and is useless as a key. Tools are keyed by their `tool_use` id;
   text already painted by deltas is skipped.
2. **Every usage field means something other than it looks like.** `total_cost_usd`
   is cumulative *per process* and restarts at zero when a conversation is
   resumed, so a turn's cost is the delta against a baseline captured at spawn.
   Assistant-event usage is a stale partial for the in-flight message. The
   top-level `result.usage` is the sum over every model call in the turn, which
   makes it right for token totals and badly wrong for context size — a turn with
   three tool calls sums four prompts. Context is the *last* model call only,
   from `usage.iterations` or the newest assistant event.
3. **Cost is never computed here.** `total_cost_usd` already prices each token
   type separately - cache reads at 0.1x input, cache writes at 1.25x (5m) or
   2x (1h) - so the figure is taken as given and only ever differenced or
   summed. Verified against a live turn: the CLI's number matches a
   per-token-type calculation exactly, while charging cache at the input rate
   would overstate it by 125%. A test guards against anyone adding a rate table.
4. **The init event only arrives after the first message**, so a freshly started
   instance reports no slash commands at all. The last list seen is remembered in
   globalState and seeded into new instances, with a built-in list behind that.
5. **Thinking blocks are often signature-only** with empty text. The webview
   hides those rather than showing an empty disclosure.

## Checking the numbers

```
node test/accounting.js   # live: cost, tokens and context against the wire
node test/reload.js       # offline: window reload, old and new stored data
```

`test/accounting.js` waits for each turn to reach the UI, not just the wire, and
says plainly which turn never arrived if one does not. It drives a real instance through a single-tool turn, a
three-tool turn and a process restart, then cross-checks every figure the UI
shows against the raw wire events — context against the last model call, token
totals against `modelUsage`, and per-turn costs against `total_cost_usd`. `test/reload.js` replays a window
reload against storage written by an older version, checking instances, folders,
running totals and tab restoration all come back without spawning anything.

## Tests

    npm test             # 1144 checks, no dependencies, no network, no CLI
    npm run test:webview # 68 checks driving the real webview in a browser
    npm run test:remote  # 69 checks driving the served client in real browsers,
                         #   including one the size of a phone and one cold-starting
                         #   with the laptop switched off
    npm run test:qr      # 22 checks reading our QR codes back with Apple's decoder
    npm run test:live    # 15 checks against the real claude binary (costs tokens)

The offline suite stubs the VS Code API (`test/helpers/vscode-stub.js`) and
drives the real modules: markdown and table rendering, ticket naming, conversation
naming, prompt recall, the folder store, project grouping and drag and drop,
file-reference matching, activation and command parity, history paths, icon
geometry, instance lifecycle, the status report and every section of the sheet it
draws, and the stream parser fed synthetic events in exactly the shape the CLI
emits.

Four of those deserve naming, because each encodes a bug that already bit or one
that would be invisible until it shipped: the parser test asserts a streamed
block is not duplicated by the final single-block assistant event, the cost test
asserts a turn is charged the delta rather than the running total, the sheet test
asserts no rendered mark carries an inline `style` attribute — the webview's CSP
drops those silently, so the charts would come out wrong with nothing in the
console to say why — and the protocol test fails if a message exists on one side
of the wire and not the other.

A check that cannot run says so loudly rather than printing a pass — and
`NIKUI_REQUIRE_CHECKS=1` turns a skip into a failure, for anywhere that has no
excuse for missing a browser.

`npm run test:webview` and `npm run test:remote` are the two checks that need a
browser. The first serves the real panel HTML with the real `media/*.js`, posts
the messages the host would post, then presses the keys a user would. The second
starts the real server and drives a real Chrome over the DevTools protocol: it
opens the page, waits for the socket, watches a turn arrive, types a prompt,
opens `/status`, then kills the socket underneath it and checks the client
reconnects with the conversation intact rather than doubled. Both skip themselves
when no Chrome is installed (`CHROME=/path/to/chrome` to point them at one).

## Layout

    src/extension.js   activation, commands, folder picker
    src/session.js     one instance: process, stream parsing, state machine
    src/manager.js     collection of instances, config, persistence
    src/tree.js        sidebar provider with coloured status icons
    src/hub.js         one instance, many clients: the protocol, no VS Code in it
    src/panel.js       the webview client of that hub: tab title, icon, editor jobs
    src/host.js        what only the editor can do, shared by every transport
    src/page.js        the page itself, once, for whichever host serves it
    src/remote.js      the local HTTP + WebSocket server: loopback, no vscode
    src/auth.js        who may connect: this machine, or a device that can sign
    src/identity.js    this laptop's own key, and the fingerprint a phone pins
    src/devices.js     paired devices, their grants, and what they did
    src/pairing.js     the one-minute window in which a device may introduce itself
    src/pairPanel.js   that window on screen: a QR, a code, a countdown
    src/devicesTree.js the sidebar list of devices, and what each is allowed
    src/qr.js          a QR encoder, verified against Apple's decoder
    src/tunnel.js      Tailscale first, a public tunnel second, both to loopback
    src/push.js        Web Push: encrypted to the device, signed by this window
    src/notify.js      what is worth waking a phone for, and what is not
    src/awake.js       holding the machine awake while something needs it
    src/lid.js         working with the lid closed, and every way it lets go
    src/prefs.js       what /settings shows, and what a change may be
    src/wire.js        RFC 6455, server side, no dependencies
    src/ticket.js      PR/issue extraction and the switch rule
    src/label.js       the one naming rule, shared by instances and history
    src/report.js      everything /status measures, derived in one place
    src/history.js     transcripts on disk: titles, paths, recent list
    media/status.js    the /status sheet: six sections, pure render
    media/charts.js    the SVG chart set the sheet draws with
    media/prompts.js   the composer's prompt recall ring
    media/snippets.js  /table and friends: what you typed, plus a standing instruction
    media/palette.js   what a slash offers, and what picking one writes
    media/prefs.js     the /settings sheet, drawn from the laptop's list
    media/panel.css    all the styling
    media/panel.js     webview front end
    media/transport.js the one seam: the editor's API, or the same over a socket
    media/device.js    this device's key: made here, never exported, signs challenges
    media/pair.js      the pairing screen a phone lands on
    media/home.js      the window as a list, drawn from the socket
    media/mobile.js    the keyboard, the viewport and the swipe: a phone's share
    media/sw.js        the service worker: the shell, never a conversation
    media/pwa.js       installing it, and subscribing to be told
    tools/icons.js     the home-screen icons, drawn rather than imported
    media/browser.css  theme and connection state for when the host is a browser
    media/theme.js     the OS colour scheme, in the terms panel.css understands
    media/markdown.js  dependency-free Markdown renderer
    test/              offline suite plus an opt-in live check

## The app

The same client again, in a native shell — `app/`, built with Capacitor for
iOS and Android. Not a second client: `app/tools/build.js` copies every file
from `media/` and generates the conversation screen with the very same
`renderPage()` the panel uses, and `cd app && npm test` fails the day a copy is
edited instead of an original.

What the app adds is the part a browser never needed — a way to connect to a
laptop in the first place, and a settings screen that answers "is it connected,
what is this device allowed, and how do I undo it" without anybody having to
ask.

And a key that is not in a browser. On a phone the device key is generated
**inside the Secure Enclave or the Android Keystore**, where this app can ask
for a signature and cannot ask for the key — not by export, not through a
backup, not from a rooted shell. A face or fingerprint check is optional and
off by default, because the key is in the chip either way; turned on it is
asked once and not again for five minutes. A phone that paired before it had a
chip can move its key there without pairing again: the key being replaced signs
for the one replacing it, and the laptop says so out loud when it does.

The laptop's protocol did not change for any of it. What did change is that two
encodings now have to be exactly right — Apple hands back a bare EC point,
both platforms sign to DER — so both conversions happen once, in JavaScript, and
`test/hardware.test.js` runs them through the laptop's real verifier.

And a connection nothing in between can read. Every socket between a device and
this laptop now agrees a throwaway key at the handshake and seals every frame
after it — AES-256-GCM, a key per direction, fresh for each connection. Both
ends name both throwaway keys inside the signatures they were already
exchanging, so the agreement cannot be swapped, stripped or replayed. TLS still
carries all of it; this is the layer that survives TLS being wrong, which is the
relay the threat model used to name as open.

Two switches go with it, both in the status-bar menu:

| Setting | Default | What it does |
| --- | --- | --- |
| `nikui.remote.requireEncryption` | on | A device that will not seal the channel is refused |
| `nikui.remote.appOnly` | off | Outside this machine, only pairing, the socket, the pulse and the push key exist — no page, no client, no worker, no manifest |

And notifications that need nothing outside the two machines. What the laptop
already decided was worth telling you now also goes **down the socket the app is
holding**, so a phone with the app open is told without a push service, an
account anywhere, or the laptop being reachable from outside at all. The phone
decides which kinds are worth interrupting for, and tapping one opens the
instance it was about. Android can keep listening while the app is in a pocket,
behind the quiet ongoing notification the system requires; an iPhone cannot, and
the app says so rather than offering a switch that would do nothing.

And pairing that is pointing a phone at a laptop. The pairing panel offers the
same invitation in two forms — one the phone's camera hands to **the app**, one
it hands to a browser — so connecting is: run the command, point the camera, tap
*Pair*. No scanner in the app, no camera permission, no library. Typing the code
is still there for when that does not work.

And a way to actually ship it. One version stamped into both platforms, a signed
Android release build with the R8 keep rules Capacitor needs to survive
shrinking, cleartext refused except to loopback, Apple's privacy manifest, and
[`app/RELEASE.md`](app/RELEASE.md) — the runbook, including what each platform
costs. Android needs nothing from anybody; an iPhone needs an Apple Developer
account for anything past seven days.

Which is also the last functional gap: an iPhone cannot keep a socket open, so
being told while the app is *closed* goes through Apple's push network. That is
implemented, tested to the socket, and inert until four settings are filled in.

    npm run app             # build the bundle and sync both platforms
    npm run test:app        # 99 checks driving the real bundle in a real browser
    cd app && npm test      # 97 checks that the bundle is still a copy, and shippable

[`app/README.md`](app/README.md) is the detail.

## Security

[`THREAT-MODEL.md`](THREAT-MODEL.md) states what NikUI is exposed to and what it
is not: the assets, seven kinds of attacker and what each of them gets, the
pairing and connection exchanges examined for replay, downgrade and
machine-in-the-middle, the boundaries that are code rather than intention, and
the findings from the review of the remote surface — all five of which are
fixed, including an HTML injection through a URL path and a CSP nonce that came
from `Math.random()`.

The one-line version: **a phone you have granted control is your keyboard**,
because NikUI runs Claude with permissions bypassed.

## Not implemented yet

- Syntax highlighting inside code fences.
- `@` file mentions.
- Permission prompts are wired end to end (`can_use_tool` -> Allow/Deny) but only
  fire if the CLI asks, which it does not under `bypassPermissions`.
