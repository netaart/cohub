---
title: Saves
description: Capture immutable Space checkpoints, review diffs, restore, and build from known-good states.
---

A Save is an immutable snapshot of a Space workspace. In CLI/API terms it is a **checkpoint**.

## Why Saves exist

Chats move quickly. Files change often. Saves mark the states you are willing to keep.

Use them to:

- Freeze a working milestone
- Compare what changed
- Restore a known-good workspace
- Branch new exploration from a stable base

## Create a Save

When the workspace is in a meaningful state:

1. Open Saves
2. Create a new Save
3. Give it a short, scannable note
4. Review the diff if shown

Save after:

- A feature works
- A risky migration succeeds
- A demo-ready state is reached
- You are about to attempt a large rewrite

Do not Save every minor edit.

## Diffs

A Save is most useful when you can see what it captured.

Cohub can show:

- Pending changes since the latest Save
- File-level diffs for a Save

Read diffs before restoring or publishing, especially after long Agent sessions.

## Restore and continue

Depending on the flow you use, a Save can become:

- A restore point for the current Space
- A base for continued work
- Context for later comparison

Treat Saves as history you can stand on, not as chat bookmarks.

## Saves vs Chats vs Apps

| Object | Captures | Use for |
| --- | --- | --- |
| Chat | Conversation and turns | Reasoning and iteration |
| Save | Workspace snapshot | Milestones and recovery |
| App | Published surface | Sharing output with others |

A great demo often needs all three: the Chat that produced it, the Save that froze it, and the App that shares it.

## Organization

Use labels and naming so Saves stay understandable:

- `v1-landing-working`
- `before-auth-refactor`
- `demo-2026-07-18`

If your team shares a Space, write Save notes for the next reader, not only for yourself.

## Practical tips

- Save before letting an Agent run a broad cleanup
- If output is publishable, Save first, then publish an App from a stable path
- Prefer fewer clear Saves over dozens of noisy ones
- When something breaks, find the last green Save before improvising

## Related

- [Files & Sandbox](/docs/workspace/files-and-sandbox)
- [Apps](/docs/create/apps)
- [Quick start](/docs/learn/quick-start)
