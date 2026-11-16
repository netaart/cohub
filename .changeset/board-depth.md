---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board items take `depth`: `lift`, `tilt`, `spin`, `bend` (`wave`, `cloth`, `curl`, or `custom` GLSL a script module exports as `bend`), `shade`, `shadow` and a `back` item. A lifted item draws as a live picture in one shared PixiJS 3D view above the Board, with map-like perspective and a soft shadow; pointers, script hit regions and selection act on what they touch in it. A 3D model with `props.model.display: "object"` rests on the Board as a lit object among lifted items. Depth animates by path and through `ctx.present`, and scripts get the clock time an event arrives at. `@neta-art/cohub/board/render` exports `loadBoardDepthEngine`; `renderBoardExport` takes a `depth` stage; the editor adds `visualBounds` and `setPickScope`. The CLI exports depth in local Chrome, frames lifted items in whole-board exports, reports `depth` in `boards inspect` (`--view`), and adds `boards schema depth`, the presets `flip`, `lift`, `land`, `toss`, `sway`, `wave` and `curl`, and `boards examples depth`. Skinned models without normals now light correctly.
