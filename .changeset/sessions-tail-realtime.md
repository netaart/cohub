---
"@neta-art/cohub-cli": patch
---

`cohub spaces sessions tail` streams again. It opened an HTTP-only client and failed at once with `realtime transport is not configured for this client`; it now connects over realtime and disconnects cleanly on Ctrl-C.
