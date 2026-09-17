---
title: App development
description: Cohub App capabilities — runtime context, permissions, prompts, generation, files, realtime, surface, and commerce.
---

Cohub Apps are published web pages that run inside a Cohub runtime. From app
code you can talk to Agents, generate media, read and write Space files, share
realtime state between viewers, expose methods to Agents, and sell products.

This page is a capability map: what each scenario can do, which SDK surface to
call, and what authorization it needs. For the full runtime reference, see the
[App Runtime Guide](https://github.com/talesofai/cohub/blob/main/packages/sdk/docs/app-runtime-guide.md).

## Runtime in one minute

`createCohubClient()` needs no token inside an App — the host provides
short-lived auth. Runtime APIs only work inside a **published** App.

- **Bridge mode** — the App runs in a Cohub iframe (default).
- **Broker mode** — the App is opened standalone; the SDK falls back to a
  popup broker. Pass `app: { brokerOrigin, appId }` (or the slug triple) to
  `createCohubClient` to enable it.

```ts
import { createCohubClient } from "@neta-art/cohub";

const client = createCohubClient({ env: isDevApp ? "dev" : "prod" });
const ctx = await client.context();
if (!ctx?.app?.id) throw new Error("Not inside a published app");
```

`env` matters in the browser: an app served from a dev host must pass
`env: "dev"`, or it will silently call production.

## Authorization

New Apps use `client.auth.authorize({ target, scopes })` with an account, explicit Space, or Space-picker target. Success includes the actual target, resolution and authoritative grant. Use the returned Space ID for subsequent operations. Unavailable Spaces may fall back to a viewer-controlled Space; `fallback: "none"` disables this.

Logged-out viewers sign in before consent. Reinitialize context after a full-page redirect. Legacy `auth.request()` / `requestSpace()` keep working but cannot report the actual target; `requestCreateSpace()` remains the create-Space entry. See the [authorization contract](https://github.com/talesofai/cohub/blob/main/docs/app-authorization.md).

## Context

```ts
const ctx = await client.context();

ctx.app.id;                        // App id
ctx.app.slug;                      // public slug
ctx.app.homeSpace;                 // the Space that owns the App
ctx.viewer;                        // current viewer, may be null
ctx.invocation;                    // where the App was opened from
ctx.shell;                         // current Cohub workspace location
ctx.permissions;                   // appScopes + viewerGrants, for rendering state
```

`invocation` carries `surface`, `source`, `spaceId`, `sessionId`, `turnId`,
and `toolCallId` when available. It describes where an open came from — it is
context, not authorization.

`ctx.shell` contains the current `space`, `session`, and `turn` ids.
Its `turn` is the Turn currently in view, not necessarily the Turn being
generated. These values can differ from `app.homeSpace` and `invocation`.
They are null when the shell has no matching location. A workspace App has
`shell.surface: "workspace"`. A new chat background has
`shell.surface: "background"`, with `shell.space` set to the hosting Space.

`client.app.onContextChanged(cb)` pushes fresh context when the shell location,
sign-in state, or grants change. Keep the latest context in memory for frequent
reads instead of polling `client.context()`. Context is informational, not an
authorization source.

## Capability scenarios

Every scenario below assumes `client` is initialized and `spaceId` is known
(`ctx.shell.space.id`, `ctx.app.homeSpace.id`, or `ctx.invocation.spaceId`).
Scope lines show the
minimum authorization; app scopes cover only the App's own Space, and viewer
grants via `client.auth.authorize()` are needed elsewhere.

### Prompt an Agent

Send a prompt into a Space Chat and stream the reply.

```ts
// session.prompt.fullaccess + session.view
const result = await space.prompt({
  accessMode: "full_access",
  content: [{ type: "text", text: "Describe a shiba inu on Mars." }],
  sessionId: null, // null creates a session; pass an id to continue
});

const stop = space.session(result.session.id).subscribeGeneration({
  state: (e) => renderPartial(e.state),
  finalized: (e) => render(e.turn.assistantText),
  error: (e) => showError(e),
});
```

Key points:

- `space.prompt()` returns immediately with a turn whose reply arrives via
  `subscribeGeneration` (or by polling `turns.get()`).
- `accessMode` must match the scope you hold: `full_access` needs
  `session.prompt.fullaccess`, `read_only` needs `session.prompt.readonly`.
  This mismatch is the most common 403.

### LLM completion (read-only)

One-shot completion with no persisted session or turn — ideal for inline
suggestions, summaries, or classification.

```ts
// session.prompt.readonly + session.view
const result = await space.prompt({
  accessMode: "read_only", // must be explicit; omitted → full_access → 403
  sessionId: null, // read-only prompts use a throwaway session
  content: [{ type: "text", text: prompt }],
});
```

### Generation (image / video / audio)

Create a multimodal generation task and wait for outputs.

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

const imageUrl = result.output?.find((b) => b.type === "image")?.source?.url;
```

Key points:

- `generation.create` can only come from a **viewer grant** — request it from
  a user gesture:

  ```ts
  await client.auth.authorize({
    target: { kind: "space", spaceId },
    scopes: ["generation.create"],
    reason: "Generate images in this app",
  });
  ```

- Polling the result needs `taskrun.view`. `generation.create` without
  `taskrun.view` is the classic "task created but never completes" bug.

### Space files

Read the file tree and file contents, and write files back.

```ts
const space = client.space(spaceId);

// file.view
const tree = await space.files.tree();
const file = await space.files.read("data.json");

// file.edit
await space.files.write("output/result.json", JSON.stringify(data));
```

### Sandbox commands

Run a shell command in the Space sandbox.

```ts
// command.execute
const run = await space.runCommand({ command: ["node", "scripts/build.mjs"] });
```

### Session realtime

Subscribe to Chat events while an Agent works.

```ts
// session.view
const stop = session.subscribe({
  progress: (e) => renderProgress(e.payload),
  finalized: (e) => render(e.payload),
});
```

### Realtime rooms

Multiplayer state, presence, and generic JSON events between viewers of the
same App. Runtime-native — no scope or consent needed.

```ts
const room = await client.app.realtime.createRoom({ code: "TEAM-ALPHA" });

const stop = room.subscribe("shared.state.updated", ({ data }) => {
  render(data);
});

await room.publish("shared.state.updated", { value: 42 });
```

Key points:

- Events are ordered while connected but **not replayed**. Re-fetch
  authoritative state after reconnecting.
- Use `room.send()` for high-rate traffic, `publish()` for meaningful updates.

### Expose methods to Agents (App Surface)

Register named methods that the Cohub host — including an Agent via
`cohub desktop open <app> --call <method>` — can call on your running App.

```ts
client.app.surface.handle("image.open", async (input, { commandId }) => {
  const result = await openImageStudio(input);
  await client.ui.reportResult(commandId, {
    status: "applied",
    result,
    error: null,
  });
});
```

Key points:

- Only registered methods are reachable. No DOM access, no script execution.
- Calls are delivered at-least-once; handlers should be safe to repeat.
- A Surface response only acknowledges delivery; report the final result via
  `client.ui.reportResult()`.

### Composer context

Attach one compact context chip to the Cohub composer while the App is active.

```ts
client.app.composer.setChip({
  key: "selection",
  label: "3 selected",
  content: "Selected records:\n- customer_123\n- customer_456",
});

client.app.composer.clearChip("selection");
```

### Commerce

Sell one-time products and consume credits, bound to the App's runtime
identity. Requires commerce enabled on the Space.

```ts
const { entitlements, credits } = await client.app.commerce.getEntitlements();

// Feature unlock
const unlocked = entitlements.some((e) => e.benefitKey === "pro" && e.enabled);
if (!unlocked) await client.app.commerce.purchase({ productKey: "pro_unlock" });

// Metered action
const result = await client.app.commerce.consumeCredits({
  amount: 10,
  operationId: crypto.randomUUID(), // stable id per logical action
  reason: "Export high-resolution image",
});
if (result.status === "insufficient") {
  await client.app.commerce.purchase({ productKey: "credit_pack" });
}

// After checkout returns, re-query authoritative order state
const state = await client.app.commerce.getCheckoutState();
if (state.orderId) {
  const { order } = await client.app.commerce.getOrder(state.orderId);
}
```

Key points:

- Use a stable, unique `operationId` per logical action — retries stay
  idempotent.
- Checkout return is not proof of payment. Re-query
  `getCheckoutState()` / `getOrder()` after redirect.
- See the [App Commerce Guide](https://github.com/talesofai/cohub/blob/main/docs/app-commerce-guide.md)
  for product setup.

### Models

Listing models needs no scope — just authentication.

```ts
const models = await client.models.list();
const multimodal = await client.models.listMultimodal();
```

### Run App Actions

Directory Apps can expose server-side entrypoints under `.cohub/actions/`. The
frontend invokes one by file stem; the host downloads the immutable App version
and runs it in the App home Space Sandbox with the existing execution token, so
the App owner is the platform cost owner while the signed-in viewer's
entitlements apply.

```ts
const task = await cohub.app.actions.run({
  action: "summarize",
  input: { text: "Long document..." },
});
const result = await cohub.tasks.get(task.taskRunId);
```

- `.ts` / `.js` entrypoints use the Sandbox Node.js runtime with native type
  stripping (no enums, namespaces, or parameter properties). Other files run
  through their executable bit, shebang, or binary format.
- Input arrives as JSON on stdin. It is stored with the Task Run and is visible
  to the App owner and Space members who can inspect the Task — never treat it
  as a secret channel.
- Action keys are `[a-z0-9-_]+`, exactly one matching entrypoint may exist, and
  Actions cannot invoke `cohub.app.actions.run()` recursively.

### Overlay surface

Besides a preview tab, an App can open as an **overlay**: a transparent,
chrome-free layer above the workspace that always stays below Cohub's own UI.
Declare it at publish time, or request it per open:

```html
<meta name="cohub:surface" content="overlay" />
```

```bash
cohub desktop open <app> --as overlay
cohub desktop open <app> --as window   # one-off override
```

An overlay starts fully click-through. The App claims the interactive parts and
optionally its own geometry:

```ts
cohub.app.requestConfigure({
  inputRegion: [{ x: rect.left, y: rect.top, width: rect.width, height: rect.height }],
});
```

`inputRegion` is `"none"` (default), `"all"`, or a list of rects; it only routes
pointer events and never clips what is painted. `geometry` (`anchor`, `x`, `y`,
`width`, `height`) shrinks the overlay and is clamped on-screen; an omitted axis
fills the window, and an invalid axis ignores the whole shape. Paint your own
transparency (`html, body { background: transparent }`) and set
`<meta name="color-scheme" content="light dark">` so Chromium does not paint an
opaque backdrop. The App closes itself with `cohub.app.requestClose()`; the
viewer can always press `Escape`.

### Embed other Apps

A published App can host other Apps in iframes. The public page keeps owning the
embedded runtime — its bridge, consent dialogs, commerce, and Cohub bar behave
exactly as standalone, and the embedder never sees its tokens.

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

The embedded App sees the forwarded location as `context.shell` with
`surface: "embed"` and learns its host from `context.invocation.embedder`. Those
ids are navigation hints, never authorization inputs — reading anything still
requires the embedded App's own grants.

### Account-level data

Beyond the App's own Space, viewer grants unlock the viewer's account data.

```ts
// user.space.list
await client.auth.authorize({ target: { kind: "account" }, scopes: ["user.space.list"], reason: "Show your spaces" });
const { spaces } = await client.spaces.list();

// user.session.list
await client.auth.authorize({ target: { kind: "account" }, scopes: ["user.session.list"], reason: "List your sessions" });
const { sessions } = await client.user.listSessions({ limit: 20 });

// user.usage.read
await client.auth.authorize({ target: { kind: "account" }, scopes: ["user.usage.read"], reason: "Show your activity" });
const activity = await client.user.getActivity({ days: 30 });
```

### Create a Space for the viewer

One consent creates a viewer-owned Space and grants the requested scopes on
it. `space` is the same `CreateSpaceInput` as `client.spaces.create()`.
Never silent — each confirm mints a new Space. The host creates with the
viewer's account token. An App holding a `space.create` viewer grant can also
call `client.spaces.create()` directly.

```ts
const { granted, space } = await client.auth.requestCreateSpace({
  scopes: ["file.view", "session.view", "session.prompt.fullaccess"],
  space: {
    name: "Whale Shrine",
    bootstrapSource: { type: "checkpoint", checkpointId },
  },
  reason: "Create a workspace from this template.",
});
if (granted && space) {
  const created = client.space(space.id);
}
// `granted: false` with a `space` means the Space exists but bootstrap or
// authorization did not finish. Keep the id and resume; never create a second
// Space or delete the first one automatically.
```

Checkpoint access still uses `checkpoint.view` on the source Space. A public
template Space with signed-in guest access is enough for anyone to clone.

## Permissions in one page

App authorization is the union of two sources — either is enough:

| Source | Granted by | Covers | Lifetime |
| --- | --- | --- | --- |
| **App scopes** | Publisher at publish time | Only the App's own Space; eight bounded scopes | While published |
| **Viewer grants** | Viewer via consent dialog | Any permission the viewer holds, on any Space they pick | 14 days, revocable |

The golden rule:

```text
Reads on the App's own Space → app scopes
Actions, other Spaces, generation, account data → viewer grants
```

Request viewer grants from a user gesture (button click), state a clear
reason, and let silent reuse cover return visits — `auth.authorize()` only
opens a dialog when something new is needed. Always act on the returned
`target`, which may resolve to a different Space than you asked for.

## Publishing and verifying

Publish targets, versions, and management details live in
[Apps](/docs/create/apps).

The one rule that matters during development: runtime APIs (`context()`,
`auth.authorize`, realtime, commerce) only work inside a **published** App.
Local `file://` pages and bare static URLs cannot exercise them — publish and
test against the real runtime, and publish a new version (`cohub apps
publish-version`) after changes.

## Best practices

- Least privilege: request the smallest scope set that works
- Call `auth.authorize` from user gestures with a clear reason
- Treat invocation context as routing info, not authorization
- Keep server data authoritative; realtime is a transport, resync after reconnect
- Make Surface handlers and credit consumption idempotent
- Never put tokens or secrets in URLs or shipped assets

## Related

- [Apps](/docs/create/apps) — publishing and management
- [SDK](/docs/developers/sdk) — full client surface
- [CLI](/docs/developers/cli) — terminal workflows
