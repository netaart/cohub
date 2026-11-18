---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

`space(id).prompt()` accepts `compactFirst: true` to compact an existing cohub session's context before the new Turn runs, so a long chat whose prompt cache has gone cold does not resend its whole history. `cohub spaces prompt --session <id> --compact-first` sends it from the CLI.
