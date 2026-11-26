---
"@neta-art/cohub-cli": patch
---

Claude Code Turns on a Local Runtime record the input, cache read, and cache write tokens of every tool call. When the stream closed a call with zero counts, they were recorded as zero, so Turn totals could count only the last call's cache usage.
