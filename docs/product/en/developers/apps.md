---
title: App development
description: Build a Cohub App — runtime context, permissions, prompts, generation, files, actions, surfaces, and commerce.
---

Cohub Apps are published web pages that run inside a Cohub runtime. From App
code you can talk to Agents, generate media, read and write Space files, run
server-side actions, share realtime state between viewers, and sell products.

This page is the single deep reference for App development. For publishing,
see [Apps](/docs/create/apps).

## Runtime in one minute

`createCohubClient()` needs no token inside an App — the host provides
short-lived auth. Runtime APIs only work inside a **published** App; local
`file://` pages and bare static URLs get `null` from `context()`.

- **Bridge mode** — the App runs in a Cohub iframe. The normal case.
- **Broker mode** — the App is opened at its standalone origin
  (`<app-id>.apps.example.com`, opt-in per deployment) and uses a popup
  broker.

The SDK discovers both modes from the same initialization:

```ts
import { createCohubClient } from "@neta-art/cohub";

// Browsers don't inject ENV — pass it explicitly, or a dev-hosted App
// silently calls the production API.
const isDev = location.pathname.startsWith("/dev/") || location.hostname.includes("dev");
const client = createCohubClient({ env: isDev ? "dev" : "prod" });

const ctx = await client.context();
if (!ctx?.app?.id) throw new Error("Not inside a published app");
```

Import without a bundler from an ESM CDN:

```ts
import { createCohubClient } from "https://esm.sh/@neta-art/cohub?bundle&target=es2022";
```

## Decide first: three questions

**1. Do you need Cohub capabilities at all?**

Presenting something — a page, a report, a game? Publish with empty scopes and
no runtime code. Nothing to authorize, nothing to pay.

**2. Who pays for AI?**

| Answer | How | Viewer sees |
| --- | --- | --- |
| **The viewer** | Call prompts, completions, and generation from the App's browser code. Usage bills the viewer. | A consent dialog (`auth.authorize`) on first use |
| **You, the owner** | Put the work in an [App Action](#app-actions) under `.cohub/actions/`, call it with `app.actions.run()`. The Action runs as the App owner in the home Space sandbox; usage bills you. | Nothing — no viewer grant |
| Hybrid | Free reads in the browser; expensive generation behind an Action metered with commerce credits. | Both, once each |

**3. Where does data live?**

| Answer | How | Viewer sees |
| --- | --- | --- |
| **The viewer's Space** | `auth.authorize({ target: { kind: "space" \| "pick-space" } })`, then write files there | One consent, revocable, expires in 14 days |
| **Your home Space** | The Action writes files with your owner permissions | Nothing |
| **Ephemeral, multi-viewer** | `app.realtime` rooms | Nothing |

## Environment awareness

The context tells the App who it is, where it was opened from, and what the
host is showing now. It is routing information, never authorization.

```ts
const ctx = await client.context();

ctx.app.homeSpace;        // the Space that owns the App (static)
ctx.viewer;               // current viewer, null when logged out
ctx.invocation;           // snapshot of where this open came from:
                          //   surface, source, spaceId, sessionId, turnId,
                          //   toolCallId, embedder, file, id
ctx.shell;                // live location the host is showing now:
                          //   space, session, turn
ctx.locale;               // the viewer's language, e.g. "zh-CN"
ctx.appearance;           // colorScheme, theme, tokens, reducedMotion
ctx.window;               // { visible } — false while the tab is hidden
ctx.permissions;          // appScopes + viewerGrants, for rendering state

// Fresh context on shell / sign-in / grant / theme / visibility changes —
// keep in memory, don't poll
client.app.onContextChanged((next) => render(next));
```

The three identity fields differ by design:

| Field | What it is | Changes |
| --- | --- | --- |
| `ctx.app.homeSpace` | The Space that owns the App | Never |
| `ctx.invocation` | Where this open came from | On each open |
| `ctx.shell` | What the host is showing | As the viewer navigates |

### Match the host

`navigator.language` and `prefers-color-scheme` only match Cohub while the
viewer follows the system. Read `ctx.locale` and `ctx.appearance` instead: the
tokens are resolved values for the theme the viewer sees, including a Space's
custom theme. One call keeps `<html>` in sync:

```ts
client.app.appearance.sync(); // sets --cohub-* variables, color-scheme, and lang
```

```css
body {
  background: var(--cohub-bg-primary, #fff);
  color: var(--cohub-text-primary, #111);
  font-family: var(--cohub-font-sans, system-ui);
}
```

The public tokens are `bg-primary`, `bg-content`, `bg-surface`, `bg-elevated`,
`bg-input`, `bg-hover`, `bg-active`, `text-primary`, `text-secondary`,
`text-tertiary`, `text-placeholder`, `text-disabled`, `border-primary`,
`border-subtle`, `brand`, `brand-hover`, `brand-soft`, `brand-muted`,
`brand-border`, `brand-ring`, `brand-contrast-fg`, `error-fg`, `selection-bg`,
`overlay-scrim`, `shadow-subtle`, `shadow-medium`, `shadow-strong`,
`font-sans`, and `font-mono`. Always keep a fallback: outside a Cohub host they
are absent.

Pause heavy rendering while `ctx.window.visible` is false; background tabs stay
mounted so they can resume instantly.

## Permissions

An App's effective permission on one Space is the union of **two sources** —
either is enough:

| Source | Granted by | Covers | Lifetime |
| --- | --- | --- | --- |
| **App scopes** | Publisher at publish time | Only the App's own Space; eight bounded scopes | While published |
| **Viewer grants** | Viewer via consent dialog | Any permission the viewer holds, on any Space | 14 days, revocable |

The eight app scopes: `space.view`, `session.view`, `file.view`, `file.edit`,
`taskrun.view`, `session.prompt.readonly`, `session.prompt.fullaccess`,
`command.execute`.

The golden rule:

```text
Reads on the App's own Space → app scopes
Actions, other Spaces, generation, account data → viewer grants
```

Request viewer grants from a user gesture, state a clear reason, and let
silent reuse cover return visits — `auth.authorize()` only opens a dialog when
something new is needed. Always act on the returned `target`, which may
resolve to a different Space than you asked for.

```ts
const result = await client.auth.authorize({
  target: { kind: "space", spaceId },
  scopes: ["file.view"],
  reason: "Read the Space you opened this App from.",
});
if (result.status !== "granted" || result.target.kind !== "space") return;
const space = client.space(result.target.spaceId);
```

- Targets: `{ kind: "account" }`, `{ kind: "space", spaceId }`, or
  `{ kind: "pick-space" }`. Account targets accept only account-level scopes.
- Success returns `status`, `requestedTarget`, the actual `target`,
  `resolution`, and the `grant`. Cancellation (`cancelled`) is not an error.
- Targeting exactly `ctx.shell.space.id` — the Space the viewer is already
  looking at — is silent when that Space published the App or has it
  installed, for read-only scopes (`space.view`, `file.view`,
  `file.view.filtered`, `session.view`, `taskrun.view`, `checkpoint.view`) and
  `file.edit`. Any other App asks once, then renews read-only grants silently.
  A grant the viewer revoked always asks again.
- Unavailable Spaces may fall back to a viewer-controlled Space;
  `fallback: "none"` disables this.
- `alwaysAsk: true` skips silent reuse — for re-confirming or switching Space.
- Grants are read without extending expiry; incremental consent
  (`scopeMode: "extend"`) adds scopes to a still-valid grant.
- Viewers manage grants via `cohub apps grants <app>` / `revoke`; an App
  session cannot manage its own grants.
- `auth.requestCreateSpace({ scopes, space })` creates a viewer-owned Space in
  one consent. `granted: false` with a `space` means the Space exists but
  bootstrap did not finish — resume against it; never auto-create a second or
  delete the first.

### API → scope map

| Operation | Scope | Source |
| --- | --- | --- |
| Read space config | `space.view` | app or viewer |
| List models | *(none — just authenticated)* | — |
| Send prompt (full access) | `session.prompt.fullaccess` | app or viewer |
| Send prompt (read-only) | `session.prompt.readonly` | app or viewer |
| LLM completion | `session.prompt.readonly` | app or viewer |
| Read / stream replies, file tree, file content | `session.view`, `file.view` | app or viewer |
| Write files | `file.edit` | app or viewer |
| Run sandbox commands | `command.execute` | app or viewer |
| Create generation task | `generation.create` | **viewer only** |
| Poll tasks, read task runs | `taskrun.view` | app or viewer |
| List viewer's spaces / sessions / activity / all tasks | `user.space.list` / `user.session.list` / `user.usage.read` / `user.taskrun.list` | **viewer only** |
| Create a Space for the viewer | requested scopes on the new Space | **viewer consent** |
| Commerce, realtime, surface, composer, actions, navigation | *(runtime only, no scope)* | — |

"app or viewer" means either source suffices; the app scope covers only the
App's own Space, any other Space needs a viewer grant on it.

## AI

### Prompt an Agent

Send a prompt into a Space Chat and stream the reply.

```ts
// session.prompt.fullaccess + session.view
const result = await space.prompt({
  accessMode: "full_access", // must match the scope you hold
  content: [{ type: "text", text: "Describe a shiba inu on Mars." }],
  sessionId: null, // null creates a session; pass an id to continue
});

space.session(result.session.id).subscribeGeneration({
  state: (e) => renderPartial(e.state),
  finalized: (e) => render(e.turn.assistantText),
});
```

- `space.prompt()` returns immediately; the reply arrives via
  `subscribeGeneration` (or polling `turns.get()`).
- `accessMode` must match the scope you hold. It defaults to `full_access`, so
  holding `session.prompt.readonly` and omitting `accessMode` is the most
  common 403.
- `session.prompt.fullaccess` does **not** include `session.view` — sending
  succeeds while reading the reply 403s without it.

### LLM completion

One-shot completion with no persisted session or turn — for inline
suggestions, summaries, classification. Accepts full conversation history and
an optional space-relative `systemPromptPath`. Needs only
`session.prompt.readonly`.

```ts
const result = await space.completion({
  messages: [{ role: "user", content: [{ type: "text", text: "Summarize in one line." }] }],
});
result.message.content; // assistant ContentBlock[]

for await (const event of space.streamCompletion({ messages, maxTokens: 160 })) {
  if (event.type === "delta") render(event.text); // SSE deltas + final result
}
```

### Generation (image / video / audio)

```ts
// viewer grant generation.create + taskrun.view
const result = await client.generations.createAndWait(
  {
    spaceId,
    model: "gpt-image-2", // from client.models.listMultimodal()
    content: [{ type: "text", text: "A cat on the moon, cartoon style" }],
    parameters: { size: "1024x1024" },
  },
  { onPoll: (d) => updateProgress(d.run.status) },
);
const url = result.output?.find((b) => b.type === "image")?.source?.url;
```

`generation.create` is **viewer-grant-only** — request it from a user gesture.
Polling needs `taskrun.view`; without it, the classic "task created but never
completes" bug.

## Files and sandbox

```ts
const space = client.space(spaceId);

// file.view
const tree = await space.files.tree();
const file = await space.files.read("data.json");

// file.edit
await space.files.write("output/result.json", JSON.stringify(data));

// command.execute — run a shell command in the Space sandbox
const run = await space.runCommand({ command: ["node", "scripts/build.mjs"] });
```

Viewer-funded writes into their own Space: request `file.edit` via
`auth.authorize`. Owner-funded persistence: write from an Action — it runs
with your permissions in the home Space.

## Open files

An App can be the editor or viewer for a file type — a Board editor, a
Markdown studio. Declare the extensions it opens in the page head:

```html
<meta name="cohub:file-handlers" content=".board" />
```

Installing the App registers it for those extensions in `.cohub/apps.json`,
unless another installed App already opens them — installing never replaces a
default. The viewer can change the default under **Open with…** in the file
menu, with **Always open .board files this way**; that is also how a Space
makes one of its own Apps the default. Only one App opens an extension, and it
must still declare it.

Clicking such a file, following a link to it, or `cohub desktop open
file://plans/roadmap.board` opens it in its own window, with the App. Read-only
views, such as a save, stay built in.

```ts
client.app.onLaunch(async ({ file }) => {
  await openDocument(file.spaceId, file.path);
});
```

Each window holds one file. `onLaunch` fires when it opens, when the viewer
opens the same file again (bring it to the front), and when the file is renamed
or moved — save to the new path from then on.

An App the Space published or installed gets `file.view` and `file.edit` on
that Space without a dialog, so opening a file just works. Other Apps ask the
viewer first. Installing is therefore a trust decision for the whole Space:
anyone who can edit `.cohub/apps.json` can install an App, and it can then edit
the Space's files for every member who opens it.

## App Actions

Directory Apps expose server-side entrypoints under `.cohub/actions/`. The
host downloads the immutable App version and runs the entrypoint in the home
Space sandbox **as the App owner** — you pay for the execution — while
entitlement and credit metering apply to the signed-in viewer.

```ts
const task = await client.app.actions.run({
  action: "summarize",
  input: { text: "Long document..." }, // JSON on stdin, ≤ 16 KB
});
const detail = await client.tasks.get(task.taskRunId); // poll to completion
```

`.ts` / `.js` entrypoints run under Node with native type stripping (no
enums, namespaces, parameter properties); other files run via executable bit
or shebang. Inside an Action, the SDK resolves identity from the execution
token — no credentials to manage:

```ts
import { getCohubContext } from "@neta-art/cohub";

const { execution } = getCohubContext();
execution.viewerUserId; // who clicked — meter credits against them
execution.spaceId;      // the home Space
```

- Action keys are `[a-z0-9-_]+`; exactly one matching entrypoint may exist.
- Input is stored with the Task Run and visible to the App owner and Space
  members — never a secret channel.
- Actions cannot invoke `app.actions.run()` recursively.
- Space Hooks can run an Action with `uses: user/space/app/action` — see
  [Space Hooks](https://github.com/talesofai/cohub/blob/main/docs/space-hooks.md).

## Surfaces and forms

### Preview tab / window

The default: the App opens as a workspace preview tab, deep-linkable as
`?window=app:<appId>`.

### Overlay

A transparent, chrome-free layer above the workspace, below Cohub's own UI.

```html
<meta name="cohub:surface" content="overlay" />   <!-- declare at publish time -->
```

```bash
cohub desktop open <app> --as overlay   # or --as window, per open
```

An overlay starts fully click-through. Claim interactive parts and optionally
a geometry:

```ts
cohub.app.requestConfigure({
  inputRegion: [{ x: rect.left, y: rect.top, width: rect.width, height: rect.height }],
});
```

- `inputRegion` — `"none"` (default), `"all"`, or rects. Routes pointer
  events; never clips painting.
- `geometry` (`anchor`, `x`, `y`, `width`, `height`) shrinks the overlay,
  clamped on-screen; an omitted axis fills the window.
- Paint your own transparency (`html, body { background: transparent }`) and
  set `<meta name="color-scheme" content="light dark">` — otherwise Chromium
  paints an opaque backdrop.
- Close yourself with `cohub.app.requestClose()`; the viewer can always press
  `Escape`.

### Background (New Chat)

A workspace App can serve as the New Chat background: `shell.surface` is
`"background"` with `shell.space` set to the hosting Space. It can attach
composer chips but is not callable through UI commands.

### Embed other Apps

A published App can host other Apps in iframes. The embedded runtime keeps
its own bridge, consent dialogs, commerce, and Cohub bar — the embedder never
sees its tokens.

```html
<iframe src="https://cohub.live/alice/studio/w/notes"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
  allow="clipboard-read; clipboard-write; fullscreen; web-share"></iframe>
```

```ts
const embed = cohub.app.embed.attach(frame, {
  appId: context.app.id,
  shell: context.shell ?? null,
  onCloseRequest: () => frame.remove(),
});
cohub.app.onContextChanged((next) => embed.setShell(next.shell ?? null));
embed.dispose();
```

The embedded App sees the forwarded location as `shell` with
`surface: "embed"` and its host in `invocation.embedder` — navigation hints,
never authorization.

### App Surface (callable methods)

Register named methods the Cohub host — including an Agent via
`cohub desktop open <app> --call <method>` — can call on your running App.

```ts
client.app.surface.handle("image.open", async (input, { commandId }) => {
  const result = await openImageStudio(input);
  await client.desktop.reportResult(commandId, { status: "applied", result, error: null });
});
```

- Only registered methods are reachable; no DOM access, no script execution.
- Calls are at-least-once — handlers should be idempotent.
- A response only acknowledges delivery; report the final result via
  `reportResult()`, persisting `commandId` so a reload can resume.
- Calls are accepted only from explicit Cohub app origins:
  `client.app.surface.allowHostOrigins(["https://cohub.internal"])`.

### Window state and closing

Tell the host what the tab should show, and whether work is still unsaved:

```ts
client.app.window.setState({ title: "Roadmap.board", status: "saving", dirty: true });
client.app.window.onBeforeClose(async () => {
  await flushPendingWrites(); // return false or throw to keep the window open
});
```

While `dirty` is true the host never unmounts the App to save memory. Closing
its tab, reloading it, or leaving the workspace first calls `onBeforeClose`,
and only asks the viewer if that fails or takes longer than 10 seconds. A new
App version waits for the next reload instead of replacing a dirty document.
Still keep drafts durable yourself: a closed browser tab cannot wait.

### Shortcuts

Cohub shortcuts such as the command palette keep working while the App has
focus. Once the App has called `context()`, the SDK forwards Ctrl / Cmd
chords the App did not handle; plain typing and the editing chords (copy,
paste, cut, select all, undo, redo) always stay in the App. Call
`event.preventDefault()` to keep a chord for yourself.

### Drops

The viewer can drag files, Tasks, and Apps from Cohub onto the App:

```ts
client.app.onDrop({
  accept: ["file", "task"],
  over: ({ x, y }) => showDropMarker(x, y),
  leave: () => hideDropMarker(),
  drop: ({ x, y, resources }) => placeResources(resources, x, y),
});
```

Coordinates are frame-local CSS pixels. While hovering, the App only learns
which kinds are being dragged; the resources arrive on `drop`, when the viewer
hands them over. Each resource has a `type` and a `ref` (the path, for files)
plus optional metadata such as `title`, `mimeType`, and `size`. Treat drops as
untrusted input, like a paste: validate each `ref` and read the resource through
your own authorized API instead of trusting the metadata.

### Composer context

One compact context chip on the Cohub composer while the App is active.
Label ≤ 120 chars, content ≤ 32 KB, plain text.

```ts
client.app.composer.setChip({ key: "selection", label: "3 selected", content: "..." });
client.app.composer.clearChip("selection");
```

### Navigation

Open any Cohub resource — App, file, session, task, checkpoint, cronjob —
inside the host workspace.

```ts
await client.navigation.open({ kind: "session", spaceId, sessionId });
await client.navigation.open({ kind: "app", ref: "username/space/app" }, { method: "focus", input: {} });
```

Returns `{ handled }` — `false` when the host can't (e.g. broker mode);
degrade gracefully.

### Diagnostics

`client.app.onDiagnostic(cb)` forwards host diagnostics (code + message) for
debugging runtime integration.

## Realtime rooms

Multiplayer state, presence, and generic JSON events between viewers of the
same App. Runtime-native — no scope or consent needed.

```ts
const room = await client.app.realtime.createRoom({ code: "TEAM-ALPHA" });
const stop = room.subscribe("shared.state.updated", ({ data }) => render(data));
await room.publish("shared.state.updated", { value: 42 });
```

- Events are ordered while connected but **not replayed** — re-fetch
  authoritative state after reconnecting.
- `room.send()` for high-rate traffic (no ACK); `publish()` when delivery
  must be confirmed. `seatPerUser: true` gives each viewer one seat.
- Rooms live minutes to 24 h, are scoped to one App, and cannot be created
  outside the App runtime.

## Commerce

Sell one-time products bound to the App's runtime identity. Products carry
**feature benefits** (access gates) and **credit benefits** (consumable,
Space-scoped credits). Requires commerce enabled on the Space.

```ts
const { entitlements, credits } = await client.app.commerce.getEntitlements();

// Feature unlock
const unlocked = entitlements.some((e) => e.benefitKey === "pro" && e.enabled);
if (!unlocked) await client.app.commerce.purchase({ productKey: "pro_unlock" });

// Metered action — operationId is the idempotency key per logical action
const result = await client.app.commerce.consumeCredits({
  amount: 10,
  operationId: crypto.randomUUID(),
  reason: "Export high-resolution image",
});
if (result.status === "insufficient") {
  await client.app.commerce.purchase({ productKey: "credit_pack" });
}

// After checkout returns, re-query authoritative order state
const state = await client.app.commerce.getCheckoutState();
if (state.orderId) await client.app.commerce.getOrder(state.orderId);
```

Key rules:

- `purchase()` redirects to checkout; call it from the user's purchase action,
  never during initialization. Checkout return is not proof of payment —
  re-query `getCheckoutState()` / `getOrder()`.
- Space credits meter actions inside the Space's Apps; Cohub Balance is a
  separate global platform-managed product component (`cohubBalanceUsd`,
  whole dollars, immutable).
- Product prices are immutable. Change them by creating a versioned product
  key (`image_credit_pack_050`), rebinding the benefit, and archiving the old
  product.
- Pair commerce with Actions: the Action runs at your cost and reports the
  viewer's entitlements; `consumeCredits` recovers the cost. This is the
  standard pattern for owner-funded generation — see
  [whale-shrine](https://github.com/talesofai/cohub/blob/main/cohub-apps/whale-shrine/README.md).
- Setup is CLI-side: `cohub spaces commerce setup`, `benefits create`,
  `products create`. See the
  [sample Apps index](https://github.com/talesofai/cohub/blob/main/cohub-apps/README.md)
  for the minimal commerce loop.

## Publishing and verifying

Publishing and management live in [Apps](/docs/create/apps). One rule during
development: runtime APIs only work in a **published** App — test against the
real runtime, publish a new version after changes.

## Pitfalls checklist

- [ ] `env: "dev"` / `"prod"` passed explicitly — the SDK defaults to prod.
- [ ] App scopes cover every read on the App's own Space: `session.view`,
      `taskrun.view`, `file.view`. Least privilege beyond that.
- [ ] `generation.create` and `user.*` are viewer-grant-only — request at
      runtime from a gesture, never at publish time.
- [ ] `accessMode` matches the scope held; omitting it means full access.
- [ ] `session.prompt.fullaccess` ⊅ `session.view`; `generation.create` ⊅
      `taskrun.view`. Pair them.
- [ ] `auth.authorize()` from a user gesture with a reason; safe to repeat.
- [ ] Act on the returned `target`, not the request; invocation context is
      routing info, not authorization.
- [ ] Broker mode: `authorize()` before other API calls — the popup exchange
      consumes the user-activation budget.
- [ ] Space has a slug and owner has a username before publishing.
- [ ] Model ids come from `models.listMultimodal()`, not hardcoded.
- [ ] Surface handlers and `consumeCredits` are idempotent (stable
      `operationId`); server data stays authoritative, realtime resyncs after
      reconnect.
- [ ] Editors report `dirty` through `window.setState()` and flush in
      `onBeforeClose()`; drafts also survive a closed browser tab.
- [ ] No tokens or secrets in URLs or shipped assets.

## Related

- [Apps](/docs/create/apps) — publishing and management
- [SDK](/docs/developers/sdk) — the client surface
- [CLI](/docs/developers/cli) — terminal workflows
- [Sample Apps](https://github.com/talesofai/cohub/blob/main/cohub-apps/README.md) — runnable examples per scenario
