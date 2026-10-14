---
"@neta-art/cohub-cli": patch
"@neta-art/cohub": patch
---

Keep a Codex turn's original prompt and client identity stable when the user steers a running turn or answers a question, so native sync can complete the existing turn and continue importing later turns. Sync explicit local Codex session names to their bound Cohub sessions, including index-only renames and reconnects, without blocking message sync.

Restore in-progress file previews after reconnects and steering updates, and retry rejected or failed progress snapshots without requiring another local event.

Recognize Codex app-update resume turns with no new user prompt, so their progress and completion continue syncing with a stable identity.

Watch writes directly for tracked active conversations so progress and subsequent turns sync on macOS while Codex keeps the transcript open. Retain directory watching for file replacement and release conversation watchers when sync is paused or stopped.

Preserve in-turn user replies, steering text and images in chronological order without changing the original Turn identity. Use existing content metadata for compatibility with older servers. Prevent stale reads from replacing newer progress, follow writes received during a read, discover open idle conversations, and cancel blocked title requests on shutdown.
