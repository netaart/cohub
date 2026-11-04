---
"@neta-art/cohub-cli": patch
---

Fix local Pi Turns failing with "Pi exited during the Turn" once a session's context grows past 8 MB. The Pi extension forwards only the event fields the Runtime reads, and an oversized line is skipped with a `native.pi_line_dropped` diagnostic instead of disconnecting Pi. Restart `cohub runtime` to apply; `runtime up` updates the installed Pi extension, and open terminal Pi sessions need `/reload`.
