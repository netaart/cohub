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

## Space files

`space.files.read(path)` and `space.files.resolve(path)` share requests: reads
made in the same task become one batched read, and concurrent reads of a file
share one request. In browsers with realtime, resolved URLs are remembered per
user across reloads, confirmed in the background and dropped when the file
changes; call `clearFileUrlCache()` on sign-out.

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

Keep a cached copy current with `sync`: one request that carries only the
changes since the cached version, or the whole Board when they are unavailable.
With `changed: false` the cached `document` is returned as is.

```ts
const { version, document, changed } = await board.sync(cached); // cached: { version, document } | null
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

// Media URLs load directly; Space paths resolve through the Space's file URLs,
// which reload pictures when their file changes. A published copy can resolve
// paths against captured artifacts instead.
const source = space.boards.assetSource();
const stage = mountBoardStage(element, {
  editor,
  source,
  assets: createBoardAssetManager(source),
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
`fit: "cover"` sizes pictures cropped to fill their box by the short edge. When
the data it reads changes for some items, call `invalidateItemAssets(ids)` and
`stage.invalidate({ items: ids })` (omit `ids` when everything changed); call
`invalidatePath` when a file changes:

```ts
const assets = createBoardAssetManager({
  resolveFile: source.resolveFile,
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
  press held in place past `BOARD_INPUT.tapMs` does nothing: it was a pick-up. A
  press on a selected card reports `selected: true`. Return `false` from `onActivate`
  to select the card instead. `{ readonly: "tap" }` opens only for viewers; built-in
  media, file and task items work that way. The stage drops the click a touch screen
  sends after a tap that opened something.
- **Card keys.** A renderer's `hitAt(item, point, context)` returns `{ action, cursor? }`
  for keys it draws; the stage shows the cursor, passes the hovered key to renderers as
  `context.hoveredHit` and sends clicks to `onHit` on release (return `false` to treat
  it as a press on the card); a drag that starts on a key moves the card. Media cards
  report `BOARD_PLAY_MEDIA` this way. `handlesHit(item, action)` names the keys you act
  on; the rest show no cursor and go to the editor.
- **Touch, menus and feedback.** Touch browses with the hand tool: a tap selects and
  switches to select, a touch away from the selection returns to the hand. A long press
  lifts the item for the same finger to move. `onContextMenu({ item, world, clientX,
  clientY })` answers a right click, a long press on empty space and a lifted item
  released in place; `onFeedback(kind)` marks `pickup`, `drop`, `menu`, `undo` and
  `redo` (two- and three-finger taps) for haptics or sound. Pass `touchRotation: false`
  to `createBoardEditor` to move and resize by touch and pen without a rotation handle.
- **Keys.** `handleBoardKeyDown(editor, event, host)` runs Figma's bindings (tools,
  history, nudge, `shift+0/1/2` and `+`/`-` zoom, Escape cancelling a drag first);
  `host(command)` performs `copy`, `cut`, `paste` and `export`, and sees every other
  command first: `open` (Enter) falls back to editing the selected item's text. Call
  `handleBoardKeyUp` for the space bar.
- **Thresholds.** `BOARD_INPUT` holds the drag slop, tap, long-press and wheel timings
  the stage uses; `src/board/README.md` describes every rule.
- **DOM views.** `viewLayer: "below"` puts them under the canvas, so selection and
  strokes draw over them; views there get no input. It needs `transparent: true`:
  the canvas then draws no backdrop, and the host paints `resolveBoardBackdrop(...)`
  behind it.
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
- **Backdrop.** A theme's `backdrop` is the Board's look until the document sets a
  color or image: a `pattern` (`{ kind: "dots", pitch: 24, color }`) and an `image`
  (`{ src, fit: "repeat", tile }`). The stage draws it on the GPU, patterns at a
  constant screen size that merge as the view zooms out, and reports the image's load
  through `onBackdropChange`. `resolveBoardBackdrop(settings, theme)` gives the result
  for previews and exports; the canvas is opaque unless `transparent` is set.
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

## Resumable uploads

Upload defaults can be set on either client, then overridden per operation:

```ts
const client = createCohubClient({
  upload: {
    multipart: "auto",
    multipartThresholdBytes: 16 * 1024 * 1024,
    partSizeBytes: 16 * 1024 * 1024,
    concurrency: 2,
    maxAttempts: 3,
    timeoutMs: 120_000,
  },
});
const task = client.publicAssets.createUploadTask({
  purpose: "chat_attachment",
  file,
  filename: file.name,
  mimeType: file.type || "application/octet-stream",
  upload: { concurrency: 4 },
});
const asset = await task.run({ onProgress: ({ ratio }) => console.log(ratio) });
```

The values above are the library defaults. Precedence is library defaults, client defaults, then operation overrides. `multipart` accepts `auto`, `always`, or `never`; `auto` uses multipart when the file exceeds `multipartThresholdBytes`, independently of `partSizeBytes`. Empty files use a single PUT. `maxAttempts` includes the first request; `timeoutMs: 0` disables SDK request timeouts. The same retry and timeout policy applies to planning, PUT, renewal, completion, and cancellation.

A prepared batch shares one immutable upload group across its file tasks and completion:

```ts
const files = client.space(spaceId).files;
const group = files.createUploadGroup({ concurrency: 4 });
const plan = await files.createUpload({ destination: { kind: "workspace" }, entries }, { upload: group });
await Promise.all(plan.entries.map((entry) =>
  files.createUploadTask(entry, sources[entry.id], { upload: group }).run(),
));
await files.completeUpload(plan.uploadId, {
  entries: plan.entries.map(({ id }) => ({ id })),
}, { upload: group });
```

Public files use the same `createUploadGroup`, `createUpload`, and `createUploadTask` pattern without the final workspace import. Groups are also available from `client.createUploadGroup()` and `client.publicAssets.createUploadGroup()`. Concurrency limits all transfer requests in one group, across all its files; independent groups have independent budgets. Passing an existing group preserves its configuration. A prepared task requires a group and rejects conflicting multipart modes or part sizes.

Retain a task and call `run()` again after a failure to reuse confirmed parts. Its configuration stays fixed; `run()` only accepts signal, progress, and fetch options. Aborting a run stops the transfer and preserves confirmed parts; `cancel()` discards the multipart session. Resume state is held in memory and is lost when the page or process exits. Signed part URLs renew within the server session's lifetime. Storage must expose `ETag` through CORS and expire abandoned multipart uploads.

Node clients can provide an `UploadSource` with `size`, `slice(start, end)` returning a `Blob`, and optional `validate()` to verify that the local file has not changed. This allows bounded range reads without loading the whole file.
