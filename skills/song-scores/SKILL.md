---
name: song-scores
description: Keep a song2 `.abc` score with a song in Cohub — where a score lands in a Space, writing a score file, handing it to the user, and generating a song with a score. Use when the user asks for a score, lead sheet or chord chart; to write, save or link a `.abc` score; to find a generated song's score; or to generate a song with a score.
---

# Scores in Cohub

A score in Cohub is a `.abc` file in the Space. Agents write the file, check it with the song2 dialect package, and hand it over as a `/workspace/` link. A generated song's score lives in its task record; write it to a `.abc` before handing it to the user.

Use this skill to write a new score, keep a score with a song, find a generated song's score, or explain how a score opens.

The editing itself — reading, note ids, one command, diagnostics, writing back — is the skill in `@neta-art/score-editor`. Read it and follow it; this page only adds Cohub's part: where a song and its score live, the handoff to the user, the write rules and generation. For the musical side — form, melody, lyrics fit, harmony, the style description and revising — read the composition skill.

## Start here

Install the latest packages in a scratch directory:

```bash
mkdir -p /tmp/score-work && cd /tmp/score-work
npm init -y
npm install @neta-art/score-editor@latest @neta-art/score-dialect-song2@latest @neta-art/song-composition@latest
```

Read `node_modules/@neta-art/score-editor/skills/score-editor/SKILL.md` and its `references/edit-a-score.md`. The editor skill ships inside the package, so its version is the package version: reread the skill whenever you install. For the text itself, read `node_modules/@neta-art/score-dialect-song2/WRITING.md` (how to write a correct score) and its `RULES.md`. For form, melody, lyrics fit, harmony, the style description and revising, read `node_modules/@neta-art/song-composition/skills/song-composition/SKILL.md`.

## Where the score is

| The source | Where to read it |
| --- | --- |
| A score file | A `.abc` in the Space, often under `scores/`. Read it with the file tools, or `cohub spaces files cat <path>`. It is the document: edit it and save back to the same path. |
| A generated song | `cohub tasks get <taskRunId> --json` prints `{ run, progress }`. The score is `.run.result.output[]` where `type == "text"` and `meta.role == "abc"`; if that is empty or absent, take the `abc` role from `.run.payload.data.content[]` (or `.run.payload.content[]`). Style is the `prompt` role and lyrics the `lyrics` role from the same input. Seed is `seed` and score mode is song2's `abc_mode`, both in `.run.payload.data.parameters`; `cohub models show song2 --json` names the mode's values. |

The task record is the original; never write to it. A change to a generated score is a new `.abc`.

List before guessing: `cohub tasks ls --space "$COHUB_SPACE_ID" --json`, `cohub spaces files ls`, or ask the user. `COHUB_SPACE_ID` and `COHUB_SESSION_ID` are the current Space and chat. Never build a task id, Space id or path from a name.

## Write a score by hand

Write the text with the file tools at the path the user named; if there is none, use `scores/<short-name>.abc`. Create `scores/` first when it does not exist. For another Space, `cohub -s <spaceId> spaces files write <path> -c "<score>"`. Follow the write rules under `## Rules`: list the folder and pick a free name, or re-check an existing file before writing it.

Start from the smallest correct score in `WRITING.md`, not from a blank page: song2 needs its header, two voices (`Vocal`, `Ins`) and the rules there. Then read the text back with the dialect and run `check`; fix every diagnostic before handing it over. Do not paste a score into chat.

## Hand a score to the user

Give the file as a Markdown link:

```markdown
[Morning train](/workspace/scores/morning-train.abc)
```

The web shows a read-only score under the song's audio, and a `.abc` file opens in the built-in viewer unless the user picked an App for it. A `/workspace/` link only works in the Space it belongs to.

When the user asks for a generated song's score, write that score to a new `.abc` in the Space and link it: the `.abc` is the artifact.

## Generate a song with a score

When the request includes a score, pass the score roles and ask for the score back:

```bash
cohub generate -m song2 \
  --text "prompt=<style>" \
  --text "lyrics=<lyrics>" \
  --param return_abc=true \
  --json
# Optional input score, add: --text "abc=<score>"
```

`prompt` (style) and `lyrics` are required; `abc` is the optional input score. With `return_abc=true`, the output has a text block with `meta.role == "abc"`; write it to a new `.abc`, check it, and link it. If the output has no `abc` block, report that instead of writing a score from memory. For every other generate option, see the `cohub-generate` skill.

To regenerate with a score, pass the input score, seed and score mode, and ask for the score back:

```bash
cohub generate -m song2 \
  --text "prompt=<style>" \
  --text "lyrics=<lyrics>" \
  --text "abc=$SCORE" \
  --param seed=<seed> \
  --param abc_mode=<mode> \
  --param return_abc=true \
  --json
```

For what to change and what to keep before a regeneration, read the composition skill.

## Rules

- **Look ids up.** Task run ids and paths come from commands or the user; note ids from the parsed model or the editor package's skill; command and refusal names from the editor package's skill. Never build one from memory.
- **Read before you write.** Read the score or task first. A new file: list the destination folder (`cohub spaces files ls <dir> --json`; add `-s <spaceId>` for another Space) and pick a name that is not there. An existing file: the agent's file tools and `cohub spaces files write` carry no version, so list the folder again before writing and compare the entry's `mtimeMs` and `size` with what you read; if either differs, stop and ask which version to keep. This is a check right before the write, not a lock: a change in that instant can still be replaced. Prefer the `edit` tool for an existing file: it applies the change to the latest content and refuses when the old text no longer matches, so a concurrent change is not dropped. Do not overwrite a file you did not read.
- **Send one command.** Change the score through the editor package's skill, write back the project it returns, and keep every other bar and line byte for byte. Do not reformat, rebuild or "improve" the rest.
- **Report the change.** Name the bars and notes, chords, tempo, key, sections or lyrics that changed, the notices, and what you left alone. If a check fails, give the diagnostics and the unchanged score.
- **Generate with the given values.** Use the seed and score mode the request gives; do not change them. `abc` must pass the dialect check before it goes into a generation.

## What this skill does not do

It does not replace the editor package's editing interface or its API; read those. It does not teach composition; read `@neta-art/song-composition`. It does not export MIDI or PDF, or write App manifests, `.cohub/apps.json` or permissions. It does not grant access to a Space or change its defaults. There is no MCP interface; use the CLI, the file tools and the packages.
