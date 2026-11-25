---
"@neta-art/cohub-cli": patch
---

Overwriting a file no longer fails with "file changed while copying" or "file changed since it was opened" when its modification time sits just below a millisecond, as files copied with `cp -p` often do.
