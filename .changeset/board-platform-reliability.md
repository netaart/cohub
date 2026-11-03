---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Boards take scripts at their word. Dragging, resizing or rotating an item a script presents saves the authored item, so a lift on the selected card no longer shrinks it, and presentations never enter undo. Scripts that keep answering each other's `emit` no longer stall the Board: past 16 handlers in a row the emit rejects with the reason, and full event queues reject instead of dropping. Exports deliver `emit` in the same host, in document order, before time moves on, and give scripts the exported area as `viewchange`, so profiles and exports switch passes as a viewer would. `--frame` draws the frame as a page, with its fill and shaders. A clipping Frame keeps its own shader passes inside its box. Shader passes go up to 16. Exports warn about shaders they did not draw and why. `boards simulate` compiles shaders before stepping, reports per step where each press landed and what took it, lists rejected emits, and stops after `--timeout` naming the busy scripts and their lanes; `boards export` does the same per frame. `boards profile` reports software or hardware WebGL, the median and range of each owner over rounds, and keeps within `--budget` by measuring smaller. `boards diff` lists what changed between two versions; the SDK adds `board.diff()` and `diffBoardVersions()`.

Hosts: no action.
