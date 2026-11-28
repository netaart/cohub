---
"@neta-art/cohub": patch
"@neta-art/cohub-cli": patch
---

`cohub boards export` no longer draws a frame with WebGL for a simulated shader outside it, so such frames draw several times faster without a GPU, and video frames are read without an extra canvas copy.
