---
"@neta-art/cohub": patch
---

Fold cover-role images into the media they depict. `toGenerationTaskView()` and Board task snapshots now share one pairing rule: an image sharing the provider id (music art), else a `first_frame` / `cover` / `poster` / `thumbnail` image in order (a video's first frame). `last_frame` images stay separate results.
