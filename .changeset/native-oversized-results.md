---
"@neta-art/cohub-cli": patch
"@neta-art/cohub": patch
---

Upload oversized native chat results in acknowledged, integrity-checked chunks when the gateway supports them. Preserve failed results for retry, report unsupported servers explicitly, and count UTF-8 bytes when batching turns.
