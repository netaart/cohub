# @neta-art/cohub-cli

CLI for [Cohub](https://cohub.live) — work with Spaces, Chats, files, Saves, Tasks, scheduled prompts, search, and multimodal generation from your terminal.

## Installation

```bash
npm install -g @neta-art/cohub-cli
cohub --help
```

## Sign in

For normal use outside Cohub Sandbox, sign in once:

```bash
cohub auth login
cohub auth whoami
```

The CLI will keep you signed in and refresh your session automatically.

Inside Cohub Sandbox or CI, `COHUB_EXECUTION_TOKEN` can be used as an ephemeral auth override.

## Environment

The CLI uses production by default.

Use the development environment with `ENV=dev`:

```bash
ENV=dev cohub auth login
ENV=dev cohub spaces ls
```

## Usage

Use `--json` when reading output for decisions, extracting IDs, or chaining commands.

For command details:

```bash
cohub -h
cohub spaces -h
cohub spaces prompt -h
```

## Terminology

| Product UI | CLI / API |
|---|---|
| Chat | Session |
| Save | Checkpoint |
| Tasks | Task runs |
| Scheduled prompt | `spaces prompt` schedule |
| Recurring scheduled prompt | Cron job |

## Spaces

```bash
cohub spaces ls --json
cohub spaces get <spaceId> --json
cohub -s <spaceId> spaces get
COHUB_SPACE_ID=<spaceId> cohub spaces get
cohub spaces create --name "<name>" --description "<description>" --json
cohub spaces create --name "<name>" --checkpoint <checkpointId> --json
cohub spaces update <spaceId> --slug <space-slug>
cohub spaces rename <spaceId> "<new name>"
cohub -s <spaceId> spaces invites create --role builder --days 7
cohub -s <spaceId> spaces invites ls
cohub -s <spaceId> spaces invites revoke <code> --yes
cohub -s <spaceId> run -- git status
```

Many space-scoped commands need a target Space:

```bash
cohub -s <spaceId> spaces prompt "message" --json
COHUB_SPACE_ID=<spaceId> cohub spaces prompt "message" --json
```

## Chats and prompts

Use `spaces prompt` for immediate sends, delayed sends, one-time schedules, recurring schedules, new Chats, and existing Chats.
Use `run` for a one-off shell command in the current Space workspace.

```bash
# Send now
cohub -s <spaceId> spaces prompt "message" --json

# Send long content from stdin
cat prompt.md | cohub -s <spaceId> spaces prompt --json

# Send to an existing Chat
cohub -s <spaceId> spaces prompt --session <sessionId> "message" --json

# Create a new Chat and send
cohub -s <spaceId> spaces prompt --title "<chat title>" "message" --json

# Schedule once
cohub -s <spaceId> spaces prompt --at "2026-05-12T09:00:00+08:00" "message" --json

# Schedule recurring
cohub -s <spaceId> spaces prompt \
  --cron "0 9 * * 1-5" \
  --timezone "Asia/Shanghai" \
  --title "Daily reminder" \
  "message" \
  --json
```

Scheduling rules:

- Use only one of `--delay-ms`, `--at`, or `--cron`.
- `--cron` requires `--timezone`.

## Chats / Sessions

```bash
cohub -s <spaceId> spaces sessions ls --json
cohub -s <spaceId> spaces sessions create "<title>" --json
cohub -s <spaceId> spaces sessions get <sessionId> --json
cohub -s <spaceId> spaces sessions rename <sessionId> "<new title>"
```

Use `spaces prompt --session <sessionId>` to send to a Chat.

## Space turns

List recent turns across all visible Sessions in a Space:

```bash
cohub -s <spaceId> spaces turns ls
cohub -s <spaceId> spaces turns ls --author others --limit 50 --json
cohub -s <spaceId> spaces turns ls --session <sessionId>
cohub -s <spaceId> spaces turns intermediate <sessionId> <turnId>
cohub -s <spaceId> spaces turns intermediate <sessionId> <turnId> --json
```

When `--session` is provided, the CLI uses the same full turn endpoint as the
Web session view. Intermediate messages are read from the turn's CDN archive;
`--json` returns the archive without reducing its content blocks.

Use `pageInfo.nextCursor` with `--cursor` to load older pages. Use a previous
`snapshotCursor` with `--after` and an explicit `--before` boundary to query
newer turns:

```bash
cohub -s <spaceId> spaces turns ls --cursor <nextCursor> --json
cohub -s <spaceId> spaces turns ls --after <snapshotCursor> --before <snapshotAt> --json
```

## Space activity

One-shot overview of a Space: usage summary, per-user contributors, top
models, and most viewed Apps. Cost figures require space-management access.

```bash
cohub -s <spaceId> spaces activity
cohub -s <spaceId> spaces activity 7
cohub -s <spaceId> spaces activity 365 --json
```

## Boards

Board targets accept a Board ID or a `.board` path. Every command supports `-h` and `--json`:

```bash
cohub boards -h
cohub -s <spaceId> boards inspect boards/plan.board --json
cohub -s <spaceId> boards items list <boardId>
cohub -s <spaceId> boards connections list <boardId>
cohub -s <spaceId> boards capabilities <boardId>
cohub -s <spaceId> boards watch <boardId> --json
```

Use targeted reads for large Boards:

```bash
cohub -s <spaceId> boards items get <boardId> <itemId> --json
cohub -s <spaceId> boards connections get <boardId> <connectionId> --json
cohub -s <spaceId> boards effects get <boardId> <effectId> --json
cohub -s <spaceId> boards compositions get <boardId> <compositionId> --json
```

Create semantic JSON from an example, then apply it to one resource:

```bash
cohub boards examples item text > item.json
cohub -s <spaceId> boards items create <boardId> --input item.json

cohub boards examples composition fade > intro.json
cohub -s <spaceId> boards compositions apply <boardId> --input intro.json
```

Apply related changes atomically with one request. The batch contains semantic commands, not a full Board snapshot:

```json
{"commands":[
  {"type":"item.patch","itemId":"title","patch":{"props":{"text":"Updated"}}},
  {"type":"connection.create","connection":{"id":"title-agent","source":{"itemId":"title"},"target":{"itemId":"agent"}}}
]}
```

```bash
cohub boards examples batch basic > changes.json
cohub -s <spaceId> boards batch <boardId> --input changes.json --dry-run
cohub -s <spaceId> boards batch <boardId> --input changes.json
```

Use `--base-version` and `--mutation-id` for controlled, retry-safe scripts. Use `--dry-run` to validate without writing. Playback is grouped under `playback`:

```bash
cohub -s <spaceId> boards playback play <boardId> <compositionId>
cohub -s <spaceId> boards playback seek <boardId> <playbackId> 400
cohub -s <spaceId> boards playback stop <boardId> <playbackId>
```

## Search

Search Spaces, Chats, and prior turns:

```bash
cohub search "query"
cohub search "query" --limit 20 --json
```

## Models and multimodal generation

`models ls` prints each LLM's per-million-token cost (`$3 /M input · $15 /M output`, with cache rates when declared) and hides models marked `hidden`. `models ls --model-type multimodal` prints each model's unit price (`$0.04 / image`, `$0.10–$0.50 / second`); use `--json` for the raw `pricing` object (`unit`, `amount` or `min`/`max`, optional `note`).

```bash
cohub models ls --json
cohub models ls --model-type multimodal --json
cohub models show <model>
cohub models show <model> --json

cohub generate "a calm lake at sunrise" \
  --model <model> \
  --output output.png \
  --json

cohub generate "restyle this image" \
  --model <model> \
  --image ./input.png \
  --param size=1024x1024 \
  --json

cohub generate "smoothly transition from the first frame to the last frame" \
  --model seedance-2-0-fast \
  --image first_frame=https://example.com/first.png \
  --image last_frame=https://example.com/last.png

cohub generate "keep the character identity from all reference images" \
  --model seedance-2-0-fast \
  --image reference_image=https://example.com/reference-1.png \
  --image reference_image=https://example.com/reference-2.png

cohub generate "Lip-sync to this spoken take" \
  --model seedance-2-0-fast \
  --image reference_image=https://example.com/portrait.png \
  --audio reference_audio=https://example.com/speech.mp3

cohub generate "a calm lake" \
  --model <model> \
  --async

cohub tasks get <taskRunId> --json
```

Supported inputs:

```bash
--image <path-or-url>
--image first_frame=<path-or-url>
--image last_frame=<path-or-url>
--image reference_image=<path-or-url>
--video <path-or-url>
--video reference_video=<path-or-url>
--audio <path-or-url>
--audio reference_audio=<path-or-url>
```

Role-qualified media values add `meta.role` to that content block. Repeat `--image reference_image=...` for multiple reference images. Seedance role-qualified media should use public URL inputs. Do not mix first/last frame roles with reference roles (`reference_image`, `reference_video`, `reference_audio`) in one request.

Pass generation parameters with `--param key=value` or `--parameters '<json>'`.

## Files

```bash
cohub -s <spaceId> spaces files ls [path] --json
cohub -s <spaceId> spaces files cat <path>
cohub -s <spaceId> spaces files write <path> -c "<content>"
cohub -s <spaceId> spaces files upload <files...> --dir <dir>
cohub -s <spaceId> spaces files mv <from> <to>
cohub -s <spaceId> spaces files rm <path>
```

`upload` places each file under `--dir`; a directory argument contributes its
contents directly (like `aws s3 cp dir remote:path`), so `upload dist --dir apps/demo`
lands at `apps/demo/index.html`, not `apps/demo/dist/index.html`. Upload adds or
overwrites files; it never deletes existing ones.

Confirm before deleting files or directories.

## Apps

Publish and manage Apps from a Space workspace. Public App URLs require a username and a Space slug.

`apps publish` detects the source from the runtime by default: local CLI runs use local
filesystem paths, while Cohub Sandbox runs use Space workspace paths. Pass
`--source workspace` or `--source local` to override the default explicitly.

```bash
cohub profile update --username <username>
cohub spaces update <spaceId> --slug <space-slug>
cohub -s <spaceId> apps ls --json
cohub apps get <appId|url|username/space/app> --json
cohub apps stats <appId|url|username/space/app>
cohub apps download <appId|url|username/space/app> --output <path>
cohub -s <spaceId> apps publish demo --file ./dist/index.html
cohub -s <spaceId> apps publish site --dir ./dist
cohub -s <spaceId> apps publish site --source workspace --dir dist
cohub -s <spaceId> apps publish app --port 3000
cohub apps publish-version <appId>
cohub apps versions <appId> --json
cohub apps rm <appId> --yes
```

Resolve a published App by public identity:

```bash
cohub apps resolve <appSlug> --owner <username> --space-slug <spaceSlug>
```

Use `--json` for machine-readable output. `apps get`, `apps stats`, and `apps download` also accept `app://<username>/<space>/<app>` mention URIs. `apps stats` reports total, 24-hour, 7-day, and 30-day views with a source breakdown. Download restores newly published file and directory artifacts directly from the CDN with checksum verification. HTML files with companion assets are restored as directory bundles; Board and port apps are not downloadable. The resolve command remains available for explicit slug-based lookup.

Realtime rooms use a published App's runtime identity, so they are available
through `client.app.realtime` in the SDK rather than as CLI commands.

## Drive the Cohub UI

Show a file or App preview in the Cohub tab that started the current session, and call
methods the App exposes.

```bash
cohub desktop open <appId|url|app://...|username/space/app|file://path>
cohub desktop open file://src/main.ts
cohub desktop open app://alice/studio/launch
cohub desktop open <app-or-file> --call selection.get
cohub desktop open <app> --call board.focus --data '{"nodeId":"n1"}'
cohub desktop open <app> --call report.build --input payload.json --json
```

`ui preview` accepts `file://` Space-relative paths, `app://` App references, and
legacy bare targets. A bare target checks the current Space for a file first, then
falls back to the same App references as `apps get`. Showing a preview is
idempotent: repeating it re-activates the same tab and refreshes any launch state
carried by the reference. With `--call`, the command waits for the App to announce readiness, invokes the method,
and waits for the App to complete the same UI command with `client.ui.reportResult()`.

App authors decide what is callable by registering handlers inside the App:

```ts
client.app.surface.handle("image.open", async (input, { commandId }) => {
  openImageStudio(input, commandId);
});
```

An App answers only a Cohub app origin, so a third-party site that embeds it
cannot invoke these methods.

Retrying with the same `--command-id` re-delivers the command rather than
returning a stale pending record, which recovers a dispatch that never reached the
browser. The frontend dedupes by command id, so ordinary redelivery does not run
twice.

Delivery is at-least-once. Deduplication lives in the receiving tab's memory, so a
retry that spans a page reload can run a `--call` method a second time. Prefer
methods that are safe to repeat.

Commands reach only the frontend instance that originated the current session,
resolved from request provenance (`X-Cohub-Source-Client`, propagated into the
Sandbox as `COHUB_SOURCE_CLIENT_ID`). They cannot target another user's browser,
and offer no DOM access or script evaluation. Pass `--client` to address a
specific instance of your own account, and `--command-id` to make retries safe.

## Saves

```bash
cohub -s <spaceId> spaces checkpoints ls --json
cohub -s <spaceId> spaces checkpoints get <checkpointId> --json
cohub -s <spaceId> spaces checkpoints create "<description>" --json
```

## Run commands

```bash
cohub -s <spaceId> run -- git status
cohub -s <spaceId> run --command "pnpm test"
cohub -s <spaceId> run --async --command "pnpm build"
```

Use `run` for one-off shell commands in a Space workspace. Use `--async` to queue and return immediately.

## Tasks

```bash
cohub tasks ls --space <spaceId> --json
cohub tasks get <taskRunId> --json
```

Create scheduled sends with `spaces prompt` scheduling flags, not task commands.

## Recurring scheduled prompts

Create recurring scheduled prompts with `spaces prompt --cron ... --timezone ...`.

Manage them with `cron-jobs`:

```bash
cohub cron-jobs ls <spaceId> --json
cohub cron-jobs runs <cronJobId> --json
cohub cron-jobs toggle <cronJobId> on
cohub cron-jobs toggle <cronJobId> off
cohub cron-jobs delete <cronJobId>
```

Confirm before enabling, disabling, or deleting recurring scheduled prompts.

## Safety

Confirm before:

- deleting files, directories, or Apps
- creating scheduled or recurring prompts with side effects
- enabling, disabling, or deleting recurring scheduled prompts
- changing access policies, member roles, or membership
