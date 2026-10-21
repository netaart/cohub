---
title: Files & Sandbox
description: Use the Space workspace, Sandbox runtime, ports, and previews as the durable project surface.
---

Files are the durable state of a Space. The Sandbox is where those files can be executed and previewed.

## Workspace files

Every Space has a workspace filesystem.

You can:

- Browse the tree
- Open and edit text files
- Upload local files or directories
- Create folders
- Delete or move paths
- Review pending changes against the latest Save

The Agent uses the same workspace. If a change matters, it should exist as a file, not only as Chat text.

## What belongs in files

Good fits:

- App source
- Docs and notes for the project
- Generated assets you want to keep
- Scripts the Agent should rerun
- Publish targets for Apps

Avoid treating Chat history as the only source of truth.

## Sandbox

The Sandbox is the runtime behind the Space.

It provides:

- Process execution for Agent tools and your commands
- Port exposure for live previews
- Isolation from other Spaces

You usually notice the Sandbox when:

- Dependencies install
- Dev servers start
- Ports appear for preview
- Hibernation or restart is needed after idle time or config changes

### Spec and hibernation

Space settings may include:

- Sandbox size / spec
- Auto-destroy or idle hibernation policy

Larger specs can require plan upgrades. Changing some settings may need a Sandbox restart.

## Ports and live preview

When a process listens on a supported public port, Cohub can preview it.

Use port preview when:

- You are running a dev server
- The result is an app, not a static file
- You want to publish a live App from that port

Static HTML can often be previewed directly as a file without a long-running process.

## Files and Chat together

The strong Cohub pattern is split-pane work:

1. Ask the Agent to change the workspace
2. Open the affected files
3. Verify preview
4. Continue the Chat with precise follow-ups

Point at paths explicitly. “Update `src/page.tsx`” is better than “fix the page”.

## Uploads

Upload when the Agent needs local material:

- Design references
- CSV / JSON inputs
- Existing project archives or source folders
- Media assets

After upload, tell the Agent where the files landed.

## Diffs and Saves

Pending workspace changes can be compared against the latest Save.

Use diffs to:

- Review Agent edits before the next prompt
- Decide whether to Save
- Catch unexpected deletions

Saving freezes the current milestone. See [Saves](/docs/workspace/saves).

## Local folder as Runtime

For advanced flows, the CLI can attach a local directory as the Space Runtime:

```bash
# The first run creates and remembers the directory's Space; later runs reuse it.
cohub runtime up ./my-project
```

Bindings are scoped by directory, account, and environment, and stored in
`~/.config/cohub/runtime-spaces.json`. This is useful when you want Cohub Agents
against a local working tree. See [CLI](/docs/developers/cli).

## Share a phone screen

When the Cohub Android app serves a Space, it can also share the phone's screen with it. Open the
Space's Runtime menu on the phone and choose **Share screen**; Android asks for permission each
time. Builders and hosts then see the screen live from **Screens → View**, on the web or another
device, and the Space's Agents can take screenshots of it and read its controls. Avatars beside a
screen show who is watching; a ring marks those who can steer it.

To let people and Agents tap, swipe and type on the phone, choose **Allow control** and enable Cohub
in Accessibility settings. Control only works while the screen is shared. Whenever a person
touches the screen, an Agent working on it waits, then looks again before going on. Stop sharing
from the Runtime menu or the notification at any time.

## Virtual screens

A cloud sandbox can run a virtual screen. Choose the screen button in the Space header, then
**Start virtual screen**: programs started in the sandbox from then on show on it — a browser an
Agent opens, for example — and you can watch and steer them live. Stop it from the same place; it
also ends when the sandbox stops. A sandbox created before virtual screens existed asks to be
updated with **Restart sandbox** in the Space settings.

This is how to watch an Agent at work in a browser and take over when it needs you — to sign in, for
example: ask it to use the virtual screen, open the screen from the link it gives you, and type
yourself. What you type goes to the screen, not to the chat.

## Game development environments

When the deployment provides a game image, choose it under **Space settings → Sandbox → Environment**. It includes Godot, Blender and CPU software-rendering tools; it does not provide a GPU. Compute remains limited by the Space owner's plan. Both images include NumPy. For Blender Cycles rendering, set `scene.cycles.device = 'CPU'` and `scene.cycles.use_denoising = False`: this build does not include OpenImageDenoise.

Projects and mods can recommend an environment with `.cohub/sandbox.json`:

```json
{ "version": 1, "image": "game", "spec": "boost" }
```

Explicit Space settings override the project file, which overrides enabled mods in their configured order. Choose **Follow configuration** to remove an image override, or **Use configured compute preference** to remove a compute override. Existing Spaces keep their saved compute selection. Mod changes must be published as a Save before they can apply.

Environment changes apply when the sandbox is next created or restarted; file edits do not interrupt running tasks. Unavailable preferences fall back to an available environment without erasing the original request. Configuration details show the request, available and running environment, sources and any limitations. Invalid files must be fixed, or both image and compute explicitly selected, before restarting. Workspace files remain on persistent storage; temporary software installations outside it do not survive replacement. Cloud environment choices do not change local sandboxes.

## Practical tips

- Keep publishable outputs in stable paths
- Don’t store secrets in workspace files you may publish
- Restart Sandbox after important runtime/config changes if the UI asks you to
- If preview looks stale, confirm the process is still running and the port is current

## Related

- [Chats](/docs/workspace/chats)
- [Saves](/docs/workspace/saves)
- [Apps](/docs/create/apps)
