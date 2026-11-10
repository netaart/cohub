---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Read a Board as a checkpoint saved it. `space.checkpoints(id).board(target)` takes a Board id or a `.board` path and returns the saved document; `version` is the Board version at save time, and `checkpointId` and `capturedAt` are added. `checkpoints(id).files.resolve(path)` gives a browser-ready URL for a saved file. In the CLI, `cohub boards get plan.board --checkpoint <id>` prints the saved Board and accepts `--only`, `--items`, `--within` and `--animations`.
