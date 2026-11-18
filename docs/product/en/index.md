---
title: Overview
description: Cohub is a living Space where people and agents create, save, share, and build from real context.
---

Cohub is a shared creative workspace for people and agents.

Open a Space, talk, edit files, run tools in a Sandbox, save meaningful moments, and publish shareable Apps. The same surface is available from the web app, CLI, and SDK.

## What you can do

- Start from a Space instead of a blank chat
- Work with an Agent that can read files, run commands, and keep context
- Save a checkpoint when the work becomes worth keeping
- Publish a file, directory, or port as an App
- Automate later with CLI, SDK, Channels, and hooks

## The main loop

```text
Create a Space
  → Chat with an Agent
  → Edit files / run in Sandbox
  → Save a checkpoint
  → Publish an App
```

That loop is the product. Everything else extends it: Labels, Channels, Mods, Skills, scheduled prompts, commerce, and developer APIs.

## Who it is for

- Builders who want agents inside a real workspace, not only a transcript
- Teams co-creating apps, media, prototypes, or automations
- Developers who want the same product surface from CLI and SDK

## Where to go next

| Goal | Page |
| --- | --- |
| Learn the vocabulary | [Core concepts](/docs/learn/core-concepts) |
| See the UI layout | [Product map](/docs/learn/product-map) |
| Ship something in minutes | [Quick start](/docs/learn/quick-start) |
| Use the terminal | [CLI](/docs/developers/cli) |
| Build integrations | [SDK](/docs/developers/sdk) |

## Product language

Cohub UI language is the source of truth in these docs:

| UI | CLI / API |
| --- | --- |
| Chat | Session |
| Save | Checkpoint |
| Task | Task run |
| Scheduled prompt | Cron job / scheduled `spaces prompt` |

Developer pages may use API names and always map them back to the UI terms.
