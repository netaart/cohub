---
title: Chats
description: Use Chats and the composer to work with Agents — models, turns, forks, skills, and sharing.
---

A Chat is a conversation context inside a Space. In CLI/API terms it is a **session**.

## Create and open Chats

- **New Chat** starts a clean thread in the current Space
- The sidebar lists recent Chats, often grouped by labels
- Cross-space recent Chats also appear in the sessions inbox

Use multiple Chats when goals diverge. Keep one Chat focused when continuity matters.

## Anatomy of a Chat

| Piece | Role |
| --- | --- |
| Transcript | Messages, tool calls, streaming output |
| Turns | Discrete units of work you can navigate |
| Composer | Input, model, attachments, slash tools |
| Header / actions | Rename, share/access, related tools |

## Side panel

The right side panel keeps what a Chat produces next to it.

| Tab | Shows |
| --- | --- |
| This chat | Media the Chat generated, with live progress, and the files it changed |
| Files | The Space file tree; files changed in this Chat carry a dot |
| Media | Every generation in the Space, filterable by type |
| Apps | Installed Apps |

Changed files come from the Agent's write and edit tool calls. Files written by shell commands are not attributed to a Chat. The CLI lists the same data with `cohub spaces sessions files <sessionId>`.

## Composer

The composer is how you steer the Agent.

### Send messages

- `Enter` sends
- Force send is available when you need to bypass a local block
- Long instructions can be pasted or attached as files

### Choose a model

Pick the model that matches the job. You can change models between turns when the UI allows it.

### Attachments

Attach images or files when the Agent needs source material that is not already in the Space workspace.

### Slash commands and skills

Type `/` to browse prompt templates and skills.

- Prompt templates insert structured instructions
- Skills often appear as `/skill:name`
- Skill availability depends on Space, user, platform, and mounted Mods

Prompt templates can reference the current context with `{{cohub.session.id}}`, `{{cohub.space.id}}`, and `{{cohub.user.uuid}}`. Unknown or unavailable variables remain unchanged.

### Mentions

Use `@space` mentions when the Agent should pull context from another Space you can access. Paste a public App URL to create an App mention that the Agent can resolve or download.

Mentions are for deliberate context references, not every message.

## Working with turns

Chats are turn-based:

1. You send a prompt
2. The Agent streams a response, often with tool calls
3. The turn finalizes
4. You continue, fork, or stop

Useful patterns:

- Ask for a plan before large edits
- Inspect file diffs / preview before the next instruction
- Start a fork when you want an alternate branch of the conversation

### Follow-ups

Some queued follow-ups can be steered or cancelled. Use that when the Agent is mid-work and the next instruction should change.

## Forking

Fork a Chat when you want to keep the current history but explore a different path.

Forks preserve lineage so you can compare approaches without overwriting the original thread.

## Sharing and access

Chats can have access controls beyond the Space default.

Typical cases:

- Keep a Chat private inside a shared Space
- Allow broader read access for a specific thread
- Share a conversation without opening the whole workspace

Exact policy controls live on the Chat / session access surface and in Space settings.

## Labels and organization

Label Chats so the sidebar stays scannable:

- By feature
- By status (`todo`, `blocked`, `shipped`)
- By collaborator or channel source

System labels may also appear for user/channel/source groupings.

## Keyboard essentials

| Action | Shortcut |
| --- | --- |
| Search everywhere | `⌘K` / `Ctrl K` |
| New chat | `⌘O` / `Ctrl O` |
| Open help | `?` |
| Focus composer | `i` (when not typing elsewhere) |
| Send | `Enter` |

See in-app help for the full shortcut list.

## Practical tips

- One goal per Chat when possible
- Put durable project state in files, not only in Chat prose
- Save the Space when the workspace reaches a good milestone
- If the Agent is lost, restate the goal and point at concrete files

## Related

- [Spaces](/docs/workspace/spaces)
- [Files & Sandbox](/docs/workspace/files-and-sandbox)
- [Saves](/docs/workspace/saves)
