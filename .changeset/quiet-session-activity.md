---
"@neta-art/cohub": patch
---

Personal session lists receive lightweight projections of the existing `session.turn.updated` events for authorized creators and participants, without subscribing to assistant streams. Session snapshots continue to use `session.updated`. Lists use Turn sequence and terminal-state guards rather than introducing new timestamps, revisions, or database indexes.
