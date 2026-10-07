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
time. Anyone who can manage the Space then sees the screen live from **Screens → View**, on the web
or another device, and the Space's Agents can take screenshots of it.

To let people and Agents tap, swipe and type on the phone, choose **Allow control** and enable Cohub
in Accessibility settings. Control only works while the screen is shared. Stop sharing from the
Runtime menu or the notification at any time.

## Practical tips

- Keep publishable outputs in stable paths
- Don’t store secrets in workspace files you may publish
- Restart Sandbox after important runtime/config changes if the UI asks you to
- If preview looks stale, confirm the process is still running and the port is current

## Related

- [Chats](/docs/workspace/chats)
- [Saves](/docs/workspace/saves)
- [Apps](/docs/create/apps)
