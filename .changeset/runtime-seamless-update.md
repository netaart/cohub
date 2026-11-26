---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": patch
---

A background Runtime now moves to a newer CLI without disconnecting. Once idle, it hands the same Runtime to the newer version, and the Space and desktop never see it go offline. If the new version fails to start, the old one picks the Runtime back up. `cohub runtime up` from a newer CLI updates a running Runtime in place.
