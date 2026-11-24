---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board shows start their sound whole: viewers load a playback's next three sounds wherever they fall, nested animations included, and the videos of its next 3 seconds, paused at their first frame, so a play, seek or `next` that lands on a clip plays it from its first word. `boards play` and `boards seek` take `--preroll <time>` (up to 5 s; `preroll` on the play and seek commands and in `board.play()` and `board.seek()`), holding the first frame on every screen while it loads. Back to the camera now appears for any directed camera, including a playback someone else started: the stage adds `cameraDirected`, true while a playback, the playhead or a script directs the camera, and deprecates `scriptCamera`. The SDK adds `boardMediaCues`.
