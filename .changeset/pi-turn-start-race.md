---
"@neta-art/cohub-cli": patch
---

Pi: a Turn sent to an idle Pi session while another was just starting is now refused and retried, instead of being reported as started and silently dropped by Pi. The Runtime reinstalls the updated Pi extension on its next start; already open Pi sessions pick it up after `/reload`.
