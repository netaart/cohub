# Board

A Board is one document with three collections. Everything visible is an **item**,
everything that moves is an **animation**, and a keyframe names the property it
drives by its JSON path inside the item.

```json
{
  "board": { "background": { "kind": "dots" }, "grid": { "visible": true, "size": 24 }, "enter": { "preset": "deal" } },
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

## Items

Common fields: `type`, `parent`, `z`, `position`, `size`, `rotation` (degrees),
`scale`, `origin` (normalized transform origin, default center), `opacity`,
`style`, `props`, `locked`, `metadata`.

- `position` is relative to `parent`; a root item is in world space.
- Children inherit the parent's transform and opacity. Only `frame` items can be parents.
- `z` orders siblings; a new item without `z` goes on top.
- `size` is authored for boxes (`frame`, `shape`, media, `task`, `effect`, `sketch`)
  and derived for `text` (from `fontSize`, optional `props.width` wraps), `draw`
  (from points) and `arrow` (from endpoints).
- `style`: `fill`, `fillOpacity`, `stroke`, `strokeWidth`, `dash`, `radius`, `trim`.
  A color is a palette token (`brand`, `neutral`, `blue`, …, follows the theme),
  any CSS color, or `{ "light": …, "dark": … }`.

| type | props |
|---|---|
| `frame` | `label`, `clip` |
| `text` | `text`, `fontSize`, `fontWeight`, `font`, `align`, `lineHeight`, `width`, `reveal` |
| `shape` | `geometry` (`rectangle` `rounded` `ellipse` `diamond` `triangle` `path`), `path`, `text`, `fontSize`, `align` |
| `draw` | `points` (`{x, y, p}` relative to `position`) |
| `arrow` | `start`, `end` (a point, or `{ "item": id, "anchor"?, "port"? }`), `route`, `bend`, `waypoints`, `arrowStart`, `arrowEnd`, `label`, `fontSize`, `relation` |
| `image` `video` `audio` `file` | `src` (Space file path), `crop` (image), `snapshot` (cached file facts) |
| `task` | `taskRunId`, `snapshot` |
| `effect` | `kind` (`particles` `trail` `impact` `flash` `glow`) and its parameters |
| `sketch` | `src` (a JS module in the Space), `params` |
| `vendor.kind` | any; an extension type, namespaced like `acme.order` |

An extension type is stored as written. A client that registers it (see
`defineBoardItem` in the SDK) checks its props on edit and draws it; any other
client shows a placeholder that still moves and keeps every field.

Background pattern lives in `board.background.kind` (`dots` or `grid`); `board.grid.visible` toggles its overlay and `board.grid.size` sets spacing in board units. The Appearance panel edits all three. Use `cohub boards schema effect` to see which parameters apply to each effect kind.

Deleting an item that is still referenced fails and lists the references; `cascade`
also deletes children and the tracks that target it. Arrows bound to a deleted item
keep their place and fall back to a point. A media item whose `src` is not a usable
Space path is a `legacy.<type>` item: it keeps its place, its snapshot and whatever
else it carried, and it is not edited or exported as media.

## Animations

An animation is a timeline: `duration`, `play` (`manual`, `auto`, `always`),
`delay`, `loop`, `end` (`hold`, `reset`), `markers`, `tracks`. A new animation
written without `duration` lasts until its last keyframe.

A track drives one property of one target:

- `target`: an item id, `camera`, or another animation id.
- `property`: the JSON path in the target (`position`, `position.x`, `opacity`,
  `style.fill`, `props.text`, …). Camera: `focus` (item id or rect), `zoom`, `shake`.
  Animation: `time` (nesting, speed, reverse and hold are all time remapping).
- `keyframes`: `{ at, value, ease? }`, `ease` is a CSS easing.
- `composite`: `replace` (default) or `add`. Adds sum positions and rotations and
  multiply scale and opacity. When several `replace` tracks drive the same property
  at once, the one that started later wins, then track id order.
- `interpolation`: `auto` (numbers, vectors and colors blend; text, booleans and
  ids step), `step`, or `spline` for smooth position paths; `orient` turns the item
  along the path.

A marker with `pause: true` stops playback there until `next`.

A `focus` track moves the camera between subjects: it holds the current focus while a
clip travels, and lands on that clip's focus when the clip ends.

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
