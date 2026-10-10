---
"@neta-art/cohub": patch
---

`session.created` for a forked Chat now carries its lineage as `payload.fork` (`RealtimeSessionFork`), so lists can nest the new Chat under its parent as it appears. Export `SessionCreatedEvent` and `RealtimeSessionFork`.
