---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Notifications: each kind reaches you over the channels you keep on for it — inbox, push and email, independently. `client.inbox` lists, summarizes and reads the inbox; `client.notifications` edits per-kind channels and registers this device's push address. Realtime delivers `inbox.changed` for inbox state and `notification.sent` for notices that should get your attention now. Prompts and notes can mention people with `@[Name](cohub://users/<uuid>)`; finished turns push by default and can be kept in the inbox. `cohub inbox` lists and reads the inbox; `cohub notifications prefs` shows and changes channels.
