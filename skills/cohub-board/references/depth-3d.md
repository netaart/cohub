# Depth and 3D

`cohub boards schema depth` and `cohub boards schema file --field props.model` list every
field. This page explains how they fit together.

## Depth

Any item's `depth` lifts it off the Board into perspective. The fields are:

- `lift`: raises it toward the viewer, so it looks larger and casts a shadow.
- `tilt`: leans it; `180` turns it over.
- `spin`: turns it within its leaned plane.
- `bend`: wave, cloth, curl, or custom GLSL from its script's `bend` export.
- `back`: an item drawn on its back face.

On a frame, depth carries the frame's children. Animate depth with tracks on `depth.*`,
or with the presets `flip`, `lift`, `land`, `toss`, `sway`, `wave` and `curl`:

```bash
cohub boards preset flip --targets card --animation reveal | cohub boards apply <board> -i -
```

`inspect` reports `seenBounds` for lifted items, which is the area they cover as seen.
Check overlaps with it rather than `bounds`.

## Models

A `file` item with a 3D model (`.glb`, `.gltf` or `.stl`) shows a still card. With `props.model.display: "object"` it
stands on the Board as a lit 3D object fitted to its box. It leans toward a camera that
looks down, and stands upright under a low one.

- `props.model.animation` picks a clip, and changing it crossfades over `fade` ms (250).
  With `autoplay` the clip plays on the Board clock. Use `time` (ms) to drive it from a
  track or script instead, and `loop: false` to hold the last pose.
- Cohub records clip names and lengths in `props.snapshot.clips`, named nodes in
  `props.snapshot.nodes`, and a still in `props.snapshot.coverUrl`. Read them, and leave
  them as they are.
- Until it loads, a model object shows a silhouette or its cover. Scripts then hear
  `model:loaded`. Play and read-only views hold `auto` animations and scripts
  (`ctx.env.ready` false) for up to 1.5 s while the models in view load.
- Keep model files small: about 128 MB on desktop and 32 MB on mobile, textures
  included. Compress large models before placing them.
- Exports draw models as shown, in a local browser.

## Attach

`attach: { item, node? }` makes an item follow another item's origin, with `position` as
the offset. With `node`, one of the names in `props.snapshot.nodes`, it rides that bone in
3D, raised by `depth.lift`. Use it for a glow on a head or a label over a character.

## Low cameras

Camera `pitch` (0–60) lowers the view toward the horizon and `bearing` turns it, so the
Board becomes ground with models standing on it. Set them in camera tracks or with
`ctx.present("camera", …)`, or look once with `export --view x,y,zoom,pitch,bearing`.

`cohub boards examples arena` puts it all together: a fox you steer with WASD, clips
that crossfade as it walks and runs, a glow attached to its head, and a low camera that
follows it.
