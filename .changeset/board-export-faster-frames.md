---
"@neta-art/cohub-cli": patch
---

`cohub boards export` renders scripted videos about 30% faster: script frames stay in one browser process, and the next frame's scripts run while the current frame uploads.
