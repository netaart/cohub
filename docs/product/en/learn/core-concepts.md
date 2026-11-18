---
title: Core concepts
description: The objects that make up Cohub — Space, Chat, Save, Sandbox, App, and more.
---

Learn these objects once. The rest of the product is combinations of them.

## Space

A Space is the main creative surface.

It holds Chats, files, Saves, tasks, Apps, and settings in one isolated environment. People and Agents share the same Space context.

Create a Space when you want a durable place to work, not just a one-off conversation.

## Chat

A Chat is a conversation context inside a Space.

Each Chat keeps its own history, model choices, turns, and forks. You can run many Chats in one Space without mixing goals.

In CLI and API this is a **session**.

## Agent

An Agent is the active collaborator in a Space.

It can read workspace files, run commands in the Sandbox, use skills, and stream results back into a Chat. The Agent is not a separate product — it works inside your Space.

## Save

A Save is an immutable snapshot of the Space workspace.

Use Saves to mark good states, review diffs, restore, or start new work from a known base. Saves are for milestones, not every keystroke.

In CLI and API this is a **checkpoint**.

## Files

Files are the Space workspace.

They are what the Agent edits, what you preview, and what you can publish. Treat the Space filesystem as the source of project state.

## Sandbox

A Sandbox is the execution environment behind a Space.

It runs processes, exposes ports for preview, and keeps runtime work away from the product surface. Most of the time you feel it as “files work” and “ports preview”.

## App

An App is a published, shareable surface.

Publish a single HTML file, a directory site, or a public Sandbox port. Apps have versions, permissions, and public URLs shaped like:

```text
/:username/:spaceSlug/w/:appSlug
```

## Channel

A Channel connects an external messenger to a Space.

Examples include Discord, Telegram, Feishu, and WeChat. People can talk from those apps; Agents can respond through the same bound Space.

## Label

Labels organize Chats, Saves, and files in the sidebar.

System labels group source, user, and channel activity. User labels let you build your own navigation without renaming every resource.

## Mod

A Mod mounts another Space into the current one as read-only context, usually under `/mods/<slug>`.

Mods are how shared skills, prompts, and base tooling enter a Space without copying files by hand.

## Skill

A Skill is a reusable capability available from the Chat composer, often as a slash command such as `/skill:name`.

Skills can come from the Space, user config, platform defaults, or mounted Mods.

## Task

A Task is an async run record — generation work, hook runs, long jobs, and similar background execution.

Use the Tasks view when you need status, history, or failure details outside the Chat transcript.

## Scheduled prompt

A scheduled prompt sends or re-sends a prompt later.

Use one-shot schedules for reminders and recurring schedules for periodic agent work. In API terms these relate to cron jobs and scheduled prompts.

## Permission

Permissions decide what members, anonymous viewers, and Apps can do.

Space roles are **host**, **builder**, and **guest**. Apps also declare their own scopes, and request viewer consent when they need runtime access.
