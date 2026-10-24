---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Allow each scheduled prompt to disable success notifications while retaining failure notifications. Existing schedules continue to notify by default. Set `schedule.notifyOnSuccess` when creating a scheduled prompt, or update a recurring job with `notifyOnSuccess`. The CLI supports `--notify-on-success on|off` for both operations.
