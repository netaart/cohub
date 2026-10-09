---
title: CLI
description: Install Cohub CLI, sign in, and run the main Space workflows from your terminal.
---

The Cohub CLI exposes the same product surface from a terminal: Spaces, Chats, files, Saves, Apps, generation, and more.

Package: `@neta-art/cohub-cli`

## Install

```bash
npm install -g @neta-art/cohub-cli
cohub --help
```

## Sign in

```bash
cohub auth login
cohub auth whoami
```

The CLI stores a session and refreshes it automatically. CLI self-updates run in the background so commands are not blocked; a successful update takes effect on the next invocation. Set `COHUB_CLI_AUTO_UPDATE=0` to disable them.

In Sandbox or CI, `COHUB_EXECUTION_TOKEN` can override stored auth for ephemeral runs.

## Environments

Production is the default.

```bash
ENV=dev cohub auth login
ENV=dev cohub spaces ls
```

## Global flags

| Flag | Purpose |
| --- | --- |
| `-s, --space <space>` | Target Space for space-scoped commands |
| `--json` | Machine-readable output |
| `-h, --help` | Command help |

Many workflows need a Space. The CLI uses `-s`, then `COHUB_SPACE_ID`, then the
Space remembered for the current directory by `cohub runtime up`. `<space>` is a
Space ID, a slug you own such as `home`, or `username/slug`:

```bash
cohub -s <spaceId> spaces get
cohub -s home spaces files ls
COHUB_SPACE_ID=<spaceId> cohub spaces get
```

Commands that start new work — `prompt`, `completion`, `generate`, `apps`, and
`public` — fall back to your Home Space when nothing else names a target. Every
other Space command reads or changes existing Space state, so it stops with an
error instead of guessing.

## Terminology

| UI | CLI |
| --- | --- |
| Chat | Session |
| Save | Checkpoint |
| Tasks | Task runs |
| Scheduled prompt | `spaces prompt` schedule / cron jobs |

## Common workflows

### Spaces

```bash
cohub spaces ls --json
cohub spaces create --name "Demo" --json
cohub spaces get <spaceId> --json
cohub -s <spaceId> spaces files ls
```

### Prompt a Chat

```bash
cohub -s <spaceId> spaces prompt "Fix the failing tests" --json
cohub -s <spaceId> spaces prompt --title "Planning" "Draft a launch plan" --json
cohub -s <spaceId> spaces prompt --session <sessionId> "Continue from the diff" --json
```

Schedule:

```bash
cohub -s <spaceId> spaces prompt --at "2026-07-20T09:00:00+08:00" "Weekly review" --json
```

### Run a command in the Space workspace

```bash
cohub -s <spaceId> run -- git status
```

### Files

```bash
cohub -s <spaceId> spaces files ls
cohub -s <spaceId> spaces files cat README.md
cohub -s <spaceId> spaces files cat logo.png > logo.png
cohub -s <spaceId> spaces files write notes.md --stdin < notes.md
cohub -s <spaceId> spaces files upload ./src
cohub -s <spaceId> spaces files cp -r <otherSpaceId>:assets assets
cohub -s <spaceId> spaces files diff
```

`cp` works like `scp`: the last path is the destination, and `<space>:<path>` names a
Space by id, `username/slug`, or the slug of a Space you own. Bare paths address the
current Space when `-s` or `COHUB_SPACE_ID` declares one, and local files otherwise, so
the same command uploads, downloads, or copies between Spaces. Copies between Spaces
run server-side, so file content never passes through the CLI.

`upload` places each file under `--dir`; a directory argument contributes its
contents directly, so `upload dist --dir apps/demo` lands at `apps/demo/index.html`,
not `apps/demo/dist/index.html`.

### Apps

`apps publish` detects the source from the runtime by default: local CLI runs use local
filesystem paths, while Cohub Sandbox runs use Space workspace paths. Use
`--source workspace` or `--source local` to override this explicitly.

```bash
cohub -s <spaceId> apps publish demo --file ./dist/index.html
cohub -s <spaceId> apps publish site --dir ./dist
cohub -s <spaceId> apps publish site --source workspace --dir dist
cohub -s <spaceId> apps ls --json
cohub apps stats <workId|url|username/space/work>
```

Realtime rooms use a published App's runtime identity. Use
`client.app.realtime` inside the App; the CLI intentionally has no room
commands.

### Drive the Cohub UI

An Agent running in a Space can show a file or App preview in the Cohub tab the chat
started from, and call methods the App exposes.

```bash
cohub desktop open <appId|url|app://...|username/space/app|file://path>
cohub desktop open file://src/main.ts
cohub desktop open app://alice/studio/launch
cohub desktop open app://alice/studio/milk-frog --as overlay
cohub desktop open <app-or-file> --call selection.get
cohub desktop open <app> --call board.focus --data '{"nodeId":"n1"}'
```

Showing a preview is idempotent: repeating it re-activates the same tab. `--call`
waits for the App to announce readiness, then invokes the method. Which methods
exist is up to the App author, registered with
`client.app.surface.handle(name, handler)`.

Commands only ever reach the frontend instance that originated the current work,
resolved from request provenance. They cannot target another user, and there is
no DOM access or script evaluation.

### Local Runtime

Expose a local folder as the Space Runtime:

```bash
cd ./my-project

# The first run prompts to create and name the directory's Space.
cohub runtime up

# Later runs recommend reusing it; native chat sync is enabled by default
# after one consent (default yes).
cohub runtime up -d
cohub runtime status
cohub runtime logs --level warn --follow
cohub runtime down

# Optional: request a new Space (-n is --new, not --name).
cohub runtime up -n --name another-project

# Optional: share this computer's screen (asks first, default no),
# or a virtual one on a headless Linux machine.
cohub runtime up --display
cohub runtime up --display xvfb:1920x1080
```

Bindings are scoped by local directory, account, and environment, and stored in
`~/.config/cohub/runtime-spaces.json`. Omitting `--space` reads the binding;
an explicit `--space` or `COHUB_SPACE_ID` overrides and updates it.
`-d` returns the Space link, process ID and log location, then runs in the background.
If not ready within 30 seconds, it returns exit code 2 and continues connecting.
`--yes` authorizes local execution without interaction. `down` retains all data and
requires `--yes` when work is unconfirmed. Network reconnection is automatic; it does
not replay model or tool work, and a disconnect does not confirm a task stopped.

### Displays

Screens a Space's machine shares: a phone from the Android app, a computer from
`cohub runtime up --display`, or a sandbox's virtual screen. Coordinates are pixels of your latest
`capture` (or of `--size`); where a display has an element tree, refs from `tree` are more precise:

```bash
cohub spaces displays ls
cohub spaces displays start                   # a virtual screen, where available; stop ends it
cohub spaces displays capture -o screen.jpg   # longest edge 1280 by default
cohub spaces displays tree                    # e3.12 button "Send" (980,2210 120x80)
cohub spaces displays tree --actionable       # only what takes an action
cohub spaces displays tap e3.12 --screenshot  # act, then save a screenshot
cohub spaces displays type "hello" --into e3.4
cohub spaces displays tap 540 1200
cohub spaces displays swipe 288 1000 288 300
cohub spaces displays tap 300 200 --count 2   # double-click; --button secondary right-clicks
cohub spaces displays type "hello"
cohub spaces displays key Control+a
cohub spaces displays press back              # phones list their system buttons
```

On macOS, the terminal running the Runtime needs Screen Recording, and Accessibility to control
the screen (System Settings → Privacy & Security). Linux needs an X11 session; Wayland is not
supported yet.

`act` runs a JSON array of actions from `--actions` or stdin, in one timeline. When a person acts on
the screen, the action stops with `display_preempted`: look again before acting. Watching, `capture`
and `tree` take view access to the sandbox; acting and `start` / `stop` take what running commands
does.

### Boards

A Board is one JSON document with three parts — `board` settings, an `items` map, and an `animations` map — and every command accepts a Board ID or a `.board` path. `get` is resource-scoped, so reading one item does not load the whole Board:

```bash
cohub -s <spaceId> boards get boards/plan.board --json
cohub -s <spaceId> boards get <boardId> --only board
cohub -s <spaceId> boards get <boardId> --only items
cohub -s <spaceId> boards get <boardId> --items title,note
cohub -s <spaceId> boards get <boardId> --within s1
```

`apply` is the only write: a JSON Merge Patch of the document where fields merge, `null` deletes, and anything unmentioned stays. `--replace` makes the document equal to the patch instead of merging it. `--dry-run` validates without writing, and `--base-version` / `--mutation-id` control retries.

```bash
cohub -s <spaceId> boards apply <boardId> '{"items":{"title":{"props":{"text":"New title"}}}}'
cohub -s <spaceId> boards apply <boardId> -i patch.json --dry-run
cohub -s <spaceId> boards apply <boardId> -i - < changes.json
```

`boards schema` is the source of truth for every field, and `boards preset` prints tracks for a preset motion — as an apply-ready patch with `--animation`, or bare `tracks` without it:

```bash
cohub -s <spaceId> boards schema                 # units, item types, colors, animatable properties
cohub -s <spaceId> boards schema arrow           # one target
cohub -s <spaceId> boards examples lesson > lesson.json
cohub -s <spaceId> boards preset rise --targets a,b --animation intro | cohub boards apply <boardId> -i -
cohub -s <spaceId> boards preset float --targets ship   # bare tracks, to fold into your own animation
```

`boards history` lists versions or restores one. Timeline playback lives on the top-level `boards` commands (`play`, `pause`, `resume`, `seek`, `next`, `stop`), image and video rendering stays on `boards export`, and `boards watch` streams changes and playback.

Board media and effects use the same item model as every other Board element. `video` and `audio` items accept `props.time` in milliseconds, so an animation track can target `props.time` directly. For example:

```json
{
  "target": "music",
  "property": "time",
  "keyframes": [{ "at": 0, "value": 0 }, { "at": 6000, "value": 6000 }]
}
```

An `effect` item uses a typed `props` object: `kind`, `rate`, `life`, `particleSize`, `speed`, `direction`, `spread`, `gravity`, `intensity`, optional `follow`, and optional `seed`. A `sketch` item points to a `.js` or `.mjs` Space file exporting `draw(ctx, frame)`; the headless exporter runs the same frame contract when creating PNG sequences or videos.

Video export consumes a frame range and uses the range step as its default frame rate:

```bash
cohub boards export demo.board --animation intro --at 0:6s:40ms -o intro.mp4
```


### Search and models

```bash
cohub search "release notes"
cohub models ls
cohub models ls --model-type multimodal
cohub generate "A calm lake at sunrise" --model <model> --output lake.png
```

`search` finds Spaces, chats by title or by the messages sent in them, and label items. `--types chat,space,label` narrows the result types, and `--space-id` searches every chat you can view in one Space; chat rows show the matching message.

`models ls` shows each LLM's per-million-token cost (for example `$3 /M input · $15 /M output`) and hides models marked `hidden`. `models ls --model-type multimodal` shows each model's unit price (for example `$0.04 / image` or `$0.10–$0.50 / second`); `--json` returns the raw `pricing` object (`unit`, `amount` or `min`/`max`, optional `note`).

## Output discipline

Use `--json` whenever a script or Agent needs to chain commands.

```bash
cohub spaces ls --json
cohub -s <spaceId> spaces sessions ls --json
```

Human-readable output is fine for interactive use. JSON is better for automation.

## Next steps

- Product loop from the UI: [Quick start](/docs/learn/quick-start)
- App capabilities and permissions: [App development](/docs/developers/apps)
- Programmatic access: [SDK](/docs/developers/sdk)
- Publishing details: [Apps](/docs/create/apps)
