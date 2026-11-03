---
"@neta-art/cohub-cli": patch
"@neta-art/cohub": patch
---

MP4 exports pad an odd width or height by a pixel instead of failing. The editor adds `fillFrame()`, which scales the selected boxes inside a frame to cover it.
