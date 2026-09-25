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
| `-s, --space <id>` | Target Space for space-scoped commands |
| `--json` | Machine-readable output |
| `-h, --help` | Command help |

Many workflows need a Space. Without an explicit target, the CLI uses the Space
remembered for the current directory before falling back to Home:

```bash
cohub -s <spaceId> spaces get
COHUB_SPACE_ID=<spaceId> cohub spaces get
```

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
cohub -s <spaceId> spaces files write notes.md --stdin < notes.md
cohub -s <spaceId> spaces files upload ./src
cohub -s <spaceId> spaces files diff
```

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
```

Bindings are scoped by local directory, account, and environment, and stored in
`~/.config/cohub/runtime-spaces.json`. Omitting `--space` reads the binding;
an explicit `--space` or `COHUB_SPACE_ID` overrides and updates it.
`-d` returns the Space link, process ID and log location, then runs in the background.
If not ready within 30 seconds, it returns exit code 2 and continues connecting.
`--yes` authorizes local execution without interaction. `down` retains all data and
requires `--yes` when work is unconfirmed. Network reconnection is automatic; it does
not replay model or tool work, and a disconnect does not confirm a task stopped.

### Boards

Board commands accept a Board ID or a `.board` path. Reads are resource-scoped, so inspecting one item does not load the whole Board.

```bash
cohub -s <spaceId> boards inspect boards/plan.board --json
cohub -s <spaceId> boards items list <boardId>
cohub -s <spaceId> boards items get <boardId> <itemId> --json
cohub -s <spaceId> boards connections list <boardId>
cohub -s <spaceId> boards effects get <boardId> <effectId> --json
cohub -s <spaceId> boards compositions get <boardId> <compositionId> --json
```

Use `boards examples` for starter JSON and `boards capabilities --json` for supported schemas. Apply a group of changes atomically with a semantic command batch:

```bash
cohub boards examples item text > item.json
cohub -s <spaceId> boards items create <boardId> --input item.json
cohub boards examples batch basic > changes.json
cohub -s <spaceId> boards batch <boardId> --input changes.json --dry-run
cohub -s <spaceId> boards batch <boardId> --input changes.json
```

A batch file has a `commands` array. It can combine item, connection, effect, composition, and Board patch commands without containing a full Board snapshot. Use `--base-version` and `--mutation-id` for controlled retries.

Playback commands are grouped under `boards playback`; image rendering remains available through `boards export`.

### Search and models

```bash
cohub search "release notes"
cohub models ls
cohub models ls --model-type multimodal
cohub generate "A calm lake at sunrise" --model <model> --output lake.png
```

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
