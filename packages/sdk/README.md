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

The App runtime APIs — `client.context()`, `client.auth.authorize()`, app
scopes and viewer grants, realtime rooms, callable surface, composer context,
commerce, and App Actions — are documented in one place:

**[App development](https://cohub.live/docs/developers/apps)**

Runtime APIs only work inside a published App; local pages get `null` from
`context()`.
