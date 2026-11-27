---
name: cohub-board
description: Create, edit, animate, script, play back and export Cohub Boards — a free-form canvas stored as one JSON document of items, settings and animations. Use for whiteboards, diagrams, slides, animated lessons and interactive canvases, for any Board ID or `.board` file, and for placing generated media or chats on a Board.
---

# Cohub Boards

A Board is one JSON document: `board` settings, an `items` map and an `animations`
map, keyed by ids you choose. Authoring is writing that JSON: `apply` merges a patch
of the same shape into the document and lands it as one version.

```json
{"board":{"background":{"pattern":"grid"}},
 "items":{
   "title":{"type":"text","position":{"x":80,"y":60},"props":{"text":"Plan","fontSize":40}},
   "hero":{"type":"shape","position":{"x":80,"y":160},"size":{"width":240,"height":120},"props":{"geometry":"rounded","text":"Ship"},"style":{"fill":"green","fillOpacity":0.12}}},
 "animations":{
   "intro":{"duration":1200,"tracks":{
     "title-in":{"target":"title","property":"opacity","keyframes":[{"at":0,"value":0},{"at":600,"value":1}]}}}}}
```

Commands take a Board ID or a `.board` path and target the current Space (`-s <spaceId>`
for another); add `--json` when chaining. Times are milliseconds; `500ms`, `12.5s` and
`2m` also work on the command line. If a command or flag here is missing, update the
CLI: `npm install -g @neta-art/cohub-cli`.

## Workflow

1. **Look up, don't guess.** `cohub boards schema` gives units, recommended scale, item
   types, colors and animatable properties; `schema <target> [--field <path>]` gives
   one part. `boards get` shows what is already there.
2. **Create and open.** Open the Board so the user can follow along; carry on without
   it when no desktop is attached.

   ```bash
   cohub boards examples                              # a few starters; each is a valid patch
   cohub boards examples slides > seed.json
   cohub boards create boards/plan.board --title "Plan" -i seed.json
   cohub desktop open file://boards/plan.board
   ```

3. **Build in visible steps.** One coherent patch per step, such as a section, a page
   or a timeline. Use `--dry-run` when unsure, then `apply`.
4. **Look at the result.** Run `boards inspect`, then export an image and view it,
   before calling the work done (see Check and export). Link the `.board` file in
   your reply.

## Authoring rules

- Item and animation ids must be distinct.
- Match the scale of nearby content; on a new Board, follow `scale` in `boards schema`.
- Only frames are parents. Children use frame-relative positions and move and clip
  with their frame.
- `z` orders layers; JSON key order does not.
- Frames draw a neutral outline and a small label. `props.decoration: "none"` makes an
  invisible group; put captions in text items.
- Palette tokens (`blue`, `green`, …) and `{ "light": …, "dark": … }` follow the
  viewer's theme; a fixed CSS color can vanish on one of them. Exports default to
  `--theme dark`.
- `board` sets the background (omit colors to follow the theme), the grid, `atmosphere`
  and `enter`, a motion for items as they are added.
- Images and videos show as cards in the viewer's theme. `props.decoration: "none"`, or
  `props.contentDecoration: "none"` on a frame, draws only the picture with its transparency,
  for scenery and sprites; lock scenery viewers should not pick.
- `apply` fits new image and video boxes to their media; set `snapshot.naturalWidth`
  and `naturalHeight` to keep your box. Leave other `props.snapshot` fields as Cohub
  wrote them.
- Animations default to `play: "manual"` and run on `boards play`; `auto` plays when the
  Board opens, `always` loops.
- Apps, videos and 3D models show a still card until opened; `"autoplay": true` runs
  them as the Board opens.
- Items also take filters, shadows, blend modes, text reveals and depth; check
  `schema <type>` before building a workaround.

## Read and write

```bash
cohub boards get <board> --only board          # settings only
cohub boards get <board> --within s1           # a frame and its children
cohub boards get <board> --rect 0,0,960,540    # a region; --limit and --cursor page items
cohub boards get <board> --since 12            # only the changes after version 12

cohub boards apply <board> '{"items":{"title":{"props":{"text":"New title"}}}}'
cohub boards apply <board> -i patch.json --dry-run
cohub boards apply <board> -i -                # patch from stdin
```

- Objects merge, arrays replace, `null` deletes, and anything left out stays.
- On large Boards, read only the part you need.
- Concurrent writes merge. `--base-version <n>` (the version you read) fails instead;
  use it when rewriting a timeline. `--mutation-id` makes retries idempotent.
- `--replace` deletes whatever the patch leaves out. First run `boards diff <board>
  --from <version you read>` to see what others changed since, such as cards moved
  in play on the web. Keep those changes, and pass `--base-version`.
- Deleting a referenced item fails and lists the references; `--cascade` also deletes
  its children and tracks.
- A `.board` file only points to its Board: a copy of the file opens the same Board.
  To duplicate one, `cohub boards get a.board | jq '{board, items, animations}' | cohub boards create b.board -i -`.

## Media and live cards

Media items take `props.src`. Prefer a public HTTP(S) URL, such as a generation result;
a Space path relative to the workspace root also works. Live cards keep themselves
current, so write only their id:

- `task` with `props.taskRunId`: a generation run, with its status and results.
- `session` with `props.sessionId`: a chat in any Space you can view. Viewers open,
  reply to and stop it from the card.

```bash
cohub generate "a calm lake at sunrise" -m <model> --async --json \
  | jq '{items:{lake:{type:"task",position:{x:80,y:80},size:{width:480,height:270},props:{taskRunId:.taskRunId}}}}' \
  | cohub boards apply <board> -i -
jq -n --arg id "$COHUB_SESSION_ID" '{items:{chat:{type:"session",position:{x:640,y:80},props:{sessionId:$id}}}}' \
  | cohub boards apply <board> -i -
```

Namespaced types such as `acme.order` hold your own data with a preview every client
can show; see `schema extension`.

## Animation

An animation is one timeline of tracks; each track drives one property of one target by
JSON path. `target: "camera"` frames the view through `focus`, `zoom`, `center`,
`shake`, `pitch` and `bearing`, composed for the animation's `viewport` (1600×900 unless
set) and scaled to fit every screen. Write tracks directly, or generate them; these
commands print patches and never write:

```bash
cohub boards preset rise --targets a,b,c --animation intro --stagger 120ms | cohub boards apply <board> -i -
cohub boards sequence <board> --animation lecture -i chapters.json | cohub boards apply <board> -i -
cohub boards place <board> --animation cut --targets intro,talk,outro | cohub boards apply <board> -i -
cohub boards path ship -i path.json            # a position track along a polyline
```

- `preset -h` lists the motions; without `--animation` you get bare tracks.
- `sequence` joins chapter animations, each written from time 0, into one timeline with
  frame visibility, camera focus and pause markers. Apply the chapters first, and
  regenerate after changing one. The sequence owns its animation: regenerating resets
  it and drops tracks added there, so put camera moves in the chapters.
- Video editing uses clips. `place` shows each target only for its span and plays its
  video, audio or nested animation. Cut, trim and fade with ordinary tracks
  (`props.volume` for sound); titles are text items and layers are `z`.

## Present

Top-level frames are pages in reading order: rows, then left to right. A labeled
`decoration: "none"` frame is an invisible page; `boards frames` prints the order.
Playback is shared by every viewer, and a marker with `pause: true` holds until `next`.

```bash
cohub boards play <board> lecture --at 2.5s
cohub boards next <board>          # also pause, resume, seek <time>, stop
cohub boards watch <board> --json  # stream changes and playback
cohub boards get <board> --only playback
cohub boards viewers <board>       # each screen: loaded, followed the camera, lost voice starts
```

- To reveal something still generating, hold at a `pause: true` marker, write it in when
  ready, then `next`. Put the reveal right after the marker: viewers load what follows it
  while it holds.
- To start or jump somewhere with heavy images, add `--preroll` to `play` or `seek`: every
  screen holds that frame until all have loaded it, at most 5 s, including scripts'
  `await ctx.preload([...])`. Check with `boards viewers` afterwards.
- A new `play` brings back viewers who took the camera; `seek` and `next` keep their view.

## Check and export

| To see | Use |
|---|---|
| Overlaps, clipping, measured bounds, timeline samples | `inspect --json`, with `--animation <id> --at 0:10s:1s` for playback |
| The Board as drawn | `export -o shot.png`, or one part with `--frame`, `--items`, `--rect` |
| What the audience sees | `export --animation <id> --at … --camera` |
| Scripts reacting to input | `simulate` (see [scripts](references/scripts.md)) |
| Shader cost | `profile` (see [shaders](references/shaders.md)) |

```bash
cohub boards inspect <board> --json
cohub boards export <board> -o /tmp/board.png
cohub boards export <board> --frame s2 -o /tmp/page.png
cohub boards export <board> --animation intro --at 1s,5s,9s --camera -o /tmp/intro-%d.png
cohub boards export <board> --animation intro --at 0:10s --fps 24 --camera -o /tmp/intro.mp4
cohub boards export <board> --view 1300,3400,0.7 -o /tmp/spot.png    # a temporary camera
```

- `inspect` checks native layout only. It misses camera cropping, script drawing and
  shader pixels, so also review exported images at the moments that matter.
- To look at a spot, use `--view` or `--rect`; never add probe items or animations to the Board.
- `-o` picks the format, and `%d` writes a frame sequence.
- Long videos, especially with shaders, render slowly on a CPU. Add `--async` to run
  the export as a Task and follow it with `cohub tasks get <id>`; never sleep and poll.
  The web app's Export button runs the same camera-view MP4 export as a Task in the Space.
- Wrap long local runs in `timeout 300 …`. To stop stray runs, use `pkill -f '[c]ohub boards (export|simulate)'`.

## Going further

Read the reference before building:

- Interaction, games, multiplayer effects, device input, scripted cameras, Board Apps:
  [references/scripts.md](references/scripts.md)
- GPU shaders, Board-wide effects, performance: [references/shaders.md](references/shaders.md)
- Depth, card flips, 3D models, low cameras: [references/depth-3d.md](references/depth-3d.md)

## History and safety

```bash
cohub boards history <board>                 # recent versions
cohub boards diff <board> --from 12          # what changed since version 12, field by field
cohub boards history <board> --restore 12    # restore as a new write
```

- Confirm with the user before deleting items or animations, writing with `--replace`,
  or restoring a version over their work.
- `export` refuses to overwrite without `--force`; never force onto an unknown path.
