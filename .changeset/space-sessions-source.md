---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

A Space's chat list filters by source on the server. `space(id).sessions.list({ source })` takes the same `UserSessionSourceKey` list as `user.listSessions`, matched by the session's `Source/*` label, so a Space flooded by scheduled or CLI chats still returns its web chats on the first page instead of after hundreds of rows. Unknown keys are rejected with a 400. `USER_SESSION_SOURCE_KEYS` lists the keys at runtime, and `cohub spaces sessions ls --source web,other` uses them.
