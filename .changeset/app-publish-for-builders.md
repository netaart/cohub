---
"@neta-art/cohub": minor
---

**App publishing for builders.** App publishing is now gated on the dedicated `app.publish` permission (granted to `host` and `builder`) instead of `space.edit`, so Space builders can create, update, and disable Apps without gaining host-only Space settings.

- `app_source` uploads (used by the local CLI / local agent publish path) now require `app.publish`; `space_avatar` stays on `space.edit`.
- App deletion: hosts may delete any App, builders only the Apps they published themselves.
- The App management page shows Edit / Disable / Update version for `app.publish` holders, and Delete only for hosts or the App's publisher.
- The `Permission` union gains `"app.publish"`.
