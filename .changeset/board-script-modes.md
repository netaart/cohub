---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

`script.modes` limits a Board script to some of `edit`, `play`, `view` and `export` (all by default): elsewhere it does not load, draw, present, take input or broadcast, and switching modes starts or stops it. Games and directed shows usually take `["play", "view", "export"]`. `boardScriptAttachments(document, mode)` and `hasBoardScripts(document, mode)` take an optional mode, and the editor adds `scriptMode` and `runsScripts`. Presence shares each viewer's `scriptMode`, and `leadsScripts(owner)` and the stage's `scriptLeader(owner)` pick an autonomous-commit leader per script among the editors whose mode runs it. `cohub boards simulate` runs scripts as their modes allow and warns about scripts its final mode leaves out.

A shape's outline, corner radius and dashes now scale with its transform, its own `scale` and its Frames', and its label scales by the smaller of the two axes, so a scaled shape keeps its proportions and buttons on a script's screen layer keep readable labels at any zoom.
