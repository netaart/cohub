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

Published Apps run with short-lived runtime auth provided by the Cohub shell — no API key in App code. `client.context()`, `client.auth.authorize()`, realtime rooms, callable surface, composer context, commerce, and App Actions are runtime-only.

The complete model — permissions, the API → scope map, capability recipes, and pitfalls — lives in [App development](/docs/developers/apps).

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
| Cohub UI commands | `client.desktop` |

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
