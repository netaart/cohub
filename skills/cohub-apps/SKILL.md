---
name: cohub-apps
description: Publish a live web page or app at a stable URL — an HTML file, board, or directory site, or a running sandbox port — with versions, visibility, permissions, and view stats.
---

# Cohub Apps

Cohub Apps publish as public pages:

```text
/:ownerUsername/:spaceSlug/w/:appSlug
```

If a command is unavailable, update the CLI: `npm install -g @neta-art/cohub-cli`.

## Inputs

A published App needs a target Space ID, an App slug, and one target. Use the current Space by default:

```bash
space_id="${COHUB_SPACE_ID:-}"
```

When the target Space is unclear, ask for the Space.

## Targets

Choose one target:

- `--file <path>` for an HTML page, board, or any other file
- `--dir <path>` for a directory site with `index.html`
- `--port 3000` or `--port 5173` for a running preview

`--file` and `--dir` paths are relative to the target Space's workspace (the
same paths `spaces files ls` shows) — not the local filesystem. Inside a
sandbox, `/workspace` maps to the Space workspace, so project-relative paths
work as-is. Outside a sandbox, upload local build output first
(`spaces files upload <dir>`), then publish the Space-side path.

## App Slug

Use a short, stable slug like `demo`, `report`, or `dashboard`. Keep an existing slug when updating an App. Ask before changing a user-provided slug.

## Visibility

Default to `public`. Use `--visibility space` when the App should be visible only to people with Space access.

## Permissions

Start with empty scopes. Add the smallest permission set needed for the App. Publisher scopes (`--app-scope`) apply on the App's home Space only:

- `space.view`
- `session.view`
- `file.view`
- `file.edit`
- `taskrun.view`
- `session.prompt.readonly`
- `session.prompt.fullaccess`
- `command.execute`

Anything outside that list — other Spaces, generation, account data — raises a viewer
consent dialog at runtime through `client.auth.authorize()`. Pass an explicit
`target` (`{ kind: "account" }`, `{ kind: "space", spaceId }`, or
`{ kind: "pick-space" }`) and act on the Space the result reports, which may
differ from the request when the viewer cannot use it.

```ts
const consent = await client.auth.authorize({
  target: { kind: "space", spaceId },
  scopes: ["file.view"],
  reason: "Read the Space you opened this App from.",
});
if (consent.status !== "granted" || consent.target.kind !== "space") return;
const space = client.space(consent.target.spaceId);
```

Call it from a user gesture, never on page load. Full contract:
[docs/developers/apps](https://cohub.live/docs/developers/apps).

## Publish

Publish creates the App or updates an existing App with the same slug:

```bash
cohub -s "$space_id" apps publish "$app_slug" --file "$file" --json
cohub -s "$space_id" apps publish "$app_slug" --dir "$dir" --json
cohub -s "$space_id" apps publish "$app_slug" --port "$port" --json
```

Use `--visibility`, `--hide-cohub-bar` for immersive pages, `--meta <json>`, or `--disabled` as needed.

For an existing App that only needs a fresh version from its current target:

```bash
cohub apps publish-version "$app_id" --json
```

## File-Opening Apps

An App that edits or views a file type declares the extensions in its page head:

```html
<meta name="cohub:file-handlers" content=".board" />
```

Installing it registers those extensions in `.cohub/apps.json` (`"opens": [".board"]`
on its entry) unless another installed App already opens them. Each file opens
in its own window and reaches the App through `client.app.onLaunch()`. Confirm
before changing which App opens a file type in a Space.

## App Ref

Refer to an App by id, public URL, `cohub://apps` URI, or `username/space/app`:

```bash
cohub apps get "$app" --json
```

Return `publicUrl`, falling back to `content.url` when needed.

## Manage

```bash
cohub apps ls
cohub apps update "$app_id" --visibility space --clear-app-scopes --json
cohub apps versions "$app_id"
cohub apps stats "$app"
cohub apps download "$app" -o ./out
cohub apps rm "$app_id" --yes
```

`update` can change the slug, visibility, target, scopes, and Cohub bar settings. `stats` shows view counts — total, 24h, 7d, 30d — and their sources.

## Desktop

Open an App window on the Cohub desktop that started this chat:

```bash
cohub desktop open "$app"
```

Add `--call <method>` to invoke a method the App registered.

## Identity Setup

If publishing reports missing public identity, check the Space and current user:

```bash
cohub spaces get "$space_id" --json
cohub auth whoami --json
```

If the current user is the Space owner, use user-provided or user-confirmed values to set the public identity:

```bash
cohub profile update --username "$owner_username" --json
cohub spaces update "$space_id" --slug "$space_slug" --json
```

## Safety

- Review target content before publishing.
- Confirm identity, permission, or status changes.
- Confirm before deleting an App.

## Finish

Return the public URL.

