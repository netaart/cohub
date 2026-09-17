---
"@neta-art/cohub": minor
---

**App publishing and management for builders.** App permissions split into `app.publish` (create an App, publish new versions) and `app.manage` (change config/status, stats, delete), both granted to `host` and `builder` instead of leaning on `space.edit`, so Space builders can run Apps without gaining host-only Space settings.

- `app_source` uploads (used by the local CLI / local agent publish path) now require `app.publish`; `space_avatar` stays on `space.edit`.
- App deletion: hosts may delete any App, builders only the Apps they published themselves.
- App detail responses now report the actual `publisher` (App creator); the public Cohub bar credits that identity instead of always showing the Space owner, and the App authorize dialog names that author.
- The App management page shows Edit / Disable / stats for `app.manage` holders, Update version for `app.publish` holders, and Delete only for hosts or the App's publisher.
- The `Permission` union gains `"app.publish"` and `"app.manage"`.
