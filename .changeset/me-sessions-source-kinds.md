---
"@neta-art/cohub": minor
---

`GET /api/me/sessions` filters by any session source instead of only `web`. `?source=web,feishu` takes a comma-separated list of source kinds, where `web` also matches a null source (legacy rows) and `other` matches anything unlabelled; unknown kinds return `400`. Responses carry `sourceCounts` so callers can build a picker from the kinds an account actually has. `user.listSessions({ source: ["web"] })`.
