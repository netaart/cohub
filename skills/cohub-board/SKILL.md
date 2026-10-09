---
name: cohub-board
description: Create, edit, animate, play back, and export Cohub Boards — a free-form JSON document of items, settings, and animations. Use for any Board authoring task.
---

# Cohub Boards

A Board is one JSON document: `board` settings, an `items` map, and an
`animations` map. Authoring is writing that JSON — `apply` merges a patch of the
same shape into the document and lands it as one version. Anything the desktop
editor can express, a patch can express.

```json
{"board":{"background":{"kind":"grid"}},
 "items":{
   "title":{"type":"text","position":{"x":80,"y":60},"props":{"text":"Plan","fontSize":48}},
   "hero":{"type":"shape","position":{"x":80,"y":160},"size":{"width":240,"height":120},"props":{"geometry":"rounded","text":"Ship"}}},
 "animations":{
   "intro":{"duration":1200,"tracks":{
     "title-in":{"target":"title","property":"opacity","keyframes":[{"at":0,"value":0},{"at":600,"value":1}]}}}}}
```

`items` and `animations` are objects keyed by id, not arrays — you name every item
you write. A patch has the same shape as the document, so `apply` only touches the
ids it mentions.

Use the Cohub CLI; it targets the current Space by default (`-s <spaceId>` only for
another Space). Add `--json` when chaining commands. Requires CLI 9.1.0+ — if Board
subcommands are missing, run `npm install -g @neta-art/cohub-cli`.

## Read, write, verify

Every command takes a Board ID or a `.board` path. Read with `get`, write with
`apply` — fields merge, arrays replace, `null` deletes, anything unmentioned stays.

```bash
cohub boards get <board> --only board          # settings only
cohub boards get <board> --within s1           # frame s1 and its children
cohub boards get <board> --rect 0,0,1600,900   # a region

cohub boards apply <board> '{"items":{"title":{"props":{"text":"New title"}}}}'
cohub boards apply <board> -i patch.json --dry-run   # validate, then drop --dry-run
cohub boards apply <board> -i -                      # patch from stdin
```

- Group a whole change into one patch so it lands as one version.
- `--replace` makes the document equal to the patch instead of merging.
- `--cascade` also deletes children and the tracks targeting a deleted item;
  arrows bound to a deleted item keep their place and fall back to a point.
- Deleting a still-referenced item fails and lists the references.
- `--base-version <n>` fails on conflict instead of merging; `--mutation-id` makes
  a retry idempotent. Without `--base-version` a conflict is rebased once and retried.

`schema` answers field questions without guessing — it is the source of truth:

```bash
cohub boards schema              # units, item types, colors, every animatable property
cohub boards schema shape        # one item type; also arrow, text, effect, frame, …
cohub boards schema track        # a track: target, property, keyframes, composite, interpolation
```

## Items

An item is placed by `position` / `size`, colored by `style`, and described by
`props`:

```json
{"id":"hero","type":"shape","position":{"x":120,"y":160},"size":{"width":280,"height":140},
 "props":{"geometry":"rounded","text":"Ship"},"style":{"fill":"green","fillOpacity":0.12}}
```

- `type`: `frame | text | shape | draw | arrow | image | video | audio | file | task | effect | sketch`
- Only `frame` items can be parents; `position` is relative to `parent`.
- Colors are theme-aware palette tokens (`cohub boards schema` lists them), any CSS
  color, or `{ "light": …, "dark": … }`.

Geometry follows the item type; `draw` and `arrow` carry no `position` / `size`:

| Item | Geometry |
|---|---|
| `text` `shape` `frame` `image` `video` `audio` `file` `task` `effect` | `position` + `size`; per-type defaults — omit what you don't mean to set |
| `draw` | `points` are world-space; the frame follows the stroke |
| `arrow` | `start` / `end` are world-space; the frame covers the `bend` curve |

Media items (`image`, `video`, `audio`, `file`) reference a Space file by `src`; a
`src` that is missing or not a relative Space path keeps the item as `legacy.<type>`
instead of rendering it.

## Board settings

`board` sits alongside `items` — background, grid, and the entry motion. The rest
of the fields and their values are in `cohub boards schema board`:

```json
{"board":{"background":{"kind":"grid"},"grid":{"visible":true,"size":24},
          "enter":{"preset":"deal","duration":600}}}
```

`background.kind` is `solid`, `dots`, `grid`, or `image`.

## Animation

An animation is one timeline in the `animations` map: an optional `duration`
plus `tracks`, each driving one property of one target by JSON path (`position`,
`opacity`, `style.fill`, `props.text`, …). The header fields are `duration`,
`play` (`manual`, `auto`, `always`), `end` (`hold` or `reset`), `delay`, `loop`
and `markers` — the full shapes are in `cohub boards schema animation`.

Tracks are just JSON, so write them directly; `preset` only saves keystrokes. With
`--animation` it prints an apply-ready patch; without it, bare `tracks` to fold into
an animation of your own.

```bash
cohub boards preset rise --targets a,b,c --animation intro --stagger 120ms | cohub boards apply <board> -i -
cohub boards preset float --targets ship > idle-tracks.json   # bare tracks, no animation wrapper
```

Presets are named in `cohub boards preset -h`. A camera is just another target and
drives `focus`, `zoom`, `center` or `shake`.

## Create

A file is created at the path you pass; the document is optional. Examples are
valid patches, so the same file works with `boards apply`.

```bash
cohub boards examples                        # basic, workflow, slides, lesson, sketch
cohub boards examples workflow > seed.json
cohub boards create boards/plan.board --title "Plan" -i seed.json
```

## Present and share

Open the Board first so the user watches it build, then stage the content in
visible steps — one patch per beat:

```bash
cohub desktop open file://boards/plan.board
cohub boards apply <board> -i beat.json
```

Playback moves every viewer together; a marker with `pause: true` holds until `next`:

```bash
cohub boards play <board> <animation> --at 2.5s
cohub boards pause <board>
cohub boards resume <board>
cohub boards stop <board>
cohub boards seek <board> 12.5s
cohub boards watch <board>    # stream changes and playback while you work
```

## Export

Users view the Board file itself; render an image only to self-check your edits or
to share a snapshot. `-o` picks the format; a `--at` range with `%d` writes a frame
sequence, and a video extension writes a video (`--help` lists the rest).

```bash
cohub boards export <board> -o /tmp/board.png
cohub boards export <board> --items a,b -o /tmp/part.png       # or --frame <id>, --rect x,y,w,h
cohub boards export <board> --animation intro --at 0:10s:500ms -o /tmp/frame-%d.png
```

## History

```bash
cohub boards history <board>                 # recent versions
cohub boards history <board> --restore 12    # return to a version, as a new write
```

## Safety

- Read the schema rather than guessing field names; `--dry-run` costs nothing.
- Confirm with the user before deleting items or animations, or restoring a version
  over their work.
- `export` refuses to overwrite without `--force`; never force onto an unknown path.
