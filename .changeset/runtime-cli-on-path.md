---
"@neta-art/cohub-cli": patch
---

`cohub runtime up` puts its own CLI last on the `PATH` of what it runs, so agents can always call `cohub`, while a `cohub` already on `PATH` (such as a self-updating global install) still comes first.
