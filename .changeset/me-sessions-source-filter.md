---
"@neta-art/cohub": minor
---

`GET /api/me/sessions` accepts `source=web` to return only human web chats, so scheduled prompts and channel bots no longer bury real conversations. `user.listSessions({ source: "web" })` exposes it, and the web inbox defaults to this filter with a Web App / All toggle.
