---
"@neta-art/cohub": minor
---

**App publishing for builders.** Publishing an App is now gated on the dedicated `app.publish` permission (granted to `host` and `builder`) instead of `space.edit`, so Space builders can create, update, and disable Apps without gaining host-only Space settings. The `Permission` union gains `"app.publish"`.
