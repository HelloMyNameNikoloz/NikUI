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
  with its own editor tab.
- **Real coloured status icons** on the editor tab and in the sidebar — orange
  while working, green when done, red when it needs you. Not an emoji in a
  string: an actual coloured icon, which a terminal tab cannot do.
- **Automatic naming.** Paste a GitHub PR or issue link and the instance names
  itself `1338`. A number mentioned in a read-only request ("analyse #1339")
  does not steal a tab that is already working a different ticket.
- **Rendered markdown** — tables with borders, fenced code with a language tag,
  nested lists, blockquotes.
- **Collapsible tool calls** showing the command, the input and the result.
- **Interrupt** mid-turn (Esc or the Stop button) over the CLI's control channel.
- **Two-stage command palette.** `/` lists the session's own commands; pick one
  that takes a fixed set of values and its options appear immediately, arrow
  navigable. Options are seeded for `/effort` and learned at runtime by reading
  `Usage: /cmd <a|b|c>` out of the CLI's own replies.
- **Copy buttons** on every code block, including tool input and output.
- **Queued prompts.** Send while an instance is busy and the prompt stacks
  instead of being dropped. The queue drains in order, five seconds after a turn
  is genuinely finished — the gate also waits on any tool still running — and
  every queued item can be removed or the whole queue cleared.
- **Clickable file references.** `src/session.js:214` in prose or tool output
  opens that file at that line, beside the conversation. URLs and email
  addresses are left alone.
- **Context budget meter** in the title bar: what the last turn had to read
  against the model's context window, turning amber at 70% and red at 90%.
- **Your own folders.** Create named folders from the + on the Instances title
  bar and drag instances into them (multi-select works). Drag onto empty space
  to take one back out, or use Move to Folder... from its context menu. Folders
  and their contents persist across reloads; deleting a folder never touches the
  instances in it.
- **Grouped by project.** Instances nest under their project folder — a git
  worktree groups with the repo it belongs to — with a per-group count, working
  count and summed cost. `nikui.groupByProject` is `auto` (nest only once more
  than one project is open), `always` or `never`.
- **Close an instance** from the × on its row: the process is killed (SIGTERM,
  then SIGKILL if it lingers) and the row disappears, while the conversation
  stays in History to reopen later. You are only asked to confirm if a turn is
  still running.
- **History is always reachable.** Both views are pinned visible, the provider
  never throws, and `NikUI: Show History` (also a button on the Instances title
  bar) focuses it if it ever gets dismissed.
- **Resume** — instances remember their Claude session id across reloads.
- **Instances survive a window reload.** They come back in the sidebar, VS Code
  restores their editor tabs, and opening one replays its saved transcript and
  reattaches the process with `--resume`. Processes are not respawned at
  activation, so a reload never fires off a pile of CLI processes on its own.
- **Reading beats following.** Auto-scroll sticks to the bottom only while you
  are at the bottom; scroll up and it stops, with a Jump to latest pill to
  re-arm it.

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
| `nikui.statusEmoji` | see below | Emoji per status in tab titles |

Default emoji: idle ⚪, working 🟠, waiting 🔴, done 🟢, error 🔴, stopped ⚫.

## How it talks to Claude

Each instance spawns:

    claude --output-format stream-json --input-format stream-json --verbose \
           --include-partial-messages --permission-mode <mode> \
           --effort <level> --settings {"outputStyle":"..."} [--model M] [--resume ID]

Prompts go in as `{"type":"user","message":{...}}` lines. Interrupts go in as
`{"type":"control_request","request":{"subtype":"interrupt"}}`. Output is JSONL
which `src/session.js` normalises into flat render items.

Four protocol details worth knowing before you edit that file:

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
3. **The init event only arrives after the first message**, so a freshly started
   instance reports no slash commands at all. The last list seen is remembered in
   globalState and seeded into new instances, with a built-in list behind that.
4. **Thinking blocks are often signature-only** with empty text. The webview
   hides those rather than showing an empty disclosure.

## Checking the numbers

```
node test/accounting.js   # live: cost, tokens and context against the wire
node test/reload.js       # offline: window reload, old and new stored data
```

`test/accounting.js` drives a real instance through a single-tool turn, a
three-tool turn and a process restart, then cross-checks every figure the UI
shows against the raw wire events — context against the last model call, token
totals against `modelUsage`, and per-turn costs against `total_cost_usd`. `test/reload.js` replays a window
reload against storage written by an older version, checking instances, folders,
running totals and tab restoration all come back without spawning anything.

## Tests

    npm test          # 126 checks, no dependencies, no network, no CLI
    npm run test:live # 15 checks against the real claude binary (costs tokens)

The offline suite stubs the VS Code API (`test/helpers/vscode-stub.js`) and
drives the real modules: markdown and table rendering, ticket naming, the folder
store, project grouping and drag and drop, file-reference matching, activation
and command parity, history paths, and the stream parser fed synthetic events in
exactly the shape the CLI emits.

Two of those deserve naming, because both encode a bug that already bit:
the parser test asserts a streamed block is not duplicated by the final
single-block assistant event, and the cost test asserts a turn is charged the
delta rather than the running total.

## Layout

    src/extension.js   activation, commands, folder picker
    src/session.js     one instance: process, stream parsing, state machine
    src/manager.js     collection of instances, config, persistence
    src/tree.js        sidebar provider with coloured status icons
    src/panel.js       webview host, tab title and icon
    src/ticket.js      PR/issue extraction and the switch rule
    media/panel.css    all the styling
    media/panel.js     webview front end
    media/markdown.js  dependency-free Markdown renderer
    test/              offline suite plus an opt-in live check

## Not implemented yet

- Syntax highlighting inside code fences.
- `@` file mentions.
- Permission prompts are wired end to end (`can_use_tool` -> Allow/Deny) but only
  fire if the CLI asks, which it does not under `bypassPermissions`.
