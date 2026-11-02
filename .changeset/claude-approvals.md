---
"@neta-art/cohub-cli": minor
---

Local Claude Code Turns pass `--permission-prompt-tool stdio` when the CLI accepts it: Bash and file-edit permission prompts become the same web approval cards as Codex, and Runtimes advertise the `inherit`, `auto`, `full_access` and `read_only` approval modes Claude Code supports. Allow for this chat is remembered by the Runtime per chat; other tools stay denied.
