---
title: Spaces
description: Create, open, configure, and think with Spaces as the main unit of work in Cohub.
---

A Space is the unit of work in Cohub. Chats, files, Saves, Apps, and settings all belong to a Space.

## Create a Space

From the app:

1. Create a new Space
2. Give it a name people can scan quickly
3. Open it and start a Chat

Optional at creation or later:

- Public slug
- Avatar
- Description
- Default Mods

Name for the job, not the tool. `launch-page-v1` is better than `test`.

## Open and switch Spaces

Use the sidebar Space switcher or command palette to move between Spaces.

Each Space keeps its own:

- Chat list
- Files and Sandbox state
- Saves
- Apps
- Members and access policy

Recent Space memory helps return to where you left off, but always check the Space header if context looks wrong.

## Space home

Entering a Space typically lands you on a new or current Chat.

From there you can:

- Start another Chat
- Open files / preview
- Review Saves
- Manage Apps
- Open Space settings

## Identity and public URL pieces

A Space can have:

- **Internal id** — stable id used by CLI/SDK
- **Name** — display title
- **Slug** — public path segment when the Space is addressable publicly

Public Apps depend on username + space slug + app slug:

```text
/:username/:spaceSlug/w/:appSlug
```

Set a readable space slug before publishing something important.

## Settings worth knowing early

| Setting | Why it matters |
| --- | --- |
| Members | Who can view, edit, manage |
| Access | Signed-in / anonymous role defaults |
| Channels | External chat entry points |
| Mods | Read-only mounted capabilities |
| Sandbox | Spec, hibernation, recovery |
| Env | Runtime environment variables |
| Commerce | Products for Apps, when enabled |

Day-to-day creation rarely needs all of these. Configure when collaboration or publishing requires it.

## Mods in a Space

Spaces can mount other Spaces as Mods.

- Mounted content is typically read-only under `/mods/<slug>`
- Prompts and skills from Mods can become available to the Agent
- Changing Mods may restart the Sandbox

Start simple: keep the default base Mod unless you know you need more.

## Good Space habits

- One Space per meaningful initiative when possible
- Use Chats for parallel threads inside the same initiative
- Save before risky rewrites
- Publish Apps from stable file/port targets
- Prefer labels over endless Chat renaming

## Related

- [Chats](/docs/workspace/chats)
- [Files & Sandbox](/docs/workspace/files-and-sandbox)
- [Saves](/docs/workspace/saves)
- [Apps](/docs/create/apps)
