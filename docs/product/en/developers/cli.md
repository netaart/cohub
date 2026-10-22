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

Use a custom API endpoint for self-hosted deployments or proxies:

```bash
cohub --base-url https://api.example.com spaces ls
COHUB_BASE_URL=https://api.example.com cohub spaces ls
```

`--base-url` takes precedence over `COHUB_BASE_URL`. Without either, the CLI uses
the selected environment's default API address. Configure other endpoints separately:

| Variable | Endpoint |
| --- | --- |
| `COHUB_BASE_URL` | API base URL |
| `COHUB_WS_URL` | Realtime gateway URL (`http(s)` or `ws(s)`) |
| `COHUB_WEB_URL` | Web base URL used in links |

Changing the API base URL does not change the gateway or authentication provider.
For self-hosted authentication, set `COHUB_AUTH_ISSUER`, `COHUB_AUTH_CLIENT_ID`,
and, if needed, `COHUB_AUTH_RESOURCE` and `COHUB_AUTH_SCOPE`. Stored login sessions,
Home Space caches, and Runtime directory bindings are scoped to the API base URL.
Sign in once for each custom server, or supply `COHUB_EXECUTION_TOKEN`.

## Global flags

| Flag | Purpose |
| --- | --- |
| `-s, --space <space>` | Target Space for space-scoped commands |
| `--base-url <url>` | Override the API base URL |
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

Commands that start new work — `prompt`, `completion`, `decision`, `generate`,
`apps`, and `public` — fall back to your Home Space when nothing else names a target. Every
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

### Decide

Answer yes/no, choice, and score questions about text or images. Questions are
inline JSON or a JSON file; local images are uploaded as WebP first.
Text and `--image` append to a text or array `state` from `--input` without
replacing it. A JSON object state cannot be combined with additional text or
images; express the whole state as a text/image array instead.

```bash
cohub decision "I was charged twice" -q questions.json
cat ticket.txt | cohub decision -q questions.json --json
cohub decision "Duplicate charge?" --image receipt.png -q questions.json
cohub decision --input request.json
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
cohub apps domains add <app> app.example.com --yes
cohub apps domains check <app> app.example.com
```

### Rooms

Take part in a published App's realtime room like any member: read and publish
its events, and set what others see about you. Join with an invite from the
App (`room.invite()`), or create a room for an App you manage.

```bash
cohub rooms create --app <app>                      # prints an invite and the link that opens the room
cohub rooms join <invite> --presence '{"name":"Guide"}'
cohub rooms get <room>                              # members, their kind and presence, the latest sequence
cohub rooms events <room> --after 42 --type 'chat.*'
cohub rooms events <room> --wait 10m                # returns when someone else publishes
cohub rooms events <room> --follow
cohub rooms publish <room> chat.message '{"text":"Hello"}'
cohub rooms presence <room> '{"status":"away"}'
cohub rooms invite <room>
cohub rooms leave <room>
```

Your seat needs no open connection: every call keeps it, and it lapses after
`--idle` (30 minutes by default) without one. An Agent holds one seat per Chat
and shows as `agent` with its model; a person shows as `cli`. Events are kept
in the room history — the latest 1,000 published, up to 512 KB — so `--after`
resumes where you left off.

For bidirectional realtime events and member/presence/track announcements, keep a connection open:

```bash
cohub rooms connect <room> --json
cohub rooms connect <room> --after 42 --input --json
```

`--input` accepts one JSON command per line: `{"op":"publish","type":"chat.message","data":{"text":"Hello"}}`, `{"op":"send","type":"cursor","data":{"x":12}}`, or `{"op":"presence","presence":{"status":"ready"}}`. `publish` returns an `ack` with its sequence; `send` is transient and has no acknowledgement or history. Input EOF keeps receiving until interrupted. Output is NDJSON with `kind` values including `connected`, `state`, `members`, `event`, `ack`, `gap`, and `input_error`. Each input line is limited to 20 KB; slow output disconnects with an error instead of buffering indefinitely.

The connection renews your existing seat. Ctrl-C detaches it; `rooms leave` gives up the seat and closes attached connections. Reconnect restores members and replays retained published events; `gap` means state must be resynchronized. Audio/video transport is not included in this command.

Node applications use `CohubClient.rooms.connect(roomId, { after, onRoom })`; register listeners in `onRoom` to receive the initial snapshot and replay. The returned room supports `publish`, `send`, `setPresence`, `subscribeAll`, and `onMembersChanged`. Call `room.disconnect()` to detach, `room.leave()` to give up the seat, and `client.disconnect()` to close the transport. `CohubHttpClient` retains its lightweight HTTP API.

### RTC media and data streams

`rooms rtc` runs WebRTC in a separate Go/Pion helper (`cohub-rtc`). The CLI downloads and verifies the helper for your platform on first use; pass `--helper <path>` to use a local build. FFmpeg is needed only for format conversion:

```bash
cohub rooms rtc <room> --audio ./voice.pcm --rate 48000 --channels 1 --output ./received
cohub rooms rtc <room> --video ./clip.i420 --size 640x360 --fps 30 --output ./received
cohub rooms rtc <room> --channel chat --data-input -
```

Audio is s16le PCM; video is raw I420. Encoded Ogg Opus (`--audio-format opus`) and VP8 IVF (`--video-format vp8`) inputs are passed through without re-encoding. Use FFmpeg or your model adapter to supply files/pipes. Only one input may use stdin. Completed inputs stop publishing, but receiving continues until Ctrl-C. `--participant` filters received media; `--delivery latest` selects best-effort DataChannel delivery. Output is NDJSON. Received tracks are stored in unique raw frame files with per-frame timing/format metadata; these are decoded frames, not the sender's original media. No recording occurs without `--output`. `--output -` streams framed binary media to stdout (4-byte big-endian JSON header length, UTF-8 header including `bytes`, then payload); status moves to stderr. This supports realtime model consumers without Base64 or intermediate files. Buffers are bounded and slow output fails explicitly. Each track replacement starts a new segment.

The helper runs in an isolated child process. Graceful shutdown releases RTC before disconnecting; your room seat remains. Only one RTC session may own an Agent seat at a time. Node code may supply `room.rtc({ createPeerConnection })` to inject a custom PeerConnection. See `apps/sandbox/cmd/cohub-rtc/README.md` for local builds, formats, and limitations. A configured server SFU is required.

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
Local harnesses are Pi, Codex, Claude Code (`claude`), WorkBuddy (`codebuddy`) and Cursor (`cursor-agent`). Without
`--harness`, every installed one is tried and one that cannot start is skipped with a warning.

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

`boards schema` explains every field, and `boards preset` prints tracks for a preset motion — as an apply-ready patch with `--animation`, or bare `tracks` without it:

```bash
cohub -s <spaceId> boards schema                 # units, scale, item types, colors, animatable properties
cohub -s <spaceId> boards schema arrow           # one target
cohub -s <spaceId> boards examples lesson > lesson.json
cohub -s <spaceId> boards preset rise --targets a,b --animation intro | cohub boards apply <boardId> -i -
cohub -s <spaceId> boards preset float --targets ship   # bare tracks, to fold into your own animation
```

`boards history` lists versions or restores one. Playback is shared by every viewer (`play`, `pause`, `resume`, `seek`, `next`, `stop`), `boards export` renders images and videos in any built-in theme (`--theme`), and `boards watch` streams changes and playback.

`video` and `audio` items accept `props.time` in milliseconds, so an animation track can drive it:

```json
{
  "target": "music",
  "property": "props.time",
  "keyframes": [{ "at": 0, "value": 0 }, { "at": 6000, "value": 6000 }]
}
```

A `task` item is a live card for a generation run: write only `props.taskRunId`, and the server keeps its status and results up to date. Any item can attach `script: { src, params }`, a JavaScript module that runs in a worker and draws or adds behavior; a `custom` item is an empty box whose content the module draws. `cohub boards schema script` lists the module API, and `cohub boards examples custom --module` prints a starter module.

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
cohub generate -m song2 --text "prompt=upbeat synthwave" --text "lyrics=[Verse] Neon lights" --param seed=42
```

`search` finds Spaces, chats by title or by the messages sent in them, and label items. `--types chat,space,label` narrows the result types, and `--space-id` searches every chat you can view in one Space; chat rows show the matching message.

`models ls` shows each LLM's per-million-token cost (for example `$3 /M input · $15 /M output`) and hides models marked `hidden`. `models ls --model-type multimodal` shows each model's unit price (for example `$0.04 / image` or `$0.10–$0.50 / second`); `--json` returns the raw `pricing` object (`unit`, `amount` or `min`/`max`, optional `note`).

`generate --text <role>=<text>` passes a text input tagged with a role from the model's text inputs (`cohub models show <model>`); repeat it for each text block.

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
