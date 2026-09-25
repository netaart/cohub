---
name: cohub
description: Work with Cohub spaces, chats, files, saves, labels, search, tasks, scheduled prompts, and cross-space run.
---

# Cohub

Use the Cohub CLI for platform operations, and use file tools for normal file work.

Prefer simple, explicit commands. Use `--json` when reading output for decisions, extracting IDs, or chaining commands.

Most commands can target the current Cohub sandbox context. If a command needs a target Space, add `-s "$COHUB_SPACE_ID"` or an explicit Space ID.

For command details, use `-h`:

```bash
cohub -h
cohub spaces -h
cohub spaces prompt -h
```

## Installation

```bash
npm install -g @neta-art/cohub-cli
cohub --help
```

## Terminology

| Product UI | CLI / API |
|---|---|
| Chat | Session |
| Save | Checkpoint |
| Tasks | Task runs |
| Scheduled prompt | `spaces prompt` schedule |
| Recurring scheduled prompt | Cron job |

When talking to users, prefer product UI terms: Chat, Save, Tasks, and Scheduled prompt.

Use `spaces prompt` for sends and schedules. Use `tasks` and `cron-jobs` for inspection and management.

## Context

```bash
COHUB_SPACE_ID
COHUB_SESSION_ID
```

Use them as defaults when the user has not specified a target.

```bash
env | grep '^COHUB_'
```

Do not guess IDs. If no target is available and the command cannot infer context, ask the user.

## Chats and Prompts

Use `spaces prompt` for all sends: immediate, delayed, one-time scheduled, recurring scheduled, new Chat, or existing Chat. Target another Space with `-s <spaceId>`.

```bash
cohub spaces prompt "message"
cohub -s <spaceId> spaces prompt "message"
cat prompt.md | cohub spaces prompt
cohub spaces prompt --session <sessionId> "message"
cohub spaces prompt --title "<chat title>" "message"
cohub spaces prompt --model <model> --provider <provider> "message"
```

List LLM models with `cohub models ls`. For multimodal generation, use the `cohub-generate` skill.

Useful options:

```bash
cohub spaces prompt --read-only "message"
cohub spaces prompt --steer "message"
cohub spaces prompt --label Bug --label Area/Frontend "message"
cohub spaces prompt --image ./shot.png "message"
cohub spaces prompt --env KEY=value "message"
```

Schedule:

```bash
cohub spaces prompt --delay-ms 600000 "message"
cohub spaces prompt --at "2026-05-12T09:00:00+08:00" "message"
cohub spaces prompt \
  --cron "0 9 * * 1-5" \
  --timezone "Asia/Shanghai" \
  --title "Daily reminder" \
  "message"
```

Scheduling rules:

- Use only one of `--delay-ms`, `--at`, or `--cron`.
- `--cron` requires `--timezone`.
- Confirm before creating scheduled or recurring prompts with side effects.
- Be careful when prompting the current Chat if it could trigger recursive behavior.

```bash
cohub spaces prompt -h
```

## Chats

Target another Space with `-s <spaceId>`.

```bash
cohub spaces sessions ls
cohub -s <spaceId> spaces sessions ls
cohub spaces sessions create "<title>"
cohub spaces sessions get <sessionId>
cohub spaces sessions files <sessionId>          # Space files the Chat changed
cohub spaces sessions rename <sessionId> "<new title>"
```

Inspect turns:

```bash
cohub spaces sessions turns ls <sessionId>
cohub spaces sessions turns get <sessionId> <turnId>
```

Send to a Chat with `spaces prompt --session <sessionId>`.

```bash
cohub spaces sessions -h
```

## Files

Prefer file tools for normal inspection and edits. For cross-space work, prefer file tools with `space_id` when supported; otherwise use CLI with `-s <spaceId>`.

Use CLI file commands when tools are unavailable, or for platform-side upload, move, rename, delete, or diff.

```bash
cohub spaces files ls [path]
cohub -s <spaceId> spaces files ls [path]
cohub spaces files cat <path>
cohub spaces files write <path> -c "<content>"
# Upload lands FILE(s) under --dir; a DIR contributes its contents (no extra level).
cohub spaces files upload <files...> --dir <dir>
cohub spaces files mkdir <path>
cohub spaces files mv <from> <to>
cohub spaces files rm <path>
cohub spaces files rm -r <path>
cohub spaces files diff
cohub spaces files diff <path>
```

Confirm before deleting files or directories.

```bash
cohub spaces files -h
```

## Labels

A `labelRef` may be nested, e.g. `Bug` or `Area/Frontend`.

Resource types: `session`, `checkpoint`, `file`.

```bash
cohub spaces labels ls
cohub spaces labels create <labelRef>
cohub spaces labels items <labelRef>
cohub spaces labels attach <labelRef> <resourceType> <resourceRef>
cohub spaces labels detach <labelRef> <resourceType> <resourceRef>
cohub spaces labels set <resourceType> <resourceRef> [labelRefs...]
cohub spaces labels patch <resourceType> <resourceRef> --add a,b --remove c
```

When sending, attach labels with `spaces prompt --label <ref>`.

```bash
cohub spaces labels -h
```

## Saves

```bash
cohub spaces checkpoints ls
cohub spaces checkpoints get <checkpointId>
cohub spaces checkpoints create "<description>"
cohub spaces checkpoints diff <checkpointId>
cohub spaces checkpoints ls-tree <checkpointId> [path]
cohub spaces checkpoints show <checkpointId> <path>
```

Create a Save after meaningful milestones or when the user asks to save progress.

```bash
cohub spaces checkpoints -h
```

## Tasks

The product UI shows Tasks. In the CLI, these are task runs.

```bash
cohub tasks ls --space "$COHUB_SPACE_ID"
cohub tasks get <taskRunId>
```

Do not create scheduled sends through task commands. Use `spaces prompt` scheduling flags instead.

```bash
cohub tasks -h
```

## Scheduled prompts

Create with `spaces prompt` scheduling flags. Manage recurring ones with `cron-jobs`:

```bash
cohub cron-jobs ls "$COHUB_SPACE_ID"
cohub cron-jobs get <cronJobId>
cohub cron-jobs runs <cronJobId>
cohub cron-jobs update <cronJobId>
cohub cron-jobs toggle <cronJobId> on
cohub cron-jobs toggle <cronJobId> off
cohub cron-jobs delete <cronJobId>
```

Confirm before enabling, disabling, updating, or deleting recurring scheduled prompts.

```bash
cohub cron-jobs -h
```

## Apps

Apps publish files, directory sites, or sandbox ports as shareable public pages. For publishing and sharing, use the `cohub-apps` skill.

For Apps with stronger capabilities (Cohub agent, generation, etc.), use the `@neta-art/cohub` SDK — install a fresh copy and read its README before writing any SDK code.

Discover existing Apps and resolve App mentions or public links:

```bash
cohub apps ls
cohub apps get <appId|url|username/space/app>
cohub apps get cohub://apps/<username>/<spaceSlug>/<appSlug> --json
```

Download a published file or directory App before inspecting it with file tools:

```bash
cohub apps download <appId|url|mentionUri> --output <path> --json
```

HTML files with companion assets download as directory bundles. Board and port Apps are not downloadable; open their public URL with browser tooling when rendered inspection is needed.

```bash
cohub apps -h
```

## Search

Use Cohub search for product-level discovery. Use file tools for workspace file search.

```bash
cohub search "query"
cohub search "query" --space-id <spaceId>
cohub search "query" --types turn,session,space
cohub search --types label --label-ref Bug
```

## Run

Run a one-off shell command in a Space workspace:

```bash
cohub -s <spaceId> run -- git status
cohub -s <spaceId> run --command "pnpm test"
```

## Spaces

```bash
cohub spaces ls
cohub spaces get <spaceId>
cohub spaces create --name "<name>" --description "<description>"
cohub spaces create --name "<name>" --checkpoint <checkpointId>
cohub spaces rename <spaceId> "<new name>"
cohub spaces update <spaceId> --slug <space-slug>
cohub spaces avatar <path>
cohub spaces config <spaceId>
```

```bash
cohub spaces -h
cohub spaces config -h
```

## Profile

```bash
cohub profile avatar <path>
```

## Common Workflows

### Inspect current context

```bash
env | grep '^COHUB_'
cohub spaces get "$COHUB_SPACE_ID"
cohub spaces sessions ls
cohub spaces files diff
```

### Send work to a new Chat

```bash
cohub spaces prompt --title "<chat title>" "<message>"
```

### Review changes and Save

```bash
cohub spaces files diff
cohub spaces checkpoints create "<description>"
```

### Run a command in another Space

```bash
cohub -s <spaceId> run -- git status
```

## Advanced

Less common management — use `-h` for details:

```bash
cohub spaces members -h
cohub spaces access -h
cohub spaces sessions access -h
cohub spaces mods -h
cohub spaces commerce -h
cohub spaces usage -h
cohub references -h
cohub me -h
cohub channels -h
cohub auth -h
cohub runtime -h
```

## Safety

Confirm before:

- deleting files, directories, or Apps
- creating scheduled or recurring prompts with side effects
- enabling, disabling, updating, or deleting recurring scheduled prompts
- changing Space config, access policies, member roles, or membership
- sending prompts that may trigger recursive agent behavior
