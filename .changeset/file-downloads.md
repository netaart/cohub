---
"@neta-art/cohub": minor
---

Space file reads that deliver through the CDN now carry `downloadUrl`, the same bytes served as an attachment under the file's name; checkpoint asset reads carry a signed equivalent. `files.saveSource(path)` (and the checkpoint variant) resolves how to save a file without buffering it when an attachment URL exists, and `spaceFileSaveSource(file)` derives it from a read you already have.

Hosts: `files.save` now takes a caller-chosen `id`, resolves with `{ location, revealable }` once the file is on disk (a dismissed system sheet rejects as `canceled`), and streams `files.progress` events; `files.reveal({ id })` shows the saved file.
