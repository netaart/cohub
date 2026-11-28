---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Notifications: `client.notifications` lists the inbox, reads summaries, marks rows read, edits per-category push and email preferences and registers this device's push address; realtime delivers `notification.changed`. Prompts and notes can mention people with `@[Name](cohub://users/<uuid>)`. `cohub notifications` lists, reads and configures them. `session.turn.notify` is unchanged; turns also land in the inbox as `turn.finished`.
