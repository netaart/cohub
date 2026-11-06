---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Archive Chats for every member of a Space. `session(id).archive()` / `unarchive()` toggle the archive, session lists hide archived Chats unless `archived: "only" | "include"` is passed, and `SessionRecord.archivedAt` reports the state. The CLI adds `spaces sessions archive|unarchive <id...>` and `--archived` / `--all` on `spaces sessions ls` and `me sessions`. Sending a message to an archived Chat restores it.

The first archive in a Space creates a system label named "Archived"; an existing top-level user label with that name is renamed to "Archived (Custom)", keeping its assignments.
