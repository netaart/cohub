---
"@neta-art/cohub": patch
---

Release buffered `session.turn.patch` events when a missing seq does not arrive within 1.5s, so a lost patch triggers a stream snapshot resync instead of freezing live output until the turn ends.
