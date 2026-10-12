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

A Board is one document of `board` settings, `items` and `animations`. Bind
one with `space.board(boardId)`; every write is a JSON Merge Patch (`null`
deletes, unmentioned fields stay):

```ts
const created = await space.boards.create({
  path: "boards/plan.board",
  title: "Plan",
  document: {
    items: {
      goal: { type: "shape", position: { x: 80, y: 80 }, size: { width: 240, height: 120 }, props: { geometry: "rounded", text: "Ship" } },
    },
  },
});

const board = space.board(created.id);
const { items, version } = await board.get({ only: ["items"] });
await board.apply({ items: { goal: { props: { text: "Shipped" } } } }, { baseVersion: version });

const stop = board.subscribe({
  changed: (event) => console.log("version", event.payload.version),
  playback: (event) => console.log("playback", event.payload.playback?.status),
});
```

Task Items keep a small, replaceable display snapshot beside their stable
`taskRunId`; build it from an authoritative TaskRun with
`taskRunToBoardTaskSnapshot(taskRun)` from `@neta-art/cohub/board`, and restore
a Board's TaskRuns in one request with `client.tasks.getMany(ids, { spaceId })`.

### Layers

Board is layered by dependency, so each use pulls in only what it needs:

| Import | What it is | Needs |
|---|---|---|
| `@neta-art/cohub/board` | Document model, geometry, item types (`defineBoardItem`, `createBoardRegistry`), export planning | — |
| `@neta-art/cohub/board/replica` | A local copy kept in step with the server, with offline writes | — |
| `@neta-art/cohub/board/editor` | The editor engine: selection, tools, gestures, undo, camera | — |
| `@neta-art/cohub/board/player` | Animation playback | — |
| `@neta-art/cohub/board/render` | Canvas renderers for each item type | `pixi.js` |
| `@neta-art/cohub/board/stage` | An editor drawn into a DOM element, with input and DOM item views | `pixi.js` |
| `@neta-art/cohub/board/export` | Render a document to an image | `pixi.js` |
| `@neta-art/cohub/board/export/node` | The same in Node.js | `pixi.js`, `@napi-rs/canvas` |

`pixi.js` and `@napi-rs/canvas` are optional peers: HTTP-only installs, agents
and servers never load them.

### Embedding an editor

The editor has no framework. Read state through its getters and listen with
`subscribe(channel, listener)`; snapshots keep their identity until they
change, so they work directly with `useSyncExternalStore`:

```ts
import { createBoardRegistry, defineBoardItem } from "@neta-art/cohub/board";
import { createBoardEditor } from "@neta-art/cohub/board/editor";
import { createBoardReplica } from "@neta-art/cohub/board/replica";
import { createBoardAssetManager, mountBoardStage } from "@neta-art/cohub/board/stage";
import { z } from "zod";

// A business item type. The server stores extension props as they are; the
// schema is checked when the editor creates or edits one.
const order = defineBoardItem({
  type: "acme.order",
  props: z.object({ orderId: z.string(), status: z.enum(["open", "paid"]) }),
  size: { width: 320, height: 200 },
  capabilities: { canRotate: false },
});

const replica = createBoardReplica({ remote: space.board(boardId) });
await replica.start();

const editor = createBoardEditor({
  document: replica.state.document!,
  registry: createBoardRegistry([order]),
  key: boardId,
  onCommit: (patch) => replica.apply(patch),
});
replica.subscribe((state) => state.document && editor.loadDocument(state.document, boardId));

// Where Space file paths resolve; a published copy could resolve elsewhere.
const source = {
  resolveFileUrl: (path: string) => space.files.resolveUrl(path, { purpose: "preview" }),
  resolvePlaybackUrl: (path: string) => space.files.resolveUrl(path, { purpose: "playback" }),
};
const stage = mountBoardStage(element, {
  editor,
  source,
  assets: createBoardAssetManager({ resolveFileUrl: source.resolveFileUrl }),
  views: [{
    type: "acme.order",
    // Mount anything: a React root, a Vue app, plain DOM.
    mount: (target, item, context) => {
      const root = createRoot(target);
      const render = (next = item, ctx = context) => root.render(<OrderCard item={next} selected={ctx.selected} />);
      render();
      return { update: render, destroy: () => root.unmount() };
    },
  }],
});

editor.addItem("acme.order", { at: editor.viewCenter(), props: { orderId: "o-1", status: "open" } });

// React: const selection = useSyncExternalStore((fn) => editor.subscribe("selection", fn), () => editor.selection);
```

Items of a type the client does not know still render as a placeholder, move
and keep every field, so documents written by newer clients are never
rewritten by older ones. For a canvas look instead of DOM, pass renderers to
`createBoardCardRendererResolver` from `board/render` and hand the result to
the stage or to `renderBoardExport` as `renderers`.

### Images

In the browser, `renderBoardExport(renderer, document, options)` from
`board/export` draws with the page's renderer (`stage.renderer`). In Node.js:

```ts
import { createNodeBoardRenderer, exportBoardImageBytes } from "@neta-art/cohub/board/export/node";

const renderer = await createNodeBoardRenderer();
const result = exportBoardImageBytes(renderer, document, { format: "png", scale: 2 });
```

Text metrics follow the same split. The renderers measure through a real canvas
and set that up themselves. Called straight off `@neta-art/cohub/board` with no
renderer in play, `measureBoardText` returns a per-character estimate — fine
for laying out a board on a server; call `installBoardTextMeasurement` from
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
