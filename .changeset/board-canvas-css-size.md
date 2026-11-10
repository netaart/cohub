---
"@neta-art/cohub": patch
---

Keep the Board canvas at its CSS size on displays whose `devicePixelRatio` disagrees with the canvas's device-pixel box. Rendering no longer drifts from taps and zoom there; the backing store still matches device pixels.
