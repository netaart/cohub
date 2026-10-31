# Board

How the Board code is organized, for people changing it. The document format
itself is described in [`docs/board.md`](../../../../docs/board.md); the public
API in the [SDK README](../../README.md#boards).

## Layers

Each directory is one layer and one subpath. A layer imports only the layers
below it; `tests/board/layers.test.ts` fails on anything else.

```
testing  ──► stage, export/node, editor     (headless scripts on Node)
client   ──► replica, model                 (space.board(id), part of the root entry)
stage    ──► editor, player, render, model  (pixi.js, DOM)
export/node ──► export ──► render ──► model (pixi.js; export/node adds Node.js)
editor   ──► model                          (no framework, no pixi.js)
replica  ──► model
player   ──► model
model    ──► @cohub/protocol                (runs anywhere)
```

| Layer | Owns |
|---|---|
| `model` | Document helpers, geometry, scene, animation, item definitions and factories |
| `replica` | The local copy of a Board: pending writes, remote merge, retry |
| `editor` | Everything a user does to a Board, minus pixels |
| `player` | Playback frames and timing |
| `render` | One canvas renderer per item type |
| `stage` | The PixiJS scene, textures, input and DOM views for a live editor |
| `export` | Images of a document, given a renderer |
| `client` | HTTP and realtime transport; the only layer that knows about Spaces |

Cohub's own UI (toolbars, menus, i18n, generation, collaboration cursors) stays
in `apps/web` and talks to these layers through their public entries. Anything
that must line up with canvas pixels (editor boxes, label geometry, overlays on
a card) is computed here and shared with the renderers, never in a component:
other hosts embed the same canvas, and a copy drifts on the next change.

## The editor

`editor/editor.ts` assembles the editor from one module per concern, sharing an
`EditorContext` (`editor/context.ts`):

| Module | Concern |
|---|---|
| `document` | Base document → animation → local script effects → gesture draft → scene; commit, undo |
| `query` | Hit tests, bounds, spatial index, tree walks |
| `camera` | Viewport, zoom, focus, eased and flung motion |
| `selection` | Selection and edits applied to it |
| `creation` | New items, text editing |
| `deletion`, `copy` | Removing, duplicating, clipboard |
| `interaction` | The pointer state machine (see Input) |
| `animation` | Playhead and keyframes |
| `snapshots` | Facts learned outside the document (file metadata, media sizes, task progress) |
| `remote` | Documents arriving from the server |

State lives in `state` fields grouped into channels (`STATE_CHANNELS`).
Assigning a field announces its channel; never mutate a value in place —
replace it, so views can compare by identity. Derived values use `memo` for the
same reason.

## Look

A renderer reads colors from `BoardRenderPalette` and everything else a theme
may change from `BoardRenderStyle` (`render/style.ts`): card silhouette, radius,
shadow, selection chrome, framed media, progress, icons, motion and chrome font.
Cards draw their body through `render/surface.ts`, so one silhouette and one
shadow serve every card type, and short facts above a card through
`render/card-tag.ts`. Selection and hover are not drawn by cards: the stage
overlay (`stage/overlay.ts`) owns them, so pointer and selection changes redraw
one layer. A renderer that still needs them sets `observesSelection`.

Under the items lies the backdrop. `resolveBoardBackdrop` (`render/backdrop.ts`)
merges the document's `background` over the theme's `backdrop` into one color,
image and pattern; the stage clears to the color and `render/backdrop-layer.ts`
draws the rest in screen space. Patterns are one full-screen shader: two levels a
doubling apart, the finer fading in, dots snapped to device pixels, so nothing
moves or shimmers as the view zooms or pans. Exports reuse the layer for the image.

Frame titles take `style.frameLabelSize`; their offset and the editor's title hit
box derive from it in `model/text-metrics.ts`, so renderer, editor and in-place
editor agree. Cache keys include `context.themeKey` rather than individual palette fields.
Zoom-dependent detail flips on `boardCardDetailed`, true while card body text is
legible; anything that must track every zoom step uses the renderer's `zoom`
hook and only touches transforms there. The `resolution` hook runs when the zoom
bucket or `context.textResolution` changes; refresh text textures and
bucket-dependent detail there instead of invalidating every renderer. The scene
spreads these refreshes over frames, nearest to the viewport center first.

## Level of detail

A card stays live while it is legible on screen, not while few cards are in view.
`BoardLod` sets the thresholds in CSS pixels: a renderer's `lod.kind` picks one
(`media` for long edges of pictures, `text` for font size, `card` otherwise), and
`lod.size` measures the item in world units. Cards below their threshold, with
hysteresis, draw through `renderFar` onto far plates: one `Graphics` per z-order
chunk, drawn at that chunk's depth and repainted only when its cards change.
Text draws its lines as bars, and pictures as their average color once loaded
(`farPictureTone`): the asset manager reads it while idle and keeps it after the
texture leaves, and the stage repaints only the plates showing it. Beyond
`BoardLod.live`, the on-screen cards nearest the view center stay live; pinned
cards and cards without `renderFar` are always live. Live cards outside the
screen skip rendering. Pass `lod` to `mountBoardStage`.

## Frames and devices

Every update runs in one animation frame callback (`requestFrame` in
`stage/stage.ts`): resize, sync or scripts, card ticks, then render, so input
reaches the screen in the frame it was handled. Work requested during a frame
waits for the next one.

Materializing cards, painting far plates and refreshing text resolution are
deferred work, spread over frames by `stage/frame-budget.ts`. Each kind learns its
main-thread cost per unit and takes what fits a share of the measured display
interval, smaller while the view moves; it grows at most twofold per frame, halves
when frames arrive late while the view moves, and always keeps an eighth of the
initial batch so work finishes. Fast devices settle in a few frames, slow ones keep
their frame rate. Scenes synced without a budget use the initial batch every frame.

`defaultBoardDeviceBudget()` in `stage/device.ts` turns what the browser reveals
(a touch-first small screen, memory, cores, Save-Data) into a tier with a live budget,
cooling pool, load concurrency and prefetch margin; stages and asset managers default
to it. Phones that report nothing stay low, since iOS reports nothing and kills tabs
early. Memory and cores say nothing about the GPU, so no tier raises the live budget.

Multisampling is off from 3× density, where it no longer shows and costs the most.

Display density never changes CSS geometry or document coordinates. The canvas
fills its host, and its backing store matches the device-pixel content box, so
fractional display scaling composites without resampling. Density is capped at
3× and a 10-megapixel budget that still fits a 4K screen.

Text is a bitmap, sharp only when one texel lands on one device pixel.
`context.textResolution` is that density in texels per world unit. While the
camera moves, it stays put within a small tolerance and otherwise steps by powers
of two; once the camera rests it becomes exact. Pass it, times any extra scale on
the label, to `syncTextResolution`, which also bounds the texture edge.
Inactive stages defer resizing until reactivation.

## Resources

Holding a texture is the demand signal. The scene calls
`context.acquireTexture(key, item)` only for live cards, so far-covered cards never
resolve, download or decode media. File URLs resolve outside the texture slots, so a
slow lookup never blocks a texture that is ready; a retry passes `{ fresh: true }` to
`resolveFile`, because the cached URL may be what failed. Readiness, failure and
invalidation notify with the resource key, and the stage refreshes only the cards that
hold it, a bounded number of texture pixels per frame; pictures that arrive after their
card fade in. Natural media sizes are recorded once per frame after scene synchronization.
`onLiveChange` reports the live set for other per-card work such as file previews.

Hosts add pictures for their own items through `itemAsset`, which maps an item to
the same `file:` and `url:` keys built-in cards use, so they share every rule below.
A `cover:` prefix sizes a picture cropped to fill its box by its short edge. Queued
loads start nearest a focus just ahead of a pan. Textures hold the size drawn: CDN
variants above `BOARD_THUMBNAIL_EDGE`, a local downscale below it, and originals without
variants decode straight to that size, so no new CDN sizes are requested.
Released textures cool in an LRU pool trimmed once the camera rests; over budget, the
oldest pictures shrink to small copies a few at a time, and only leave when those copies
still do not fit, so returning shows them at once and sharpens.

A resting camera warms the pictures of cards that would be live within `prefetch`
viewports beyond the cull margin, nearest first, at background task priority.
`assets.prefetch` keeps them in the cooling pool without holding them: only as many as
fit half the pool at the size they would load, never originals, two at a time with a
slot left for cards, and only while no card waits. Requests the view left are dropped,
and a failed prefetch is not tried again until a card holds it.

## Input

`editor/input.ts` holds every threshold (`BOARD_INPUT`): a press becomes a drag past
4 CSS pixels for a mouse and 8 for touch and pen, and nothing is written before that
or when a drag lands where it began. `editor/interaction.ts` decides what a press
means; the stage adds what needs the DOM.

**What a press acts on** (`query.pickAt`), first match wins: selection handles, arrow
handles and connection ports, card keys, then the topmost item. Locked items are
blank. A frame with children is picked by its title; a press inside it marquees its
children. Touch and pen also reach an item within `touchHitSlop` of its box.

**Editing, select tool** (Figma). A press selects an unselected item and drags the
selection. A click on one of several selected items narrows to it on release, and a
shift-click on a selected item removes it on release, so either can still drag the
group; the gap inside a multiple selection drags it too. A drag over a frame names it
`dropTargetId` and drops into it. Escape (`cancelPointerInteraction`) puts a drag back.

**Browsing** (read-only, the hand tool, touch). A drag pans, over items too. A tap opens
an item whose activation is `tap` (`{ readonly: "tap" }` for media, files and tasks) or
selects it. Touch browses with the hand: a tap selects and arms the select tool, a touch
away from the selection drops it and returns to the hand, and a select tool the host set
keeps one marquee. A long press lifts the item (`pickUp`) for the same finger to move;
released in place, or on empty space, it asks for the context menu. A second finger
lands the drag so far, then pinches; lifting one finger of a pinch keeps panning. A
released touch pan glides (`camera.fling`), and a touch that catches it is no tap.

**Frame view** (`editor/frames.ts`). Showing a frame sets `frameView`; a pan, zoom or
host camera call ends it, through `camera.setCamera` and the wheel paths, while
`camera.show` moves without ending it. A finger on a read-only Board and every pointer
in a presentation hold the frame: the pan follows, and on release `swipe` moves on past
`BOARD_INPUT.swipeDistance` or `swipeVelocity`, or settles back. A presentation also
blocks wheel and pinch (a pinch settles back), taps step, and nothing selects or edits.
Regions are recomputed only when a navigable frame's scene item changes, so ordinary
edits and camera moves cost one walk over the top-level items. A presentation
moves without animating, and the stage masks everything outside the shown frame,
clipping DOM views to the same rect.

**Stage.** Card keys from `BoardCardRenderer.hitAt` act on release; a drag that starts on
one moves the card. Touch double taps and two- or three-finger taps (undo, redo) are
recognized in `stage/presses.ts`, and the click a touch screen sends after a tap that
opened something is dropped. `stage/wheel.ts` reads each wheel stream once: a coarse
first step is a mouse wheel and eases, anything else follows the fingers; ctrl or cmd
zooms, Safari's gesture events pinch, and pans just after a pinch are dropped. A stream
that began in a scrollable DOM view scrolls it until it reaches its end.
`stage/auto-pan.ts` pans toward the edge a drag presses against, by time, and the editor
replays the pointer after every camera move so a dragged item stays under it.

**Keys.** `editor/keymap.ts` maps keys to commands with Figma's bindings and runs the
editor's own; hosts perform clipboard, export and open.

## DOM views

The stage owns world-space position, size and rotation. A single camera container
translates and scales all views. Render content in ordinary CSS pixels at the item's
world size: do not multiply dimensions by zoom or apply an additional camera transform.
Screen-fixed controls belong in the overlay, outside the camera container.
`viewLayer: "below"` stacks the views under the canvas for hosts whose DOM views only
stand in for canvas drawing; they then get no pointer input, and the stage must be
`transparent` so the canvas leaves them visible. A view that takes input, such as an
embedded page, should do so only while `context.entered` (the host set
`editor.enteredId`): until then presses select and drag the card like any other. A
press elsewhere or Escape leaves it, and unlike text editing it holds no remote update.

**Drawn views.** Where the browser supports HTML-in-Canvas (`stage/view-surface.ts`, the
only file that touches it), a view that calls `context.setDrawable(true)` moves into a
`<canvas layoutsubtree>` in its place. The content still lays out, takes input and stays
accessible there, but the canvas shows nothing: on each `paint` it draws the content,
copies it into a texture and clears. The scene puts the texture on top of the item's card
(`scene.syncViews`), so the view takes the card's z-order, clip, opacity, animation and the
presentation mask, and exports draw it through `viewTextures`, at its on-screen resolution
and only while it is drawn. A texture that leaves `views.textures` is destroyed at the start
of the next sync, which then calls `scene.syncViews` before it renders.

Only what the page may read is drawn: cross-origin frames stay blank and images need
CORS. A view allows drawing only while it shows neither, and requests its images with
`crossorigin` whenever it may be drawn (`context.canDraw`), so a switch never reloads them.
Low-tier devices and Save-Data skip drawing (`BoardDeviceBudget.drawViews`), and hosts can
turn it off with the stage's `drawViews`. Switching moves the view's element to another node, which drops focus and
reloads frames inside it. A canvas is its own compositing layer, so a drawable
view keeps one only while its card is live and the view detailed; otherwise it is hidden
and the card stands in. Rasters follow `boardBitmapResolution` of the text resolution,
like script bitmaps, and share a 4 ms budget per frame. Elsewhere, or once drawing fails,
views stay DOM over the canvas.

Embedded pages are expensive: show a static cover (`BoardAppMetadata.cover`) and run
the page only when the user asks, keeping that choice in the session, not the document.

A view may declare `contentSize: { width: 180, height: 120 }` in screen pixels and
render expensive content only when `context.detailed` is true. The stage adds
hysteresis and retains focused content and active pointer streams. Camera movement
alone does not call `update`; item, selection and detail changes do. Continue using
`context.toPointerEvent` for input conversion. Offscreen inactive views are destroyed;
iframe state is not automatically persisted. Stage input conversion handles ancestor
CSS `transform`, `rotate`, `scale` and `zoom` in 2D. Custom DOM integrations can pass the
host element to `toBoardPointerEvent`, or use `elementClientToLocal` from
`@neta-art/cohub/board` for client-to-padding-box coordinates.

Migration: replace `context.zoom` and `--board-zoom` layout calculations with world
sizes; use `contentSize` / `context.detailed` for LOD. `BoardScriptHost.frame` is a
texture read and no longer accepts the previously ignored resolution argument.

## Scripts

The public authoring contract is in [`docs/board-scripts.md`](../../../../docs/board-scripts.md).
`model/script.ts` defines the module context; `model/script-scene.ts` validates scope
and composes local effects. `render/script-runtime.ts` is a self-contained kernel,
serialized into browser workers and Node VM workers so execution semantics do not
drift. Keep it free of imported runtime values and bundler-only helpers.

`render/script-modules.ts` resolves the ESM graph before code enters an isolated
realm. Browser hosting lives in `render/script-host.ts`; Node hosting (export
samples and the interactive runtime) in `export/node/scripts.ts`. Everything
between the editor and a host that needs no DOM lives in
`stage/script-controller.ts`: host lifecycle, observed events (`change`, `gesture`,
selection, view, transforms), input routing, commit routing
(`stage/script-commits.ts`) and composition. The stage and `testing` drive the same
controller, so the headless harness routes input and commits exactly like the app.
Script subscriptions, source loading, errors and lifecycle belong to the host, not
item renderers: culling a renderer must not reset an instance. Static scripts
schedule no idle animation frames. One opaque broker iframe runs a pool of workers
shared by every instance (each instance imports its own module URLs, so module state
stays isolated), watches them for hangs and never executes user modules. DOM
`mount()` exports are rejected. The broker stamps routing tokens after worker data
so scripts cannot impersonate another instance. Output validation compiles only changed
instances; the stage composes them once per frame. Texture revisions invalidate
only their own card. Spatially hidden or far-covered draws are omitted while simulation
continues. The stage queries actual Scene materialization after scene synchronization;
it does not maintain a second LOD state. Execution-only responses wake the script clock,
not the scene renderer. Static scripts redraw when rematerialized or when density changes.

Interactive bitmaps use quantized screen-pixel demand, including item scale and DPR,
with hysteresis, a 2048-pixel edge limit and a 2-megapixel budget per bitmap. Zoom
reuses existing textures until 120 ms after the last zoom change. Export hosts are
independent of interactive visibility and settling. `draw()` must only render current
state: it can be omitted or repeated and must not advance business state or issue
persistent effects. Use frame/event handlers for those operations.

Boards without enabled scripts do not create a script host, message listener, DOM
layer, iframe or worker. The stage bypasses script clocks, composition and hit tests;
CLI exports reuse the native export preparation. `model/script-index.ts` shares a
single discovery scan per immutable item collection across editor, UI and hosts.
The module parser loads only when a script is actually read. Removing the last
enabled script destroys its host and clears local output without interrupting an
editor-owned pointer gesture.

Node export uses at most four persistent workers, with a separate module graph and
VM context per instance. Sequential samples advance the same state, while backwards
seeks recreate the affected instance. Clearing output textures does not reset the
simulation or reload modules.

Temporary items are absent from editor selection, clipboard subtrees and writes.
Explicit commits reuse the normal transaction and undo path. Future host capabilities
extend the context without adding business-specific fields to Board items.

## Adding an item type

1. Define it in `model/items/builtin.ts` with `defineBoardItem`: capabilities,
   and `hitTest`/`bounds` if the frame is too coarse. Extension types
   (`vendor.kind`) need no protocol change; built-in types also need a schema
   in `@cohub/protocol` (`board-model.ts`).
2. Give it a factory in `model/items/create.ts` if the default `registry.create`
   placement is not enough.
3. Draw it: a renderer in `render/renderers/`, listed in
   `board-renderer-registry.ts`, or a DOM view passed to the stage.
4. Cover it in `tests/board/`.

Never drop or rewrite fields of an item the client does not understand: write
patches with only what changed, and treat unknown types as plain boxes.
