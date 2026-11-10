---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board animations play smoothly and look the same everywhere. Camera tracks frame the animation's new `viewport` (1600×900 by default) and every screen and `--camera` export shows that framing scaled to fit; `boards export --camera` sizes to it unless `--size` is given. A playing soundtrack leads the visuals instead of being nudged, so audio no longer warbles. Moving the view during playback continues from the shot on screen, and played motion no longer wakes scene subscribers every frame.
