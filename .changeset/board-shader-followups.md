---
"@neta-art/cohub-cli": patch
"@neta-art/cohub": patch
---

Animation tracks can target a Board script by id and animate its `params.<name>`: numbers blend, colors mix and other values step. Changing params no longer restarts a script, so its state survives tuning and animation. Removing a Board script that tracks animate needs `--cascade`, or `removeBoardScriptPatch()` to drop them too. Shader `state` takes an optional `bounds` area, so a Board script's state can stay on the Board rather than the view, and `stateAt(local)` reads it by position. Adaptive shader quality follows the display's frame rate instead of assuming 60 Hz. `cohub boards export` through Chrome continues scripts and shader state from frame to frame instead of replaying them for every frame, and an untimed web export draws shaders at the Board's current script time. `cohub boards simulate` compiles shaders with a local Chrome, Chromium or Edge when one is found, or checks them without one, and reports Board script errors.

Hosts: no action. `createBrowserBoardScriptExport()` keeps scripts running across export frames, and `renderBoardExport` accepts `shaderLayers` to carry shader state between them.
