---
"@neta-art/cohub": minor
---

`GET /api/me/sessions` no longer returns `sourceCounts`. The per-origin totals required a full aggregate over the account's sessions on every page fetch, which does not scale with large scheduled-task volumes. The source picker in the web inbox now lists every origin statically without counts.
