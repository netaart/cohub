---
"@neta-art/cohub-cli": patch
---

With `--json`, an error from the API now keeps its HTTP status: the printed body gains `status` unless it already has its own, so scripts can tell a retryable failure (429, 5xx) from a refusal.
