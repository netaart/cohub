---
"@neta-art/cohub-cli": patch
---

Space arguments on `spaces get/setup/update/rename/config/pin/unpin/archive/unarchive`, `search --space-id`, `references aggregate`, `apps authorize --space`, and `run -s` (before or after `run`) accept an ID, `home`, your own slug, or `username/slug`. `cohub -s <space> search` scopes the search. `spaces sessions tail --json` now writes only JSONL to stdout.
