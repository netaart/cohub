---
"@neta-art/cohub-cli": patch
---

`cohub spaces wallet funding` now explains a missing transferable balance: it asks for a signed-in user session when `COHUB_EXECUTION_TOKEN` is in use, and reports `unavailable` otherwise.
