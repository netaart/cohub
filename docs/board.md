# Board

A Board is one document with three collections: settings, items and animations.
Items can attach scripts for local interaction and procedural content; animations
drive properties by their JSON paths. See [Board scripts](board-scripts.md) for the
shared runtime used by native items and custom content.

```json
{
  "board": { "background": { "pattern": "dots" }, "grid": { "size": 24, "snap": true }, "enter": { "preset": "deal" } },
  "items": {
    "s3":   { "type": "frame", "position": { "x": 2160, "y": 0 }, "size": { "width": 960, "height": 540 }, "props": { "label": "Length contraction" } },
    "ship": { "type": "shape", "parent": "s3", "position": { "x": 120, "y": 240 }, "size": { "width": 192, "height": 48 }, "props": { "geometry": "rounded" }, "style": { "fill": "blue" } },
    "t3":   { "type": "text", "parent": "s3", "position": { "x": 72, "y": 60 }, "props": { "text": "Moving rulers get shorter", "fontSize": 40 } }
  },
  "animations": {
    "scene-3": {
      "duration": 7000,
      "tracks": {
        "ship-scale": { "target": "ship", "property": "scale", "keyframes": [{ "at": 1000, "value": 1 }, { "at": 6800, "value": { "x": 0.6, "y": 1 }, "ease": "ease-in-out" }] },
        "t3-reveal":  { "target": "t3", "property": "props.reveal", "keyframes": [{ "at": 0, "value": 0 }, { "at": 800, "value": 1 }] }
      }
    }
  }
}
```

## Items

Common fields: `type`, `parent`, `z`, `position`, `size`, `rotation` (degrees),
`scale`, `origin` (normalized transform origin, default center), `opacity`,
`style`, `props`, `locked`, `metadata`, optional `script` (`src`, `params`, `targets`, `seed`, `enabled`).

- `position` is relative to `parent`; a root item is in world space.
- Children inherit the parent's transform and opacity. Only `frame` items can be parents.
- Draw points and unbound arrow endpoints use item-local coordinates, transformed
  by the item's position and parent frame. Bound endpoints follow the referenced item.
  Shape paths are fitted to the shape's size.
- `z` orders siblings; a new item without `z` goes on top.
- `size` is authored for boxes (`frame`, `shape`, media, `task`, `session`, `effect`, `custom`)
  and derived for `text` (from `fontSize`, optional `props.width` wraps), `draw`
  (from points) and `arrow` (from endpoints).
- One unit is one CSS pixel at 100% zoom, and defaults share one reading scale: a
  slide is a 960×540 frame, media take a 480 long edge, cards keep their interface
  size, and text uses 56 / 40 / 24 / 16 for title, heading, body and caption.
  `boards schema` lists it under `scale`.
- `style`: `fill`, `fillOpacity`, `stroke`, `strokeWidth`, `dash`, `radius`, `trim`,
  and the effects below.
  A color is a palette token (`brand`, `neutral`, `blue`, …, follows the theme),
  any CSS color, or `{ "light": …, "dark": … }`.
- An image is drawn whole inside its box; `crop` picks the region to show, so a crop
  matching the box's aspect ratio fills it. A frame border follows `stroke`, `dash` and
  `trim`; without `stroke` it stays a quiet neutral outline.

| type | props |
|---|---|
| `frame` | `label`, `clip`, optional `decoration` (`frame` or `none`) |
| `text` | `text`, `fontSize`, `fontWeight`, `font`, `align`, `lineHeight`, `width`, `reveal`, `revealBy` (`char` `word` `line`), `revealMotion` (`cut` `fade` `rise`) |
| `shape` | `geometry` (`rectangle` `rounded` `ellipse` `diamond` `triangle` `path`), `path`, `text`, `fontSize`, `align` |
| `draw` | `points` (`{x, y, p}` relative to `position`) |
| `arrow` | `start`, `end` (a point, or `{ "item": id, "anchor"?, "port"? }`), `route`, `bend`, `waypoints`, `arrowStart`, `arrowEnd`, `label`, `fontSize`, `relation` |
| `image` `video` `audio` `file` | `src` (public HTTP(S) URL or relative Space file path), `crop` (image: `{x, y, w, h}` as 0–1 fractions of the source), `snapshot` (cached media facts), `origin` (media: `{ taskRunId, artifactId }` of the run that produced it) |
| `task` | `taskRunId`, `snapshot` (server-maintained; see [Tasks on Boards](#tasks-on-boards)) |
| `session` | `sessionId`, `snapshot` (server-maintained; see [Sessions on Boards](#sessions-on-boards)) |
| `effect` | `kind` (`particles` `trail` `impact` `flash` `glow`) and its parameters; `shape` (`circle` `square` `star` `heart` `spark`) and `colors` for particles and impacts |
| `custom` | empty; the common `script` attachment supplies drawing or native scene content |
| `vendor.kind` | any; an extension type, namespaced like `acme.order` |

An extension type is stored as written. A client that registers it (see
`defineBoardItem` in the SDK) checks its props on edit and draws it; any other
client shows a placeholder that still moves and keeps every field. Give the item a
`preview` so other clients, exports and agents can show and name it as a card:

```json
{ "type": "acme.order", "props": { "orderId": "o-1" }, "preview": { "title": "Order o-1", "excerpt": "Two lamps", "cover": "https://cdn.example.com/o-1.webp", "src": "orders/o-1.json" } }
```

`props` belong to the type; `preview` is Cohub's (`boards schema extension`). Keep it
current from the client that owns the type; `cover` and `src` follow the media source rules.

`board.background` stacks a `color`, an `image` (`src`, `fit`, `opacity`) and a `pattern` (`none`, `dots` or `grid`) spaced by `board.grid.size` board units. A layer left out follows the viewer's theme, and a color or image hides the theme's own decoration. Patterns keep their size on screen and merge as the view zooms out; exports draw only the color and image. `board.grid.snap` snaps moved and resized items to the grid. The Appearance panel edits all of them. Use `cohub boards schema effect` to see which parameters apply to each effect kind.

Deleting an item that is still referenced fails and lists the references; `cascade`
also deletes children and the tracks that target it. Arrows bound to a deleted item
keep their place and fall back to a point. Media sources must be a public HTTP(S)
URL without credentials or a relative Space path.

### Effects

Any item takes `style.filter`, `style.shadow` and `style.blend`, and every number and
color in them animates by path (`style.filter.blur`, `style.shadow.color`, …):

```json
{"style":{"filter":{"saturate":0,"blur":2},"shadow":{"color":"blue","blur":24,"y":0,"opacity":0.8},"blend":"multiply"}}
```

- `filter`: `blur` (board units, as CSS `blur()`), `brightness`, `contrast`, `saturate`,
  `hue` (degrees), `grayscale`, `sepia`, `invert`, applied in that order.
- `shadow`: `color` (black), `opacity` (0.35), `blur` (16, as CSS `drop-shadow()`), `x`,
  `y` (8). It follows the visible shape; with no offset and a bright color it glows.
- `blend`: `normal`, `multiply`, `screen` or `add`.
- On a frame they apply to the frame and its contents as one layer.
- `board.atmosphere` adds `vignette` and `grain` (0–1) over the whole view.
- For anything else, `board.scripts` attaches modules to the Board itself; their
  `shader` passes draw over or under every item, such as rain that splashes on cards.
  See [Board scripts](board-scripts.md#script-the-whole-board).

Exports draw all of them. Low-end devices skip blur and shadows and keep the rest.

### Media sources

Prefer an existing stable URL when adding media, including generation results:

```json
{ "items": { "cover": { "type": "image", "props": { "src": "https://cdn.example.com/cover.webp" } } } }
```

The same patch works through the API, SDK and `cohub boards apply`. For a URL
without an extension, set the item `type` explicitly. Optional `snapshot` facts
(title, MIME type, natural dimensions and duration) give an immediate preview.

Media without a recorded natural size take it once it is known, by one rule: the
size is recorded and the box takes the media's aspect ratio, keeping its long edge;
media stay centered and task cards keep their top-left corner. `cohub boards apply`
and `create` size the image and video items they create before writing, finished
tasks size their cards in the same write, and the app adopts what it learns while
showing a Board. `boards export` and `inspect` render with the same rule. Sizes come
from local files inside a sandbox and from Cohub's media hosts; the SDK exposes the
rule as `settleBoardMediaSizes`. Write `naturalWidth` and `naturalHeight` yourself to
keep a box exactly as written.
The Web editor supports pasting media URLs, dropping links, and **Add from link**
on desktop and mobile. Task cards offer **Add results to board**, which lays out
their media results as items that keep their URLs.

A `file` item whose source is a 3D model (`.glb`, `.gltf`, `.stl` or `.obj`) shows
a still of the model; its corner key, double-click or Enter opens an orbitable view
in place. glTF buffers and textures and OBJ materials resolve next to the model.
The Web editor renders stills only for cards on screen, one at a time, and leaves
models above 64 MB (16 MB on mobile) for the user to open. Other clients and
exports draw a placeholder.

A URL loads directly, without importing it into the Space. A Space path retains
live file updates and resolves through the Space file API. Existing paths are not
rewritten; temporary signed download URLs must not replace persistent paths.
Query parameters are part of the source and are retained.

Remote images and video thumbnails must support anonymous CORS for canvas
rendering and export. A load failure preserves the source and cached facts; use
**Open source** to inspect it. CLI image and audio downloads validate public DNS
addresses and redirects and enforce transfer limits. Existing export format
limitations still apply (including video-frame support).

Publishing captures Space file dependencies and lists remote references in
`externalUrls` in the artifact manifest. Dependencies are media sources, extension
`preview` covers and sources, script modules, and the files a model loads beside
itself: glTF buffers and images, and OBJ material libraries named in the first
megabyte with their textures. Remote media remains live and can change
or disappear; it is not an immutable captured asset. A published Board never
needs access to the original Space to resolve a URL. Automatic remote capture
and proxying are not part of this behavior.

A published Board browses like the editor without writing: pan, zoom, scripts,
animations and their playback bar, media and models in place, App cards, export, and a
menu to open, copy, focus or link. Files open as captured, and task cards open
their featured result. Each viewer's view is remembered on their device. A URL
fragment opens it at an item, a view or a moment of an animation:
`#focus=<itemId>`, `#view=<x>,<y>,<zoom>` (the world point at the center) or
`#play=<animationId>&t=<ms>`; **Copy link to this view** writes one.

### Tasks on Boards

A `task` item shows one run. Writers send only `props.taskRunId`; the server
reads the run and writes `props.snapshot` (status, prompt, failure reason,
start time and up to six results). A snapshot written by a client never wins
over the run, so history restores, pastes and duplicates cannot roll a task
back. Writing a run the author cannot view fails with `TASK_FORBIDDEN`; a run
in another Space keeps the snapshot written with it, so forked and copied
Boards stay as they were.

```sh
cohub generate "a calm lake at sunrise" -m <model> --async --json \
  | jq '{items:{hero:{type:"task",position:{x:80,y:80},size:{width:480,height:270},props:{taskRunId:.taskRunId}}}}' \
  | cohub boards apply plan.board -i -
```

When a run finishes, the worker writes its final snapshot onto every Board in
the run's Space that shows it, one version per Board, attributed to the task
(`source.via = "task"`). Items deleted meanwhile stay deleted. When the first
result is a sized image or video, the card takes its aspect ratio and keeps its
long edge, top-left corner in place; nearby content may be overlapped. Clients
draw "queued", "generating" and the elapsed time from realtime task events
without writing the document.

Results laid out from a card become ordinary media items that keep an
`origin` back to the run. The task detail lists the Boards that show a run.

### Sessions on Boards

A `session` item shows one chat. Writers send only `props.sessionId`; the server
reads the Session and writes `props.snapshot`: its title, latest message as plain
text, source, last activity, and whether the last run failed or was lost. As with
tasks, a snapshot written by a client never wins over the Session. Putting a
Session the author cannot view on a Board fails with `SESSION_FORBIDDEN`; a
Session from another Space keeps the snapshot written with it. A Session with its own
access policy may be hidden from the Board's readers, so its snapshot keeps only the
title, source and status.

```sh
jq -n --arg id "$COHUB_SESSION_ID" '{items:{chat:{type:"session",position:{x:80,y:80},props:{sessionId:$id}}}}' \
  | cohub boards apply plan.board -i -
```

Snapshots follow the Session lazily: changes gather for two minutes, then the
worker rewrites only the cards that are out of date, one version per Board,
attributed to the Session (`source.via = "session"`). Viewers in the Space do not
wait for it: their cards show the running state, latest message and unread dot
live from the same data as the Chats list, without writing the document.

In the web app, drag a chat from the sidebar onto a Board. Its card opens the
chat beside the Board, replies in place (a reply to a running chat queues, as in
the composer), stops a run, and selects what the chat changed on this Board.

### Plain containers

Use `props.decoration: "none"` on a frame to hide its title, border and background.
One position, scale or rotation track on the frame then moves its children together.
The frame remains selectable; clipping is independent of decoration. Set `clip: false`
when children may extend outside it. The web selection toolbar can toggle its appearance.

```json
{"items":{"train":{"type":"frame","props":{"decoration":"none","clip":false},"position":{"x":100,"y":200},"size":{"width":400,"height":180}},"body":{"type":"shape","parent":"train","size":{"width":400,"height":180}}}}
```

### Frames as pages

Top-level frames are the Board's pages. A plain container is a page too when it has a
`label`, named in the navigator and invisible on the canvas; an unnamed one is seen
through, so the frames inside it count. Frames nested in pages do not. Their
placement is their order: rows top to
bottom, each left to right, where a frame joins a row it overlaps by half the shorter
height. Nothing is stored for it, so moving a frame reorders the pages.

- **Frame view.** `N` and `Shift+N` step to the next and previous frame, from the one
  nearest the view; selecting a frame and focusing it (`Shift+2`) or double-clicking a
  read-only Board inside one also shows it. The arrow keys move in that direction when
  nothing is selected: left and right stay within a row and continue in reading order
  past its end; up and down reach the nearest frame above or below. A small navigator
  steps, maps every frame and closes; panning, zooming or `Escape` leave frame view.
- **Swipes.** On a read-only Board, a finger swipe in frame view moves to the frame
  in that direction, or settles back when short. Editable Boards keep touch panning.
- **Present.** Every other control hides, the frame fills the screen and everything
  around it is covered. A click, `Space` or `PageDown` moves on; a tap on the left third
  of a touch screen, `Shift+Space` or `PageUp` goes back; `Home` and `End` jump to the
  ends; swipes and arrows move by direction. Each frame cuts in, one at a time.
  `Escape` returns to the view before presenting.
- **Links.** `#focus=<frame>` opens framed, and `&present` presents from it (or from
  the first frame).

`cohub boards frames` lists the order and where each arrow leads. The SDK exposes the
order as `boardFrameRegions(scene)`, and `boardReadingOrder`, `boardRegionNeighbor` and
`boardRegionStep` for regions of any kind.

## Animations

An animation is a timeline: `duration`, `play` (`manual`, `auto`, `always`),
`delay`, `loop`, `end` (`hold`, `reset`), `markers`, `tracks`. A new animation
written without `duration` lasts until its last keyframe.

A track drives one property of one target:

- `target`: an item id, `camera`, a Board script id, or another animation id.
- `property`: the JSON path in the target (`position`, `position.x`, `opacity`,
  `style.fill`, `props.text`, …). Camera: `focus` (item id or rect), `zoom`, `shake`.
  Animation: `time` (nesting, speed, reverse and hold are all time remapping).
  Board script: `params.<name>`; numbers blend, colors mix and other values step.
- `keyframes`: `{ at, value, ease? }`. Easing defaults to linear; the destination
  keyframe's CSS easing controls the incoming segment. Before the first keyframe
  and after the last, the property holds its boundary value.
- `composite`: `replace` (default) or `add`. Adds sum positions and rotations and
  multiply scale and opacity. When several `replace` tracks drive the same property
  at once, the one that started later wins, then the lexicographically larger track ID.
  Before any start, the nearest upcoming track wins. Track keys have their own namespace:
  `camera` is a valid key, while `target: "camera"` addresses the animation camera.
- `interpolation`: `auto` (numbers, vectors and colors blend; text, booleans and
  ids step), `step`, or `spline` for smooth position paths; `orient` turns the item
  along the path.

A marker with `pause: true` stops playback there until `next`.

A `focus` track holds its current target until the next focus keyframe.
Use `boards schema track`, `boards schema animation` and `boards schema effect`
for field definitions and behavior.

### Edit in the web app

**Animation** (⇧A) docks a timeline under the Board, and a faint outline marks the
canvas while it is open. Rows group tracks by item, with the camera and nested
animations first; selected items also list position, rotation, scale and opacity.
◇ beside a property keys its shown value at the playhead, and moving an item while
its property is animated keys the change. **Auto key** keys every change instead.
Keyframes drag in time and snap to the playhead, markers and other keyframes (hold
Alt to skip snapping); drag across lanes to select several, and ⌘C/⌘V copies them to
the playhead. Selecting a keyframe edits its time, value and track interpolation;
selecting the segment between two keyframes edits its easing, including a
`cubic-bezier` curve. Double-click the ruler to add a marker. Animation settings set
the name, duration, delay, play mode, loop and end, and **Key current view** records
the camera. Viewers get a playback bar instead of the timeline.

### Compose chapters

Write each chapter's keyframes relative to its own start, then compile a sequence:

```json
{"chapters":[{"animation":"intro","frame":"cover","label":"Introduction","pause":true},{"animation":"experiment","frame":"lab","label":"Experiment","gap":300,"pause":true}]}
```

```sh
cohub boards sequence lesson.board --animation lecture -i boards/chapters.json > boards/lecture-patch.json
cohub boards apply lesson.board -i boards/lecture-patch.json --dry-run
cohub boards apply lesson.board -i boards/lecture-patch.json --base-version 12
```

`sequence` prints a patch without writing. It offsets source keyframes into an ordinary
parent timeline; source animations remain unchanged. Keep the chapter description and
recompile after changing durations or order. Recompiling the same parent removes stale
generated tracks.

- Each chapter must be a distinct manual animation without nested time tracks.
- Chapters cannot share an additive track's target property, including vector/component
  overlaps. Use distinct items or combine those tracks first.
- Optional, distinct frames control chapter visibility and supply the starting camera
  focus. Chapter camera tracks are retained and override that fallback when they start;
  without a frame, the helper does not infer chapter membership.
- Child markers are promoted. End pauses retain the outgoing chapter, with a 1 ms
  boundary before the next chapter.

The animation menu offers **Combine chapters**, ordering, frame selection and pauses.
Labeled markers provide local chapter navigation without seeking shared playback.
The SDK exposes `boardSequence` and `boardSequencePatch` for the same compilation.

### Sample paths

```json
{"points":[{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":300}],"duration":2000,"samples":64,"orient":true}
```

```sh
cohub boards path ship -i boards/path.json > boards/path-track.json
```

`boardPathTrack` / `boards path` returns a standard position track sampled by polyline
distance. Original vertices are retained so interpolation does not cut corners.
It creates no live dependency on another item. Use scripts for procedural
meshes, physics and specialized drawings.

## Reading

`get` reads the whole Board, or the part `only`, `items`, `animations`, `rect`,
`within` or `limit` names. A copy cached at a version passes `since` and gets the
Board's metadata with `changes`, every write after that version oldest first, to
apply in order with `applyBoardDelta`; `[]` when nothing changed. When the changes
are unavailable or too many, the read returns the whole Board without `changes`.
`board.sync(cached)` in the SDK does this in one call.

## Writing

`apply` is the only write. It takes a JSON Merge Patch of the document: fields you
write merge, `null` deletes, anything unmentioned stays. `replace` makes the
document equal to the input. Each apply is one transaction holding the before and
after state of every entity it changed, so history can be replayed and restored.
It also keeps the patch as it was reported — `replace` and `cascade` recorded as
`$replace` and `$cascade`, since they are directives rather than document values —
and a write that changed nothing records that patch alone. Versions are ordered
but not contiguous. Without `baseVersion` concurrent writers merge
field by field; with it a stale write fails.

## Export

Use `--frame`, `--items` or `--rect` for a fixed region, or `--camera` for the animation's
view at a specified time:

```sh
cohub boards export lesson.board --frame lab -o lab.png
cohub boards export lesson.board --animation lecture --at 10s --camera --size 1600x900 -o preview.png
cohub boards export lesson.board --animation lecture --at 1s,5s,9s --camera -o /tmp/preview-%d.png
cohub boards export lesson.board --animation lecture --at 0:30s:100ms --camera -o lesson.mp4
```

`--theme` picks any built-in Cohub theme (`dark`, `light`, `solarized-dark`,
`solarized-light`, `neta-studio`, `neta-pixel`, `neta-pixel-dark`), with its colors and
card style; exports use the app's fonts. Previews are drawn as the app shows them,
including video covers: Cohub-hosted media (OSS and Cloudflare R2) provide resized images
and video first frames, so only what the export needs is downloaded and decoded. The web
Board uses the same frames; videos elsewhere decode in the page there, and are drawn
without a cover in Node exports. Previews beyond the image memory budget (`--image-memory`) are drawn as
placeholders, with a warning.

Exports draw in Node until a script draws with a shader; then `--renderer auto` (the
default) renders every frame in a local Chrome, Chromium or Edge, headless and with
software WebGL where there is no GPU, so the result matches the web app. Set
`COHUB_CHROME` to pick the browser. `--renderer canvas` stays in Node and warns which
shaders fell back to `draw()` or were left out; `--renderer gpu` always uses the browser.

Camera and fixed region options are mutually exclusive. `--size` sets camera output
pixels and never sizes frames; `--scale` applies to fixed regions. In the web export
dialog, choose an animation and time, then **Follow camera**. Export does not change
shared playback.

Trails reconstruct recent target positions when seeking or exporting directly at a time.
`follow` applies to trails only; use a shared parent frame to move a particle emitter
with another item.

Image sequences are written one frame at a time. Video export checks ffmpeg first,
uses one document snapshot, stores frames on temporary disk, and publishes the encoded
result after success. Ctrl+C cancels work. Replacing an existing output requires
`--force`. Frame rate is inferred from the range step; an explicit `--fps` must agree,
and video times must be evenly spaced.

For batch rendering, reuse `createBoardRenderSampler(document, animation, theme)` from
`@neta-art/cohub/board/render` with `exportBoardImageBytes` or `renderBoardExport`;
`boardRenderTheme(id)` gives a built-in theme to spread into both.
It resolves theme tokens and CSS alpha consistently with rendering. Use
`createBoardAnimationSampler` for geometry sampling or with an explicit color resolver.
Caches are bounded and scoped to the document snapshot.

The CLI's `runBoardExport` accepts an asynchronous `onFrame(frame, index)` consumer
with backpressure, `signal` and `onProgress`. Contact sheets, reports and encoders can
consume frames without adding layout policies to the renderer. Images are selected
for the current viewport; sequence export releases textures that leave it.

## Inspect and measure

```sh
cohub boards inspect lesson.board --animation lecture --at 1s,5s,9s --json
cohub boards inspect lesson.board --items title,formula --json
```

Results include `mode` (`static` or `animation`) and the sampled times. Without
`--animation`, inspection uses the static document, not playback. Each item's
`bounds` is its world-space frame (`x/y` at the top left, independent of text
alignment); `worldBounds` is its axis-aligned box including rotation, and `opacity`
includes parents. `--items` filters measurements and relevant diagnostics.

The SDK's `inspectBoardItems` returns these measurements; `measureBoardText` uses
the rendering font stack and layout rules. `inspectBoardScene` reports possible
clipped or overlapping text, unavailable glyphs and unused `follow` parameters.
Checks have work/output limits; hints are advisory and never block saving. They
exclude camera cropping and content painted inside scripts. Font availability
affects measurements and glyph coverage; review exported images as well.

In the web export dialog, **Check layout** inspects the selected time. Select a hint
to locate its item. This is a local inspection, not a shared playback command.
