---
"@neta-art/cohub": patch
"@neta-art/cohub-cli": patch
---

`cohub boards export` draws a frame with WebGL only when it shows 3D, a tilted camera or a shader that draws, and with Canvas 2D otherwise, so on machines without a GPU those frames draw several times faster. `--timeout` now also bounds the browser's work on a frame, which used to give up after two minutes.
