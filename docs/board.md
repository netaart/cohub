# Board

A Board is one document with three collections: settings, items and animations.
Items can attach scripts for local interaction and procedural content; animations
drive properties by their JSON paths. See [Board scripts](board-scripts.md) for the
shared runtime used by native items and custom content.

```json
{
  "board": { "background": { "kind": "dots" }, "grid": { "visible": true, "size": 24 }, "enter": { "preset": "deal" } },
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
- `size` is authored for boxes (`frame`, `shape`, media, `task`, `effect`, `custom`)
  and derived for `text` (from `fontSize`, optional `props.width` wraps), `draw`
  (from points) and `arrow` (from endpoints).
- One unit is one CSS pixel at 100% zoom, and defaults share one reading scale: a
  slide is a 960×540 frame, media take a 480 long edge, cards keep their interface
  size, and text uses 56 / 40 / 24 / 16 for title, heading, body and caption.
  `boards schema` lists it under `scale`.
- `style`: `fill`, `fillOpacity`, `stroke`, `strokeWidth`, `dash`, `radius`, `trim`.
  A color is a palette token (`brand`, `neutral`, `blue`, …, follows the theme),
  any CSS color, or `{ "light": …, "dark": … }`.
- An image is drawn whole inside its box; `crop` picks the region to show, so a crop
  matching the box's aspect ratio fills it. A frame border follows `stroke`, `dash` and
  `trim`; without `stroke` it stays a quiet neutral outline.

| type | props |
|---|---|
| `frame` | `label`, `clip`, optional `decoration` (`frame` or `none`) |
| `text` | `text`, `fontSize`, `fontWeight`, `font`, `align`, `lineHeight`, `width`, `reveal` |
| `shape` | `geometry` (`rectangle` `rounded` `ellipse` `diamond` `triangle` `path`), `path`, `text`, `fontSize`, `align` |
| `draw` | `points` (`{x, y, p}` relative to `position`) |
| `arrow` | `start`, `end` (a point, or `{ "item": id, "anchor"?, "port"? }`), `route`, `bend`, `waypoints`, `arrowStart`, `arrowEnd`, `label`, `fontSize`, `relation` |
| `image` `video` `audio` `file` | `src` (public HTTP(S) URL or relative Space file path), `crop` (image: `{x, y, w, h}` as 0–1 fractions of the source), `snapshot` (cached media facts), `origin` (media: `{ taskRunId, artifactId }` of the run that produced it) |
| `task` | `taskRunId`, `snapshot` (server-maintained; see [Tasks on Boards](#tasks-on-boards)) |
| `effect` | `kind` (`particles` `trail` `impact` `flash` `glow`) and its parameters |
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

Background pattern lives in `board.background.kind` (`dots` or `grid`); `board.grid.visible` toggles its overlay and `board.grid.size` sets spacing in board units. The Appearance panel edits all three. Use `cohub boards schema effect` to see which parameters apply to each effect kind.

Deleting an item that is still referenced fails and lists the references; `cascade`
also deletes children and the tracks that target it. Arrows bound to a deleted item
keep their place and fall back to a point. Media sources must be a public HTTP(S)
URL without credentials or a relative Space path.

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
`externalUrls` in the artifact manifest. Remote media remains live and can change
or disappear; it is not an immutable captured asset. A published Board never
needs access to the original Space to resolve a URL. Automatic remote capture
and proxying are not part of this behavior.

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

### Plain containers

Use `props.decoration: "none"` on a frame to hide its title, border and background.
One position, scale or rotation track on the frame then moves its children together.
The frame remains selectable; clipping is independent of decoration. Set `clip: false`
when children may extend outside it. The web selection toolbar can toggle its appearance.

```json
{"items":{"train":{"type":"frame","props":{"decoration":"none","clip":false},"position":{"x":100,"y":200},"size":{"width":400,"height":180}},"body":{"type":"shape","parent":"train","size":{"width":400,"height":180}}}}
```

## Animations

An animation is a timeline: `duration`, `play` (`manual`, `auto`, `always`),
`delay`, `loop`, `end` (`hold`, `reset`), `markers`, `tracks`. A new animation
written without `duration` lasts until its last keyframe.

A track drives one property of one target:

- `target`: an item id, `camera`, or another animation id.
- `property`: the JSON path in the target (`position`, `position.x`, `opacity`,
  `style.fill`, `props.text`, …). Camera: `focus` (item id or rect), `zoom`, `shake`.
  Animation: `time` (nesting, speed, reverse and hold are all time remapping).
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

The web timeline offers **Combine chapters**, ordering, frame selection and pauses.
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
including video covers: Cohub-hosted media provide resized images and video first frames,
so only what the export needs is downloaded and decoded. Videos elsewhere are drawn
without a cover. Previews beyond the image memory budget (`--image-memory`) are drawn as
placeholders, with a warning.

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
