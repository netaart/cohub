---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Silence completion popups for successful scheduled prompts, hooks, and background tasks. `client.user.getPreferences()` and `client.user.updatePreferences()` read and change the per-source switches and per-scheduled-task overrides, and `client.cronJobs.getNotification()` / `setNotification()` manage one scheduled task's setting for its owner, including from Apps with `cronjob.manage`; a task's own setting wins, and failed or interrupted runs always notify. `session.turn.notify` now carries `source`, `cronJobId`, and `silent`, and preference changes arrive as `user.preferences.updated`. The CLI adds `cohub me notifications get|set` and `cohub cron-jobs notify <id> on|off|default`.
