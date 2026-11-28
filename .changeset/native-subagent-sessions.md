---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Subagents of local harnesses sync as Sessions of their own, created by an agent and linked from the Turn and tool call that spawned them: Claude Code subagents, Codex `spawn_agent` threads, Cursor subagents and nested Antigravity conversations. In a `claude -p` session, a background task's completion now stays in the Turn that launched it instead of appearing as a separate Turn.
