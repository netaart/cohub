---
"@neta-art/cohub": minor
---

`GET /api/me/sessions` filters by session source instead of only `web`: `?source=web,feishu` takes any of the `Source/*` label kinds, and each response carries `sourceCounts` so callers can build a picker from the kinds an account actually has. `user.listSessions({ source: ["web"] })`. The web inbox defaults to Web App and offers a source picker.
