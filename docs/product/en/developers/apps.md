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

Logged-out viewers sign in before consent. Reinitialize context after a full-page redirect. Existing `auth.request()`, `requestSpace()` and `requestCreateSpace()` remain compatible. See the [authorization contract](https://github.com/talesofai/cohub/blob/main/docs/app-authorization.md).

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
grants via `client.auth.request()` are needed elsewhere.

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
  await client.auth.request({
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

### Account-level data

Beyond the App's own Space, viewer grants unlock the viewer's account data.

```ts
// user.space.list
await client.auth.request({ scopes: ["user.space.list"], reason: "Show your spaces" });
const { spaces } = await client.spaces.list();

// user.session.list
const { sessions } = await client.user.listSessions({ limit: 20 });

// user.usage.read
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
reason, and let silent reuse cover return visits — `auth.request` only opens
a dialog when something new is needed.

## Publishing and verifying

Publish targets, versions, and management details live in
[Apps](/docs/create/apps).

The one rule that matters during development: runtime APIs (`context()`,
`auth.request`, realtime, commerce) only work inside a **published** App.
Local `file://` pages and bare static URLs cannot exercise them — publish and
test against the real runtime, and publish a new version (`cohub apps
publish-version`) after changes.

## Best practices

- Least privilege: request the smallest scope set that works
- Call `auth.request` from user gestures with a clear reason
- Treat invocation context as routing info, not authorization
- Keep server data authoritative; realtime is a transport, resync after reconnect
- Make Surface handlers and credit consumption idempotent
- Never put tokens or secrets in URLs or shipped assets

## Related

- [Apps](/docs/create/apps) — publishing and management
- [SDK](/docs/developers/sdk) — full client surface
- [CLI](/docs/developers/cli) — terminal workflows
