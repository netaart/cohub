# @neta-art/cohub

Cohub SDK for interacting with spaces, sessions, checkpoints, and realtime agent collaboration.

## Install

```bash
npm install @neta-art/cohub
```

## Quick start

```ts
import { createCohubClient } from "@neta-art/cohub";
import type { ContentBlock } from "@neta-art/cohub";

const client = createCohubClient({
  getAccessToken: async () => localStorage.getItem("token"),
});

const content: ContentBlock[] = [{ type: "text", text: "Hello" }];
```

The SDK connects to production by default:

- API: `https://api.cohub.live`
- WebSocket: `wss://gateway.cohub.live/ws`

Use development with `ENV=dev` in Node.js:

```bash
ENV=dev node app.js
```

Or select it explicitly in code:

```ts
const client = createCohubClient({
  env: "dev",
  getAccessToken: async () => localStorage.getItem("token"),
});
```

Development uses:

- API: `https://api-dev.cohub.live`
- WebSocket: `wss://gateway-dev.cohub.live/ws`

Custom endpoints are still supported when needed:

```ts
const client = createCohubClient({
  baseUrl: "https://api.example.com",
  getAccessToken: async () => localStorage.getItem("token"),
  websocket: {
    url: "https://gateway.example.com",
  },
});
```

## Spaces and sessions

A **Space** is a live, isolated working environment where users and agents create together.

```ts
const created = await client.spaces.create({ name: "Demo" });
const space = client.space(created.space.id);

const sessionResult = await space.sessions.create({ title: "Planning" });
const session = space.session(sessionResult.session.id);

await session.messages.send({
  content: [{ type: "text", text: "Help me plan the next steps" }],
});
```

## Boards

Use `space.boards` for collection operations and bind an ID with
`space.board(boardId)` for entity operations:

```ts
const created = await space.boards.create({
  path: "boards/plan.board",
  title: "Plan",
  items: [{
    id: "goal",
    type: "geo",
    frame: { x: 80, y: 80, width: 240, height: 120, rotation: 0 },
    props: { shape: "rounded", text: "Ship" },
    style: { color: "green" },
  }],
});

const board = space.board(created.board.id);
// Equivalent: space.boards.byId(created.board.id)

// Machine-readable types, enums and coordinate spaces for dynamic clients.
const capabilities = await board.capabilities();

const snapshot = await board.authoring({ include: ["items"] });

await board.mutateSemantic({
  baseVersion: snapshot.board.version,
  commands: [{
    type: "item.patch",
    itemId: "goal",
    patch: { props: { text: "Updated plan" } },
  }],
});

await board.play({
  commandId: crypto.randomUUID(),
  type: "play",
  compositionId: "ambient",
});
```

A bound `BoardClient` injects its `boardId` into semantic mutation requests.
Realtime subscriptions use the same semantic resource projection:

```ts
const stop = board.subscribe({
  changed(event) {
    console.log("version", event.payload.version);
    console.log("items", event.payload.changed.items);
  },
  playback(event) {
    console.log("playback", event.payload.status);
  },
});

stop();
```

Task Items keep a small, replaceable display snapshot beside their stable `taskRunId`. The SDK can build that projection from an authoritative TaskRun without copying the full payload, result or inline media into a Board:

```ts
import { taskRunToBoardTaskSnapshot } from "@neta-art/cohub/board";

const snapshot = taskRunToBoardTaskSnapshot(taskRun);
```

Use `client.tasks.getMany(ids, { spaceId })` to restore the TaskRuns for a Board in one request. The server applies the same Space permissions and result sanitization as the regular task list endpoint.

Board is split by dependency: the model runs anywhere, drawing needs PixiJS.
`@neta-art/cohub/board` carries the document schema, geometry, the shape layer,
timeline compilation and export planning, with no renderer and no PixiJS — so
agents, servers and edge workers can read, write and measure boards without a
graphics stack:

```ts
import {
  BoardDocumentSchema,
  compileComposition,
  createBoardExtensionRegistry,
  itemBounds,
  planBoardExport,
} from "@neta-art/cohub/board";

const composition = compileComposition({
  id: "ambient",
  name: "Ambient",
  duration: 1_000,
  tracks: [{
    id: "image-translation",
    target: { type: "item", itemId: "image" },
    channel: "transform.translation",
    fill: "both",
    keyframes: [
      { time: 0, value: { x: 0, y: 0 } },
      { time: 500, value: { x: 0, y: -8 } },
      { time: 1_000, value: { x: 0, y: 0 } },
    ],
  }],
  playback: { loop: true, endBehavior: "hold", reducedMotion: { mode: "base" } },
});

await space.boards.create({
  path: "boards/ambient.board",
  metadata: {
    playback: { compositionId: composition.id, delayMs: 500 },
  },
  compositions: [composition],
});
```

Drawing pixels is where PixiJS enters. The card renderers and themes the editor
uses live behind `@neta-art/cohub/board/render`, and turning a plan into an
image has dedicated browser and Node.js entries:

```ts
import { getBoardCardRenderer } from "@neta-art/cohub/board/render";
import { renderBoardExport } from "@neta-art/cohub/board/export";
import {
  createBoardHeadlessRenderer,
  exportBoardImageBytes,
} from "@neta-art/cohub/board/headless";
```

Install `pixi.js` to use `board/render` or `board/export`, and add
`@napi-rs/canvas` as well for `board/headless`. Both are optional peers, and
`@neta-art/cohub/board` never reaches for either, so HTTP-only installations
stay lightweight.

Text metrics follow the same split. The renderers measure through a real canvas
and set that up themselves, so nothing extra is needed to draw or export. Called
straight off `@neta-art/cohub/board` with no renderer in play,
`measureBoardText` returns a per-character estimate instead — fine for laying
out a board on a server, but call `installBoardTextMeasurement` from
`board/render` first if the numbers have to match what the editor draws.

## Session subscriptions

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

## Apps and the App runtime

An **App** (previously *Work*) is a published, shareable web page hosted by
Cohub. When a viewer opens an App, it runs inside a Cohub-managed runtime that
provides short-lived access tokens — no API keys required.

These runtime-only APIs are available **exclusively inside a published App**:

- `client.context()` — returns App identity, App home Space identity, the current
  viewer, permissions, optional invocation identifiers, and the current shell
  location (`context.shell`). A new chat background has `shell.surface:
  "background"` with the hosting Space in `shell.space` (`session` / `turn` are
  null); `invocation.spaceId` is the same Space for compatibility.
  Returns `null` outside an App runtime. `client.app.onContextChanged()` pushes
  fresh state.
- `client.auth.authorize({ target, scopes, reason?, alwaysAsk?, fallback? })`
  — requests consent for an account, a specific Space, or a viewer-picked
  Space. Silent when a grant covers the scopes. Returns the actual target,
  how it was resolved, and the authoritative grant; see the
  [authorization contract](../../docs/app-authorization.md).
  `client.auth.request()` / `requestSpace()` / `requestCreateSpace()` remain
  available for older Apps.
- `client.context().permissions.viewerGrants` — render the viewer's current
  per-space grants. Grant management uses an account-authenticated client or
  the CLI; an App session cannot manage its own grants.
- `client.app.commerce.*` — entitlement checks, credit consumption,
  purchases.
- `client.app.realtime.*` — temporary rooms, typed events, presence, and
  membership.

### Quick start (inside an App)

```ts
// Browsers don't inject ENV — pass it explicitly.
const client = createCohubClient({ env: "prod" });

const ctx = await client.context();
if (!ctx?.space?.id) throw new Error("Not inside a published app.");

const sourceSessionId = ctx.invocation?.sessionId ?? null;
// `shell.space` is the current Cohub location. `app.homeSpace` is the App's
// owning Space. A new chat background also has `invocation.spaceId`.
const spaceId = ctx.shell?.space?.id ?? ctx.invocation?.spaceId ?? ctx.app.homeSpace?.id ?? ctx.space.id;
const space = client.space(spaceId);

// Request viewer grants from a user gesture (button click)
const consent = await client.auth.authorize({
  target: { kind: "space", spaceId },
  scopes: ["session.prompt.fullaccess", "generation.create"],
  reason: "This app sends prompts and generates images.",
});
if (consent.status !== "granted") return;
// Act on the granted target, which may differ from the request.
const activeSpace = consent.target.kind === "space"
  ? client.space(consent.target.spaceId)
  : space;
```

### The permission model (critical)

An app's effective permission for one Space is the union of **two grant
sources** — either one is enough:

- **App scopes** (no consent): eight bounded scopes — `space.view`,
  `session.view`, `file.view`, `file.edit`, `taskrun.view`,
  `session.prompt.readonly`, `session.prompt.fullaccess`, `command.execute` —
  granted at publish time via `appScopes`, applying only to the app's own
  Space.
- **Viewer grants** (consent-required): any permission the viewer holds, on
  any Space they choose — one grant per Space, valid 14 days, re-validated
  against the viewer's live access on every request. Includes scopes beyond
  the eight app scopes, such as `generation.create` and the account-level
  `user.*` scopes.

**They never substitute for each other's halves.** `session.prompt.fullaccess`
lets you send a prompt but does NOT let you read the reply — that needs
`session.view`. `generation.create` lets you create a generation task, but
polling its result needs `taskrun.view`.

Render grant state from `ctx.permissions.viewerGrants`; act through
`auth.authorize()` (silent when covered). `allowedViewerScopes` is deprecated —
viewer grants are no longer gated by the app configuration.

### Realtime rooms

App runtime rooms are generic, temporary event channels. The SDK does not
know the App's business events; define their names and payload types in the
App itself.

```ts
type Events = {
  "shared.state.updated": { value: number };
  "activity.submitted": { itemId: string };
};

const room = await client.app.realtime.createRoom<Events>({
  code: "TEAM-ALPHA", // optional; generated when omitted
  maxParticipants: 64,
  expiresInSeconds: 2 * 60 * 60,
});

const stop = room.subscribe("shared.state.updated", (event) => {
  console.log(event.sequence, event.data.value, event.self);
});

await room.publish("shared.state.updated", { value: 42 });
await room.setPresence({ status: "active" });
await room.leave();
stop();
```

`expiresInSeconds` is an absolute lifetime from server-side room creation. It
never extends on publish, presence, or heartbeat. The maximum lifetime is
24 hours. Room events are live and ordered while connected, with publish ACKs
and sequence-gap detection; events missed during a disconnect are not replayed.

For high-frequency traffic such as input frames, `room.send(type, data)` skips
the per-event ACK that would otherwise cap throughput at one round trip per
event; failures surface through `room.onSendError`. Every connection is its own
participant by default; create the room with `seatPerUser: true` to give each
viewer a single seat instead.

For the complete API-to-scope mapping, initialization recipe, capability
recipes, a full working example, and a pitfalls checklist, see the
**[App Runtime Guide](./docs/app-runtime-guide.md)**.
