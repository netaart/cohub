---
"@neta-art/cohub-cli": patch
"@neta-art/cohub": patch
---

Board scripts attached to the Board itself now publish with their App, so rain and other Board-wide effects run on the published page. Wide blurs and shadows halve the layer before blurring, at a fraction of the cost and without gaps between samples, and item effects render at the device resolution, so a frame with a color filter keeps its text sharp. Shader sprites call `sprite(id)` once per sprite rather than once per corner. A Board script's collision field covers the view with a margin, so panning and small zooms reuse it; text and items blended as light (`screen`, `add`) are no longer surfaces, and shapes keep their outlines. Reduced motion stops redrawing held shaders. The rain example traces each drop only as far as it shows and drains streaks into their splash.

Hosts: no action.
