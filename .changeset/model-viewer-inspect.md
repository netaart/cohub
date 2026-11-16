---
"@neta-art/cohub": minor
---

Model previews inspect as well as show. `ModelScene` pans (right or middle drag, Shift+drag, two fingers), turns slowly on `spinning`, switches animation `clip`s, and swaps `shading` between `standard`, `clay`, `color` and `normals`, with a depth-tested `wireframe` that follows skinning and morph targets. `look()` moves to a `ModelView` (yaw and pitch in degrees, zoom 1 fits the model, a target offset in model radii), `viewpoint` reads one back, and `MODEL_VIEW_PRESETS` holds the default, front, side and top views. `LoadedModel.stats` counts triangles, vertices, materials, textures and clips and measures the model. `ModelViewer` exposes the current `scene`, its `stats` and a PNG `snapshot()`.
