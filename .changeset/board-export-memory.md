---
"@neta-art/cohub": patch
"@neta-art/cohub-cli": patch
---

Board exports with glows and blurs no longer grow native memory frame after frame: effect pictures give their canvases back as soon as they are drawn, and a long glowing line only draws the part that reaches the view. A 1080p export of a large Board now stays near 1 GB over hundreds of frames instead of adding about 170 MB a frame.
