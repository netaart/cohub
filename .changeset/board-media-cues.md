---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board shows start their sound whole: viewers load a playback's next three sounds wherever they fall, nested animations included, and the videos of its next 3 seconds, paused at their first frame, so a play, seek or `next` that lands on a clip plays it from its first word.

Shared playback can wait for its audience. Each screen reports through presence whether it has loaded what it shows, the next second of sound and its scripts' preloads, whether it follows the camera, is muted or hidden, and how much of a sound's start it lost (`presence.setPlayback`, sent by the stage). `boards play` and `boards seek` take `--preroll [max]` (`preroll` in `board.play()` and `board.seek()`): every screen holds the first frame until all that watch are ready, at most 5 s, then they start together (`resume` takes `ifCommand`). `boards viewers` and `board.viewers()` list the screens and their state.

Scripts load images ahead with `ctx.preload([src | { src, width?, height? }])`, which resolves once they have loaded; a preroll waits for it.

Back to the camera now appears for any directed camera, including a playback someone else started: the stage adds `cameraDirected`, true while a playback, the playhead or a script directs the camera, and deprecates `scriptCamera`. The SDK adds `boardMediaCues`.
