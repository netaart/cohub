---
"@neta-art/cohub": patch
---

The debugger truncates oversized captured payloads in a single pass instead of re-encoding them repeatedly, cutting its CPU cost on busy realtime streams.
