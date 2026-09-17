---
title: SDK
description: Use the Cohub TypeScript SDK for Spaces, Chats, Apps, realtime updates, and App runtime APIs.
---

The Cohub SDK is the TypeScript client for product APIs and realtime collaboration.

Package: `@neta-art/cohub`

## Install

```bash
npm install @neta-art/cohub
```

## Create a client

```ts
import { createCohubClient } from "@neta-art/cohub";

const client = createCohubClient({
  getAccessToken: async () => localStorage.getItem("token"),
});
```

Defaults:

| Env | API | WebSocket |
| --- | --- | --- |
| production | `https://api.cohub.live` | `wss://gateway.cohub.live/ws` |
| development | `https://api-dev.cohub.live` | `wss://gateway-dev.cohub.live/ws` |

Select development:

```ts
const client = createCohubClient({
  env: "dev",
  getAccessToken: async () => token,
});
```

Or with `ENV=dev` in Node.js.

Custom endpoints are supported when self-hosting or proxying.

## Spaces and Chats

```ts
const created = await client.spaces.create({ name: "Demo" });
const space = client.space(created.space.id);

const sessionResult = await space.sessions.create({ title: "Planning" });
const session = space.session(sessionResult.session.id);

await session.messages.send({
  content: [{ type: "text", text: "Help me plan the next steps" }],
});
```

Product mapping:

- Space → `client.spaces` / `client.space(id)`
- Chat → session APIs under a Space
- Save → checkpoint APIs under a Space
- App → `client.apps`

## Session realtime

Subscribe to session events while an Agent is working:

```ts
const stop = session.subscribe({
  progress(event) {
    console.log("progress", event.payload);
  },
  finalized(event) {
    console.log("done", event.payload);
  },
});

stop();
```

## Apps

Create and manage Apps through `client.apps`, including publish, update, versions, and lookups by slug.

For ordinary server/automation code, use normal user auth. For code **inside a published App**, use the App runtime APIs below.

## App runtime

Published Apps can run with short-lived runtime auth provided by the Cohub shell.

```ts
const client = createCohubClient(); // token comes from the App runtime

const context = await client.context();
// App identity, Space identity, viewer state

await client.auth.authorize({
  target: { kind: "space", spaceId },
  scopes: ["session.prompt.readonly"],
  reason: "Continue the demo chat",
});
```

Important:

- Runtime APIs work inside a published App
- They do not work from arbitrary static hosting or local file open
- App scopes and per-space viewer grants are enforced

Commerce helpers live under `client.app.commerce.*` when commerce is enabled and the App is published.

### Realtime rooms

Inside a published App, `client.app.realtime` provides temporary rooms for
multiplayer state, presence, and generic JSON events. It uses the App runtime
identity and needs no additional scope or consent dialog.

```ts
const room = await client.app.realtime.createRoom({
  code: "TEAM-ALPHA", // optional
  expiresInSeconds: 2 * 60 * 60,
});

const stop = room.subscribe("shared.state.updated", ({ data }) => {
  console.log(data);
});

await room.publish("shared.state.updated", { value: 42 });
stop();
await room.leave();
```

Events are ordered while connected but are not replayed. Use `room.send()` for
high-rate traffic, and resync authoritative state after reconnecting. Realtime
rooms are runtime-only; normal server auth and the CLI cannot create or join
them.

See the [App Runtime Guide](https://github.com/talesofai/cohub/blob/main/packages/sdk/docs/app-runtime-guide.md#realtime-rooms-apprealtime)
for lifecycle, presence, membership, seat, and limit details.

### Callable surface

An App can expose named methods to the Cohub host embedding it, so an Agent can
call into the running App with `cohub desktop open <app> --call <method>`.

```ts
client.app.surface.handle("image.open", async (input, { commandId }) => {
  openImageStudio(input, commandId);
});

await client.ui.reportResult(commandId, {
  status: "applied",
  result: selectedImage,
  error: null,
});
```

Only registered methods are reachable. There is no DOM access or script
execution. A Surface response only acknowledges delivery; the App reports the
final result through the same UI command with `client.ui.reportResult()`.

Calls are delivered at-least-once, so prefer methods that are safe to repeat.

### Composer context

An App running in the workspace preview or as the New Chat background can attach
one compact context chip to the Cohub composer. The label stays short while the
full content is available to the user and sent with each message while attached:

```ts
client.app.composer.setChip({
  key: "selection",
  label: "3 selected",
  content: "Selected records:\n- customer_123\n- customer_456\n- customer_789",
});

client.app.composer.clearChip("selection");
```

Calling `setChip()` again with the same key updates the existing chip. Cohub owns
the chip's appearance and treats its content as plain text. Labels are limited to
120 characters and content to 32KB. A preview chip is attached while that App is
active. A background chip is attached while the New Chat background is visible
and no preview is active. Closing or reloading either surface clears its chip.

New Chat backgrounds expose composer context but are not callable through UI
commands.

Because a published App is publicly embeddable, surface calls and composer
context are accepted only from an
explicit list of Cohub app origins (or the App's own origin), and replies go to
that origin rather than being broadcast. An App embedded by any other site
registers its methods but never answers. The list is deliberately not a
`*.cohub.live` suffix match, since Apps themselves are served from a Cohub
subdomain. Self-hosted deployments and local development widen it explicitly:

```ts
client.app.surface.allowHostOrigins(["https://cohub.internal"]);
```

## Main client surfaces

The client groups product APIs intentionally:

| Area | Client surface |
| --- | --- |
| Spaces / sessions / files | `client.spaces`, `client.space(id)` |
| Apps | `client.apps` |
| Generations | `client.generations` |
| Models | `client.models` |
| Search | `client.search` |
| Tasks / cron | `client.tasks`, `client.cronJobs` |
| Channels | `client.channels` |
| Billing / commerce | `client.billing`, `client.appCommerce` |
| App runtime | `client.context()`, `client.auth`, `client.app` |
| Cohub UI commands | `client.ui` |

Use only the surfaces you need. Start with Spaces, sessions, and Apps.

## Auth model

Outside App runtime:

- Provide `getAccessToken`
- Optionally handle token storage helpers if you integrate login yourself

Inside App runtime:

- The host can provide short-lived tokens
- Request additional viewer grants only when required

Prefer least privilege for any App that runs in other people’s browsers.

## Practical tips

- Reuse one client instance per app shell
- Prefer Space-scoped helpers (`client.space(id)`) for readable code
- Use realtime subscriptions for streaming UX, not tight polling loops
- Keep product terms aligned in UI copy: Chat/Save, not session/checkpoint

## Related

- [App development](/docs/developers/apps) — runtime capabilities and permissions
- [CLI](/docs/developers/cli)
- [Apps](/docs/create/apps)
- [Core concepts](/docs/learn/core-concepts)
