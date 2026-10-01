---
name: cohub-board
description: Create, edit, animate, and export Cohub Boards — items, arrows, effects, and animations. Use for any Board authoring task.
---

# Cohub Boards

A Board is one document with three collections. Everything visible is an **item**,
everything that moves is an **animation**, and a keyframe names the property it
drives by its JSON path inside the item.

```json
{
  "board": { "background": { "kind": "dots" }, "enter": { "preset": "deal" } },
  "items": {
    "s3":   { "type": "frame", "position": { "x": 1700, "y": 1000 }, "size": { "width": 1600, "height": 900 }, "props": { "label": "Length contraction" } },
    "ship": { "type": "shape", "parent": "s3", "position": { "x": 200, "y": 400 }, "size": { "width": 320, "height": 80 }, "props": { "geometry": "rounded" }, "style": { "fill": "blue" } },
    "t3":   { "type": "text", "parent": "s3", "position": { "x": 80, "y": 60 }, "props": { "text": "Moving rulers get shorter", "fontSize": 48 } }
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

Use the Cohub CLI — it targets the current Space by default (`-s <spaceId>` only for
another Space). Add `--json` when chaining commands.

## Target a Board

Every command takes a Board ID or a `.board` path; the path is a `.board` file in
the Space, so it also shows up in Files and opens on the desktop.

```bash
cohub boards get boards/plan.board --json
cohub boards get <boardId> --only items --within s3
```

`get` pages through large Boards; prefer the filters (`--items`, `--within`,
`--rect`, `--only`, `--limit`/`--cursor`) over reading everything.

## Learn the shape of the data

`schema` is the source of truth — read it before improvising a field name:

```bash
cohub boards schema                     # units, item types, colors, every animatable property
cohub boards schema arrow               # a target: shape, arrow, text, effect, frame, animation, …
cohub boards preset --list              # fade-in, rise, pop, draw, type, pulse, float, shake, spin, …
```

## Edit

The loop: read → patch → verify. A patch is a JSON Merge Patch — objects merge,
arrays replace, `null` deletes, anything unmentioned stays.

```bash
cohub boards apply <board> '{"items":{"title":{"props":{"text":"New title"}}}}'
cohub boards apply <board> -i patch.json --dry-run   # validate first
cohub boards apply <board> -i -                      # patch from stdin
```

- Group a whole change into one patch so it lands as one version.
- `--cascade` also deletes children of deleted items; arrows bound to a deleted
  item keep their place and fall back to a point.
- Deleting an item that is still referenced fails and lists the references.
- `--base-version <n>` fails on conflict instead of merging; `--mutation-id`
  makes a retry idempotent.

Item types, common fields and per-type props are in the schema above. Two rules
worth remembering:

- `position` is relative to `parent`, and only `frame` items can be parents.
- Colors are palette tokens (`brand`, `neutral`, `blue`, …, follow the theme), any
  CSS color, or `{ "light": …, "dark": … }`.
- A media item whose `src` is missing or not a relative Space path is kept as a
  `legacy.<type>` item rather than rendered as media.

## Animate

An animation is a timeline: `duration`, `play` (`manual`, `auto`, `always`),
`delay`, `loop`, `end` (`hold`, `reset`), `markers`, `tracks`. A track drives one
property of one target (`property` is a JSON path: `position`, `opacity`,
`style.fill`, `props.text`, …).

Write an animation's header and its tracks in the same patch: a new animation
without `duration` is sized from its keyframes. A version is not contiguous, so
never infer what changed from the version number — read the document, or the
history, and let `--base-version` catch a stale write.

Prefer generated tracks over hand-written keyframes:

```bash
cohub boards preset rise --targets a,b,c --animation intro --stagger 120ms | cohub boards apply <board> -i -
cohub boards preset float --targets ship --animation idle --duration 4s    | cohub boards apply <board> -i -
```

Camera tracks target `camera` and drive `focus` (an item id or a rect), `zoom` and
`shake`, so a scene can push in on what it is talking about. `--ease` takes a CSS
easing; `--at`, `--stagger` and `--duration` take times like `800ms` or `2.5s`.

## Create

A Board file is created at the path you pass; the document is optional.

```bash
cohub boards examples --list                 # basic, workflow, slides, lesson, sketch
cohub boards examples workflow > seed.json
cohub boards create boards/plan.board --title "Plan" -i seed.json
```

Examples are valid patches, so the same file works with `boards apply`.

## Present progressively

Open the Board first so the user watches it build, then stage the content in
visible steps — one patch per beat:

```bash
cohub desktop open file://boards/plan.board
cohub boards apply <board> -i beat.json
```

Shared playback moves every viewer together, and a marker with `pause: true` holds
the presentation until you move on:

```bash
cohub boards play <board> <animation> --at 2.5s
cohub boards pause <board> · resume · stop
cohub boards seek <board> 12.5s
cohub boards next <board>
cohub boards watch <board>          # stream changes and playback while you work
```

## Show the result

Users view the Board file itself:

```bash
cohub desktop open file://boards/plan.board
```

Render an image only to self-check your edits or to share a snapshot:

```bash
cohub boards export <board> -o /tmp/board.png
cohub boards export <board> --items a,b -o /tmp/part.png       # or --frame <id>, --rect x,y,w,h
cohub boards export <board> --animation intro --at 1.5s -o /tmp/frame.png
cohub boards export <board> --animation intro --at 0:10s:500ms -o /tmp/frame-%d.png
```

A sequence needs `%d` in `-o`; every frame keeps the first frame's rect.

## History

```bash
cohub boards history <board>                    # recent versions
cohub boards history <board> --restore 12       # return to a version, as a new write
```

## Safety

- Read the schema rather than guessing field names; `--dry-run` costs nothing.
- Confirm with the user before deleting items or animations, or restoring a
  version over their work.
- `export` refuses to overwrite without `--force`; never force onto an unknown path.
