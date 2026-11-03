---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Board items can autoplay. Set `"autoplay": true` on an app, a video, a 3D model or a finished task with a video result, and it opens as the Board opens: the app runs, the video loops muted, the model renders in its card and plays its own animation, drawing nothing more while it is still. Every viewer sees the same thing. Only items on screen and large enough run, and each device runs as many as it can. The largest go first, and the rest keep their still card until there is room. An app that scrolls off screen keeps running for 30 seconds, so panning back does not reload it. Video exports draw autoplay videos looping. `boards inspect` flags `autoplay` on items with nothing to play.

Hosts: no action.
