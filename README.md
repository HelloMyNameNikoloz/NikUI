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
  navigable. Options are seeded for `/effort` and learned at runtime by reading
  `Usage: /cmd <a|b|c>` out of the CLI's own replies.
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
  reaches the CLI. The panel keeps showing your words, with a `+table` chip you
  can hover to read what was added, so a long standing instruction is not
  reprinted on every turn. They appear in the `/` palette tagged *NikUI*, and
  they are yours to write: `nikui.promptSnippets` maps a word to its text, your
  entries merged over the built-in one, and an empty string switches one off.
  The one that ships asks for the current plan as a table — 🟢 done, 🟡 in
  progress, 🔴 not started — scoped to the task in hand rather than the project.
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
| `/table` | Append the standing "plan as a table" instruction to this prompt |
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
| `nikui.model` | *(empty)* | Passed to `--model`; empty uses your default |
| `nikui.permissionMode` | `bypassPermissions` | Passed to `--permission-mode` |
| `nikui.effort` | `max` | Passed to `--effort` (low/medium/high/xhigh/max) |
| `nikui.outputStyle` | `Concise` | Passed inline via `--settings` |
| `nikui.extraArgs` | `[]` | Extra CLI arguments |
| `nikui.autoTitleFromTicket` | `true` | Name instances from PR/issue numbers |
| `nikui.fontFamily` | *(empty)* | Conversation font; empty uses the UI font |
| `nikui.fontSize` | `13` | Conversation font size |
| `nikui.showThinking` | `true` | Show thinking blocks, collapsed |
| `nikui.groupByProject` | `auto` | Nest instances under their project folder |
| `nikui.promptSnippets` | `/table` | Words that append a standing instruction to your prompt |
| `nikui.pauseWhenQuotaRuns` | `true` | Hold every instance when the usage limit is spent, and start them again when it resets |
| `nikui.resumePrompt` | see below | What to send an instance that was cut off mid-turn, once the quota is back |
| `nikui.maxTranscriptItems` | `400` | Messages an instance keeps in memory; 0 keeps everything |
| `nikui.keepHiddenPanelsWarm` | `false` | Hold a hidden panel's webview in memory for instant switching |
| `nikui.notifyOnAttention` | `true` | Tell you when an instance you cannot see is blocked or failed to start |
| `nikui.interruptOnSingleEscape` | `false` | Interrupt on the first Escape, the way the CLI does |
| `nikui.statusEmoji` | see below | Emoji per status in tab titles |

Default emoji: idle ⚪, working 🟠, waiting 🔴, done 🟢, error 🔴, stopped ⚫.

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

`test/protocol.test.js` holds the protocol as two lists — what a client may send,
what the host may send — and reads both sides out of the source to compare
against them. A message added to the webview and forgotten in the hub, or sent by
the hub and never drawn, fails there. The same suite drives a plain in-memory
client through every message in both directions, so a new transport has a
conformance suite waiting for it rather than a reading exercise.

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

    npm test             # 688 checks, no dependencies, no network, no CLI
    npm run test:webview # 68 checks driving the real webview in a browser
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

`npm run test:webview` is the one check that needs a browser: it serves the real
panel HTML with the real `media/*.js`, posts the messages the host would post,
then presses the keys a user would. It skips itself when no Chrome is installed
(`CHROME=/path/to/chrome` to point it at one).

## Layout

    src/extension.js   activation, commands, folder picker
    src/session.js     one instance: process, stream parsing, state machine
    src/manager.js     collection of instances, config, persistence
    src/tree.js        sidebar provider with coloured status icons
    src/hub.js         one instance, many clients: the protocol, no VS Code in it
    src/panel.js       the webview client of that hub: tab title, icon, editor jobs
    src/ticket.js      PR/issue extraction and the switch rule
    src/label.js       the one naming rule, shared by instances and history
    src/report.js      everything /status measures, derived in one place
    src/history.js     transcripts on disk: titles, paths, recent list
    media/status.js    the /status sheet: six sections, pure render
    media/charts.js    the SVG chart set the sheet draws with
    media/prompts.js   the composer's prompt recall ring
    media/snippets.js  /table and friends: what you typed, plus a standing instruction
    media/panel.css    all the styling
    media/panel.js     webview front end
    media/markdown.js  dependency-free Markdown renderer
    test/              offline suite plus an opt-in live check

## Not implemented yet

- Syntax highlighting inside code fences.
- `@` file mentions.
- Permission prompts are wired end to end (`can_use_tool` -> Allow/Deny) but only
  fire if the CLI asks, which it does not under `bypassPermissions`.
