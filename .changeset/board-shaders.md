---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Board scripts can draw on the GPU and belong to the Board itself. `board.scripts` attaches modules to the Board: they reach every item, draw over the whole view and run before item scripts. A module's `shader` declares WebGL 2 passes written as GLSL functions: above or below its owner, or a `filter` over the owner's pixels; instanced `sprites`; `surfaces`, a distance field of the Board's item edges for collisions; `state` advanced at 60 Hz; declared `uniforms` set with `ctx.uniforms()`; and `cohub:` includes. Loops are bounded, compile errors point at the author's lines, quality adapts to the frame rate, and a shader running when the GPU resets is paused for the session. Hosts now send each script only the items an edit changed. Web exports draw shaders as the Board shows them; `cohub boards export --renderer auto` (the default) moves to a local Chrome, Chromium or Edge when a script has a shader, `canvas` names the shaders it drew with `draw()` or left out. `cohub boards examples rain --module` prints rain that splashes on cards.

Hosts: no action. Hosts that pass `scripts` to `renderBoardExport` get shader layers on WebGL renderers and a `shaders-unsupported` warning on Canvas renderers; implement `BoardScriptHost.shaders` to export shaders from a custom host.
