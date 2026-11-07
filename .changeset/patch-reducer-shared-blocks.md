---
"@neta-art/cohub": patch
---

Session patches copy only the content blocks they change. Untouched blocks keep their identity across generation `state` events instead of being deep-cloned on every patch.
