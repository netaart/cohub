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

Override endpoints for self-hosted deployments or proxies:

```ts
const client = createCohubClient({
  baseUrl: "https://api.example.com",
  webBaseUrl: "https://cohub.example.com",
  getAccessToken: async () => localStorage.getItem("token"),
  websocket: {
    url: "https://gateway.example.com",
  },
  voice: {
    url: "https://gateway.example.com",
  },
});
```

In Node.js, the SDK and CLI share these optional environment variables:

| Variable | Endpoint |
| --- | --- |
| `COHUB_BASE_URL` | API base URL |
| `COHUB_WS_URL` | Realtime gateway URL (`http(s)` or `ws(s)`; `/ws` is added when omitted) |
| `COHUB_WEB_URL` | Web origin for App authorization and CLI links |
| `COHUB_VOICE_WS_URL` | Voice input gateway URL; falls back to `COHUB_WS_URL` with `/asr/ws` |

Explicit client options take precedence over environment variables. Unconfigured
endpoints use the selected environment's defaults. API, web, and gateway addresses
are configured separately; changing `baseUrl` does not change the gateway.

```bash
COHUB_BASE_URL=http://localhost:3000 COHUB_WS_URL=ws://localhost:8080 node app.js
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

const board = space.board(created.id); // or await space.boards.open("boards/plan.board")
const { items, version } = await board.get({ only: ["items"] });
await board.apply({ items: { goal: { props: { text: "Shipped" } } } }, { baseVersion: version });

const stop = board.subscribe({
  changed: (event) => console.log("version", event.payload.version),
  playback: (event) => console.log("playback", event.payload.playback?.status),
});
```

Task Items show a run by its `taskRunId`. Write only the id; the server fills
the display snapshot from the run and rewrites it when the run finishes, on
every Board in the Space that shows it. Lay a run's results out as media with
`createTaskResultItems`; each result keeps an `origin` leading back to the run.

```ts
const { taskRunId } = await client.generations.create({ spaceId, model, content });
await board.apply({ items: { hero: { type: "task", position: { x: 80, y: 80 }, size: { width: 480, height: 270 }, props: { taskRunId } } } });
```

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
import { createBoardRegistry, defineBoardItem, worldPoint } from "@neta-art/cohub/board";
import { createBoardEditor } from "@neta-art/cohub/board/editor";
import { createBoardReplica, createIndexedDbBoardReplicaStorage } from "@neta-art/cohub/board/replica";
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

// Cached documents and unsent writes survive a reload; clear them on sign-out
// with `clearBoardReplicaStorage({ userKey })`. The replica reads the Board again
// after a realtime reconnect and resends pending writes when the network returns.
const replica = createBoardReplica({
  remote: space.board(boardId),
  storage: createIndexedDbBoardReplicaStorage({ userKey, spaceId: space.id, boardId }),
});
await replica.start();

const editor = createBoardEditor({
  document: replica.state.document!,
  registry: createBoardRegistry([order]),
  key: boardId,
  onCommit: (patch) => replica.apply(patch),
});
replica.subscribe((state) => state.document && editor.loadDocument(state.document, boardId));

// Prefer stable media URLs. Existing Space paths remain supported by addFile.
editor.addMedia("https://cdn.example.com/cover.webp", worldPoint(0, 0));
// Supply a kind for sources without a file extension.
editor.addMedia("https://cdn.example.com/media?id=42", worldPoint(400, 0), {
  kind: "video",
  snapshot: { title: "Launch", naturalWidth: 1920, naturalHeight: 1080 },
});

// Media URLs load directly; these callbacks only receive Space paths.
// A published copy can resolve paths against captured artifacts instead.
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

For draggable DOM item views, use `createBoardPointerGestures(element, { move, end })`
from `board/stage`: call `start(event)` for accepted pointer downs and `cancel()`
on unmount. It follows active pointers outside the element, preserves mouse gestures
when capture is lost, and cancels on window blur or page hide. Forward events through
`context.toPointerEvent` to the editor; keep hover handling separate from active gestures.

Items of a type the client does not know still render as a placeholder, move
and keep every field, so documents written by newer clients are never
rewritten by older ones. For a canvas look instead of DOM, pass renderers to
`createBoardCardRendererResolver` from `board/render` and hand the result to
the stage or to `renderBoardExport` as `renderers`.

### Hosting a Board

Compose the SDK instead of wrapping it, and each release's loading, level of
detail and text work reaches your Board without code changes.

Pictures your own items show go through `itemAsset`. They share the built-in
loader: CDN variants sized to the screen, loads ordered by where the view is
heading, prefetch, compact copies when panned away, device budgets, one cache
and exports. `src` is a Space path, resolved like an image item's, or a URL;
`fit: "cover"` sizes pictures cropped to fill their box by the short edge. Call
`invalidateItemAssets()` when the data it reads changes, and `invalidatePath`
when a file changes:

```ts
const assets = createBoardAssetManager({
  resolveFileUrl: source.resolveFileUrl,
  // undefined keeps the built-in rule; null shows no picture.
  itemAsset: (item) => {
    if (item.type !== "acme.order") return undefined;
    const cover = covers.get(item.props.orderId as string); // "orders/o-1.webp"
    return cover ? { src: cover, fit: "cover" } : null;
  },
});
```

- **Budgets.** Leave `lod`, `prefetch`, `concurrency` and `lruBudget` unset; they
  follow `defaultBoardDeviceBudget()`. Force a tier with
  `boardDeviceBudget(readBoardDeviceSignals(), "low")`.
- **Canvas cards.** Declare `lod` (`{ kind: "media" }` for pictures) and
  `renderFar`, drawn with `drawFarPlate(graphics, item.frame, { fill:
  farPictureTone(item, context) ?? paper })`. Wrap card text with
  `layoutTextLines(text, font, width, { whiteSpace: "normal", maxLines: 2 })`
  and apply `context.textResolution` in the `resolution` hook.
- **Opening cards.** Give a type `activation: "tap"` and handle `onActivate`: a
  quick press opens the card without selecting it, a drag moves it (or pans with
  the hand tool or read-only), and hovering shows a pointer instead of ports. A
  press held in place past `BOARD_TAP_MAX_MS` does nothing: it was a pick-up. A
  press on a selected card reports `selected: true`. `onLongPress` fires for a still
  touch or pen; call `editor.pickUp()` there to pick the card up and drag it. The
  stage drops the click a touch screen sends after a tap that opened something.
- **Card keys.** A renderer's `hitAt(item, point, context)` returns `{ action, cursor? }`
  for keys it draws; the stage shows the cursor, passes the hovered key to renderers as
  `context.hoveredHit` and sends presses to `onHit` (return `false` to let the editor
  have them). Media cards report `BOARD_PLAY_MEDIA` this way. `handlesHit(item, action)`
  names the keys you act on; the rest show no cursor and go to the editor.
- **Touch.** A touch on the selected item drags it, never a port. Pass
  `touchRotation: false` to `createBoardEditor` to move and resize by touch and pen
  without a rotation handle.
- **DOM views.** `viewLayer: "below"` puts them under the canvas, so selection and
  strokes draw over them; views there get no input. Use a theme with `imageBackground`
  and paint the Board background behind the host, or the canvas covers them.
- **Previews.** Write `preview: { title, excerpt, cover, src }` on your items so
  clients without your renderer, exports and agents show them as cards. Keep it out
  of undo with `editor.commitPatch(patch, { record: false })`.
- **Text editing.** Place the in-place editor with `boardTextEditLayout`, so its
  caret sits on the canvas text:

  ```ts
  const layout = boardTextEditLayout(item, { viewport: editor.camera, scene: editor.scene, style: stage.theme.style, draft });
  // A content-box textarea at layout.left/top, sized layout.width × height, padded by
  // layout.padding, with `rotate(${layout.rotation}deg) scale(${layout.scale})` about its center.
  ```

- **Themes.** Start from a built-in theme and override what differs:
  `{ key: "neta-pixel", ...boardRenderTheme("neta-pixel") }`. `style.frameLabelSize`
  sets frame titles; the editor's title hit box and text editor follow it.
- **Fonts.** Board text measures in `"Geist Variable"`; load
  `@fontsource-variable/geist` so lines match the CLI export.
- **Agent context.** `onViewStateChange` on the editor reports `visibleRect` and
  `selectedNodes`; send them with a prompt as
  `buildViewportContentBlock([{ kind: "board", path, boardId, visibleRect, selectedNodes }])`
  so the agent knows which Board, where and what the user is looking at.
- **Measuring.** `runBoardStageBench(stage)` drives the stage with wheel input and
  reports frame and settle times; `stage.stats()` shows live, far and texture counts.

Release notes for Board changes end with `Hosts:`, naming what an embedding app
must change, or `Hosts: no action`.

### Images

In the browser, `renderBoardExport(renderer, document, options)` from
`board/export` draws with the page's renderer (`stage.renderer`). In Node.js:

```ts
import { createNodeBoardRenderer, exportBoardImageBytes } from "@neta-art/cohub/board/export/node";

const renderer = await createNodeBoardRenderer();
const result = exportBoardImageBytes(renderer, document, { format: "png", scale: 2 });
```

Text layout follows the same split. The renderers measure through a real canvas
and break lines where the browser breaks them in a `<textarea>`
(`white-space: pre-wrap; overflow-wrap: break-word`), so canvas, editor and
selection agree. Called straight off `@neta-art/cohub/board` with no renderer in
play, `layoutBoardText` estimates widths per character — fine for laying out a
board on a server; call `installBoardTextMeasurement` from `board/render` first
if the lines have to match what the editor draws. In a browser, call it again
when a web font Board text uses finishes loading (the stage does this itself).

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

## Space wallets

```ts
const wallet = client.space(spaceId).wallet;
const balance = await wallet.get();
const catalog = await wallet.catalog();
const activity = await wallet.activities(1);
const { checkout, orderId } = await wallet.createOrder({
  id: crypto.randomUUID(), // Persist and reuse this ID when retrying.
  productKey,
});
const confirmation = await wallet.confirmOrder(orderId);
```

Open `checkout.checkoutUrl` to pay. Confirmation requires the contributor's
session; a payment redirect is not proof of settlement. Space funds pay whole
usage charges when sufficient, otherwise the original user's balance is used.
Personal balance transfers and withdrawals are not supported.

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
