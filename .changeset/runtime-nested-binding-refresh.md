---
"@neta-art/cohub-cli": patch
---

A running local Runtime stops syncing a subdirectory's harness sessions as soon as that subdirectory is bound to its own Space with `cohub runtime up`, instead of mirroring them until the parent Runtime restarts.
