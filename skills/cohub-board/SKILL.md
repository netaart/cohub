---
name: cohub-board
description: Create, edit, animate, script, play back, and export Cohub Boards — a free-form JSON document of items, settings, and animations. Use for any Board authoring task, including placing generated media on a Board.
---

# Cohub Boards

A Board is one JSON document: `board` settings, an `items` map, and an
`animations` map. Authoring is writing that JSON — `apply` merges a patch of the
same shape into the document and lands it as one version.

```json
{"board":{"background":{"pattern":"grid"}},
 "items":{
   "title":{"type":"text","position":{"x":80,"y":60},"props":{"text":"Plan","fontSize":40}},
   "hero":{"type":"shape","position":{"x":80,"y":160},"size":{"width":240,"height":120},"props":{"geometry":"rounded","text":"Ship"},"style":{"fill":"green","fillOpacity":0.12}}},
 "animations":{
   "intro":{"duration":1200,"tracks":{
     "title-in":{"target":"title","property":"opacity","keyframes":[{"at":0,"value":0},{"at":600,"value":1}]}}}}}
```

`items` and `animations` are maps keyed by ids you choose. Requires Cohub CLI
10.3.0+; if a command below is missing, run `npm install -g @neta-art/cohub-cli`.
Board commands take a Board ID or a `.board` path and target the current Space
(`-s <spaceId>` for another); add `--json` when chaining.

## Workflow

1. Look up fields with `boards schema`, and current content with `boards get`.
2. Open the Board when possible so the user can follow along; otherwise continue
   without it. Create the `.board` file first — it only points to the Board:

   ```bash
   cohub boards create boards/plan.board --title "Plan"   # -i seed.json for an initial document
   cohub desktop open file://boards/plan.board
   ```

3. Build in coherent patches, one visible step at a time: `--dry-run`, then `apply`.
4. Check with `boards inspect` and an exported image.

Starter documents are valid patches for `create` and `apply`:

```bash
cohub boards examples                        # basic, workflow, slides, lesson, custom
cohub boards examples workflow > seed.json
```

## Schema

`schema` lists every field with its meaning and default — read it instead of guessing:

```bash
cohub boards schema              # units, scale, coordinates, item types, colors, animatable properties
cohub boards schema frame        # one item type: text, shape, arrow, image, task, custom, …
cohub boards schema frame --field props.decoration  # one field, without the full schema
cohub boards schema track        # also board, animation, camera
cohub boards schema camera --field focus  # camera value types and units
cohub boards schema script       # the script attachment and the module API
```

Worth knowing before you build:

- Item and animation IDs must be distinct.
- Match the scale of existing content when adding items. For a new Board, use
  the examples or the recommended `scale` in `boards schema`.
- Only frames are parents; children use frame-relative positions and move with it.
- Set `z` to order layers; changing JSON key order does not reorder existing items.
- Frames have a neutral outline and a small organizational label. Use
  `props.decoration: "none"` for invisible groups; use child text items for captions.
- Animations default to `play: "manual"` and run only on `boards play`; `auto` plays
  when the Board opens, `always` loops.
- Apps, videos and 3D models show a still card until opened; `"autoplay": true` on the
  item runs the app, loops the video muted, or renders the model as the Board opens.
- Palette tokens (`blue`, `green`, …) and `{ "light": …, "dark": … }` follow the
  viewer's theme; a fixed CSS color can vanish on one of them. Exports default to
  `--theme dark`; `--theme` takes any built-in theme, such as `light` or `neta-pixel`.
- `boards apply` fits new image and video items to their media's aspect ratio before
  writing; write `snapshot.naturalWidth` and `naturalHeight` to keep a box as authored.
- `board` sets the background (`color`, `image` and a `dots` or `grid` pattern; omit
  them to follow the theme), the grid's size and snapping, `atmosphere` (vignette,
  grain), and `enter`, a motion for items as they are added.
- Any item takes `style.filter` (blur, saturate, hue, …), `style.shadow` (a glow
  with no offset) and `style.blend`; on a frame they treat it and its contents as one layer.
  Text reveals by `char`, `word` or `line` (`props.revealBy`) with `revealMotion`.

## Read and write

```bash
cohub boards get <board> --only board          # settings only
cohub boards get <board> --within s1           # frame s1 and its children
cohub boards get <board> --rect 0,0,960,540    # a region
cohub boards get <board> --since 12            # only the changes after version 12

cohub boards apply <board> '{"items":{"title":{"props":{"text":"New title"}}}}'
cohub boards apply <board> -i patch.json --dry-run
cohub boards apply <board> -i -                # patch from stdin
```

- Fields merge, arrays replace, `null` deletes, anything unmentioned stays.
- `--replace` makes the document equal to the patch; anything it leaves out is deleted.
  First run `cohub boards diff <board> --from <version you read>` to see what others
  changed since (cards moved by someone playing on the web), and keep it.
- Deleting a referenced item fails and lists the references; `--cascade` also
  deletes its children and tracks.
- Concurrent writes merge; `--base-version <n>` fails instead — use it when
  rewriting a timeline or the whole document. `--mutation-id` makes retries idempotent.

## Media

Media items take `props.src`; prefer a public HTTP(S) URL, such as a generation
result — a Space path relative to the workspace root also works. A `task` item is
a live card for a generation run: write only `props.taskRunId`, and the server
keeps its status and results up to date.

```bash
cohub generate "a calm lake at sunrise" -m <model> --async --json \
  | jq '{items:{lake:{type:"task",position:{x:80,y:80},size:{width:480,height:270},props:{taskRunId:.taskRunId}}}}' \
  | cohub boards apply <board> -i -
```

A `session` item is a live card for a chat in the Space: write only
`props.sessionId` and the server keeps its title, latest message and status.
In the web app, viewers open, reply to and stop the chat from its card. To pin
the chat you are running in:

```bash
jq -n --arg id "$COHUB_SESSION_ID" '{items:{chat:{type:"session",position:{x:80,y:80},props:{sessionId:$id}}}}' \
  | cohub boards apply <board> -i -
```

## Scripts

`script` attaches a JavaScript module to any item; a `custom` item is an empty box
whose content the module draws. Write modules as Space files, attach them with
`apply`, and read the API with `boards schema script`.

```bash
mkdir -p scripts
cohub boards examples custom --module > scripts/wave.js
cohub boards examples custom > custom.json
cohub boards create demo.board -i custom.json
```

A module exports `draw(ctx, frame)` to paint Canvas 2D, a default setup function
for behavior, or both. Its output is local: `present` and `scene` show temporary
changes, and only `commit` saves. Input reaches it only through declared
`hitRegions`; `change` and `gesture` events observe edits and pen strokes without
taking input. One Frame script can drive all its descendants, and a commit may
spawn items running modules already in its scope. Draw in item-local coordinates
within `width` × `height`; export `pixelated` and `frameRate` for pixel art. Prefer
native text for editable, inspectable labels; Canvas text can use `Geist` or
`Geist Mono`.

`board.scripts` attaches a module to the Board itself: it reaches every item and
draws over the whole view. For GPU effects a module exports `shader` (GLSL passes,
instanced sprites, filters, state and `surface()` collisions with cards); rain that
splashes on cards is one example:

```bash
cohub boards examples rain --module > scripts/rain.js
cohub boards apply <board> '{"board":{"scripts":{"rain":{"src":"scripts/rain.js"}}}}'
```

Animate a Board script with tracks on `params.<name>`, targeting the script's id,
and an item's script with `script.params.<name>`. After writing a shader, run
`cohub boards simulate <board>` to compile it and see errors. Exports render shaders
in a shared local Chrome automatically; check the result with an exported image,
since `inspect` does not see shader pixels.

Design a playful Board as one world before splitting it: one controller script (on
the Board or one Frame) with regions as data reads as a whole and moves cards across
regions, where a script per Frame becomes separate mini-games. Confirm that
direction with the user before building out every region.

Keep it smooth: a pass with a `name` switches with `ctx.passes()` and costs nothing
while off, so turn a full-view `filter` on only while it shows; drive motion through
`ctx.uniforms()` rather than presenting items every frame, and present shadows or
filters only while they change. Give a box pass `texel` when its picture changes only
every few units (pixel art, maps), keep shared data such as sprite sheets in a `.json`
module imported `with { type: "json" }`, and compress large models before placing them.
`cohub boards profile <board>` times each shader
owner (median and range over rounds), says whether it ran on software WebGL, and
names what to change; it stays within `--budget` by measuring smaller.

Scripts work together through `emit`: a Frame hands a cast to a Board script, which
can answer. A handler may emit back, but a chain of handlers answering each other
rejects after 16 hops; send follow-ups from `onFrame()`. A clipping Frame keeps its own
shader passes in its box; set `clip: false` to let rain spill out. `present()` is
never saved, even when the user drags or resizes a presented card.

Verify interaction before handing over: `cohub boards simulate <board> -i steps.json
-o shot.png` runs the scripts through taps, drags, pen strokes and hovers
(`{"move": [[x, y], …]}`) without saving, reports script errors, and renders shaders
and screen UI that `export` leaves out. With `--json`, `presses` says for every tap and
drag where it landed (a script's hit region, a selection handle, an item, empty board)
and what took it, so a stroke that started on a caption or a drag that grabbed a resize
handle shows at once. It compiles shaders first and stops on errors, and gives up after
`--timeout` (2m) naming the scripts still busy.

Scripts sense the viewer through `ctx.env` (mode, pointer, orientation, senses) and
by listening to `motion`, `gamepad`, `audio` or `location`: a sense runs only while a
script listens, Cohub never saves readings (commit only what the Board needs), and
`simulate` delivers them with `{"sense": "motion", "data": {…}}`.
`capabilities.call("haptics" | "fullscreen")` answers back. Check `ctx.env.senses` and offer a fallback when one is unavailable.

Published as an App, a Board opens in play: every visitor gets a local copy where
drags move unlocked items and script regions take every press, saved per App version.
Lock what visitors should not move, keep progress in the document (`ctx.state` starts
over), and check the visitor's view with `{"tool": "play"}` in the steps.

Long runs: wrap them in `timeout` (`timeout 300 cohub boards simulate …`) so a stuck run
cannot hold the shell. To stop a stray process, use `pkill -f '[c]ohub boards simulate'`:
the bracket keeps the pattern from matching the shell running `pkill` itself.

## Animation

An animation is one timeline of tracks; each track drives one property of one
target by JSON path. `target: "camera"` moves the view through `focus`, `zoom`,
`center` and `shake`. Write tracks directly, or generate them — these helpers
print JSON and never write:

```bash
cohub boards preset rise --targets a,b,c --animation intro --stagger 120ms | cohub boards apply <board> -i -
cohub boards preset float --targets ship > idle-tracks.json    # bare tracks
cohub boards sequence <board> --animation lecture -i chapters.json > lecture.json
cohub boards path ship -i path.json > ship-track.json
```

- `preset -h` lists presets; `--animation` wraps the tracks in an apply-ready patch.
- `sequence` joins chapter animations, each written from time 0, into one timeline:
  `{"chapters":[{"animation":"intro","frame":"cover","pause":true}, …]}`. First
  apply the chapters, generate the sequence, then apply its patch. Frames control
  chapter visibility and provide the default camera focus; chapter camera tracks
  and markers are retained. Regenerate after changing chapter tracks, lengths or order.
- `path` turns `{"points":[{"x":0,"y":0}, …],"duration":2000,"orient":true}` into a
  position track.

### Clips and video editing

A clip shows a target only for a span (a `visible` track) and plays video, audio or
a nested animation (a `props.time` or `time` track whose slope is its speed). Media
sound while shown and moving forward; `props.volume` fades them. Cut, trim and
transition with ordinary tracks; titles are text items and layers are `z`.

```bash
cohub boards place <board> --animation cut --targets intro,talk,outro | cohub boards apply <board> -i -
cohub boards place <board> --animation cut --targets music --at 0 --duration 30s --from 12s --together
cohub boards export <board> --animation cut --at 0:30s:40ms --camera --size 1920x1080 -o /tmp/cut.mp4
```

`place` lays targets end to end, moves ones already placed, and prints a patch.
Video exports draw each video at its time and mix every playing clip's sound.

## Check and export

`-o` picks the format; a `--at` range with `%d` writes a frame sequence, and a video
extension writes a video. `--camera` renders what the audience sees.

```bash
cohub boards inspect <board> --animation lecture --at 0:10s:1s --json  # final timeline, up to 100 samples
cohub boards inspect <board> --items title,formula --json     # static layout
cohub boards export <board> -o /tmp/board.png
cohub boards export <board> --items a,b -o /tmp/part.png       # or --frame <id>, --rect x,y,w,h
cohub boards export <board> --frame s2 -o /tmp/page.png        # the frame as a page, its shaders included
cohub boards export <board> --animation intro --at 1s,5s,9s --camera --size 1600x900 -o /tmp/preview-%d.png
cohub boards export <board> --animation intro --at 0:10s:40ms --camera -o /tmp/intro.mp4
```

`--size` sets the output pixels of a camera export; it never sizes frames.

A long video with shaders renders slowly on a CPU. Add `--async` to run the export as
a Task in the Space's sandbox and return at once (`cohub tasks get <id>` follows it);
never sleep and poll for it. Viewers can also export MP4 from the web app, which
draws on their GPU.

Exports give scripts the exported area as their view and deliver `emit` within the same
moment. Warnings name any shader that did not draw and why (outside the area, hidden,
clipped, every pass off, failed to compile).

`inspect` checks the static document unless `--animation` is given. `bounds` uses
world units with `x/y` at the top left, regardless of text alignment; `worldBounds`
includes rotation and `opacity` includes parents. Checks exclude camera cropping
and script-drawn content, so also review exported images at relevant times.

## Present

Top-level frames are pages, ordered by placement (rows, then left to right); a labeled
`decoration: "none"` frame is an invisible page. `cohub boards frames` shows the order.

Playback moves every viewer together; a marker with `pause: true` holds until `next`:

```bash
cohub boards play <board> <animation> --at 2.5s
cohub boards pause <board>       # also resume, next, stop
cohub boards seek <board> 12.5s
cohub boards watch <board>       # stream changes and playback
```

## History

```bash
cohub boards history <board>                 # recent versions
cohub boards diff <board> --from 12          # what changed since version 12, field by field
cohub boards history <board> --restore 12    # restore as a new write
```

## Safety

- Confirm with the user before deleting items or animations, or restoring a version
  over their work.
- `export` refuses to overwrite without `--force`; never force onto an unknown path.
