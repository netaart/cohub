---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

List Apps and scheduled prompts across spaces: `sdk.user.listApps()` and `sdk.user.listCronJobs()`, with `cohub apps ls --all` and `cohub cron-jobs ls` (no space). App sessions need the new `user.app.list` / `user.cronjob.list` grants for these account-wide lists.

`cohub cron-jobs ls` without a space now pages through `{ items, pageInfo }` (50 per page, `--cursor` for more) instead of returning `{ jobs }`.
