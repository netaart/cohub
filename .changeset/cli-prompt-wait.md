---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": patch
---

Add `--wait`, `--stream`, `--timeout`, and `--abort-on-timeout` to `cohub prompt`, plus `cohub spaces sessions turns wait` to re-attach to a turn. The SDK no longer logs an error when `disconnect()` cancels an in-flight realtime connect.
