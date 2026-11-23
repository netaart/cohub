---
"@neta-art/cohub-cli": patch
---

Space-scoped commands and `cohub runtime status/down/logs/detach/import` now use the nearest directory bound with `cohub runtime up`, so they work from subdirectories. `runtime up` inside a bound directory says the new Space is separate from the parent's.
